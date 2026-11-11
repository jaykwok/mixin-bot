// The health check of every platform: one set of rows, wording and JSON. The console reads `doctor --json` through ops.sh,
// ops.ps1 and the macOS entry alike. What only the host's own tools can tell (the container, the scheduled task, the
// LaunchDaemon, whether the service answers, the model check under the service's identity) arrives as facts; the files and
// the service's /health are read here. Read-only. Built-in modules only: the Linux host runs this without node_modules.
//
// The facts and the `lines` format are an interface between versions: after an upgrade from a terminal, the ops.sh still
// in memory is the previous version's, and it runs this file of the new one for the check that closes the upgrade. A new
// fact therefore needs a default, and an existing fact or line level keeps its meaning.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { commandHint, type OpsPlatform } from "./command-hint.ts";
import { doctorRows, readServiceStatus } from "../tools/directory-admin.ts";
import { probeProgram, versionFacts, versionRows, type ProgramVersion } from "../tools/version-info.ts";

export type DoctorStatus = "pass" | "warn" | "fail";
export interface DoctorRow { name: string; status: DoctorStatus; detail: string; fix: string }
/** `doctor --json`: one line, these keys. */
export interface DoctorReport { pass: number; warn: number; fail: number; port: number; checks: DoctorRow[] }
export type DoctorPlatform = OpsPlatform;

export const row = (name: string, status: DoctorStatus, detail: string, fix = ""): DoctorRow => ({ name, status, detail, fix: status === "pass" ? "" : fix });

/** The command that repairs a deployment, as the platform's entry names it. */
const REPAIR: Record<DoctorPlatform, string> = { linux: "repair", windows: "doctor -Repair", macos: "doctor --repair" };

export function savedPort(project: string, env: NodeJS.ProcessEnv = process.env): number {
  let raw = env.BOT_PORT?.trim() || "";
  if (!raw) { try { raw = readFileSync(join(project, "data/state/bot-port"), "utf8").trim(); } catch { raw = "10000"; } }
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!(port >= 1 && port <= 65535)) throw new Error(`BOT_PORT/data/state/bot-port 中的端口无效：${raw}`);
  return port;
}

/** 200: ready and the recorded instance; 503: the verification-only instance of a deployment; 0: no answer or another instance. */
export type LocalStatus = 200 | 503 | 0;
/** The whole model configuration: valid; invalid; no models.json; or not checked while a deployment or upgrade is unfinished. */
export type ModelsCheck = "valid" | "invalid" | "missing" | "busy";

/** The Docker deployment: the container's state as Docker names it ("" when there is none) and a leftover rollback container. */
export interface LinuxService { container: string; rollback: string }
export function linuxRows(service: LinuxService, hint: (command: string) => string): { rows: DoctorRow[]; healthFix: string } {
  const label = service.container === "running" ? "运行中" : service.container === "exited" ? "已退出" : service.container || "缺少";
  return { rows: [
    row("容器", service.container === "running" ? "pass" : "fail", label, `使用 ${hint("start")}；尚未部署时请使用 ${hint("deploy")}。`),
    service.rollback ? row("部署回滚容器", "fail", `发现 ${service.rollback}，请确认后恢复或删除`) : row("部署回滚容器", "pass", "无"),
  ], healthFix: `使用 ${hint("restart")}，再到 ${hint("logs")} 查看日志。` };
}

/**
 * The scheduled task as Get-ScheduledTask reports it (`state` "" when there is none; `lastResult` of Get-ScheduledTaskInfo),
 * the processes listening on the port and the bot processes of this project.
 */
