// An operator takes a conversation over from the console (console/server/views.ts → /_admin/conversation/*, src/server/http-app.ts):
//
// - stop: the member's running task and the messages waiting behind it are cancelled, as the member's own /stop cancels
//   them. The member is told nothing.
// - say: stop, then the operator's text goes to the member as a message of the bot (a group: with an @ of the member),
//   and is written into the member's conversation as a passive entry. The model sees it as a user message starting
//   with 「[人工回复]」 (src/agent/prompt.ts says what it is), so the bot answers the member's next message knowing
//   what the operator said. Nothing else changes: the next message of the member is the bot's again.
//
// Only a member who has talked to the bot in that space, and whom the synced directory still knows (the platform ID
// the message goes to comes from there).
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { EntryDraft } from "@earendil-works/pi-durable";
import { DIRECT_SCOPE, groupScope, type Layout, type Scope, spaceDatabase, spacePath } from "../core/layout.ts";
import type { DirectoryIdentity } from "../integrations/open-platform/identity-directory.ts";
import { markdownMessage, splitText, type Target } from "../integrations/open-platform/messages.ts";
import { OPERATOR_NOTE_KIND, OPERATOR_NOTE_LABEL } from "./operator-note.ts";
import type { Outbound } from "./outbound.ts";
import type { MemberRecords } from "./records.ts";

/** The longest text an operator sends at once (characters). */
export const OPERATOR_TEXT_MAX = 4_000;

/** What the takeover needs from the message service (src/durable/service.ts). */
export interface TakeoverHost {
  records(scope: Scope, phone: string): Promise<Readonly<MemberRecords>>;
  /** Resolves with the texts of the messages that waited behind the running one (the model never saw them). */
  halt(scope: Scope, phone: string): Promise<{ waiting: string[] }>;
  note(scope: Scope, phone: string, requestId: string, entry: EntryDraft): Promise<void>;
}

export interface TakeoverOptions {
  host: TakeoverHost;
  outbound: Outbound;
  directory: { byPhone(phone: string): DirectoryIdentity | undefined };
  layout: Pick<Layout, "conversations">;
  signal: AbortSignal;
  now?: () => number;
  /** Failures that do not fail the calling operation. Must not throw. */
  onReport?: (error: unknown) => void;
  /** Waits between attempts to write the entry after the message went out. */
  noteRetryMs?: readonly number[];
}

/** A refusal the console shows to the operator. */
export class TakeoverRefused extends Error { override name = "TakeoverRefused"; }

/**
 * sent: the member has the message. uncertain: the platform did not confirm it (it may have arrived). partial: a long
 * text went out in segments and a later one failed; `segments` says how many of how many arrived.
 * `recorded` is false when the entry could not be written: the bot will not know what was said.
 */
export type SayResult = { sent: "sent" | "uncertain" | "partial"; recorded: boolean; segments?: { sent: number; total: number } };

/** The scope a space path names (`direct`, `groups/<group ID>`), or undefined. */
export function scopeOfSpace(space: string): Scope | undefined {
  if (space === "direct") return DIRECT_SCOPE;
  const id = space.startsWith("groups/") ? space.slice("groups/".length) : "";
  if (!id) return undefined;
  const scope = groupScope(id);
  // A hashed segment does not give its group ID back.
  return spacePath(scope) === space ? scope : undefined;
}

/** Waiting messages quoted in the entry: this many, each this long. */
const WAITING_SHOWN = 5, WAITING_CHARS = 500;

/**
 * The entry: what the operator told the member, after the member's messages the operator answered in the bot's place
 * and the model never saw (`waiting`).
 */
