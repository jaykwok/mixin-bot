// An operator takes a conversation over from the console (console/server/views.ts → /_admin/conversation/*, src/server/http-app.ts):
//
// - stop: the member's running task and the messages waiting behind it are cancelled, as the member's own /stop cancels
//   them. The member is told nothing.
// - say: validate/upload an optional attachment, stop, then send the operator's text and attachment as the bot
//   (a group: with an @ of the member),
//   and is written into the member's conversation as a passive entry. The model sees it as a user message starting
//   with 「[人工回复]」 (src/agent/prompt.ts says what it is), so the bot answers the member's next message knowing
//   what the operator said. Nothing else changes: the next message of the member is the bot's again.
//
// Only a member who has talked to the bot in that space, and whom the synced directory still knows (the platform ID
// the message goes to comes from there).
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntryDraft } from "@earendil-works/pi-durable";
import { DIRECT_SCOPE, groupScope, type Layout, type Scope, spaceDatabase, spacePath } from "../core/layout.ts";
import type { DirectoryIdentity } from "../integrations/open-platform/identity-directory.ts";
import { imageMessage, markdownMessage, splitText, type OutboundMessage, type Target } from "../integrations/open-platform/messages.ts";
import { imageInfo } from "../integrations/open-platform/image.ts";
import { operatorAttachment, type OperatorAttachment } from "../contracts/takeover-upload.ts";
import { AsyncSemaphore } from "../core/async-semaphore.ts";
import { OPERATOR_NOTE_KIND, OPERATOR_NOTE_LABEL } from "./operator-note.ts";
import { escapeInline, fileUpload, uploadedFile, type Outbound } from "./outbound.ts";

/** The longest text an operator sends at once (characters). */
export const OPERATOR_TEXT_MAX = 4_000;

/** What the takeover needs from the message service (src/durable/service.ts). */
export interface TakeoverHost {
  /** The member has a conversation in the space (not its request records: those go a day after the request closed). */
  hasConversation(scope: Scope, phone: string): Promise<boolean>;
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
 * text/attachment went out in parts and a later one failed; `segments` says how many of how many arrived.
 * `recorded` is false when the entry could not be written: the bot will not know what was said.
 */
export type SayResult = { sent: "sent" | "uncertain" | "partial"; recorded: boolean; segments?: { sent: number; total: number };
  attachment?: { name: string; kind: "image" | "file"; sent: "sent" | "uncertain" | "failed" | "not-sent" } };

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
/** Messages a stop cancelled unseen are quoted in the entry of a text the operator sends within this time. */
const UNSEEN_KEPT_MS = 30 * 60_000;

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
  readonly #uploads = new AsyncSemaphore(2);
  /**
   * By space and member: the messages stops cancelled before the model saw them, until an entry tells the model of them
   * (the operator stops first and writes then, or a text could not be sent). In memory only.
   */
  readonly #unseen = new Map<string, { texts: string[]; at: number }>();