export interface WindowsService { task: { state: string; logon: string; lastResult?: number } | null; listeners: number[]; botPids: number[] }
const TASK_STATES: Record<string, string> = { Running: "运行中", Ready: "就绪", Disabled: "已禁用", Queued: "排队中" };
const TASK_LOGONS: Record<string, string> = { S4U: "S4U（无需登录）", InteractiveToken: "交互式登录", Interactive: "交互式登录" };
const resultHex = (value: number) => "0x" + (value >>> 0).toString(16).padStart(8, "0").toUpperCase();
export function windowsRows(service: WindowsService, local: LocalStatus, port: number, hint: (command: string) => string): { rows: DoctorRow[]; healthFix: string } {
  const { task, listeners, botPids } = service, rows: DoctorRow[] = [];
  // The task is there, not running, and nothing answers: mostly a deliberate stop (the task stays ready), sometimes a crash.
  const stoppedTask = !!task && task.state !== "Disabled" && task.state !== "Running" && local === 0;
  const stopped = `有意停止的使用 ${hint("start")} 启动；意外退出时先在 ${hint("logs")} 查看日志，再使用 ${hint("doctor -Repair")}。`;
  if (!task) {
    rows.push(local === 200 && botPids.length > 0 ? row("计划任务", "warn", "未安装；机器人当前以前台方式运行", `如需开机自启，请以管理员身份使用 ${hint("deploy")}。`)
      : row("计划任务", "fail", "缺少，且没有健康的前台机器人", `请以管理员身份使用 ${hint("deploy")}。`));
  } else {
    const detail = `${TASK_STATES[task.state] ?? task.state}，${task.logon ? TASK_LOGONS[task.logon] ?? task.logon : "未知登录方式"}`
      + (task.lastResult === undefined ? "" : `，上次结果 ${resultHex(task.lastResult)}`);
    rows.push(task.state === "Disabled" ? row("计划任务", "fail", detail, `使用 ${hint("start")}，会启用计划任务并启动机器人。`)
      : task.state === "Running" ? row("计划任务", "pass", detail)
      : local === 200 ? row("计划任务", "warn", `${detail}；机器人可能在任务外运行`, `先通过 ${hint("stop")} 停止手动启动的机器人，再使用 ${hint("start")}。`)
      : row("计划任务", "fail", `${detail}；机器人没有运行`, stopped));
  }
  const listening = `机器人监听 :${port}`, owner = listeners.find(pid => botPids.includes(pid));
  rows.push(listeners.length === 0 ? row(listening, "fail", "没有监听", stoppedTask ? stopped : `使用 ${hint("doctor -Repair")}。`)
    : owner !== undefined ? row(listening, "pass", `pid ${owner}（mixin-bot）`)
    : local === 200 ? row(listening, "warn", `pid ${listeners.join(", ")}；健康检查有响应但未识别进程身份`,
      `在 Windows 任务管理器的「详细信息」中核对这些 PID 与命令行；${hint("doctor")} 可重新检查。`)
    : row(listening, "fail", `pid ${listeners.join(", ")} 不是健康的 mixin-bot`, `在 Windows 任务管理器中核对占用端口的进程，或通过 ${hint("deploy")} 选择其他端口。`));
  return { rows, healthFix: stoppedTask ? stopped : `使用 ${hint("doctor -Repair")}，再到 ${hint("logs")} 查看日志。` };
}

function relayRows(project: string, hint: (command: string) => string): DoctorRow[] {
  const path = join(project, "data/config/relay.json");
  if (!existsSync(path)) return [];
  let value: Record<string, unknown> | null = null;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { value = null; }
  // Required fields only: the runtime validates the whole format at start, and no credential leaves this process.
  const complete = !!value && typeof value === "object" && value.provider === "s3"
    && ["endpoint", "region", "bucket", "accessKeyId", "secretAccessKey"].every(key => typeof value![key] === "string" && (value![key] as string).trim().length > 0);
  return complete ? [row("S3 外链配置必填项", "pass", "必填项齐全；启动时执行完整格式校验")]
    : [row("data/config/relay.json", "fail", "S3 必填项不全", `使用 ${hint("relay-configure")} 重新配置。`)];
}

export interface DoctorInput {
  platform: DoctorPlatform;
  project: string;
  port: number;
  /** The external materials directory; "" for the default one in the project. */
  workspaceRoot: string;
  local: LocalStatus;
  /** The platform's rows about the service itself (container, scheduled task and listener, LaunchDaemon). */
  service: DoctorRow[];
  /** What to do when nothing answers; the verification-only instance has one answer everywhere. */
  healthFix: string;
  models: ModelsCheck;
  env?: NodeJS.ProcessEnv;
  /** The running service's status rows (`状态\t名称\t说明`) and its program; tests replace the two reads of /health. */
  probe?: { status(): Promise<string[]>; program(): Promise<ProgramVersion | undefined> };
}

