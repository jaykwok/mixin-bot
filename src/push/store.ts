// Push records in the state database (data/state/agent.sqlite, src/core/state.ts): who may push, the groups the bot has
// seen and their registered names, the pushes, their recipients, the replies they collect and the conversation notes still
// to be written. Synchronous reads and writes on
// the service's main thread (bun:sqlite), like the identity directory: the inbound router decides from them while it
// handles an event, before its first await, so a member's messages keep their arrival order.
//
// Tables are created on open (`CREATE TABLE IF NOT EXISTS`); nothing here migrates. The address book copy elsewhere in
// the database is as sensitive as these rows: logs name counts and push IDs, never phones, names or reply text.
import type { Database, SQLQueryBindings } from "bun:sqlite";

export type PushMode = "ack" | "options" | "reply";
/**
 * preview: waiting for 「确认推送」 on the pusher's card. cancelled / expired: never sent. sending: cards going out (clicks
 * are already taken). open: every card has a final send state. closed: deadline passed or everyone answered.
 */
export type PushState = "preview" | "cancelled" | "expired" | "sending" | "open" | "closed";
/** As for delivery parts: uncertain counts as sent and is never resent (the platform does not deduplicate). */
export type SendState = "pending" | "sending" | "sent" | "failed" | "uncertain";
export type SummaryState = "pending" | "sent" | "failed";

/** Beyond individuals, which a pusher may always reach. */
export type Grants = {
  /** Departments by ID (each with its sub-departments), or any department of the sync scope. */
  department?: { any: true } | { departments: string[] };
  all?: true;
  group?: true;
};

export type PushRole = {
  phone: string;
  admin: boolean;
  pusher: boolean;
  grants: Grants;
  /** Pushes confirmed within 24 hours; null: no limit. */
  dailyLimit: number | null;
  updatedAt: number;
};

export type Person = { phone: string; name: string };
/** A person a push names, with what the push's fields say for this person (in the fields' order). */
export type TargetPerson = Person & { values?: string[] };

/** A file that goes out with a push: its name as sent, and its size. The bytes are the push's own copy (src/core/layout.ts pushFile). */
export type PushFile = { name: string; size: number };

/** A department the push goes to, as the pusher named it; `children`: with its sub-departments. */
export type TargetDepartment = { id: string; path: string; children: boolean };

/** A registered group the push goes to, with its name when the push was prepared. */
export type TargetGroup = { id: string; name: string };

/**
 * What the pusher asked for, as the preview card shows it: people by name and phone, departments, everyone in the sync scope,
 * registered groups. The recipient rows are the list it expands to, again at 「确认推送」 (the address book and the group
 * registrations of that moment). `of`: this push reminds the recipients of push `of` who did not answer (the 「提醒未回复」
 * button on its summary). `unmatched`: people the pusher named who are not in the address book as named; they are not on
 * the list, and the preview says so.
 */
export type PushTarget = { people: TargetPerson[]; departments: TargetDepartment[]; everyone: boolean; groups?: TargetGroup[]; of?: string; unmatched?: string[] };

/** A group's recipient row: one per group, answered by anyone in it (`member` is `group:<group ID>`). */
export const groupMember = (groupId: string) => `group:${groupId}`;
/** The group of a group's recipient row; undefined for a person. */
export const memberGroup = (member: string) => member.startsWith("group:") ? member.slice("group:".length) : undefined;

/**
 * seen: someone @-mentioned the bot there (the platform names groups only so). registered: an admin gave it a name (in the
 * group with /登记群, or in the console); only registered groups take pushes. disabled: takes no pushes, keeps its name.
 */
export type GroupState = "seen" | "registered" | "disabled";
export type ChatGroup = {
  id: string;
  name: string | null;
  state: GroupState;
  firstSeenAt: number;
  lastSeenAt: number;
  registeredAt: number | null;
  /** The admin's phone; null when named in the console. */
  registeredBy: string | null;
};

export type Push = {
  id: string;
  pusher: string;
  pusherName: string;
  /** The pusher's platform user ID when the push was prepared: where the preview, receipts and summary go. */
  pusherIm: string;
  subject: string;
  body: string;
  mode: PushMode;
  options: string[];
  deadline: number;
  /** The deadline was not given: the default applied. */
  defaultDeadline: boolean;
  target: PushTarget;
  cc: Person[];
  /** The files sent to every recipient ahead of the card, in order. */
  files: PushFile[];
  /** Titles of what differs by recipient: each recipient's card shows their own values under them. Empty: the same card for all. */
  fields: string[];
  state: PushState;
  createdAt: number;
  confirmedAt: number | null;
  closedAt: number | null;
  closeReason: "deadline" | "complete" | null;
  /** The preview card's ID (from a click on it) and version. */
  previewCard: string | null;
  previewVersion: number;
  summaryState: SummaryState | null;
  summaryAttempts: number;
  summaryAt: number | null;
  summaryError: string | null;
  /** Phones the summary went to, and `<phone>|<step>` for what went out of one still unfinished (a retry skips them). */
  summaryDone: string[];
  /** The summary as the pusher's card shows it (lines), once made. */
  summaryText: string | null;
  /** The pusher's summary card's ID (from a click on it) and version. */
  summaryCard: string | null;
  summaryVersion: number;
  /** The push its summary's 「提醒未回复」 prepared. */
  followUp: string | null;
  /** At its progress moments the card goes again to whoever has not answered (the pusher is told the progress either way). */
  remind: boolean;
  /** The progress moments still to come (./reminders.ts), set when the push is confirmed. */
  checkpoints: number[];
  /** How often the card went again so. */
  reminded: number;
  /** Reply attachments were released (after the summary went out). */
  released: boolean;
};

