// The push tools, in three extensions a member's conversation selects by what the member is to pushes right now
// (src/server/app.ts passes them to the message service as member extensions, `pushSelection` names the ones that apply):
//
// - `mixin.push`, for pushers in the direct chat: push_prepare and push_status, with the prompt section on pushing.
// - `mixin.push-reply`, for a member (in the direct chat) or a group that a live push reached: push_reply, and in the
//   direct chat push_forward, with the prompt section on answering; before each model request it appends the live
//   pushes to the tail (never to the history).
// - `mixin.directory`, for both in the direct chat: directory_lookup.
//
// Everyone else has neither the tools nor the texts. Model-only like the send tools: push_prepare and push_forward send a
// card that cannot be taken back. Neither sends to anyone else: that takes 「确认推送」 or 「确认转派」 on the card, which only
// the service sees (./service.ts).
import { defineExtension, type Extension, GenerationTask, hook, section } from "@earendil-works/pi-durable";
import { arr, bool, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { resolveSource } from "../agent/send-tools.ts";
import { type Layout, parseScopeKey, type Scope } from "../core/layout.ts";
import { activeRequest, appendTail } from "../durable/closeout.ts";
import { IdentityDoc } from "../durable/identity.ts";
import { memberTool, type Member, type MemberCall, type MemberToolSpec } from "../durable/tools.ts";
import { type ForwardInput, type LookupInput, PUSH_LIMITS, type PrepareInput, type PushService, type ReplyInput } from "./service.ts";

export const PUSH_EXTENSION = "mixin.push";
export const PUSH_REPLY_EXTENSION = "mixin.push-reply";
export const DIRECTORY_EXTENSION = "mixin.directory";

const CALLERS = ["model"] as const;

const person = obj({
  name: str({ description: "姓名，与通讯录一致" }),
  phone: str({ description: "手机号" }),
}, { open: true });

const department = obj({
  name: str({ description: "部门名称，或从上级写起的路径（如 技术部/研发组）；有同名部门时要写路径" }),
  children: opt(bool({ description: "是否包括下级部门；默认包括，成员明确说不含下级时写 false" })),
}, { open: true });

const recipient = obj({
  name: str({ description: "姓名，与通讯录一致" }),
  phone: str({ description: "手机号" }),
  values: opt(arr(str(), { description: "写了 fields 时必填：这个人各栏的内容，个数和顺序与 fields 一致" })),
}, { open: true });

const prepareParams = obj({
  recipients: opt(arr(recipient, { description: `按人推送：每人姓名和手机号都要有（不知道手机号先用 directory_lookup 查），最多 ${PUSH_LIMITS.people} 人` })),
  departments: opt(arr(department, { description: `按部门推送，最多 ${PUSH_LIMITS.departments} 个部门；需要管理员授权` })),
  everyone: opt(bool({ description: "推送给全员（机器人同步的通讯录范围内的所有人）；需要管理员授权" })),
  groups: opt(arr(obj({ name: str({ description: "登记的群名" }) }, { open: true }),
    { description: `推送到群（只能是管理员登记过的群），最多 ${PUSH_LIMITS.groups} 个；需要管理员授权；群推送不能用 options` })),
  subject: str({ description: `主题，不超过 ${PUSH_LIMITS.subjectChars} 个字` }),
  body: str({ description: `正文（Markdown），不超过 ${PUSH_LIMITS.bodyChars} 个字` }),
  mode: oneOf(["ack", "options", "reply"],
    { description: "要求：ack 只需确认收到；options 在给定选项中选一个；reply 需要回复（文字或附件）" }),
  options: opt(arr(str(), { description: `mode 为 options 时的选项，${PUSH_LIMITS.options[0]} 到 ${PUSH_LIMITS.options[1]} 个，每个不超过 ${PUSH_LIMITS.optionChars} 个字` })),
  deadline: opt(str({ description: "截止时间，写成 2026-11-07 18:00，最早是 10 分钟之后；只写日期表示当天 23:59；不写默认 3 天后" })),
  cc: opt(arr(person, { description: `抄送人，只收到汇总；默认没有，最多 ${PUSH_LIMITS.cc} 人` })),
  remind: opt(bool({ description: "是否自动提醒没有答复的人；默认提醒，成员说不用提醒时写 false" })),
  attachments: opt(arr(str(), { description: `随推送发给每个接收人的附件：文件路径（成员发来的文件、共享资料里的文件，或这次任务生成的文件），最多 ${PUSH_LIMITS.files} 个，每个不超过 30 MB` })),
  fields: opt(arr(str(), { description: `每个接收人内容不同时的栏目名（如 本月指标、完成率），最多 ${PUSH_LIMITS.fields} 栏，每个不超过 ${PUSH_LIMITS.fieldChars} 个字；写了它就只能按人推送，recipients 里每人要有 values（每项不超过 ${PUSH_LIMITS.valueChars} 个字）` })),
}, { open: true });

const statusParams = obj({
  id: opt(str({ description: "推送编号；不写则列出最近的 5 条推送" })),
}, { open: true });

const lookupParams = obj({
  names: opt(arr(str(), { description: `姓名，可以只写其中几个字；要查几个人就写几个，一次最多 ${PUSH_LIMITS.lookupNames} 个，每个名字分别查` })),
  phone: opt(str({ description: "完整的手机号" })),
  department: opt(str({ description: "部门名称，或从上级写起的路径（如 华东分公司/销售部）；列出部门里的人" })),
  children: opt(bool({ description: "按部门查时是否包括下级部门；默认包括" })),
}, { open: true });

const replyParams = obj({
  push: str({ description: "推送编号，见请求末尾“[推送]”一段" }),
  action: oneOf(["add", "replace", "withdraw"],
    { description: "add 把这条消息记入回复（成员分几条发就记几次）；replace 用这条消息替换之前记的；withdraw 撤回之前记的，这条消息本身不记" }),
  quote: opt(str({ description: "要记的不是当前这条消息、而是成员前面发的某一条时，照抄那条消息里的一小段原话；记当前这条消息时不写" })),
}, { open: true });

const forwardParams = obj({
  push: str({ description: "推送编号，见请求末尾“[推送]”一段" }),
  to: obj({ name: str({ description: "转给谁：姓名，与通讯录一致" }), phone: str({ description: "对方的手机号（不知道先用 directory_lookup 查）" }) }, { open: true }),
}, { open: true });

const PROMPT = `你可以替当前成员发起推送：把一条通知以卡片发给通讯录里的人，接收人确认收到、选择或回复，机器人收集后在截止时（或全部答复后）把汇总发给推送人和抄送人。

- 成员要推送时，先弄清：推送对象、主题、正文、要求（只需确认 ack、选项 options、需要回复 reply）、截止时间（可选，默认 3 天）、抄送人（可选，默认没有）。不清楚的先问，不要猜。
- 推送对象可以是个人（每人姓名和手机号）、部门（名称或路径，默认包括下级部门）、全员、登记过的群（按群名），也可以组合。部门、全员和群要管理员授权，没有授权时 push_prepare 会拒绝。部门和全员的名单不含成员自己，在成员点「确认推送」时按当时的通讯录展开。
- 成员只说了姓名或部门、没给手机号时，先用 directory_lookup 查通讯录（成员说了几个人，就在一次调用里把名字都写上）：按姓名只查到一个人，就用查到的姓名和手机号；查到几个人，或成员只说了部门（如 某某分公司）而要推送给其中某些人，把查到的人（姓名和部门）列给成员，由成员指定推送给谁，不要替成员挑。查不到就告诉成员没有查到。成员不推送、只想查某人的手机号或部门，也用 directory_lookup。
- 群推送在群里发一张卡片，群里谁确认、谁回复都算这个群的；群里只收文字回复，不能用选项（options）。需要按人收集附件或选项时，请推送给个人或部门。群要先由管理员在群里发“@机器人 /登记群 群名”登记，没有登记的群不能推送。
- 成员要随推送带文件（通知的附件、要填的表）：把文件路径写进 attachments，可以是成员发来的文件、共享资料里的文件，或你这次生成的文件。接收人先收到这些文件，再收到卡片。文件在准备时就定下来，之后再改文件要重新准备。
- 每个接收人要看到不同的内容时（各自的指标、分工、座位、结果）：正文写大家都一样的部分，fields 写栏目名，recipients 里每个人的 values 按栏目顺序写这个人的内容；每个人的卡片在正文后面只显示自己的那几项。只能按人推送。每一项都必须出自成员给的材料（成员的话、发来的表），原样抄写，不换算、不补全、不推测；哪个人缺一项、对不上，先问成员。准备后预览卡片和随后的核对表会列出每个人的内容，提醒成员逐人核对后再确认。
- 信息齐了调用 push_prepare。它只把预览卡片发给成员本人，不会发给任何接收人；成员在预览卡片上点「确认推送」才会发出。不要说已经推送，也不要替成员确认。
- push_prepare 拒绝时，把原因告诉成员，按成员的修改重新调用。它说名单里有人没有对上时，预览里是其余的人：把没对上的人和原因告诉成员，由成员决定先发给其余的人，还是改正后重新准备；不要自己换成别的人。
- 成员问推送的情况（谁确认了、谁没回复、回复了什么、转给了谁），用 push_status 查；只能查成员自己发起的推送。
- 接收人直接把回复发给机器人，机器人记下原话；接收人也可以把推送转给通讯录里的其他人，转了就算他处理过了，推送人会收到通知。需要回复的推送在全部回复、十分钟内没有人再补充后结束；到截止时间也结束。汇总由系统发出。
- 推送发出后系统自己跟进：时间过半时把进度发给成员，并把卡片再发一次给还没有答复的人；一天以上的推送临近截止时再来一次，不到 2 小时的推送没有，夜里不发。成员说不用提醒接收人，remind 写 false，进度照样发给成员。
- 成员另外要再提醒没有答复的人时：推送结束后点汇总卡片上的「提醒未回复」（同样先发预览）；推送还在进行中的，请管理员在控制台推送页补推送。`;

const REPLY_PROMPT = `成员收到、还没有结束的推送列在每次请求末尾的“[推送]”一段里（系统提供，成员看不到这一段）。要求回复的推送不用点按钮：成员直接把回复发给你，你用 push_reply 记下，推送人到时收到汇总。

- 先看这条消息和哪条推送有关。是在回复某条推送：调用 push_reply，action 用 add。记下的是成员这条消息的原文和随它发来的附件，不是你的转述，所以不用整理内容，附件也不用打开看；记完只用一句话告诉成员记到哪条推送里了：不复述、不概括成员写的内容，不评价写得全不全，不追问。
- 有推送在等回复，成员发来的又正是它要的内容（推送要本周进展，成员发来一段进展），就按回复记，不用等成员说“这是回复”。
- 成员在问推送本身（什么意思、什么时候截止、要交什么）：按推送正文回答，不记。和推送无关的话照常处理，不记；这时不用说明没有记，也不顺带提醒成员还有推送没回。
- 几条推送都在等回复、分不清回的是哪条：问成员一句，不猜。成员答了之后，要记的是他前面那条消息：用 quote 照抄那条消息里的一小段原话。成员说“刚才那条就是回复”时也这样记。
- 成员说“改成……”“以这条为准”：action 用 replace。说“刚才那条不算”“撤回”：action 用 withdraw。改完、撤完同样只回一句。已经回复过的推送，成员明确要补充或修改时才动。
- 只需确认收到或选择的推送，由成员在卡片上点，你不能代点。
- 成员说这件事该由别人处理、要转给某人：用 directory_lookup 查到这个人（查到几个，把姓名、部门和手机号列给成员挑），再调用 push_forward。它只给成员发一张确认卡片，成员点「确认转派」后才发给对方，推送人会收到通知；不要说已经转了。只能转给机器人同步的通讯录里的人。
- push_reply、push_forward 拒绝时，把原因告诉成员。`;

const GROUP_REPLY_PROMPT = `本群收到、还没有结束的推送列在每次请求末尾的“[推送]”一段里（系统提供，成员看不到这一段）。要求回复的推送，群里任何人 @ 你发的文字都可以算本群的回复：你用 push_reply 记下，推送人到时收到汇总。

- 成员这条消息是在回复某条推送：调用 push_reply，action 用 add。记下的是这条消息的原文和发的人，不是你的转述；记完用一句话告诉成员记到哪条推送里了，不复述内容。
- 有推送在等回复，成员发来的又正是它要的内容，就按回复记。成员在问推送本身，按推送正文回答，不记；无关的话照常处理。
- 分不清回的是哪条推送：问一句。成员答了之后，用 quote 照抄他前面那条消息里的一小段原话来记。
- 成员要改自己发的：action 用 replace；要撤回自己发的：action 用 withdraw。别人发的内容动不了。
- 群里只收文字回复；确认收到由群里的人在卡片上点。push_reply 拒绝时，把原因告诉成员。`;

/** What the tools need from the push service. */
export type PushTools = Pick<PushService, "prepare" | "status" | "lookup" | "reply" | "forward" | "pending" | "isPusher" | "hasLive">;

/** The request the call belongs to: who asks, where, and the member's message as it was sent. */
async function caller(member: Member, call: MemberCall, action: string, direct = true) {
  const item = await activeRequest(call.api, call.context);
  const scope = item && parseScopeKey(item.space);
  if (!item || !scope || item.phone !== member.phone) throw new Error(`没有正在执行的任务，不能${action}`);
  if (direct && scope.kind !== "direct") throw new Error(`${action}只能在单聊里进行`);
  const { reply } = item.record;
  return { phone: member.phone, scope, reply, message: { msgUid: reply.msgUid, text: item.content, receivedAt: reply.receivedAt } };
}

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }], details: {} });

