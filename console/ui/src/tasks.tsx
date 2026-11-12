/** @jsxImportSource preact */
// Maintenance tasks. A preview opens a sheet to confirm (it shows the preview's expiry); the console's executor then runs
// the task on its own. A task confirmed on this page is followed in a sheet and in the activity tray wherever the page
// goes meanwhile; the maintenance page lists every task with its progress and output.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiFailure } from "./api.ts";
import { serverTime } from "./clock.ts";
import { dateTime, platformName } from "./format.ts";
import { PathField } from "./files.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { Countdown, Dialog, Disclosure, PageHeader, ProgressBar, Row, Section, Segmented, Spinner, Stepper, Toggle } from "./ui.tsx";
import { DeploymentDirectoryPicker, type DeploymentSelection } from "./deployment-directory.tsx";
import type { ConsoleInfo } from "./contract.ts";

export interface TaskView { id: string; operation: string; state: string; needsRecovery: boolean; createdAt: number;
  reason?: string; result?: { message: string; finalState: string; outcome: string; exitCode: number } }
interface Plan { id: string; operation: string; summary: string[]; expiresAt: number }
export interface TaskEvent { seq: number; at: number; kind: string; text: string }
export const TASK_STATES: Record<string, string> = { queued: "等待接单", "not-accepted": "未接单", running: "执行中", interrupted: "执行中断", succeeded: "已完成", failed: "失败", unknown: "结果未知" };
export const TASK_LABELS: Record<string, string> = { start: "启动", stop: "停止", restart: "重启", "maintenance-recover": "恢复中断的维护", update: "升级", deploy: "重新部署", install: "首次部署", repair: "修复部署", uninstall: "卸载", resume: "继续上次操作", rollback: "回滚上次操作", "history-clear": "清空会话", "history-compact": "会话压缩",
  "tmp-purge": "归档临时文件", "tmp-reclaim": "物理回收", "tmp-discard": "删除归档", "stat-import": "导入统计", "runtime-configure": "运行参数",
  "relay-test": "测试外链", "relay-purge": "清理外链", "backup-clean": "清理备份", "configuration-apply": "应用配置", "configuration-restore": "恢复配置" };
/** Operations whose interruption leaves maintenance to recover. */
const RECOVERABLE = ["history-clear", "history-compact", "stat-import", "tmp-purge", "tmp-reclaim", "tmp-discard", "configuration-apply", "configuration-restore",
  "runtime-configure", "backup-clean", "relay-test", "relay-purge", "maintenance-recover"];
const STEPS = ["预览", "确认", "执行"];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export const taskEnded = (state: string | undefined) => !!state && state !== "queued" && state !== "running";

/** How a task stands, for its glyph, stepper and progress bar. */
export function taskTone(task: TaskView | null): { tone: "ok" | "danger" | "warn" | null; icon: IconName; tint: "blue" | "green" | "red" | "orange" } {
  if (!task || !taskEnded(task.state)) return { tone: null, icon: "loader", tint: "blue" };
  if (task.state === "succeeded") return { tone: "ok", icon: "checkmark", tint: "green" };
  if (task.state === "failed" || task.state === "not-accepted") return { tone: "danger", icon: "x", tint: "red" };
  return { tone: "warn", icon: "alert", tint: "orange" };
}

// ─── Tasks followed from this page ──────────────────────────────────────────

export interface Followed { id: string; operation: string; task: TaskView | null; error?: string }
let followed: Followed[] = [];
/** The task whose sheet is open, and the one the maintenance page opens with. */
let shown: string | null = null, recent: string | null = null;
/** The task whose sheet took over from the confirmation sheet: it appears in place, without its own entrance. */
let handoff: string | null = null;
// Bumped by resetTasks: an answer to a poll sent before (the page of an earlier login) changes nothing.
let epoch = 0;
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const emit = () => { for (const listener of listeners) listener(); };
const POLL_MS = 2_000;

function poll(id: string) {
  const sentIn = epoch;
  timers.set(id, setTimeout(async () => {
    timers.delete(id);
    try {
      const task = await api<TaskView>(`/api/tasks/${id}`);
      if (sentIn !== epoch) return;
      followed = followed.map(item => item.id === id ? { ...item, task, error: undefined } : item); emit();
      if (!taskEnded(task.state) && followed.some(item => item.id === id)) poll(id);
    } catch (error) {
      if (sentIn !== epoch || error instanceof ApiFailure && (error.status === 401 || error.code === "offline")) return;
      followed = followed.map(item => item.id === id ? { ...item, error: message(error) } : item); emit();
      if (followed.some(item => item.id === id)) poll(id);
    }
  }, POLL_MS));
}

