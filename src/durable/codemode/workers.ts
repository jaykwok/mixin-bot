/** Process-wide admission with bounded FIFO queueing. A result, a cancellation or close() is not a worker exit
 * (seen first with Pi 1.3.0, checked against the pinned codemode by tests/durable/codemode-workers.test.ts): a
 * reservation ends only when the worker exits, fails to start, or is explicitly released before starting a worker. */

export interface CodemodeWorkersOptions {
  /** Concurrent worker threads allowed at once (default 2). */
  readonly limit?: number;
  /** Maximum callers waiting in the FIFO queue (default 32). */
  readonly maxWaiters?: number;
  /** Maximum time a caller waits for a worker slot before failing (default 60_000 ms). */
  readonly waitTimeoutMs?: number;
}

/** One pre-reserved worker slot, handed to a single CodemodeSandbox run. */
export interface WorkerReservation {
  /** Passed directly to CodemodeSandboxOptions.acquireWorker; claims the pre-reserved slot synchronously. */
  readonly acquireWorker: () => () => void;
  /** Passed directly to CodemodeSandboxOptions.onWorkerStarted; tracks the worker until real thread exit. */
  readonly onWorkerStarted: (exited: Promise<void>) => void;
  /** Release the slot if no worker ever claimed it (e.g., cached/decided rerun or setup failure). */
  release(): void;
}

interface Waiter {
  grant(reservation: WorkerReservation): void;
  fail(error: Error): void;
}

export class CodemodeWorkers {
  readonly limit: number;
  readonly maxWaiters: number;
  readonly waitTimeoutMs: number;
  #reserved = 0;
  #stopped = false;
  readonly #waiters: Waiter[] = [];
  readonly #exits = new Set<Promise<void>>();

  constructor(options: number | CodemodeWorkersOptions = 2) {
    const config = typeof options === "number" ? { limit: options } : options;
    const limit = config.limit ?? 2;
    const maxWaiters = config.maxWaiters ?? 32;
    const waitTimeoutMs = config.waitTimeoutMs ?? 60_000;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("worker limit must be positive");
    if (!Number.isSafeInteger(maxWaiters) || maxWaiters < 0) throw new RangeError("maxWaiters must be a non-negative integer");
    if (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 1) throw new RangeError("waitTimeoutMs must be a positive integer");
    this.limit = limit;
    this.maxWaiters = maxWaiters;
    this.waitTimeoutMs = waitTimeoutMs;
  }

  get reserved(): number { return this.#reserved; }
  get alive(): number { return this.#exits.size; }
  get queued(): number { return this.#waiters.length; }

  /** Direct synchronous hook: acquires immediately or throws when full/stopping; releases on construction failure or exit. */
  acquireWorker = (): (() => void) => {
    if (this.#stopped) throw new Error("Codemode 服务正在关闭");
    if (this.#reserved >= this.limit) throw new Error(`Codemode worker 容量已满（${this.limit}），请稍后重试`);
    this.#reserved++;
    let released = false;
    return () => { if (!released) { released = true; this.#releaseSlot(); } };
  };

  /** Wait in FIFO order for a worker slot, bounded by `maxWaiters`, `timeoutMs`, `signal`, and `stop()`. */
  reserve(signal?: AbortSignal, timeoutMs = this.waitTimeoutMs): Promise<WorkerReservation> {
    if (this.#stopped) return Promise.reject(new Error("Codemode 服务正在关闭"));
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.#reserved < this.limit && this.#waiters.length === 0) {
      this.#reserved++;
      return Promise.resolve(this.#createReservation());
    }
    if (this.#waiters.length >= this.maxWaiters) {
      return Promise.reject(new Error(`Codemode worker 等待队列已满（${this.maxWaiters}），请稍后重试`));
    }
    return new Promise<WorkerReservation>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const index = this.#waiters.indexOf(waiter);
        if (index !== -1) this.#waiters.splice(index, 1);
        return true;
      };
      const onAbort = () => { if (cleanup()) reject(abortError(signal!)); };
      const timer = setTimeout(() => {
        if (cleanup()) reject(new Error(`等待 Codemode worker 超时（${Math.ceil(timeoutMs / 1000)} 秒），当前容量已满（${this.limit}），请稍后重试`));
      }, timeoutMs);
      timer.unref?.();
      const waiter: Waiter = {
        grant: (reservation) => { if (cleanup()) resolve(reservation); else reservation.release(); },
        fail: (error) => { if (cleanup()) reject(error); },
      };
      this.#waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  onWorkerStarted = (exited: Promise<void>): void => {
    this.#exits.add(exited);
    void exited.finally(() => this.#exits.delete(exited)).catch(() => {});
  };

  stop(): void {
    this.#stopped = true;
    const error = new Error("Codemode 服务正在关闭");
    while (this.#waiters.length) this.#waiters.shift()!.fail(error);
  }

  /** The application's one shutdown deadline bounds this wait. Never free a living worker's slot. */
  async drain(): Promise<void> {
    while (this.#exits.size) await Promise.allSettled([...this.#exits]);
  }

  #releaseSlot(): void {
    this.#reserved--;
    this.#admit();
  }

  #admit(): void {
    while (!this.#stopped && this.#reserved < this.limit && this.#waiters.length > 0) {
      const waiter = this.#waiters.shift()!;
      this.#reserved++;
      waiter.grant(this.#createReservation());
    }
  }

  #createReservation(): WorkerReservation {
    let claimed = false;
    let released = false;
    const free = () => { if (!released) { released = true; this.#releaseSlot(); } };
    return {
      acquireWorker: () => {
        if (this.#stopped) throw new Error("Codemode 服务正在关闭");
        if (released) throw new Error("Codemode worker 预留已释放");
        if (claimed) return this.acquireWorker();
        claimed = true;
        return free;
      },
      onWorkerStarted: this.onWorkerStarted,
      release: () => { if (!claimed) free(); },
    };
  }
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Codemode worker 等待已取消", "AbortError");
}

export const codemodeWorkers = new CodemodeWorkers();