export async function doctorReport(input: DoctorInput): Promise<DoctorReport> {
  const { project, port, local, platform } = input, env = input.env ?? process.env;
  const hint = (command: string) => commandHint(platform, command, env);
  const instance = join(project, "data/state/instance.json");
  const probe = input.probe ?? {
    status: async () => doctorRows(await readServiceStatus(port, instance)),
    program: () => probeProgram(project, port),
  };
  const rows: DoctorRow[] = [];
  // A missing external directory stops the service at start (it is never taken for an empty library); the default one is created by the service.
  const workspace = input.workspaceRoot;
  rows.push(!workspace ? row("共享资料目录", "pass", `${join(project, "workspace")}（默认）`)
    : existsSync(workspace) ? row("共享资料目录", "pass", `${workspace}（外置，只读）`)
    : row("共享资料目录", "fail", `外置目录不存在：${workspace}`, `恢复该目录或挂载；改用其他目录请设置 WORKSPACE_ROOT=<目录> 后使用 ${hint("deploy")}。`));
  rows.push(...input.service);
  rows.push(local === 200 ? row("本地机器人健康", "pass", "就绪且实例身份匹配")
    : local === 503 ? row("本地机器人健康", "fail", "只验证实例，不处理消息", `使用 ${hint("resume")} 继续上次操作并完成提交。`)
    : row("本地机器人健康", "fail", "未就绪或实例身份不匹配", input.healthFix));

  // The Stream and the directory come from the running service's /health: a second Stream connection is not allowed.
  let running: ProgramVersion | undefined;
  if (local === 200) {
    try {
      for (const line of await probe.status()) {
        const [state, name, detail] = line.split("\t", 3);
        if (!name) continue;
        const fix = name === "事件 Stream" ? `检查出站访问 imtwo.zdxlz.com 的 443 端口和应用凭据（${hint("configure-app-bot")}），再查看 ${hint("logs")}。`
          : name === "通讯录同步" ? `服务会自动重试和复核；用 ${hint("directory")} 查看范围状态和原因，长时间没有恢复时查看 ${hint("logs")}。`
          : name === "运行状况" ? `在 ${hint("logs")} 中查看对应记录（Durable 报告、交付超时放弃、统计累计值回退等）；停住的任务由成员用 /status 查看、/stop 或 /clear 结束。` : "";
        rows.push(row(name, state === "pass" || state === "warn" ? state : "fail", detail ?? "", fix));
      }
    } catch { rows.push(row("事件 Stream", "warn", "无法读取服务状态", `查看 ${hint("logs")}。`)); }
    try { running = await probe.program(); } catch { running = undefined; }
  }
  // The version of the running service; of the deployment record when it is not running. A checkout that differs gets its own row.
  try {
    for (const [name, value] of versionRows(versionFacts(project, running)))
      rows.push(value.startsWith("未知：") ? row(name, "fail", value, "部署记录无法读取；不要在此目录覆盖部署，参见 docs/data-migrations.md。") : row(name, "pass", value));
  } catch { rows.push(row("应用机器人", "warn", "无法读取版本信息")); }

  rows.push(existsSync(join(project, "data/config/app-bot.json")) ? row("data/config/app-bot.json", "pass", "已配置（不显示凭据）")
    : row("data/config/app-bot.json", "fail", "缺少（服务拒绝启动）", `使用 ${hint("configure-app-bot")} 填写 AppID 和 AppSecret。`));

  // The whole model configuration at once: providers and credentials in models.json, the choice in the Pi settings.
  const models = "模型配置（models.json + Pi 设置）";
  rows.push(input.models === "valid" ? row(models, "pass", "有效")
    : input.models === "busy" ? row(models, "fail", "部署、升级或运维操作尚未完成，未检查", `完成或回滚上次操作（${hint("resume")} / ${hint("rollback")}）后重新体检。`)
    : input.models === "missing" ? row(models, "fail", "缺少或无效", `通过 ${hint("deploy")} 完成首次模型配置。`)
    : row(models, "fail", "缺少或无效", "先修正 data/config/models.json 与 data/runtime/pi/settings.json。"));
  rows.push(...relayRows(project, hint));
  const count = (status: DoctorStatus) => rows.filter(item => item.status === status).length;
  return { pass: count("pass"), warn: count("warn"), fail: count("fail"), port, checks: rows };
}