export type Recipient = {
  pushId: string;
  /** The member's phone, or `group:<group ID>` for a group (groupMember). */
  member: string;
  name: string;
  /** Where the card goes: the member's platform user ID, or the group ID. */
  receiveId: string;
  sendState: SendState;
  sendAttempts: number;
  sendError: string | null;
  sentAt: number | null;
  retryAt: number | null;
  /** How many of the push's files went out to this recipient (they go in order, ahead of the card). */
  filesSent: number;
  /** This recipient's values of the push's fields, in their order; one handed the push has those of who handed it on. */
  values: string[];
  /** The card's ID, known from the first click on it. */
  card: string | null;
  version: number;
  /** A person's first 「已收到」, or the first one in a group. */
  ackedAt: number | null;
  /** 「已收到」 clicks in a group (the clickers cannot be told apart); 0 for a person. */
  clicks: number;
  choice: number | null;
  choiceAt: number | null;
  /** When the reply (the member's reply items) last changed; null: no reply. */
  repliedAt: number | null;
};

/** `sent`: pushes that went out (`followUps` of them 补推送, `live` not closed); the rest is over the closed ones. */
export type PushTotals = { sent: number; followUps: number; live: number; delivered: number; acked: number; replyDelivered: number; replied: number };

export type ItemKind = "text" | "image" | "file" | "video";
export type ReplyItem = {
  id: number;
  pushId: string;
  member: string;
  msgUid: string;
  kind: ItemKind;
  text: string | null;
  /** The held attachment in the member's records (src/durable/attachments.ts); null for a text. */
  attachment: string | null;
  name: string | null;
  size: number | null;
  receivedAt: number;
  /** The attachment's file, recorded when the push released its hold (the record is gone then; the console still downloads it). */
  path: string | null;
  /** Who sent a group's reply text: phone and name; null in a direct chat. */
  sender: string | null;
  senderName: string | null;
};

/**
 * A recipient hands a push on to someone else in the address book: `pending` until the recipient presses 「确认转派」 on the
 * card that asks (its ID is known from a click on it), then `confirmed` (the other person is a recipient of the push from
 * then on, and the one who handed it on counts as answered) or `cancelled`.
 */
export type ForwardState = "pending" | "confirmed" | "cancelled";
export type Forward = {
  id: string;
  pushId: string;
  /** The recipient who hands on, and the person it goes to (phones). */
  from: string;
  to: string;
  toName: string;
  state: ForwardState;
  card: string | null;
  version: number;
  createdAt: number;
  decidedAt: number | null;
};

/** A text a recipient of a live push sent (`member`: the phone, or the group's row; `sender`: who wrote it), kept a day so a reply can be recorded word for word. */
export type Heard = { msgUid: string; member: string; sender: string; text: string; receivedAt: number };

