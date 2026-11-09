// `mixin.push`: push_prepare, push_status and directory_lookup, with the prompt section that explains them. Only
// pushers' direct conversations select it (src/server/app.ts passes it to the message service as a member extension),
// so everyone else has neither the tools nor the text.
//
// Model-only like the send tools: push_prepare sends the preview card, which cannot be taken back. It never sends to a
// recipient: that takes 「确认推送」 on the preview, which only the service sees (./service.ts).
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import { arr, bool, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { Layout } from "../core/layout.ts";
import { DIRECT_SCOPE } from "../core/layout.ts";
import { activeRequest } from "../durable/closeout.ts";
import { memberTool, type Member, type MemberCall, type MemberToolSpec } from "../durable/tools.ts";
import { type LookupInput, PUSH_LIMITS, type PrepareInput, type PushService } from "./service.ts";

export const PUSH_EXTENSION = "mixin.push";

const CALLERS = ["model"] as const;

const person = obj({
  name: str({ description: "姓名，与通讯录一致" }),
  phone: str({ description: "手机号" }),
}, { open: true });

const department = obj({
  name: str({ description: "部门名称，或从上级写起的路径（如 技术部/研发组）；有同名部门时要写路径" }),
  children: opt(bool({ description: "是否包括下级部门；默认包括，成员明确说不含下级时写 false" })),
}, { open: true });

const prepareParams = obj({
  recipients: opt(arr(person, { description: `按人推送：每人姓名和手机号都要有（不知道手机号先用 directory_lookup 查），最多 ${PUSH_LIMITS.people} 人` })),
  departments: opt(arr(department, { description: `按部门推送，最多 ${PUSH_LIMITS.departments} 个部门；需要管理员授权` })),
  everyone: opt(bool({ description: "推送给全员（机器人同步的通讯录范围内的所有人）；需要管理员授权" })),
  groups: opt(arr(obj({ name: str({ description: "登记的群名" }) }, { open: true }),
    { description: `推送到群（只能是管理员登记过的群），最多 ${PUSH_LIMITS.groups} 个；需要管理员授权；群推送不能用 options` })),
  subject: str({ description: `主题，不超过 ${PUSH_LIMITS.subjectChars} 个字` }),
  body: str({ description: `正文（Markdown），不超过 ${PUSH_LIMITS.bodyChars} 个字` }),
  mode: oneOf(["ack", "options", "reply"],
    { description: "要求：ack 只需确认收到；options 在给定选项中选一个；reply 需要回复（文字或附件）" }),
  options: opt(arr(str(), { description: `mode 为 options 时的选项，${PUSH_LIMITS.options[0]} 到 ${PUSH_LIMITS.options[1]} 个，每个不超过 ${PUSH_LIMITS.optionChars} 个字` })),
  deadline: opt(str({ description: "截止时间，写成 2026-11-07 18:00；只写日期表示当天 23:59；不写默认 3 天后" })),
  cc: opt(arr(person, { description: `抄送人，只收到汇总；默认没有，最多 ${PUSH_LIMITS.cc} 人` })),
}, { open: true });

const statusParams = obj({
  id: opt(str({ description: "推送编号；不写则列出最近的 5 条推送" })),
}, { open: true });

const lookupParams = obj({
  name: opt(str({ description: "姓名，可以只写其中几个字" })),
  phone: opt(str({ description: "完整的手机号" })),
  department: opt(str({ description: "部门名称，或从上级写起的路径（如 华东分公司/销售部）；列出部门里的人" })),
  children: opt(bool({ description: "按部门查时是否包括下级部门；默认包括" })),
}, { open: true });

const PROMPT = `你可以替当前成员发起推送：把一条通知以卡片发给通讯录里的人，接收人在卡片上确认收到、选择或回复，机器人收集后在截止时（或全部答复后）把汇总发给推送人和抄送人。

- 成员要推送时，先弄清：推送对象、主题、正文、要求（只需确认 ack、选项 options、需要回复 reply）、截止时间（可选，默认 3 天）、抄送人（可选，默认没有）。不清楚的先问，不要猜。
- 推送对象可以是个人（每人姓名和手机号）、部门（名称或路径，默认包括下级部门）、全员、登记过的群（按群名），也可以组合。部门、全员和群要管理员授权，没有授权时 push_prepare 会拒绝。部门和全员的名单不含成员自己，在成员点「确认推送」时按当时的通讯录展开。
- 成员只说了姓名或部门、没给手机号时，先用 directory_lookup 查通讯录：按姓名只查到一个人，就用查到的姓名和手机号；查到几个人，或成员只说了部门（如 某某分公司）而要推送给其中某些人，把查到的人（姓名和部门）列给成员，由成员指定推送给谁，不要替成员挑。查不到时如实告诉成员。成员不推送、只想查某人的手机号或部门，也用 directory_lookup。
- 群推送在群里发一张卡片，群里谁确认、谁回复都算这个群的；群里只能回复文字，不能用选项（options）。需要按人收集附件或选项时，请推送给个人或部门。群要先由管理员在群里发“@机器人 /登记群 群名”登记，没有登记的群不能推送。
- 信息齐了调用 push_prepare。它只把预览卡片发给成员本人，不会发给任何接收人；成员在预览卡片上点「确认推送」才会发出。不要说已经推送，也不要替成员确认。
- push_prepare 拒绝时，把原因原样告诉成员，按成员的修改重新调用。
- 成员问推送的情况（谁确认了、谁没回复、回复了什么），用 push_status 查；只能查成员自己发起的推送。
- 接收人的点击和回复由系统直接收集，不经过你；汇总在截止或全部答复后由系统发出。
- 成员要再提醒没有答复的人时：推送结束后点汇总卡片上的「提醒未回复」（同样先发预览）；推送还在进行中的，请管理员在控制台推送页补推送。`;

/** What the tools need from the push service. */
export type PushTools = Pick<PushService, "prepare" | "status" | "lookup">;

async function caller(member: Member, call: MemberCall, action = "推送") {
  const item = await activeRequest(call.api, call.context);
  if (!item || item.phone !== member.phone) throw new Error(`没有正在执行的任务，不能${action}`);
  if (item.record.reply.kind !== "direct") throw new Error(`${action}只能在单聊里进行`);
  return { phone: member.phone, reply: item.record.reply };
}

function specs(push: PushTools): MemberToolSpec[] {
  const prepare: MemberToolSpec<typeof prepareParams> = {
    name: "push_prepare",
    description: "准备一条推送：核对对象和内容，把预览卡片发给当前成员；成员点卡片上的「确认推送」后才发给接收人。",
    callers: CALLERS,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    parameters: prepareParams,
    async run(params, member, call) {
      const text = await push.prepare(await caller(member, call), params as PrepareInput);
      return { output: [{ type: "text", text }], details: {} };
    },
  };
  const status: MemberToolSpec<typeof statusParams> = {
    name: "push_status",
    description: "查询当前成员自己发起的推送：不给编号列出最近 5 条，给编号列出每个接收人的确认、选择和回复。",
    callers: CALLERS,
    parameters: statusParams,
    async run(params, member, call) {
      const { phone } = await caller(member, call);
      return { output: [{ type: "text", text: push.status(phone, params.id) }], details: {} };
    },
  };
  const lookup: MemberToolSpec<typeof lookupParams> = {
    name: "directory_lookup",
    description: "查机器人同步的通讯录：按姓名（可以只写其中几个字）、手机号或部门找人，列出姓名、手机号和所在部门；几项一起写时要同时符合。",
    callers: CALLERS,
    parameters: lookupParams,
    async run(params, member, call) {
      const { phone } = await caller(member, call, "查通讯录");
      return { output: [{ type: "text", text: push.lookup(phone, params as LookupInput) }], details: {} };
    },
  };
  return [prepare, status, lookup];
}

/** The extension, for the direct space (the only one push is started from). */
export function pushExtension(push: PushTools, options: { layout: Layout; venvDir?: string }): Extension {
  const places = { layout: options.layout, scope: DIRECT_SCOPE, ...(options.venvDir ? { venvDir: options.venvDir } : {}) };
  return defineExtension({ name: PUSH_EXTENSION, tools: specs(push).map((spec) => memberTool(spec, places).registration),
    sections: [section("push", () => PROMPT)] });
}
