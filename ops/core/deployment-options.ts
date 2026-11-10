// Explicit choices for new lifecycle operations. No stdin defaults and no arbitrary environment/argv from the browser.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, win32 } from "node:path";
import { readDirectoryScope } from "../../src/integrations/open-platform/directory-scope.ts";
import { assertMaintenanceAction } from "../../src/core/maintenance-state.ts";
import { readConfigurationState } from "../../src/core/configuration-state.ts";
import { RUNTIME_KEYS } from "../../src/core/runtime-schema.ts";
import { loadPendingTransaction } from "./pending-transaction.ts";
import { assertLifecycleTarget } from "./recovery-plan.ts";
import { parsePort } from "./console-port.ts";
import { canonical, planDigest } from "./plans.ts";
import { runCommand, type Runner } from "./hosting.ts";
import { ownsDataMount } from "./deployment-data.ts";
import { nativeService } from "./platform.ts";
import { LaunchdPlatform, SERVICE_ACCOUNT, type LaunchdHostFacts } from "./launchd-host.ts";
import { ConfigurationDrafts } from "./configuration-drafts.ts";
import { deploymentRecord } from "../../src/core/data-version.ts";
import { directoryChoice, checkedDirectoryChoice, directoryChoiceText, type DirectoryChoice } from "../lib/directory-choice.ts";
import { REQUIRED_SETTINGS } from "../lib/settings-files.ts";
import { assertUninstallable } from "./uninstall.ts";

type Common = { directory: "saved" | "all" | DirectoryChoice };
export type UpgradeOptions = Common & { target: string; switchMain: boolean };
export type DeployOptions = Common & { port: number; workspace: string };
/** A configuration draft as the console confirmed it (configuration-drafts.ts). */
export type DraftReference = { draft: string; digest: string };
/** A first deployment: the configuration comes from checked console drafts and the directory scope is chosen now. */
export type InstallOptions = DeployOptions & { directory: "all" | DirectoryChoice; app: DraftReference; models: DraftReference };
export type DeploymentOperation = "update" | "deploy" | "install";
const INPUTS = ["data/state/data-version.json", "data/state/release-data.json", "data/state/bot-port", "data/state/workspace-root",
  "data/config/app-bot.json", "data/config/models.json", "data/config/runtime.json", "data/config/directory.json",
  "data/runtime/pi/settings.json", ".console/port"];

function draftReference(value: unknown): DraftReference {
  const raw = value as Partial<DraftReference> | null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort().join(",") !== "digest,draft"
    || typeof raw.draft !== "string" || !/^config-[a-f0-9]{32}$/.test(raw.draft) || typeof raw.digest !== "string" || !/^[a-f0-9]{64}$/.test(raw.digest))
    throw new Error("首次部署需要已校验的应用机器人和模型配置");
  return { draft: raw.draft, digest: raw.digest };
}

export function deploymentOptions(operation: DeploymentOperation, input: Record<string, unknown>): UpgradeOptions | DeployOptions | InstallOptions {
  const keys = ["directory", ...(operation === "update" ? ["target", "switchMain"] : ["port", "workspace"]), ...(operation === "install" ? ["app", "models"] : [])];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== keys.length
    || Object.keys(input).some(key => !keys.includes(key))) throw new Error("请明确选择每项部署设置，不接受缺失或多余参数");
  if (operation === "install" && input.directory === "saved") throw new Error("首次部署需要选择通讯录同步范围");
  const common: Common = { directory: input.directory === "saved" || input.directory === "all" ? input.directory : directoryChoice(input.directory) };
  if (operation === "update") {
    if (typeof input.target !== "string" || !/^[a-f0-9]{40}$/.test(input.target) || typeof input.switchMain !== "boolean") throw new Error("升级需要已核对的完整提交和明确的分支切换选择");
    return { ...common, target: input.target, switchMain: input.switchMain };
  }
  if (!Number.isSafeInteger(input.port) || Number(input.port) < 1 || Number(input.port) > 65535 || typeof input.workspace !== "string"
    || input.workspace.length > 4096 || /[\x00-\x1f]/.test(input.workspace) || input.workspace !== input.workspace.trim()
    || (input.workspace !== "" && !isAbsolute(input.workspace))) throw new Error("部署需要有效端口和共享目录的绝对路径；空目录表示使用默认目录");
  const deploy = { ...common, port: Number(input.port), workspace: input.workspace };
  if (operation !== "install") return deploy;
  return { ...deploy, directory: deploy.directory as InstallOptions["directory"], app: draftReference(input.app), models: draftReference(input.models) };
}

