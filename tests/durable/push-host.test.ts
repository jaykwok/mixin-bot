// What the message service gives the push service (src/push/service.ts PushHost) and the push tools: attachments a push
// holds (the files of a recorded reply), passive conversation notes, the member extensions a conversation selects by what
// the member is to pushes right now, the live pushes at the tail of its requests, and the question after a failed run.
import { afterAll, expect, test } from "bun:test";
import type { Message, Models } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { ModelRef } from "@earendil-works/pi-durable";
import { type AttachmentEvent, type AttachmentSource, holdAttachments, releaseHeld } from "../../src/durable/attachments.ts";
import type { ModelSelection } from "../../src/durable/models.ts";
import type { Outbound } from "../../src/durable/outbound.ts";
import type { Attachment, MemberRecords } from "../../src/durable/records.ts";
import { DurableService, type DurableServiceOptions, type InboundAttachment } from "../../src/durable/service.ts";
import { PlatformClient } from "../../src/integrations/open-platform/client.ts";
import { downloadFile } from "../../src/integrations/open-platform/files.ts";
import { appLayout, DIRECT_SCOPE, groupScope } from "../../src/core/layout.ts";
import { PUSH_NOTE_KIND } from "../../src/push/note.ts";
import type { ForwardInput, ReplyInput, Speaker } from "../../src/push/service.ts";
import { pushExtensions, pushSelection, type PushTools } from "../../src/push/tools.ts";
import { FakePlatform } from "../helpers/fake-platform.ts";
import { fauxModels, TEST_PROGRESS } from "../helpers/durable.ts";
import { DIRECT_SPACE, type Recording, recordingOutbound, replyTexts } from "../helpers/recording-outbound.ts";
import { tempFixture } from "../helpers/temp.ts";
import { tmpOf } from "../helpers/layout.ts";
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import "../helpers/restore-spies.ts";

const fixture = await tempFixture("durable-push-host-");
const platform = new FakePlatform();
const client = new PlatformClient(platform.config, { endpoints: platform.endpoints, retryDelaysMs: [5, 5] });
afterAll(async () => { client.close(); platform.stop(); await fixture.cleanup(); });
const ALICE = "13800000001";
const BOB = "13800000002";
let counter = 0;
const root = () => join(fixture.root, `root-${++counter}`);

const download: AttachmentSource = (fileId, destination, options) => downloadFile(client, fileId, destination, options);
function upload(content: string, fileName: string): string {
  const id = `file-${++counter}`;
  platform.files.set(id, Buffer.from(content));
  platform.fileInfo.set(id, { fileName, mimeType: "text/plain" });
  return id;
}

function selection(models: Models, ref: ModelRef): ModelSelection {
  return {
    runtime: models as never, settings: undefined as never, model: models.getModel(ref.provider, ref.modelId) as never, ref, thinkingLevel: "off",
    harnessSettings: { retry: { maxRetries: 1, baseDelayMs: 5, maxAgentDelayMs: 20 }, ...(TEST_PROGRESS === undefined ? {} : { progress: TEST_PROGRESS }) },
  };
}