/** A task the console accepted from this page: its sheet opens and the tray follows it until it ends. */
export function followTask(task: TaskView) {
  recent = task.id; shown = task.id; handoff = task.id;
  followed = [{ id: task.id, operation: task.operation, task }, ...followed.filter(item => item.id !== task.id)].slice(0, 6);
  clearTimeout(timers.get(task.id)); poll(task.id); emit();
  window.dispatchEvent(new CustomEvent("console-task", { detail: task.id }));
}
export function showTask(id: string | null) { shown = id; handoff = null; emit(); }
/** Closes the sheet and opens the task on the maintenance page (the link goes there). */
export function viewTaskInPage(id: string) {
  recent = id; shown = null; handoff = null; emit();
  window.dispatchEvent(new CustomEvent("console-task", { detail: id }));
}
export function forgetTask(id: string) {
  clearTimeout(timers.get(id)); timers.delete(id);
  followed = followed.filter(item => item.id !== id); if (shown === id) shown = null; emit();
}
/** Forgets every followed task (the session ended): stops polling; the tasks themselves run on. */
export function resetTasks() {
  epoch++; for (const timer of timers.values()) clearTimeout(timer); timers.clear();
  followed = []; shown = null; recent = null; handoff = null; emit();
}
export function useFollowed(): { followed: Followed[]; shown: string | null; handoff: string | null } {
  const [, setTick] = useState(0);
  useEffect(() => { const listener = () => setTick(value => value + 1); listeners.add(listener); return () => { listeners.delete(listener); }; }, []);
  return { followed, shown, handoff };
}

// ─── Preview and confirmation ───────────────────────────────────────────────

/**
 * A button that previews `operation`; the sheet that follows shows what will be done and until when the preview holds, and
 * hands the task over on confirmation. `danger`: the confirmation is red (the button itself only says it in red).
 */
export function TaskAction({ operation, params, children, disabled, danger = false, primary = false, onStarted }: {
  operation: string; params: Record<string, unknown>; children: ComponentChildren; disabled?: boolean; danger?: boolean; primary?: boolean; onStarted?: (task: TaskView) => void;
}) {
  // The preview's expiry is the server's: `now` and `received` are server time.
  const [plan, setPlan] = useState<Plan | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [now, setNow] = useState(serverTime);
  const [submitting, setSubmitting] = useState(false), [received, setReceived] = useState(0);
  // The console refused this preview (facts changed, plan used or expired, executor unavailable): only a new preview can go on.
  const [refused, setRefused] = useState(false);
  const key = useRef(""), lock = useRef(false), live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { if (!plan) return; const timer = setInterval(() => setNow(serverTime()), 1000); return () => clearInterval(timer); }, [plan]);
  const preview = async () => {
    if (lock.current) return; lock.current = true; setBusy(true); setError(""); setRefused(false);
    try {
      const result = await api<Plan>("/api/plans", { method: "POST", body: { operation, params }, intent: true, timeoutMs: 120_000 });
      if (live.current) { key.current = crypto.randomUUID(); setPlan(result); setNow(serverTime()); setReceived(serverTime()); }
    } catch (error) { if (live.current) setError(message(error)); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  };
  const submit = async () => {
    if (!plan || refused || lock.current || serverTime() >= plan.expiresAt) return;
    lock.current = true; setBusy(true); setSubmitting(true); setError("");
    const sentIn = epoch;
    try {
      const task = await api<TaskView>("/api/tasks", { method: "POST", body: { plan: plan.id, key: key.current }, intent: true, timeoutMs: 90_000 });
      // The session ended meanwhile (logout): the task runs on, but this page no longer follows it.
      if (sentIn !== epoch) return;
      const accepted = { ...task, operation: task.operation ?? operation, createdAt: task.createdAt ?? Date.now(), needsRecovery: task.needsRecovery ?? false };
      if (live.current) { setPlan(null); onStarted?.(accepted); }
      followTask(accepted);
    } catch (error) {
      if (!live.current) return;
      // Only a lost or timed-out answer may have been accepted after all: the same preview and key cannot run twice.
      if (error instanceof ApiFailure && error.status >= 400 && error.status < 500) {
        // Most refusals already end with "请重新预览"; say it once.
        setRefused(true); setError(message(error).replace(/[，；,;]?\s*请重新预览[。.]?$/, "") + "。这份预览不能再执行，请重新预览。");
      }
      else setError(message(error) + "。可以用同一预览重试，已接单的任务不会重复执行。");
    }
    finally { lock.current = false; if (live.current) { setBusy(false); setSubmitting(false); } }
  };
  const expired = !!plan && now >= plan.expiresAt;
  const close = () => { if (!busy) { setPlan(null); setError(""); } };
  return <>
    <button type="button" class={`btn${danger ? " destructive" : primary ? " primary" : ""}`} disabled={disabled || busy} onClick={() => void preview()}>
      {busy && !plan ? <><Icon name="loader" size={14} class="spin" />正在预览…</> : children}</button>
    {!plan && error && <p role="alert" class="form-error">{error}</p>}
    {plan && <Dialog title={`确认${TASK_LABELS[operation] ?? "操作"}`} icon={danger ? "alert" : "shield"} onClose={close}
      header={<Stepper steps={[...STEPS, "完成"]} current={submitting ? 2 : busy ? 0 : 1} label="任务流程" />} footer={<>
        <button class="btn" disabled={busy} onClick={close}>返回</button>
        {expired || refused ? <button class="btn primary" disabled={busy} onClick={() => void preview()}>{busy ? "正在预览…" : "重新预览"}</button>
          : <button class={`btn ${danger ? "danger" : "primary"}`} disabled={busy} onClick={() => void submit()}>{submitting ? "正在交接任务…" : "确认执行"}</button>}
      </>}>
      <ul class="plan-summary">{plan.summary.map((line, index) => <li key={index}>{line}</li>)}</ul>
      <div class="plan-meta">
        <span>{expired ? "预览已过期，请重新核对。" : `预览有效至 ${dateTime(plan.expiresAt)}。`}</span>
        {!expired && <Countdown total={Math.max(1, plan.expiresAt - received)} left={plan.expiresAt - now} label="预览剩余有效时间" />}
      </div>
      <p class="plan-note">确认后任务独立运行，关掉网页或控制台不会取消。重新打开后可在维护页查看结果。</p>
      {error && <p role="alert" class="form-error">{error}</p>}
    </Dialog>}
  </>;
}

