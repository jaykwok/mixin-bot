// doctor on macOS: the host's side of doctor.ts. The LaunchDaemon stands where the container or the scheduled task stands
// on the other platforms, and the model check runs as the service account. Read-only.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acquireDeploymentLock, type DeploymentLock } from "./deployment-lock.ts";
import { commandHint } from "./command-hint.ts";
import { doctorLines, doctorReport as report, row, savedPort, type DoctorReport, type DoctorRow, type LocalStatus, type ModelsCheck } from "./doctor.ts";
import { LaunchdPlatform, SERVICE_ACCOUNT, serviceEnvironment, type LaunchdService } from "./launchd-host.ts";
import { serviceReady } from "./readiness.ts";
import { attached, ok, step, warn, fail } from "./macos-terminal.ts";

/**
 * deploy.lock for the model check, or null while a deployment, upgrade or unfinished transaction may hold older code against
 * newer data. The check runs as the service account and holds the lock throughout: no deployment counts it as a leftover of
 * the service, and no start or stop kills it halfway.
 */
function modelCheckLock(project: string): DeploymentLock | null {
  if (["deploy-transaction", "upgrade-transaction"].some(name => existsSync(join(project, "data/state", name)))) return null;
  // A busy lock, and an unusable lock file alike, count as in progress.
  try { return acquireDeploymentLock(project); }
  catch { return null; }
}

function serviceRow(service: LaunchdService | Error, local: LocalStatus, hint: (command: string) => string): DoctorRow {
  const stopped = `有意停止的使用 ${hint("start")} 启动；意外退出时先在 ${hint("logs")} 查看日志，再使用 ${hint("doctor --repair")}。`;
  if (service instanceof Error) return row("LaunchDaemon", "fail", `无法读取：${service.message}`, "以 root 运行（sudo）后重试。");
  if (!service.owned) return row("LaunchDaemon", "fail", "属于其他目录或其他账户", "先在那个目录卸载它，再在本目录部署。");
  switch (service.state) {
    case "absent":
      return local === 200 ? row("LaunchDaemon", "warn", "未安装；机器人当前以前台方式运行", `如需开机自启，请使用 ${hint("deploy")}。`)
        : row("LaunchDaemon", "fail", "未安装，且没有健康的前台机器人", `请使用 ${hint("deploy")}。`);
    case "unsupported": return row("LaunchDaemon", "fail", `状态（${service.rawState}）或服务账户 ${SERVICE_ACCOUNT} 不支持`, `请使用 ${hint("deploy")} 重新部署。`);
    case "running": return service.rawState === "running" ? row("LaunchDaemon", "pass", `已加载并运行，以 ${SERVICE_ACCOUNT} 运行`)
      : row("LaunchDaemon", "fail", `已加载但没有运行（launchd 状态：${service.rawState}）`, `使用 ${hint("start")} 重新启动；先在 ${hint("logs")} 查看它为什么退出。`);
    case "stopped":
      if (service.leftovers > 0) return row("LaunchDaemon", "warn", `已停止；服务账户有 ${service.leftovers} 个进程在运行（前台运行的机器人或残留进程）`,
        `前台机器人用 Ctrl+C 结束；之后使用 ${hint("start")}。`);
      return row("LaunchDaemon", "fail", "已停止（保持禁用，开机也不会启动）", stopped);
  }
}

export interface DoctorOptions {
  project: string;
  bun: string;
  /** PATH of the service (its definition's), for the model check. */
  path: string;
  env?: NodeJS.ProcessEnv;
  service?: LaunchdPlatform;
}

export async function doctorReport(options: DoctorOptions): Promise<DoctorReport> {
  const { project, bun, path } = options, env = options.env ?? process.env, port = savedPort(project, env);
  const hint = (command: string) => commandHint("macos", command, env);
  let workspaceRoot = "";
  try { workspaceRoot = readFileSync(join(project, "data/state/workspace-root"), "utf8").trim(); } catch { workspaceRoot = ""; }
  const local: LocalStatus = await serviceReady(project, 3000) ? 200 : await serviceReady(project, 3000, { verification: true }) ? 503 : 0;
  const platform = options.service ?? new LaunchdPlatform(project);
  const service = await platform.inspect().catch(error => error instanceof Error ? error : new Error(String(error)));
  const stoppedService = !(service instanceof Error) && service.state === "stopped" && service.leftovers === 0;

  let models: ModelsCheck = "missing";
  if (existsSync(join(project, "data/config/models.json"))) {
    const lock = modelCheckLock(project);
    if (!lock) models = "busy";
    else {
      try {
        const user = service instanceof Error ? undefined : service.user;
        const code = user ? await attached([bun, "--no-env-file", "run", join(project, "ops/config/validate-models.ts"), project],
          { cwd: project, env: { ...serviceEnvironment(project), PATH: path }, identity: user, quiet: true }) : 1;
        models = code === 0 ? "valid" : "invalid";
      } finally { lock.close(); }
    }
  }
  return report({ platform: "macos", project, port, workspaceRoot, local, service: [serviceRow(service, local, hint)],
    healthFix: stoppedService ? `使用 ${hint("start")} 启动。` : `使用 ${hint("doctor --repair")}，再到 ${hint("logs")} 查看日志。`, models, env });
}

/** Human output; true when nothing failed. */
export function printDoctor(result: DoctorReport, env: NodeJS.ProcessEnv = process.env): boolean {
  for (const line of doctorLines(result, "macos", env)) {
    if (line.level === "step") step(line.text); else if (line.level === "pass") ok(line.text);
    else if (line.level === "warn") warn(line.text); else if (line.level === "fail") fail(line.text); else console.log(line.text);
  }
  return result.fail === 0;
}