/** A faux model that keeps each request's transcript; `answers` decide the replies (default: a plain answer). */
function model(answers: ((messages: Message[]) => ReturnType<FauxResponseFactory>)[] = []) {
  const { faux, models, model } = fauxModels();
  const requests: Message[][] = [];
  const state: { hold?: Promise<void> } = {};
  faux.setResponses(Array.from({ length: 30 }, (_, index) => ((transcript, options) => {
    requests.push(structuredClone(transcript.messages));
    const answer = answers[index]?.(transcript.messages) ?? fauxAssistantMessage(`answer ${requests.length}`);
    if (!state.hold) return answer;
    return new Promise(done => {
      options?.signal?.addEventListener("abort", () => done(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
      void state.hold!.then(() => done(answer));
    });
  }) as FauxResponseFactory));
  return { models, ref: model, requests, state };
}

function open(where: string, m: ReturnType<typeof model>, outbound: Outbound, options: Partial<DurableServiceOptions> = {}) {
  return new DurableService({
    layout: appLayout(where), selection: selection(m.models, m.ref), modules: [], relay: null, materials: false,
    limits: { runTimeoutMs: 60_000, modelIdleMs: 60_000, modelResponseMs: 60_000, tickMs: 20 },
    outbound, attachments: { source: download, limits: { memberCount: 1 } }, ...options,
  });
}

async function until(probe: () => boolean | Promise<boolean>, label: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!await probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

const ask = (out: Recording, phone: string, text: string) => out.message(DIRECT_SPACE, phone, text);
function attachment(out: Recording, phone: string, event: Partial<AttachmentEvent> & { fileId: string }, ask?: string): InboundAttachment {
  const { scope, reply } = out.message(DIRECT_SPACE, phone, "[文件]");
  return { scope, phone, reply, attachment: { kind: "file", name: "a.txt", ...event }, ...(ask ? { ask } : {}) };
}
async function stateOf(service: DurableService, msgUid: string, phone = ALICE): Promise<Attachment | undefined> {
  return Object.values((await service.records(DIRECT_SCOPE, phone)).attachments).find(item => item.msgUid === msgUid);
}
const received = (where: string, phone = ALICE) => readdir(join(tmpOf(where, DIRECT_SPACE, phone), "received")).catch(() => [] as string[]);

const text = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => "text" in part ? part.text : "").join("");
const userTexts = (messages: Message[]) => messages.filter(message => message.role === "user").map(text);
/** The tools and sections in effect at the end of the transcript's system messages. */
function declared(messages: Message[]) {
  const tools = new Set<string>(), sections = new Set<string>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const [name, body] of Object.entries(message.sections ?? {})) { if (body === null) sections.delete(name); else sections.add(name); }
  }
  return { tools, sections };
}

test("holding and releasing: one holder at a time; released, a file is its request's alone again, and its record goes when the request's is gone", () => {
  const file = (id: string, extra: Partial<Attachment> = {}): Attachment => ({ id, msgUid: `m-${id}`, receivedAt: 1, epoch: 0, fileId: `f-${id}`, kind: "file", name: `${id}.txt`,
    reply: { kind: "direct", receiveId: "im", senderImUserId: "im", msgUid: `m-${id}`, summary: "", receivedAt: 1 }, state: "ready", path: `/tmp/${id}`, at: 1, ...extra });
  const records: MemberRecords = { requests: { "req-1": { requestId: "req-1", reply: file("x").reply, createdAt: 1, notes: [], deliverables: [], files: [], events: {} } },
    attachments: { a: file("a", { boundTo: "req-1" }), b: file("b", { boundTo: "req-gone" }), c: file("c", { state: "void" }), d: file("d", { heldBy: "push:p2" }) } };
  // Void ones, missing ones and those another holder has are left; holding again is the same hold.
  expect(holdAttachments(records, "push:p1", ["a", "b", "c", "d", "missing"])).toBe(2);
  expect(holdAttachments(records, "push:p1", ["a"])).toBe(1);
  expect(Object.values(records.attachments).map(each => each.heldBy)).toEqual(["push:p1", "push:p1", undefined, "push:p2"]);
  expect(releaseHeld(records, "push:p2", ["a", "b"])).toBe(0);
  expect(releaseHeld(records, "push:p1", ["a", "b", "c", "missing"])).toBe(2);
  expect(Object.keys(records.attachments)).toEqual(["a", "c", "d"]);
  expect([records.attachments.a!.heldBy, records.attachments.a!.boundTo]).toEqual([undefined, "req-1"]);
});

