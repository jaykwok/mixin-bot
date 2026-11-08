import { createHash, randomUUID } from "node:crypto";
import { readlinkSync, realpathSync } from "node:fs";
import { link, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { setTimeout } from "node:timers/promises";
import { descriptorPath } from "./darwin.ts";

/**
 * mode: the new file's permission bits (0600 unless a reader under another identity needs more).
 * within: a directory the writer trusts (the project) when the directories below it may belong to another account. The new
 * file must really be at its path under it: one created through a directory replaced by a link is removed again and refused,
 * so a root writer never leaves a file of its choosing elsewhere (Linux and macOS).
 */
export interface PublishOptions { owner?: { uid: number; gid: number }; createOnly?: boolean; mode?: number; within?: string }
export async function publish(path: string, value: Uint8Array | string | AsyncIterable<Uint8Array>, options: PublishOptions = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + ".atomic-" + randomUUID();
  try {
    const handle = await open(temporary, "wx", options.mode ?? 0o600);
    try {
      if (options.within && process.platform !== "win32") {
        const actual = process.platform === "darwin" ? descriptorPath(handle.fd) : readlinkSync(`/proc/self/fd/${handle.fd}`);
        if (actual !== join(realpathSync(options.within), relative(options.within, temporary))) {
          await unlink(actual).catch(() => {});
          throw new Error(`写入位置经过了被替换的目录：${dirname(path)}`);
        }
      }
      if (typeof value === "string" || value instanceof Uint8Array) await handle.writeFile(value);
      else for await (const chunk of value) await handle.writeFile(chunk);
      if (options.owner && process.platform !== "win32") await handle.chown(options.owner.uid, options.owner.gid);
      await handle.sync();
    } finally { await handle.close(); }
    for (let attempt = 0; ; attempt++) {
      try { if (options.createOnly) await link(temporary, path); else await rename(temporary, path); break; }
      catch (error) {
        if (process.platform !== "win32" || attempt >= 6 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await setTimeout(25 * 2 ** attempt);
      }
    }
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
/** The bytes publishJson writes for a value. */
export const jsonText = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
export const publishJson = (path: string, value: unknown, options?: PublishOptions) => publish(path, jsonText(value), options);

export const digest = (value: Uint8Array | null) => value === null ? null : createHash("sha256").update(value).digest("hex");