export type DoctorLine = { level: "step" | DoctorStatus | "plain"; text: string };
/** The report for a terminal, line by line; each entry prints the levels in its own colours. */
export function doctorLines(report: DoctorReport, platform: DoctorPlatform, env: NodeJS.ProcessEnv = process.env): DoctorLine[] {
  const lines: DoctorLine[] = [{ level: "step", text: `mixin-bot 健康检查（本机端口=${report.port}）` }];
  for (const item of report.checks) lines.push({ level: item.status, text: `${item.name.padEnd(26)} ${item.detail}` });
  lines.push({ level: "plain", text: "" }, { level: "plain", text: `结果：${report.pass} 项通过，${report.warn} 项警告，${report.fail} 项失败` });
  const actions = [...new Map(report.checks.filter(item => item.status !== "pass" && item.fix).map(item => [item.name + item.fix, item])).values()];
  if (actions.length) {
    lines.push({ level: "plain", text: "" }, { level: "plain", text: "建议操作：" });
    for (const item of actions) lines.push({ level: "plain", text: `  - ${item.name}: ${item.fix}` });
  }
  lines.push(report.fail > 0 ? { level: "warn", text: `可尝试修复：${commandHint(platform, REPAIR[platform], env)}` }
    : report.warn > 0 ? { level: "warn", text: "必需检查已通过，但仍有警告" } : { level: "pass", text: "全部检查通过" });
  return lines;
}

const numbers = (value: string | undefined): number[] => (value ?? "").split(",").map(item => item.trim()).filter(Boolean).map(Number).filter(Number.isSafeInteger);

/**
 * ops.sh and ops.ps1: `doctor.ts --platform linux|windows --project <dir> --format json|lines`, the host's facts in
 * MIXIN_DOCTOR_*; `lines` is `level<TAB>text` for the entry to print in its own colours. Exit code 0 when nothing failed,
 * 1 when a check failed, 2 for unusable arguments or facts.
 */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, out: (text: string) => void = text => { process.stdout.write(text); },
  err: (text: string) => void = text => { process.stderr.write(text); }): Promise<number> {
  let values: { platform?: string; project?: string; format?: string };
  try { ({ values } = parseArgs({ args: [...argv], options: { platform: { type: "string" }, project: { type: "string" }, format: { type: "string" } } })); }
  catch { values = {}; }
  const { platform, project, format = "lines" } = values;
  const local = Number(env.MIXIN_DOCTOR_LOCAL ?? ""), models = env.MIXIN_DOCTOR_MODELS ?? "", port = Number(env.MIXIN_DOCTOR_PORT ?? "");
  if ((platform !== "linux" && platform !== "windows") || !project || !["json", "lines"].includes(format)
    || ![200, 503, 0].includes(local) || env.MIXIN_DOCTOR_LOCAL === undefined || env.MIXIN_DOCTOR_LOCAL.trim() === ""
    || !["valid", "invalid", "missing", "busy"].includes(models) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    err("用法：doctor.ts --platform linux|windows --project <目录> [--format json|lines]，宿主事实经 MIXIN_DOCTOR_* 传入\n");
    return 2;
  }
  const hint = (command: string) => commandHint(platform, command, env);
  const task = env.MIXIN_DOCTOR_TASK?.trim() || "", result = env.MIXIN_DOCTOR_TASK_RESULT?.trim() || "";
  const service = platform === "linux" ? linuxRows({ container: env.MIXIN_DOCTOR_CONTAINER?.trim() || "", rollback: env.MIXIN_DOCTOR_ROLLBACK?.trim() || "" }, hint)
    : windowsRows({ task: task ? { state: task, logon: env.MIXIN_DOCTOR_TASK_LOGON?.trim() || "", ...(/^-?\d+$/.test(result) ? { lastResult: Number(result) } : {}) } : null,
      listeners: numbers(env.MIXIN_DOCTOR_LISTENERS), botPids: numbers(env.MIXIN_DOCTOR_BOT_PIDS) }, local as LocalStatus, port, hint);
  const report = await doctorReport({ platform, project, port, workspaceRoot: env.MIXIN_DOCTOR_WORKSPACE?.trim() || "", local: local as LocalStatus,
    service: service.rows, healthFix: service.healthFix, models: models as ModelsCheck, env });
  if (format === "json") out(JSON.stringify(report) + "\n");
  // A row's text is one line whatever the service reported: the entries read this line by line.
  else for (const line of doctorLines(report, platform, env)) out(`${line.level}\t${line.text.replace(/[\r\n]+/g, " ")}\n`);
  return report.fail > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