test("a push holds the files of a recorded reply: /clear and a day of maintenance leave them, until the holder releases them; a waiting push changes what the member is asked", async () => {
  const where = root(), m = model(), out = recordingOutbound();
  const service = open(where, m, out.outbound);
  try {
    // With a push waiting for the member's reply the receipt asks whether the file is one.
    const sent = attachment(out, ALICE, { fileId: upload("reply", "reply.txt"), name: "reply.txt" }, "是回复「周报」的话说一声，我记进去；要我处理别的也直接说。");
    expect(await service.attach(sent)).toMatchObject({ status: "accepted" });
    await until(async () => (await stateOf(service, sent.reply.msgUid))?.state === "ready", "the download");
    expect(out.texts("notice", ALICE)).toEqual(["文件「reply.txt」收到了。是回复「周报」的话说一声，我记进去；要我处理别的也直接说。"]);
    // The member's next message takes the file; the push that recorded the message holds it.
    await service.admit(ask(out, ALICE, "这是我的周报"));
    await until(() => replyTexts(out.sent).length === 1, "the answer");
    expect(userTexts(m.requests[0]!).at(-1)!).toContain("reply.txt");
    const bound = (await stateOf(service, sent.reply.msgUid))!;
    expect(bound.boundTo).toBeDefined();
    expect(await service.holdAttachments(DIRECT_SCOPE, ALICE, "push:p1", [bound.id, "missing"])).toBe(1);
    expect(await service.holdAttachments(DIRECT_SCOPE, ALICE, "push:p2", [bound.id])).toBe(0);
    // The member's own limit is one unconsumed attachment: neither a consumed nor a held one takes it.
    const own = attachment(out, ALICE, { fileId: upload("own", "own.txt"), name: "own.txt" });
    expect(await service.attach(own)).toMatchObject({ status: "accepted" });
    await until(async () => (await stateOf(service, own.reply.msgUid))?.state === "ready", "the member's download");
    expect(out.texts("notice", ALICE).at(-1)).toBe("文件「own.txt」收到了，想让我怎么处理？");
    // /clear voids the member's waiting file and a day of maintenance drops old records: the held one stays as it is.
    await service.control(ask(out, ALICE, "/clear"));
    await service.maintain(Date.now() + 25 * 3600_000);
    expect((await stateOf(service, own.reply.msgUid))?.state ?? "void").toBe("void");
    const kept = (await stateOf(service, sent.reply.msgUid))!;
    expect(kept).toMatchObject({ state: "ready", heldBy: "push:p1" });
    const file = kept.path!.split(/[\\/]/).at(-1)!;
    // Only its holder releases it; the file is left to the tmp lifecycle.
    expect(await service.releaseAttachments(DIRECT_SCOPE, ALICE, "push:p2", [kept.id])).toBe(0);
    expect(await service.releaseAttachments(DIRECT_SCOPE, ALICE, "push:p1", [kept.id, "missing"])).toBe(1);
    expect((await stateOf(service, sent.reply.msgUid))?.heldBy).toBeUndefined();
    expect(await received(where)).toContain(file);
    expect(await service.attach(sent)).toEqual({ status: "duplicate" });
  } finally { await service.close(); }
});

test("a note is a passive entry: no run, written once per request id, seen by the member's next request and kept by a busy one", async () => {
  const where = root(), m = model(), out = recordingOutbound();
  const service = open(where, m, out.outbound);
  const note = (requestId: string, body: string) => service.note(DIRECT_SCOPE, ALICE, requestId, {
    kind: PUSH_NOTE_KIND, data: { push: "p1" }, model: [{ role: "user", content: [{ type: "text", text: body }], timestamp: Date.now() }] });
  try {
    // The member has no conversation yet: the note creates it.
    await note("push-note:card:p1", "[推送] 第一条备注");
    await note("push-note:card:p1", "[推送] 第一条备注");
    await Bun.sleep(100);
    expect(m.requests).toHaveLength(0);
    expect(out.sent).toEqual([]);
    await service.admit(ask(out, ALICE, "question one"));
    await until(() => replyTexts(out.sent).length === 1, "the first answer");
    expect(userTexts(m.requests[0]!)).toEqual(["[推送] 第一条备注", expect.stringContaining("question one")]);
    // A note written while a run is busy is not part of that run; the next request has it before its question.
    const hold = Promise.withResolvers<void>();
    m.state.hold = hold.promise;
    await service.admit(ask(out, ALICE, "question two"));
    await until(() => m.requests.length === 2, "the second run");
    await note("push-note:reply:p1:1", "[推送回复] 第二条备注");
    hold.resolve();
    await until(() => replyTexts(out.sent).length === 2, "the second answer");
    m.state.hold = undefined;
    await service.admit(ask(out, ALICE, "question three"));
    await until(() => replyTexts(out.sent).length === 3, "the third answer");
    const third = userTexts(m.requests.at(-1)!);
    expect(third.filter(each => each.startsWith("[推送"))).toEqual(["[推送] 第一条备注", "[推送回复] 第二条备注"]);
    expect(third.indexOf("[推送回复] 第二条备注")).toBeLessThan(third.findIndex(each => each.includes("question three")));
    expect(userTexts(m.requests[1]!)).not.toContain("[推送回复] 第二条备注");
  } finally { await service.close(); }
});

