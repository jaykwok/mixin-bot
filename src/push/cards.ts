// Push cards: the pusher's preview, each recipient's card in every state (a person's, or a group's that anyone in the
// group answers), the card that asks a recipient before a push is handed on, and the button data a click brings back.
//
// Buttons carry `{ k: "push", p: <push ID>, a: <action>, v: <card version>, o?: <option index>, f?: <forward ID> }`. Every
// update of a card raises its version, so a redelivered click or one on a button the card no longer shows names an older
// version: the service then only refreshes the card to its current state (./service.ts). Replies have no buttons: the
// recipient writes to the bot and the conversation records the reply (./tools.ts push_reply).
import type { CardButton, CardContent } from "../integrations/open-platform/messages.ts";
import { escapeInline } from "../durable/outbound.ts";
import { checkpoints } from "./reminders.ts";
import { type Forward, memberGroup, type Push, type Recipient } from "./store.ts";

export type PreviewAction = "confirm" | "cancel";
export type RecipientAction = "ack" | "choose";
/** On the card that asks a recipient whether to hand the push on. */
export type ForwardAction = "forward" | "keep";
/** On the pusher's summary card: prepare a push to those who did not answer. */
export type SummaryAction = "remind";
export type CardAction = PreviewAction | RecipientAction | ForwardAction | SummaryAction;
const ACTIONS: readonly CardAction[] = ["confirm", "cancel", "ack", "choose", "forward", "keep", "remind"];

export type ClickData = { push: string; action: CardAction; version: number; option?: number; forward?: string };

const COLOR = { waiting: "#2D71FF", replying: "#D97706", done: "#16A34A", closed: "#8A8F99" } as const;
export const PUSH_ID = /^[a-z0-9]{8}$/;

/** Card body limit (measured ~5000 characters); push texts are bounded well below it (./service.ts). */
export const CARD_MAX_CHARS = 5000;