/**
 * Fetch SSE so Origin and X-Console-Request apply to every connection; EventSource cannot set this header. The server sends a
 * keepalive every second, so a connection silent for `idleMs` has stalled (a half-open SSH tunnel never ends it): it fails
 * and the caller reconnects. `onOpen` reports each connection the console accepted.
 */
export async function readTaskEvents(id: string, after: number, signal: AbortSignal, onEvent: (event: TaskEvent) => void,
  { idleMs = 15_000, onOpen }: { idleMs?: number; onOpen?: () => void } = {}): Promise<void> {
  const idle = new AbortController();
  let timer = setTimeout(() => idle.abort(), idleMs);
  const heard = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(), idleMs); };
  try {
    const response = await fetch(`/api/tasks/${id}/events`, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.any([signal, idle.signal]),
      headers: { "X-Console-Request": "1", "Last-Event-ID": String(after) } });
    if (!response.ok || !response.body) throw new Error(`事件连接未完成（HTTP ${response.status}）`);
    onOpen?.(); heard();
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
    // The aborted fetch errors the body too; cancelling here ends the read even where it does not.
    idle.signal.addEventListener("abort", () => { void reader.cancel().catch(() => {}); }, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        heard();
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = frame.split("\n").find(line => line.startsWith("data: "));
          if (frame.includes("event: error\n")) {
            let text = "事件记录无法读取";
            try { const value = JSON.parse(data?.slice(6) ?? "") as { message?: unknown }; if (typeof value.message === "string" && value.message) text = value.message; } catch {}
            throw new Error(text);
          }
          if (!frame.includes("event: task\n") || !data) continue;
          const event = JSON.parse(data.slice(6)) as TaskEvent;
          if (!Number.isSafeInteger(event.seq) || typeof event.text !== "string") throw new Error("事件记录不完整");
          if (event.seq > after) { after = event.seq; onEvent(event); }
        }
        if (buffer.length > 256 * 1024) throw new Error("事件数据过大");
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } catch (error) {
    if (!idle.signal.aborted || signal.aborted) throw error;
  } finally { clearTimeout(timer); }
  if (idle.signal.aborted && !signal.aborted) throw new Error("事件连接没有响应");
}

// ─── Progress ───────────────────────────────────────────────────────────────