/** These are named internal choices, not a shell fragment. Clear ambient overrides when preserving saved settings. */
export function deploymentEnvironment(operation: DeploymentOperation, input: Record<string, unknown>, project: string): Record<string, string> {
  const value = deploymentOptions(operation, input);
  return { ...Object.fromEntries(RUNTIME_KEYS.map(key => [key, ""])),
    MIXIN_OPS_LIFECYCLE: operation,
    MIXIN_OPS_DIRECTORY: typeof value.directory === "string" ? value.directory : "selected", BOT_DIRECTORY_SCOPE: value.directory === "all" ? "all" : "",
    MIXIN_OPS_DIRECTORY_INPUT: typeof value.directory === "string" ? "" : directoryChoiceText(value.directory),
    MIXIN_OPS_DIRECTORY_APP: typeof value.directory === "string" ? "" : value.directory.appHash,
    MIXIN_OPS_SWITCH_MAIN: "switchMain" in value && value.switchMain ? "1" : "0",
    // A first deployment's drafts as "<draft>:<digest>"; console-stage.ts stages them for the core.
    MIXIN_OPS_APP_DRAFT: "app" in value ? `${value.app.draft}:${value.app.digest}` : "",
    MIXIN_OPS_MODELS_DRAFT: "models" in value ? `${value.models.draft}:${value.models.digest}` : "",
    BOT_PORT: "port" in value ? String(value.port) : "",
    WORKSPACE_ROOT: "workspace" in value ? value.workspace || (nativeService() ? join(project, "workspace") : "") : "" };
}

export function assertDeploymentEnvironment(operation: string, input: Record<string, unknown>, project: string, env = process.env): void {
  const expectedEnvironment = operation === "repair" ? repairEnvironment(project, input) : operation === "uninstall" ? uninstallEnvironment(input)
    : operation === "update" || operation === "deploy" || operation === "install" ? deploymentEnvironment(operation, input, project) : null;
  if (!expectedEnvironment) return;
  for (const [key, expected] of Object.entries(expectedEnvironment)) {
    // The upgrader unsets cleared runtime overrides before handing off to the core.
    if ((env[key] ?? "") !== expected) throw new Error(`${operation === "uninstall" ? "卸载" : "部署"}选择未完整传递（${key}），未执行操作`);
  }
}

/** An uninstall's two explicit choices: archive data/ and logs/, and (Linux only) remove the image. */
export type UninstallOptions = { data: boolean; image: boolean };
export function uninstallOptions(input: Record<string, unknown>): UninstallOptions {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join(",") !== "data,image"
    || typeof input.data !== "boolean" || typeof input.image !== "boolean") throw new Error("卸载需要明确选择是否归档数据和删除镜像");
  if (input.image && nativeService()) throw new Error("只有 Linux 部署有镜像可删除");
  return { data: input.data, image: input.image };
}
/** The entries read these in console mode instead of asking. */
export function uninstallEnvironment(input: Record<string, unknown>): Record<string, string> {
  const value = uninstallOptions(input);
  return { MIXIN_OPS_UNINSTALL_DATA: value.data ? "1" : "0", MIXIN_OPS_UNINSTALL_IMAGE: value.image ? "1" : "0" };
}