function pusherSpecs(push: PushTools): MemberToolSpec[] {
  const prepare: MemberToolSpec<typeof prepareParams> = {
    name: "push_prepare",
    description: "准备一条推送：核对对象和内容，把预览卡片发给当前成员；成员点卡片上的「确认推送」后才发给接收人。",
    callers: CALLERS,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    parameters: prepareParams,
    async run(params, member, call) {
      const who = await caller(member, call, "推送");
      // The files are checked like those of send_file: inside the shared materials or the member's own tmp.
      const attachments: { path: string; size: number }[] = [], listed = params.attachments ?? [];
      // Too many is said with the real number, before any of the files is looked at.
      if (listed.length > PUSH_LIMITS.files) throw new Error(`推送未准备：附件最多 ${PUSH_LIMITS.files} 个，现在是 ${listed.length} 个`);
      for (const path of listed) {
        const source = await resolveSource(String(path), member.places.workspaceDir, member.places.tempDir, call.signal);
        if (source.kind !== "local") throw new Error("推送的附件只能是文件：成员发来的、共享资料里的或这次任务生成的；链接请直接写进正文");
        attachments.push({ path: source.path, size: source.size });
      }
      return text(await push.prepare(who, { ...params, attachments } as PrepareInput));
    },
  };
  const status: MemberToolSpec<typeof statusParams> = {
    name: "push_status",
    description: "查询当前成员自己发起的推送：不给编号列出最近 5 条，给编号列出每个接收人的确认、选择、回复和转派。",
    callers: CALLERS,
    parameters: statusParams,
    async run(params, member, call) {
      const { phone } = await caller(member, call, "推送");
      return text(push.status(phone, params.id));
    },
  };
  return [prepare, status];
}

