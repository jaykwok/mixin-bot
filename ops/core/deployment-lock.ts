// The existing deploy.lock, shared with flock in Bash and FileShare.None in PowerShell.
// Its pathname is permanent: releasing a lock never unlinks/replaces the file.
import { dlopen, FFIType, ptr, read } from "bun:ffi";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { WindowsHandles } from "../../src/core/windows-handles.ts";
import { AT_FDCWD, close, descriptorPath, O, openAt, tryLock } from "../../src/lib/darwin.ts";
import { MaintenanceRefused } from "./maintenance.ts";

export class DeploymentBusy extends MaintenanceRefused {
  constructor() { super("部署、升级或另一个维护操作正在进行；未执行操作"); }
}
export interface DeploymentLock {
  readonly path: string;
  /** Called again before mutations; on Linux and macOS, a removed/replaced lock is no longer exclusive for this pathname. */
  assertHeld(): void;
  close(): void;
}

let libc: ReturnType<typeof linuxNative> | undefined;
function linuxNative() {
  return dlopen("libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  }).symbols;
}
/** Non-blocking exclusive flock; false when another open file description holds it. */
function lockFile(fd: number): boolean {
  if (process.platform === "darwin") return tryLock(fd);
  const native = libc ??= linuxNative();
  if (native.flock(fd, 2 | 4) === 0) return true; // LOCK_EX | LOCK_NB
  const errno = read.i32(native.__errno_location()!);
  if (errno === 11) return false; // EWOULDBLOCK
  throw new Error(`无法取得部署锁（flock errno ${errno}）`);
}
const longPath = (path: string) => path.startsWith("\\\\?\\") ? path
  : path.startsWith("\\\\") ? "\\\\?\\UNC\\" + path.slice(2) : "\\\\?\\" + path;
// ops.sh keeps deploy.lock on descriptor 9 for a whole update and exports its path (acquire_deploy_lock). That open file
// description already owns the flock, so a fresh open would conflict with our own parent. Adopt fd 9 only when it is
// still that same file; the parent closes it, never this process: an explicit unlock would release the parent's lock too.
function inheritedLock(path: string): number | undefined {
  if (process.env.BOT_DEPLOY_LOCK_HELD !== path) return undefined;
  try {
    const held = fstatSync(9, { bigint: true }), named = lstatSync(path, { bigint: true });
    return held.isFile() && named.isFile() && held.dev === named.dev && held.ino === named.ino ? 9 : undefined;
  } catch { return undefined; }
}

/**
 * macOS: data/ belongs to the service account, which could put a link in place of data or data/state. The lock is opened
 * from the project directory (the operator's) one level at a time without following a link, so root never creates or locks
 * a file elsewhere. Mode 0644: the account's offline proof opens it to test the lock.
 */
function openDarwinLock(project: string): number {
  const opened: number[] = [];
  try {
    let dir = openAt(AT_FDCWD, project, O.RDONLY | O.DIRECTORY);
    opened.push(dir);
    for (const name of ["data", "state"]) { dir = openAt(dir, name, O.RDONLY | O.DIRECTORY | O.NOFOLLOW); opened.push(dir); }
    return openAt(dir, "deploy.lock", O.CREAT | O.RDWR | O.NOFOLLOW | O.NONBLOCK, 0o644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP" || (error as NodeJS.ErrnoException).code === "ENOTDIR") throw new Error("部署锁的路径含有链接，未继续操作");
    throw error;
  } finally { for (const fd of opened) close(fd); }
}

/** Non-blocking, same native lock as the shipping CLI; it is not a PID file or a second lock namespace. */
export function acquireDeploymentLock(project: string): DeploymentLock {
  if (!["linux", "darwin", "win32"].includes(process.platform)) throw new Error("此平台不支持部署锁");
  const state = join(resolve(project), "data", "state");
  if (process.platform === "darwin") {
    for (const path of [join(resolve(project), "data"), state]) {
      try { if (lstatSync(path).isSymbolicLink()) throw new Error("部署锁的路径含有链接，未继续操作"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  mkdirSync(state, { recursive: true });
  const directory = realpathSync(state), path = join(directory, "deploy.lock");
  let closed = false, closeError: unknown;
  const assertOpen = () => { if (closed) throw new Error("部署锁已经释放"); };
  if (process.platform !== "win32") {
    const inherited = inheritedLock(path);
    const darwin = process.platform === "darwin", root = realpathSync(resolve(project));
    const fd = inherited ?? (darwin ? openDarwinLock(root) : openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600));
    const release = () => { if (inherited === undefined) closeSync(fd); };
    try {
      const held = fstatSync(fd, { bigint: true });
      if (!held.isFile()) throw new Error("部署锁不是普通文件");
      // The lock this project names: on macOS exactly data/state/deploy.lock of the project, and the file it opened.
      if (darwin && (path !== join(root, "data", "state", "deploy.lock") || descriptorPath(fd) !== path)) throw new Error("部署锁路径已被替换，未继续操作");
      if (!lockFile(fd)) throw new DeploymentBusy();
      // macOS: the service account's offline proof opens the lock to test it; root's own lock (never a second name) is readable to it.
      if (darwin && process.geteuid?.() === 0 && held.uid === 0n && held.nlink === 1n && (Number(held.mode) & 0o777) !== 0o644) fchmodSync(fd, 0o644);
      const lock: DeploymentLock = {
        path,
        assertHeld() {
          assertOpen();
          const current = lstatSync(path, { bigint: true });
          if (!current.isFile() || current.dev !== held.dev || current.ino !== held.ino || realpathSync(state) !== directory) {
            throw new Error("部署锁路径已被替换，未继续操作");
          }
        },
        close() {
          if (closed) { if (closeError) throw closeError; return; }
          closed = true;
          try { release(); } catch (error) { closeError = error; throw error; }
        },
      };
      lock.assertHeld();
      return lock;
    } catch (error) {
      try { release(); } catch (cleanup) { throw new AggregateError([error, cleanup], "部署锁打开失败且句柄无法关闭"); }
      throw error;
    }
  }

  const resources = new WindowsHandles({ observe: () => {} }), native = resources.native;
  const wide = Buffer.from(longPath(path) + "\0", "utf16le");
  // No inheritable SECURITY_ATTRIBUTES, no FILE_SHARE_DELETE, OPEN_ALWAYS without truncation.
  const value = native.CreateFileW(ptr(wide), 0xc0000000, 0, null, 4, 0x00200080, null) as bigint;
  if (value === -1n) {
    const code = native.GetLastError();
    if (code === 32 || code === 33) throw new DeploymentBusy();
    throw resources.error("hold deployment lock", path, code);
  }
  const held = resources.own(value, path, "CreateFileW");
  try {
    const info = new Uint8Array(52);
    if (!native.GetFileInformationByHandle(held.value, ptr(info))) throw resources.error("inspect deployment lock", path, native.GetLastError());
    if ((new DataView(info.buffer).getUint32(0, true) & (0x400 | 0x10)) !== 0) throw new Error("部署锁是链接或目录");
    const lock: DeploymentLock = {
      path,
      assertHeld() {
        assertOpen();
        const name = new Uint16Array(32768), size = native.GetFinalPathNameByHandleW(held.value, ptr(name), name.length, 0);
        if (!size || size >= name.length) throw resources.error("read deployment lock path", path, native.GetLastError());
        const actual = new TextDecoder("utf-16le").decode(name.subarray(0, size));
        if (actual.toLowerCase() !== longPath(path).toLowerCase() || realpathSync(state).toLowerCase() !== directory.toLowerCase()) {
          throw new Error("部署锁路径已被替换，未继续操作");
        }
      },
      close() {
        if (closed) { if (closeError) throw closeError; return; }
        closed = true;
        try { held.close(); } catch (error) { closeError = error; throw error; }
      },
    };
    lock.assertHeld();
    return lock;
  } catch (error) {
    try { held.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "部署锁打开失败且句柄无法关闭"); }
    throw error;
  }
}

export async function withDeploymentLock<T>(project: string, work: (lock: DeploymentLock) => Promise<T>): Promise<T> {
  const lock = acquireDeploymentLock(project);
  let cause: unknown;
  try { return await work(lock); }
  catch (error) { cause = error; throw error; }
  finally {
    try { lock.close(); }
    catch (error) { if (cause) throw new AggregateError([cause, error], "维护失败且部署锁无法释放"); throw error; }
  }
}
