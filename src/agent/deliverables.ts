import { constants } from "node:fs";
import { copyFile, mkdir, open, stat, unlink, realpath, lstat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, extname, join } from "node:path";
import { isPathInside } from "../contracts/paths.ts";
import { SNAPSHOT_DIRECTORY } from "./tool-path.ts";
import { type Deliverable, fileSendOutcome, openPart, type RequestRecord } from "../durable/records.ts";

/** Streaming, abortable digest: large relay files do not occupy the JavaScript heap. */
export async function fileDigest(path: string, signal?: AbortSignal, maxBytes = Number.MAX_SAFE_INTEGER): Promise<string> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error("文件不是普通文件或超过交付大小上限");
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(256 * 1024);
    let total = 0;
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error("文件增长超过交付大小上限");
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally { await file.close(); }
}

/** Copy before recording; check both sides so later edits cannot change a registered version. */
export async function freezeFile(sourcePath: string, tempDir: string, requestId: string, maxBytes: number, signal?: AbortSignal, sourceDigest?: string) {
  const sha256 = sourceDigest ?? await fileDigest(sourcePath, signal, maxBytes);
  const parent = await realpath(tempDir), root = join(parent, SNAPSHOT_DIRECTORY);
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) throw new Error("交付快照目录不能是链接");
  const dir = join(root, createHash("sha256").update(requestId).digest("hex").slice(0, 24), randomUUID());
  await mkdir(dir, { recursive: true });
  if (await realpath(dir) !== dir) throw new Error("交付快照目录越界");
  const name = basename(sourcePath), path = join(dir, name);
  try {
    await copyFile(sourcePath, path, constants.COPYFILE_EXCL);
    if (sha256 !== await fileDigest(path, signal, maxBytes)) throw new Error("复制期间源文件变化，请完成生成后重新登记");
    return { path, name, sha256, size: (await stat(path)).size };
  } catch (error) { await unlink(path).catch(() => {}); throw error; }
}

/** Structural completeness only; never a claim that content or layout has been reviewed. */
export async function completeFile(path: string, format: string): Promise<boolean> {
  const f = await open(path, "r");
  try {
    const { size } = await f.stat();
    if (!size) return false;
    const read = async (position: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await f.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead);
    };
    if (format === "pdf") return (await read(0, 5)).toString() === "%PDF-" &&
      (await read(Math.max(0, size - 1024), Math.min(size, 1024))).includes(Buffer.from("%%EOF"));
    const main = ({ docx: "word/document.xml", pptx: "ppt/presentation.xml", xlsx: "xl/workbook.xml" } as Record<string, string>)[format];
    if (!main) return true;
    const tail = await read(Math.max(0, size - 65557), Math.min(size, 65557));
    let end = -1;
    for (let n = tail.length - 22; n >= 0; n--) if (tail.readUInt32LE(n) === 0x06054b50 && n + 22 + tail.readUInt16LE(n + 20) === tail.length) { end = n; break; }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) return false;
    const count = tail.readUInt16LE(end + 10), length = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
    // ZIP64 / multi-disk files are not treated as complete by this inexpensive check.
    if (count === 0xffff || length > 16 * 1024 * 1024 || offset + length > size - tail.length + end) return false;
    const directory = await read(offset, length), names = new Set<string>();
    let pos = 0;
    for (let i = 0; i < count; i++) {
      if (pos + 46 > directory.length || directory.readUInt32LE(pos) !== 0x02014b50) return false;
      const nameLength = directory.readUInt16LE(pos + 28), extra = directory.readUInt16LE(pos + 30), comment = directory.readUInt16LE(pos + 32);
      if (directory.readUInt32LE(pos + 42) >= offset || pos + 46 + nameLength + extra + comment > directory.length) return false;
      names.add(directory.subarray(pos + 46, pos + 46 + nameLength).toString()); pos += 46 + nameLength + extra + comment;
    }
    return pos === directory.length && names.has("[Content_Types].xml") && names.has(main);
  } catch { return false; } finally { await f.close(); }
}

const nextSeq = (all: readonly Deliverable[]) => all.reduce((max, each) => Math.max(max, each.seq), 0) + 1;

/** At most 3 deliverables (slots) and 8 versions per request, counting what the model registered. */
export function registerDeliverable(record: RequestRecord, entry: Omit<Deliverable, "id" | "seq" | "at" | "auto">, now = Date.now()): Deliverable {
  const previous = record.deliverables, own = previous.filter(each => !each.auto);
  if (own.length >= 8) throw new Error("本任务最多登记 8 个版本，请发送已登记的最佳版本");
  if (!own.some(each => each.slot === entry.slot) && new Set(own.map(each => each.slot)).size >= 3) throw new Error("本任务最多登记 3 个交付物");
  const next: Deliverable = { ...entry, id: randomUUID(), seq: nextSeq(previous), at: now };
  previous.push(next);
  return next;
}

/** Slots that keep a service-saved draft; older ones give way. */
export const AUTO_DRAFT_SLOTS = 3;

/**
 * A file a document tool produced, saved as an unchecked draft without the model asking: the newest per slot, in at most
 * `AUTO_DRAFT_SLOTS` slots, outside the model's limits. Nothing is added when these bytes are registered already.
 * `dropped` are the snapshots of the drafts this one replaced that nothing in the record refers to any more.
 */