function lookupSpec(push: PushTools): MemberToolSpec {
  const lookup: MemberToolSpec<typeof lookupParams> = {
    name: "directory_lookup",
    description: "查机器人同步的通讯录：按姓名（可以只写其中几个字，可以一次查几个人）、手机号或部门找人，列出姓名、手机号和所在部门；几项一起写时要同时符合。",
    callers: CALLERS,
    parameters: lookupParams,
    async run(params, member, call) {
      const { phone } = await caller(member, call, "查通讯录");
      return text(push.lookup(phone, params as LookupInput));
    },
  };
  return lookup as MemberToolSpec;
}

function replySpecs(push: PushTools, scope: Scope): MemberToolSpec[] {
  const reply: MemberToolSpec<typeof replyParams> = {
    name: "push_reply",
    description: "把成员的消息记为一条推送的回复，或者修改、撤回已经记下的回复。记的是成员消息的原文和随消息发来的附件。",
    callers: CALLERS,
    parameters: replyParams,
    async run(params, member, call) {
      const { phone, scope: space, message } = await caller(member, call, "记回复", false);
      return text(await push.reply({ scope: space, phone, message }, params as ReplyInput));
    },
  };
  const forward: MemberToolSpec<typeof forwardParams> = {
    name: "push_forward",
    description: "准备把一条推送转给通讯录里的另一个人：给当前成员发一张确认卡片，成员点「确认转派」后才发给对方。",
    callers: CALLERS,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    parameters: forwardParams,
    async run(params, member, call) {
      const { phone } = await caller(member, call, "转派");
      return text(await push.forward({ phone }, params as ForwardInput));
    },
  };
  return scope.kind === "direct" ? [reply as MemberToolSpec, forward as MemberToolSpec] : [reply as MemberToolSpec];
}