/** A task's record and events, kept current: the record is read every few seconds, the events stream in. */
function useTask(id: string) {
  const [task, setTask] = useState<TaskView | null>(null), [events, setEvents] = useState<TaskEvent[]>([]);
  // Each source clears its own alert once it works again.
  const [loadError, setLoadError] = useState(""), [streamError, setStreamError] = useState("");
  useEffect(() => {
    const controller = new AbortController(); let cursor = 0, reconnect: ReturnType<typeof setTimeout> | undefined, poll: ReturnType<typeof setTimeout> | undefined, busy = false;
    setTask(null); setEvents([]); setLoadError(""); setStreamError("");
    // A read already under way schedules the next one. An ended task changes only when maintenance recovery settles it:
    // read it less often.
    const load = async () => {
      if (busy) return; busy = true; let ended = false;
      try { const value = await api<TaskView>(`/api/tasks/${id}`, { signal: controller.signal }); if (!controller.signal.aborted) { setTask(value); setLoadError(""); ended = taskEnded(value.state); } }
      catch (error) { if (!controller.signal.aborted) setLoadError(message(error)); } finally { busy = false; }
      if (!controller.signal.aborted) { clearTimeout(poll); poll = setTimeout(() => void load(), ended ? 10_000 : 3000); }
    };
    const connect = async () => {
      try { await readTaskEvents(id, cursor, controller.signal, event => { cursor = event.seq; setEvents(previous => [...previous, event].slice(-2000)); }, { onOpen: () => setStreamError("") }); }
      // fetch() itself fails with the browser's own text ("Failed to fetch"): say what happened instead.
      catch (error) { if (!controller.signal.aborted) { setStreamError((error instanceof TypeError ? "事件连接中断" : message(error)) + "，正在重连…"); clearTimeout(poll); void load(); } }
      if (!controller.signal.aborted) reconnect = setTimeout(() => void connect(), 3000);
    };
    void load(); void connect();
    return () => { controller.abort(); clearTimeout(poll); clearTimeout(reconnect); };
  }, [id]);
  return { task, events, loadError, streamError };
}

/** One task's progress: where it stands, the latest stage, its result, and the output it wrote. */
export function TaskProgress({ id, recoveryAllowed, inSheet = false }: { id: string; recoveryAllowed: boolean; inSheet?: boolean }) {
  const { task, events, loadError, streamError } = useTask(id);
  // The export error stays until the next export.
  const [error, setError] = useState("");
  const download = async () => {
    setError("");
    try {
      const result = await api<{ filename: string; content: string }>(`/api/tasks/${id}/log`, { method: "POST", body: {}, intent: true });
      const url = URL.createObjectURL(new Blob([result.content], { type: "text/plain;charset=utf-8" })), link = document.createElement("a");
      link.href = url; link.download = result.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) { setError(message(error)); }
  };
  const ended = taskEnded(task?.state), look = taskTone(task);
  const phase = [...events].reverse().find(event => event.kind === "phase")?.text;
  const stage = [...events].reverse().find(event => event.text.startsWith("部署阶段："))?.text.slice(5);
  const state = task ? TASK_STATES[task.state] ?? task.state : "正在读取…";
  return <section class="task-detail">
    <div class="task-head">
      <span class={`glyph tint-${look.tint}`} aria-hidden="true"><Icon name={look.icon} size={16} class={look.icon === "loader" ? "spin" : undefined} /></span>
      <div class="row-text">
        {!inSheet && <div class="task-title">{TASK_LABELS[task?.operation ?? ""] ?? "任务详情"}</div>}
        <div class={`task-state${look.tone ? ` ${look.tone}` : ""}`}>{state}{task?.needsRecovery ? " · 需要恢复处理" : ""}</div>
      </div>
    </div>
    <Stepper steps={[...STEPS, ended ? state : "完成"]} current={ended ? 3 : 2} tone={look.tone ?? undefined} label="任务流程" />
    {!ended && <div class="task-phase"><Spinner label="" /><span class="phase-text" key={stage ?? phase}>{stage ? `部署阶段：${stage}` : phase ?? (task?.state === "queued" ? "等待执行器接单" : "正在执行")}</span></div>}
    <ProgressBar label="任务进度" value={ended ? 1 : undefined} tone={look.tone ?? undefined} />
    {task?.result && <p role="status" class={`task-result${look.tone ? ` ${look.tone}` : ""}`}>{task.result.message || (task.result.outcome === "success" ? "执行完成" : "执行失败，请查看下方记录")}</p>}
    {task?.needsRecovery && <><p role="alert">维护记录仍需处理。请查看体检和运维日志，按恢复指引继续或回滚。</p>
      {recoveryAllowed && RECOVERABLE.includes(task.operation) && <div class="action-row"><TaskAction operation="maintenance-recover" params={{}}>预览恢复中断的维护</TaskAction></div>}</>}
    {task?.reason && <p role="alert">{task.reason}</p>}
    {[...new Set([loadError, streamError, error])].filter(Boolean).map(text => <p key={text} role="alert">{text}</p>)}
    <details class="task-output" open={task?.state === "failed"}>
      <summary><Icon name="chevronRight" size={13} />任务输出{events.length ? `（${events.length} 行）` : ""}</summary>
      <pre class="task-events" aria-label="任务输出">{events.map(event => <div key={event.seq} class={event.kind === "error" ? "event-error" : ""}>{event.text}</div>)}</pre>
    </details>
    <div class="task-foot">
      <span>最多显示最近 2000 行。{inSheet ? "关闭这里不会取消任务。" : "收起详情只断开订阅，不会取消任务。"}</span>
      <button type="button" class="btn small-btn" onClick={() => void download()}><Icon name="download" size={13} />导出任务日志</button>
    </div>
    <span class="task-id">{id}</span>
  </section>;
}