/**
 * A console uninstall: the service the entry stops and removes, and what happens to data/, logs/ and the image. Only this
 * deployment's service: one of another directory is refused (the entries would remove it by name). The scope binds the
 * service's identity, so the entry, rechecking under its lock, removes what the preview showed.
 */
export async function uninstallScope(project: string, params: Record<string, unknown>, run: Runner = runCommand, launchd: Partial<LaunchdHostFacts> = {}) {
  const options = uninstallOptions(params);
  assertUninstallable(project);
  const summary: string[] = [];
  let identity: unknown, installed: boolean;
  if (process.platform === "win32") {
    const task = await scheduledTask(run), actions = task?.Actions;
    if (task && (actions?.length !== 1 || !sameWindowsPath(actions[0]!.WorkingDirectory ?? "", project))) throw new Error("本机的计划任务 mixin-bot 属于另一个目录：请在那个目录卸载");
    identity = task; installed = task !== null;
    summary.push(task ? "停止机器人并注销计划任务 mixin-bot；launcher 移入 backup/rm。" : "计划任务 mixin-bot 不存在；结束本项目残留的机器人进程（如有）。");
  } else if (process.platform === "darwin") {
    const service = await new LaunchdPlatform(project, { ...launchd, run }).inspect();
    if (!service.owned) throw new Error("机器人 LaunchDaemon 属于其他目录或其他账户：请在那个目录卸载");
    identity = service.identity; installed = service.state !== "absent";
    summary.push(installed ? "停止机器人并删除 LaunchDaemon。" : "LaunchDaemon 不存在；结束本项目残留的机器人进程（如有）。",
      `保留服务账户 ${SERVICE_ACCOUNT}（data/ 及其归档仍属于它）。`);
  } else {
    const containers: [string, string][] = [];
    for (const name of (await botContainers(run)).sort()) {
      const result = await run(["docker", "container", "inspect", name]);
      if (result.code !== 0) throw new Error(`无法核对容器 ${name}`);
      const inspected = JSON.parse(result.stdout), container = inspected[0];
      if (inspected.length !== 1 || !ownsDataMount(project, container?.Mounts)) throw new Error(`容器 ${name} 不属于此部署：请在它所属的目录卸载`);
      containers.push([name, container.Id]);
    }
    identity = containers; installed = containers.length > 0;
    summary.push(containers.length ? `停止并删除容器 ${containers.map(([name]) => name).join("、")}。` : "容器 mixin-bot 不存在。",
      options.image ? "删除镜像 mixin-bot 和部署回滚标签 mixin-bot:previous；下次部署重新构建。" : "保留镜像 mixin-bot。");
  }
  const present = (path: string) => { try { lstatSync(join(project, path)); return true; } catch { return false; } };
  const data = present("data"), logs = present("logs");
  let workspace = "";
  // As fileHash: the console may be root and data/state belongs to the service, so only a bounded regular file is read.
  try {
    const path = join(project, "data/state/workspace-root"), info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new Error("data/state/workspace-root 不是有效的普通文件，请先检查部署记录");
    workspace = readFileSync(path, "utf8").trim();
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; /* the default workspace */ }
  if (!installed && !data && !logs) throw new Error("没有可卸载的服务或数据");
  summary.push(!options.data ? "保留 data/ 和 logs/：之后可在维护页重新部署，沿用原有配置、会话和统计。"
    : data || logs ? "data/ 和 logs/（配置、部署状态、会话、临时文件和统计）移入 backup/rm，不直接删除；本目录回到尚未部署，可以重新首次部署。"
      : "data/ 和 logs/ 不存在。",
  workspace ? `外置共享资料目录 ${workspace} 不删除。` : "项目的 workspace/ 目录（共享资料）不删除。");
  return { scope: planDigest(["uninstall", options, identity, data, logs, workspace]), summary };
}

