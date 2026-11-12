// Pushes: a pusher asks the model, the model calls push_prepare (./tools.ts), the pusher confirms on a preview card,
// cards go to the recipients, and their answers are collected here.
//
// Flow of one push:
// - prepare: the people are checked against the address book (in the sync scope, name and phone matching) and the
//   pusher's grants; the push is stored as `preview` and the preview card goes to the pusher's direct chat.
// - 「确认推送」 on the preview (only the pusher's click counts): `sending`; every recipient's card is sent (pending →
//   sending → sent | failed | uncertain; uncertain counts as sent and is never resent, failed is tried again twice).
//   Once no card is pending the push is `open`.
// - Clicks come back over the event stream with the card's ID; the first click gives the card's ID, after which the
//   service updates the card whenever the recipient's state changes.
// - Replies (mode `reply`) have no buttons. The recipient writes to the bot as always; the conversation's model sees the
//   live pushes in the tail of its requests (`pending`) and calls push_reply when the message answers one. `reply` then
//   records the member's message word for word (the request's text and the attachments it bound, or an earlier message
//   the model quotes from: the texts of recipients are kept a day for that, `directText` / `groupText`), adds to the reply,
//   replaces it or withdraws it. A request that ends without an answer is recorded as the reply when exactly one push
//   waits for one (`failed`): an outage of the model loses no reply.
// - Handing on (`forward`, the model's push_forward): a recipient names someone in the address book; a card asks the
//   recipient, and 「确认转派」 makes that person a recipient of the same push. Whoever handed a push on counts as answered.
//   A card that cannot be delivered to that person undoes it: the push is with the one who handed it on again.
// - Deadline, or everyone answered (for replies: and nobody added to one for `replyGraceMs`): `closed`. The deadline
//   counts by the time input is handled: a click or a reply after it ends the push first (the timer may not have run yet)
//   and counts for nothing. The summary (message and package) goes to the pusher and the CCs once the cards still being
//   sent have their result and the reply attachments are downloaded, or `settleWaitMs` after the end: a card still
//   without a result then stays uncertain, whatever comes back later, so the summary stays true. Then the held reply
//   attachments are released, each one still being downloaded once that ends (its file stays for the console's package).
// - Conversation notes go through an outbox in the state database into the members' conversations as passive entries,
//   so the model later knows what happened.
//
// Groups: the bot learns a group only when someone there @-mentions it (`groupText`, every group text the inbound
// router has); an admin names it with /登记群 (or the console does), and only registered groups take pushes. A group
// gets one card and one recipient row (`group:<ID>`), answered by anyone there: clicks cannot be traced to people, so
// 「已收到」 counts clicks, options are refused and a group's push is not handed on. A group's reply is the texts its
// members had recorded, each with its sender; a member replaces or withdraws only their own. Group members' conversations
// learn of a live push the next time they @-mention the bot.
//
// Lookup (directory_lookup): a pusher, or a recipient of a live push, finds people in the synced address book by part of
// the name, phone or department, with their full phones and departments.
//
// Files (push_prepare's attachments): the service copies them when the push is prepared (data/state/push-files/<push>),
// so what the pusher confirmed is what goes out. Each recipient gets them as file messages ahead of the card, in the same
// send: a card that went out means its files did; a file that fails is the card's failure, and the next try goes on with
// the file that failed. A reminder's card goes alone. The copies stay until the push is void, or `filesKeepMs` after its end.
//
// All state is in the state database (./store.ts); what runs in the background (sends, card updates, notes, the summary)
// picks up from there after a restart.
import { randomBytes } from "node:crypto";
import { copyFileSync, linkSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { chmod, copyFile, mkdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { formatSize } from "@earendil-works/pi-coding-agent";
import type { EntryDraft } from "@earendil-works/pi-durable";
import { canonicalCommand, isSlashCommandMessage } from "../agent/commands.ts";
import { SendNotConfirmed, transferFile } from "../agent/send-tools.ts";
import { DIRECT_SCOPE, groupScope, parseScopeKey, pushFile, scopeKey, userTmp, type Layout, type Scope } from "../core/layout.ts";
import { log } from "../core/log.ts";
import { NATIVE_FILE_MAX_BYTES } from "../core/transfer-limits.ts";
import { fileUpload, type Outbound, sendNotice, uploadedFile } from "../durable/outbound.ts";
import type { Attachment, MemberRecords, ReplyContext } from "../durable/records.ts";
import { sendChannel } from "../durable/send.ts";
import type { DepartmentTree } from "../integrations/open-platform/department-tree.ts";
import type { DirectoryIdentity } from "../integrations/open-platform/identity-directory.ts";
import { cardMessage, type CardContent, type SendOutcome, splitText, type Target, textMessage } from "../integrations/open-platform/messages.ts";
import type { StreamEvent } from "../integrations/open-platform/stream.ts";
import type { RelayConfig } from "../integrations/relay.ts";
import { PUSH_NOTE_KIND } from "./note.ts";
import { checkpoints, quietHours } from "./reminders.ts";
import { ROLE_LIMITS } from "./role-limits.ts";
import { CARD_MAX_CHARS, clickData, type ClickData, clickShape, countsText, type Counts, forwardCard, phoneTail, previewCard, type Reach, reachText, recipientCard,
  requirementText, shortTime, summaryCard } from "./cards.ts";
import { buildSummary, type HeldFile, replyItems, replyText, senders, type SummaryPackage, writeCheckSheet } from "./summary.ts";
import { type ChatGroup, type Forward, type Grants, groupMember, LIVE_STATES, memberGroup, type Person, type Push, type PushFile, type PushMode, type PushRole, type PushState, type PushStore,
  type PushTarget, type PushTotals, type Recipient, type RecipientCounts, type ReplyItem, type TargetDepartment, type TargetGroup } from "./store.ts";

export const PUSH_LIMITS = {
  defaultDeadlineMs: 3 * 24 * 3600_000,
  maxDeadlineMs: 30 * 24 * 3600_000,
  /** A given deadline is at least this far from the minute the push is prepared in (deadlines are whole minutes). */
  minDeadlineMs: 10 * 60_000,
  /** ...and still this far away when the pusher confirms: reading the preview takes a moment. */
  confirmDeadlineMs: 5 * 60_000,
  /** A preview not confirmed within this is void. */
  previewMs: 24 * 3600_000,
  /** A progress moment (./reminders.ts) this close to the deadline sends nothing: the summary follows. */
  remindLeadMs: 30 * 60_000,
  /**
   * A push asking for replies ends early once everyone answered and nobody added to a reply for this long: a reply may come
   * in several messages.
   */
  replyGraceMs: 10 * 60_000,
  /** A recipient's texts are kept this long, the newest `heardKeep` of each sender, for replies recorded from an earlier message. */
  heardMs: 24 * 3600_000,
  heardKeep: 20,
  /** Live pushes the tail of a model request lists. */
  pendingShown: 10,
  /** Card sends: attempts, and the waits before the second and third. */
  sendAttempts: 3,
  sendRetryMs: [60_000, 5 * 60_000] as readonly number[],
  summaryRetryMs: [60_000, 5 * 60_000, 30 * 60_000] as readonly number[],
  /** The summary waits this long after the end for cards still being sent and reply attachments still being received or downloaded. */
  settleWaitMs: 10 * 60_000,
  tickMs: 15_000,
  /** Cards sent at once (the message sender also limits the rate): a large push never queues ahead of other replies by more. */
  concurrency: 4,
  /** The preview card shows the sending progress at most this often (the end of sending always updates it). */
  progressMs: 5000,
  /** People named one by one, and everyone a push reaches once its departments and everyone are expanded. */
  people: 500,
  recipients: 5000,
  departments: 50,
  groups: 50,
  groupNameChars: 30,
  /** A known group's "last @-mentioned" time is written at most this often. */
  groupSeenMs: 10 * 60_000,
  cc: 10,
  /** People one directory_lookup answer lists, and the names one call asks for. */
  lookup: 50,
  lookupNames: 20,
  /** Files one push sends along (each at most the native file size), and the characters of a file's name. */
  files: 5,
  fileNameChars: 80,
  /** An uploaded file's ID is used for this long; then the file is uploaded again (the platform answers at once for bytes it has). */
  fileIdMs: 3600_000,
  /** The copies of a closed push's files stay this long (a follow-up push takes them); the directory is looked through this often. */
  filesKeepMs: 30 * 24 * 3600_000,
  filesSweepMs: 3600_000,
  /** What differs by recipient: titles here, each recipient's values under `recipients` (people only). */
  fields: 6,
  fieldChars: 12,
  valueChars: 100,
  subjectChars: 40,
  bodyChars: 3000,
  options: [2, 6] as readonly [number, number],
  optionChars: 10,
};
export type PushLimits = typeof PUSH_LIMITS;

/** What the push needs from the message service (src/durable/service.ts). */
export interface PushHost {
  records(scope: Scope, phone: string): Promise<Readonly<MemberRecords>>;
  /** The attachments a reply took from a request are the push's from now on (the same call again changes nothing). */
  holdAttachments(scope: Scope, phone: string, holder: string, ids: readonly string[]): Promise<number>;
  releaseAttachments(scope: Scope, phone: string, holder: string, ids: readonly string[]): Promise<number>;
  note(scope: Scope, phone: string, requestId: string, entry: EntryDraft): Promise<void>;
}

export interface PushDirectory {
  lookup(imUserId: string): DirectoryIdentity | undefined;
  byPhone(phone: string): DirectoryIdentity | undefined;
  /** The synced department tree (department-tree.ts): department targets, everyone, department grants, lookups. */
  readonly departments: Pick<DepartmentTree, "updatedAt" | "get" | "all" | "find" | "within" | "members" | "everyone" | "departmentsOf">;
}

export interface PushOptions {
  store: PushStore;
  directory: PushDirectory;
  outbound: Outbound;
  layout: Pick<Layout, "tmp" | "pushFiles">;
  relay: RelayConfig | null;
  signal: AbortSignal;
  limits?: Partial<PushLimits>;
  now?: () => number;
  /** Failures that do not fail the calling operation. Must not throw. */
  onReport?: (error: unknown) => void;
}

/** What push_prepare passes on (./tools.ts). */
export type PrepareInput = {
  /** `values`: what the push's `fields` say for this person, in their order. */
  recipients?: readonly { name: string; phone: string; values?: readonly string[] }[];
  /** By name or path; `children: false` leaves the sub-departments out. */
  departments?: readonly { name: string; children?: boolean }[];
  everyone?: boolean;
  /** Registered groups by name. */
  groups?: readonly { name: string }[];
  subject: string;
  body: string;
  mode: PushMode;
  options?: readonly string[];
  deadline?: string;
  cc?: readonly { name: string; phone: string }[];
  /** False: the card does not go again to those who have not answered. */
  remind?: boolean;
  /** Files to send along: local files the tool resolved (./tools.ts), with their sizes. */
  attachments?: readonly { path: string; size: number }[];
  /** Titles of what differs by recipient; then the push goes to people only, each with `values`. */
  fields?: readonly string[];
};

/** What directory_lookup passes on (./tools.ts): at least one of names, phone and department; together they narrow down. */
export type LookupInput = {
  /** Parts of names: each is looked up on its own. */
  names?: readonly string[];
  phone?: string;
  /** By name or path; `children: false` leaves the sub-departments out. */
  department?: string;
  children?: boolean;
};

/** Who speaks in a conversation (a direct chat, or a group), and the message of the request at hand. */
export type Speaker = { scope: Scope; phone: string; message: { msgUid: string; text: string; receivedAt: number } };

/**
 * What push_reply passes on (./tools.ts). `add` and `replace` record the request's message, or with `quote` the
 * speaker's latest earlier message that contains it; `withdraw` drops what was recorded.
 */
export type ReplyInput = { push: string; action: "add" | "replace" | "withdraw"; quote?: string };

/** What push_forward passes on (./tools.ts): the push and the person it should go to. */
export type ForwardInput = { push: string; to: { name: string; phone: string } };

/** Someone named for a push who is not in the address book as named: for the preview card (`who`) and for the model (`why`). */
type Unmatched = { who: string; why: string };

/** A refusal the model passes on to the member. */
export class PushRefused extends Error { override name = "PushRefused"; }
/** The settings name people outside the synced address book; `phones` (at most 10) go back as a list, for the console to mask. */
export class PushSettingsRefused extends Error {
  override name = "PushSettingsRefused";
  constructor(message: string, readonly phones: readonly string[]) { super(message); }
}

/** The console's list filter: pushes waiting for 确认推送, out, closed, or never sent. */
export const PUSH_GROUPS = { preview: ["preview"], live: ["sending", "open"], closed: ["closed"], void: ["cancelled", "expired"] } as const satisfies
  Record<string, readonly PushState[]>;
export type PushGroup = keyof typeof PUSH_GROUPS;

/** Recipient rows; `groups` of them are groups. */
export type PushCounts = Omit<RecipientCounts, "unsettled" | "repliedAt">;
/** Where the console's list goes on: the last push of the page before (the list is newest first, then by ID). */
export type PushCursor = Pick<Push, "createdAt" | "id">;
export type PushListItem = Pick<Push, "id" | "subject" | "mode" | "state" | "pusher" | "pusherName" | "createdAt" | "confirmedAt" | "deadline" | "closedAt"
  | "closeReason" | "summaryState" | "followUp"> & { of: string | null; counts: PushCounts };
export type PushRecipientDetail = Pick<Recipient, "member" | "name" | "values" | "sendState" | "sendError" | "sentAt" | "ackedAt" | "clicks" | "choiceAt" | "repliedAt"> & {
  choice: string | null;
  /** Answered, or handed the push on. */
  answered: boolean;
  /** The reply: its text (at most 2000 characters here), attachments and, for a group, who sent it. */
  reply: { text: string; files: { name: string; size: number | null; kind: ReplyItem["kind"] }[]; senders: string[] } | null;
  /** Who handed the push on to this recipient, and whom this recipient handed it on to (names). */
  forwardedBy: string | null;
  forwardedTo: string[];
};
export type PushDetail = { push: PushListItem & Pick<Push, "body" | "options" | "defaultDeadline" | "target" | "cc" | "files" | "fields" | "summaryError" | "summaryAt" | "remind" | "reminded" | "checkpoints">;
  recipients: PushRecipientDetail[] };

/** A group as the console lists it: who registered it by name (null: the console did, or nobody yet). */
export type PushGroupRow = ChatGroup & { registeredByName: string | null };

/** What the local control interface offers the console (src/server/http-app.ts `/_admin/push/*`). */
export type PushAdmin = Pick<PushService, "settings" | "saveSettings" | "list" | "detail" | "remind" | "setCc" | "remove" | "package" | "groups" | "saveGroup">;

export const holderOf = (pushId: string) => `push:${pushId}`;
/** A name as names are compared: no white space, lower case. */
const compactName = (text: string) => text.replace(/\s+/g, "").toLowerCase();
const sameName = (a: string, b: string) => compactName(a) === compactName(b);
const chars = (text: string) => [...text].length;
const truncate = (text: string, max: number) => chars(text) > max ? [...text].slice(0, max).join("") + "…" : text;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
/** Text to go between 「 and 」 in a note: its own corner brackets become the double ones, so it cannot end the quotation. */
const quoted = (text: string) => text.replaceAll("「", "『").replaceAll("」", "』");
/** A note's part on the push's files; `to`: they went to this recipient as file messages. */
const filesNote = (push: Pick<Push, "files">, to?: string) => !push.files.length ? ""
  : `；附件：${push.files.map(each => quoted(each.name)).join("、")}${to ? `（已作为文件单独发给${to}）` : ""}`;
/** A note's part on what a push says for one recipient alone: `；<label>：指标 120；完成率 85%`. */
const valuesNote = (push: Pick<Push, "fields">, values: readonly string[], label: string) => !push.fields.length || !values.length ? ""
  : `；${label}：${push.fields.map((field, index) => `${quoted(field)} ${quoted(values[index] ?? "")}`).join("；")}`;
const NO_DEPARTMENT_GRANT = "你没有按部门推送的权限，请联系管理员在控制台授权";
const NO_GROUP_GRANT = "你没有推送到群的权限，请联系管理员在控制台授权";
const PREVIEW_GONE = "这张预览已经作废，什么都没有发出：确认了后面准备的推送，之前没确认的预览就一起清掉了。还要发的话请再提一次。";
/** How a group gets registered (the bot's refusals and the console say so). */
export const GROUP_STEPS = "登记方法：把机器人拉进群，推送管理员在群里发送“@机器人 /登记群 群名”；有人 @ 过机器人的群，也可以在控制台推送页的群名单里补群名";
const GROUP_ID = /^[0-9]{1,64}$/;
/** The console's packages, each in its own directory directly under data/tmp (`package`). */
const PACKAGE_DIR = "push-console-";

/** Who a push reaches: a person (by phone) or a group (`group:<ID>`), with the name and where the card goes; `values`: the person's own under the push's fields. */
type Reached = { member: string; name: string; receiveId: string; values?: string[] };
const personReached = (person: DirectoryIdentity): Reached => ({ member: person.phone, name: person.name, receiveId: person.imUserId });
const groupReached = (group: TargetGroup): Reached => ({ member: groupMember(group.id), name: group.name, receiveId: group.id });
const reachOf = (rows: readonly { member: string }[]): Reach => {
  const groups = rows.filter(row => memberGroup(row.member) !== undefined).length;
  return { people: rows.length - groups, groups };
};

/** `2026-11-07 18:00`, `2026-11-07T18:00`, or a date alone (the end of that day), in the service's time zone. */
export function parseDeadline(text: string): number | undefined {
  const match = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*$/.exec(text);
  if (!match) return undefined;
  const [y, m, d, hh, mm] = [match[1], match[2], match[3], match[4], match[5]].map(part => part === undefined ? undefined : Number(part));
  const at = hh === undefined ? new Date(y!, m! - 1, d!, 23, 59) : new Date(y!, m! - 1, d!, hh, mm!);
  // A date that rolled over (02-30) is not what was meant.
  if (at.getFullYear() !== y || at.getMonth() !== m! - 1 || at.getDate() !== d || (hh !== undefined && (at.getHours() !== hh || at.getMinutes() !== mm))) return undefined;
  return at.getTime();
}

/** The role list a settings save carries (the console, through the local control interface). */
export function parseRoles(value: unknown): Omit<PushRole, "updatedAt">[] {
  if (!Array.isArray(value) || value.length > ROLE_LIMITS.people) throw new Error(`名单必须是不超过 ${ROLE_LIMITS.people} 项的数组`);
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const item = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
    const at = `第 ${index + 1} 项`;
    if (!item || typeof item.phone !== "string" || !/^[A-Za-z0-9_+\-]{1,32}$/.test(item.phone)) throw new Error(`${at}的手机号无效`);
    if (seen.has(item.phone)) throw new Error(`${at}的手机号重复`);
    seen.add(item.phone);
    if (typeof item.admin !== "boolean" || typeof item.pusher !== "boolean") throw new Error(`${at}缺少管理员或推送人标记`);
    const limit = item.dailyLimit ?? null;
    if (limit !== null && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > ROLE_LIMITS.dailyLimit)) {
      throw new Error(`${at}的频次上限必须是 1 到 ${ROLE_LIMITS.dailyLimit} 的整数`);
    }
    return { phone: item.phone, admin: item.admin, pusher: item.pusher, grants: parseGrants(item.grants, at), dailyLimit: limit };
  });
}

