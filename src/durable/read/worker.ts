// The bot's read-only thread for the host console. One operation at a time, each in its own short read transaction
// (`BEGIN ... COMMIT`); never on the shared write thread (sqlite-client.ts). Actively queried space/state databases reuse
// read-only connections in a small LRU cache verified by file identity (`dev`/`ino`) and auto-closed after a short idle
// TTL, so neither WAL checkpointing nor Windows file cleanup is held up. A database is only opened when it is a regular
// file inside the conversations root: nothing is created, migrated or recovered.
import type { Database } from "bun:sqlite";
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { assertDataDirectory } from "../../lib/group-data.ts";
import { openReadable } from "../../lib/sqlite-open.ts";
import { groupSegment } from "../../core/layout.ts";
import { assertDurableSchema } from "../schema-gate.ts";
import { missing, spaceDirectories } from "../space-databases.ts";
import { encodeError } from "../sqlite-protocol.ts";
import { READ_ERRORS, READ_LIMITS, type ReadMessage, type ReadOp, type WorkerInit, type WorkerMessage } from "./protocol.ts";
import * as q from "./queries.ts";

const named = (name: string, message: string) => Object.assign(new Error(message), { name });

if (!parentPort) throw new Error("The read worker must run on a worker thread");
const port = parentPort;
const init = workerData as WorkerInit;
const flags = new Int32Array(init.cancel);
const BUSY_TIMEOUT_MS = 1_000;
const MAX_CACHED_CONNECTIONS = 8;

type FileIdentity = { path: string; dev: bigint; ino: bigint };
type CachedConnection = {
  db: Database;
  dev: bigint;
  ino: bigint;
  timer?: ReturnType<typeof setTimeout>;
};

const cache = new Map<string, CachedConnection>();

function closeEntry(entry: CachedConnection): void {
  if (entry.timer !== undefined) { clearTimeout(entry.timer); entry.timer = undefined; }
  try { entry.db.close(); } catch {}
}

function evict(path: string): void {
  const entry = cache.get(path);
  if (!entry) return;
  cache.delete(path);
  closeEntry(entry);
}

function closeAllCached(): void {
  for (const entry of cache.values()) closeEntry(entry);
  cache.clear();
}

function armIdle(path: string, entry: CachedConnection): void {
  if (entry.timer !== undefined) clearTimeout(entry.timer);
  if (init.connectionIdleMs <= 0) { evict(path); return; }
  entry.timer = setTimeout(() => {
    if (cache.get(path) === entry) evict(path);
  }, init.connectionIdleMs);
  entry.timer.unref?.();
}

function acquireCached(file: FileIdentity): CachedConnection {
  const existing = cache.get(file.path);
  if (existing) {
    if (existing.dev === file.dev && existing.ino === file.ino) {
      if (existing.timer !== undefined) { clearTimeout(existing.timer); existing.timer = undefined; }
      // Refresh LRU order.
      cache.delete(file.path);
      cache.set(file.path, existing);
      return existing;
    }
    evict(file.path);
  }
  while (cache.size >= MAX_CACHED_CONNECTIONS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    evict(oldest);
  }
  const db = openReadable(file.path, { strict: true });
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  const created: CachedConnection = { db, dev: file.dev, ino: file.ino };
  cache.set(file.path, created);
  return created;
}

const LOGICAL_ERRORS = new Set<string>([READ_ERRORS.cancelled, READ_ERRORS.expired, READ_ERRORS.changed, READ_ERRORS.absent, "ReadLimit"]);

function guard(message: ReadMessage): q.Guard {
  return () => {
    if (Atomics.load(flags, message.slot) !== 0) throw named(READ_ERRORS.cancelled, "读取已取消");
    if (Date.now() > message.deadline) throw named(READ_ERRORS.expired, "读取超过期限");
  };
}