// ─── The maintenance page ───────────────────────────────────────────────────

/**
 * `setup`: the first deployment wizard while this checkout is not deployed yet; the controls of a deployment are hidden then.
 * `platform`: the host's, for what only some platforms offer (removing the image on uninstall).
 */
export function TasksPage({ resultsOnly = false, setup, platform }: { resultsOnly?: boolean; setup?: ComponentChildren; platform?: ConsoleInfo["platform"] }) {
  const [tasks, setTasks] = useState<TaskView[]>([]), [selected, setSelected] = useState<string | null>(recent), [error, setError] = useState(""), [loaded, setLoaded] = useState(false);
  // The task in the sheet opens here once the sheet closes (one subscription per task).
  const { shown: inSheet } = useFollowed();
  useEffect(() => {
    const controller = new AbortController(); let busy = false;
    const load = async () => { if (busy) return; busy = true; try { const value = await api<{ tasks: TaskView[] }>("/api/tasks", { signal: controller.signal }); if (!controller.signal.aborted) { setTasks(value.tasks); setError(""); setLoaded(true); } }
      catch (error) { if (!controller.signal.aborted) setError(message(error)); } finally { busy = false; } };
    const choose = (event: globalThis.Event) => { setSelected((event as CustomEvent<string>).detail); void load(); };
    void load(); const timer = setInterval(() => void load(), 5000); window.addEventListener("console-task", choose);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener("console-task", choose); };
  }, []);
  return <>
    <PageHeader title="维护" description={resultsOnly ? "查看后台任务及断线前的进度。" : setup ? "在这里完成首次部署，查看后台任务及断线前的进度。"
      : "启停、更新和重新部署机器人，查看后台任务及断线前的进度。"} />
    {!resultsOnly && setup}
    {!resultsOnly && !setup && <>
      <RecoveryActions />
      <Section title="机器人">
        <Row icon="power" tint="green" title="运行控制" detail="每个操作先预览，确认后由控制台在后台执行。">
          <TaskAction operation="start" params={{}}><Icon name="play" size={13} />启动</TaskAction>
          <TaskAction operation="stop" params={{}}><Icon name="square" size={13} />停止</TaskAction>
          <TaskAction operation="restart" params={{}}><Icon name="rotate" size={13} />重启</TaskAction>
        </Row>
      </Section>
      <UpgradeForm />
      <DeployForm />
    </>}
    <Section title="后台任务" aside={<span class="muted small">每 5 秒刷新</span>}>
      {error && <div class="group-note form-error" role="alert">{error}</div>}
      {!tasks.length && !error && <div class="group-note">{loaded ? "暂无任务记录。" : <Spinner label="正在读取任务…" />}</div>}
      {tasks.length > 0 && <ul class="task-list">{tasks.map(task => {
        const look = taskTone(task), open = selected === task.id && inSheet !== task.id;
        return <li key={task.id}>
          <button type="button" class="task-row" aria-expanded={open} onClick={() => { if (inSheet === task.id) showTask(null); setSelected(open ? null : task.id); }}>
            <span class={`glyph tint-${look.tint}`} aria-hidden="true"><Icon name={look.icon} size={15} class={look.icon === "loader" ? "spin" : undefined} /></span>
            <span class="row-text"><span class="row-title">{TASK_LABELS[task.operation] ?? task.operation}</span>
              <span class="row-detail">{TASK_STATES[task.state] ?? task.state}{task.needsRecovery ? " · 需要恢复" : ""} · {dateTime(task.createdAt)}</span></span>
            <Icon name="chevronRight" size={15} class="chevron-go" />
          </button>
          {open && <div class="task-row-body"><TaskProgress key={task.id} id={task.id} recoveryAllowed={!resultsOnly} /></div>}
        </li>;
      })}</ul>}
    </Section>
    {!resultsOnly && !setup && <>
      <BackupCleanup />
      <Section title="危险操作">
        <Row icon="trash" tint="red" title="清空全部会话" detail="包含单聊和所有群组；统计保留。此操作不可撤销。">
          <TaskAction operation="history-clear" params={{ space: "all" }} danger>预览清空全部会话</TaskAction>
        </Row>
        <UninstallForm platform={platform} />
      </Section>
    </>}
  </>;
}