export function repairEnvironment(project: string, params: Record<string, unknown>): Record<string, string> {
  return nativeService() ? { ...Object.fromEntries(RUNTIME_KEYS.map(key => [key, ""])), MIXIN_OPS_LIFECYCLE: "repair" }
    : deploymentEnvironment("deploy", params, project);
}

export async function repairScope(project: string, params: Record<string, unknown>, run: Runner = runCommand, launchd: Partial<LaunchdHostFacts> = {}) {
  if (!nativeService()) return deploymentScope(project, "deploy", params, run);
  if (loadPendingTransaction(project) || readConfigurationState(project)) throw new Error("请先完成或恢复未结束的维护事务");
  assertMaintenanceAction(project, "service");
  const before = INPUTS.map(path => [path, fileHash(join(project, path))]), { identity } = await deploymentIdentity(project, run, launchd);
  if (planDigest(before) !== planDigest(INPUTS.map(path => [path, fileHash(join(project, path))]))) throw new Error("预览期间部署设置已变化，请重试");
  return { scope: planDigest([before, identity]), summary: ["检查本机实例身份与就绪状态，未就绪时尝试重启（包括当前停止的实例）。",
    `本机已就绪时不重启。不改配置或数据；${process.platform === "darwin" ? "LaunchDaemon" : "计划任务"}缺失或安装损坏时，请使用重新部署。`] };
}

