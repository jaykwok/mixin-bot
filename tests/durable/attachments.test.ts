// Direct-chat attachments (src/durable/attachments.ts): registration in arrival order, binding at the next
// admitted request, download limits, voiding by /stop, /clear and expiry, and restarts around a download. The platform
// download runs against the local fake platform; the model is a faux provider that records what the member asked.
import { afterAll, spyOn, test } from "bun:test";
import { expectAsync as expect } from "../helpers/async-expect.ts";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { ModelRef } from "@earendil-works/pi-durable";
import { imageLimits } from "@earendil-works/pi-durable/tools";
import {
  readOwnAttachmentBytes, verifyOwnAttachment,
  type AttachmentEvent, type AttachmentLimits, type AttachmentSource,
} from "../../src/durable/attachments.ts";
import { inspectImageBeforeDecode } from "../../src/durable/image-guard.ts";
import { nodeImages } from "../../src/durable/base-tools.ts";
import { SpaceHarnesses } from "../../src/durable/spaces.ts";
import type { ModelSelection } from "../../src/durable/models.ts";
import type { Outbound } from "../../src/durable/outbound.ts";
import type { Attachment } from "../../src/durable/records.ts";
import { DIRECT_SPACE } from "../helpers/recording-outbound.ts";
import { DurableService, type DurableServiceOptions, type InboundAttachment } from "../../src/durable/service.ts";
import { PlatformClient } from "../../src/integrations/open-platform/client.ts";
import { downloadFile } from "../../src/integrations/open-platform/files.ts";
import { FakePlatform } from "../helpers/fake-platform.ts";
import { fauxModels, TEST_PROGRESS } from "../helpers/durable.ts";
import { type Recording, recordingOutbound, replyTexts } from "../helpers/recording-outbound.ts";
import { tempFixture } from "../helpers/temp.ts";
import "../helpers/restore-spies.ts";
import { scopeOf, tmpOf } from "../helpers/layout.ts";
import { appLayout } from "../../src/core/layout.ts";

const fixture = await tempFixture("durable-attachments-");
const platform = new FakePlatform();
const client = new PlatformClient(platform.config, { endpoints: platform.endpoints, retryDelaysMs: [5, 5] });
afterAll(async () => { client.close(); platform.stop(); await fixture.cleanup(); });
const ALICE = "13800000001";
const BOB = "13800000002";
let counter = 0;

const download: AttachmentSource = (fileId, destination, options) => downloadFile(client, fileId, destination, options);

/** A platform file; its download reports `fileName`. */
function upload(content: string | Buffer, fileName = "sample.txt", mimeType?: string): string {
  const id = `file-${++counter}`;
  platform.files.set(id, typeof content === "string" ? Buffer.from(content) : content);
  platform.fileInfo.set(id, { fileName, mimeType: mimeType ?? fileName.slice(fileName.lastIndexOf(".")) });
  return id;
}
const downloads = (fileId: string) => platform.requestsTo(`/open-apis/v1/files/${fileId}/download`).length;

/** A download that waits for `gate` first, or its abort; `stubborn` ignores a cancellation (not the shutdown). */
function gated(gate: Promise<void>, stubborn = false): AttachmentSource {
  return async (fileId, destination, options) => {
    await new Promise<void>((resolve, reject) => {
      void gate.then(resolve);
      if (stubborn) return;
      if (options.signal?.aborted) reject(options.signal.reason);
      options.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
    });
    return download(fileId, destination, stubborn ? {} : options);
  };
}

function selection(models: Models, ref: ModelRef): ModelSelection {
  return {
    runtime: models as never, settings: undefined as never, model: models.getModel(ref.provider, ref.modelId) as never, ref, thinkingLevel: "off",
    harnessSettings: { retry: { maxRetries: 1, baseDelayMs: 5, maxAgentDelayMs: 20 }, ...(TEST_PROGRESS === undefined ? {} : { progress: TEST_PROGRESS }) },
  };
}

const userText = (message: { content: unknown } | undefined) => typeof message?.content === "string" ? message.content
  : (message?.content as { type: string; text?: string }[] | undefined)?.map(part => part.text ?? "").join("") ?? "";