export function registerAutoDraft(record: RequestRecord, entry: Omit<Deliverable, "id" | "seq" | "at" | "auto" | "status" | "checked" | "unchecked" | "issues">,
  now = Date.now()): { added?: Deliverable; dropped: string[] } {
  const all = record.deliverables;
  if (all.some(each => each.sha256 === entry.sha256)) return { dropped: [] };
  const added: Deliverable = { ...entry, id: randomUUID(), seq: nextSeq(all), at: now, auto: true,
    status: "draft", checked: [], unchecked: ["系统自动保存的生成结果，未经检查"], issues: [] };
  const slots = [...new Set(all.filter(each => each.auto && each.slot !== entry.slot).map(each => each.slot))]
    .sort((a, b) => nextSeq(all.filter(each => each.auto && each.slot === b)) - nextSeq(all.filter(each => each.auto && each.slot === a)));
  const kept = new Set(slots.slice(0, AUTO_DRAFT_SLOTS - 1));
  const removed = all.filter(each => each.auto && !kept.has(each.slot));
  record.deliverables = [...all.filter(each => !removed.includes(each)), added];
  const used = new Set([...record.deliverables.map(each => each.path), ...record.files.map(each => each.path)]);
  return { added, dropped: [...new Set(removed.map(each => each.path))].filter(path => !used.has(path)) };
}

/**
 * The complete, not rejected versions of every slot that has any, best first: checked before draft, newest first. A
 * service-saved draft competes like any draft in its slot.
 */
export function slotVersions(record: Pick<RequestRecord, "deliverables">): Deliverable[][] {
  const all = record.deliverables, rejected = new Set(all.filter(x => x.status === "rejected").map(x => x.sha256));
  return [...new Set(all.map(x => x.slot))].flatMap(slot => {
    const versions = all.filter(x => x.slot === slot && x.complete && !rejected.has(x.sha256)).sort((a, b) =>
      Number(b.status === "checked") - Number(a.status === "checked") || b.seq - a.seq);
    return versions.length ? [versions] : [];
  });
}

/**
 * The slots the fallback delivers, with their versions best first. What the model registered says what the deliverables
 * are, so slots holding only service-saved drafts (intermediate files, mostly) are left out then; when the model
 * registered nothing it can send, the saved drafts are all there is.
 */
export function fallbackSlots(record: Pick<RequestRecord, "deliverables" | "files">): Deliverable[][] {
  const slots = slotVersions(record), own = slots.filter(versions => versions.some(version => !version.auto));
  if (own.length) return own;
  // A saved draft older than the last file the run itself sent was a step on the way to that file, unless it is that file.
  const sends = record.files.filter(file => fileSendOutcome(file) !== undefined);
  const last = sends.reduce((at, file) => Math.max(at, file.at), -Infinity), sent = new Set(sends.map(file => file.sha256));
  return slots.filter(versions => versions[0]!.at > last || sent.has(versions[0]!.sha256));
}

/** The best version of every slot the model registered a sendable version in: what it is reminded to send. */
export function deliverableCandidates(record: Pick<RequestRecord, "deliverables">): Deliverable[] {
  return slotVersions(record).filter(versions => versions.some(version => !version.auto)).map(versions => versions[0]!);
}

/**
 * The registered deliverable a name stands for, with its versions best first: the slot as registered, or the name with or
 * without the file's extension, in any letter case; a path stands for its last segment. Undefined when no slot or more
 * than one matches.
 */
export function deliverableNamed(record: Pick<RequestRecord, "deliverables">, name: string): Deliverable[] | undefined {
  const slots = slotVersions(record), wanted = name.trim();
  const exact = slots.filter(versions => versions[0]!.slot === wanted);
  if (exact.length === 1) return exact[0];
  const fold = (value: string) => value.toLocaleLowerCase(), given = new Set([wanted, wanted.split(/[\\/]/).at(-1)!].map(fold));
  const loose = slots.filter(versions => versions.some(version => [version.slot, version.name, basename(version.name, extname(version.name))]
    .some(each => given.has(fold(each)))));
  return loose.length === 1 ? loose[0] : undefined;
}

/** Snapshots of a closed request that no delivery part still to be sent needs. */
export function releasableSnapshots(record: Readonly<RequestRecord>): string[] {
  const open = record.delivery?.abandoned === undefined ? record.delivery?.parts.filter(openPart) ?? [] : [];
  const keep = new Set(open.filter(part => part.kind === "file").map(part => part.file!.path));
  const paths = new Set([...record.deliverables.map(x => x.path), ...record.files.map(x => x.path)]);
  return [...paths].filter(path => !keep.has(path));
}

/** Delete snapshot files; only inside the member tmp `.deliverables` directory, missing files are fine. */
export async function deleteSnapshots(paths: readonly string[], tempDir: string): Promise<void> {
  let root: string | undefined;
  for (const path of paths) {
    try {
      root ??= join(await realpath(tempDir), SNAPSHOT_DIRECTORY);
      const actual = await realpath(path);
      if (actual === root || !isPathInside(actual, root)) throw new Error("交付快照清理路径越界");
      await unlink(actual);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