/** A space's push extensions: all three for the direct space, the reply one for a group. */
export function pushExtensions(push: PushTools, scope: Scope, options: { layout: Layout; venvDir?: string }): Extension[] {
  const places = { layout: options.layout, scope, ...(options.venvDir ? { venvDir: options.venvDir } : {}) };
  const tools = (specs: readonly MemberToolSpec[]) => specs.map(spec => memberTool(spec, places).registration);
  const answering = defineExtension({ name: PUSH_REPLY_EXTENSION, tools: tools(replySpecs(push, scope)),
    sections: [section("push-reply", () => scope.kind === "direct" ? REPLY_PROMPT : GROUP_REPLY_PROMPT)],
    hooks: [hook(GenerationTask, {
      // The live pushes change between requests and differ by member: the tail, never the history or the system prompt.
      async beforeRequest(request, api, context) {
        const identity = await api.snapshot(IdentityDoc, api.conversationId, context);
        const pending = identity?.phone ? push.pending(scope, identity.phone) : undefined;
        return pending === undefined ? undefined : { messages: appendTail(request.messages, pending, Date.now()) };
      },
    })] });
  if (scope.kind !== "direct") return [answering];
  return [defineExtension({ name: PUSH_EXTENSION, tools: tools(pusherSpecs(push)), sections: [section("push", () => PROMPT)] }),
    answering, defineExtension({ name: DIRECTORY_EXTENSION, tools: tools([lookupSpec(push)]) })];
}

/** The push extensions a member's conversation in `scope` selects now: by role, and by the live pushes that reached the member or the group. */
export function pushSelection(push: Pick<PushTools, "isPusher" | "hasLive">, scope: Scope, phone: string): string[] {
  const pusher = scope.kind === "direct" && push.isPusher(phone), reached = push.hasLive(scope, phone);
  return [...(pusher ? [PUSH_EXTENSION] : []), ...(reached ? [PUSH_REPLY_EXTENSION] : []), ...(scope.kind === "direct" && (pusher || reached) ? [DIRECTORY_EXTENSION] : [])];
}