/** Uninstall: the service always goes; data/ and logs/ (and on Linux the image) only when ticked. */
function UninstallForm({ platform }: { platform?: ConsoleInfo["platform"] }) {
  const [data, setData] = useState(false), [image, setImage] = useState(false);
  const service = platform === "windows" ? "注销计划任务" : platform === "macos" ? "删除 LaunchDaemon" : "删除容器";
  return <>
    <Row icon="trash" tint="red" title="卸载" detail={`停止机器人并${service}。共享资料目录不删除。`}>
      <TaskAction operation="uninstall" params={{ data, image: platform === "linux" && image }} danger>预览卸载</TaskAction>
    </Row>
    <div class="row"><Toggle label="同时归档 data/ 和 logs/" checked={data} onChange={setData}
      detail={data ? "配置、部署状态、会话、临时文件和统计移入 backup/rm，本目录回到尚未部署。" : "保留数据：之后可以在本页重新部署，沿用原有配置、会话和统计。"} /></div>
    {platform === "linux" && <div class="row"><Toggle label="同时删除镜像 mixin-bot" detail="下次部署重新构建。" checked={image} onChange={setImage} /></div>}
  </>;
}

/**
 * The directory scope of a deployment or upgrade that has none saved. A saved one is used as it is, with nothing to choose:
 * the directory page changes it, applied to the running robot without a deployment.
 */
function ScopeChoice({ label, hasDirectory, value, onChange, onSelection }: {
  label: string; hasDirectory: boolean; value: string; onChange: (value: string) => void; onSelection: (value: DeploymentSelection | null) => void;
}) {
  if (hasDirectory) return null;
  return <>
    <Row title="通讯录范围" detail="还没有保存的同步范围：选择整个通讯录或部分部门。">
      <select aria-label={label} value={value} onChange={event => { onChange(event.currentTarget.value); onSelection(null); }}>
        <option value="">请选择</option><option value="all">整个通讯录</option><option value="departments">选择部分部门</option>
      </select>
    </Row>
    {value === "departments" && <div class="row-body flush-top"><DeploymentDirectoryPicker onChange={onSelection} /></div>}
  </>;
}