function fileHash(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error("部署设置必须是普通文件且大小有上限");
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function deploymentScope(project: string, operation: DeploymentOperation, params: Record<string, unknown>, run: Runner = runCommand,
  launchd: Partial<LaunchdHostFacts> = {}) {
  const options = deploymentOptions(operation, params);
  if (loadPendingTransaction(project)) throw new Error("请先继续或回滚未完成的部署或升级");
  if (readConfigurationState(project)) throw new Error("请先完成或恢复未结束的配置事务");
  // The redeployment restarts the service: an unfinished ops task or an unreadable state record refuses it.
  assertMaintenanceAction(project, "service");
  const before = INPUTS.map(path => [path, fileHash(join(project, path))]);
  for (const path of [...REQUIRED_SETTINGS, "data/state/data-version.json"]) {
    if (fileHash(join(project, path)) === null) throw new Error("请先完成首次部署及模型、机器人配置；网页只重新部署已有实例");
  }
  const directory = readDirectoryScope(join(project, "data/config/directory.json"));
  if (options.directory === "saved" && !directory) throw new Error("没有已保存的通讯录范围，请先选择同步范围");
  if (options.directory === "all" && directory) throw new Error("已有同步范围；请在通讯录设置修改，然后选择沿用保存值");
  if (typeof options.directory === "object") {
    if (directory) throw new Error("已有同步范围；请在通讯录设置修改，然后选择沿用保存值");
    checkedDirectoryChoice(project, options.directory);
  }
  const branch = await run(["git", "-C", project, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.code !== 0) throw new Error("无法核对当前分支");
  let workspaceIdentity: unknown = null;
  if ("target" in options) {
    const status = await run(["git", "-C", project, "status", "--porcelain", "--untracked-files=no"]);
    if (status.code !== 0 || status.stdout.trim()) throw new Error("已跟踪文件有改动，未开始升级");
    if (branch.stdout.trim() !== "main" && !options.switchMain) throw new Error("当前不在 main，请明确允许切换分支再预览");
    await assertLifecycleTarget(project, options.target, run);
  } else {
    const portFile = readFileSync(join(project, ".console/port"), "utf8");
    if (options.port === parsePort(portFile, "控制台 ")) throw new Error("机器人目标端口与控制台端口相同，未停止机器人");
    if (options.workspace) {
      const path = realpathSync(options.workspace), stat = lstatSync(path);
      if (!stat.isDirectory()) throw new Error("共享资料目录不存在或不是目录");
      workspaceIdentity = [path, String(stat.dev), String(stat.ino)];
    }
  }
  const { identity, note } = await deploymentIdentity(project, run, launchd, operation === "deploy");
  if (planDigest(before) !== planDigest(INPUTS.map(path => [path, fileHash(join(project, path))]))) throw new Error("预览期间部署设置已变化，请重试");
  return { scope: planDigest([before, options, branch.stdout.trim(), workspaceIdentity, identity]), summary: [
    "target" in options ? `目标提交：${options.target}；当前分支：${branch.stdout.trim()}；${options.switchMain ? "允许切换到 main" : "不允许切换分支"}。`
      : `重新部署当前代码；端口 ${options.port}；共享资料：${options.workspace || "workspace（默认）"}。`,
    ...note ? [note] : [],
    options.directory === "saved" ? "沿用已保存的通讯录范围。" : options.directory === "all" ? "首次设置通讯录范围：整个通讯录。"
      : `首次设置通讯录范围：${options.directory.names.join("、")}（含全部子部门）。`,
    "target" in options ? "原来运行的实例升级后恢复运行；原来停止的实例保持停止。" : "重新部署完成后启动机器人，包括当前处于停止状态的实例。",
    "沿用模型与机器人凭据；目标脚本在停机前校验。提交前失败恢复原部署，提交后只能继续收尾。",
  ] };
}

/**
 * A first deployment from the console: nothing deployed here and no service of this name on the host; the configuration is the
 * pair of checked drafts, read again (task-bound by then) whenever the plan is verified. Only files the entry does not create
 * before the core count: it makes directories, logs, a stage and images, and on macOS the service account.
 */
export async function installScope(project: string, params: Record<string, unknown>, run: Runner = runCommand, launchd: Partial<LaunchdHostFacts> = {}) {
  const options = deploymentOptions("install", params) as InstallOptions;
  if (loadPendingTransaction(project)) throw new Error("请先继续或回滚未完成的部署或升级");
  if (deploymentRecord(project)) throw new Error("本目录已经部署过：请使用重新部署");
  if (readConfigurationState(project)) throw new Error("请先完成或恢复未结束的配置事务");
  assertMaintenanceAction(project, "service");
  const before = INPUTS.map(path => [path, fileHash(join(project, path))]);
  if (fileHash(join(project, "data/config/directory.json")) !== null) throw new Error("尚未部署，但已有 data/config/directory.json：请确认它的来历并移走后再首次部署");
  const drafts = new ConfigurationDrafts(project);
  const app = drafts.deploymentDraft(options.app.draft, "app", options.app.digest), models = drafts.deploymentDraft(options.models.draft, "models", options.models.digest);
  if (typeof options.directory === "object" && options.directory.appHash !== createHash("sha256").update(app.next.files.app!).digest("hex"))
    throw new Error("部门是用另一份应用凭据读取的，请重新选择部门");
  const branch = await run(["git", "-C", project, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.code !== 0) throw new Error("无法核对当前分支");
  if (options.port === parsePort(readFileSync(join(project, ".console/port"), "utf8"), "控制台 ")) throw new Error("机器人端口与控制台端口相同，请换一个端口");
  let workspaceIdentity: unknown = null;
  if (options.workspace) {
    const path = realpathSync(options.workspace), stat = lstatSync(path);
    if (!stat.isDirectory()) throw new Error("共享资料目录不存在或不是目录");
    workspaceIdentity = [path, String(stat.dev), String(stat.ino)];
  }
  await assertNoService(project, run, launchd);
  if (planDigest(before) !== planDigest(INPUTS.map(path => [path, fileHash(join(project, path))]))) throw new Error("预览期间部署设置已变化，请重试");
  const platform = process.platform === "win32" ? "注册开机启动的计划任务 mixin-bot" : process.platform === "darwin" ? `创建服务账户 ${SERVICE_ACCOUNT}（尚未创建时）并安装 LaunchDaemon`
    : "构建镜像并创建服务容器 mixin-bot";
  return { scope: planDigest([before, options, branch.stdout.trim(), workspaceIdentity]), summary: [
    `首次部署当前代码；端口 ${options.port}；共享资料：${options.workspace || "workspace（默认）"}。`,
    ...app.validated!.summary, ...models.validated!.summary,
    options.directory === "all" ? "通讯录同步范围：整个通讯录。" : `通讯录同步范围：${options.directory.names.join("、")}（含全部子部门）。`,
    `${platform}；部署完成后启动机器人。`,
    "部署前在本次代码中再次核对配置和数据；提交前失败撤销本次的全部改动，不留下服务。",
  ] };
}

/**
 * Two Windows paths naming the same directory, as the PowerShell entries compare the task's directory with theirs (`-eq`:
 * without case). The task keeps the directory as it was typed when the bot was deployed, this process has it as the
 * file system spells it: `d:\projects\Mixin-Bot` and `D:\Projects\mixin-bot` are one deployment.
 */
export function sameWindowsPath(a: string, b: string): boolean {
  const normal = (path: string) => win32.resolve(path).replace(/\\+$/, "").toLowerCase();
  return normal(a) === normal(b);
}

/** The scheduled task mixin-bot as the plan binds it, or null when there is none. A listing that fails is not "none". */
async function scheduledTask(run: Runner): Promise<{ Actions?: { WorkingDirectory?: string }[] } | null> {
  const result = await run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; $found=@(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -ceq 'mixin-bot' }); if ($found.Count -eq 0) { 'null' } elseif ($found.Count -gt 1) { throw 'mixin-bot 计划任务不唯一' } else { $t=$found[0]; [ordered]@{Principal=[ordered]@{UserId=$t.Principal.UserId; LogonType=[string]$t.Principal.LogonType; RunLevel=[string]$t.Principal.RunLevel}; Actions=@($t.Actions | ForEach-Object { [ordered]@{Execute=$_.Execute; Arguments=$_.Arguments; WorkingDirectory=$_.WorkingDirectory} })} | ConvertTo-Json -Depth 6 -Compress }"]);
  if (result.code !== 0) throw new Error("无法核对机器人计划任务");
  return JSON.parse(result.stdout);
}
/** The bot's containers on this Docker daemon: mixin-bot and an old mixin-bot-rollback. */
async function botContainers(run: Runner): Promise<string[]> {
  const result = await run(["docker", "ps", "-a", "--filter", "name=^/mixin-bot$", "--filter", "name=^/mixin-bot-rollback$", "--format", "{{.Names}}"]);
  if (result.code !== 0) throw new Error("无法读取 Docker 中的机器人容器");
  return result.stdout.split("\n").map(line => line.trim()).filter(Boolean);
}

/** Before a first deployment: no bot service of this name on this host (one deployment per host and Docker daemon). */
async function assertNoService(project: string, run: Runner, launchd: Partial<LaunchdHostFacts>): Promise<void> {
  if (process.platform === "win32") {
    if (await scheduledTask(run) !== null) throw new Error("本机已有计划任务 mixin-bot：一台机器只运行一个部署，请先在原目录卸载");
  } else if (process.platform === "darwin") {
    const service = await new LaunchdPlatform(project, { ...launchd, run }).inspect();
    if (service.state !== "absent") throw new Error("本机已有机器人 LaunchDaemon：一台机器只运行一个部署，请先在原目录卸载");
  } else {
    const names = await botContainers(run);
    if (names.length) throw new Error(`Docker 中已有容器 ${names.join("、")}：同一个 Docker 只运行一个部署，请先在原目录卸载`);
  }
}

/**
 * The deployed service the plan binds. `missing`: a redeployment may recreate a service that is gone (an uninstall that kept
 * the data, or one removed by hand); the plan then binds its absence, and on Linux the data/state owner the entry runs the
 * service as (deploy.sh determine_service_user, which takes this confirmation instead of asking).
 * `launchd`: the service definition's place and the host facts beside `run`, for tests.
 */
async function deploymentIdentity(project: string, run: Runner, launchd: Partial<LaunchdHostFacts>, missing = false): Promise<{ identity: unknown; note?: string }> {
  let identity: unknown;
  if (process.platform === "win32") {
    const task = await scheduledTask(run);
    if (task === null) {
      if (!missing) throw new Error("计划任务 mixin-bot 不存在（例如卸载时保留了数据）：请先在维护页重新部署，它会重新注册计划任务");
      return { identity: "absent", note: "计划任务 mixin-bot 不存在：重新部署会重新注册它。" };
    }
    identity = task;
    const actions = task.Actions;
    if (actions?.length !== 1 || !sameWindowsPath(actions[0]!.WorkingDirectory ?? "", project)) throw new Error("机器人计划任务不属于此部署");
  } else if (process.platform === "darwin") {
    const service = await new LaunchdPlatform(project, { ...launchd, run }).inspect();
    if (service.state === "absent") {
      if (!missing) throw new Error("LaunchDaemon 不存在（例如卸载时保留了数据）：请先在维护页重新部署，它会重新安装 LaunchDaemon");
      // An uninstall keeps the account (data/ still belongs to it); a new one would need its ownership confirmed by hand.
      if (!service.user) throw new Error(`服务账户 ${SERVICE_ACCOUNT} 不存在：数据目录的属主需要人工确认，请在终端用 sudo bash scripts/ops.sh deploy 重新部署`);
      return { identity: [service.identity, service.user], note: `LaunchDaemon 不存在：重新部署会重新安装它，沿用服务账户 ${SERVICE_ACCOUNT}。` };
    }
    if (!service.owned || service.state === "unsupported") throw new Error("机器人 LaunchDaemon 不属于此部署");
    identity = service.identity;
  } else {
    const names = await botContainers(run);
    if (!names.includes("mixin-bot")) {
      if (!missing) throw new Error("容器 mixin-bot 不存在（例如卸载时保留了数据）：请先在维护页重新部署，它会重新创建容器");
      if (names.length) throw new Error("发现旧回滚容器 mixin-bot-rollback，请先确认其状态");
      const stat = lstatSync(join(project, "data/state"));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("data/state 不是目录，无法确定服务身份");
      const owner = `${stat.uid}:${stat.gid}`;
      // As service_user_from_data: rootless Docker (the operator is not root, docker-host.ts) runs the service as 0:0,
      // which the daemon maps to its own user, so data/state must belong to that user.
      const uid = process.geteuid!();
      if (uid === 0) return { identity: { absent: true, owner }, note: `找不到容器 mixin-bot：重新部署会重新创建它，服务以 data/state 的属主（UID:GID ${owner}）运行，已有数据的属主不变。` };
      if (stat.uid !== uid) throw new Error(`data/state 属于 ${owner}，不是运行 rootless Docker 的当前用户（UID ${uid}），无法确定服务身份`);
      return { identity: { absent: true, owner, user: "0:0" }, note: `找不到容器 mixin-bot：重新部署会重新创建它，服务在容器里以 0:0 运行，由 rootless Docker 映射为 data/state 的属主（UID:GID ${owner}），已有数据的属主不变。` };
    }
    const result = await run(["docker", "container", "inspect", "mixin-bot"]);
    if (result.code !== 0) throw new Error("无法核对机器人容器身份");
    const containers = JSON.parse(result.stdout), c = containers[0];
    if (containers.length !== 1 || !ownsDataMount(project, c?.Mounts)) throw new Error("机器人容器不属于此部署");
    // Docker builds Mounts from a map: successive inspections may return the same mounts in a different order.
    // Keep every property in the confirmation, but make this unordered collection stable across processes.
    const mounts = [...c.Mounts].sort((a, b) => canonical(a).localeCompare(canonical(b), "en"));
    identity = { id: c.Id, image: c.Image, user: c.Config?.User, mounts };
  }
  return { identity };
}