/** A faux model that records each request's last user text and raw content; `hold` makes the next answers wait for it. */
function model() {
  const { faux, models, model } = fauxModels();
  const prompts: string[] = [];
  const contents: unknown[] = [];
  const state: { hold?: Promise<void> } = {};
  faux.setResponses(Array.from({ length: 40 }, () => ((transcript, options) => new Promise(done => {
    const lastUser = transcript.messages.filter(message => message.role === "user").at(-1);
    contents.push(lastUser?.content);
    prompts.push(userText(lastUser));
    const answer = fauxAssistantMessage(`answer ${prompts.length}`);
    if (!state.hold) return done(answer);
    options?.signal?.addEventListener("abort", () => done(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
    void state.hold.then(() => done(answer));
  })) as FauxResponseFactory));
  return { faux, models, ref: model, prompts, contents, state };
}

function open(root: string, m: ReturnType<typeof model>, outbound: Outbound,
  options: { source?: AttachmentSource; limits?: Partial<AttachmentLimits>; service?: Partial<DurableServiceOptions> } = {}) {
  const reports: unknown[] = [];
  const service = new DurableService({
    layout: appLayout(root), selection: selection(m.models, m.ref), modules: [], relay: null, materials: false,
    limits: { runTimeoutMs: 60_000, modelIdleMs: 60_000, modelResponseMs: 60_000 },
    outbound, onReport: error => reports.push(error),
    attachments: { source: options.source ?? download, ...(options.limits ? { limits: options.limits } : {}) }, ...options.service,
  });
  return { service, reports };
}

async function until(probe: () => boolean | Promise<boolean>, label: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!await probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

function attachment(out: Recording, phone: string, event: Partial<AttachmentEvent> & { fileId: string }): InboundAttachment {
  const { scope, reply } = out.message(DIRECT_SPACE, phone, "[文件]");
  return { scope, phone, reply, attachment: { kind: "file", name: "a.txt", ...event } };
}
const ask = (out: Recording, phone: string, text: string) => out.message(DIRECT_SPACE, phone, text);
const notices = (out: Recording, phone = ALICE) => out.texts("notice", phone);

async function attachments(service: DurableService, phone = ALICE): Promise<Attachment[]> {
  return Object.values((await service.records(scopeOf(DIRECT_SPACE), phone)).attachments).sort((a, b) => a.receivedAt - b.receivedAt);
}
async function stateOf(service: DurableService, msgUid: string, phone = ALICE): Promise<Attachment | undefined> {
  return (await attachments(service, phone)).find(item => item.msgUid === msgUid);
}
const received = (root: string, phone = ALICE) => readdir(join(tmpOf(root, DIRECT_SPACE, phone), "received")).catch(() => [] as string[]);
const root = () => join(fixture.root, `root-${++counter}`);

test("a file followed at once by a question is bound to it; a /status and a refused message in between do not consume it", async () => {
  const where = root(), m = model(), out = recordingOutbound();
  const hold = Promise.withResolvers<void>();
  m.state.hold = hold.promise;
  const { service, reports } = open(where, m, out.outbound, { service: { limits: { runTimeoutMs: 60_000, modelIdleMs: 60_000, modelResponseMs: 60_000, queue: 0 } } });
  try {
    await service.admit(ask(out, ALICE, "first question"));
    await until(() => m.prompts.length === 1, "the first run");
    const file = attachment(out, ALICE, { fileId: upload("hello attachment", "a.txt"), size: 16 });
    expect(await service.attach(file)).toMatchObject({ status: "accepted", attachment: expect.any(String) });
    // The queue holds one message: this one is refused and must leave the attachment for the next.
    expect((await service.admit(ask(out, ALICE, "refused question"))).status).toBe("full");
    expect(await service.control(ask(out, ALICE, "/status"))).toContain("待处理附件：1 个");
    m.state.hold = undefined; hold.resolve();
    await until(() => replyTexts(out.sent).length === 1, "the first answer");
    await until(async () => (await stateOf(service, file.reply.msgUid))?.state === "ready", "the download");
    await service.admit(ask(out, ALICE, "summarise it"));
    await until(() => m.prompts.length === 2, "the second run");
    expect(m.prompts[0]).toBe("first question");
    expect(m.prompts[1]).toStartWith("summarise it\n\n[用户在这条消息之前发送的附件]\n- 文件「a.txt」，16 B，类型 .txt：");
    const stored = (await stateOf(service, file.reply.msgUid))!;
    expect(stored.boundTo).toStartWith("msg:");
    expect(m.prompts[1]).toContain(stored.path!.replace(/\\/g, "/"));
    expect(await readFile(stored.path!, "utf8")).toBe("hello attachment");
    expect(stored.path!.startsWith(join(tmpOf(where, DIRECT_SPACE, ALICE), "received", `${stored.id}-`))).toBe(true);
    expect(notices(out)).toContain("文件「a.txt」收到了，想让我怎么处理？");
    // Bound once: the next question sees no attachment. With no queue it waits for the second answer: the run's inbox
    // item is removed just before that reply, and until then a new message is refused as queue-full.
    await until(() => replyTexts(out.sent).length === 2, "the second answer");
    expect((await service.admit(ask(out, ALICE, "another"))).status).toBe("accepted");
    await until(() => m.prompts.length === 3, "the third run");
    expect(m.prompts[2]).toBe("another");
    expect(await service.attach(file)).toEqual({ status: "duplicate" });
    expect(reports).toEqual([]);
  } finally { hold.resolve(); await service.close(); }
});

test("the request waits for the download it bound; one that takes too long is explained and still lands", async () => {
  const where = root(), m = model(), out = recordingOutbound();
  let gate = Promise.withResolvers<void>();
  const { service } = open(where, m, out.outbound, { source: (...args) => gated(gate.promise)(...args), limits: { waitMs: 400 } });
  try {
    const first = attachment(out, ALICE, { fileId: upload("one", "one.txt"), name: "one.txt" });
    await service.attach(first);
    await service.admit(ask(out, ALICE, "use it"));
    await Bun.sleep(150);
    expect(m.prompts).toEqual([]);
    gate.resolve();
    await until(() => m.prompts.length === 1, "the run after the download");
    expect(m.prompts[0]).toContain("文件「one.txt」，3 B");
    gate = Promise.withResolvers<void>();
    const slow = attachment(out, ALICE, { fileId: upload("two", "two.txt"), name: "two.txt" });
    await service.attach(slow);
    await service.admit(ask(out, ALICE, "and this"));
    await until(() => m.prompts.length === 2, "the run after the wait limit");
    expect(m.prompts[1]).toContain("- 文件「two.txt」：等待下载超时，本次无法使用");
    gate.resolve();
    await until(async () => (await stateOf(service, slow.reply.msgUid))?.state === "ready", "the late download");
    expect((await stateOf(service, slow.reply.msgUid))!.boundTo).toBeDefined();
  } finally { gate.resolve(); await service.close(); }
});

test("no project size limit: a file larger than the event declared lands whole; the count limit refuses with a reason", async () => {
  const where = root(), m = model(), out = recordingOutbound();
  const { service } = open(where, m, out.outbound, { limits: { memberCount: 3 } });
  try {
    // Larger than the old 25 MiB rule, and larger than it claims: neither is a reason to refuse.
    const big = attachment(out, ALICE, { fileId: upload("x".repeat(31 * 1024 * 1024)), name: "big.bin", size: 10 });
    await service.attach(big);
    await until(async () => (await stateOf(service, big.reply.msgUid))?.state === "ready", "the large file");
    expect((await stateOf(service, big.reply.msgUid))!.actualSize).toBe(31 * 1024 * 1024);
    await service.attach(attachment(out, ALICE, { fileId: upload("y"), name: "second.txt" }));
    await service.attach(attachment(out, ALICE, { fileId: upload("z"), name: "third.txt" }));
    const fourth = attachment(out, ALICE, { fileId: upload("u"), name: "fourth.txt" });
    expect(await service.attach(fourth)).toEqual({ status: "full", message: "文件「fourth.txt」没有收下：你之前发的 3 个附件还没处理，请先发消息告诉我怎么处理。" });
    expect(await stateOf(service, fourth.reply.msgUid)).toBeUndefined();
    expect(await service.attach(fourth)).toEqual({ status: "duplicate" });
    await until(async () => (await attachments(service)).every(item => item.state !== "pending"), "settled downloads");
    await service.admit(ask(out, ALICE, "what did I send"));
    await until(() => m.prompts.length === 1, "the run");
    expect(m.prompts[0]).toContain("- 文件「big.bin」，31.0 MiB");
    expect(m.prompts[0]).toContain("- 文件「third.txt」，1 B");
    // Consumed: room again.
    expect(await service.attach(attachment(out, ALICE, { fileId: upload("t"), name: "again.txt" }))).toMatchObject({ status: "accepted", attachment: expect.any(String) });
  } finally { await service.close(); }
});

test("a failed download is told to the member and explained to the request that binds it", async () => {
  const where = root(), m = model(), out = recordingOutbound();
  const { service } = open(where, m, out.outbound);
  try {
    const missing = attachment(out, ALICE, { fileId: "gone", name: "gone.txt" });
    await service.attach(missing);
    await until(async () => (await stateOf(service, missing.reply.msgUid))?.state === "failed", "the failure");
    expect(notices(out).some(text => text.startsWith("文件「gone.txt」没有下载成功：") && text.endsWith("请再发一次。"))).toBe(true);
    await service.admit(ask(out, ALICE, "read it"));
    await until(() => m.prompts.length === 1, "the run");
    expect(m.prompts[0]).toMatch(/- 文件「gone\.txt」：下载失败，/);
  } finally { await service.close(); }
});

test("/clear voids earlier unbound attachments and their files; a download finishing after it does not revive one; later ones stay", async () => {
  const where = root(), m = model(), out = recordingOutbound();
  const gate = Promise.withResolvers<void>(), slowDone = Promise.withResolvers<void>();
  let slowId = "";
  const slowSource: AttachmentSource = async (...args) => { try { return await gated(gate.promise, true)(...args); } finally { slowDone.resolve(); } };
  const { service } = open(where, m, out.outbound, { source: (fileId, ...rest) => fileId === slowId ? slowSource(fileId, ...rest) : download(fileId, ...rest) });
  try {
    const ready = attachment(out, ALICE, { fileId: upload("ready", "r.txt") });
    await service.attach(ready);
    await until(async () => (await stateOf(service, ready.reply.msgUid))?.state === "ready", "the first download");
    slowId = upload("slow", "s.txt");
    const slow = attachment(out, ALICE, { fileId: slowId });
    await service.attach(slow);
    await Bun.sleep(50);
    await service.control(ask(out, ALICE, "/clear"));
    const after = attachment(out, ALICE, { fileId: upload("after", "after.txt") });
    await service.attach(after);
    gate.resolve();
    await until(async () => (await stateOf(service, after.reply.msgUid))?.state === "ready", "the later download");
    // The late download ignores the cancellation: wait for it to return, then for its files to go (the .part is renamed, and the
    // result removed as not kept). A fixed sleep after its request was too short on a slow runner (CI 40275415799).
    await slowDone.promise;
    const own = (await stateOf(service, after.reply.msgUid))!;
    const ownName = own.path!.split(/[\\/]/).at(-1)!;
    await until(async () => (await received(where)).join() === ownName, "the late download's files gone");
    expect(downloads(slowId)).toBe(1);
    expect((await stateOf(service, ready.reply.msgUid))!.state).toBe("void");
    expect((await stateOf(service, slow.reply.msgUid))!.state).toBe("void");
    expect((await stateOf(service, slow.reply.msgUid))!.path).toBeUndefined();
    expect(await received(where)).toEqual([ownName]);
    await service.admit(ask(out, ALICE, "go"));
    await until(() => m.prompts.length === 1, "the run");
    expect(m.prompts[0]).toContain("-after.txt");
    expect(m.prompts[0].match(/^- /gm)).toHaveLength(1);
  } finally { gate.resolve(); await service.close(); }
});

test("/stop voids the attachments of the request it cancels", async () => {
  const where = root(), m = model(), out = recordingOutbound();
  const hold = Promise.withResolvers<void>();
  m.state.hold = hold.promise;
  const { service } = open(where, m, out.outbound);
  try {
    const file = attachment(out, ALICE, { fileId: upload("data", "d.txt") });
    await service.attach(file);
    await until(async () => (await stateOf(service, file.reply.msgUid))?.state === "ready", "the download");
    await service.admit(ask(out, ALICE, "work on it"));
    await until(() => m.prompts.length === 1, "the run");
    await service.control(ask(out, ALICE, "/stop"));
    const stored = (await stateOf(service, file.reply.msgUid))!;
    expect(stored.state).toBe("void"); expect(stored.boundTo).toBeDefined();
    await until(async () => (await received(where)).length === 0, "the removed file");
  } finally { hold.resolve(); await service.close(); }
});

test("an attachment whose registration commits after a /clear that arrived later is void at once and never downloaded", async () => {
  const where = root(), m = model(), out = recordingOutbound();
  const { service } = open(where, m, out.outbound);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const acquire = SpaceHarnesses.prototype.acquire;
  let armed = false;
  const { spyOn } = await import("bun:test");
  const spy = spyOn(SpaceHarnesses.prototype, "acquire").mockImplementation(async function (this: SpaceHarnesses, scope) {
    // Only the registration is held: the warm-up's own follow-up work may still acquire the group (seen under load).
    if (armed && /\bat (?:\S+\.)?attach \(/.test(new Error().stack ?? "")) { armed = false; entered.resolve(); await release.promise; }
    return acquire.call(this, scope);
  });
  try {
    await service.admit(ask(out, ALICE, "warm-up"));
    await until(() => replyTexts(out.sent).length === 1, "the warm-up");
    const fileId = upload("late");
    const file = attachment(out, ALICE, { fileId });
    armed = true;
    const registering = service.attach(file);
    await entered.promise;
    await service.control(ask(out, ALICE, "/clear"));
    release.resolve();
    expect(await registering).toMatchObject({ status: "accepted", attachment: expect.any(String) });
    expect((await stateOf(service, file.reply.msgUid))!.state).toBe("void");
    await Bun.sleep(100);
    expect(downloads(fileId)).toBe(0);
    expect(notices(out).some(text => text.endsWith("收到了，想让我怎么处理？"))).toBe(false);
  } finally { release.resolve(); spy.mockRestore(); await service.close(); }
});

test("an attachment whose registration commits after a /stop that arrived later stays for the next message", async () => {
  const where = root(), m = model(), out = recordingOutbound();
  const { service } = open(where, m, out.outbound);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const acquire = SpaceHarnesses.prototype.acquire;
  let armed = false;
  const { spyOn } = await import("bun:test");
  const spy = spyOn(SpaceHarnesses.prototype, "acquire").mockImplementation(async function (this: SpaceHarnesses, scope) {
    if (armed && /\bat (?:\S+\.)?attach \(/.test(new Error().stack ?? "")) { armed = false; entered.resolve(); await release.promise; }
    return acquire.call(this, scope);
  });
  try {
    await service.admit(ask(out, ALICE, "warm-up"));
    await until(() => replyTexts(out.sent).length === 1, "the warm-up");
    const file = attachment(out, ALICE, { fileId: upload("late", "late.txt") });
    armed = true;
    const registering = service.attach(file);
    await entered.promise;
    await service.control(ask(out, ALICE, "/stop"));
    release.resolve();
    await registering;
    await until(async () => (await stateOf(service, file.reply.msgUid))?.state === "ready", "the download");
    expect(notices(out).some(text => text.endsWith("收到了，想让我怎么处理？"))).toBe(true);
    await service.admit(ask(out, ALICE, "use it"));
    await until(() => m.prompts.length === 2, "the next message");
    expect(m.prompts[1]).toContain("late.txt");
  } finally { release.resolve(); spy.mockRestore(); await service.close(); }
});

test("restarts: an interrupted download starts again, left-overs of a rename are removed, a committed one is not fetched again", async () => {
  const where = root(), m = model(), out = recordingOutbound();
  const never = Promise.withResolvers<void>();
  const fileId = upload("content", "doc.txt");
  const file = attachment(out, ALICE, { fileId, name: "doc.txt" });
  let { service } = open(where, m, out.outbound, { source: gated(never.promise) });
  await service.attach(file);
  await Bun.sleep(50);
  await service.close();
  const pending = (await (async () => {
    ({ service } = open(where, m, out.outbound, { source: gated(never.promise) }));
    try { return await stateOf(service, file.reply.msgUid); } finally { await service.close(); }
  })())!;
  expect(pending.state).toBe("pending");
  // A crash between the rename and the ready commit leaves both names behind.
  const dir = join(tmpOf(where, DIRECT_SPACE, ALICE), "received");
  await writeFile(join(dir, `${pending.id}.part`), "half");
  await writeFile(join(dir, `${pending.id}-stale.txt`), "renamed, not committed");
  ({ service } = open(where, m, out.outbound));
  try {
    expect(await service.start()).toEqual([scopeOf(DIRECT_SPACE)]);
    await until(async () => (await stateOf(service, file.reply.msgUid))?.state === "ready", "the resumed download");
    expect(await received(where)).toEqual([`${pending.id}-doc.txt`]);
    expect(downloads(fileId)).toBe(1);
  } finally { await service.close(); }
  ({ service } = open(where, m, out.outbound));
  try {
    expect(await service.start()).toEqual([]);
    await service.admit(ask(out, ALICE, "now"));
    await until(() => m.prompts.length === 1, "the run");
    expect(m.prompts[0]).toContain("doc.txt");
    expect(downloads(fileId)).toBe(1);
  } finally { never.resolve(); await service.close(); }
});

test("members are isolated: one member's attachment never reaches another member's request", async () => {
  const where = root(), m = model(), out = recordingOutbound();
  const { service } = open(where, m, out.outbound);
  try {
    const file = attachment(out, ALICE, { fileId: upload("alice's", "alice.txt") });
    await service.attach(file);
    await until(async () => (await stateOf(service, file.reply.msgUid))?.state === "ready", "the download");
    await service.admit(ask(out, BOB, "bob asks"));
    await until(() => m.prompts.length === 1, "bob's run");
    expect(m.prompts[0]).toBe("bob asks");
    expect(await attachments(service, BOB)).toEqual([]);
    expect(await received(where, BOB)).toEqual([]);
    await service.admit(ask(out, ALICE, "alice asks"));
    await until(() => m.prompts.length === 2, "alice's run");
    expect(m.prompts[1]).toContain("alice.txt");
  } finally { await service.close(); }
});

test("unbound attachments expire after a day; a bound one lives as long as its request record", async () => {
  const where = root(), m = model(), out = recordingOutbound();
  const { service } = open(where, m, out.outbound);
  try {
    const used = attachment(out, ALICE, { fileId: upload("used", "used.txt") });
    await service.attach(used);
    await until(async () => (await stateOf(service, used.reply.msgUid))?.state === "ready", "the first download");
    await service.admit(ask(out, ALICE, "use it"));
    await until(() => replyTexts(out.sent).length === 1, "the answer");
    const idle = attachment(out, ALICE, { fileId: upload("idle", "idle.txt") });
    await service.attach(idle);
    await until(async () => (await stateOf(service, idle.reply.msgUid))?.state === "ready", "the second download");
    await service.maintain(Date.now() + 23 * 3600_000);
    expect((await stateOf(service, idle.reply.msgUid))!.state).toBe("ready");
    const bound = (await stateOf(service, used.reply.msgUid))!;
    expect(bound.state).toBe("ready"); expect(bound.boundTo).toBeDefined();
    await service.maintain(Date.now() + 25 * 3600_000);
    expect((await stateOf(service, idle.reply.msgUid))!.state).toBe("void");
    await until(async () => (await received(where)).length === 1, "the expired file removed");
    // The closed request is pruned a day after it closed; its attachment record goes with it (the file is left to tmp archive).
    expect(await stateOf(service, used.reply.msgUid)).toBeUndefined();
    expect(await received(where)).toEqual([bound.path!.split(/[\\/]/).at(-1)!]);
  } finally { await service.close(); }
});

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

test("ready direct-chat images are fitted and inlined for vision models, omitted safely when corrupt, and path-only for text-only models", async () => {
  const visionRoot = root(), mVision = model(), outVision = recordingOutbound();
  const visionSelection = selection(mVision.models, mVision.ref);
  visionSelection.model = { ...visionSelection.model, input: ["text", "image"] };
  const { service: visionService, reports: visionReports } = open(visionRoot, mVision, outVision.outbound, { service: { selection: visionSelection } });
  try {
    const valid = attachment(outVision, ALICE, { fileId: upload(ONE_PIXEL_PNG, "photo.png", ".png"), kind: "image", name: "photo.png", mimeType: "image/png" });
    const corrupt = attachment(outVision, ALICE, { fileId: upload("not-an-image", "broken.png", ".png"), kind: "image", name: "broken.png", mimeType: "image/png" });
    await visionService.attach(valid);
    await visionService.attach(corrupt);
    await until(async () => (await attachments(visionService)).every(item => item.state === "ready"), "image downloads");
    await visionService.admit(ask(outVision, ALICE, "看看这些图"));
    await until(() => mVision.contents.length === 1, "the vision run");
    const blocks = mVision.contents[0] as ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
    expect(Array.isArray(blocks)).toBe(true);
    // Only the valid PNG is inlined; the corrupt one is safely omitted without failing the run or suggesting read.
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe("text");
    const visionText = (blocks[0] as { type: "text"; text: string }).text;
    expect(visionText).toContain("图片已附在本条消息中");
    expect(visionText).toContain("photo.png");
    expect(visionText).toContain("broken.png");
    expect(visionText).toContain("无法用 read 查看");
    expect(visionText).not.toContain("可尝试用 read");
    expect(visionText).not.toContain("图片可以用 read");
    expect(blocks[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect((blocks[1] as { data: string }).data.length).toBeGreaterThan(0);
    await until(() => replyTexts(outVision.sent).length === 1, "the vision answer");

    // Five valid images: first 4 are inlined, the 5th is marked as capped and only suggests trying `read`.
    for (let i = 1; i <= 5; i++) {
      await visionService.attach(attachment(outVision, ALICE, {
        fileId: upload(ONE_PIXEL_PNG, `img-${i}.png`, ".png"), kind: "image", name: `img-${i}.png`, mimeType: "image/png",
      }));
    }
    await until(async () => (await attachments(visionService)).every(item => item.state !== "pending"), "five image downloads");
    await visionService.admit(ask(outVision, ALICE, "看五张图"));
    await until(() => mVision.contents.length === 2, "the five-image run");
    const fiveBlocks = mVision.contents[1] as ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
    expect(fiveBlocks).toHaveLength(5); // 1 text + 4 inline images
    const fiveText = (fiveBlocks[0] as { type: "text"; text: string }).text;
    expect(fiveText).toContain("超出单条自动附带上限，可尝试用 read 查看");
    expect(fiveText).not.toContain("图片可以用 read");
    await until(() => replyTexts(outVision.sent).length === 2, "the five-image answer");
    expect(visionReports).toEqual([]);
  } finally { await visionService.close(); }

  const textRoot = root(), mText = model(), outText = recordingOutbound();
  const textSelection = selection(mText.models, mText.ref);
  textSelection.model = { ...textSelection.model, input: ["text"] };
  const { service: textService } = open(textRoot, mText, outText.outbound, { service: { selection: textSelection } });
  try {
    const valid = attachment(outText, ALICE, { fileId: upload(ONE_PIXEL_PNG, "only-path.png", ".png"), kind: "image", name: "only-path.png", mimeType: "image/png" });
    await textService.attach(valid);
    await until(async () => (await stateOf(textService, valid.reply.msgUid))?.state === "ready", "text-only download");
    await textService.admit(ask(outText, ALICE, "看图"));
    await until(() => mText.contents.length === 1, "the text-only run");
    expect(typeof mText.contents[0]).toBe("string");
    expect(mText.prompts[0]).toContain("only-path.png");
    expect(mText.prompts[0]).toContain("图片可尝试用 read 工具查看。");
    expect(mText.prompts[0]).not.toContain("图片已附在本条消息中");
  } finally { await textService.close(); }
});

/** Build a tiny PNG header declaring arbitrary width x height (no pixel payload needed to test pre-decode rejection). */
function fakePngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

test("inline image guard rejects high-pixel decompression bombs before Photon decode, enforces bounded reads, and refuses symlinks/junctions along the member path", async () => {
  // 1) Pre-decode header checks reject oversized dimensions and excessive pixel counts without calling Photon.
  expect(inspectImageBeforeDecode(fakePngHeader(16385, 100))).toEqual({ ok: false, reason: "dimension_limit" });
  expect(inspectImageBeforeDecode(fakePngHeader(6000, 5000))).toEqual({ ok: false, reason: "pixel_limit" });
  expect(inspectImageBeforeDecode(ONE_PIXEL_PNG)).toEqual({ ok: true, mimeType: "image/png", width: 1, height: 1 });

  const where = root(), m = model(), out = recordingOutbound();
  const layout = appLayout(where), directScope = scopeOf(DIRECT_SPACE);
  const visionSelection = selection(m.models, m.ref);
  visionSelection.model = { ...visionSelection.model, input: ["text", "image"] };
  const { service } = open(where, m, out.outbound, { service: { selection: visionSelection } });
  const prepareSpy = spyOn(nodeImages, "prepare");
  try {
    const bomb = attachment(out, ALICE, { fileId: upload(fakePngHeader(6000, 5000), "bomb.png", ".png"), kind: "image", name: "bomb.png", mimeType: "image/png" });
    await service.attach(bomb);
    await until(async () => (await stateOf(service, bomb.reply.msgUid))?.state === "ready", "bomb download");
    await service.admit(ask(out, ALICE, "看超高像素图"));
    await until(() => m.contents.length === 1, "the bomb run");
    // Photon was NEVER invoked for the 30-megapixel header bomb; message stays plain text and does NOT suggest read.
    expect(prepareSpy).toHaveBeenCalledTimes(0);
    expect(typeof m.contents[0]).toBe("string");
    expect(m.prompts[0]).toContain("bomb.png");
    expect(m.prompts[0]).toContain("超过图片安全像素上限");
    expect(m.prompts[0]).toContain("无法用 read 查看");
    expect(m.prompts[0]).not.toContain("图片已附在本条消息中");
    expect(m.prompts[0]).not.toContain("可尝试用 read");
    expect(m.prompts[0]).not.toContain("图片可以用 read");

    // 2) Held-directory bounded reader anchored at layout.tmp enforces maxBytes and rejects outside paths.
    const stored = (await stateOf(service, bomb.reply.msgUid))!;
    expect(await readOwnAttachmentBytes(layout, directScope, ALICE, stored.path!, 10)).toEqual({ kind: "too_large", size: 33 });
    expect(await verifyOwnAttachment(layout, directScope, ALICE, stored.path!)).toBe("ok");
    const outside = join(where, "outside.png");
    await writeFile(outside, ONE_PIXEL_PNG);
    expect(await readOwnAttachmentBytes(layout, directScope, ALICE, outside, 1024)).toEqual({ kind: "untrusted" });
    expect(await verifyOwnAttachment(layout, directScope, ALICE, outside)).toBe("untrusted");

    // 3) Symlink replacing a downloaded attachment inside received/ is refused without reading the target.
    const swapped = attachment(out, ALICE, { fileId: upload(ONE_PIXEL_PNG, "swap.png", ".png"), kind: "image", name: "swap.png", mimeType: "image/png" });
    await service.attach(swapped);
    await until(async () => (await stateOf(service, swapped.reply.msgUid))?.state === "ready", "swapped download");
    const swappedRecord = (await stateOf(service, swapped.reply.msgUid))!;
    let symlinkCreated = false;
    try {
      await rm(swappedRecord.path!);
      await symlink(outside, swappedRecord.path!);
      symlinkCreated = true;
    } catch {
      // Unprivileged Windows without Developer Mode may forbid file symlinks; restore regular file if symlink failed.
      await writeFile(swappedRecord.path!, ONE_PIXEL_PNG);
    }
    if (symlinkCreated) {
      expect(await readOwnAttachmentBytes(layout, directScope, ALICE, swappedRecord.path!, 1024)).toEqual({ kind: "untrusted" });
      await service.admit(ask(out, ALICE, "看被替换的链接"));
      await until(() => m.contents.length === 2, "the symlink run");
      expect(prepareSpy).toHaveBeenCalledTimes(0);
      expect(typeof m.contents[1]).toBe("string");
      expect(m.prompts[1]).toContain("附件文件不可用");
    }

    // 4) Replacing the MEMBER directory itself with a directory symlink (POSIX) or junction (Windows) is refused
    // because `holdDirectory` anchors at trusted `layout.tmp` and verifies every intermediate segment.
    const bobFile = attachment(out, BOB, { fileId: upload(ONE_PIXEL_PNG, "member-link.png", ".png"), kind: "image", name: "member-link.png", mimeType: "image/png" });
    await service.attach(bobFile);
    await until(async () => (await stateOf(service, bobFile.reply.msgUid, BOB))?.state === "ready", "bob download");
    const bobRecord = (await stateOf(service, bobFile.reply.msgUid, BOB))!;
    const decoyMember = join(where, "decoy-member");
    await mkdir(join(decoyMember, "received"), { recursive: true });
    await writeFile(join(decoyMember, "received", basename(bobRecord.path!)), ONE_PIXEL_PNG);
    const bobMemberDir = tmpOf(where, DIRECT_SPACE, BOB);
    await rm(bobMemberDir, { recursive: true, force: true });
    // Windows junctions work without administrator privileges; POSIX uses a directory symlink.
    await symlink(decoyMember, bobMemberDir, process.platform === "win32" ? "junction" : "dir");
    expect(await verifyOwnAttachment(layout, directScope, BOB, bobRecord.path!)).toBe("untrusted");
    expect(await readOwnAttachmentBytes(layout, directScope, BOB, bobRecord.path!, 1024)).toEqual({ kind: "untrusted" });
    const beforeBobRun = m.contents.length;
    await service.admit(ask(out, BOB, "看成员目录被替换为链接后的图"));
    await until(() => m.contents.length === beforeBobRun + 1, "the member-link run");
    expect(prepareSpy).toHaveBeenCalledTimes(0);
    expect(typeof m.contents[beforeBobRun]).toBe("string");
    expect(m.prompts[beforeBobRun]).toContain("附件文件不可用");

    // 5) Even if the model ignores the prompt and calls `read` (or any consumer of `nodeImages`), the shared guarded
    // ImageProcessor rejects the 30-megapixel bomb before Photon decodes it.
    expect(await nodeImages.prepare(fakePngHeader(6000, 5000), "image/png", imageLimits(visionSelection.model))).toBeUndefined();
    const toolResults: string[] = [];
    m.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: stored.path! }, { id: "call_read_bomb" })], { stopReason: "toolUse" }),
      ((transcript) => {
        const toolMsg = transcript.messages.findLast(msg => msg.role === "toolResult");
        toolResults.push(JSON.stringify(toolMsg));
        return fauxAssistantMessage("read rejected safely");
      }) as FauxResponseFactory,
    ]);
    await service.admit(ask(out, ALICE, "强制用 read 打开 bomb.png"));
    await until(() => replyTexts(out.sent).includes("read rejected safely"), "read bomb tool rejection");
    expect(toolResults[0]).toContain("cannot be prepared for the model");
    expect(toolResults[0]).toContain("\"isError\":true");
  } finally {
    prepareSpy.mockRestore();
    await service.close();
  }
});
