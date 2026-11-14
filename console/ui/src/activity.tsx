/** @jsxImportSource preact */
// What runs in the background, whichever page is open: the sheet with the progress of a task confirmed on this page, and
// the tray in the corner that follows those tasks and the exports until each ends.
import { useEffect } from "preact/hooks";
import { ExportItem, useExportJobs } from "./exports.tsx";
import { Icon } from "./icons.tsx";
import { forgetTask, showTask, TASK_LABELS, TASK_STATES, TaskProgress, taskEnded, taskTone, useFollowed, viewTaskInPage, type Followed } from "./tasks.tsx";
import { Dialog, ProgressBar } from "./ui.tsx";

/** The progress of one followed task. Closing it leaves the task running; the tray keeps following it. */
export function TaskSheet() {
  const { followed, shown, handoff } = useFollowed();
  const item = followed.find(entry => entry.id === shown);
  if (!item) return null;
  const close = () => showTask(null);
  return (
    <Dialog title={TASK_LABELS[item.operation] ?? "后台任务"} icon="activity" onClose={close} class={handoff === item.id ? "continued" : undefined}
      footer={<>
        <a class="link-btn" href="#/maintain" onClick={() => viewTaskInPage(item.id)}>在维护页查看</a>
        <span class="spacer" />
        <button type="button" class="btn primary" data-autofocus onClick={close}>{taskEnded(item.task?.state) ? "完成" : "在后台继续"}</button>
      </>}>
      {/* Recovery is previewed on the maintenance page, not in a sheet over this one. */}
      <TaskProgress key={item.id} id={item.id} recoveryAllowed={false} inSheet />
    </Dialog>
  );
}

function TaskItem({ item }: { item: Followed }) {
  const look = taskTone(item.task), ended = taskEnded(item.task?.state);
  const succeeded = !item.error && item.task?.state === "succeeded" && !item.task.needsRecovery
    && item.task.result?.outcome === "success" && item.task.result.exitCode === 0;
  // Only dismiss a confirmed success, after it has been visible in the tray for ten seconds. Opening its sheet or
  // leaving this component cancels the timer; failed, uncertain and recovery-needed tasks remain until dismissed.
  useEffect(() => {
    if (!succeeded) return;
    const timer = setTimeout(() => forgetTask(item.id), 10_000);
    return () => clearTimeout(timer);
  }, [item.id, succeeded]);
  const state = item.error ? `无法读取任务状态：${item.error}` : item.task ? `${TASK_STATES[item.task.state] ?? item.task.state}${item.task.needsRecovery ? " · 需要恢复处理" : ""}` : "正在读取…";
  return (
    <div class={`activity-item${look.tone ? ` tone-${look.tone}` : ""}`} role="status">
      <button type="button" class="activity-open" data-tip="查看任务进度" onClick={() => showTask(item.id)}>
        <span class="activity-icon"><Icon name={ended ? look.icon : "activity"} size={16} /></span>
        <span class="activity-text">
          <span class="activity-name">{TASK_LABELS[item.operation] ?? item.operation}</span>
          <span class="activity-state">{!ended && <Icon name="loader" size={12} class="spin" />}{state}{succeeded && " · 10 秒后自动收起"}</span>
          {!ended && <ProgressBar label="任务进度" />}
        </span>
      </button>
      {ended && <button type="button" class="btn ghost icon-btn" aria-label="关闭这条任务提示" onClick={() => forgetTask(item.id)}><Icon name="x" size={14} /></button>}
    </div>
  );
}

export function ActivityTray() {
  const { followed, shown } = useFollowed();
  const jobs = useExportJobs();
  // The task in the open sheet is shown there.
  const tasks = followed.filter(item => item.id !== shown).slice(0, 3);
  if (!tasks.length && !jobs.length) return null;
  return (
    <div class="activity-tray" role="region" aria-label="后台活动">
      {tasks.map(item => <TaskItem key={item.id} item={item} />)}
      {jobs.map(job => <ExportItem key={job.id} job={job} />)}
    </div>
  );
}