export function operatorNote(text: string, at: number, waiting: readonly string[] = []): EntryDraft {
  const unseen = waiting.slice(-WAITING_SHOWN).map(each => {
    const chars = [...each.trim()];
    return `「${chars.slice(0, WAITING_CHARS).join("")}${chars.length > WAITING_CHARS ? "…" : ""}」`;
  });
  const body = (unseen.length ? `用户发来的这些消息你没有处理，由管理员接手：\n${unseen.join("\n")}\n` : "") + `管理员以你的名义直接回复了这位用户，用户已经看到：\n${text}`;
  return { kind: OPERATOR_NOTE_KIND, data: { at }, model: [{ role: "user", content: [{ type: "text", text: `${OPERATOR_NOTE_LABEL} ${body}` }], timestamp: at }] };
}

export class Takeover {
  readonly #options: TakeoverOptions;

  constructor(options: TakeoverOptions) { this.#options = options; }

  /** The member of a conversation that exists, with the platform ID messages go to. */
  async #member(space: string, phone: string): Promise<{ scope: Scope; identity: DirectoryIdentity }> {
    const scope = scopeOfSpace(space);
    if (!scope || !existsSync(spaceDatabase(this.#options.layout, scope))) throw new TakeoverRefused("没有这个会话空间。");
    const records = await this.#options.host.records(scope, phone);
    if (!Object.keys(records.requests).length) throw new TakeoverRefused("这位成员在这里还没有和机器人的对话。");
    const identity = this.#options.directory.byPhone(phone);
    if (!identity) throw new TakeoverRefused("这位成员已不在机器人同步的通讯录范围内，不能接管。");
    return { scope, identity };
  }

  async stop(space: string, phone: string): Promise<void> {
    const { scope } = await this.#member(space, phone);
    await this.#options.host.halt(scope, phone);
  }

  async say(space: string, phone: string, raw: string): Promise<SayResult> {
    const text = raw.trim();
    if (!text) throw new TakeoverRefused("请输入要发给成员的内容。");
    if ([...text].length > OPERATOR_TEXT_MAX) throw new TakeoverRefused(`一次最多发 ${OPERATOR_TEXT_MAX} 个字，请分几次发。`);
    const { scope, identity } = await this.#member(space, phone);
    // First the bot stops: its answer must not land beside the operator's.
    const { waiting } = await this.#options.host.halt(scope, phone);
    const { outbound, signal } = this.#options;
    const target: Target = scope.kind === "direct" ? { kind: "direct", receiveId: identity.imUserId } : { kind: "group", receiveId: scope.groupId };
    const segments = splitText(text);
    const delivered: string[] = [];
    const outcome = await outbound.sequence(target, async (send): Promise<SayResult["sent"]> => {
      let sent: SayResult["sent"] = "sent";
      for (const [index, segment] of segments.entries()) {
        // A group message names the member it is for.
        const result = await send(markdownMessage(segment, scope.kind === "group" && index === 0 ? identity.imUserId : undefined), { signal });
        if (result.status === "failed") {
          if (index === 0) throw new TakeoverRefused(`消息没有发出去（${result.reason}），请稍后再试。`);
          return "partial";
        }
        if (result.status === "uncertain") sent = "uncertain";
        delivered.push(segment);
      }
      return sent;
    }, signal);
    // What the member has is what the bot is told.
    const recorded = await this.#record(scope, phone, delivered.join("\n"), waiting);
    return { sent: outcome, recorded, ...(outcome === "partial" ? { segments: { sent: delivered.length, total: segments.length } } : {}) };
  }

  /** The entry in the member's conversation; a few attempts, since the message is already out. */
  async #record(scope: Scope, phone: string, text: string, waiting: readonly string[]): Promise<boolean> {
    const at = (this.#options.now ?? Date.now)(), requestId = `operator-note:${randomUUID()}`;
    for (const wait of [0, ...this.#options.noteRetryMs ?? [500, 2_000]]) {
      if (wait) await Bun.sleep(wait);
      if (this.#options.signal.aborted) return false;
      try { await this.#options.host.note(scope, phone, requestId, operatorNote(text, at, waiting)); return true; }
      catch (error) { this.#options.onReport?.(error); }
    }
    return false;
  }
}
