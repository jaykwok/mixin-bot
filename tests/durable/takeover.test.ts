// The console's takeover of a conversation (src/durable/takeover.ts) on the real message service with a faux model: an
// operator's stop cancels the member's running task and waiting messages without a receipt, the operator's text goes to
// the member as a message of the bot and into the conversation, and the member's next message is the bot's again, with
// what the operator said in front of the model.
import { afterAll, expect, test } from "bun:test";
import type { Message, Models } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { ModelSelection } from "../../src/durable/models.ts";
import type { Outbound } from "../../src/durable/outbound.ts";
import { DurableService } from "../../src/durable/service.ts";
import { OPERATOR_NOTE_KIND } from "../../src/durable/operator-note.ts";
import { OPERATOR_TEXT_MAX, scopeOfSpace, Takeover, TakeoverRefused } from "../../src/durable/takeover.ts";
import { appLayout, DIRECT_SCOPE, groupScope } from "../../src/core/layout.ts";
import type { OutboundMessage, SendOutcome, Target } from "../../src/integrations/open-platform/messages.ts";
import { ReadChannel } from "../../src/durable/read/client.ts";
import { fauxModels, TEST_PROGRESS } from "../helpers/durable.ts";
import { DIRECT_SPACE, recordingOutbound, replyTexts } from "../helpers/recording-outbound.ts";
import { tempFixture } from "../helpers/temp.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "../helpers/restore-spies.ts";

const fixture = await tempFixture("durable-takeover-");
afterAll(() => fixture.cleanup());
const ALICE = "13800000001", GONE = "13800000007", GROUP = "70001";
let counter = 0;

function selection(models: Models, ref: ModelRef): ModelSelection {
  return {
    runtime: models as never, settings: undefined as never, model: models.getModel(ref.provider, ref.modelId) as never, ref, thinkingLevel: "off",
    harnessSettings: { retry: { maxRetries: 1, baseDelayMs: 5, maxAgentDelayMs: 20 }, ...(TEST_PROGRESS === undefined ? {} : { progress: TEST_PROGRESS }) },
  };
}

async function until(probe: () => boolean | Promise<boolean>, label: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!await probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

const text = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => "text" in part ? part.text : "").join("");
const userTexts = (messages: Message[]) => messages.filter(message => message.role === "user").map(text);

