/** @jsxImportSource preact */
import { afterAll, expect, jest, test } from "bun:test";
import { GlobalRegistrator } from "../helpers/dom.tsx";
const registered = !GlobalRegistrator.isRegistered;
if (registered) GlobalRegistrator.register({ url: "http://127.0.0.1:10001/" });
const { render } = await import("preact");
const { act } = await import("preact/test-utils");
const { ActivityTray } = await import("../../console/ui/src/activity.tsx");
const { followTask, resetTasks, showTask } = await import("../../console/ui/src/tasks.tsx");
import type { TaskView } from "../../console/ui/src/tasks.tsx";

afterAll(async () => { if (registered) await GlobalRegistrator.unregister(); });
const success: TaskView = { id: "activity-fixture", operation: "restart", state: "succeeded", needsRecovery: false, createdAt: 1,
  result: { message: "已完成", outcome: "success", exitCode: 0, finalState: "running" } };

test("后台任务确认成功后显示十秒再收起，打开详情期间不会被计时器关闭", async () => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root);
  globalThis.fetch = (async (_url: string) => Response.json(success)) as typeof fetch;
  jest.useFakeTimers();
  try {
    await act(() => { followTask({ ...success, state: "running", result: undefined }); showTask(null); render(<ActivityTray />, root); });
    expect(root.textContent).toContain("执行中");
    await act(async () => { jest.advanceTimersByTime(2000); }); // Server confirms completion.
    expect(root.textContent).toContain("10 秒后自动收起");
    await act(() => { jest.advanceTimersByTime(9000); });
    expect(root.querySelector(".activity-item") !== null).toBe(true);
    await act(() => { showTask(success.id); });
    await act(() => { jest.advanceTimersByTime(20_000); });
    await act(() => { showTask(null); });
    expect(root.textContent).toContain("已完成");
    await act(() => { jest.advanceTimersByTime(9999); });
    expect(root.querySelector(".activity-item") !== null).toBe(true);
    await act(() => { jest.advanceTimersByTime(1); });
    expect(root.querySelector(".activity-tray") === null).toBe(true);
  } finally { render(null, root); root.remove(); resetTasks(); jest.useRealTimers(); globalThis.fetch = previous; }
});

test("失败、中断、未知、未完成和需要恢复的后台任务不会自动收起", async () => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root);
  let current: TaskView = success;
  globalThis.fetch = (async (_url: string) => Response.json(current)) as typeof fetch;
  jest.useFakeTimers();
  try {
    for (const patch of [
      { state: "failed" }, { state: "interrupted" }, { state: "unknown" }, { state: "not-accepted" }, { state: "running" },
      { needsRecovery: true }, { result: undefined }, { result: { ...success.result!, exitCode: 1, outcome: "failure" } },
    ]) {
      await act(() => { render(null, root); resetTasks(); current = { ...success, ...patch }; followTask(current); showTask(null); render(<ActivityTray />, root); });
      await act(async () => { jest.advanceTimersByTime(30_000); });
      expect(root.querySelector(".activity-item") !== null).toBe(true);
      expect(root.textContent).not.toContain("自动收起");
    }
  } finally { render(null, root); root.remove(); resetTasks(); jest.useRealTimers(); globalThis.fetch = previous; }
});