/** `scope`: the conversation's scope key (src/core/layout.ts scopeKey): `direct`, or `group:<ID>` for a member's group conversation. */
export type PushNote = { scope: string; requestId: string; phone: string; text: string; data: string; attempts: number; nextAt: number; createdAt: number };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS push_roles (
  phone TEXT PRIMARY KEY, admin INTEGER NOT NULL, pusher INTEGER NOT NULL, grants TEXT NOT NULL, daily_limit INTEGER,
  updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS chat_groups (
  group_id TEXT PRIMARY KEY, name TEXT UNIQUE, state TEXT NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  registered_at INTEGER, registered_by TEXT) STRICT;
CREATE TABLE IF NOT EXISTS pushes (
  id TEXT PRIMARY KEY, pusher TEXT NOT NULL, pusher_name TEXT NOT NULL, pusher_im TEXT NOT NULL, subject TEXT NOT NULL,
  body TEXT NOT NULL, mode TEXT NOT NULL, options TEXT NOT NULL, deadline INTEGER NOT NULL, default_deadline INTEGER NOT NULL,
  target TEXT NOT NULL, cc TEXT NOT NULL, files TEXT NOT NULL, fields TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, confirmed_at INTEGER,
  closed_at INTEGER, close_reason TEXT, preview_card TEXT, preview_version INTEGER NOT NULL, summary_state TEXT,
  summary_attempts INTEGER NOT NULL, summary_at INTEGER, summary_error TEXT, summary_done TEXT NOT NULL, summary_text TEXT, summary_card TEXT,
  summary_version INTEGER NOT NULL, follow_up TEXT, remind INTEGER NOT NULL, checkpoints TEXT NOT NULL, reminded INTEGER NOT NULL,
  released INTEGER NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS pushes_by_pusher ON pushes (pusher, created_at);
CREATE INDEX IF NOT EXISTS pushes_by_state ON pushes (state);
CREATE TABLE IF NOT EXISTS push_recipients (
  push_id TEXT NOT NULL, member TEXT NOT NULL, name TEXT NOT NULL, receive_id TEXT NOT NULL, send_state TEXT NOT NULL,
  send_attempts INTEGER NOT NULL, send_error TEXT, sent_at INTEGER, retry_at INTEGER, files_sent INTEGER NOT NULL, field_values TEXT NOT NULL, card TEXT, version INTEGER NOT NULL,
  acked_at INTEGER, clicks INTEGER NOT NULL, choice INTEGER, choice_at INTEGER, replied_at INTEGER,
  PRIMARY KEY (push_id, member)) STRICT;
CREATE INDEX IF NOT EXISTS push_recipients_by_member ON push_recipients (member);
CREATE TABLE IF NOT EXISTS push_reply_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, push_id TEXT NOT NULL, member TEXT NOT NULL,
  msg_uid TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, text TEXT, attachment TEXT, name TEXT, size INTEGER,
  received_at INTEGER NOT NULL, path TEXT, sender TEXT, sender_name TEXT) STRICT;
CREATE INDEX IF NOT EXISTS push_reply_items_by_reply ON push_reply_items (push_id, member);
CREATE TABLE IF NOT EXISTS push_forwards (
  id TEXT PRIMARY KEY, push_id TEXT NOT NULL, from_member TEXT NOT NULL, to_member TEXT NOT NULL, to_name TEXT NOT NULL, state TEXT NOT NULL,
  card TEXT, version INTEGER NOT NULL, created_at INTEGER NOT NULL, decided_at INTEGER) STRICT;
CREATE INDEX IF NOT EXISTS push_forwards_by_push ON push_forwards (push_id, from_member);
CREATE TABLE IF NOT EXISTS push_heard (
  msg_uid TEXT PRIMARY KEY, member TEXT NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL, received_at INTEGER NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS push_heard_by_member ON push_heard (member, sender, received_at);
CREATE TABLE IF NOT EXISTS push_notes (
  scope TEXT NOT NULL, phone TEXT NOT NULL, request_id TEXT NOT NULL, text TEXT NOT NULL, data TEXT NOT NULL, attempts INTEGER NOT NULL,
  next_at INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (scope, phone, request_id)) STRICT;
`;

type Row = Record<string, string | number | null>;

const PUSH_COLUMNS = {
  id: "id", pusher: "pusher", pusherName: "pusher_name", pusherIm: "pusher_im", subject: "subject", body: "body", mode: "mode",
  options: "options", deadline: "deadline", defaultDeadline: "default_deadline", target: "target", cc: "cc", files: "files", fields: "fields", state: "state",
  createdAt: "created_at", confirmedAt: "confirmed_at", closedAt: "closed_at", closeReason: "close_reason", previewCard: "preview_card",
  previewVersion: "preview_version", summaryState: "summary_state", summaryAttempts: "summary_attempts", summaryAt: "summary_at",
  summaryError: "summary_error", summaryDone: "summary_done", summaryText: "summary_text", summaryCard: "summary_card", summaryVersion: "summary_version", followUp: "follow_up",
  remind: "remind", checkpoints: "checkpoints", reminded: "reminded", released: "released",
} as const satisfies Record<keyof Push, string>;

const RECIPIENT_COLUMNS = {
  pushId: "push_id", member: "member", name: "name", receiveId: "receive_id", sendState: "send_state", sendAttempts: "send_attempts",
  sendError: "send_error", sentAt: "sent_at", retryAt: "retry_at", filesSent: "files_sent", values: "field_values", card: "card", version: "version", ackedAt: "acked_at", clicks: "clicks",
  choice: "choice", choiceAt: "choice_at", repliedAt: "replied_at",
} as const satisfies Record<keyof Recipient, string>;

const JSON_PUSH_FIELDS = new Set<keyof Push>(["options", "target", "cc", "files", "fields", "summaryDone", "checkpoints"]);
const BOOLEAN_PUSH_FIELDS = new Set<keyof Push>(["defaultDeadline", "remind", "released"]);

function encodePush<K extends keyof Push>(key: K, value: Push[K]): string | number | null {
  if (JSON_PUSH_FIELDS.has(key)) return JSON.stringify(value);
  if (BOOLEAN_PUSH_FIELDS.has(key)) return value ? 1 : 0;
  return value as string | number | null;
}

function decodePush(row: Row): Push {
  const push = {} as Record<string, unknown>;
  for (const [key, column] of Object.entries(PUSH_COLUMNS) as [keyof Push, string][]) {
    const value = row[column];
    push[key] = JSON_PUSH_FIELDS.has(key) ? JSON.parse(String(value)) : BOOLEAN_PUSH_FIELDS.has(key) ? value === 1 : value;
  }
  return push as Push;
}

const encodeRecipient = (key: keyof Recipient, value: unknown): SQLQueryBindings => key === "values" ? JSON.stringify(value) : value as SQLQueryBindings;

function decodeRecipient(row: Row): Recipient {
  const recipient = {} as Record<string, unknown>;
  for (const [key, column] of Object.entries(RECIPIENT_COLUMNS)) recipient[key] = key === "values" ? JSON.parse(String(row[column])) : row[column];
  return recipient as Recipient;
}

const RECIPIENT_KEYS = Object.keys(RECIPIENT_COLUMNS) as (keyof Recipient)[];
const RECIPIENT_INSERT = `INSERT INTO push_recipients (${RECIPIENT_KEYS.map(key => RECIPIENT_COLUMNS[key]).join(", ")}) VALUES (${RECIPIENT_KEYS.map(() => "?").join(", ")})`;
/** Handed on to someone (a confirmed forward of the row's member). */
const FORWARDED = "EXISTS (SELECT 1 FROM push_forwards f WHERE f.push_id = r.push_id AND f.from_member = r.member AND f.state = 'confirmed')";
/** `delivered` in SQL (a recipient row `r`). */
const DELIVERED = "(r.send_state IN ('sent', 'uncertain') OR r.sent_at IS NOT NULL)";
const FORWARD_SELECT = `SELECT id, push_id AS pushId, from_member AS "from", to_member AS "to", to_name AS toName, state, card, version,
  created_at AS createdAt, decided_at AS decidedAt FROM push_forwards`;

const ITEM_SELECT = `SELECT id, push_id AS pushId, member, msg_uid AS msgUid, kind, text, attachment, name, size,
  received_at AS receivedAt, path, sender, sender_name AS senderName FROM push_reply_items`;
const GROUP_SELECT = `SELECT group_id AS id, name, state, first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, registered_at AS registeredAt,
  registered_by AS registeredBy FROM chat_groups`;

/**
 * A push's recipient rows, counted: `groups` of them are groups, `delivered` were reached and `answered` of those answered or
 * handed the push on, `unsettled` have a send still to come; `repliedAt`: when a reply last changed.
 */
export type RecipientCounts = { total: number; groups: number; delivered: number; failed: number; answered: number; unsettled: number; repliedAt: number | null };

/** States in which a push still takes clicks and replies. */
export const LIVE_STATES: readonly PushState[] = ["sending", "open"];

/**
 * The card reached the recipient at least once. A card sent again (补推送, a reminder) puts the row back to `pending`
 * and may fail, but the card they have keeps counting: `sentAt` stays from the send that reached them.
 */
export function delivered(recipient: Pick<Recipient, "sendState" | "sentAt">): boolean {
  return recipient.sendState === "sent" || recipient.sendState === "uncertain" || recipient.sentAt !== null;
}

/** The send state to show: a card sent again that failed leaves the one the recipient has (`delivered`), so it shows as sent. */
export function shownSend(recipient: Pick<Recipient, "sendState" | "sentAt" | "sendError">): Pick<Recipient, "sendState" | "sendError"> {
  return recipient.sendState === "failed" && delivered(recipient) ? { sendState: "sent", sendError: null } : { sendState: recipient.sendState, sendError: recipient.sendError };
}

export class PushStore {
  constructor(readonly db: Database) {
    db.exec(SCHEMA);
  }

  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  // ---- roles ----------------------------------------------------------------------------------------------------------

  roles(): PushRole[] {
    return (this.db.query("SELECT * FROM push_roles ORDER BY phone").all() as Row[]).map(roleOf);
  }

  role(phone: string): PushRole | undefined {
    const row = this.db.query("SELECT * FROM push_roles WHERE phone = ?").get(phone) as Row | null;
    return row ? roleOf(row) : undefined;
  }

  /** Replace the whole list; people with neither role are left out. */
  replaceRoles(roles: readonly Omit<PushRole, "updatedAt">[], now: number): void {
    this.transaction(() => {
      const before = new Map(this.roles().map(role => [role.phone, role]));
      this.db.query("DELETE FROM push_roles").run();
      const insert = this.db.query("INSERT INTO push_roles (phone, admin, pusher, grants, daily_limit, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
      for (const role of roles) {
        if (!role.admin && !role.pusher) continue;
        const previous = before.get(role.phone);
        const same = previous && previous.admin === role.admin && previous.pusher === role.pusher && previous.dailyLimit === role.dailyLimit
          && JSON.stringify(previous.grants) === JSON.stringify(role.grants);
        insert.run(role.phone, role.admin ? 1 : 0, role.pusher ? 1 : 0, JSON.stringify(role.grants), role.dailyLimit, same ? previous.updatedAt : now);
      }
    });
  }

  // ---- groups ---------------------------------------------------------------------------------------------------------

  /** Someone in the group @-mentioned the bot: a new group is `seen`; a known one's time moves on at most every `every` ms. */
  groupSeen(id: string, at: number, every: number): void {
    this.db.query(`INSERT INTO chat_groups (group_id, name, state, first_seen_at, last_seen_at) VALUES (?, NULL, 'seen', ?, ?)
      ON CONFLICT (group_id) DO UPDATE SET last_seen_at = excluded.last_seen_at WHERE excluded.last_seen_at - chat_groups.last_seen_at >= ?`).run(id, at, at, every);
  }

  group(id: string): ChatGroup | undefined {
    return (this.db.query(`${GROUP_SELECT} WHERE group_id = ?`).get(id) as ChatGroup | null) ?? undefined;
  }

  /** Registered, then disabled, then seen; most recently seen first in each. */
  groups(): ChatGroup[] {
    return this.db.query(`${GROUP_SELECT} ORDER BY CASE state WHEN 'registered' THEN 0 WHEN 'disabled' THEN 1 ELSE 2 END, last_seen_at DESC`).all() as ChatGroup[];
  }

  /** Name, register or disable a group that was seen; the caller checked the name is free. */
  saveGroup(id: string, change: Pick<ChatGroup, "name" | "state" | "registeredAt" | "registeredBy">): void {
    this.db.query("UPDATE chat_groups SET name = ?, state = ?, registered_at = ?, registered_by = ? WHERE group_id = ?")
      .run(change.name, change.state, change.registeredAt, change.registeredBy, id);
  }

  // ---- pushes ---------------------------------------------------------------------------------------------------------

  /** A new push in `preview` with its recipients, in one transaction. */
  create(push: Push, recipients: readonly Recipient[]): void {
    this.transaction(() => {
      const keys = Object.keys(PUSH_COLUMNS) as (keyof Push)[];
      this.db.query(`INSERT INTO pushes (${keys.map(key => PUSH_COLUMNS[key]).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
        .run(...keys.map(key => encodePush(key, push[key])));
      for (const recipient of recipients) this.addRecipient(recipient);
    });
  }

  push(id: string): Push | undefined {
    const row = this.db.query("SELECT * FROM pushes WHERE id = ?").get(id) as Row | null;
    return row ? decodePush(row) : undefined;
  }

  exists(id: string): boolean {
    return this.db.query("SELECT 1 FROM pushes WHERE id = ?").get(id) !== null;
  }

  /** The pusher's pushes, newest first. */
  pushesOf(pusher: string, limit: number): Push[] {
    return (this.db.query("SELECT * FROM pushes WHERE pusher = ? AND state NOT IN ('cancelled', 'expired') ORDER BY created_at DESC LIMIT ?")
      .all(pusher, limit) as Row[]).map(decodePush);
  }

  pushesIn(states: readonly PushState[]): Push[] {
    return (this.db.query(`SELECT * FROM pushes WHERE state IN (${states.map(() => "?").join(", ")}) ORDER BY created_at`)
      .all(...states) as Row[]).map(decodePush);
  }

  /** The console's list: newest first, then by ID; after `before` (the last push of the page before), optionally only some states. */
  page(states: readonly PushState[] | null, before: Pick<Push, "createdAt" | "id"> | null, limit: number): Push[] {
    const where = [...(states ? [`state IN (${states.map(() => "?").join(", ")})`] : []), ...(before === null ? [] : ["(created_at < ? OR (created_at = ? AND id > ?))"])];
    return (this.db.query(`SELECT * FROM pushes ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id LIMIT ?`)
      .all(...states ?? [], ...(before === null ? [] : [before.createdAt, before.createdAt, before.id]), limit) as Row[]).map(decodePush);
  }

  /**
   * The console's totals over the pushes kept here: those that went out, and over the closed ones the
   * delivered recipients (a person or a group each) that confirmed (「已收到」, a choice, or a reply) and, of the pushes
   * asking for a reply, that replied. A push deleted in the console no longer counts.
   */
  totals(): PushTotals {
    const pushes = this.db.query(`SELECT count(*) AS sent, coalesce(sum(json_extract(target, '$.of') IS NOT NULL), 0) AS followUps,
      coalesce(sum(state != 'closed'), 0) AS live FROM pushes WHERE state IN ('sending', 'open', 'closed')`).get() as Pick<PushTotals, "sent" | "followUps" | "live">;
    const answers = this.db.query(`SELECT count(*) AS delivered, coalesce(sum(r.acked_at IS NOT NULL), 0) AS acked,
      coalesce(sum(p.mode = 'reply'), 0) AS replyDelivered, coalesce(sum(p.mode = 'reply' AND r.replied_at IS NOT NULL), 0) AS replied
      FROM push_recipients r JOIN pushes p ON p.id = r.push_id WHERE p.state = 'closed' AND ${DELIVERED}`).get() as
      Omit<PushTotals, "sent" | "followUps" | "live">;
    return { ...pushes, ...answers };
  }

  /** Delete a push with its recipients, reply items and forwards (the console). */
  remove(id: string): void {
    this.transaction(() => {
      for (const table of ["push_reply_items", "push_recipients", "push_forwards"]) this.db.query(`DELETE FROM ${table} WHERE push_id = ?`).run(id);
      this.db.query("DELETE FROM pushes WHERE id = ?").run(id);
    });
  }

  /**
   * Previews the pusher prepared before a push they confirmed: the earlier rounds of a push that went out in a later
   * one. A follow-up (「提醒未回复」) neither counts as that push nor is one of them.
   */
  supersededPreviews(): Push[] {
    return (this.db.query(`SELECT p.* FROM pushes p WHERE p.state = 'preview' AND json_extract(p.target, '$.of') IS NULL AND EXISTS (
      SELECT 1 FROM pushes c WHERE c.pusher = p.pusher AND c.created_at > p.created_at AND c.confirmed_at IS NOT NULL
        AND json_extract(c.target, '$.of') IS NULL) ORDER BY p.created_at`).all() as Row[]).map(decodePush);
  }

  /** Pushes with a summary still to send. */
  summariesDue(): Push[] {
    return (this.db.query("SELECT * FROM pushes WHERE state = 'closed' AND summary_state = 'pending' ORDER BY closed_at").all() as Row[]).map(decodePush);
  }

  /** Closed pushes whose held attachments are still to release. */
  unreleased(): Push[] {
    return (this.db.query("SELECT * FROM pushes WHERE state = 'closed' AND summary_state IN ('sent', 'failed') AND released = 0").all() as Row[]).map(decodePush);
  }

  /** Pushes the pusher confirmed since `since` (the frequency limit). */
  confirmedSince(pusher: string, since: number): number {
    return (this.db.query("SELECT count(*) AS n FROM pushes WHERE pusher = ? AND confirmed_at >= ?").get(pusher, since) as { n: number }).n;
  }

  updatePush(id: string, change: Partial<Omit<Push, "id">>): void {
    const keys = Object.keys(change) as (keyof typeof change)[];
    if (!keys.length) return;
    this.db.query(`UPDATE pushes SET ${keys.map(key => `${PUSH_COLUMNS[key]} = ?`).join(", ")} WHERE id = ?`)
      .run(...keys.map(key => encodePush(key, change[key] as never)), id);
  }

  /** Change the push only while it is in `from`; true when it was. */
  movePush(id: string, from: readonly PushState[], change: Partial<Omit<Push, "id">>): boolean {
    return this.transaction(() => {
      const current = this.push(id);
      if (!current || !from.includes(current.state)) return false;
      this.updatePush(id, change);
      return true;
    });
  }

  // ---- recipients -----------------------------------------------------------------------------------------------------

  /** The counts of these pushes (a push without rows is absent), without decoding what can be 5000 rows each. */
  recipientCounts(pushIds: readonly string[]): Map<string, RecipientCounts> {
    if (!pushIds.length) return new Map();
    const rows = this.db.query(`SELECT r.push_id AS pushId, count(*) AS total, sum(r.member LIKE 'group:%') AS groups,
      sum(${DELIVERED}) AS delivered, sum(r.send_state = 'failed' AND NOT ${DELIVERED}) AS failed,
      sum(${DELIVERED} AND (CASE p.mode WHEN 'ack' THEN r.acked_at IS NOT NULL WHEN 'options' THEN r.choice IS NOT NULL
        ELSE r.replied_at IS NOT NULL END OR ${FORWARDED})) AS answered,
      sum(NOT ${DELIVERED} AND (r.send_state IN ('pending', 'sending') OR (r.send_state = 'failed' AND r.retry_at IS NOT NULL))) AS unsettled,
      max(r.replied_at) AS repliedAt
      FROM push_recipients r JOIN pushes p ON p.id = r.push_id WHERE r.push_id IN (${pushIds.map(() => "?").join(", ")}) GROUP BY r.push_id`)
      .all(...pushIds) as (RecipientCounts & { pushId: string })[];
    return new Map(rows.map(({ pushId, ...counts }) => [pushId, counts]));
  }

  recipients(pushId: string): Recipient[] {
    return (this.db.query("SELECT * FROM push_recipients WHERE push_id = ? ORDER BY rowid").all(pushId) as Row[]).map(decodeRecipient);
  }

  recipient(pushId: string, member: string): Recipient | undefined {
    const row = this.db.query("SELECT * FROM push_recipients WHERE push_id = ? AND member = ?").get(pushId, member) as Row | null;
    return row ? decodeRecipient(row) : undefined;
  }

  /** A preview's list again (as expanded at 「确认推送」); the caller holds the transaction that confirms it. */
  replaceRecipients(pushId: string, recipients: readonly Recipient[]): void {
    this.transaction(() => {
      this.db.query("DELETE FROM push_recipients WHERE push_id = ?").run(pushId);
      for (const recipient of recipients) this.addRecipient(recipient);
    });
  }

  /** One more recipient of a push (the list at its creation and confirmation, then people it is handed on to). */
  addRecipient(recipient: Recipient): void {
    this.db.query(RECIPIENT_INSERT).run(...RECIPIENT_KEYS.map(key => encodeRecipient(key, recipient[key])));
  }

  updateRecipient(pushId: string, member: string, change: Partial<Omit<Recipient, "pushId" | "member">>): void {
    const keys = Object.keys(change) as (keyof typeof change)[];
    if (!keys.length) return;
    this.db.query(`UPDATE push_recipients SET ${keys.map(key => `${RECIPIENT_COLUMNS[key]} = ?`).join(", ")} WHERE push_id = ? AND member = ?`)
      .run(...keys.map(key => encodeRecipient(key, change[key])), pushId, member);
  }

  /** Every card of the push is out of date (the push ended): clicks on the buttons as sent no longer count. */
  bumpVersions(pushId: string): void {
    this.db.query("UPDATE push_recipients SET version = version + 1 WHERE push_id = ?").run(pushId);
  }

  /** The member's (or group's) rows in live pushes whose card reached them. */
  reached(member: string): Recipient[] {
    return (this.db.query(`SELECT r.* FROM push_recipients r JOIN pushes p ON p.id = r.push_id
      WHERE r.member = ? AND p.state IN ('sending', 'open') AND ${DELIVERED} ORDER BY p.created_at`).all(member) as Row[]).map(decodeRecipient);
  }

  /** Live pushes that want a reply from the member (or group) and have none yet, unless they handed the push on. */
  awaitingReply(member: string): Recipient[] {
    return (this.db.query(`SELECT r.* FROM push_recipients r JOIN pushes p ON p.id = r.push_id
      WHERE r.member = ? AND p.mode = 'reply' AND p.state IN ('sending', 'open') AND r.replied_at IS NULL AND NOT ${FORWARDED}
      AND ${DELIVERED} ORDER BY p.created_at`).all(member) as Row[]).map(decodeRecipient);
  }

  /** Recipients whose card is due to be sent (pending, or failed with a retry time reached). */
  sendsDue(now: number): Recipient[] {
    return (this.db.query(`SELECT r.* FROM push_recipients r JOIN pushes p ON p.id = r.push_id
      WHERE p.state IN ('sending', 'open') AND (r.send_state = 'pending' OR (r.send_state = 'failed' AND r.retry_at IS NOT NULL AND r.retry_at <= ?))
      ORDER BY p.created_at, r.rowid`).all(now) as Row[]).map(decodeRecipient);
  }

  /**
   * At startup: sends an ended process left `sending` may have reached the platform. A row with files still to go is not
   * one of them: its card follows the files, so it was not sent. It is sent again while the push is on (the file that was
   * under way may arrive twice), and failed once the push has ended.
   */
  settleInterruptedSends(): number {
    return this.transaction(() => {
      const unsent = "send_state = 'sending' AND files_sent < (SELECT json_array_length(p.files) FROM pushes p WHERE p.id = push_recipients.push_id)";
      this.db.query(`UPDATE push_recipients SET send_state = 'failed', retry_at = NULL, send_error = '截止前没有发完附件'
        WHERE ${unsent} AND push_id NOT IN (SELECT id FROM pushes WHERE state IN ('sending', 'open'))`).run();
      this.db.query(`UPDATE push_recipients SET send_state = 'pending' WHERE ${unsent}`).run();
      return this.db.query("UPDATE push_recipients SET send_state = 'uncertain', send_error = '发送过程中服务中断，结果未知' WHERE send_state = 'sending'").run().changes;
    });
  }

  // ---- reply items ----------------------------------------------------------------------------------------------------

  /** The new item's ID; undefined when the message was recorded before (a redelivery). */
  addItem(item: Omit<ReplyItem, "id" | "path">): number | undefined {
    const result = this.db.query(`INSERT OR IGNORE INTO push_reply_items (push_id, member, msg_uid, kind, text, attachment, name, size,
      received_at, sender, sender_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(item.pushId, item.member, item.msgUid, item.kind,
      item.text, item.attachment, item.name, item.size, item.receivedAt, item.sender, item.senderName);
    return result.changes ? Number(result.lastInsertRowid) : undefined;
  }

  /** The item a message became, if any. */
  itemOf(msgUid: string): ReplyItem | undefined {
    return (this.db.query(`${ITEM_SELECT} WHERE msg_uid = ?`).get(msgUid) as ReplyItem | null) ?? undefined;
  }

  removeItems(ids: readonly number[]): void {
    for (const id of ids) this.db.query("DELETE FROM push_reply_items WHERE id = ?").run(id);
  }

  /** Where the item's file is, kept when the push lets its hold go. */
  keepItemPath(id: number, path: string): void {
    this.db.query("UPDATE push_reply_items SET path = ? WHERE id = ?").run(path, id);
  }

  /** A push's reply items in order; `member`: one recipient's reply. */
  items(pushId: string, member?: string): ReplyItem[] {
    if (member === undefined) return this.db.query(`${ITEM_SELECT} WHERE push_id = ? ORDER BY received_at, id`).all(pushId) as ReplyItem[];
    return this.db.query(`${ITEM_SELECT} WHERE push_id = ? AND member = ? ORDER BY received_at, id`).all(pushId, member) as ReplyItem[];
  }

  // ---- forwards -------------------------------------------------------------------------------------------------------

  addForward(forward: Forward): void {
    this.db.query(`INSERT INTO push_forwards (id, push_id, from_member, to_member, to_name, state, card, version, created_at, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(forward.id, forward.pushId, forward.from, forward.to, forward.toName, forward.state, forward.card, forward.version,
      forward.createdAt, forward.decidedAt);
  }

  forward(id: string): Forward | undefined {
    return (this.db.query(`${FORWARD_SELECT} WHERE id = ?`).get(id) as Forward | null) ?? undefined;
  }

  /** A push's forwards in order; `state`: only these. */
  forwards(pushId: string, state?: ForwardState): Forward[] {
    return state === undefined ? this.db.query(`${FORWARD_SELECT} WHERE push_id = ? ORDER BY created_at, rowid`).all(pushId) as Forward[]
      : this.db.query(`${FORWARD_SELECT} WHERE push_id = ? AND state = ? ORDER BY created_at, rowid`).all(pushId, state) as Forward[];
  }

  updateForward(id: string, change: Partial<Pick<Forward, "state" | "card" | "version" | "decidedAt">>): void {
    const columns = { state: "state", card: "card", version: "version", decidedAt: "decided_at" } as const;
    const keys = Object.keys(change) as (keyof typeof columns)[];
    if (!keys.length) return;
    this.db.query(`UPDATE push_forwards SET ${keys.map(key => `${columns[key]} = ?`).join(", ")} WHERE id = ?`).run(...keys.map(key => change[key] ?? null), id);
  }

  /** The push ended: what was still asked is not handed on. */
  cancelForwards(pushId: string, now: number): void {
    this.db.query("UPDATE push_forwards SET state = 'cancelled', decided_at = ?, version = version + 1 WHERE push_id = ? AND state = 'pending'").run(now, pushId);
  }

  // ---- heard messages -------------------------------------------------------------------------------------------------

  /** Keep a recipient's text, and of this sender there only the newest `keep`. */
  hear(heard: Heard, keep: number): void {
    this.db.query("INSERT OR IGNORE INTO push_heard (msg_uid, member, sender, text, received_at) VALUES (?, ?, ?, ?, ?)")
      .run(heard.msgUid, heard.member, heard.sender, heard.text, heard.receivedAt);
    this.db.query(`DELETE FROM push_heard WHERE member = ? AND sender = ? AND msg_uid NOT IN (
      SELECT msg_uid FROM push_heard WHERE member = ? AND sender = ? ORDER BY received_at DESC, rowid DESC LIMIT ?)`).run(heard.member, heard.sender, heard.member, heard.sender, keep);
  }

  /** What this sender said there, newest first. */
  heard(member: string, sender: string): Heard[] {
    return this.db.query(`SELECT msg_uid AS msgUid, member, sender, text, received_at AS receivedAt FROM push_heard WHERE member = ? AND sender = ?
      ORDER BY received_at DESC, rowid DESC`).all(member, sender) as Heard[];
  }

  forgetHeard(before: number): void {
    this.db.query("DELETE FROM push_heard WHERE received_at < ?").run(before);
  }

  // ---- conversation notes ---------------------------------------------------------------------------------------------

  /** Queue a note for one member's conversation; one with the same request ID there is kept as it was. */
  addNote(note: Pick<PushNote, "scope" | "requestId" | "phone" | "text" | "data">, now: number): void {
    this.db.query("INSERT OR IGNORE INTO push_notes (scope, phone, request_id, text, data, attempts, next_at, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)")
      .run(note.scope, note.phone, note.requestId, note.text, note.data, now, now);
  }

  notesDue(now: number, limit: number): PushNote[] {
    return this.db.query(`SELECT scope, request_id AS requestId, phone, text, data, attempts, next_at AS nextAt, created_at AS createdAt FROM push_notes
      WHERE next_at <= ? ORDER BY created_at, rowid LIMIT ?`).all(now, limit) as PushNote[];
  }

  dropNote(note: Pick<PushNote, "scope" | "phone" | "requestId">): void {
    this.db.query("DELETE FROM push_notes WHERE scope = ? AND phone = ? AND request_id = ?").run(note.scope, note.phone, note.requestId);
  }

  deferNote(note: Pick<PushNote, "scope" | "phone" | "requestId">, nextAt: number): void {
    this.db.query("UPDATE push_notes SET attempts = attempts + 1, next_at = ? WHERE scope = ? AND phone = ? AND request_id = ?")
      .run(nextAt, note.scope, note.phone, note.requestId);
  }
}

function roleOf(row: Row): PushRole {
  return { phone: String(row.phone), admin: row.admin === 1, pusher: row.pusher === 1, grants: JSON.parse(String(row.grants)) as Grants,
    dailyLimit: row.daily_limit === null ? null : Number(row.daily_limit), updatedAt: Number(row.updated_at) };
}