/** A short read transaction on a one-shot connection (used by bulk space scans so the hot LRU cache is never churned). */
async function withOneShotReader<T>(path: string, read: (db: Database) => T | Promise<T>): Promise<T> {
  const db = openReadable(path, { strict: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec("BEGIN");
    try { return await read(db); }
    finally {
      try { db.exec("COMMIT"); } catch { try { db.exec("ROLLBACK"); } catch {} }
    }
  } finally { db.close(); }
}

/** A short read transaction on a cached read-only connection (verified by file dev/ino, auto-closed after connectionIdleMs). */
async function withCachedReader<T>(file: FileIdentity, read: (entry: CachedConnection) => T | Promise<T>): Promise<T> {
  if (init.connectionIdleMs <= 0) {
    return withOneShotReader(file.path, db => read({ db, dev: file.dev, ino: file.ino }));
  }
  const entry = acquireCached(file);
  let keep = true;
  try {
    entry.db.exec("BEGIN");
    try {
      return await read(entry);
    } catch (error) {
      if (!LOGICAL_ERRORS.has((error as Error | undefined)?.name ?? "")) keep = false;
      throw error;
    } finally {
      try { entry.db.exec("COMMIT"); }
      catch {
        keep = false;
        try { entry.db.exec("ROLLBACK"); } catch {}
      }
    }
  } catch (error) {
    if (!LOGICAL_ERRORS.has((error as Error | undefined)?.name ?? "")) keep = false;
    throw error;
  } finally {
    if (!keep) evict(file.path);
    else if (cache.get(file.path) === entry) armIdle(file.path, entry);
  }
}

const schema = (db: Database, path: string) =>
  assertDurableSchema({ get: <T extends object>(sql: string) => (db.query(sql).get() as T | null) ?? undefined }, path);

async function spaceFile(space: string): Promise<FileIdentity | undefined> {
  const path = join(init.conversations, space, "durable.sqlite");
  try {
    await assertDataDirectory(dirname(path), init.conversations);
    const info = await lstat(path, { bigint: true });
    if (!info.isFile()) throw new Error(`会话库路径不是普通文件：${space}`);
    return { path, dev: info.dev, ino: info.ino };
  } catch (error) {
    if (missing(error)) { evict(path); return undefined; }
    throw error;
  }
}

async function onSpace<T>(op: Extract<ReadOp, { space: string }>, check: q.Guard, read: (db: Database) => T): Promise<T> {
  const file = await spaceFile(op.space);
  if (!file) throw named(READ_ERRORS.absent, "会话空间不存在");
  check();
  return withCachedReader(file, async entry => {
    // Re-check durable_schema inside every short read transaction so in-place schema changes are never bypassed by cache.
    await schema(entry.db, file.path);
    const identity = q.spaceIdentity(entry.db);
    if (identity?.generation !== op.generation) throw named(READ_ERRORS.changed, "会话库已更换，请重新打开");
    return read(entry.db);
  });
}

async function execute(message: ReadMessage): Promise<unknown> {
  const { op } = message, check = guard(message);
  check();
  switch (op.op) {
    case "spaces": {
      const spaces = [];
      for (const space of (await spaceDirectories(init.conversations)).slice(0, READ_LIMITS.spaces)) {
        check();
        const file = await spaceFile(space);
        if (!file) { spaces.push({ space, state: "empty" as const }); continue; }
        try {
          spaces.push(await withOneShotReader(file.path, async db => {
            await schema(db, file.path);
            const info = q.spaceInfo(db);
            if (!info) return { space, state: "empty" as const };
            // `key` is the scope key the database records (`direct`, `group:<id>`); `space` its storage path.
            const { space: key, ...rest } = info;
            return { space, state: "ready" as const, key, ...rest };
          }));
        } catch (error) { spaces.push({ space, state: "unreadable" as const, error: (error as Error).message }); }
      }
      return { spaces, observedAt: Date.now() };
    }
    case "members": return onSpace(op, check, db => q.members(db, op.after, op.limit, check));
    case "activity": return onSpace(op, check, db => ({ items: q.activity(db, op.conversations, check), observedAt: Date.now() }));
    case "bounds": return onSpace(op, check, db => ({ upper: q.bounds(db, op.conversations, check), observedAt: Date.now() }));
    case "entries": return onSpace(op, check, db => q.entries(db, op.conversation,
      { older: op.older, cursor: op.cursor, upper: op.upper, limit: op.limit, budget: READ_LIMITS.entryBudget }));
    case "entry": return onSpace(op, check, db => ({ entry: q.entry(db, op.conversation, op.id) ?? null }));
    case "boundaries": return onSpace(op, check, db => q.boundaries(db, op.conversation, op.after, op.limit));
    case "search": return onSpace(op, check, db => q.search(db, { conversationId: op.conversation, text: op.text, kinds: op.kinds ?? null,
      from: op.from ?? null, to: op.to ?? null, cursor: op.cursor, upper: op.upper, scan: READ_LIMITS.searchScan, hits: READ_LIMITS.searchHits }, check));
    case "requests": return onSpace(op, check, db => ({ ...q.requests(db, op.phone, op.conversation, READ_LIMITS.requests, check), observedAt: Date.now() }));
    case "names": {
      const file = await stateFile();
      if (!file) return { found: [], observedAt: Date.now() };
      return withCachedReader(file, ({ db }) => {
        const rows = db.query(`SELECT phone, name, last_verified_at AS verifiedAt FROM member_directory WHERE phone IN (${op.phones.map(() => "?").join(", ")})`)
          .all(...op.phones) as { phone: string; name: string; verifiedAt: number }[];
        return { found: rows, observedAt: Date.now() };
      });
    }
    case "groups": {
      const file = await stateFile();
      if (!file) return { groups: [], observedAt: Date.now() };
      return withCachedReader(file, ({ db }) => {
        // The table appears with the push store; a database from before it has no names.
        if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_groups'").get()) return { groups: [], observedAt: Date.now() };
        const rows = db.query("SELECT group_id AS id, name FROM chat_groups WHERE name IS NOT NULL").all() as { id: string; name: string }[];
        return { groups: rows.map(row => ({ segment: groupSegment(row.id), name: row.name })), observedAt: Date.now() };
      });
    }
  }
}

/** The state database is there (a regular file); undefined before the first start. */
async function stateFile(): Promise<FileIdentity | undefined> {
  let info;
  try { info = await lstat(init.state, { bigint: true }); }
  catch (error) { if (missing(error)) { evict(init.state); return undefined; } throw error; }
  if (!info.isFile()) throw new Error("状态库路径不是普通文件");
  return { path: init.state, dev: info.dev, ino: info.ino };
}

// One at a time, in arrival order: a second message waits until the current operation has replied.
let line = Promise.resolve();
port.on("message", (message: WorkerMessage) => {
  line = line.then(async () => {
    try {
      if ("release" in message) {
        closeAllCached();
        port.postMessage({ request: message.request, ok: true, value: undefined });
        return;
      }
      port.postMessage({ request: message.request, ok: true, value: await execute(message) });
    } catch (error) {
      port.postMessage({ request: message.request, ok: false, error: encodeError(error) });
    }
  });
});
port.on("close", closeAllCached);