export function DeployForm() {
  const [open, setOpen] = useState(false), [selected, setSelected] = useState<DeploymentSelection | null>(null);
  const [saved, setSaved] = useState<{ port: number; workspace: string; hasDirectory: boolean; platform: "windows" | "linux" | "macos" } | null>(null);
  const [port, setPort] = useState(""), [workspace, setWorkspace] = useState(""), [directory, setDirectory] = useState("");
  const [operation, setOperation] = useState<"deploy" | "repair">("deploy"), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const live = useRef(true), controller = useRef<AbortController | null>(null), lock = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; controller.current?.abort(); }; }, []);
  const load = async () => {
    if (lock.current) return; lock.current = true; setBusy(true); setError(""); setSaved(null); setDirectory(""); setSelected(null); setOperation("deploy");
    controller.current?.abort(); controller.current = new AbortController();
    try { const value = await api<NonNullable<typeof saved>>("/api/lifecycle/deploy", { signal: controller.current.signal, intent: true });
      if (live.current) { setSaved(value); setPort(String(value.port)); setWorkspace(value.workspace); } }
    catch (error) { if (live.current) setError(message(error)); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  };
  const toggle = (next: boolean) => { setOpen(next); if (next && !saved && !busy) void load(); };
  const portValid = /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
  const scope = saved?.hasDirectory ? "saved" : directory;
  return <Disclosure title="重新部署与修复" icon="wrench" tint="graphite" open={open} onToggle={toggle}
    detail="使用当前代码和已保存的配置重新部署，完成后启动机器人。服务已被删除（卸载时保留了数据）时，重新部署会重新创建它。">
    <div class="action-row">
      <button type="button" class="btn small-btn" disabled={busy} onClick={() => void load()}>{busy ? <><Icon name="loader" size={13} class="spin" />正在读取部署设置…</> : "重新读取部署设置"}</button>
    </div>
    {error && <p role="alert" class="form-error">{error}</p>}
    {saved && <div class="group">
      {saved.platform === "linux" ? <Row title="部署操作" detail={operation === "repair" ? "保留数据，按已保存的设置重建服务容器。" : "按当前代码重新构建并部署。"}>
        <Segmented label="部署操作" value={operation} onChange={setOperation} size="small"
          options={[{ value: "deploy", label: "重新部署" }, { value: "repair", label: "重建容器修复" }]} />
      </Row> : <Row title="本机修复" detail={`${platformName(saved.platform)} 本机未就绪时可先尝试重启修复；${saved.platform === "macos" ? "LaunchDaemon" : "计划任务"}缺失或安装损坏时使用下面的重新部署。`}>
        <TaskAction operation="repair" params={{}}>预览本机修复</TaskAction>
      </Row>}
      <Row title="机器人端口" detail="机器人在本机监听的端口。">
        <input aria-label="机器人端口" type="number" min="1" max="65535" value={port} onInput={event => setPort(event.currentTarget.value)} />
      </Row>
      <Row class="stack" title="共享资料目录" detail="留空使用项目目录下的 workspace/；外置目录必须已经存在。不会移动或删除共享资料。">
        <PathField label="共享资料目录" purpose="workspace" value={workspace} onChange={setWorkspace} placeholder="留空使用项目目录下的 workspace/" />
      </Row>
      <ScopeChoice label="重部署通讯录范围" hasDirectory={saved.hasDirectory} value={directory} onChange={setDirectory} onSelection={setSelected} />
      <Row title={operation === "repair" ? "重建修复" : "重新部署"} detail="预览列出将要执行的步骤，确认后在后台运行。">
        <TaskAction operation={operation} params={{ port: Number(port), workspace, directory: scope === "departments" ? selected : scope }} primary
          disabled={!portValid || !scope || scope === "departments" && !selected} onStarted={() => setSaved(null)}>
          {operation === "repair" ? "预览重建修复" : "预览重新部署"}</TaskAction>
      </Row>
    </div>}
  </Disclosure>;
}

export function UpgradeForm() {
  const [selected, setSelected] = useState<DeploymentSelection | null>(null);
  const [version, setVersion] = useState<{ branch: string; hasDirectory: boolean; target: string } | null>(null);
  const [directory, setDirectory] = useState(""), [switchMain, setSwitchMain] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const live = useRef(true), controller = useRef<AbortController | null>(null), lock = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; controller.current?.abort(); }; }, []);
  const check = async () => {
    if (lock.current) return; lock.current = true; setBusy(true); setError(""); setVersion(null); setDirectory(""); setSelected(null); setSwitchMain(false);
    controller.current?.abort(); controller.current = new AbortController();
    try { const value = await api<NonNullable<typeof version>>("/api/lifecycle/check-update", { method: "POST", body: {}, intent: true, signal: controller.current.signal, timeoutMs: 120_000 });
      if (live.current) setVersion(value); }
    catch (error) { if (live.current) setError(message(error)); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  };
  const scope = version?.hasDirectory ? "saved" : directory;
  return <Section title="软件更新" footer="升级沿用模型、机器人凭据和运行参数；完成后请重新运行 bun run console。">
    <Row icon="cloud" tint="blue" title="检查 origin/main" detail="取得最新提交后选择升级方式，再预览确认。">
      <button type="button" class="btn" disabled={busy} onClick={() => void check()}>{busy ? <><Icon name="loader" size={14} class="spin" />正在检查版本…</> : "检查更新"}</button>
    </Row>
    {error && <div class="group-note form-error" role="alert">{error}</div>}
    {version && <>
      <Row class="value" title="目标提交"><code>{version.target}</code></Row>
      <Row class="value" title="当前分支">{version.branch}</Row>
      <ScopeChoice label="升级通讯录范围" hasDirectory={version.hasDirectory} value={directory} onChange={setDirectory} onSelection={setSelected} />
      {version.branch !== "main" && <div class="row"><Toggle label="允许切换到 main 分支" detail={`当前在 ${version.branch} 分支；升级会切换到 main。`} checked={switchMain} onChange={setSwitchMain} /></div>}
      <Row title="升级" detail="预览列出目标提交和步骤，确认后在后台运行。">
        <TaskAction operation="update" params={{ target: version.target, switchMain, directory: scope === "departments" ? selected : scope }} primary
          disabled={!scope || scope === "departments" && !selected || (version.branch !== "main" && !switchMain)} onStarted={() => setVersion(null)}>预览升级</TaskAction>
      </Row>
    </>}
  </Section>;
}