test("a note into a group nobody has asked in yet creates the space and the member's conversation; their first question there sees it", async () => {
  const where = root(), m = model(), out = recordingOutbound();
  const service = open(where, m, out.outbound);
  try {
    await service.note(groupScope("100"), BOB, "push-note:card:p1", {
      kind: PUSH_NOTE_KIND, data: { push: "p1" }, model: [{ role: "user", content: [{ type: "text", text: "[推送] 推送到本群的备注" }], timestamp: Date.now() }] });
    await Bun.sleep(100);
    expect(m.requests).toHaveLength(0);
    await service.admit(out.message("100", BOB, "群里的问题"));
    await until(() => replyTexts(out.sent).length === 1, "the group answer");
    expect(userTexts(m.requests[0]!)).toEqual(["[推送] 推送到本群的备注", expect.stringContaining("群里的问题")]);
  } finally { await service.close(); }
});

/** A push service as the tools see it: `pushers` push, `live` are the members and groups (`group:<ID>`) a live push reached. */
function fakePushes() {
  const pushers = new Set<string>(), live = new Set<string>();
  const calls: unknown[][] = [];
  const key = (scope: { kind: string; groupId?: string }, phone: string) => scope.kind === "group" ? `group:${scope.groupId}` : phone;
  const push: PushTools = {
    prepare: async (caller, input) => { calls.push(["prepare", caller.phone, input.attachments]); return "预览已发出"; },
    status: phone => { calls.push(["status", phone]); return "没有推送"; },
    lookup: (phone, input) => { calls.push(["lookup", phone, input]); return "找到 1 人"; },
    reply: async (speaker: Speaker, input: ReplyInput) => { calls.push(["reply", speaker, input]); return "已记入回复"; },
    forward: async (speaker: { phone: string }, input: ForwardInput) => { calls.push(["forward", speaker, input]); return "已把确认卡片发给成员"; },
    pending: (scope, phone) => live.has(key(scope, phone)) ? `[推送] ${scope.kind === "group" ? "本群" : "这位成员"}收到、还没有结束的推送：\n- 推送编号 abcd2345：推送人 推送「周报」` : undefined,
    isPusher: phone => pushers.has(phone),
    hasLive: (scope, phone) => live.has(key(scope, phone)),
  };
  return { push, pushers, live, calls };
}
const PUSH_TOOLS = ["directory_lookup", "push_forward", "push_prepare", "push_reply", "push_status"];
const pushTools = (names: Set<string>) => [...names].filter(name => PUSH_TOOLS.includes(name)).sort();
const pushSections = (names: Set<string>) => [...names].filter(name => name.startsWith("push")).sort();
function withPushes(where: string, fake: ReturnType<typeof fakePushes>): Partial<DurableServiceOptions> {
  return { memberExtensions: { install: scope => pushExtensions(fake.push, scope, { layout: appLayout(where) }), selected: (scope, phone) => pushSelection(fake.push, scope, phone) } };
}

test("a pusher's conversation selects the push tools and section and the address book; a revoked pusher's next request has none", async () => {
  const where = root(), out = recordingOutbound(), fake = fakePushes();
  fake.pushers.add(ALICE);
  const m = model([() => fauxAssistantMessage([fauxToolCall("push_status", {}, { id: "status-1" }),
    fauxToolCall("directory_lookup", { department: "华东分公司" }, { id: "lookup-1" })], { stopReason: "toolUse" })]);
  const service = open(where, m, out.outbound, withPushes(where, fake));
  try {
    await service.admit(ask(out, ALICE, "how are my pushes"));
    await until(() => replyTexts(out.sent).length === 1, "Alice's answer");
    // The two calls of one model turn run side by side: either may reach the service first.
    expect(fake.calls.length).toBe(2);
    expect(fake.calls).toContainEqual(["status", ALICE]);
    expect(fake.calls).toContainEqual(["lookup", ALICE, { department: "华东分公司" }]);
    const alice = declared(m.requests[0]!);
    expect([pushTools(alice.tools), pushSections(alice.sections)]).toEqual([["directory_lookup", "push_prepare", "push_status"], ["push"]]);
    expect(m.requests[1]!.some(message => message.role === "toolResult" && text(message) === "没有推送")).toBe(true);
    expect(m.requests[1]!.some(message => message.role === "toolResult" && text(message) === "找到 1 人")).toBe(true);
    expect(userTexts(m.requests[0]!).join("\n")).not.toContain("[推送]");
    await service.admit(ask(out, BOB, "hello"));
    await until(() => replyTexts(out.sent).length === 2, "Bob's answer");
    const bob = declared(m.requests[2]!);
    expect([pushTools(bob.tools), pushSections(bob.sections)]).toEqual([[], []]);
    fake.pushers.delete(ALICE);
    await service.admit(ask(out, ALICE, "and now"));
    await until(() => replyTexts(out.sent).length === 3, "Alice's answer after the revocation");
    const revoked = declared(m.requests[3]!);
    expect([pushTools(revoked.tools), pushSections(revoked.sections)]).toEqual([[], []]);
  } finally { await service.close(); }
});

