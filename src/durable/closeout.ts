import type { Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { defineExtension, type DocumentReader, GenerationTask, ToolTask, hook, type HookApi, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { arr, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { basename, extname } from "node:path";
import { unlink } from "node:fs/promises";
import { completeFile, deleteSnapshots, deliverableCandidates, freezeFile, registerAutoDraft, registerDeliverable } from "../agent/deliverables.ts";
import { BASH_DEFAULT_TIMEOUT, NATIVE_FILE_MAX_BYTES } from "../core/config.ts";
import { resolveSource } from "../agent/send-tools.ts";
import { IdentityDoc } from "./identity.ts";
import { InboxDoc } from "./inbox.ts";
import { fileSendOutcome, memberRecords, recordsOf, type RequestRecord } from "./records.ts";
import { memberTool, type BaseToolsOptions, type MemberPlaces, type MemberToolSpec } from "./tools.ts";
import { log } from "../core/log.ts";

export interface CloseoutTiming { closeoutMs: number; reserveMs: number; fallbackMs: number }
export function validateCloseout(timing: CloseoutTiming, runTimeoutMs: number): void {
  if (![timing.closeoutMs, timing.reserveMs, timing.fallbackMs].every(x => Number.isSafeInteger(x) && x > 0) ||
    timing.reserveMs >= timing.closeoutMs || timing.closeoutMs >= runTimeoutMs / 2) {
    throw new Error("收尾配置无效：交付保留时间须小于收尾时间，收尾时间须小于任务总时限的一半；各时间须为正数");
  }
}
/** The running inbox item of the calling conversation, with its member and run record. */
export async function activeRequest(api: Pick<DocumentReader, "snapshot"> & Pick<HookApi, "conversationId">, context: Context) {
  const head = (await api.snapshot(InboxDoc, api.conversationId, context))?.items[0];
  if (!head || head.startedAt === undefined || head.cancelled) return;
  const identity = await api.snapshot(IdentityDoc, api.conversationId, context);
  if (!identity?.phone) return;
  const record = (await memberRecords(api, identity.phone, context)).requests[head.requestId];
  if (!record) return;
  return { requestId: head.requestId, startedAt: head.startedAt, phone: identity.phone, space: identity.space, record };
}

/** Change one run record in its own commit (hooks have no transaction of their own). */
export type RecordWriter = (phone: string, requestId: string, change: (record: RequestRecord) => void) => Promise<void>;
export function phase(remaining: number, timing: CloseoutTiming): "常规" | "收尾" | "交付" {
  return remaining <= timing.reserveMs ? "交付" : remaining <= timing.closeoutMs ? "收尾" : "常规";
}
export function appendTiming(messages: readonly Message[], text: string, now: number): Message[] {
  const last = messages.at(-1);
  if (last?.role === "user") {
    const content = typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : [...last.content];
    return [...messages.slice(0, -1), { ...last, content: [...content, { type: "text", text }] }];
  }
  return [...messages, { role: "user", content: [{ type: "text", text }], timestamp: now }];
}
export async function closeoutTool(name: string, args: unknown, api: ToolExecutionApi, context: Context, timing: CloseoutTiming, runTimeoutMs: number) {
  const item = await activeRequest(api, context);
  if (!item) return args;
  const remaining = item.startedAt + runTimeoutMs - Date.now(), stage = phase(remaining, timing);
  if (stage === "交付" && !["send_file", "send_image", "deliverable_register", "read"].includes(name)) {
    throw new Error(`任务只剩 ${Math.max(0, Math.ceil(remaining / 1000))} 秒，已进入交付阶段；仅允许 read、deliverable_register、send_file、send_image。请立即交付已登记版本。`);
  }
  if (name === "bash") {
    const params = args as { timeout?: number };
    const available = Math.floor((remaining - timing.reserveMs) / 1000);
    if (available < 1) throw new Error("剩余时间已保留给交付，不能启动新命令");
    return { ...params, timeout: Math.min(params.timeout ?? BASH_DEFAULT_TIMEOUT, available) };
  }
  return args;
}

const DOCUMENT_TOOLS = ["document_build", "document_compose", "document_patch"];

/**
 * The server's local date and time to the minute with its UTC offset, e.g. `2026-11-02 15:34（服务器时区 UTC+08:00）`. The
 * prompt replaces Pi's default, so nothing else tells the model the date or the time; relative times such as a push deadline
 * "15 分钟后" need the time of day, which the model would otherwise look up with bash.
 */
export function localTime(now: number): string {
  const date = new Date(now), offset = -date.getTimezoneOffset(), pad = (value: number) => String(value).padStart(2, "0");
  const zone = `UTC${offset < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}（服务器时区 ${zone}）`;
}

/**
 * The countdown and, given `requestTmp`, the request's temp directory go into the tail of every model call, never into the
 * history; the system prompt stays the same for every member and request.
 */
export function closeoutExtension(write: RecordWriter, timing: CloseoutTiming, runTimeoutMs: number,
  places?: (phone: string, requestId: string) => MemberPlaces) {
  return defineExtension({ name: "mixin.clock", hooks: [
    hook(GenerationTask, {
      async beforeRequest(request, api, context) {
        const item = await activeRequest(api, context); if (!item) return;
        const now = Date.now(), deadline = item.startedAt + runTimeoutMs, remaining = Math.max(0, deadline - now), stage = phase(remaining, timing);
        const seconds = Math.ceil(remaining / 1000), versions = Object.values(item.record.events).filter(x => DOCUMENT_TOOLS.includes(x.name)).length;
        const registered = deliverableCandidates(item.record), sent = item.record.files.filter(x => fileSendOutcome(x) === "sent").length;
        const direction = stage === "交付" ? "立即登记并发送最佳可交付版本，回复里一句话说明发了什么，有已知问题才提。" : stage === "收尾" ? "停止美化及非必要重建；先登记最佳版本再发送，只修正事实错误。" : "";
        // Counts only once there is something to count: a plain question should not be steered towards files.
        const counts = [versions ? `本任务已生成文档 ${versions} 版` : "", registered.length ? `已登记交付物 ${registered.length} 个` : "", sent ? `已发送 ${sent} 个` : ""]
          .filter(Boolean).map(part => "；" + part).join("");
        const text = `[任务计时] 剩余 ${Math.floor(seconds / 60)}分${seconds % 60}秒；阶段：${stage}；现在是 ${localTime(now)}${counts}。${direction}${versions >= 4 ? "除修正事实错误外不要再重建。" : ""}`
          + (places ? `\n[临时目录] ${places(item.phone, item.requestId).requestDir!.replace(/\\/g, "/")}` : "");
        return { messages: appendTiming(request.messages, text, now) };
      },
      async onYield(_answer, api, context) {
        const item = await activeRequest(api, context); if (!item) return;
        if (item.record.events.delivery_reminder) return;
        // A deliverable is taken care of once any version of it went out: the model may have sent a newer build of the
        // same name (saved by the service) than the one it registered.
        const sent = new Set(item.record.files.filter(s => fileSendOutcome(s) !== undefined).map(s => s.sha256));
        const missing = deliverableCandidates(item.record).filter(x => !item.record.deliverables.some(each => each.slot === x.slot && sent.has(each.sha256)));
        if (!missing.length) return;
        await write(item.phone, item.requestId, record => { record.events.delivery_reminder ??= { name: "delivery_reminder", at: Date.now() }; });
        return { continue: `你登记了 ${missing.map(x => `《${x.name}》`).join("、")} 但尚未发送；请立即发送。如果不需要发送，请在回复中说明原因。` };
      },
    }),
    hook(ToolTask, { async afterTool(call, result, api, context) {
      if (result.isError || !["document_build", "document_compose", "document_patch", "document_render"].includes(call.name)) return;
      const item = await activeRequest(api, context); if (!item) return;
      const output = (result.structuredOutput ?? result.details) as Record<string, unknown> | undefined;
      const field = (name: string) => output && typeof output === "object" && typeof output[name] === "string" ? output[name] as string : undefined;
      const digest = field("digest"), produced = field("output");
      await write(item.phone, item.requestId, record => { record.events[`${api.taskId}/${call.id}`] ??= { name: call.name, ...(digest ? { digest } : {}), at: Date.now() }; });
      if (places && produced && digest && DOCUMENT_TOOLS.includes(call.name)) {
        // The file is the tool's result either way: a draft that could not be saved only loses the fallback for it.
        await saveDraft(write, item, places(item.phone, item.requestId), produced, digest, context.abortSignal)
          .catch(error => log.warn(`生成结果未能自动保存为草稿：${error instanceof Error ? error.message : String(error)}`));
      }
      return undefined;
    } }),
  ] });
}

/**
 * Keep what a document tool just produced as an unchecked draft of the request, so that a run that ends without the model
 * registering anything still has something to deliver. The copy is made before the record names it.
 */
async function saveDraft(write: RecordWriter, item: { phone: string; requestId: string; record: Readonly<RequestRecord> }, places: MemberPlaces,
  output: string, digest: string, signal?: AbortSignal): Promise<void> {
  if (item.record.deliverables.some(each => each.sha256 === digest)) return;
  const source = await resolveSource(output, places.workspaceDir, places.tempDir, signal);
  if (source.kind !== "local" || source.size > NATIVE_FILE_MAX_BYTES) return;
  const frozen = await freezeFile(source.path, places.tempDir, item.requestId, NATIVE_FILE_MAX_BYTES, signal, digest);
  let outcome: ReturnType<typeof registerAutoDraft> | undefined;
  try {
    const complete = await completeFile(frozen.path, extname(frozen.name).slice(1).toLowerCase());
    await write(item.phone, item.requestId, record => {
      outcome = registerAutoDraft(record, { ...frozen, slot: basename(frozen.name, extname(frozen.name)), complete });
    });
  } finally {
    await deleteSnapshots([...(outcome?.added ? [] : [frozen.path]), ...(outcome?.dropped ?? [])], places.tempDir).catch(() => {});
  }
}

const registerParams = obj({
  path: str(), slot: opt(str({ maxLength: 120 })),
  status: oneOf(["checked", "draft", "rejected"]),
  checked: arr(str({ maxLength: 300 }), { maxItems: 10 }),
  unchecked: arr(str({ maxLength: 300 }), { maxItems: 10 }),
  issues: arr(str({ maxLength: 300 }), { maxItems: 10 }),
}, { open: true });
/** What the service adds to `unchecked` when a Word or PowerPoint version is registered as checked without a rendering of it. */
export const UNRENDERED = "版式（这个版本没有看过排版效果）";

/** deliverable_register (model-only): an immutable copy of a generated file, for send_file and the closeout fallback. */
export function deliverableTool(options: BaseToolsOptions, maxBytes = NATIVE_FILE_MAX_BYTES) {
  const spec: MemberToolSpec<typeof registerParams> = {
    name: "deliverable_register", callers: ["model"],
    description: "登记文件的不可变副本并说明检查情况，供 send_file 按名称发送和失败时自动交付。document_build、document_compose、document_patch 的结果已由系统自动保存为未检查草稿，不必登记 draft；检查后登记 checked，写明查了什么、没查什么。其他方式生成的文件需要失败时自动交付的，登记 draft。图片、参数、事实错误必须登记 rejected。docx/pptx 的这个版本没有 document_render 记录时，系统在未检查项注明版式未看图。每任务最多登记 3 个交付物、8 个版本。登记不等于发送，也不证明内容已核对。",
    parameters: registerParams,
    async run(params, member, call) {
      const { signal } = call;
      const item = await activeRequest(call.api, call.context); if (!item) throw new Error("没有正在执行的任务，不能登记交付物");
      const source = await resolveSource(params.path, member.places.workspaceDir, member.places.tempDir, signal);
      if (source.kind !== "local") throw new Error("只能登记当前用户 tmp 或共享资料 workspace 内的文件");
      const frozen = await freezeFile(source.path, member.places.tempDir, item.requestId, maxBytes, signal);
      try {
        const format = extname(frozen.name).slice(1).toLowerCase();
        const complete = await completeFile(frozen.path, format);
        // Whether the layout was looked at is a fact of the run: these bytes were rendered or they were not. It is noted
        // from the run's own record, never read out of how the model worded its checks.
        const unrendered = ["docx", "pptx"].includes(format) && params.status === "checked"
          && !Object.values(item.record.events).some(x => x.name === "document_render" && x.digest === frozen.sha256);
        const entry = { ...frozen, slot: params.slot?.trim() || basename(source.path, extname(source.path)), complete, status: params.status,
          checked: params.checked, unchecked: [...params.unchecked, ...(unrendered ? [UNRENDERED] : [])], issues: params.issues };
        const record = await call.api.commit(async tx => {
          const current = (await recordsOf(tx, item.phone)).requests[item.requestId];
          if (!current || current.closedAt !== undefined) throw new Error("任务已结束，不能再登记交付物");
          return structuredClone(registerDeliverable(current, entry));
        }, call.context);
        const send = `发送：send_file 的 deliverable 填 ${JSON.stringify(record.slot)}`;
        const message = !complete ? "文件结构不完整，不会自动发送"
          : record.status === "rejected" ? "已登记为不可用版本，不会自动发送"
          : unrendered ? `已登记。这个版本没有 document_render 的记录，未检查项里已注明版式未看图；要说明版式已检查，先渲染这个版本再登记。${send}`
          : `已登记。${send}`;
        // The snapshot's path stays out of the answer: it is gone when the request ends, and send_file takes the name.
        const { slot, name, seq, status, size, checked, unchecked, issues } = record;
        return { output: [{ type: "text", text: JSON.stringify({ slot, name, seq, status, complete, size, checked, unchecked, issues, message }) }],
          details: record, ...(complete ? {} : { isError: true }) };
      } catch (error) { await unlink(frozen.path).catch(() => {}); throw error; }
    },
  };
  return memberTool(spec, options);
}