export function RecoveryActions() {
  const [pending, setPending] = useState<{ subject: string; record: string[]; committed: boolean; canResume: boolean; canRollback: boolean } | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const refresh = async (signal?: AbortSignal) => {
    setBusy(true); setPending(null); setError("");
    try { const value = await api<{ pending: typeof pending }>("/api/lifecycle", { signal }); if (!signal?.aborted) setPending(value.pending); }
    catch (error) { if (!signal?.aborted) setError(message(error)); }
    finally { if (!signal?.aborted) setBusy(false); }
  };
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort(); }, []);
  return <Section title="部署恢复" aside={<button type="button" class="btn ghost small-btn" disabled={busy} onClick={() => void refresh()}><Icon name="refresh" size={13} class={busy ? "spin" : undefined} />刷新恢复状态</button>}>
    {busy && <div class="row"><Spinner label="正在读取事务记录…" /></div>}
    {error && <div class="group-note form-error" role="alert">{error}</div>}
    {!busy && !error && !pending && <Row icon="check" tint="green" title="没有未完成的部署或升级。" />}
    {pending && <>
      <Row icon="alert" tint="orange" title={pending.subject} detail={pending.committed ? "数据已提交，只能继续完成启动和清理。" : !pending.canResume ? "上次操作已经开始回滚，只能完成回滚。" : "按原事务记录处理，不拉取新目标或改变已保存的选择。"} />
      <div class="row-body flush-top"><ul class="plain-list">{pending.record.map(line => <li key={line}>{line}</li>)}</ul></div>
      <div class="row"><div class="action-row">
        <TaskAction operation="resume" params={{}} disabled={!pending.canResume} primary onStarted={() => setPending(null)}>预览继续上次操作</TaskAction>
        <TaskAction operation="rollback" params={{}} disabled={!pending.canRollback} danger onStarted={() => setPending(null)}>预览回滚上次操作</TaskAction>
      </div></div>
    </>}
  </Section>;
}

function BackupCleanup() {
  const [data, setData] = useState<{ selection: string | null; entries: { index: number; name: string; basis: string[]; bytes: number; category: string; selected: boolean; selectable: boolean }[] } | null>(null),
    [indexes, setIndexes] = useState<number[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const scan = async () => {
    setBusy(true); setError(""); setData(null);
    try { const value = await api<NonNullable<typeof data>>("/api/backups/scan", { method: "POST", body: {}, intent: true, timeoutMs: 120_000 });
      setData(value); setIndexes(value.entries.filter(entry => entry.selected && entry.selectable).map(entry => entry.index)); }
    catch (error) { setError(message(error)); } finally { setBusy(false); }
  };
  const categories: Record<string, string> = { "confirmed-test": "测试数据", business: "业务归档", "suspected-test": "疑似测试数据", unknown: "无法判断" };
  return <Section title="备份清理" footer="活动事务与当前发布依赖的备份始终受保护。">
    <Row icon="archive" tint="cyan" title="历史备份" detail="业务归档默认保留。勾选需要删除的条目，再预览确认。">
      <button type="button" class="btn" disabled={busy} onClick={() => void scan()}>{busy ? <><Icon name="loader" size={14} class="spin" />正在扫描…</> : "扫描备份"}</button>
    </Row>
    {error && <div class="group-note form-error" role="alert">{error}</div>}
    {data && !data.entries.length && <div class="group-note">没有历史备份。</div>}
    {data && data.entries.map(entry => <div class="row" key={entry.index}>
      <label class="check-label row-text"><input type="checkbox" checked={indexes.includes(entry.index)} disabled={!entry.selectable}
        onChange={event => setIndexes(previous => event.currentTarget.checked ? [...previous, entry.index] : previous.filter(value => value !== entry.index))} />
        <span><span class="row-title">{entry.name}</span><span class="row-detail">{categories[entry.category]} · {(entry.bytes / 1024 / 1024).toFixed(2)} MB{entry.basis.length > 0 ? ` · ${entry.basis.join("；")}` : ""}</span></span></label>
    </div>)}
    {data?.selection && data.entries.length > 0 && <div class="row"><span class="row-text muted">已选 {indexes.length} 项</span>
      <TaskAction operation="backup-clean" params={{ selection: data.selection, indexes }} disabled={!indexes.length} danger onStarted={() => setData(null)}>预览所选备份</TaskAction></div>}
  </Section>;
}