/** `11-03 10:20`, with the year when it is not the current one. */
export function shortTime(at: number, now = Date.now()): string {
  const date = new Date(at), pad = (n: number) => String(n).padStart(2, "0");
  const year = date.getFullYear() === new Date(now).getFullYear() ? "" : `${date.getFullYear()}-`;
  return `${year}${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The last four digits of a phone, as cards and summaries name people. */
export function phoneTail(phone: string): string {
  return phone.slice(-4);
}

export function requirementText(push: Pick<Push, "mode" | "options">): string {
  return push.mode === "ack" ? "确认收到" : push.mode === "options" ? `选择：${push.options.join(" / ")}` : "需要回复（文字或附件）";
}

function button(push: Pick<Push, "id">, version: number, index: number, name: string, action: CardAction, style: 1 | 2,
  extra: { option?: number; forward?: string } = {}): CardButton {
  return { name, type: "button", index, show: true, disabled: false, value: { placeholder: "action", value: action, style, url: "", method: "POST",
    data: { k: "push", p: push.id, a: action, v: version, ...(extra.option === undefined ? {} : { o: extra.option }), ...(extra.forward === undefined ? {} : { f: extra.forward }) } } };
}

function card(title: string, content: string, status: { name: string; color: string }, buttons: CardButton[], msgUid: string | null, invalid = false): CardContent {
  return { title, content, status, invalid, pcLayout: buttons.length ? [buttons.map(item => item.index)] : [], tailFields: buttons,
    ...(msgUid ? { msgUid } : {}) };
}

/** The part of a click event a push card sent: undefined for anything else. */
export function clickData(content: unknown): ClickData | undefined {
  const parse = (value: unknown): Record<string, unknown> | undefined => {
    if (typeof value === "string") { try { value = JSON.parse(value); } catch { return undefined; } }
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  };
  const data = parse(parse(content)?.data);
  if (!data || data.k !== "push" || typeof data.p !== "string" || !PUSH_ID.test(data.p)) return undefined;
  const action = data.a as CardAction;
  const version = Number(data.v), option = data.o === undefined ? undefined : Number(data.o);
  if (!ACTIONS.includes(action) || !Number.isSafeInteger(version) || version < 0) return undefined;
  if (option !== undefined && (!Number.isSafeInteger(option) || option < 0 || option > 16)) return undefined;
  if (data.f !== undefined && (typeof data.f !== "string" || !PUSH_ID.test(data.f))) return undefined;
  if ((action === "forward" || action === "keep") && data.f === undefined) return undefined;
  return { push: data.p, action, version, ...(option === undefined ? {} : { option }), ...(data.f === undefined ? {} : { forward: data.f }) };
}

export type Counts = { texts: number; files: number };

export function countsText(counts: Counts): string {
  const parts = [counts.texts ? `文字 ${counts.texts} 段` : "", counts.files ? `附件 ${counts.files} 个` : ""].filter(Boolean);
  return parts.length ? parts.join("，") : "还没有内容";
}

/** People and groups a push reaches. */
export type Reach = { people: number; groups: number };

/** How a closed push ended, for an answered card: everyone answered before the deadline, or the deadline came. */
const endedText = (push: Pick<Push, "closeReason">) => push.closeReason === "complete" ? "推送已结束" : "已截止";

export function reachText(reach: Reach): string {
  return [reach.people || !reach.groups ? `${reach.people} 人` : "", reach.groups ? `${reach.groups} 个群` : ""].filter(Boolean).join("、");
}

/** A group's reply: who sent it and how much, `张三等 2 人，3 段文字`. */
export function groupReplyText(senders: readonly string[], counts: Counts): string {
  if (!counts.texts) return "还没有内容";
  return `${escapeInline(senders[0] ?? "")}${senders.length > 1 ? `等 ${senders.length} 人` : ""}，${counts.texts} 段文字`;
}

const REPLY_HINT = "**直接把回复发给我：文字、附件都行，可以分几条发。**";
const GROUP_REPLY_HINT = "**回复请 @机器人 直接发文字，谁发都算本群的回复，可以分几条发。群里只收文字，附件请单独发给推送人。**";
const FORWARD_HINT = "这件事该由别人处理的话，告诉我转给谁。";

// ---- the pusher's preview -------------------------------------------------------------------------------------------

export type PreviewView = {
  push: Push;
  /** Recipients in list order (people and groups). */
  people: readonly { name: string; member: string }[];
  /** Once confirmed: how the sends went. */
  sent?: { done: number; total: number; delivered: Reach; failed: Reach };
};

const PREVIEW_NAMES = 50, UNMATCHED_NAMES = 20;

function peopleText(people: PreviewView["people"], max = PREVIEW_NAMES): string {
  const shown = people.slice(0, max).map(person => `${escapeInline(person.name)}（尾号 ${phoneTail(person.member)}）`).join("、");
  return people.length > max ? `${shown} 等 ${people.length} 人` : `${shown}，共 ${people.length} 人`;
}

const groupsText = (groups: readonly { name: string }[]) => `群 ${groups.map(group => escapeInline(group.name)).join("、")}`;

/** The object lines: the people and groups for a list of them; what was asked for and the expanded list otherwise. */
function targetLines(push: Push, list: PreviewView["people"]): string[] {
  const { target } = push;
  const people = list.filter(each => memberGroup(each.member) === undefined), groups = list.filter(each => memberGroup(each.member) !== undefined);
  const reach = [...(people.length ? [peopleText(people)] : []), ...(groups.length ? [groupsText(groups)] : [])].join("；");
  if (target.of) return [`**对象**：推送编号 ${target.of} 中没有答复的${groups.length ? "" : "人"}：${reach}`];
  const left = target.unmatched?.length ? [`**没有对上、未包含**：${target.unmatched.slice(0, UNMATCHED_NAMES).map(escapeInline).join("、")}${target.unmatched.length > UNMATCHED_NAMES ? ` 等 ${target.unmatched.length} 人` : ""}`] : [];
  if (!target.departments.length && !target.everyone) return [`**对象**：${reach}`, ...left];
  const asked = [
    ...(target.everyone ? ["全员（同步范围内的所有人）"] : []),
    ...target.departments.map(department => `部门 ${escapeInline(department.path)}${department.children ? "（含下级）" : "（不含下级）"}`),
    ...(target.people.length ? [`个人 ${peopleText(target.people.map(person => ({ name: person.name, member: person.phone })), 20)}`] : []),
    ...(target.groups?.length ? [groupsText(target.groups)] : []),
  ];
  return [`**对象**：${asked.join("；")}`, `**名单**：${people.length ? peopleText(people) : "没有人"}（按点「确认推送」时的通讯录展开，不含你自己）`, ...left];
}

/** What happens on the way: when the pusher hears of the progress, and whether the card goes again to those who have not answered. */
function progressLine(push: Push, now: number): string[] {
  // Before the confirmation the moments are those of a push confirmed now.
  const from = push.confirmedAt ?? now, moments = checkpoints(from, push.confirmedAt === null && push.defaultDeadline ? from + (push.deadline - push.createdAt) : push.deadline).length;
  if (!moments) return [];
  const when = moments > 1 ? "时间过半和临近截止时" : "时间过半时";
  return [`**提醒**：${when}把进度发给你${push.remind ? "，并把卡片再发一次给还没有答复的人" : "；不自动提醒没有答复的人"}`];
}

export function previewCard(view: PreviewView, now = Date.now()): CardContent {
  const { push } = view;
  const deadline = `${shortTime(push.deadline, now)}${push.defaultDeadline ? "（未指定，默认发出后 3 天）" : ""}`;
  const cc = push.cc.length ? push.cc.map(person => `${escapeInline(person.name)}（尾号 ${phoneTail(person.phone)}）`).join("、") : "无抄送";
  const lines = [
    ...targetLines(push, view.people),
    `**抄送**：${cc}`,
    `**要求**：${escapeInline(requirementText(push))}`,
    `**截止**：${deadline}`,
    ...progressLine(push, now),
    "",
    "---",
    "",
    push.body,
    "",
    "---",
  ];
  const title = `${push.target.of ? "补推送预览" : "推送预览"}：${push.subject}`;
  switch (push.state) {
    case "preview":
      lines.push("核对无误后点「确认推送」才会发出；不推送请点「取消」。", "", `推送编号 ${push.id}`);
      return card(title, lines.join("\n"), { name: "待确认", color: COLOR.waiting },
        [button(push, push.previewVersion, 1, "确认推送", "confirm", 1), button(push, push.previewVersion, 2, "取消", "cancel", 2)], push.previewCard);
    case "cancelled":
      lines.push("已取消，没有发给任何人。", "", `推送编号 ${push.id}`);
      return card(title, lines.join("\n"), { name: "已取消", color: COLOR.closed }, [], push.previewCard, true);
    case "expired":
      lines.push("超过 24 小时没有确认，预览已失效，没有发给任何人。", "", `推送编号 ${push.id}`);
      return card(title, lines.join("\n"), { name: "已失效", color: COLOR.closed }, [], push.previewCard, true);
    default: {
      const sent = view.sent;
      const failed = sent ? sent.failed.people + sent.failed.groups : 0;
      const progress = sent === undefined ? "已确认，正在发送。"
        : sent.done < sent.total ? `已确认，正在发送：${sent.done}/${sent.total}${failed ? `，失败 ${failed}` : ""}。`
        : `已发出 ${reachText(sent.delivered)}${failed ? `，失败 ${reachText(sent.failed)}（可在控制台补推送）` : ""}。截止或全部答复后把汇总发给你${push.cc.length ? "和抄送人" : ""}。`;
      lines.push(progress, "", `推送编号 ${push.id}`);
      const closed = push.state === "closed";
      const status = !closed ? "已发出" : push.closeReason === "complete" ? "已全部答复" : "已截止";
      return card(title, lines.join("\n"), { name: status, color: closed ? COLOR.closed : COLOR.done }, [], push.previewCard, closed);
    }
  }
}

// ---- a recipient's card ---------------------------------------------------------------------------------------------

export type RecipientView = {
  push: Push;
  recipient: Recipient;
  /** What the reply holds. */
  reply: Counts;
  /** A group's card: who sent the reply's texts (names in order of their first text). */
  senders?: readonly string[];
  /** Who handed the push on to this recipient, and whom this recipient handed it on to (names). */
  forwardedBy?: string;
  forwardedTo?: readonly string[];
};

export function recipientCard(view: RecipientView, now = Date.now()): CardContent {
  const { push, recipient } = view;
  const group = memberGroup(recipient.member) !== undefined;
  const title = `推送：${push.subject}`;
  const head = [`**${escapeInline(push.pusherName)}** 于 ${shortTime(push.confirmedAt ?? push.createdAt, now)} 推送${group ? "到本群" : ""}`
    + (view.forwardedBy ? `，**${escapeInline(view.forwardedBy)}** 转给你` : "")
    + (push.target.of ? `（补推送：之前的推送还没有收到${group ? "本群" : "你"}的答复）` : ""), "", push.body, "", "---", "",
    `**要求**：${escapeInline(group && push.mode === "reply" ? "需要回复（群里只收文字）" : requirementText(push))}`, `**截止**：${shortTime(push.deadline, now)}`];
  const tail = ["", `推送编号 ${push.id}`];
  const make = (status: { name: string; color: string }, extra: string[], buttons: CardButton[], invalid = false) =>
    card(title, [...head, ...extra, ...tail].join("\n"), status, buttons, recipient.card, invalid);
  const v = recipient.version;
  const closed = push.state === "closed";
  if (group) return groupCard(view, make, now);
  const ended = endedText(push);
  const handed = view.forwardedTo?.length ? [`已转给 ${view.forwardedTo.map(escapeInline).join("、")}。`] : [];
  const nudge = (what: string) => push.reminded > 0 && !handed.length ? [`**提醒：这条推送还在等你${what}。**`] : [];
  // Handed on and not answered: the push is off this recipient's hands, the buttons stay.
  const waiting = (name: string) => handed.length ? { name: "已转派", color: COLOR.done } : { name, color: COLOR.waiting };

  if (push.mode === "ack") {
    if (recipient.ackedAt !== null) return make({ name: "已确认收到", color: closed ? COLOR.closed : COLOR.done }, [`已于 ${shortTime(recipient.ackedAt, now)} 确认收到。`, ...handed], [], closed);
    if (closed) return make({ name: handed.length ? "已转派" : "已截止", color: COLOR.closed }, [...handed, "已截止。"], [], true);
    return make(waiting("待确认"), [...nudge("确认"), ...handed, "请点「已收到」确认。", ...(handed.length ? [] : [FORWARD_HINT])], [button(push, v, 1, "已收到", "ack", 1)]);
  }

  if (push.mode === "options") {
    const chosen = recipient.choice === null ? undefined : push.options[recipient.choice];
    if (closed) {
      return chosen === undefined ? make({ name: handed.length ? "已转派" : "已截止", color: COLOR.closed }, [...handed, "已截止，没有选择。"], [], true)
        : make({ name: `已选择：${chosen}`, color: COLOR.closed }, [`已选择「${escapeInline(chosen)}」。`, ...handed], [], true);
    }
    const buttons = push.options.map((option, index) => button(push, v, index + 1, index === recipient.choice ? `✓ ${option}` : option, "choose",
      index === recipient.choice ? 1 : 2, { option: index }));
    return chosen === undefined
      ? make(waiting("待选择"), [...nudge("选择"), ...handed, "请点选一项；推送结束前可以改选。", ...(handed.length ? [] : [FORWARD_HINT])], buttons)
      : make({ name: `已选择：${chosen}`, color: COLOR.done }, [`已选择「${escapeInline(chosen)}」（${shortTime(recipient.choiceAt!, now)}）；推送结束前可以改选。`, ...handed], buttons);
  }

  // reply
  const replied = recipient.repliedAt !== null ? `已回复（${countsText(view.reply)}）· ${shortTime(recipient.repliedAt, now)}` : undefined;
  if (closed) {
    return replied === undefined ? make({ name: handed.length ? "已转派" : "未回复", color: COLOR.closed }, [...handed, "已截止，没有收到回复。"], [], true)
      : make({ name: "已回复", color: COLOR.closed }, [`${replied}。${ended}。`, ...handed], [], true);
  }
  if (replied) return make({ name: "已回复", color: COLOR.done }, [`${replied}。`, ...handed, "要补充、修改或者撤回，直接发消息告诉我。"], []);
  const acked = recipient.ackedAt === null ? [] : [`已于 ${shortTime(recipient.ackedAt, now)} 确认收到。`];
  const buttons = recipient.ackedAt === null ? [button(push, v, 1, "已收到", "ack", 2)] : [];
  return make(waiting(recipient.ackedAt === null ? "待回复" : "已确认，待回复"), [...nudge("回复"), ...acked, ...handed, "", REPLY_HINT, ...(handed.length ? [] : [FORWARD_HINT])], buttons);
}

type Make = (status: { name: string; color: string }, extra: string[], buttons: CardButton[], invalid?: boolean) => CardContent;

/**
 * A group's card: anyone answers for the group. 「已收到」 stays to count clicks (the clickers cannot be named); a reply
 * is texts @-mentioning the bot, from anyone, that the conversation recorded. Groups take no options (./service.ts).
 */
function groupCard(view: RecipientView, make: Make, now: number): CardContent {
  const { push, recipient } = view, v = recipient.version, closed = push.state === "closed", ended = endedText(push);
  const acked = recipient.ackedAt === null ? [] : [`已收到：首次 ${shortTime(recipient.ackedAt, now)}，共点击 ${recipient.clicks} 次。`];
  const ack = (style: 1 | 2) => button(push, v, 1, "已收到", "ack", style);
  const nudge = (what: string) => push.reminded > 0 ? [`**提醒：这条推送还在等本群${what}。**`] : [];
  if (push.mode !== "reply") {
    if (closed) return make({ name: recipient.ackedAt === null ? "已截止" : "已收到", color: COLOR.closed }, recipient.ackedAt === null ? ["已截止，没有人确认。"] : [...acked, `${ended}。`], [], true);
    return make({ name: recipient.ackedAt === null ? "待确认" : "已收到", color: recipient.ackedAt === null ? COLOR.waiting : COLOR.done },
      recipient.ackedAt === null ? [...nudge("确认"), "请点「已收到」确认，群里谁点都可以。"] : acked, [ack(recipient.ackedAt === null ? 1 : 2)]);
  }
  const replied = recipient.repliedAt !== null ? `已回复（${groupReplyText(view.senders ?? [], view.reply)}）· ${shortTime(recipient.repliedAt, now)}` : undefined;
  if (closed) {
    return replied === undefined ? make({ name: "未回复", color: COLOR.closed }, [...acked, "已截止，没有收到回复。"], [], true)
      : make({ name: "已回复", color: COLOR.closed }, [`${replied}。${ended}。`], [], true);
  }
  if (replied) return make({ name: "已回复", color: COLOR.done }, [...acked, `${replied}。`, "要补充就继续 @机器人 发；改或者撤回自己发的内容，@机器人 说一声。"], [ack(2)]);
  return make({ name: "待回复", color: COLOR.waiting }, [...nudge("回复"), ...acked, "", GROUP_REPLY_HINT], [ack(2)]);
}

// ---- handing a push on ----------------------------------------------------------------------------------------------

export type ForwardView = {
  push: Push;
  forward: Forward;
  /** The departments of the person it goes to (paths). */
  departments: readonly string[];
};

/** The card that asks the recipient before a push goes to someone else: nothing is sent to them until 「确认转派」. */
export function forwardCard(view: ForwardView, now = Date.now()): CardContent {
  const { push, forward } = view;
  const who = `**${escapeInline(forward.toName)}**（尾号 ${phoneTail(forward.to)}${view.departments.length ? `，${view.departments.map(escapeInline).join("；")}` : ""}）`;
  const title = `转派确认：${push.subject}`, tail = ["", `推送编号 ${push.id}`];
  const subject = `**${escapeInline(push.pusherName)}** 推送的「${escapeInline(push.subject)}」`;
  if (forward.state === "confirmed") {
    return card(title, [`已把${subject}转给 ${who}（${shortTime(forward.decidedAt ?? forward.createdAt, now)}）。`, ...tail].join("\n"), { name: "已转派", color: COLOR.done }, [], forward.card, true);
  }
  if (forward.state === "cancelled") {
    return card(title, [`${subject}没有转给 ${who}。`, ...tail].join("\n"), { name: "没有转派", color: COLOR.closed }, [], forward.card, true);
  }
  const lines = [`把${subject}转给 ${who}？`, "", "点「确认转派」后，这条推送的卡片会发给对方，推送人也会知道是你转的；发出后收不回来。", ...tail];
  return card(title, lines.join("\n"), { name: "待确认", color: COLOR.waiting },
    [button(push, forward.version, 1, "确认转派", "forward", 1, { forward: forward.id }), button(push, forward.version, 2, "取消", "keep", 2, { forward: forward.id })], forward.card);
}

// ---- the pusher's summary -------------------------------------------------------------------------------------------

export type SummaryView = {
  push: Push;
  /** The summary message's lines (the CCs get them as text). */
  lines: readonly string[];
  /** Recipients without an answer, failed cards included. */
  unanswered: Reach;
  /** The push 「提醒未回复」 prepared, unless it was cancelled or expired. */
  followUp?: Pick<Push, "id" | "state">;
};

export function summaryCard(view: SummaryView): CardContent {
  const { push, unanswered, followUp } = view;
  const lines = [...view.lines];
  let buttons: CardButton[] = [];
  if (followUp?.state === "preview") lines.push("", `已准备补推送（推送编号 ${followUp.id}），请在预览卡片上确认。`);
  else if (followUp) lines.push("", `已补推送给没有答复的人（推送编号 ${followUp.id}）。`);
  else if (unanswered.people + unanswered.groups > 0) {
    lines.push("", `点「提醒未回复」把这条推送再发给没有答复的 ${reachText(unanswered)}：先发预览给你，确认后才发出。`);
    buttons = [button(push, push.summaryVersion, 1, "提醒未回复", "remind", 1)];
  }
  return card(`推送汇总：${push.subject}`, lines.join("\n"), { name: "已汇总", color: COLOR.closed }, buttons, push.summaryCard);
}