/** The service with a faux model that keeps each request's transcript and can be held mid-answer, and a takeover over it. */
function harness() {
  const where = join(fixture.root, `root-${++counter}`), layout = appLayout(where);
  const { faux, models, model } = fauxModels();
  const requests: Message[][] = [];
  const state: { hold?: Promise<void> } = {};
  faux.setResponses(Array.from({ length: 30 }, () => ((transcript, options) => {
    requests.push(structuredClone(transcript.messages));
    const answer = fauxAssistantMessage(`answer ${requests.length}`);
    if (!state.hold) return answer;
    return new Promise(done => {
      options?.signal?.addEventListener("abort", () => done(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
      void state.hold!.then(() => done(answer));
    });
  }) as FauxResponseFactory));
  const out = recordingOutbound();
  // Every send with where it went (the recording decodes by the message answered; an operator's message answers none).
  const posted: { target: Target; message: OutboundMessage; answers?: string }[] = [];
  const failing: { when?: (message: OutboundMessage, index: number) => SendOutcome | undefined } = {};
  const send = out.outbound.send.bind(out.outbound);
  const outbound: Outbound = { ...out.outbound,
    send(target, message, options) {
      const outcome = failing.when?.(message, posted.length);
      posted.push({ target, message, ...(options?.replyMsgId ? { answers: options.replyMsgId } : {}) });
      return outcome ? Promise.resolve(outcome) : send(target, message, options);
    },
    sequence(target, work) { return work((message, options) => outbound.send(target, message, options)); },
  };
  const service = new DurableService({
    layout, selection: selection(models, model), modules: [], relay: null, materials: false,
    limits: { runTimeoutMs: 60_000, modelIdleMs: 60_000, modelResponseMs: 60_000, tickMs: 20 }, outbound,
  });
  const people = new Map([[ALICE, { phone: ALICE, name: "张三", imUserId: `im-${ALICE}` }]]);
  const abort = new AbortController();
  const reports: unknown[] = [];
  const takeover = new Takeover({ host: service, outbound, directory: { byPhone: phone => people.get(phone) }, layout, signal: abort.signal, noteRetryMs: [5],
    onReport: error => reports.push(error) });
  // The service's own sends answer a message of the member; an operator's answers none.
  const operatorSends = () => posted.filter(item => item.answers === undefined);
  const answers = () => replyTexts(out.sent.filter(item => item.msgUid !== ""));
  return { where, layout, service, takeover, out, posted, failing, requests, state, people, reports, operatorSends, answers,
    ask: (phone: string, content: string, space = DIRECT_SPACE) => service.admit(out.message(space, phone, content)),
    async close() { abort.abort(); await service.close(); } };
}

/** The entries of a member's conversation, as the console reads them. */
async function entries(h: ReturnType<typeof harness>, space: string, phone: string) {
  const channel = new ReadChannel({ conversations: h.layout.conversations, state: join(h.where, "state", "agent.sqlite") });
  try {
    const { spaces } = await channel.run({ op: "spaces" }) as { spaces: { space: string; generation?: string }[] };
    const generation = spaces.find(each => each.space === space)!.generation!;
    const { items } = await channel.run({ op: "members", space, generation, after: 0, limit: 50 }) as { items: { phone: string; conversationId: number }[] };
    const conversation = items.find(item => item.phone === phone)!.conversationId;
    const page = await channel.run({ op: "entries", space, generation, conversation, older: false, cursor: null, upper: null, limit: 200 }) as
      { items: { kind: string; role?: string; parts: { text?: string }[] }[] };
    return page.items;
  } finally { await channel.close(); }
}

test("space paths name scopes: direct, a group by its ID; a hashed segment names none", () => {
  expect(scopeOfSpace("direct")).toEqual(DIRECT_SCOPE);
  expect(scopeOfSpace("groups/70001")).toEqual(groupScope("70001"));
  expect(scopeOfSpace(`groups/sha256-${"a".repeat(64)}`)).toBeUndefined();
  for (const space of ["", "groups/", "group:70001", "direct/x"]) expect(scopeOfSpace(space)).toBeUndefined();
});

test("say: the running answer stops without a receipt, the operator's text reaches the member and the conversation, and the next message is the bot's again", async () => {
  const h = harness();
  try {
    await h.service.start();
    await h.ask(ALICE, "first question");
    await until(() => h.answers().length === 1, "the first answer");
    // The bot is in the middle of the second answer when the operator steps in.
    const { promise, resolve } = Promise.withResolvers<void>();
    h.state.hold = promise;
    await h.ask(ALICE, "second question");
    await until(() => h.requests.length === 2, "the second request at the model");
    // A third message waits behind it.
    await h.ask(ALICE, "third question");
    const before = h.out.sent.length;
    expect(await h.takeover.say("direct", ALICE, "  这个问题我来答：下周一给你报价。  ")).toEqual({ sent: "sent", recorded: true });
    resolve();
    h.state.hold = undefined;
    // The member got the operator's text as a message of the bot, and nothing else: no receipt, no answer to the stopped questions.
    const mine = h.operatorSends();
    expect(mine.map(item => [item.target, (item.message.content as { content: string }).content]))
      .toEqual([[{ kind: "direct", receiveId: `im-${ALICE}` }, "这个问题我来答：下周一给你报价。"]]);
    await Bun.sleep(200);
    expect(h.answers()).toEqual(["answer 1"]);
    expect(h.out.sent.slice(before).filter(item => item.kind === "notice")).toEqual([]);
    const records = await h.service.records(DIRECT_SCOPE, ALICE);
    expect(Object.values(records.requests).filter(request => request.cancelled).length).toBe(2);
    // The conversation keeps the operator's message as its own kind of entry.
    const kept = (await entries(h, "direct", ALICE)).filter(entry => entry.kind === OPERATOR_NOTE_KIND);
    expect(kept.map(entry => entry.parts.map(part => part.text ?? "").join(""))).toEqual(["[人工回复] 用户发来的这些消息你没有处理，由管理员接手：\n「third question」\n管理员以你的名义直接回复了这位用户，用户已经看到：\n这个问题我来答：下周一给你报价。"]);
    // The member's next message is answered by the bot, with the operator's words in front of the model.
    const asked = h.requests.length;
    await h.ask(ALICE, "那什么时候能签？");
    await until(() => h.answers().length === 2, "the answer after the takeover");
    const seen = userTexts(h.requests.at(-1)!).join("\n---\n");
    expect(h.requests.length).toBe(asked + 1);
    expect(seen).toContain("first question");
    expect(seen).toContain("[人工回复] 用户发来的这些消息你没有处理，由管理员接手：\n「third question」\n管理员以你的名义直接回复了这位用户，用户已经看到：\n这个问题我来答：下周一给你报价。");
    expect(seen).toContain("那什么时候能签？");
    expect(seen.indexOf("[人工回复]")).toBeLessThan(seen.indexOf("那什么时候能签？"));
    // The question the bot was answering stays in the conversation; the waiting one is only in the operator's entry.
    expect(userTexts(h.requests.at(-1)!).filter(each => each.includes("second question")).length).toBe(1);
    expect(userTexts(h.requests.at(-1)!).filter(each => each.includes("third question")).length).toBe(1);
  } finally { await h.close(); }
});

test("stop alone: the task and the waiting messages are cancelled, the member is told nothing, an idle conversation is left as it is", async () => {
  const h = harness();
  try {
    await h.service.start();
    await h.ask(ALICE, "first question");
    await until(() => h.answers().length === 1, "the first answer");
    // Nothing runs: a stop changes nothing.
    await h.takeover.stop("direct", ALICE);
    const { promise, resolve } = Promise.withResolvers<void>();
    h.state.hold = promise;
    await h.ask(ALICE, "second question");
    await until(() => h.requests.length === 2, "the second request at the model");
    const before = h.out.sent.length, posted = h.posted.length;
    await h.takeover.stop("direct", ALICE);
    resolve();
    h.state.hold = undefined;
    await Bun.sleep(200);
    expect(h.out.sent.slice(before)).toEqual([]);
    expect(h.posted.length).toBe(posted);
    expect((await entries(h, "direct", ALICE)).filter(entry => entry.kind === OPERATOR_NOTE_KIND)).toEqual([]);
    await h.ask(ALICE, "third question");
    await until(() => h.answers().length === 2, "the answer after the stop");
  } finally { await h.close(); }
});

test("stop, then say: what the stop cancelled unseen is quoted in the entry of the operator's next text, once; a text that could not be sent keeps it", async () => {
  const h = harness();
  try {
    await h.service.start();
    await h.ask(ALICE, "first question");
    await until(() => h.answers().length === 1, "the first answer");
    const { promise, resolve } = Promise.withResolvers<void>();
    h.state.hold = promise;
    await h.ask(ALICE, "second question");
    await until(() => h.requests.length === 2, "the second request at the model");
    await h.ask(ALICE, "third question");
    // The operator stops the bot first and writes then.
    await h.takeover.stop("direct", ALICE);
    resolve();
    h.state.hold = undefined;
    const notes = async () => (await entries(h, "direct", ALICE)).filter(entry => entry.kind === OPERATOR_NOTE_KIND).map(entry => entry.parts.map(part => part.text ?? "").join(""));
    expect(await notes()).toEqual([]);
    h.failing.when = () => ({ status: "failed", reason: "平台拒绝" });
    await expect(h.takeover.say("direct", ALICE, "我来处理")).rejects.toThrow("消息没有发出去");
    expect(await notes()).toEqual([]);
    delete h.failing.when;
    expect(await h.takeover.say("direct", ALICE, "我来处理")).toEqual({ sent: "sent", recorded: true });
    expect(await h.takeover.say("direct", ALICE, "再补一句")).toEqual({ sent: "sent", recorded: true });
    expect(await notes()).toEqual([
      "[人工回复] 用户发来的这些消息你没有处理，由管理员接手：\n「third question」\n管理员以你的名义直接回复了这位用户，用户已经看到：\n我来处理",
      "[人工回复] 管理员以你的名义直接回复了这位用户，用户已经看到：\n再补一句",
    ]);
  } finally { await h.close(); }
});

test("a stop from another console session while a text goes out: what it cancelled waits for the next entry", async () => {
  const conversations = join(fixture.root, `sessions-${++counter}`, "conversations");
  mkdirSync(join(conversations, "direct"), { recursive: true });
  writeFileSync(join(conversations, "direct", "durable.sqlite"), "");
  const halts = [["消息 A"], ["消息 B"]], notes: string[] = [];
  let release = Promise.withResolvers<void>();
  const takeover = new Takeover({
    host: {
      hasConversation: async () => true,
      halt: async () => ({ waiting: halts.shift() ?? [] }),
      note: async (_scope, _phone, _id, entry) => { notes.push(JSON.stringify(entry.model ?? [])); },
    },
    outbound: { sequence: async (_target: Target, work: (send: () => Promise<SendOutcome>) => Promise<unknown>) => work(async () => { await release.promise; return { status: "sent" }; }) } as never,
    directory: { byPhone: phone => ({ phone, name: "张三", imUserId: `im-${phone}` }) as never },
    layout: { conversations }, signal: new AbortController().signal, noteRetryMs: [],
  });
  const first = takeover.say("direct", ALICE, "第一条");
  await Bun.sleep(10);
  // The other session's stop lands while the first text is still going out.
  await takeover.stop("direct", ALICE);
  release.resolve();
  expect(await first).toEqual({ sent: "sent", recorded: true });
  release = Promise.withResolvers<void>();
  release.resolve();
  expect(await takeover.say("direct", ALICE, "第二条")).toEqual({ sent: "sent", recorded: true });
  expect(notes.map(note => [note.includes("消息 A"), note.includes("消息 B")])).toEqual([[true, false], [false, true]]);
});

test("a group conversation: the operator's message goes to the group and names the member", async () => {
  const h = harness();
  try {
    await h.service.start();
    await h.ask(ALICE, "group question", GROUP);
    await until(() => h.answers().length === 1, "the group answer");
    expect(await h.takeover.say(`groups/${GROUP}`, ALICE, "补充一点：这款下月停产。")).toEqual({ sent: "sent", recorded: true });
    const mine = h.operatorSends().at(-1)!;
    expect(mine.target).toEqual({ kind: "group", receiveId: GROUP });
    expect(mine.message.content).toMatchObject({ content: "补充一点：这款下月停产。", a: [{ i: `im-${ALICE}` }] });
    expect((await entries(h, `groups/${GROUP}`, ALICE)).filter(entry => entry.kind === OPERATOR_NOTE_KIND).length).toBe(1);
    // The member's direct conversation is another one: nothing was written there (there is none).
    await expect(h.takeover.say("direct", ALICE, "x")).rejects.toThrow("没有这个会话空间");
  } finally { await h.close(); }
});

test("a conversation whose request records are gone (a day after they closed) can still be taken over", async () => {
  const h = harness();
  try {
    await h.service.start();
    await h.ask(ALICE, "first question");
    await until(() => h.answers().length === 1, "the first answer");
    await until(async () => Object.values((await h.service.records(DIRECT_SCOPE, ALICE)).requests).every(record => record.closedAt !== undefined), "closed records");
    await h.service.maintain(Date.now() + 25 * 3600_000);
    expect(Object.keys((await h.service.records(DIRECT_SCOPE, ALICE)).requests)).toEqual([]);
    expect((await entries(h, "direct", ALICE)).length).toBeGreaterThan(0);
    expect(await h.takeover.say("direct", ALICE, "管理员补充回复")).toEqual({ sent: "sent", recorded: true });
    const kept = (await entries(h, "direct", ALICE)).filter(entry => entry.kind === OPERATOR_NOTE_KIND);
    expect(kept.map(entry => entry.parts.map(part => part.text ?? "").join("")).join("")).toContain("管理员补充回复");
  } finally { await h.close(); }
});

test("refusals: no such space, a member without a conversation there, one the directory no longer knows, an empty or oversized text; nothing is sent or stopped", async () => {
  const h = harness();
  try {
    await h.service.start();
    await h.ask(ALICE, "first question");
    await h.ask(GONE, "a question of someone who then left");
    await until(() => h.answers().length === 2, "the answers");
    const posted = h.posted.length;
    for (const [space, phone, value, reason] of [
      ["groups/999", ALICE, "x", "没有这个会话空间"], ["nowhere", ALICE, "x", "没有这个会话空间"], ["direct", "13800000099", "x", "还没有和机器人的对话"],
      ["direct", GONE, "x", "已不在机器人同步的通讯录范围内"], ["direct", ALICE, "   ", "请输入要发给成员的内容"],
      ["direct", ALICE, "字".repeat(OPERATOR_TEXT_MAX + 1), `一次最多发 ${OPERATOR_TEXT_MAX} 个字`]] as const) {
      const refused = await h.takeover.say(space, phone, value).then(() => undefined, (error: unknown) => error as Error);
      expect(refused).toBeInstanceOf(TakeoverRefused);
      expect(refused!.message).toContain(reason);
    }
    await expect(h.takeover.stop("direct", GONE)).rejects.toThrow("已不在机器人同步的通讯录范围内");
    expect(h.posted.length).toBe(posted);
    expect((await entries(h, "direct", ALICE)).filter(entry => entry.kind === OPERATOR_NOTE_KIND)).toEqual([]);
  } finally { await h.close(); }
});

test("sending fails or is not confirmed: a failed message is refused and not recorded, an unconfirmed one is recorded and reported so", async () => {
  const h = harness();
  try {
    await h.service.start();
    await h.ask(ALICE, "first question");
    await until(() => h.answers().length === 1, "the first answer");
    h.failing.when = () => ({ status: "failed", reason: "平台拒绝" });
    await expect(h.takeover.say("direct", ALICE, "第一条")).rejects.toThrow("消息没有发出去（平台拒绝），请稍后再试。");
    expect((await entries(h, "direct", ALICE)).filter(entry => entry.kind === OPERATOR_NOTE_KIND)).toEqual([]);
    h.failing.when = () => ({ status: "uncertain", reason: "超时" });
    expect(await h.takeover.say("direct", ALICE, "第二条")).toEqual({ sent: "uncertain", recorded: true });
    // A long text in segments, the second one fails: the member has the first, and that is what the bot is told.
    const long = `${"甲".repeat(3_000)}\n\n${"乙".repeat(900)}`;
    let sends = 0;
    h.failing.when = () => ++sends === 1 ? undefined : { status: "failed", reason: "平台拒绝" };
    const partial = await h.takeover.say("direct", ALICE, long);
    if (sends > 1) {
      expect(partial).toEqual({ sent: "partial", recorded: true, segments: { sent: 1, total: sends } });
      const kept = (await entries(h, "direct", ALICE)).filter(entry => entry.kind === OPERATOR_NOTE_KIND).map(entry => entry.parts.map(part => part.text ?? "").join(""));
      expect(kept.length).toBe(2);
      expect(kept[1]).toContain("甲".repeat(100));
      expect(kept[1]).not.toContain("乙");
    } else expect(partial).toEqual({ sent: "sent", recorded: true });
  } finally { await h.close(); }
});