test("push_prepare's attachments are files of the shared materials or the member's own tmp, passed on by real path and size; another file is refused before the push service hears of it", async () => {
  const where = root(), out = recordingOutbound(), fake = fakePushes();
  fake.pushers.add(ALICE);
  const own = join(tmpOf(where, DIRECT_SPACE, ALICE), "notice.txt"), outside = join(where, "secret.txt");
  await mkdir(dirname(own), { recursive: true });
  await writeFile(own, "notice");
  await writeFile(outside, "secret");
  const prepare = (path: string, id: string) => () => fauxAssistantMessage([fauxToolCall("push_prepare", { subject: "notice", body: "please read", mode: "ack",
    recipients: [{ name: "Carol", phone: "13800000003" }], attachments: [path] }, { id })], { stopReason: "toolUse" });
  const m = model([prepare(own, "prepare-1"), () => fauxAssistantMessage("sent the preview"), prepare(outside, "prepare-2")]);
  const service = open(where, m, out.outbound, withPushes(where, fake));
  try {
    await service.admit(ask(out, ALICE, "push this file to Carol"));
    await until(() => replyTexts(out.sent).length === 1, "the answer after the preview");
    expect(fake.calls).toEqual([["prepare", ALICE, [{ path: await realpath(own), size: 6 }]]]);
    await service.admit(ask(out, ALICE, "and this one"));
    await until(() => replyTexts(out.sent).length === 2, "the answer after the refusal");
    expect(fake.calls).toHaveLength(1);
    expect(m.requests.at(-1)!.some(message => message.role === "toolResult" && text(message).includes("只能发送共享资料 workspace 或当前调用用户 tmp 目录内的文件"))).toBe(true);
  } finally { await service.close(); }
});

test("a member a live push reached gets the reply tools, the address book and the live pushes at the tail of each request; push_reply is given the message as it was sent", async () => {
  const where = root(), out = recordingOutbound(), fake = fakePushes();
  const plain = () => fauxAssistantMessage("好的");
  const m = model([plain,
    () => fauxAssistantMessage([fauxToolCall("push_reply", { push: "abcd2345", action: "add" }, { id: "reply-1" })], { stopReason: "toolUse" }), plain,
    () => fauxAssistantMessage([fauxToolCall("push_forward", { push: "abcd2345", to: { name: "王五", phone: "13800000003" } }, { id: "forward-1" })], { stopReason: "toolUse" })]);
  const service = open(where, m, out.outbound, withPushes(where, fake));
  try {
    await service.admit(ask(out, BOB, "之前的问题"));
    await until(() => replyTexts(out.sent).length === 1, "the answer before the push");
    expect(pushTools(declared(m.requests[0]!).tools)).toEqual([]);
    // A push reaches Bob.
    fake.live.add(BOB);
    const said = ask(out, BOB, "  本周完成了迁移，\n下周联调  ");
    await service.admit(said);
    await until(() => replyTexts(out.sent).length === 2, "the answer that recorded the reply");
    const second = declared(m.requests[1]!);
    expect([pushTools(second.tools), pushSections(second.sections)]).toEqual([["directory_lookup", "push_forward", "push_reply"], ["push-reply"]]);
    expect(userTexts(m.requests[1]!).at(-1)).toEndWith("[推送] 这位成员收到、还没有结束的推送：\n- 推送编号 abcd2345：推送人 推送「周报」");
    // The service's own copy of the message, not the model's wording: text, message ID and time as they arrived.
    expect(fake.calls).toEqual([["reply", { scope: DIRECT_SCOPE, phone: BOB, message: { msgUid: said.reply.msgUid, text: said.content, receivedAt: said.reply.receivedAt } },
      { push: "abcd2345", action: "add" }]]);
    // The tail is part of the request only: the next one has it once, at its own end.
    await service.admit(ask(out, BOB, "把这件事转给王五"));
    await until(() => replyTexts(out.sent).length === 3, "the answer that asked to hand it on");
    const last = userTexts(m.requests.at(-1)!);
    expect(last.filter(each => each.includes("[推送] 这位成员收到")).length).toBe(1);
    expect(last.at(-1)).toContain("[推送] 这位成员收到");
    expect(fake.calls.at(-1)).toEqual(["forward", { phone: BOB }, { push: "abcd2345", to: { name: "王五", phone: "13800000003" } }]);
    // The push is over: the tools and the tail go with it.
    fake.live.delete(BOB);
    await service.admit(ask(out, BOB, "之后的问题"));
    await until(() => replyTexts(out.sent).length === 4, "the answer after the push");
    const after = declared(m.requests.at(-1)!);
    expect([pushTools(after.tools), pushSections(after.sections)]).toEqual([[], []]);
    expect(userTexts(m.requests.at(-1)!).at(-1)).not.toContain("[推送] 这位成员收到");
  } finally { await service.close(); }
});