function parseGrants(value: unknown, at: string): Grants {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${at}的授权无效`);
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !["department", "all", "group"].includes(key))) throw new Error(`${at}的授权含未知项`);
  const grants: Grants = {};
  if (raw.all === true) grants.all = true; else if (raw.all !== undefined && raw.all !== false) throw new Error(`${at}的全员授权无效`);
  if (raw.group === true) grants.group = true; else if (raw.group !== undefined && raw.group !== false) throw new Error(`${at}的群授权无效`);
  const department = raw.department as Record<string, unknown> | undefined | null;
  if (department !== undefined && department !== null) {
    if (department.any === true && Object.keys(department).length === 1) grants.department = { any: true };
    else if (Array.isArray(department.departments) && Object.keys(department).length === 1 && department.departments.length >= 1
      && department.departments.length <= ROLE_LIMITS.departments
      && department.departments.every(id => typeof id === "string" && /^[0-9A-Za-z_-]{1,64}$/.test(id))) grants.department = { departments: [...new Set(department.departments as string[])] };
    else throw new Error(`${at}的部门授权无效`);
  }
  return grants;
}

type Click = { event: StreamEvent; data: ClickData; userId: string; card: string };

export class PushService {
  readonly #store: PushStore;
  readonly #directory: PushDirectory;
  readonly #outbound: Outbound;
  readonly #limits: PushLimits;
  readonly #now: () => number;
  readonly #signal: AbortSignal;
  readonly #work = new Set<Promise<unknown>>();
  readonly #refreshing = new Map<string, { again: boolean }>();
  readonly #clicks = new Set<string>();
  readonly #progressAt = new Map<string, number>();
  /** When each group's "last @-mentioned" time was last written. */
  readonly #seenAt = new Map<string, number>();
  /** `<push>|<group>|<phone>`: the member's group conversation has the push's note queued (a restart queues it again; the write is deduplicated). */
  readonly #groupNoted = new Set<string>();
  /** `<push>/<index>`: the platform's ID of an uploaded push file (the upload under way, or done), and when it began. */
  readonly #fileIds = new Map<string, { id: Promise<string>; at: number }>();
  /** Pushes whose files are being copied: their directories have no record yet. */
  readonly #preparing = new Set<string>();
  #filesSweptAt: number | undefined;
  #host?: PushHost;
  #timer?: ReturnType<typeof setInterval>;
  #pumping = false;
  #pumpAgain = false;
  #ticking = false;
  #closing = false;

  constructor(private readonly options: PushOptions) {
    this.#store = options.store;
    this.#directory = options.directory;
    this.#outbound = options.outbound;
    this.#limits = { ...PUSH_LIMITS, ...options.limits };
    this.#now = options.now ?? Date.now;
    this.#signal = options.signal;
  }

  /** The message service, once it exists (it is built with this service's tools). */
  bind(host: PushHost): void { this.#host = host; }

  /** Startup: sends an ended process left `sending` are uncertain; then the background work resumes. */
  start(): void {
    const settled = this.#store.settleInterruptedSends();
    if (settled) log.warn(`推送：${settled} 张卡片在上次服务中断时正在发送，结果未知，按已发出处理`);
    this.#dropSuperseded();
    this.#sweepPackages();
    this.#track(this.#holdReplies());
    this.#timer = setInterval(() => this.tick(), this.#limits.tickMs);
    this.#timer.unref?.();
    this.tick();
  }

  async close(): Promise<void> {
    this.#closing = true;
    clearInterval(this.#timer);
    await this.idle();
  }

  /** Resolves once no work is left: the sends, updates and summaries running now and any they start. */
  async idle(): Promise<void> {
    while (this.#work.size) await Promise.allSettled([...this.#work]);
  }

  /** Packages an ended process left: the tmp cleanup looks only under the members' directories. Listed before any new one can exist. */
  #sweepPackages(): void {
    const tmp = this.options.layout.tmp;
    let names: string[] = [];
    try { names = readdirSync(tmp); } catch { return; }
    const left = names.filter(name => name.startsWith(PACKAGE_DIR)).map(name => rm(join(tmp, name), { recursive: true, force: true }));
    if (left.length) this.#track(Promise.all(left));
  }

  /**
   * The copies of push files nobody sends any more go, every `filesSweepMs`: of pushes that are void or deleted, and of
   * those closed for `filesKeepMs`. Uploaded file IDs past their time go with them.
   */
  #sweepFiles(): void {
    const now = this.#now(), root = this.options.layout.pushFiles;
    if (this.#filesSweptAt !== undefined && now - this.#filesSweptAt < this.#limits.filesSweepMs) return;
    this.#filesSweptAt = now;
    for (const [key, upload] of this.#fileIds) if (now - upload.at >= this.#limits.fileIdMs) this.#fileIds.delete(key);
    let names: string[] = [];
    try { names = readdirSync(root); } catch { return; }
    const gone = names.filter(name => {
      if (this.#preparing.has(name)) return false;
      const push = this.#store.push(name);
      return !push || !push.files.length || push.state === "cancelled" || push.state === "expired"
        || (push.state === "closed" && now - (push.closedAt ?? 0) >= this.#limits.filesKeepMs);
    });
    if (!gone.length) return;
    log.info(`推送：清理 ${gone.length} 条推送的附件副本`);
    this.#track(Promise.all(gone.map(name => rm(join(root, name), { recursive: true, force: true }))).catch(error => this.#report(error)));
  }

  // ---- permissions ----------------------------------------------------------------------------------------------------

  isPusher(phone: string): boolean {
    return this.#store.role(phone)?.pusher === true;
  }

  isAdmin(phone: string): boolean {
    return this.#store.role(phone)?.admin === true;
  }

  /** The settings page: every role, with the person's current name (null: not in the synced address book), and the synced departments for grants. */
  settings(): { roles: (PushRole & { name: string | null })[]; departments: { id: string; path: string }[] } {
    return { roles: this.#store.roles().map(role => ({ ...role, name: this.#directory.byPhone(role.phone)?.name ?? null })),
      departments: this.#directory.departments.all().map(({ id, path }) => ({ id, path })) };
  }

  /** Replace the role list; everyone on it must be in the synced address book. */
  saveSettings(value: unknown): void {
    const roles = parseRoles(value);
    const unknown = roles.filter(role => (role.admin || role.pusher) && !this.#directory.byPhone(role.phone));
    if (unknown.length) throw new PushSettingsRefused(`${unknown.length} 个手机号不在同步的通讯录里`, unknown.map(role => role.phone).slice(0, 10));
    this.#store.replaceRoles(roles, this.#now());
    log.info(`推送设置已保存：推送人 ${roles.filter(role => role.pusher).length} 人，管理员 ${roles.filter(role => role.admin).length} 人`);
  }

  // ---- groups ---------------------------------------------------------------------------------------------------------

  /** The console's group list: registered and disabled groups, and groups seen but not named yet. */
  groups(): { groups: PushGroupRow[]; steps: string } {
    return { groups: this.#store.groups().map(group => ({ ...group, registeredByName: group.registeredBy ? this.#directory.byPhone(group.registeredBy)?.name ?? null : null })),
      steps: GROUP_STEPS };
  }

  /** Name (register), rename, disable or enable a group the bot has seen (the console); no `name` keeps the current one. */
  saveGroup(id: string, change: { name?: string; state: "registered" | "disabled" }): ChatGroup {
    const group = this.#store.group(id);
    if (!group) throw new PushRefused("机器人没有这个群的记录：要先有人在群里 @ 过机器人");
    const named = change.name === undefined ? group.name : this.#groupName(id, change.name);
    if (change.state === "registered" && named === null) throw new PushRefused("登记群要写群名");
    return this.#saveGroup(group, named, change.state, null);
  }

  #saveGroup(group: ChatGroup, name: string | null, state: "registered" | "disabled", by: string | null): ChatGroup {
    const registered = state === "registered" && group.state !== "registered";
    const change = { name, state, registeredAt: registered ? this.#now() : group.registeredAt, registeredBy: registered ? by : group.registeredBy };
    this.#store.saveGroup(group.id, change);
    log.info(`群 ${group.id} ${state === "disabled" ? "已停用" : registered ? "已登记" : "已改名"}`);
    return { ...group, ...change };
  }

  /** A group name: one line of 1 to 30 characters, used by no other group. */
  #groupName(id: string, raw: string): string {
    const name = oneLine(raw);
    if (!name) throw new PushRefused("群名不能为空");
    if (chars(name) > this.#limits.groupNameChars) throw new PushRefused(`群名不能超过 ${this.#limits.groupNameChars} 个字`);
    const other = this.#store.groups().find(group => group.id !== id && group.name !== null && sameName(group.name, name));
    if (other) throw new PushRefused(`群名「${name}」已经用于另一个群${other.state === "disabled" ? "（已停用）" : ""}，请换一个`);
    return name;
  }

  /** A text in a group (any member's, before anything else): the group is known; its time moves on now and then. */
  #groupSeen(groupId: string): void {
    const now = this.#now(), last = this.#seenAt.get(groupId);
    if (last !== undefined && now - last < this.#limits.groupSeenMs) return;
    if (this.#seenAt.size >= 10_000) this.#seenAt.clear();
    this.#seenAt.set(groupId, now);
    this.#store.groupSeen(groupId, now, this.#limits.groupSeenMs);
  }

  /** `/登记群 <名称>` in a group: admins only. */
  #registerCommand(groupId: string, identity: DirectoryIdentity, reply: ReplyContext, text: string): void {
    if (!this.isAdmin(identity.phone)) { this.#notice(reply, "只有推送管理员可以登记群；管理员名单在控制台的推送设置里。"); return; }
    const raw = text.trim().slice(text.trim().split(/\s+/, 1)[0]!.length);
    if (!oneLine(raw)) { this.#notice(reply, "请在指令后写上群名，例如：@机器人 /登记群 销售一部"); return; }
    try {
      // Seen a moment ago, unless the write was skipped as too recent; the row is there either way.
      const group = this.#store.group(groupId) ?? (this.#store.groupSeen(groupId, this.#now(), 0), this.#store.group(groupId)!);
      const saved = this.#saveGroup(group, this.#groupName(groupId, raw), "registered", identity.phone);
      this.#notice(reply, `已登记为 ${saved.name}。有群推送权限的推送人现在可以按这个群名推送到本群。`);
    } catch (error) {
      if (!(error instanceof PushRefused)) throw error;
      this.#notice(reply, error.message);
    }
  }

  // ---- prepare (push_prepare) -----------------------------------------------------------------------------------------

  /** Check the request, store the push as a preview and send the preview card to the pusher; the model's answer. */
  async prepare(caller: { phone: string; reply: ReplyContext }, input: PrepareInput): Promise<string> {
    const role = this.#store.role(caller.phone);
    if (!role?.pusher) throw new PushRefused("你没有推送权限，请联系管理员在控制台设置。");
    const now = this.#now(), limits = this.#limits;
    const subject = oneLine(input.subject ?? ""), body = (input.body ?? "").trim();
    const problems: string[] = [];
    if (!subject || chars(subject) > limits.subjectChars) problems.push(`主题必须是 1 到 ${limits.subjectChars} 个字`);
    if (!body || chars(body) > limits.bodyChars) problems.push(`正文必须是 1 到 ${limits.bodyChars} 个字；更长的内容请改为附件`);
    if (!["ack", "options", "reply"].includes(input.mode)) problems.push("要求必须是 ack（确认收到）、options（选项）或 reply（需要回复）");
    const options = input.mode === "options" ? (input.options ?? []).map(oneLine) : [];
    if (input.mode === "options") {
      const [min, max] = limits.options;
      if (options.length < min || options.length > max) problems.push(`选项必须有 ${min} 到 ${max} 个`);
      if (options.some(option => !option || chars(option) > limits.optionChars)) problems.push(`每个选项必须是 1 到 ${limits.optionChars} 个字`);
      if (new Set(options).size !== options.length) problems.push("选项不能重复");
    }
    let deadline = now + limits.defaultDeadlineMs, defaultDeadline = true;
    if (input.deadline !== undefined && input.deadline.trim()) {
      const parsed = parseDeadline(input.deadline);
      if (parsed === undefined) problems.push(`截止时间「${input.deadline}」无法识别，请写成 2026-11-07 18:00 这样的格式`);
      else if (parsed < now - now % 60_000 + limits.minDeadlineMs) problems.push("截止时间至少要在 10 分钟之后");
      else if (parsed > now + limits.maxDeadlineMs) problems.push("截止时间不能超过 30 天之后");
      else { deadline = parsed; defaultDeadline = false; }
    }
    const fields = (input.fields ?? []).map(field => oneLine(String(field ?? "")));
    if (fields.length) {
      if (fields.length > limits.fields) problems.push(`每人不同的内容最多 ${limits.fields} 栏`);
      if (fields.some(field => !field || chars(field) > limits.fieldChars)) problems.push(`每个栏目名必须是 1 到 ${limits.fieldChars} 个字`);
      if (new Set(fields).size !== fields.length) problems.push("栏目名不能重复");
      if (input.departments?.length || input.everyone || input.groups?.length) problems.push("每人不同的内容只能按人推送，不能和部门、全员、群一起用");
    }
    const before = problems.length;
    // People who do not match are left out and named, as long as someone is left to push to.
    const unmatched: Unmatched[] = [];
    const target = this.#checkTarget(role, input, fields, problems, unmatched);
    const people = problems.length > before ? [] : this.#expand(target, caller.phone);
    if (problems.length === before && !people.length && !unmatched.length) {
      problems.push(target.departments.length || target.everyone ? "按部门或全员展开后没有可以接收的人（不含你自己）" : "至少要有一个推送对象");
    }
    if (people.length > limits.recipients) {
      problems.push(`一次最多推送 ${limits.recipients} 人，现在是 ${reachText(reachOf(people))}${reachOf(people).groups ? "（一个群算一人）" : ""}`);
    }
    // The pusher gets the summary anyway.
    const cc = this.#checkPeople(input.cc ?? [], "抄送人", problems).filter(person => person.phone !== caller.phone);
    if (cc.length > limits.cc) problems.push(`抄送人最多 ${limits.cc} 个`);
    const attachments = input.attachments ?? [];
    if (attachments.length > limits.files) problems.push(`附件最多 ${limits.files} 个，现在是 ${attachments.length} 个`);
    for (const file of attachments) {
      if (!(file.size > 0)) problems.push(`附件「${basename(file.path)}」是空文件`);
      else if (file.size > NATIVE_FILE_MAX_BYTES) problems.push(`附件「${basename(file.path)}」（${formatSize(file.size)}）超过单个附件的上限 ${formatSize(NATIVE_FILE_MAX_BYTES)}`);
    }
    // Refused for another reason, or nobody is left: the people who do not match are named with the rest.
    if (problems.length || !people.length) throw new PushRefused(`推送未准备：\n- ${[...problems, ...unmatched.map(each => each.why)].join("\n- ")}`);
    this.#checkLimit(role, now);
    const pusher = this.#directory.byPhone(caller.phone);
    const push = this.#newPush({ pusher: caller.phone, pusherName: pusher?.name ?? caller.reply.name ?? caller.phone, pusherIm: pusher?.imUserId ?? caller.reply.receiveId,
      subject, body, mode: input.mode, options, deadline, defaultDeadline, target, cc: cc.map(({ phone, name }) => ({ phone, name })), remind: input.remind !== false, files: [], fields });
    const earlier = this.#store.pushesOf(caller.phone, 50).filter(each => each.state === "preview" && !each.target.of).length;
    let outcome;
    try {
      if (attachments.length) push.files = await this.#takeFiles(push.id, await this.#named(caller.phone, attachments));
      outcome = await this.#createPreview(push, people);
    } catch (error) {
      if (attachments.length) await rm(join(this.options.layout.pushFiles, push.id), { recursive: true, force: true }).catch(() => {});
      throw error;
    } finally { this.#preparing.delete(push.id); }
    const sheet = push.fields.length ? await this.#sendCheckSheet(push) : true;
    log.info(`推送 ${push.id} 已准备：${reachText(reachOf(people))}${push.files.length ? `，附件 ${push.files.length} 个` : ""}，等待推送人确认`);
    return `已把推送预览卡片发给你（推送编号 ${push.id}，${reachText(reachOf(people))}${cc.length ? `，抄送 ${cc.length} 人` : ""}${push.files.length ? `，附件 ${push.files.length} 个` : ""}，`
      + `截止 ${defaultDeadline ? "确认发出后 3 天（未指定截止时间）" : shortTime(deadline, now)}）。`
      + (!fields.length ? "" : sheet ? `每人不同的内容（${fields.join("、")}）列在随预览发去的核对表里：提醒成员确认前逐人核对，发出后改不了。`
        : `每人不同的内容（${fields.join("、")}）的核对表没有发出：把每个人的内容列给成员核对，再请成员确认。`)
      + (unmatched.length ? `名单里有 ${unmatched.length} 人没有对上，没有放进这次推送：\n- ${unmatched.map(each => each.why).join("\n- ")}\n把这几个人告诉成员：先发给其余的人就在卡片上确认；要补上他们，核对后带着完整名单重新准备。\n` : "")
      + "请在卡片上核对，点「确认推送」才会发出；点之前不会发给任何人。"
      + (target.departments.length || target.everyone ? "部门和全员的名单在点「确认推送」时按当时的通讯录重新展开。" : "")
      + (earlier ? `之前准备、还没有确认的 ${earlier} 条预览在确认这一条后清理，旧卡片不再有效。` : "")
      + (outcome === "uncertain" ? "（预览卡片的发送结果不确定，如果没有收到，请重新提出。）" : "");
  }

  /** A push in `preview`, with nothing confirmed, sent or summarised yet. */
  #newPush(fields: Pick<Push, "pusher" | "pusherName" | "pusherIm" | "subject" | "body" | "mode" | "options" | "deadline" | "defaultDeadline" | "target" | "cc" | "remind" | "files" | "fields">): Push {
    return { id: this.#newId(), ...fields, state: "preview", createdAt: this.#now(), confirmedAt: null, closedAt: null, closeReason: null, previewCard: null,
      previewVersion: 0, summaryState: null, summaryAttempts: 0, summaryAt: null, summaryError: null, summaryDone: [], summaryText: null, summaryCard: null,
      summaryVersion: 0, followUp: null, checkpoints: [], reminded: 0, released: false };
  }

  #recipientRow(pushId: string, reached: Reached): Recipient {
    return { pushId, ...reached, values: reached.values ?? [], sendState: "pending", sendAttempts: 0, sendError: null, sentAt: null, retryAt: null, filesSent: 0, card: null, version: 0, ackedAt: null,
      clicks: 0, choice: null, choiceAt: null, repliedAt: null };
  }

  /**
   * The names the files go out under: a file the pusher sent to the bot keeps the name it came with (its stored name
   * starts with the attachment's ID), any other its own. One line, at most `fileNameChars` characters, the extension kept.
   */
  async #named(phone: string, files: readonly { path: string; size: number }[]): Promise<{ path: string; name: string }[]> {
    const received = new Map<string, string>();
    for (const attachment of Object.values((await this.#host?.records(DIRECT_SCOPE, phone))?.attachments ?? {})) {
      if (attachment.path) received.set(basename(attachment.path), attachment.name);
    }
    const max = this.#limits.fileNameChars;
    return files.map(file => {
      const name = oneLine((received.get(basename(file.path)) ?? basename(file.path)).replace(/[\x00-\x1f\x7f\\/]+/g, " ")) || "附件";
      const extension = /\.[A-Za-z0-9]{1,10}$/.exec(name)?.[0] ?? "";
      return { path: file.path, name: chars(name) > max ? [...name.slice(0, name.length - extension.length)].slice(0, max - extension.length).join("") + extension : name };
    });
  }

  /** Copy the files into the push's own directory, in order; what was copied is what goes out. */
  async #takeFiles(pushId: string, files: readonly { path: string; name: string }[]): Promise<PushFile[]> {
    this.#preparing.add(pushId);
    const taken: PushFile[] = [];
    try {
      await mkdir(join(this.options.layout.pushFiles, pushId), { recursive: true, mode: 0o700 });
      for (const [index, file] of files.entries()) {
        const copy = pushFile(this.options.layout, pushId, index);
        await copyFile(file.path, copy);
        await chmod(copy, 0o600);
        const { size } = await stat(copy);
        if (!size || size > NATIVE_FILE_MAX_BYTES) throw new PushRefused(`附件「${file.name}」在准备推送时被改动了，推送未准备，请重新提出。`);
        taken.push({ name: file.name, size });
      }
    } catch (error) {
      throw error instanceof PushRefused ? error : new PushRefused(`推送未准备：附件没有读到（${error instanceof Error ? error.message : String(error)}）。`);
    }
    return taken;
  }

  /**
   * A follow-up push takes the files of the push it reminds: links to the same bytes (copies where the file system has
   * no links). Empty when they are gone (the push ended `filesKeepMs` ago). Synchronous, as its caller has to be.
   */
  #linkFiles(from: Push, pushId: string): PushFile[] {
    if (!from.files.length) return [];
    const dir = join(this.options.layout.pushFiles, pushId);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const index of from.files.keys()) {
        const source = pushFile(this.options.layout, from.id, index), copy = pushFile(this.options.layout, pushId, index);
        try { linkSync(source, copy); } catch { copyFileSync(source, copy); }
      }
      return from.files;
    } catch {
      rmSync(dir, { recursive: true, force: true });
      return [];
    }
  }

  /**
   * Store the push with its list (`also`: in the same transaction) and send the preview card to the pusher; a preview
   * that could not be sent is cancelled. Synchronous up to the send.
   */
  async #createPreview(push: Push, people: readonly Reached[], also?: () => void): Promise<"sent" | "uncertain"> {
    const recipients = people.map(person => this.#recipientRow(push.id, person));
    // The card must fit (measured ~5000 characters): the one with the longest values of its own.
    const size = (recipient: Recipient) => recipient.values.reduce((sum, value) => sum + value.length, 0);
    const longest = recipients.reduce((most, each) => size(each) > size(most) ? each : most, recipients[0]!);
    const sample = recipientCard({ push, recipient: longest, reply: { texts: 0, files: 0 } }, this.#now());
    if (chars(sample.content) > CARD_MAX_CHARS) throw new PushRefused("正文太长，卡片放不下，请精简或改为附件");
    // The preview lists fewer names when it is long (./cards.ts); beside a long body, file names and CCs it may still not fit.
    const preview = previewCard({ push, people: recipients.map(recipient => ({ name: recipient.name, member: recipient.member, values: recipient.values })) }, this.#now());
    if (chars(preview.content) > CARD_MAX_CHARS) throw new PushRefused("正文加上附件名、抄送和名单太长，预览卡片放不下，请精简正文或附件名，或把长内容改为附件");
    this.#store.transaction(() => { this.#store.create(push, recipients); also?.(); });
    const outcome = await this.#outbound.send(this.#pusherTarget(push), cardMessage(this.#previewCard(push)), { signal: this.#signal });
    if (outcome.status === "failed") {
      this.#store.updatePush(push.id, { state: "cancelled" });
      throw new Error(`预览卡片没有发出（${outcome.reason}），推送未准备，请稍后再试`);
    }
    return outcome.status;
  }

  /**
   * After the preview of a push whose recipients each get their own values: a workbook with everyone's, to the pusher, to
   * check before confirming (the card lists only as many as fit). False when it did not go out.
   */
  async #sendCheckSheet(push: Push): Promise<boolean> {
    const dir = join(userTmp(this.options.layout, DIRECT_SCOPE, push.pusher), `push-${push.id}-check`);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const sheet = await writeCheckSheet(push, this.#store.recipients(push.id), dir, this.#now());
      const fileId = await this.#outbound.upload(fileUpload(sheet), this.#signal);
      const outcome = await this.#outbound.send(this.#pusherTarget(push), uploadedFile(fileId, sheet), { signal: this.#signal });
      if (outcome.status === "failed") throw new Error(outcome.reason);
      return true;
    } catch (error) {
      if (!this.#signal.aborted) log.warn(`推送 ${push.id} 的核对表没有发出：${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
  }

  /**
   * The target as asked: people checked against the address book, departments found by name or path, all within the grants.
   * With `fields`, each person has their values for them.
   */
  #checkTarget(role: PushRole, input: PrepareInput, fields: readonly string[], problems: string[], unmatched: Unmatched[]): PushTarget {
    const people = this.#checkPeople(input.recipients ?? [], "对象", problems, unmatched);
    const given = new Map((input.recipients ?? []).map(entry => [String(entry?.phone ?? "").replace(/[\s-]/g, ""), (entry?.values ?? []).map(value => oneLine(String(value ?? "")))]));
    if (!fields.length && [...given.values()].some(values => values.length)) problems.push("给了每人的内容（values），却没有写栏目名（fields）");
    const incomplete = !fields.length ? [] : people.filter(person => given.get(person.phone)?.length !== fields.length || given.get(person.phone)!.some(value => !value));
    if (incomplete.length) {
      problems.push(`每人的内容要有 ${fields.length} 项，依次对应 ${fields.join("、")}，不能空着；这些人不全：${incomplete.slice(0, 10).map(person => person.name).join("、")}${incomplete.length > 10 ? ` 等 ${incomplete.length} 人` : ""}`);
    }
    const long = !fields.length ? [] : people.filter(person => given.get(person.phone)?.some(value => chars(value) > this.#limits.valueChars));
    if (long.length) problems.push(`每人的内容每项不能超过 ${this.#limits.valueChars} 个字；超过的有：${long.slice(0, 10).map(person => person.name).join("、")}${long.length > 10 ? ` 等 ${long.length} 人` : ""}`);
    if (people.length > this.#limits.people) problems.push(`一次最多列出 ${this.#limits.people} 个人；更多的人请按部门推送`);
    const asked = input.departments ?? [], tree = this.#directory.departments;
    const departments: TargetDepartment[] = [];
    if (asked.length > this.#limits.departments) problems.push(`一次最多列出 ${this.#limits.departments} 个部门；请改选它们的上级部门`);
    else if (asked.length && !role.grants.department) problems.push(NO_DEPARTMENT_GRANT);
    else if (asked.length && tree.updatedAt === undefined) problems.push("机器人还没有同步到部门信息，请稍后再试");
    else {
      for (const entry of asked) {
        const name = oneLine(String(entry?.name ?? ""));
        const { matches, similar } = tree.find(name);
        if (!matches.length) { problems.push(`找不到部门「${name}」${similar.length ? `，是不是：${similar.map(department => department.path).join("、")}` : ""}`); continue; }
        if (matches.length > 1) { problems.push(`有 ${matches.length} 个部门叫「${name}」，请用完整路径说明是哪一个：${matches.map(department => department.path).join("；")}`); continue; }
        const found = matches[0]!;
        if (!departments.some(department => department.id === found.id)) departments.push({ id: found.id, path: found.path, children: entry?.children !== false });
      }
    }
    const groups = this.#checkGroups(role, input, problems);
    const target: PushTarget = { people: people.map(({ phone, name }) => ({ phone, name, ...(fields.length ? { values: given.get(phone) ?? [] } : {}) })), departments, everyone: input.everyone === true,
      ...(groups.length ? { groups } : {}), ...(unmatched.length ? { unmatched: unmatched.map(each => each.who) } : {}) };
    problems.push(...this.#grantProblems(role, target));
    return target;
  }

  /** Groups by registered name; options are refused for them (a click in a group cannot be traced to a person). */
  #checkGroups(role: PushRole, input: PrepareInput, problems: string[]): TargetGroup[] {
    const asked = input.groups ?? [], groups: TargetGroup[] = [];
    if (!asked.length) return groups;
    if (asked.length > this.#limits.groups) { problems.push(`一次最多列出 ${this.#limits.groups} 个群`); return groups; }
    if (!role.grants.group) { problems.push(NO_GROUP_GRANT); return groups; }
    if (input.mode === "options") problems.push("推送到群不支持选项：群里的点击对应不到人。请改为确认收到（ack）或需要回复（reply），或改为按人、按部门推送");
    const registered = this.#store.groups().filter(group => group.state === "registered" && group.name !== null);
    if (!registered.length) { problems.push(`还没有登记任何群。${GROUP_STEPS}`); return groups; }
    for (const entry of asked) {
      const name = oneLine(String(entry?.name ?? ""));
      const found = registered.find(group => sameName(group.name!, name));
      if (!found) {
        problems.push(`没有登记名为「${name}」的群（已登记：${registered.slice(0, 20).map(group => group.name).join("、")}${registered.length > 20 ? ` 等 ${registered.length} 个` : ""}）。没有登记的群不能推送，${GROUP_STEPS}`);
        continue;
      }
      if (!groups.some(group => group.id === found.id)) groups.push({ id: found.id, name: found.name! });
    }
    return groups;
  }

  /** What in the target the pusher may not reach (any more): departments outside the grant or gone from the tree, everyone, groups no longer registered. */
  #grantProblems(role: PushRole, target: PushTarget): string[] {
    const problems: string[] = [], tree = this.#directory.departments, grant = role.grants.department;
    if (target.departments.length && !grant) problems.push(NO_DEPARTMENT_GRANT);
    for (const department of target.departments) {
      if (!grant) break;
      if (!tree.get(department.id)) problems.push(`部门「${department.path}」已不在同步的通讯录里`);
      else if ("departments" in grant && !tree.within(department.id, grant.departments)) {
        problems.push(`部门「${department.path}」不在你可以推送的部门里（可以推送：${grant.departments.map(id => tree.get(id)?.path ?? `部门 ${id}`).join("、")}，含下级）`);
      }
    }
    if (target.everyone && !role.grants.all) problems.push("你没有推送给全员的权限，请联系管理员在控制台授权");
    if (target.groups?.length && !role.grants.group) problems.push(NO_GROUP_GRANT);
    else for (const group of target.groups ?? []) if (this.#store.group(group.id)?.state !== "registered") problems.push(`群「${group.name}」已停用`);
    return problems;
  }

  /**
   * Who the target reaches now: the people named (still in the address book), then the departments' and everyone's
   * members but the pusher, then the groups (by their current names).
   */
  #expand(target: PushTarget, pusher: string): Reached[] {
    const list = new Map<string, DirectoryIdentity>(), tree = this.#directory.departments;
    for (const person of target.people) {
      const found = this.#directory.byPhone(person.phone);
      if (found) list.set(found.phone, found);
    }
    const add = (people: readonly DirectoryIdentity[]) => { for (const person of people) if (person.phone !== pusher && !list.has(person.phone)) list.set(person.phone, person); };
    for (const department of target.departments) add(tree.members([department.id], department.children));
    if (target.everyone) add(tree.everyone());
    const groups = (target.groups ?? []).map(group => groupReached({ id: group.id, name: this.#store.group(group.id)?.name ?? group.name }));
    const values = new Map(target.people.map(person => [person.phone, person.values]));
    return [...[...list.values()].map(person => ({ ...personReached(person), ...(values.get(person.phone) ? { values: values.get(person.phone)! } : {}) })), ...groups];
  }

  /**
   * The people of `list` as the address book has them. One that is not there as named is a problem, or with `unmatched`
   * is left out and listed there.
   */
  #checkPeople(list: readonly { name: string; phone: string }[], label: string, problems: string[], unmatched?: Unmatched[]): (Person & { imUserId: string })[] {
    const people = new Map<string, Person & { imUserId: string }>();
    for (const entry of list) {
      const phone = String(entry?.phone ?? "").replace(/[\s-]/g, ""), name = oneLine(String(entry?.name ?? ""));
      const found = phone ? this.#directory.byPhone(phone) : undefined;
      const why = !phone ? `${label}「${name || "（无姓名）"}」缺少手机号`
        : !found ? `${label} ${name || ""}（${phone}）不在机器人同步的通讯录范围内`
        : name && !sameName(name, found.name) ? `${label}手机号 ${phone} 在通讯录里是「${found.name}」，与「${name}」不符` : undefined;
      if (why === undefined) people.set(phone, { phone, name: found!.name, imUserId: found!.imUserId });
      else if (unmatched) unmatched.push({ who: `${name || "（无姓名）"}${phone ? `（尾号 ${phoneTail(phone)}）` : ""}`, why });
      else problems.push(why);
    }
    return [...people.values()];
  }

  #checkLimit(role: PushRole, now: number): void {
    if (role.dailyLimit === null) return;
    const used = this.#store.confirmedSince(role.phone, now - 24 * 3600_000);
    if (used >= role.dailyLimit) throw new PushRefused(`你 24 小时内最多推送 ${role.dailyLimit} 条，已达上限，请稍后再推送。`);
  }

  /** An ID no push has (`taken`: nor one of these). */
  #newId(taken: (id: string) => boolean = id => this.#store.exists(id)): string {
    for (;;) {
      const id = [...randomBytes(8)].map(byte => "abcdefghjkmnpqrstuvwxyz23456789"[byte % 31]).join("");
      if (!taken(id)) return id;
    }
  }

  // ---- push_status ----------------------------------------------------------------------------------------------------

  /** The pusher's own pushes: the latest few, or one in detail. */
  status(phone: string, id?: string): string {
    if (!this.isPusher(phone)) throw new PushRefused("你没有推送权限。");
    const now = this.#now();
    if (id) {
      const push = this.#store.push(id.trim().toLowerCase());
      if (!push || push.pusher !== phone) throw new PushRefused(`没有你发起的推送 ${id}。`);
      const recipients = this.#store.recipients(push.id), items = this.#store.items(push.id), forwards = this.#store.forwards(push.id, "confirmed");
      const lines = [this.#statusLine(push, recipients, now), ""];
      for (const recipient of recipients.slice(0, 100)) {
        const who = memberGroup(recipient.member) === undefined ? `${recipient.name}（尾号 ${phoneTail(recipient.member)}）` : `群 ${recipient.name}`;
        const by = forwards.find(forward => forward.to === recipient.member), to = forwards.filter(forward => forward.from === recipient.member);
        lines.push(`- ${who}${by ? `（${recipients.find(each => each.member === by.from)?.name ?? "别人"} 转来）` : ""}：${this.#personState(push, recipient, items)}`
          + (to.length ? `；已转给 ${to.map(forward => forward.toName).join("、")}` : "") + valuesNote(push, recipient.values, by ? "转来的内容" : "内容"));
      }
      if (recipients.length > 100) lines.push(`……共 ${reachText(reachOf(recipients))}，其余见控制台推送页。`);
      return lines.join("\n");
    }
    const pushes = this.#store.pushesOf(phone, 5);
    if (!pushes.length) return "你还没有发起过推送。";
    return ["你最近的推送（新的在前）：", ...pushes.map(push => `- ${this.#statusLine(push, this.#store.recipients(push.id), now)}`),
      "", "要看某条推送每个人的情况，用推送编号再查一次。"].join("\n");
  }

  #statusLine(push: Push, recipients: readonly Recipient[], now: number): string {
    const state = push.state === "preview" ? "待确认" : push.state === "sending" ? "发送中" : push.state === "open" ? "进行中"
      : push.state === "cancelled" ? "已取消" : push.state === "expired" ? "已失效" : push.closeReason === "complete" ? "已全部答复" : "已截止";
    return `推送编号 ${push.id}「${push.subject}」${state}，${push.confirmedAt ? `${shortTime(push.confirmedAt, now)} 发出` : `${shortTime(push.createdAt, now)} 准备`}，`
      + `截止 ${shortTime(push.deadline, now)}；${this.#tally(push, recipients)}`;
  }

  /** Counts of a push, as the summary and push_status word them. */
  #tally(push: Push, recipients: readonly Recipient[]): string {
    const delivered = recipients.filter(recipient => recipient.sendState === "sent" || recipient.sendState === "uncertain");
    const failed = recipients.filter(recipient => recipient.sendState === "failed").length;
    const head = `共 ${reachText(reachOf(recipients))}${failed ? `（发送失败 ${failed}）` : ""}`;
    // Handed on without an answer of their own: neither answered nor waited for.
    const handed = this.#handed(push.id), none = new Set<string>();
    const passed = delivered.filter(recipient => handed.has(recipient.member) && !this.#answered(push, recipient, none)).length;
    const also = passed ? `，已转派 ${passed}` : "";
    if (push.mode === "ack") {
      const acked = delivered.filter(recipient => recipient.ackedAt !== null).length;
      return `${head}；已确认 ${acked}${also}，未确认 ${delivered.length - acked - passed}`;
    }
    if (push.mode === "options") {
      const counts = push.options.map((option, index) => `${option} ${delivered.filter(recipient => recipient.choice === index).length}`);
      return `${head}；${counts.join("，")}${also}，未选择 ${delivered.filter(recipient => recipient.choice === null).length - passed}`;
    }
    const acked = delivered.filter(recipient => recipient.ackedAt !== null).length, replied = delivered.filter(recipient => recipient.repliedAt !== null).length;
    return `${head}；已确认 ${acked}，已回复 ${replied}${also}，未回复 ${delivered.length - replied - passed}`;
  }

  #personState(push: Push, recipient: Recipient, items: readonly ReplyItem[]): string {
    if (recipient.sendState === "failed") return `发送失败（${recipient.sendError ?? "原因未知"}）`;
    if (recipient.sendState === "pending" || recipient.sendState === "sending") return "未发出";
    const clicks = memberGroup(recipient.member) === undefined ? "" : `，群里共点击 ${recipient.clicks} 次`;
    if (push.mode === "ack") return recipient.ackedAt === null ? "未确认" : `已确认（${shortTime(recipient.ackedAt, this.#now())}${clicks}）`;
    if (push.mode === "options") return recipient.choice === null ? "未选择" : `选择「${push.options[recipient.choice]}」`;
    const own = replyItems(recipient, items);
    if (!own.length) return recipient.ackedAt === null ? "未确认，未回复" : "已确认，未回复";
    const text = replyText(own), files = own.filter(item => item.kind !== "text").map(item => item.name ?? "附件");
    return `已回复：${text ? truncate(oneLine(text), 200) : "（没有文字）"}${files.length ? `；附件：${files.join("、")}` : ""}`;
  }

  // ---- directory_lookup -----------------------------------------------------------------------------------------------

  /**
   * People in the synced address book, for a pusher or a recipient of a live push: by part of a name (several names are
   * looked up one by one), by phone, or in a department (with its sub-departments unless `children` is false); given
   * together they narrow down. Each comes with the full phone and the departments, at most `lookup` of them. The
   * model's answer.
   */
  lookup(phone: string, input: LookupInput): string {
    if (!this.isPusher(phone) && !this.#store.reached(phone).length) throw new PushRefused("查通讯录是给推送人和收到推送的人用的，这位成员现在两样都不是。");
    const tree = this.#directory.departments;
    // Each name once, as it was first written.
    const names = new Map<string, string>();
    for (const name of input.names ?? []) if (compactName(String(name ?? "")) && !names.has(compactName(String(name)))) names.set(compactName(String(name)), oneLine(String(name)));
    const number = (input.phone ?? "").replace(/[\s-]/g, ""), department = oneLine(input.department ?? "");
    if (!names.size && !number && !department) throw new PushRefused("请给出姓名（可以只写其中几个字）、手机号或部门，至少一项。");
    if (names.size > this.#limits.lookupNames) throw new PushRefused(`一次最多查 ${this.#limits.lookupNames} 个名字，请分几次查。`);
    const lines: string[] = [];
    let people: readonly DirectoryIdentity[];
    if (department) {
      if (tree.updatedAt === undefined) return "机器人还没有同步到部门信息，暂时不能按部门查，请稍后再试；按姓名或手机号可以查。";
      const { matches, similar } = tree.find(department);
      if (!matches.length) return `找不到部门「${department}」${similar.length ? `，是不是：${similar.map(each => each.path).join("、")}` : ""}。`;
      if (matches.length > 1) return `有 ${matches.length} 个部门叫「${department}」，请用完整路径再查：${matches.map(each => each.path).join("；")}。`;
      const found = matches[0]!, children = input.children !== false;
      const below = tree.all().filter(each => each.parent === found.id).map(each => each.name);
      lines.push(`部门 ${found.path}（${children ? "含下级" : "不含下级"}）`
        + (below.length ? `，下级部门：${below.slice(0, 30).join("、")}${below.length > 30 ? ` 等 ${below.length} 个` : ""}` : "，没有下级部门"));
      people = tree.members([found.id], children);
    } else people = number ? [this.#directory.byPhone(number)].filter(person => person !== undefined) : tree.everyone();
    const pool = people.filter(person => !number || person.phone === number);
    // One list, or one per name; the names share what an answer may list.
    const several = names.size > 1, limit = several ? Math.max(5, Math.floor(this.#limits.lookup / names.size)) : this.#limits.lookup;
    for (const [key, asked] of names.size ? names : [["", ""] as const]) {
      const matched = pool.filter(person => !key || compactName(person.name).includes(key)), head = several ? `「${asked}」` : "";
      if (!matched.length) { lines.push(several ? `${head}没有找到。` : "没有找到符合的人（只查机器人同步的通讯录范围）。"); continue; }
      const shown = matched.slice(0, limit), places = tree.departmentsOf(shown.map(person => person.phone));
      lines.push(matched.length <= limit ? `${head}找到 ${matched.length} 人：`
        : several ? `${head}找到 ${matched.length} 人，只列出前 ${limit} 人；把名字写全或加上部门可以缩小范围：`
        : `找到 ${matched.length} 人，只列出前 ${limit} 人；可以加上姓名或改查下级部门缩小范围：`);
      for (const person of shown) {
        const paths = places.get(person.phone) ?? [];
        lines.push(`- ${person.name}，手机号 ${person.phone}${paths.length ? `，部门：${paths.join("；")}` : ""}`);
      }
    }
    if (several) lines.push("只查机器人同步的通讯录范围。");
    return lines.join("\n");
  }

  // ---- clicks ---------------------------------------------------------------------------------------------------------

  /** A card click from the event stream (callback:card_interaction). Synchronous decisions; sends run in the background. */
  click(event: StreamEvent): void {
    const payload = event.payload;
    const data = clickData(payload.content);
    const userId = typeof payload.userId === "string" ? payload.userId : "", card = typeof payload.msgUid === "string" ? payload.msgUid : "";
    // Not a push card's click: the card's message ID and what the event looked like (field names and kinds only) tell a
    // card of another feature from a click whose data arrived in a form or a place this service does not read.
    if (!data) {
      log.info(`忽略不属于推送的卡片点击（卡片 ${/^[\x21-\x7e]{1,128}$/.test(card) ? card : "?"}）：${clickShape(payload)}`);
      return;
    }
    const groupId = typeof payload.groupId === "string" ? payload.groupId : "";
    if (!/^[\x21-\x7e]{1,128}$/.test(userId) || !/^[\x21-\x7e]{1,128}$/.test(card)) { log.warn("推送卡片点击缺少有效的 userId 或 msgUid，已丢弃"); return; }
    if (groupId && !GROUP_ID.test(groupId)) { log.warn("推送卡片点击的群号无效，已丢弃"); return; }
    // The same click delivered twice (a reconnect): its stamp, card, button and version repeat.
    const key = `${card}|${event.sentAt ?? ""}|${data.action}|${data.version}|${data.option ?? ""}|${data.forward ?? ""}|${userId}|${groupId}`;
    if (this.#clicks.has(key)) return;
    if (this.#clicks.size >= 20_000) this.#clicks.delete(this.#clicks.values().next().value!);
    this.#clicks.add(key);
    const found = this.#store.push(data.push);
    if (!found) {
      log.info(`推送 ${data.push} 不存在，忽略点击`);
      // A preview's buttons: the record was cleared with a later confirmed push, or deleted in the console.
      if (!groupId && (data.action === "confirm" || data.action === "cancel")) this.#text({ kind: "direct", receiveId: userId }, PREVIEW_GONE);
      return;
    }
    const click: Click = { event, data, userId, card };
    try {
      // Past the deadline the push ends first: the click only shows the end.
      const push = this.#closeIfDue(found) ? this.#store.push(found.id)! : found;
      // Previews, summaries and the cards that ask before handing on go to direct chats only.
      if (groupId) {
        if (data.action === "confirm" || data.action === "cancel" || data.action === "remind" || data.action === "forward" || data.action === "keep") {
          log.warn(`推送 ${push.id} 的预览、汇总或转派按钮出现在群里，忽略`);
        } else this.#recipientClick(push, click, groupId);
      }
      else if (data.action === "confirm" || data.action === "cancel") this.#previewClick(push, click);
      else if (data.action === "remind") this.#summaryClick(push, click);
      else if (data.action === "forward" || data.action === "keep") this.#forwardClick(push, click);
      else this.#recipientClick(push, click);
    } catch (error) { this.#report(error); }
  }

  #previewClick(push: Push, click: Click): void {
    const clicker = this.#directory.lookup(click.userId);
    if (clicker?.phone !== push.pusher && click.userId !== push.pusherIm) { log.warn(`推送 ${push.id} 的预览卡片被推送人以外的人点击，忽略`); return; }
    if (push.previewCard !== click.card) this.#store.updatePush(push.id, { previewCard: click.card });
    const current = this.#store.push(push.id)!;
    if (current.state !== "preview" || click.data.version !== current.previewVersion) { this.#refreshPreview(push.id); return; }
    if (click.data.action === "cancel") {
      this.#store.movePush(push.id, ["preview"], { state: "cancelled", previewVersion: current.previewVersion + 1 });
      log.info(`推送 ${push.id} 已由推送人取消`);
      this.#previewSettled(push.id);
      return;
    }
    const role = this.#store.role(push.pusher), now = this.#now();
    if (!role?.pusher) {
      this.#store.movePush(push.id, ["preview"], { state: "cancelled", previewVersion: current.previewVersion + 1 });
      this.#previewSettled(push.id);
      this.#text(this.#pusherTarget(push), "你已没有推送权限，这条推送已取消。");
      return;
    }
    // A given deadline was checked when the push was prepared, up to a day ago. A default one starts now, as the card says.
    if (!current.defaultDeadline && current.deadline < now + this.#limits.confirmDeadlineMs) {
      this.#store.movePush(push.id, ["preview"], { state: "cancelled", previewVersion: current.previewVersion + 1 });
      this.#previewSettled(push.id);
      this.#text(this.#pusherTarget(push), "这条推送没有发出，已取消：截止时间已经过了，或离现在不到 5 分钟。请重新准备。");
      return;
    }
    try { this.#checkLimit(role, now); }
    catch (error) { this.#text(this.#pusherTarget(push), (error as Error).message); return; }
    // The list is expanded again: the address book and the grants of this moment.
    const problems = this.#grantProblems(role, current.target);
    const people = problems.length ? [] : this.#expand(current.target, push.pusher);
    if (problems.length || !people.length || people.length > this.#limits.recipients) {
      this.#store.movePush(push.id, ["preview"], { state: "cancelled", previewVersion: current.previewVersion + 1 });
      this.#previewSettled(push.id);
      const reach = reachOf(people);
      this.#text(this.#pusherTarget(push), `这条推送没有发出，已取消：${problems.length ? problems.join("；") : !people.length ? "按现在的通讯录没有可以接收的人"
        : `现在是 ${reachText(reach)}${reach.groups ? "（一个群算一人）" : ""}，超过一次 ${this.#limits.recipients} 人的上限`}。`);
      return;
    }
    const deadline = current.defaultDeadline ? now + this.#limits.defaultDeadlineMs : current.deadline;
    const confirmed = this.#store.transaction(() => {
      if (!this.#store.movePush(push.id, ["preview"], { state: "sending", confirmedAt: now, previewVersion: current.previewVersion + 1, deadline,
        checkpoints: checkpoints(now, deadline) })) return false;
      this.#store.replaceRecipients(push.id, people.map(person => this.#recipientRow(push.id, person)));
      this.#dropSuperseded();
      return true;
    });
    if (!confirmed) return;
    log.info(`推送 ${push.id} 已确认，开始发送 ${people.length} 张卡片`);
    this.#previewSettled(push.id);
    this.#pump();
  }

  /**
   * Delete the previews a pusher prepared before a push they confirmed: a push settled over several rounds leaves one
   * record, the one that went out. Their cards cannot be updated (a card's ID is only known from a click on it): a
   * click on one is answered in `click`.
   */
  #dropSuperseded(): void {
    this.#store.transaction(() => {
      for (const preview of this.#store.supersededPreviews()) {
        this.#store.remove(preview.id);
        log.info(`推送 ${preview.id} 的预览没有确认，推送人确认了之后准备的推送，已清理`);
      }
    });
  }

  /** The preview's state changed: its card, and for a follow-up the summary card of the push it reminds. */
  #previewSettled(pushId: string): void {
    this.#refreshPreview(pushId);
    const of = this.#store.push(pushId)?.target.of;
    if (of) this.#refreshSummary(of);
  }

  /** 「提醒未回复」 on the pusher's summary card (only the pusher's click counts): a follow-up push, as a preview. */
  #summaryClick(push: Push, click: Click): void {
    const clicker = this.#directory.lookup(click.userId);
    if (clicker?.phone !== push.pusher && click.userId !== push.pusherIm) { log.warn(`推送 ${push.id} 的汇总卡片被推送人以外的人点击，忽略`); return; }
    if (push.summaryCard !== click.card) this.#store.updatePush(push.id, { summaryCard: click.card });
    const current = this.#store.push(push.id)!;
    if (current.state !== "closed" || click.data.version !== current.summaryVersion || this.#followUpOf(current)) { this.#refreshSummary(push.id); return; }
    this.#track(this.#prepareFollowUp(current).catch(error => {
      this.#text(this.#pusherTarget(push), error instanceof PushRefused ? error.message : `补推送没有准备好：${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => this.#refreshSummary(push.id)));
  }

  /** The follow-up of a push that is not void (cancelled or expired): one at a time. */
  #followUpOf(push: Push): Push | undefined {
    const followUp = push.followUp ? this.#store.push(push.followUp) : undefined;
    return followUp && followUp.state !== "cancelled" && followUp.state !== "expired" ? followUp : undefined;
  }

  /**
   * A follow-up of a closed push: the same content and CCs to the recipients who did not answer (`members`: only these of
   * them), with the default deadline, as a preview the pusher confirms. Returns its ID. Synchronous up to the preview's
   * send: the summary card's version moves on with it, so a second click or a console call meanwhile is refused.
   */
  async #prepareFollowUp(original: Push, members?: readonly string[]): Promise<string> {
    const role = this.#store.role(original.pusher);
    if (!role?.pusher) throw new PushRefused("你已没有推送权限，不能补推送。");
    const existing = this.#followUpOf(original);
    if (existing) throw new PushRefused(`「${original.subject}」已经准备过补推送（推送编号 ${existing.id}）${existing.state === "preview" ? "，请在预览卡片上确认或取消" : ""}。`);
    this.#checkLimit(role, this.#now());
    const chosen = this.#unanswered(original).filter(recipient => !members || members.includes(recipient.member));
    // People still in the address book, groups still registered (by their current names).
    const people = chosen.flatMap(recipient => memberGroup(recipient.member) === undefined ? this.#directory.byPhone(recipient.member) ?? [] : []);
    const groups = chosen.flatMap(recipient => {
      const group = this.#store.group(memberGroup(recipient.member) ?? "");
      return group?.state === "registered" && group.name !== null ? [{ id: group.id, name: group.name }] : [];
    });
    // Each keeps what the push said for them (one it was handed on to: what it said for who handed it on).
    const valuesOf = (phone: string) => original.fields.length ? { values: chosen.find(recipient => recipient.member === phone)?.values ?? [] } : {};
    const reached = [...people.map(person => ({ ...personReached(person), ...valuesOf(person.phone) })), ...groups.map(groupReached)];
    if (!reached.length) throw new PushRefused(`「${original.subject}」没有需要补推送的对象：没有答复的人都已不在同步的通讯录里（群已停用），或已经全部答复。`);
    const pusher = this.#directory.byPhone(original.pusher), now = this.#now();
    const push = this.#newPush({ pusher: original.pusher, pusherName: pusher?.name ?? original.pusherName, pusherIm: pusher?.imUserId ?? original.pusherIm,
      subject: original.subject, body: original.body, mode: original.mode, options: original.options, deadline: now + this.#limits.defaultDeadlineMs,
      defaultDeadline: true, target: { people: people.map(({ phone, name }) => ({ phone, name, ...valuesOf(phone) })), departments: [], everyone: false, ...(groups.length ? { groups } : {}),
        of: original.id }, cc: original.cc, remind: original.remind, files: [], fields: original.fields });
    push.files = this.#linkFiles(original, push.id);
    await this.#createPreview(push, reached, () => this.#store.updatePush(original.id, { followUp: push.id, summaryVersion: original.summaryVersion + 1 }));
    if (original.files.length && !push.files.length) this.#text(this.#pusherTarget(original), `「${original.subject}」的附件已经清理，这条补推送不带附件；要带附件请重新准备一条推送。`);
    if (push.fields.length && !await this.#sendCheckSheet(push)) this.#text(this.#pusherTarget(original), `「${original.subject}」补推送的核对表没有发出；每个人的内容和原来那条推送里的一样。`);
    log.info(`推送 ${original.id} 的补推送 ${push.id} 已准备：${reachText(reachOf(reached))}`);
    return push.id;
  }

  /** Recipients without an answer: delivered and neither answered nor handed on, or never reached. */
  #unanswered(push: Push): Recipient[] {
    const handed = this.#handed(push.id);
    return this.#store.recipients(push.id).filter(recipient => recipient.sendState === "failed" || !this.#answered(push, recipient, handed));
  }

  /** Answered; whoever handed the push on (`handed`) counts as that too. */
  #answered(push: Push, recipient: Recipient, handed: ReadonlySet<string>): boolean {
    return handed.has(recipient.member) || (push.mode === "ack" ? recipient.ackedAt !== null : push.mode === "options" ? recipient.choice !== null : recipient.repliedAt !== null);
  }

  /** The recipients who handed the push on. */
  #handed(pushId: string): Set<string> {
    return new Set(this.#store.forwards(pushId, "confirmed").map(forward => forward.from));
  }

  // ---- the console: 补推送 and CCs ------------------------------------------------------------------------------------

  /**
   * 补推送 (the console): a live push sends its card again to the chosen recipients who have not answered (default: all of
   * them, failed cards included); a closed one prepares a follow-up push, as its summary card does.
   */
  async remind(pushId: string, members?: readonly string[]): Promise<{ resent: number } | { followUp: string }> {
    const push = this.#store.push(pushId);
    if (!push) throw new PushRefused("推送不存在");
    if (push.state === "closed") {
      try { return { followUp: await this.#prepareFollowUp(push, members) }; }
      finally { this.#refreshSummary(pushId); }
    }
    if (this.#closeIfDue(push)) throw new PushRefused("这条推送已经截止，请刷新后再补推送");
    if (!LIVE_STATES.includes(push.state)) throw new PushRefused("这条推送没有发出，不能补推送");
    const chosen = this.#resend(push, members);
    if (chosen.length) { log.info(`推送 ${pushId}：补推送 ${chosen.length} 张卡片`); this.#pump(); }
    return { resent: chosen.length };
  }

  /**
   * The card of a live push goes again to the recipients who have not answered (`members`: only these of them), failed
   * cards included: a new card message each (`card: null`); the old card keeps working, a click on it makes it the one
   * updated again. The caller starts the sends.
   */
  #resend(push: Push, members?: readonly string[]): Recipient[] {
    const chosen = this.#unanswered(push).filter(recipient => (!members || members.includes(recipient.member))
      && recipient.sendState !== "pending" && recipient.sendState !== "sending");
    this.#store.transaction(() => {
      for (const recipient of chosen) this.#store.updateRecipient(push.id, recipient.member, { sendState: "pending", sendAttempts: 0, retryAt: null, sendError: null, card: null });
    });
    return chosen;
  }

  /**
   * A progress moment of an open push came (./reminders.ts): the pusher is told how it stands, and unless they turned
   * that off the card goes again to whoever has not answered. Moments missed while the service was down count as one,
   * and wait for the morning when the service is back at night (the tick); with everyone answered, or within the last
   * half hour, nothing is sent.
   */
  #lookIn(push: Push): void {
    const now = this.#now(), rest = push.checkpoints.filter(at => at > now);
    const waiting = this.#unanswered(push).filter(recipient => recipient.sendState !== "pending" && recipient.sendState !== "sending");
    if (!waiting.length || push.deadline - now < this.#limits.remindLeadMs) { this.#store.updatePush(push.id, { checkpoints: rest }); return; }
    const tally = this.#tally(push, this.#store.recipients(push.id));
    const reminded = this.#atomic(() => {
      this.#store.updatePush(push.id, { checkpoints: rest, reminded: push.reminded + (push.remind ? 1 : 0) });
      return push.remind ? this.#resend(this.#store.push(push.id)!) : [];
    });
    const told = reminded.length ? `已把卡片再发给没有答复的 ${reachText(reachOf(reminded))}。` : "";
    log.info(`推送 ${push.id} 的进度已告知推送人${reminded.length ? `，提醒 ${reminded.length} 张卡片` : ""}`);
    this.#text(this.#pusherTarget(push), `推送「${push.subject}」的进度：${tally}。${shortTime(push.deadline, now)} 截止。${told}（推送编号 ${push.id}）`);
    this.#note(DIRECT_SCOPE, push.pusher, `progress:${push.id}:${push.checkpoints.length - rest.length}:${rest.length}`,
      `[推送进度]「${quoted(push.subject)}」：${tally}；截止 ${shortTime(push.deadline, now)}。${told}推送编号 ${push.id}`, { push: push.id, event: "progress" });
    if (reminded.length) this.#pump();
  }

  /** Change the CCs until the summary goes out (the console); the people are checked as push_prepare checks them. */
  setCc(pushId: string, people: readonly { name: string; phone: string }[]): void {
    const push = this.#store.push(pushId);
    if (!push) throw new PushRefused("推送不存在");
    if (push.state === "cancelled" || push.state === "expired") throw new PushRefused("这条推送没有发出");
    if ((push.state === "closed" && push.summaryState !== "pending") || this.#refreshing.has(`summary:${pushId}`)) throw new PushRefused("汇总已经在发或已经发出，不能再改抄送人");
    const problems: string[] = [];
    const cc = this.#checkPeople(people, "抄送人", problems).filter(person => person.phone !== push.pusher);
    if (cc.length > this.#limits.cc) problems.push(`抄送人最多 ${this.#limits.cc} 个`);
    if (problems.length) throw new PushRefused(problems.join("；"));
    this.#store.updatePush(pushId, { cc: cc.map(({ phone, name }) => ({ phone, name })) });
    if (push.state === "preview") this.#refreshPreview(pushId);
  }

  /** The console's list: newest first, then by ID; `before`: after this push of the page before. With the totals over all pushes. */
  list(query: { group: PushGroup | null; before: PushCursor | null; limit: number }): { pushes: PushListItem[]; more: boolean; totals: PushTotals } {
    const page = this.#store.page(query.group ? PUSH_GROUPS[query.group] : null, query.before, query.limit + 1), shown = page.slice(0, query.limit);
    const counts = this.#store.recipientCounts(shown.map(push => push.id));
    return { pushes: shown.map(push => this.#listItem(push, counts.get(push.id))), more: page.length > query.limit, totals: this.#store.totals() };
  }

  #listItem(push: Push, counts: RecipientCounts | undefined): PushListItem {
    const { total = 0, groups = 0, delivered = 0, failed = 0, answered = 0 } = counts ?? {};
    return { id: push.id, subject: push.subject, mode: push.mode, state: push.state, pusher: push.pusher, pusherName: push.pusherName, createdAt: push.createdAt,
      confirmedAt: push.confirmedAt, deadline: push.deadline, closedAt: push.closedAt, closeReason: push.closeReason, summaryState: push.summaryState,
      followUp: push.followUp, of: push.target.of ?? null,
      counts: { total, groups, delivered, failed, answered } };
  }

  /** One push for the console: its content and every recipient's state and reply. */
  detail(id: string): PushDetail {
    const push = this.#store.push(id);
    if (!push) throw new PushRefused("推送不存在");
    const recipients = this.#store.recipients(id), items = this.#store.items(id), forwards = this.#store.forwards(id, "confirmed");
    const handed = new Set(forwards.map(forward => forward.from));
    return {
      push: { ...this.#listItem(push, this.#store.recipientCounts([id]).get(id)), body: push.body, options: push.options, defaultDeadline: push.defaultDeadline, target: push.target, cc: push.cc,
        files: push.files, fields: push.fields, summaryError: push.summaryError, summaryAt: push.summaryAt, remind: push.remind, reminded: push.reminded, checkpoints: push.checkpoints },
      recipients: recipients.map(recipient => {
        const own = replyItems(recipient, items), text = replyText(own);
        return { member: recipient.member, name: recipient.name, values: recipient.values, sendState: recipient.sendState, sendError: recipient.sendError, sentAt: recipient.sentAt,
          ackedAt: recipient.ackedAt, clicks: recipient.clicks, choice: recipient.choice === null ? null : push.options[recipient.choice] ?? null, choiceAt: recipient.choiceAt,
          repliedAt: recipient.repliedAt,
          answered: (recipient.sendState === "sent" || recipient.sendState === "uncertain") && this.#answered(push, recipient, handed),
          reply: own.length ? { text: chars(text) > 2000 ? truncate(text, 2000) : text,
            files: own.filter(item => item.kind !== "text").map(item => ({ name: item.name ?? "附件", size: item.size, kind: item.kind })), senders: senders(own) } : null,
          forwardedBy: forwards.flatMap(forward => forward.to === recipient.member ? [recipients.find(each => each.member === forward.from)?.name ?? forward.from] : [])[0] ?? null,
          forwardedTo: forwards.filter(forward => forward.from === recipient.member).map(forward => forward.toName) };
      }),
    };
  }

  /**
   * Delete a push that is over (the console): closed with its summary sent or given up, cancelled, or expired. Held
   * reply attachments are released first; conversation notes stay in the conversations.
   */
  async remove(id: string): Promise<void> {
    const push = this.#store.push(id);
    if (!push) throw new PushRefused("推送不存在");
    if (push.state === "preview" || LIVE_STATES.includes(push.state)) throw new PushRefused("推送还没有结束，不能删除；未确认的预览会在 24 小时后失效");
    if (push.state === "closed" && (push.summaryState === "pending" || this.#refreshing.has(`summary:${id}`))) throw new PushRefused("汇总还没有发出，请稍后再删除");
    if (!push.released) {
      await this.#releasePush(id);
      if (!this.#store.push(id)?.released) throw new PushRefused("回复附件的占用没有解除（可能还在接收或下载），请稍后再删除");
    }
    this.#store.remove(id);
    await rm(join(this.options.layout.pushFiles, id), { recursive: true, force: true }).catch(error => this.#report(error));
    log.info(`推送 ${id} 已在控制台删除`);
  }

  /**
   * The console's package: the summary workbook and the replies with their attachments, of the whole push or one
   * recipient (`member`), phones masked, as one archive in its own directory; `done` removes it.
   */
  async package(id: string, member?: string, signal?: AbortSignal): Promise<{ path: string; name: string; size: number; done(): Promise<void> }> {
    const push = this.#store.push(id);
    if (!push) throw new PushRefused("推送不存在");
    if (push.state === "preview" || push.state === "cancelled" || push.state === "expired") throw new PushRefused("这条推送没有发出");
    const recipients = this.#store.recipients(id).filter(recipient => member === undefined || recipient.member === member);
    if (!recipients.length) throw new PushRefused("这条推送没有这个接收人");
    const items = this.#store.items(id).filter(item => member === undefined || item.member === member);
    const dir = join(this.options.layout.tmp, `${PACKAGE_DIR}${randomBytes(8).toString("hex")}`);
    const done = () => rm(dir, { recursive: true, force: true }).catch(() => {});
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const pack = await buildSummary({ push, recipients, items, forwards: this.#store.forwards(id, "confirmed"), files: await this.#heldFiles(id, items), dir,
        partBytes: Number.MAX_SAFE_INTEGER, now: this.#now(),
        signal: signal ? AbortSignal.any([this.#signal, signal]) : this.#signal });
      if (pack.parts.length !== 1) throw new PushRefused("回复附件合计超过 4 GiB，请按人下载");
      const part = pack.parts[0]!, person = recipients[0]!;
      return { path: part.path, size: part.size, done,
        name: member === undefined ? part.name
          : part.name.replace(/\.zip$/, memberGroup(person.member) === undefined ? `-${person.name}-${person.member.slice(-4)}.zip` : `-群-${person.name}.zip`) };
    } catch (error) { await done(); throw error; }
  }

  /** The held attachments of these items, as the members' records have them now. */
  async #heldFiles(pushId: string, items: readonly ReplyItem[]): Promise<Map<string, HeldFile>> {
    const files = new Map<string, HeldFile>();
    for (const member of new Set(items.filter(item => item.attachment).map(item => item.member))) {
      for (const [id, attachment] of Object.entries((await this.#host!.records(DIRECT_SCOPE, member)).attachments)) {
        if (attachment.heldBy === holderOf(pushId)) files.set(id, attachment);
      }
    }
    return files;
  }

  /** A click on a recipient's card: a person's (found by the clicker), or a group's (`groupId`: anyone there counts). */
  #recipientClick(push: Push, click: Click, groupId?: string): void {
    let recipient;
    if (groupId !== undefined) recipient = this.#store.recipient(push.id, groupMember(groupId));
    else {
      const member = this.#directory.lookup(click.userId)?.phone;
      recipient = member === undefined ? undefined : this.#store.recipient(push.id, member);
      recipient ??= this.#store.recipients(push.id).find(each => each.receiveId === click.userId && memberGroup(each.member) === undefined);
    }
    if (!recipient) { log.warn(`推送 ${push.id} 的卡片被${groupId === undefined ? "非接收人" : "不是接收群的群里"}点击，忽略`); return; }
    const { member: phone } = recipient;
    if (recipient.card !== click.card) this.#store.updateRecipient(push.id, phone, { card: click.card });
    recipient = this.#store.recipient(push.id, phone)!;
    const now = this.#now(), { action, option } = click.data;
    // A group's 「已收到」 counts every click, also one on a card version since passed (the button stays).
    if (groupId !== undefined && action === "ack" && LIVE_STATES.includes(push.state) && push.mode !== "options") {
      this.#store.updateRecipient(push.id, phone, { clicks: recipient.clicks + 1, ackedAt: recipient.ackedAt ?? now });
      this.#refreshCard(push.id, phone);
      this.#checkComplete(push.id);
      return;
    }
    if (!LIVE_STATES.includes(push.state) || click.data.version !== recipient.version) { this.#refreshCard(push.id, phone); return; }
    const bump = (change: Partial<Recipient>) => this.#store.updateRecipient(push.id, phone, { ...change, version: recipient!.version + 1 });
    switch (action) {
      case "ack":
        if (recipient.ackedAt === null && push.mode !== "options") bump({ ackedAt: now });
        break;
      case "choose":
        if (push.mode !== "options" || option === undefined || option >= push.options.length) break;
        bump({ choice: option, choiceAt: now, ackedAt: recipient.ackedAt ?? now });
        break;
    }
    this.#refreshCard(push.id, phone);
    this.#checkComplete(push.id);
  }

  // ---- handing a push on (push_forward) -------------------------------------------------------------------------------

  /**
   * A recipient wants the push to go to someone else: the person is checked against the address book and a card asks the
   * recipient; nothing goes to that person before 「确认转派」. The model's answer.
   */
  async forward(speaker: { phone: string }, input: ForwardInput): Promise<string> {
    const { push, recipient } = this.#reachedPush(DIRECT_SCOPE, speaker.phone, input.push);
    const problems: string[] = [];
    const target = this.#checkPeople([input.to ?? { name: "", phone: "" }], "转派对象", problems)[0];
    if (!target) throw new PushRefused(problems.join("；") || "转派对象要有姓名和手机号，先用 directory_lookup 查。");
    if (target.phone === speaker.phone) throw new PushRefused("不能转给成员自己。");
    if (target.phone === push.pusher) throw new PushRefused(`${target.name} 就是这条推送的推送人，不用转。`);
    if (this.#listed(push.id, target.phone)) throw new PushRefused(`${target.name} 已经在「${push.subject}」的名单里，不用转。`);
    const now = this.#now();
    const forward: Forward = { id: this.#newId(id => this.#store.forward(id) !== undefined), pushId: push.id, from: speaker.phone, to: target.phone, toName: target.name,
      state: "pending", card: null, version: 0, createdAt: now, decidedAt: null };
    this.#atomic(() => {
      // Asked again for the same person: the earlier card no longer counts.
      for (const earlier of this.#store.forwards(push.id, "pending")) {
        if (earlier.from !== speaker.phone || earlier.to !== target.phone) continue;
        this.#store.updateForward(earlier.id, { state: "cancelled", decidedAt: now, version: earlier.version + 1 });
        this.#refreshForward(earlier.id);
      }
      this.#store.addForward(forward);
    });
    const outcome = await this.#outbound.send(this.#memberTarget(recipient), cardMessage(this.#forwardCard(forward.id)!), { signal: this.#signal });
    if (outcome.status === "failed") {
      this.#store.updateForward(forward.id, { state: "cancelled", decidedAt: this.#now(), version: 1 });
      throw new Error(`确认卡片没有发出（${outcome.reason}），没有转派，请稍后再试`);
    }
    log.info(`推送 ${push.id}：一位接收人准备转派，等待确认`);
    const places = this.#directory.departments.departmentsOf([target.phone]).get(target.phone) ?? [];
    return `已把确认卡片发给成员本人：把「${push.subject}」转给 ${target.name}${places.length ? `（${places.join("；")}）` : ""}。`
      + `成员点卡片上的「确认转派」后才会发给 ${target.name}，点之前没有发给任何人。`
      + (outcome.status === "uncertain" ? "（确认卡片的发送结果不确定，成员没收到的话请重新提出。）" : "");
  }

  /** In the push's list already; a person whose card could not be delivered may be handed the push (again). */
  #listed(pushId: string, member: string): boolean {
    const row = this.#store.recipient(pushId, member);
    return row !== undefined && !(row.sendState === "failed" && row.retryAt === null);
  }

  /** 「确认转派」 or 「取消」 on the card that asked (only the recipient's click counts). */
  #forwardClick(push: Push, click: Click): void {
    const asked = click.data.forward === undefined ? undefined : this.#store.forward(click.data.forward);
    if (!asked || asked.pushId !== push.id) { log.info(`推送 ${push.id} 的转派记录不存在，忽略点击`); return; }
    const recipient = this.#store.recipient(push.id, asked.from);
    if (this.#directory.lookup(click.userId)?.phone !== asked.from && click.userId !== recipient?.receiveId) { log.warn(`推送 ${push.id} 的转派确认卡片被别人点击，忽略`); return; }
    if (asked.card !== click.card) this.#store.updateForward(asked.id, { card: click.card });
    const forward = this.#store.forward(asked.id)!;
    if (forward.state !== "pending" || click.data.version !== forward.version) { this.#refreshForward(forward.id); return; }
    const now = this.#now();
    const drop = (why?: string) => {
      this.#store.updateForward(forward.id, { state: "cancelled", decidedAt: now, version: forward.version + 1 });
      if (why && recipient) this.#text(this.#memberTarget(recipient), why);
    };
    const target = this.#directory.byPhone(forward.to);
    if (click.data.action === "keep") drop();
    else if (!recipient || !LIVE_STATES.includes(push.state)) drop(`「${push.subject}」已经结束，没有转给 ${forward.toName}。`);
    else if (!target) drop(`${forward.toName} 已经不在机器人同步的通讯录里，「${push.subject}」没有转出去。`);
    else if (this.#listed(push.id, forward.to)) drop(`${forward.toName} 已经在「${push.subject}」的名单里，没有再转。`);
    else {
      this.#atomic(() => {
        this.#store.updateForward(forward.id, { state: "confirmed", decidedAt: now, version: forward.version + 1 });
        // A card that could not be delivered before is tried afresh.
        if (this.#store.recipient(push.id, forward.to)) this.#store.updateRecipient(push.id, forward.to, { sendState: "pending", sendAttempts: 0, sendError: null, retryAt: null });
        else this.#store.addRecipient(this.#recipientRow(push.id, { ...personReached(target), values: recipient.values }));
        const data = { push: push.id, event: "forward", forward: forward.id };
        this.#note(DIRECT_SCOPE, forward.from, `forward:${forward.id}`, `[推送转派] 已把 ${push.pusherName} 推送的「${quoted(push.subject)}」转给 ${target.name}。推送编号 ${push.id}`, data);
        this.#note(DIRECT_SCOPE, push.pusher, `forwarded:${forward.id}`, `[推送转派] ${recipient.name} 把「${quoted(push.subject)}」转给了 ${target.name}。推送编号 ${push.id}`, data);
        this.#text(this.#pusherTarget(push), `${recipient.name} 把「${push.subject}」转给了 ${target.name}。`);
      });
      log.info(`推送 ${push.id}：一位接收人把推送转给了另一个人`);
      this.#refreshCard(push.id, forward.from);
      this.#refreshPreview(push.id);
      this.#pump();
    }
    this.#refreshForward(forward.id);
  }

  /**
   * The card of a push handed on could not be delivered: it did not get there, so the push is with the one who handed it
   * on again. They are told, and may hand it on once more (to the same person too).
   */
  #forwardUndelivered(push: Push, recipient: Recipient): void {
    const forward = this.#store.forwards(push.id, "confirmed").find(each => each.to === recipient.member);
    const by = forward && this.#store.recipient(push.id, forward.from);
    if (!forward || !by) return;
    this.#store.updateForward(forward.id, { state: "cancelled", decidedAt: this.#now(), version: forward.version + 1 });
    this.#text(this.#memberTarget(by), `转给 ${recipient.name} 的「${push.subject}」没有发出去，这条推送还在你这里：可以再转一次，或者直接找对方。`);
    this.#refreshForward(forward.id);
    this.#refreshCard(push.id, by.member);
    this.#refreshPreview(push.id);
  }

  /** Who handed the push on to this recipient (their row), if anyone did. */
  #forwardedBy(pushId: string, member: string): Recipient | undefined {
    const forward = this.#store.forwards(pushId, "confirmed").find(each => each.to === member);
    return forward && this.#store.recipient(pushId, forward.from);
  }

  // ---- replies (push_reply) and what the conversations are told -------------------------------------------------------

  /** The speaker's row in live pushes: their own in a direct chat, their group's in a group. */
  #memberOf(scope: Scope, phone: string): string {
    return scope.kind === "group" ? groupMember(scope.groupId) : phone;
  }

  /** The live push `id` whose card reached the speaker; refuses with what to tell the member. A push past its deadline ends first. */
  #reachedPush(scope: Scope, phone: string, id: string): { push: Push; recipient: Recipient } {
    const found = this.#store.push(String(id ?? "").trim().toLowerCase());
    const recipient = found && this.#store.recipient(found.id, this.#memberOf(scope, phone));
    if (!found || !recipient || (recipient.sendState !== "sent" && recipient.sendState !== "uncertain") || found.state === "preview") {
      throw new PushRefused(`没有发给${scope.kind === "group" ? "本群" : "这位成员"}的推送 ${String(id ?? "")}；编号见请求末尾“[推送]”一段。`);
    }
    if (this.#closeIfDue(found) || !LIVE_STATES.includes(found.state)) throw new PushRefused(`「${found.subject}」已经结束，不能再改了。`);
    return { push: found, recipient };
  }

  /** Whether live pushes reached the speaker: their conversation then gets the reply tools and the tail (src/server/app.ts). */
  hasLive(scope: Scope, phone: string): boolean {
    return this.#store.reached(this.#memberOf(scope, phone)).length > 0;
  }

  /**
   * The live pushes that reached the speaker, for the tail of the conversation's model requests: what each asks for, what
   * the speaker did so far, and the body of those still waiting for a reply. Undefined when there is none.
   */
  pending(scope: Scope, phone: string): string | undefined {
    const member = this.#memberOf(scope, phone), group = scope.kind === "group", now = this.#now();
    const rows = this.#store.reached(member).map(recipient => ({ recipient, push: this.#store.push(recipient.pushId)! })).filter(({ push }) => now < push.deadline);
    if (!rows.length) return undefined;
    const shown = rows.slice(-this.#limits.pendingShown);
    const lines = shown.map(({ push, recipient }) => {
      const items = this.#store.items(push.id, member);
      const to = this.#store.forwards(push.id, "confirmed").filter(forward => forward.from === member).map(forward => forward.toName);
      const own = group ? items.filter(item => item.sender === phone).length : 0;
      const state = push.mode === "ack" ? (recipient.ackedAt === null ? "还没有确认" : "已确认")
        : push.mode === "options" ? (recipient.choice === null ? "还没有选" : `已选「${push.options[recipient.choice]}」`)
        : !items.length ? "还没有回复"
        : group ? `已回复（共 ${items.length} 段文字，其中这位成员 ${own} 段）` : `已回复（${countsText(countsOf(items))}）`;
      const asks = push.mode === "ack" ? "确认收到（成员在卡片上点「已收到」）" : push.mode === "options" ? `选择 ${push.options.join(" / ")}（成员在卡片上点）`
        : group ? "回复（群里只收文字）" : "回复（文字或附件）";
      return `- 推送编号 ${push.id}：${push.pusherName} ${shortTime(push.confirmedAt ?? push.createdAt, now)} 推送${group ? "到本群" : ""}「${quoted(push.subject)}」，要求${asks}，`
        + `截止 ${shortTime(push.deadline, now)}。${state}${to.length ? `，已转给 ${to.join("、")}` : ""}。`
        + (push.mode === "reply" && !items.length ? `正文（引用）：「${quoted(truncate(oneLine(push.body), 300))}」` : "");
    });
    return [`[推送] ${group ? "本群" : "这位成员"}收到、还没有结束的推送${rows.length > shown.length ? `（共 ${rows.length} 条，这里是最近 ${shown.length} 条）` : ""}：`, ...lines].join("\n");
  }

  /**
   * A direct-chat text of a member (the inbound router asks before admitting it): true only for /登记群, answered with
   * where to send it. A recipient's text is kept for replies recorded from it later. Synchronous: call it in arrival order.
   */
  directText(identity: DirectoryIdentity, reply: ReplyContext, text: string): boolean {
    const command = isSlashCommandMessage(text) ? canonicalCommand(text) : undefined;
    if (command === "/登记群") { this.#notice(reply, "请在要登记的群里发送“@机器人 /登记群 群名”。"); return true; }
    if (command === undefined) this.#hear(identity.phone, identity.phone, reply, text);
    return false;
  }

  /**
   * A group text that @-mentions the bot (the inbound router asks before admitting it): the group is known from it. True
   * only for /登记群. Otherwise the member's group conversation learns of the group's live pushes first, and the text is
   * kept for replies recorded from it. Synchronous: call it in arrival order.
   */
  groupText(groupId: string, identity: DirectoryIdentity, reply: ReplyContext, text: string): boolean {
    this.#groupSeen(groupId);
    const command = isSlashCommandMessage(text) ? canonicalCommand(text) : undefined;
    if (command === "/登记群") { this.#registerCommand(groupId, identity, reply, text); return true; }
    this.#groupNotes(groupId, identity.phone);
    if (command === undefined) this.#hear(groupMember(groupId), identity.phone, reply, text);
    return false;
  }

  /** Keep the text while a push waits for replies there. */
  #hear(member: string, sender: string, reply: ReplyContext, text: string): void {
    if (!this.#store.reached(member).some(recipient => this.#store.push(recipient.pushId)!.mode === "reply")) return;
    this.#store.hear({ msgUid: reply.msgUid, member, sender, text, receivedAt: reply.receivedAt }, this.#limits.heardKeep);
  }

  /**
   * What a member is asked when an attachment arrives in the direct chat while pushes wait for their reply: it may be one.
   * Undefined otherwise (the message service asks as always).
   */
  attachmentAsk(phone: string): string | undefined {
    const now = this.#now();
    const waiting = this.#store.awaitingReply(phone).map(recipient => this.#store.push(recipient.pushId)!).filter(push => now < push.deadline);
    if (!waiting.length) return undefined;
    return waiting.length === 1 ? `是回复「${waiting[0]!.subject}」的话说一声，我记进去；要我处理别的也直接说。`
      : "是回复推送的话告诉我是哪一条，我记进去；要我处理别的也直接说。";
  }

  /**
   * Record a reply, or change one (push_reply): the speaker's message as it was sent, never the model's wording of it.
   * In a group the reply is the group's and each text keeps its sender; a member replaces or withdraws only their own.
   * The model's answer.
   */
  async reply(speaker: Speaker, input: ReplyInput): Promise<string> {
    const { push, recipient } = this.#reachedPush(speaker.scope, speaker.phone, input.push);
    const group = memberGroup(recipient.member) !== undefined;
    if (push.mode !== "reply") throw new PushRefused(`「${push.subject}」不收回复：它要的是${requirementText(push)}，由成员在卡片上点。`);
    if (input.action === "withdraw") return this.#withdraw(push, recipient, speaker.phone);
    if (input.action !== "add" && input.action !== "replace") throw new PushRefused("action 必须是 add、replace 或 withdraw。");
    const source = this.#source(speaker, recipient.member, input.quote);
    // A group takes texts only; the attachments of a direct message are the ones its request bound.
    const files = group ? [] : await this.#boundFiles(speaker.phone, source.msgUid);
    const recorded = this.#atomic(() => this.#record(push.id, recipient.member, speaker.phone, source, files, input.action === "replace"));
    await this.#hold(push.id, recipient.member, recorded.held);
    this.#refreshCard(push.id, recipient.member);
    this.#checkComplete(push.id);
    log.info(`推送 ${push.id}：${group ? "一个群" : "一位接收人"}${recorded.already ? "的回复没有变化" : input.action === "replace" ? "改了回复" : "回复了"}`);
    const total = group ? `本群的回复现在共 ${recorded.counts.texts} 段文字` : `回复现在共有${countsText(recorded.counts)}`;
    return (recorded.already ? `这条消息已经在「${push.subject}」的回复里了，没有重复记。` : `已把成员的这条消息${input.action === "replace" ? "记为" : "记入"} ${push.pusherName} 推送的「${push.subject}」的回复`
      + `${input.action === "replace" ? (group ? "，这位成员之前发的不算了" : "，之前记的不算了") : ""}。`)
      + `${total}。`
      + (recorded.lost.length ? `这些附件没有收到，没有记进去，请成员重发：${recorded.lost.join("、")}。` : "");
  }

  /** The message a reply is recorded from: the request's, or the speaker's latest kept text that contains `quote`. */
  #source(speaker: Speaker, member: string, quote: string | undefined): Speaker["message"] {
    const wanted = compactName(quote ?? "");
    if (!wanted) return speaker.message;
    const found = this.#store.heard(member, speaker.phone).find(heard => compactName(heard.text).includes(wanted));
    if (!found) throw new PushRefused("在这位成员最近的消息里没有找到这段话。quote 要照抄成员那条消息里的原话，一小段就够；实在找不到，请成员把回复内容再发一遍。");
    return { msgUid: found.msgUid, text: found.text, receivedAt: found.receivedAt };
  }

  /** The attachments the request of message `msgUid` bound, in arrival order. */
  async #boundFiles(phone: string, msgUid: string): Promise<Attachment[]> {
    const records = await this.#host!.records(DIRECT_SCOPE, phone);
    const request = Object.values(records.requests).find(record => record.reply.msgUid === msgUid);
    if (!request) return [];
    return Object.values(records.attachments).filter(attachment => attachment.boundTo === request.requestId && attachment.state !== "void")
      .sort((a, b) => a.epoch - b.epoch || a.receivedAt - b.receivedAt);
  }

  /**
   * In one transaction: the message's text and files become items of the reply (`replace`: instead of what the sender
   * had there). A message is part of one reply only. `held`: the attachments to hold for the push; `lost`: files that
   * did not arrive.
   */
  #record(pushId: string, member: string, sender: string, source: Speaker["message"], files: readonly Attachment[], replace: boolean):
    { already: boolean; counts: Counts; held: string[]; lost: string[] } {
    const push = this.#store.push(pushId), recipient = this.#store.recipient(pushId, member);
    if (!push || !recipient || !LIVE_STATES.includes(push.state)) throw new PushRefused(`「${push?.subject ?? pushId}」已经结束，不能再改了。`);
    const group = memberGroup(member) !== undefined, now = this.#now();
    const current = this.#store.items(pushId, member);
    const arrived = files.filter(file => file.state === "ready" || file.state === "pending");
    const lost = files.filter(file => !arrived.includes(file)).map(file => file.name);
    if (!source.text.trim() && !arrived.length) throw new PushRefused("这条消息没有可以记的内容。");
    const uids = [source.msgUid, ...arrived.map(file => file.msgUid)];
    for (const uid of uids) {
      const existing = this.#store.itemOf(uid);
      if (!existing || current.some(item => item.id === existing.id)) continue;
      throw new PushRefused(`这条消息已经记在「${this.#store.push(existing.pushId)?.subject ?? existing.pushId}」的回复里；一条消息只记到一条推送，要改记先把那边的撤回，或者请成员再发一遍。`);
    }
    const have = new Set(current.map(item => item.msgUid));
    const already = uids.every(uid => have.has(uid) || (uid === source.msgUid && !source.text.trim()));
    if (replace) {
      const dropped = current.filter(item => (group ? item.sender === sender : true) && !uids.includes(item.msgUid));
      this.#store.removeItems(dropped.map(item => item.id));
      this.#release(pushId, member, dropped);
    } else if (already) {
      return { already, counts: countsOf(current), held: [], lost };
    }
    const name = group ? this.#directory.byPhone(sender)?.name ?? sender : null;
    if (source.text.trim() && !have.has(source.msgUid)) {
      this.#store.addItem({ pushId, member, msgUid: source.msgUid, kind: "text", text: source.text, attachment: null, name: null, size: null,
        receivedAt: source.receivedAt, sender: group ? sender : null, senderName: name });
    }
    for (const file of arrived) {
      if (have.has(file.msgUid)) continue;
      this.#store.addItem({ pushId, member, msgUid: file.msgUid, kind: file.kind, text: null, attachment: file.id, name: file.name, size: file.actualSize ?? file.size ?? null,
        receivedAt: file.receivedAt, sender: null, senderName: null });
    }
    this.#store.updateRecipient(pushId, member, { repliedAt: now, ackedAt: recipient.ackedAt ?? now, version: recipient.version + 1 });
    const after = this.#store.items(pushId, member);
    return { already: already && !replace, counts: countsOf(after), held: arrived.map(file => file.id), lost };
  }

  /** The reply's attachments stay with the push until its summary went out (again at startup, should a process end before this). */
  async #hold(pushId: string, member: string, ids: readonly string[]): Promise<void> {
    if (!ids.length || memberGroup(member) !== undefined) return;
    try { await this.#host!.holdAttachments(DIRECT_SCOPE, member, holderOf(pushId), ids); }
    catch (error) { if (!this.#signal.aborted) this.#report(error); }
  }

  /** At startup: the attachments of the replies to live pushes are held (a process may have ended between the record and the hold). */
  async #holdReplies(): Promise<void> {
    if (!this.#host) return;
    for (const push of this.#store.pushesIn(LIVE_STATES)) {
      const items = this.#store.items(push.id).filter(item => item.attachment !== null);
      for (const member of new Set(items.map(item => item.member))) {
        await this.#hold(push.id, member, items.flatMap(item => item.member === member ? [item.attachment!] : []));
      }
    }
  }

  /** Drop the reply: a person's whole reply, in a group what this member sent. */
  #withdraw(push: Push, asked: Recipient, sender: string): string {
    const group = memberGroup(asked.member) !== undefined;
    const left = this.#atomic(() => {
      const recipient = this.#store.recipient(push.id, asked.member)!;
      const current = this.#store.items(push.id, asked.member);
      const own = group ? current.filter(item => item.sender === sender) : current;
      if (!own.length) return undefined;
      this.#store.removeItems(own.map(item => item.id));
      this.#release(push.id, asked.member, own);
      const rest = current.length - own.length;
      this.#store.updateRecipient(push.id, asked.member, { repliedAt: rest ? this.#now() : null, version: recipient.version + 1 });
      return rest;
    });
    if (left === undefined) return group ? `这位成员在本群没有给「${push.subject}」记过回复，没有可以撤回的。` : `「${push.subject}」还没有记过回复，没有可以撤回的。`;
    this.#refreshCard(push.id, asked.member);
    log.info(`推送 ${push.id}：${group ? "一个群里有人" : "一位接收人"}撤回了回复`);
    return group ? `已撤回这位成员在「${push.subject}」里发的回复${left ? `，群里其他人发的 ${left} 段还在` : "，本群现在没有回复"}。`
      : `已撤回「${push.subject}」的回复，现在是没有回复。`;
  }

  /**
   * A request ended without an answer (the model failed or ran out of time; src/durable/service.ts asks before it tells
   * the member): with exactly one push waiting for the speaker's reply the message is recorded as that reply, so an outage
   * of the model loses none. Returns the line that tells the member, or undefined when no push waits.
   */
  async failed(speaker: Speaker): Promise<string | undefined> {
    const group = speaker.scope.kind === "group", member = this.#memberOf(speaker.scope, speaker.phone), now = this.#now();
    const existing = this.#store.itemOf(speaker.message.msgUid), recorded = existing && this.#store.push(existing.pushId);
    if (recorded) return `这条消息已经记进「${recorded.subject}」的回复了，不用重发。`;
    const waiting = this.#store.awaitingReply(member).map(recipient => this.#store.push(recipient.pushId)!).filter(push => now < push.deadline);
    if (!waiting.length) return undefined;
    if (waiting.length > 1) {
      return `${group ? "本群" : "你"}有 ${waiting.length} 条推送等着回复（${waiting.slice(0, 5).map(push => `「${push.subject}」`).join("、")}${waiting.length > 5 ? " 等" : ""}），`
        + "这条消息没有记进去；是回复的话，请过一会儿再发一次。";
    }
    const push = waiting[0]!;
    try {
      const files = group ? [] : await this.#boundFiles(speaker.phone, speaker.message.msgUid);
      const done = this.#atomic(() => {
        const result = this.#record(push.id, member, speaker.phone, speaker.message, files, false);
        this.#note(speaker.scope, speaker.phone, `reply:${push.id}:${speaker.message.msgUid}`, `[推送回复] 上面那条没有答上来的消息，系统已经记为${group ? "本群" : ""}对 ${push.pusherName} 推送的`
          + `「${quoted(push.subject)}」的回复。推送编号 ${push.id}`, { push: push.id, event: "reply" });
        return result;
      });
      await this.#hold(push.id, member, done.held);
      this.#refreshCard(push.id, member);
      this.#checkComplete(push.id);
      log.info(`推送 ${push.id}：模型没有答上来的一条消息记为回复`);
      return `这条消息我先记进「${push.subject}」的回复了；不是回复的话，回头跟我说一声“撤回”。`;
    } catch (error) {
      if (!(error instanceof PushRefused) && !this.#signal.aborted) this.#report(error);
      return undefined;
    }
  }

  /** The group's live pushes, noted once in this member's group conversation (they may not have seen the card). */
  #groupNotes(groupId: string, phone: string): void {
    for (const recipient of this.#store.reached(groupMember(groupId))) {
      const key = `${recipient.pushId}|${groupId}|${phone}`, push = this.#store.push(recipient.pushId)!;
      if (this.#groupNoted.has(key) || this.#now() >= push.deadline) continue;
      if (this.#groupNoted.size >= 20_000) this.#groupNoted.delete(this.#groupNoted.values().next().value!);
      this.#groupNoted.add(key);
      this.#cardNote(push, groupScope(groupId), phone);
    }
  }

  /**
   * The note of a card: in a recipient's direct conversation when it is sent, in a group member's when they next speak.
   * The body is another person's text entering this member's conversation as a user message, so it is marked as a
   * quotation (the system prompt says quoted push text is no instruction) and cannot close the marks itself.
   */
  #cardNote(push: Push, scope: Scope, phone: string): void {
    const now = this.#now(), group = scope.kind === "group";
    const by = group ? undefined : this.#forwardedBy(push.id, phone);
    this.#note(scope, phone, `card:${push.id}`, `[推送] ${push.pusherName} ${shortTime(push.confirmedAt ?? now, now)} 推送${group ? "到本群" : ""}「${quoted(push.subject)}」`
      + `${by ? `（${by.name} 转来）` : ""}，正文（引用）：`
      + `「${quoted(truncate(oneLine(push.body), 500))}」${chars(push.body) > 500 ? "（全文见卡片）" : ""}${filesNote(push, group ? "本群" : "成员")}${valuesNote(push, group ? [] : this.#store.recipient(push.id, phone)?.values ?? [], by ? `给 ${by.name} 的内容` : "给这位成员的内容")}；要求：${group && push.mode === "reply" ? "需要回复（群里只收文字）" : requirementText(push)}；`
      + `截止 ${shortTime(push.deadline, now)}。推送编号 ${push.id}`,
    { push: push.id, event: "card" });
  }

  // ---- background: sends, deadlines, summaries, notes -----------------------------------------------------------------

  /** One maintenance pass (also on a timer): due sends, expired previews, deadlines, replies all in, notes, summaries. */
  tick(): void {
    if (this.#closing || this.#ticking) return;
    this.#ticking = true;
    try {
      const now = this.#now();
      for (const push of this.#store.pushesIn(["preview"])) {
        if (now - push.createdAt >= this.#limits.previewMs && this.#store.movePush(push.id, ["preview"], { state: "expired", previewVersion: push.previewVersion + 1 })) {
          this.#previewSettled(push.id);
        }
      }
      for (const push of this.#store.pushesIn(LIVE_STATES)) {
        if (now >= push.deadline) { this.#close(push.id, "deadline"); continue; }
        if (push.state === "open" && push.checkpoints.length && push.checkpoints[0]! <= now && !quietHours(now)) this.#lookIn(push);
        // Everyone replied a while ago and nobody added anything since.
        if (push.mode === "reply") this.#checkComplete(push.id);
      }
      this.#store.forgetHeard(now - this.#limits.heardMs);
      this.#sweepFiles();
      this.#pump();
      this.#track(this.#drainNotes());
      for (const push of this.#store.summariesDue()) this.#track(this.#summarize(push.id));
      for (const push of this.#store.unreleased()) this.#track(this.#releasePush(push.id));
    } catch (error) { this.#report(error); }
    finally { this.#ticking = false; }
  }

  /** Send the cards that are due; one pump at a time. */
  #pump(): void {
    if (this.#closing) return;
    if (this.#pumping) { this.#pumpAgain = true; return; }
    this.#pumping = true;
    this.#track((async () => {
      try {
        do {
          this.#pumpAgain = false;
          const due = this.#store.sendsDue(this.#now());
          let next = 0;
          await Promise.all(Array.from({ length: Math.min(this.#limits.concurrency, due.length) }, async () => {
            while (next < due.length && !this.#closing) await this.#send(due[next++]!);
          }));
          for (const push of this.#store.pushesIn(["sending"])) this.#settleSending(push.id);
          for (const pushId of new Set(due.map(recipient => recipient.pushId))) if (this.#progressAt.delete(pushId)) this.#refreshPreview(pushId);
          // A retry that reached someone late may complete an open push.
          for (const pushId of new Set(due.map(recipient => recipient.pushId))) this.#checkComplete(pushId);
        } while (this.#pumpAgain && !this.#closing);
      } finally { this.#pumping = false; }
    })());
  }

  async #send(due: Recipient): Promise<void> {
    const push = this.#store.push(due.pushId);
    const recipient = this.#store.recipient(due.pushId, due.member);
    if (!push || !recipient || !LIVE_STATES.includes(push.state) || (recipient.sendState !== "pending" && recipient.sendState !== "failed")) return;
    // Past the deadline no card goes out: the push ends, its cards not sent yet count as failed.
    if (this.#closeIfDue(push)) return;
    const attempts = recipient.sendAttempts + 1;
    this.#store.updateRecipient(push.id, recipient.member, { sendState: "sending", sendAttempts: attempts, retryAt: null });
    let outcome: SendOutcome;
    try {
      // The files first: a card that went out means they did.
      outcome = await this.#sendFiles(push, recipient)
        ?? await this.#outbound.send(this.#memberTarget(recipient), cardMessage(this.#recipientCard(push.id, recipient.member)!), { signal: this.#signal });
    } catch (error) { outcome = { status: "failed" as const, reason: String(error) }; }
    // The summary stopped waiting and reported this card as unknown: what it said stays true.
    if (this.#store.recipient(push.id, recipient.member)?.sendState !== "sending") return;
    // The push may have ended during the send: no further try, and its summary may be waiting for this result.
    const live = LIVE_STATES.includes(this.#store.push(push.id)!.state);
    if (outcome.status === "failed" && this.#signal.aborted) {
      // Never dispatched: the next start sends it, while the push is still on.
      this.#store.updateRecipient(push.id, recipient.member, live ? { sendState: "pending", sendAttempts: recipient.sendAttempts } : { sendState: "failed", sendError: "截止前没有发出" });
      return;
    }
    const now = this.#now();
    if (outcome.status === "failed") {
      const retry = live && attempts < this.#limits.sendAttempts ? now + (this.#limits.sendRetryMs[attempts - 1] ?? this.#limits.sendRetryMs.at(-1)!) : null;
      this.#store.updateRecipient(push.id, recipient.member, { sendState: "failed", sendError: outcome.reason, retryAt: retry });
      if (retry === null) {
        log.warn(`推送 ${push.id}：一张卡片发送失败（已试 ${attempts} 次）：${outcome.reason}`);
        this.#forwardUndelivered(push, recipient);
      }
    } else {
      this.#store.updateRecipient(push.id, recipient.member, { sendState: outcome.status, sentAt: now, sendError: outcome.status === "uncertain" ? outcome.reason : null });
      // A group's members get the note when they next @-mention the bot (#groupNotes).
      if (memberGroup(recipient.member) === undefined) this.#cardNote(push, DIRECT_SCOPE, recipient.member);
    }
    this.#progress(push.id);
    if (!live) this.#settled(push.id);
  }

  /**
   * The push's files this recipient does not have yet, in order, as file messages. Undefined once all are out (an
   * uncertain send counts as out, as for cards); else the failure, which is the card's: the next try goes on with that
   * file. Stops when the push ended or the summary stopped waiting for this send.
   */
  async #sendFiles(push: Push, recipient: Recipient): Promise<SendOutcome | undefined> {
    for (let index = recipient.filesSent; index < push.files.length; index++) {
      const file = push.files[index]!, key = `${push.id}/${index}`;
      const upload = this.#fileId(push, index, key);
      let outcome: SendOutcome;
      try {
        const fileId = await upload;
        this.#signal.throwIfAborted();
        outcome = await this.#outbound.send(this.#memberTarget(recipient), uploadedFile(fileId, file), { signal: this.#signal });
      } catch (error) { outcome = { status: "failed", reason: error instanceof Error ? error.message : String(error) }; }
      if (outcome.status === "failed") {
        // The platform may no longer have the uploaded file: the next try uploads it again.
        if (this.#fileIds.get(key)?.id === upload) this.#fileIds.delete(key);
        return { status: "failed", reason: `附件「${file.name}」没有发出：${outcome.reason}` };
      }
      if (this.#store.recipient(push.id, recipient.member)?.sendState !== "sending") return { status: "failed", reason: "截止后一直没有得到发送结果" };
      this.#store.updateRecipient(push.id, recipient.member, { filesSent: index + 1 });
      if (!LIVE_STATES.includes(this.#store.push(push.id)?.state ?? "closed")) {
        // Ended after this recipient's last file: the files arrived, the card is what did not go.
        return { status: "failed", reason: index + 1 < push.files.length ? "截止前没有发完附件" : "附件已发出，卡片没有赶在截止前发出" };
      }
    }
    return undefined;
  }

  /** The platform's ID of a push file: uploaded once, then used for every recipient until `fileIdMs` passed. */
  #fileId(push: Push, index: number, key: string): Promise<string> {
    const now = this.#now(), known = this.#fileIds.get(key);
    if (known && now - known.at < this.#limits.fileIdMs) return known.id;
    const file = push.files[index]!;
    const id = this.#outbound.upload(fileUpload({ path: pushFile(this.options.layout, push.id, index), name: file.name, size: file.size }), this.#signal);
    this.#fileIds.set(key, { id, at: now });
    // A failed upload is not kept; whoever waits for it gets the failure.
    id.catch(() => { if (this.#fileIds.get(key)?.id === id) this.#fileIds.delete(key); });
    return id;
  }

  /** The preview card's sending progress, at most every `progressMs`: a large push spends its sends on the cards. */
  #progress(pushId: string): void {
    const now = this.#now(), last = this.#progressAt.get(pushId);
    if (last !== undefined && now - last < this.#limits.progressMs) return;
    this.#progressAt.set(pushId, now);
    this.#refreshPreview(pushId);
  }

  /** A sending push with no card left pending is open; the pusher's note records what went out. */
  #settleSending(pushId: string): void {
    const recipients = this.#store.recipients(pushId);
    if (recipients.some(recipient => recipient.sendState === "pending" || recipient.sendState === "sending")) return;
    if (!this.#store.movePush(pushId, ["sending"], { state: "open" })) return;
    this.#progressAt.delete(pushId);
    const push = this.#store.push(pushId)!;
    const failed = recipients.filter(recipient => recipient.sendState === "failed").length;
    log.info(`推送 ${pushId} 已发出：${recipients.length - failed} 张，失败 ${failed} 张`);
    const cc = push.cc.length ? `，抄送 ${push.cc.map(person => person.name).join("、")}` : "";
    this.#note(DIRECT_SCOPE, push.pusher, `sent:${pushId}`, `[推送已发出]「${quoted(push.subject)}」${shortTime(push.confirmedAt!, this.#now())} 发出，`
      + `共 ${reachText(reachOf(recipients))}${failed ? `（发送失败 ${failed} 个）` : ""}${cc}${filesNote(push)}${push.fields.length ? `；每人不同的内容：${push.fields.map(quoted).join("、")}` : ""}；要求：${requirementText(push)}；截止 ${shortTime(push.deadline, this.#now())}。推送编号 ${pushId}`,
    { push: pushId, event: "sent" });
    this.#refreshPreview(pushId);
    this.#checkComplete(pushId);
  }

  /**
   * Everyone the card reached has answered or handed it on (and no card is still to go): close early. A push asking for
   * replies waits until nobody added to a reply for `replyGraceMs` (the timer comes back to it): a reply may come in
   * several messages, and the first one already counts.
   */
  #checkComplete(pushId: string): void {
    const push = this.#store.push(pushId);
    if (push?.state !== "open") return;
    const counts = this.#store.recipientCounts([pushId]).get(pushId);
    if (!counts || counts.unsettled || !counts.delivered || counts.answered !== counts.delivered) return;
    if (push.mode === "reply" && counts.repliedAt !== null && this.#now() - counts.repliedAt < this.#limits.replyGraceMs) return;
    this.#close(pushId, "complete");
  }

  /** A live push past its deadline closes now, before the input at hand is handled (the timer may not have seen it yet). True when it did. */
  #closeIfDue(push: Push): boolean {
    if (!LIVE_STATES.includes(push.state) || this.#now() < push.deadline) return false;
    this.#close(push.id, "deadline");
    return true;
  }

  /** Close a live push: the cards show the end, what was still asked is not handed on, the summary is due. */
  #close(pushId: string, reason: "deadline" | "complete"): void {
    // One transaction for the whole list (5000 rows at most): a commit per row is a disk sync each, on the thread that
    // answers messages. What it sends starts after the commit.
    this.#atomic(() => {
      const push = this.#store.push(pushId);
      if (!push || !LIVE_STATES.includes(push.state)) return;
      for (const recipient of this.#store.recipients(pushId)) {
        if (recipient.sendState === "pending" || (recipient.sendState === "failed" && recipient.retryAt !== null)) {
          this.#store.updateRecipient(pushId, recipient.member, { sendState: "failed", retryAt: null, sendError: recipient.sendError ?? "截止前没有发出" });
        }
      }
      if (!this.#store.movePush(pushId, LIVE_STATES, { state: "closed", closedAt: this.#now(), closeReason: reason, summaryState: "pending" })) return;
      log.info(`推送 ${pushId} 已${reason === "deadline" ? "截止" : "全部答复，提前结束"}`);
      this.#store.bumpVersions(pushId);
      this.#store.cancelForwards(pushId, this.#now());
      // Only a card someone clicked has a known ID to update.
      for (const recipient of this.#store.recipients(pushId)) if (recipient.card) this.#refreshCard(pushId, recipient.member);
      this.#refreshPreview(pushId);
      this.#effect(() => this.#track(this.#summarize(pushId)));
    });
  }

  /** While `#atomic` runs: what its work sends, to start once the transaction has committed. */
  #after: (() => void)[] | null = null;

  /**
   * Run `work` in one transaction. The texts, notices, card updates, attachment releases and note deliveries it asks for
   * start after the commit, and not at all when it fails: nothing goes out for a change that was rolled back.
   */
  #atomic<T>(work: () => T): T {
    if (this.#after) return work();
    const after: (() => void)[] = [];
    this.#after = after;
    let result: T;
    try { result = this.#store.transaction(work); }
    finally { this.#after = null; }
    for (const run of after) run();
    return result;
  }

  #effect(run: () => void): void {
    if (this.#after) this.#after.push(run);
    else run();
  }

  /**
   * Build and send the summary to the pusher and the CCs, once the cards still being sent have their result and the reply
   * attachments are downloaded (or `settleWaitMs` after the end: the summary says what is unknown
   * or missing). One person's failure holds nobody else back; a retry sends only what did not go out.
   */
  async #summarize(pushId: string): Promise<void> {
    const key = `summary:${pushId}`;
    if (this.#refreshing.has(key) || this.#closing) return;
    const push = this.#store.push(pushId);
    if (push?.summaryState !== "pending" || (push.summaryAt !== null && push.summaryAt > this.#now())) return;
    this.#refreshing.set(key, { again: false });
    const dir = join(userTmp(this.options.layout, DIRECT_SCOPE, push.pusher), `push-${push.id}`);
    try {
      const items = this.#store.items(pushId);
      const files = push.mode === "reply" ? await this.#heldFiles(pushId, items) : new Map<string, HeldFile>();
      // Read after the await, so a send that ended during it is in them.
      const current = this.#store.recipients(pushId);
      // Waiting: a send or a registration that ends, or the timer, tries again.
      if (this.#now() - (push.closedAt ?? 0) < this.#limits.settleWaitMs
        && current.some(recipient => recipient.sendState === "sending" || replyItems(recipient, items).some(item => unsettled(item, files)))) return;
      // A card still without a result is unknown for good (#send leaves it so), then the counts below cannot change.
      this.#store.transaction(() => {
        for (const recipient of current) if (recipient.sendState === "sending") this.#store.updateRecipient(pushId, recipient.member, { sendState: "uncertain", sendError: "截止后一直没有得到发送结果" });
      });
      const recipients = this.#store.recipients(pushId);
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const forwards = this.#store.forwards(pushId, "confirmed"), handed = new Set(forwards.map(forward => forward.from));
      const partBytes = this.options.relay?.maxBytes ?? NATIVE_FILE_MAX_BYTES;
      const pack = await buildSummary({ push, recipients, items, forwards, files, dir, partBytes, bare: true, split: true, now: this.#now(), signal: this.#signal });
      const tally = this.#tally(push, recipients);
      const missing = recipients.filter(recipient => (recipient.sendState === "sent" || recipient.sendState === "uncertain") && !this.#answered(push, recipient, handed))
        .map(recipient => memberGroup(recipient.member) === undefined ? recipient.name : `群 ${recipient.name}`);
      const unknown = recipients.filter(recipient => recipient.sendState === "uncertain").length;
      const lines = [`推送「${push.subject}」${push.closeReason === "complete" ? "已全部答复" : "已截止"}（推送编号 ${push.id}）`, tally,
        ...(unknown ? [`有 ${unknown} 张卡片发送结果未知，按已发出统计`] : []),
        ...(missing.length ? [`${push.mode === "reply" ? "未回复" : push.mode === "ack" ? "未确认" : "未选择"}：${missing.slice(0, 30).join("、")}${missing.length > 30 ? ` 等 ${missing.length} 个` : ""}`] : []),
        ...(pack.missingFiles ? [`有 ${pack.missingFiles} 个附件没能打包（原因见汇总表）`] : []),
        ...(pack.splitFiles ? [`有 ${pack.splitFiles} 个附件超过单个文件 ${formatSize(partBytes)} 的发送上限，分段放在几个压缩包里（文件名以 .001、.002 结尾）：`
          + "把全部压缩包解压到同一个文件夹后合并，方法写在那个人文件夹的“回复.txt”里；也可以请管理员在控制台下载完整的汇总包"] : []),
        pack.bare ? "汇总表见下面的文件。" : pack.parts.length > 1 ? `汇总表和回复内容分成 ${pack.parts.length} 个压缩包，见下面。` : "汇总表和回复内容见下面的压缩包。"];
      this.#store.updatePush(pushId, { summaryText: lines.join("\n") });
      const failures: { name: string; reason: string }[] = [];
      for (const person of [{ phone: push.pusher, name: push.pusherName, im: push.pusherIm }, ...push.cc.map(cc => ({ ...cc, im: this.#directory.byPhone(cc.phone)?.imUserId }))]) {
        if (push.summaryDone.includes(person.phone)) continue;
        if (!person.im) { log.warn(`推送 ${push.id}：一位抄送人已不在同步的通讯录里，没有给这位抄送人发汇总`); continue; }
        const cc = person.phone !== push.pusher;
        try {
          // The pusher's summary is a card (its 「提醒未回复」 button); the CCs get text.
          await this.#sendSummary(pushId, person.phone, { kind: "direct", receiveId: person.im }, cc ? { text: `${push.pusherName} 推送的汇总抄送给你：\n${lines.join("\n")}` }
            : { card: this.#summaryCard(this.#store.push(pushId)!) }, pack, dir);
        } catch (error) {
          if (this.#signal.aborted) throw error;
          failures.push({ name: person.name, reason: error instanceof Error ? error.message : String(error) });
          continue;
        }
        this.#store.updatePush(pushId, { summaryDone: [...this.#store.push(pushId)!.summaryDone.filter(done => !done.startsWith(`${person.phone}|`)), person.phone] });
        this.#note(DIRECT_SCOPE, person.phone, `summary:${push.id}`, cc
          ? `[推送汇总抄送] ${push.pusherName} 推送的「${quoted(push.subject)}」：${tally}，${pack.bare ? "汇总表" : "汇总包"}已发出。推送编号 ${push.id}`
          : `[推送汇总]「${quoted(push.subject)}」：${tally}，${pack.bare ? "汇总表" : "汇总包"}已发出。推送编号 ${push.id}`, { push: push.id, event: cc ? "summary-cc" : "summary" });
      }
      if (failures.length) {
        // The log names no one.
        this.#summaryFailed(push, failures.map(({ name, reason }) => `${name}：${reason}`).join("；"), `${failures.length} 人没有发出，${failures[0]!.reason}`);
        return;
      }
      this.#store.updatePush(pushId, { summaryState: "sent", summaryAt: this.#now(), summaryError: null });
      log.info(`推送 ${pushId} 的汇总已发出`);
      this.#track(this.#releasePush(pushId));
    } catch (error) {
      if (this.#signal.aborted) return;
      this.#summaryFailed(push, String(error), String(error));
    } finally {
      this.#refreshing.delete(key);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Another try after this attempt's delay, or the last one was. */
  #summaryFailed(push: Push, reason: string, logged: string): void {
    const attempts = push.summaryAttempts + 1, delay = this.#limits.summaryRetryMs[attempts - 1];
    this.#store.updatePush(push.id, delay === undefined
      ? { summaryState: "failed", summaryAttempts: attempts, summaryError: reason, summaryAt: this.#now() }
      : { summaryAttempts: attempts, summaryError: reason, summaryAt: this.#now() + delay });
    log.warn(`推送 ${push.id} 的汇总没有发出（第 ${attempts} 次）：${logged}`);
  }

  /**
   * One person's summary: the message and the workbook or the archives (each by link when above the native size; only a relay allows
   * that). What went out is recorded under `<phone>|<step>`, so a retry sends the rest. An uncertain send counts as sent,
   * as for cards; a process that ends between a send and its record sends that step again.
   */
  async #sendSummary(pushId: string, phone: string, target: Target, message: { text: string } | { card: CardContent }, pack: SummaryPackage, dir: string): Promise<void> {
    const step = async (name: string, send: () => Promise<void>) => {
      const done = `${phone}|${name}`;
      if (this.#store.push(pushId)!.summaryDone.includes(done)) return;
      await send();
      this.#store.updatePush(pushId, { summaryDone: [...this.#store.push(pushId)!.summaryDone, done] });
    };
    const messages = "card" in message ? [cardMessage(message.card)] : splitText(message.text).map(textMessage);
    for (const [index, each] of messages.entries()) {
      await step(`message-${index}`, async () => {
        const outcome = await this.#outbound.send(target, each, { signal: this.#signal });
        if (outcome.status === "failed") throw new Error(`汇总消息没有发出：${outcome.reason}`);
      });
    }
    const reply: ReplyContext = { kind: "direct", receiveId: target.receiveId, senderImUserId: target.receiveId, msgUid: "", summary: "", receivedAt: this.#now() };
    const options = { channel: sendChannel(this.#outbound, reply), relay: this.options.relay, tempDir: dir };
    for (const part of pack.parts) {
      await step(part.name, async () => {
        let transfer;
        try { transfer = await transferFile({ kind: "local", path: part.path, size: part.size }, part.name, options, this.#signal); }
        catch (error) {
          if (!(error instanceof SendNotConfirmed && error.uncertain)) throw error;
          log.warn(`推送 ${pushId} 的一个汇总包发送结果不确定，按已发出处理`);
          return;
        }
        if (transfer.mode === "relay") {
          const outcome = await this.#outbound.send(target, textMessage(transfer.note), { signal: this.#signal });
          if (outcome.status === "failed") throw new Error(`汇总外链没有发出：${outcome.reason}`);
        }
      });
    }
  }

  /**
   * Release the held attachments of a push whose summary is done (sent or given up). A reply's file still downloading
   * stays held until the download ends, so where it is gets kept: the push counts as released only once none is left
   * (the timer tries again).
   */
  async #releasePush(pushId: string): Promise<void> {
    const key = `release:${pushId}`;
    if (this.#refreshing.has(key)) return;
    this.#refreshing.set(key, { again: false });
    try {
      const items = this.#store.items(pushId).filter(item => item.kind !== "text");
      const files = await this.#heldFiles(pushId, items);
      // The records go; where the files are stays with the items, for the console's downloads until the tmp cleanup takes them.
      const byMember = new Map<string, string[]>();
      let waiting = false;
      for (const item of items) {
        const file = item.attachment ? files.get(item.attachment) : undefined;
        if (unsettled(item, files)) { waiting = true; continue; }
        if (!file) continue;
        if (file.state === "ready" && file.path && item.path !== file.path) this.#store.keepItemPath(item.id, file.path);
        byMember.set(item.member, [...byMember.get(item.member) ?? [], item.attachment!]);
      }
      for (const [member, ids] of byMember) await this.#host!.releaseAttachments(DIRECT_SCOPE, member, holderOf(pushId), ids);
      if (!waiting) this.#store.updatePush(pushId, { released: true });
    } catch (error) { if (!this.#signal.aborted) this.#report(error); }
    finally { this.#refreshing.delete(key); }
  }

  /** A card's send ended: a closed push's summary may be waiting for it. */
  #settled(pushId: string): void {
    const push = this.#store.push(pushId);
    if (this.#closing || push?.state !== "closed") return;
    if (push.summaryState === "pending") this.#track(this.#summarize(pushId));
    else if (!push.released) this.#track(this.#releasePush(pushId));
  }

  /** Release the attachments of replaced or withdrawn items now (best effort). */
  #release(pushId: string, member: string, items: readonly ReplyItem[]): void {
    const ids = items.flatMap(item => item.attachment ? [item.attachment] : []);
    if (!ids.length || !this.#host) return;
    const host = this.#host;
    this.#effect(() => this.#track(host.releaseAttachments(DIRECT_SCOPE, member, holderOf(pushId), ids).catch(error => { if (!this.#signal.aborted) this.#report(error); })));
  }

  // ---- notes ----------------------------------------------------------------------------------------------------------

  /** A note for the member's conversation in `scope` (their direct chat, or a group). */
  #note(scope: Scope, phone: string, requestId: string, text: string, data: Record<string, string | number>): void {
    this.#store.addNote({ scope: scopeKey(scope), requestId: `push-note:${requestId}`, phone, text, data: JSON.stringify(data) }, this.#now());
    this.#effect(() => this.#track(this.#drainNotes()));
  }

  #draining = false;
  async #drainNotes(): Promise<void> {
    if (this.#draining || !this.#host || this.#closing) return;
    this.#draining = true;
    try {
      for (let due = this.#store.notesDue(this.#now(), 20); due.length && !this.#closing; due = this.#store.notesDue(this.#now(), 20)) {
        for (const note of due) {
          try {
            const scope = parseScopeKey(note.scope);
            if (!scope) { this.#store.dropNote(note); log.error("推送会话备注的会话无法识别，已丢弃"); continue; }
            await this.#host.note(scope, note.phone, note.requestId, { kind: PUSH_NOTE_KIND, data: JSON.parse(note.data),
              model: [{ role: "user", content: [{ type: "text", text: note.text }], timestamp: note.createdAt }] });
            this.#store.dropNote(note);
          } catch (error) {
            if (this.#signal.aborted) return;
            if (note.attempts >= 20) { this.#store.dropNote(note); log.error(`推送会话备注多次写入失败，已放弃：${String(error)}`); continue; }
            this.#store.deferNote(note, this.#now() + Math.min(3600_000, 30_000 * 2 ** note.attempts));
            this.#report(error);
          }
        }
      }
    } finally { this.#draining = false; }
  }

  // ---- cards and messages ---------------------------------------------------------------------------------------------

  #pusherTarget(push: Push): Target { return { kind: "direct", receiveId: push.pusherIm }; }
  #memberTarget(recipient: Recipient): Target {
    return { kind: memberGroup(recipient.member) === undefined ? "direct" : "group", receiveId: recipient.receiveId };
  }

  #previewCard(push: Push): CardContent {
    const recipients = this.#store.recipients(push.id);
    const done = recipients.filter(recipient => recipient.sendState !== "pending" && recipient.sendState !== "sending").length;
    const failed = recipients.filter(recipient => recipient.sendState === "failed");
    const delivered = recipients.filter(recipient => recipient.sendState === "sent" || recipient.sendState === "uncertain");
    return previewCard({ push, people: recipients.map(recipient => ({ name: recipient.name, member: recipient.member, values: recipient.values })),
      ...(push.state === "preview" || push.state === "cancelled" || push.state === "expired" ? {}
        : { sent: { done, total: recipients.length, delivered: reachOf(delivered), failed: reachOf(failed) } }) }, this.#now());
  }

  #recipientCard(pushId: string, member: string): CardContent | undefined {
    const push = this.#store.push(pushId), recipient = this.#store.recipient(pushId, member);
    if (!push || !recipient) return undefined;
    const reply = this.#store.items(pushId, member);
    const forwards = memberGroup(member) === undefined ? this.#store.forwards(pushId, "confirmed") : [];
    const by = forwards.find(forward => forward.to === member), to = forwards.filter(forward => forward.from === member).map(forward => forward.toName);
    return recipientCard({ push, recipient, reply: countsOf(reply), ...(memberGroup(member) === undefined ? {} : { senders: senders(reply) }),
      ...(by ? { forwardedBy: this.#store.recipient(pushId, by.from)?.name ?? "别人" } : {}), ...(to.length ? { forwardedTo: to } : {}) }, this.#now());
  }

  #forwardCard(id: string): CardContent | undefined {
    const forward = this.#store.forward(id), push = forward && this.#store.push(forward.pushId);
    if (!forward || !push) return undefined;
    return forwardCard({ push, forward, departments: this.#directory.departments.departmentsOf([forward.to]).get(forward.to) ?? [] }, this.#now());
  }

  #refreshForward(id: string): void {
    this.#refresh(`forward:${id}`, () => {
      const forward = this.#store.forward(id), recipient = forward?.card ? this.#store.recipient(forward.pushId, forward.from) : undefined;
      return recipient ? { target: this.#memberTarget(recipient), card: this.#forwardCard(id)! } : undefined;
    });
  }

  /** The pusher's summary card: the summary text, and 「提醒未回复」 while there is someone to remind and no follow-up yet. */
  #summaryCard(push: Push): CardContent {
    const followUp = this.#followUpOf(push);
    return summaryCard({ push, lines: (push.summaryText ?? "").split("\n"), unanswered: reachOf(this.#unanswered(push)), ...(followUp ? { followUp } : {}) });
  }

  #refreshSummary(pushId: string): void {
    this.#refresh(`summary-card:${pushId}`, () => {
      const push = this.#store.push(pushId);
      return push?.summaryCard ? { target: this.#pusherTarget(push), card: this.#summaryCard(push) } : undefined;
    });
  }

  #refreshPreview(pushId: string): void {
    this.#refresh(`preview:${pushId}`, () => {
      const push = this.#store.push(pushId);
      return push?.previewCard ? { target: this.#pusherTarget(push), card: this.#previewCard(push) } : undefined;
    });
  }

  #refreshCard(pushId: string, member: string): void {
    this.#refresh(`card:${pushId}:${member}`, () => {
      const recipient = this.#store.recipient(pushId, member);
      if (!recipient?.card) return undefined;
      return { target: this.#memberTarget(recipient), card: this.#recipientCard(pushId, member)! };
    });
  }

  /** Update a card in place with its state at send time; updates asked for meanwhile coalesce into one more. */
  #refresh(key: string, build: () => { target: Target; card: CardContent } | undefined): void {
    if (this.#after) { this.#after.push(() => this.#refresh(key, build)); return; }
    const running = this.#refreshing.get(key);
    if (running) { running.again = true; return; }
    const state = { again: false };
    this.#refreshing.set(key, state);
    this.#track((async () => {
      try {
        do {
          state.again = false;
          const next = build();
          if (!next || this.#signal.aborted) break;
          let outcome = await this.#outbound.send(next.target, cardMessage(next.card), { signal: this.#signal });
          if (outcome.status === "failed" && !this.#signal.aborted && !state.again) {
            await pause(3000, this.#signal);
            const retry = build();
            if (retry) outcome = await this.#outbound.send(retry.target, cardMessage(retry.card), { signal: this.#signal });
          }
          if (outcome.status === "failed" && !this.#signal.aborted) log.warn(`推送卡片没有更新：${outcome.reason}`);
        } while (state.again && !this.#signal.aborted);
      } finally { this.#refreshing.delete(key); }
    })());
  }

  #text(target: Target, text: string): void {
    this.#effect(() => this.#track(this.#outbound.send(target, textMessage(text), { signal: this.#signal }).then(outcome => {
      if (outcome.status === "failed" && !this.#signal.aborted) log.warn(`推送提示没有发出：${outcome.reason}`);
    })));
  }

  #notice(reply: ReplyContext, text: string): void {
    this.#effect(() => this.#track(sendNotice(this.#outbound, reply, text, { signal: this.#signal })));
  }

  #track(work: Promise<unknown>): void {
    const tracked = work.catch(error => { if (!this.#signal.aborted) this.#report(error); });
    this.#work.add(tracked);
    void tracked.finally(() => this.#work.delete(tracked));
  }

  #report(error: unknown): void {
    try { this.options.onReport?.(error); } catch {}
  }
}

/** Wait `ms`, or less when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
  });
}

function countsOf(items: readonly ReplyItem[]): Counts {
  return { texts: items.filter(item => item.kind === "text").length, files: items.filter(item => item.kind !== "text").length };
}

/** A reply attachment still being downloaded. */
function unsettled(item: ReplyItem, files: ReadonlyMap<string, HeldFile>): boolean {
  return item.attachment !== null && files.get(item.attachment)?.state === "pending";
}
