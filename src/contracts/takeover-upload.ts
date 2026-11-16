// Browser → console → bot: bytes only, never a path supplied by the browser or shared with a container.
import { NATIVE_FILE_MAX_BYTES } from "./transfer-limits.ts";

export interface OperatorAttachment { kind: "image" | "file"; file: File }
export class TakeoverUploadError extends Error { override name = "TakeoverUploadError"; }
const fail = (message: string): never => { throw new TakeoverUploadError(message); };

export function operatorAttachment(kind: unknown, file: unknown): OperatorAttachment {
  if (kind !== "image" && kind !== "file") fail("请选择发送图片或文件");
  if (!(file instanceof File) || !file.size || file.size > NATIVE_FILE_MAX_BYTES) fail("请选择非空文件，单个附件不能超过 30 MB");
  const attachment = file as File;
  if (!attachment.name || attachment.name.length > 240 || /[\\/\x00-\x1f\x7f]/.test(attachment.name)) fail("附件文件名无效");
  return { kind: kind as OperatorAttachment["kind"], file: attachment };
}

/** Bounded before multipart parsing, including chunked bodies and duplicate form fields. */
export async function readTakeoverUpload(request: Request, alive: () => boolean = () => true): Promise<{ metadata: Record<string, unknown>; attachment: OperatorAttachment }> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data;\s*boundary=/i.test(type) || !request.body) fail("附件上传格式无效");
  const limit = NATIVE_FILE_MAX_BYTES + 64 * 1024;
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) fail("附件上传超过 30 MB");
  const reader = request.body!.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      request.signal.throwIfAborted(); if (!alive()) fail("登录已失效，请重新登录");
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength; if (size > limit) fail("附件上传超过 30 MB");
      chunks.push(chunk.value);
    }
    if (!alive()) fail("登录已失效，请重新登录");
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const form = await new Response(bytes, { headers: { "content-type": type } }).formData().catch(() => fail("附件上传不完整"));
    if ([...form.keys()].length !== 2 || form.getAll("message").length !== 1 || form.getAll("file").length !== 1) fail("一次只支持一个图片或文件");
    const message = form.get("message"); if (typeof message !== "string" || message.length > 20_000) fail("附件说明无效");
    const metadata: unknown = JSON.parse(message as string);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) fail("附件说明无效");
    const fields = metadata as Record<string, unknown>;
    return { metadata: fields, attachment: operatorAttachment(fields.kind, form.get("file")) };
  } catch (error) {
    if (error instanceof SyntaxError) fail("附件说明无效");
    throw error;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