  constructor(options: TakeoverOptions) { this.#options = options; }

  /** The member's unseen messages with these added. */
  #keep(key: string, added: readonly string[]): string[] {
    const now = (this.#options.now ?? Date.now)();
    for (const [each, kept] of this.#unseen) if (now - kept.at > UNSEEN_KEPT_MS) this.#unseen.delete(each);
    const texts = [...this.#unseen.get(key)?.texts ?? [], ...added].slice(-WAITING_SHOWN);
    if (texts.length) this.#unseen.set(key, { texts, at: now });
    return texts;
  }

  /**
   * An entry told the model of these. Only they go: a stop from another console session while the text was going out
   * kept more, and those wait for the next entry.
   */
  #told(key: string, texts: readonly string[]): void {
    const kept = this.#unseen.get(key);
    if (!kept) return;
    const rest = [...kept.texts];
    for (const text of texts) {
      const at = rest.indexOf(text);
      if (at >= 0) rest.splice(at, 1);
    }
    if (rest.length) this.#unseen.set(key, { texts: rest, at: kept.at });
    else this.#unseen.delete(key);
  }

  /** The member of a conversation that exists, with the platform ID messages go to. */
  async #member(space: string, phone: string): Promise<{ scope: Scope; identity: DirectoryIdentity }> {
    const scope = scopeOfSpace(space);
    if (!scope || !existsSync(spaceDatabase(this.#options.layout, scope))) throw new TakeoverRefused("没有这个会话空间。");
    if (!await this.#options.host.hasConversation(scope, phone)) throw new TakeoverRefused("这位成员在这里还没有和机器人的对话。");
    const identity = this.#options.directory.byPhone(phone);
    if (!identity) throw new TakeoverRefused("这位成员已不在机器人同步的通讯录范围内，不能接管。");
    return { scope, identity };
  }

  async stop(space: string, phone: string): Promise<void> {
    const { scope } = await this.#member(space, phone);
    this.#keep(`${space}\n${phone}`, (await this.#options.host.halt(scope, phone)).waiting);
  }

  async say(space: string, phone: string, raw: string, attachment?: OperatorAttachment): Promise<SayResult> {
    const text = raw.trim();
    if (!text && !attachment) throw new TakeoverRefused("请输入要发给成员的内容，或选择图片／文件。");
    if ([...text].length > OPERATOR_TEXT_MAX) throw new TakeoverRefused(`一次最多发 ${OPERATOR_TEXT_MAX} 个字，请分几次发。`);
    const member = await this.#member(space, phone);
    // Validate and upload before stopping or sending anything. Failed uploads cannot leave half a reply behind.
    const signal = AbortSignal.any([this.#options.signal, AbortSignal.timeout(4 * 60_000)]);
    const uploaded = attachment ? await this.#upload(operatorAttachment(attachment.kind, attachment.file), signal) : undefined;
    // An upload can outlast a directory refresh; recheck membership and use the current recipient ID.
    const { scope, identity } = attachment ? await this.#member(space, phone) : member;
    signal.throwIfAborted();
    // First the bot stops: its answer must not land beside the operator's.
    const key = `${space}\n${phone}`;
    const waiting = this.#keep(key, (await this.#options.host.halt(scope, phone)).waiting);
    const { outbound } = this.#options;
    const target: Target = scope.kind === "direct" ? { kind: "direct", receiveId: identity.imUserId } : { kind: "group", receiveId: scope.groupId };
    const segments = text ? splitText(text) : scope.kind === "group" && attachment ? [`发送${attachment.kind === "image" ? "图片" : "文件"}：${escapeInline(attachment.file.name)}`] : [];
    const media: SayResult["attachment"] = attachment ? { name: attachment.file.name, kind: attachment.kind, sent: "not-sent" } : undefined;
    const total = segments.length + (uploaded ? 1 : 0);
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
      if (uploaded && media) {
        const result = await send(uploaded, { signal });
        media.sent = result.status;
        if (result.status === "failed") {
          if (!delivered.length) throw new TakeoverRefused(`附件没有发出去（${result.reason}），请稍后再试。`);
          return "partial";
        }
        if (result.status === "uncertain") sent = "uncertain";
        delivered.push(`[${media.kind === "image" ? "图片" : "文件"}] ${media.name}（${attachment!.file.size} 字节${result.status === "uncertain" ? "，平台未确认送达" : "，已发送"}）`);
      }
      return sent;
    }, signal);
    // What the member has is what the bot is told.
    const recorded = await this.#record(scope, phone, delivered.join("\n"), waiting);
    if (recorded) this.#told(key, waiting);
    return { sent: outcome, recorded, ...(outcome === "partial" ? { segments: { sent: delivered.length, total } } : {}), ...(media ? { attachment: media } : {}) };
  }

  async #upload(attachment: OperatorAttachment, signal: AbortSignal): Promise<OutboundMessage> {
    const release = await this.#uploads.acquire(signal);
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), "mixin-operator-"));
      const path = join(directory, "attachment"), { file, kind } = attachment;
      await writeFile(path, new Uint8Array(await file.arrayBuffer()), { flag: "wx", mode: 0o600, signal });
      const source = { path, name: file.name, size: file.size };
      if (kind === "image") {
        const image = await imageInfo(path);
        if (!image) throw new TakeoverRefused("无法识别图片，请选择 PNG、JPEG、GIF、WebP 或 BMP；其他格式可按文件发送。");
        const fileId = await this.#options.outbound.upload({ path, fileName: file.name, size: file.size, mimeType: `image/${image.format === "jpg" ? "jpeg" : image.format}` }, signal);
        return imageMessage({ fileId, width: image.width, height: image.height, mimeType: image.format });
      }
      return uploadedFile(await this.#options.outbound.upload(fileUpload(source), signal), source);
    } catch (error) {
      if (error instanceof TakeoverRefused) throw error;
      throw new TakeoverRefused("附件上传失败，尚未发送任何内容，请稍后重试。");
    } finally { try { if (directory) await rm(directory, { recursive: true, force: true }); } finally { release(); } }
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