test("a group a live push reached: its members' conversations there get push_reply alone, with the group's pushes at the tail", async () => {
  const where = root(), out = recordingOutbound(), fake = fakePushes();
  fake.live.add("group:100");
  fake.pushers.add(BOB);
  const m = model([() => fauxAssistantMessage([fauxToolCall("push_reply", { push: "abcd2345", action: "replace" }, { id: "reply-1" })], { stopReason: "toolUse" })]);
  const service = open(where, m, out.outbound, withPushes(where, fake));
  try {
    const said = out.message("100", BOB, "我们组已盘点");
    await service.admit(said);
    await until(() => replyTexts(out.sent).length === 1, "the group answer");
    const group = declared(m.requests[0]!);
    // A pusher too has only the reply tool in a group: pushing and the address book stay in the direct chat.
    expect([pushTools(group.tools), pushSections(group.sections)]).toEqual([["push_reply"], ["push-reply"]]);
    expect(userTexts(m.requests[0]!).at(-1)).toEndWith("[推送] 本群收到、还没有结束的推送：\n- 推送编号 abcd2345：推送人 推送「周报」");
    expect(fake.calls).toEqual([["reply", { scope: groupScope("100"), phone: BOB, message: { msgUid: said.reply.msgUid, text: "我们组已盘点", receivedAt: said.reply.receivedAt } },
      { push: "abcd2345", action: "replace" }]]);
    // Another group has nothing of it.
    await service.admit(out.message("200", BOB, "别的群"));
    await until(() => replyTexts(out.sent).length === 2, "the other group's answer");
    expect(pushTools(declared(m.requests.at(-1)!).tools)).toEqual([]);
  } finally { await service.close(); }
});

test("a request that ends without an answer is offered to the push service, and what it says follows the failure", async () => {
  const where = root(), out = recordingOutbound();
  const offered: unknown[] = [];
  const failed = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 invalid api key" });
  const m = model([failed, failed, failed, failed]);
  const service = open(where, m, out.outbound, {
    unanswered: async request => { offered.push(request); return request.message.text.includes("周报") ? "这条消息我先记进「周报」的回复了；不是回复的话，回头跟我说一声“撤回”。" : undefined; },
  });
  try {
    const said = ask(out, ALICE, "周报：本周完成了迁移");
    await service.admit(said);
    await until(() => replyTexts(out.sent).length === 1, "the failure text");
    expect(offered).toEqual([{ scope: DIRECT_SCOPE, phone: ALICE, message: { msgUid: said.reply.msgUid, text: "周报：本周完成了迁移", receivedAt: said.reply.receivedAt } }]);
    const told = replyTexts(out.sent)[0]!;
    expect(told).toContain("没有处理成功");
    expect(told).toEndWith("\n\n这条消息我先记进「周报」的回复了；不是回复的话，回头跟我说一声“撤回”。");
    // Nothing to add: the failure alone.
    await service.admit(ask(out, ALICE, "一个问题"));
    await until(() => replyTexts(out.sent).length === 2, "the second failure text");
    expect(offered).toHaveLength(2);
    expect(replyTexts(out.sent)[1]).not.toContain("周报");
  } finally { await service.close(); }
});
