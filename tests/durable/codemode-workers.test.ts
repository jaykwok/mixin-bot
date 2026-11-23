import { expect, test } from "bun:test";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { CodemodeWorkers } from "../../src/durable/codemode/workers.ts";

test("synchronous shared reservations survive cancellation until exit; release is idempotent; shutdown fences admission", async () => {
  const workers = new CodemodeWorkers(2);
  const first = workers.acquireWorker(), second = workers.acquireWorker();
  const exit = Promise.withResolvers<void>(); workers.onWorkerStarted(exit.promise);
  expect(workers.reserved).toBe(2); expect(workers.alive).toBe(1);
  expect(() => workers.acquireWorker()).toThrow("容量已满");
  second(); second(); expect(workers.reserved).toBe(1);
  workers.stop(); expect(() => workers.acquireWorker()).toThrow("关闭");
  let drained = false; const pending = workers.drain().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false);
  first(); exit.resolve(); await pending; expect(workers.reserved).toBe(0);
});

test("reserve() queues callers in strict FIFO order, supports abort/timeout/queue bounds, and releases unclaimed reservations", async () => {
  const workers = new CodemodeWorkers({ limit: 1, maxWaiters: 2, waitTimeoutMs: 5_000 });
  const first = await workers.reserve();
  expect(workers.reserved).toBe(1); expect(workers.queued).toBe(0);

  const order: string[] = [];
  const abortMe = new AbortController();
  const second = workers.reserve().then(reservation => { order.push("second"); return reservation; });
  const aborted = workers.reserve(abortMe.signal);
  expect(workers.queued).toBe(2);
  await expect(workers.reserve()).rejects.toThrow("等待队列已满");

  abortMe.abort(new Error("caller gone"));
  await expect(aborted).rejects.toThrow("caller gone");
  expect(workers.queued).toBe(1);

  const third = workers.reserve().then(reservation => { order.push("third"); return reservation; });
  const timedOut = new CodemodeWorkers({ limit: 1, waitTimeoutMs: 40 });
  const hold = await timedOut.reserve();
  await expect(timedOut.reserve()).rejects.toThrow("超时");
  hold.release(); expect(timedOut.reserved).toBe(0);

  // Unclaimed reservation releases on release() and wakes the next FIFO waiter.
  first.release();
  const gotSecond = await second;
  expect(order).toEqual(["second"]);
  // Claimed reservation stays held across release() until the worker callback runs.
  const releaseSecondWorker = gotSecond.acquireWorker();
  gotSecond.release();
  expect(workers.reserved).toBe(1);
  expect(workers.queued).toBe(1);
  releaseSecondWorker();
  const gotThird = await third;
  expect(order).toEqual(["second", "third"]);
  // stop() rejects any newly queued waiters immediately.
  const waitingAtStop = workers.reserve();
  workers.stop();
  await expect(waitingAtStop).rejects.toThrow("关闭");
  gotThird.release();
  expect(workers.reserved).toBe(0);
});

test("queued real CodemodeSandbox runs wait in FIFO order and execute once the active worker exits", async () => {
  const workers = new CodemodeWorkers({ limit: 1, waitTimeoutMs: 10_000 });
  const firstReservation = await workers.reserve();
  const firstSandbox = new CodemodeSandbox({ acquireWorker: firstReservation.acquireWorker, onWorkerStarted: firstReservation.onWorkerStarted });
  const called = Promise.withResolvers<void>();
  const firstRun = firstSandbox.start("await tools.wait({}); return 1;", {
    startedAt: Date.now(), seed: 1, tools: [{ name: "wait" }], onCall: () => called.resolve(),
  });
  await called.promise;

  // Second caller queues instead of failing immediately.
  const secondReserved = workers.reserve();
  expect(workers.queued).toBe(1);
  firstRun.deliver(1, Date.now(), 1, { ok: true, value: null });
  expect(await firstRun.result).toMatchObject({ ok: true, value: 1 });
  const secondReservation = await secondReserved;
  const secondSandbox = new CodemodeSandbox({ acquireWorker: secondReservation.acquireWorker, onWorkerStarted: secondReservation.onWorkerStarted });
  try {
    const secondRun = secondSandbox.start("return 2;", { startedAt: Date.now(), seed: 2, onCall: () => {} });
    expect(await secondRun.result).toMatchObject({ ok: true, value: 2 });
  } finally {
    await Promise.all([firstSandbox.close(), secondSandbox.close()]);
    firstReservation.release();
    secondReservation.release();
    await workers.drain();
    expect(workers.reserved).toBe(0);
  }
}, 20000);

test("two independent group sandboxes share official admission and release on real exit, including worker construction failure", async () => {
  const workers = new CodemodeWorkers(1);
  const options = { acquireWorker: workers.acquireWorker, onWorkerStarted: workers.onWorkerStarted };
  const a = new CodemodeSandbox(options), b = new CodemodeSandbox(options);
  const called = Promise.withResolvers<void>();
  const first = a.start("await tools.wait({}); return 1;", { startedAt: Date.now(), seed: 1,
    tools: [{ name: "wait" }], onCall: () => called.resolve() });
  await called.promise;
  const denied = await b.start("return 2;", { startedAt: Date.now(), seed: 2, onCall: () => {} }).result;
  expect(denied.ok).toBe(false); expect(JSON.stringify(denied)).toContain("容量已满");
  await a.close(); await first.result; await workers.drain(); expect(workers.reserved).toBe(0);
  const failed = new CodemodeSandbox({ ...options, workerUrl: "missing-worker-for-admission-test.ts" });
  expect((await failed.start("return 1;", { startedAt: Date.now(), seed: 1, onCall: () => {} }).result).ok).toBe(false);
  await workers.drain(); expect(workers.reserved).toBe(0);
  await Promise.all([b.close(), failed.close()]);
}, 20000);

test("a non-interruptible builtin returns timeout promptly and cannot dispatch late tools or over-admit on repeated cancellation", async () => {
  const workers = new CodemodeWorkers(1);
  const sandbox = new CodemodeSandbox({ acquireWorker: workers.acquireWorker, onWorkerStarted: workers.onWorkerStarted });
  let calls = 0;
  const entered = Promise.withResolvers<void>();
  const run = sandbox.start("await tools.started({}); /^(a+)+$/.test('a'.repeat(27) + '!'); await tools.late({});", {
    startedAt: Date.now(), seed: 1, timeoutMs: 200, tools: [{ name: "started" }, { name: "late" }],
    onCall: call => { calls++; run.deliver(1, Date.now(), call.id, { ok: true, value: null }); entered.resolve(); },
  });
  await entered.promise;
  // Let the worker receive the tool result and enter the synchronous builtin.
  await Bun.sleep(50);
  const started = performance.now();
  expect((await run.result).ok).toBe(false);
  expect(performance.now() - started).toBeLessThan(2000);
  for (let i = 0; i < 3; i++) {
    const other = new CodemodeSandbox({ acquireWorker: workers.acquireWorker, onWorkerStarted: workers.onWorkerStarted });
    const occupied = workers.reserved === 1;
    const attempt = await other.start("return 2;", { startedAt: Date.now(), seed: i, onCall: () => {} }).result;
    if (occupied) { expect(attempt.ok).toBe(false); expect(JSON.stringify(attempt)).toContain("容量已满"); }
    await other.close(); expect(workers.reserved).toBeLessThanOrEqual(1);
  }
  await sandbox.close(); await workers.drain(); expect(calls).toBe(1); expect(workers.reserved).toBe(0);
}, 30000);
