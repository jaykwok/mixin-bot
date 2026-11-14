// The bot's service on this host under its fixed names: the scheduled task mixin-bot (Windows), the containers mixin-bot and
// mixin-bot-rollback (one Docker daemon), the LaunchDaemon (macOS). One deployment per host uses them, so before a first
// deployment one may be left from another directory, or from this one after its data went. The console's first deployment
// may remove it once the operator confirmed exactly that service: its registration, its start at boot and its processes go;
// the directory it ran from keeps its files (on Linux the images stay too).
import { rmSync } from "node:fs";
import { posix, win32 } from "node:path";
import { canonical, planDigest } from "./plans.ts";
import { runCommand, type Runner } from "./hosting.ts";
import { LaunchdPlatform, type LaunchdHostFacts } from "./launchd-host.ts";
import { WindowsPlatform } from "./windows-host.ts";
import { runNative, type NativeOutput, type NativeRunner } from "./native-process.ts";
import { SOURCE_DIR } from "./platform.ts";

/** The scheduled task mixin-bot as the plan binds it, or null when there is none. A listing that fails is not "none". */
export async function scheduledTask(run: Runner): Promise<{ Actions?: { WorkingDirectory?: string }[] } | null> {
  const result = await run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; $found=@(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -ceq 'mixin-bot' }); if ($found.Count -eq 0) { 'null' } elseif ($found.Count -gt 1) { throw 'mixin-bot 计划任务不唯一' } else { $t=$found[0]; [ordered]@{Principal=[ordered]@{UserId=$t.Principal.UserId; LogonType=[string]$t.Principal.LogonType; RunLevel=[string]$t.Principal.RunLevel}; Actions=@($t.Actions | ForEach-Object { [ordered]@{Execute=$_.Execute; Arguments=$_.Arguments; WorkingDirectory=$_.WorkingDirectory} })} | ConvertTo-Json -Depth 6 -Compress }"]);
  if (result.code !== 0) throw new Error("无法核对机器人计划任务");
  return JSON.parse(result.stdout);
}
/** The bot's containers on this Docker daemon: mixin-bot and an old mixin-bot-rollback. */
export async function botContainers(run: Runner): Promise<string[]> {
  const result = await run(["docker", "ps", "-a", "--filter", "name=^/mixin-bot$", "--filter", "name=^/mixin-bot-rollback$", "--format", "{{.Names}}"]);
  if (result.code !== 0) throw new Error("无法读取 Docker 中的机器人容器");
  return result.stdout.split("\n").map(line => line.trim()).filter(Boolean);
}

/** A service of the bot's name on this host, as the first deployment's preview names it. */
export interface HostService {
  /** What the operator confirms: the service's definition (not whether it runs), compared again right before removal. */
  digest: string;
  /** The directory its definition runs from; null when it does not name exactly one. */
  directory: string | null;
  running: boolean;
  /** For example "计划任务 mixin-bot（D:\old\mixin-bot，运行中）". */
  description: string;
  /** Linux: the IDs of its containers, the ones the digest binds. */
  containers?: string[];
}
/** The host's commands, for tests: `run` reads, `native` runs the removal's long steps, `source` holds the platform scripts. */
export interface HostServiceFacts { run: Runner; launchd: Partial<LaunchdHostFacts>; native: NativeRunner; source: string; platform: NodeJS.Platform }

function place(directory: string | null, project: string, same: (a: string, b: string) => boolean): string {
  return directory === null ? "运行目录不明" : same(directory, project) ? `${directory}，即本目录` : directory;
}
const windowsPath = (path: string) => win32.resolve(path).replace(/\\+$/, "").toLowerCase();

/** The service of the bot's name on this host, whichever directory it belongs to; null when there is none. */
export async function hostService(project: string, run: Runner = runCommand, launchd: Partial<LaunchdHostFacts> = {},
  platform: NodeJS.Platform = process.platform): Promise<HostService | null> {
  if (platform === "win32") {
    const result = await run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; $found=@(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -ceq 'mixin-bot' }); if ($found.Count -eq 0) { 'null' } elseif ($found.Count -gt 1) { throw 'mixin-bot 计划任务不唯一' } else { $t=$found[0]; [ordered]@{State=[string]$t.State; Path=$t.TaskPath; Principal=[ordered]@{UserId=$t.Principal.UserId; GroupId=$t.Principal.GroupId; LogonType=[string]$t.Principal.LogonType; RunLevel=[string]$t.Principal.RunLevel}; Actions=@($t.Actions | ForEach-Object { [ordered]@{Execute=$_.Execute; Arguments=$_.Arguments; WorkingDirectory=$_.WorkingDirectory} })} | ConvertTo-Json -Depth 6 -Compress }"]);
    if (result.code !== 0) throw new Error("无法核对机器人计划任务");
    const task = JSON.parse(result.stdout) as { State?: unknown; Path?: unknown; Principal?: unknown; Actions?: unknown } | null;
    if (!task) return null;
    const actions = Array.isArray(task.Actions) ? task.Actions as { WorkingDirectory?: unknown }[] : [];
    const folder = actions.length === 1 && typeof actions[0]!.WorkingDirectory === "string" ? actions[0]!.WorkingDirectory.trim() : "";
    // As the deployment registers it (windows-platform.ps1 $owned): in the root folder, one action with its directory.
    const directory = folder && task.Path === "\\" ? win32.resolve(folder) : null, running = task.State === "Running";
    return { digest: planDigest(["windows", task.Path, task.Principal, actions]), directory, running,
      description: `计划任务 mixin-bot（${place(directory, project, (a, b) => windowsPath(a) === windowsPath(b))}，${running ? "运行中" : "未运行"}）` };
  }
  if (platform === "darwin") {
    const service = new LaunchdPlatform(project, { ...launchd, run }), facts = await service.inspect();
    if (facts.state === "absent") return null;
    let directory: string | null = null;
    try { const found = (await service.serviceDefinition())?.directory; directory = found ? posix.resolve(found) : null; } catch { directory = null; }
    const running = facts.state === "running";
    return { digest: planDigest(["darwin", facts.identity]), directory, running,
      description: `LaunchDaemon ${service.plist}（${place(directory, project, (a, b) => a === posix.resolve(b))}，${running ? "已加载" : "未加载"}）` };
  }
  const containers: { name: string; id: string; image: unknown; running: boolean; data: string | null; mounts: unknown[] }[] = [];
  for (const name of (await botContainers(run)).sort()) {
    const result = await run(["docker", "container", "inspect", name]);
    if (result.code !== 0) throw new Error(`无法核对容器 ${name}`);
    const inspected = JSON.parse(result.stdout), container = inspected[0];
    if (!Array.isArray(inspected) || inspected.length !== 1 || typeof container?.Id !== "string" || !/^[a-f0-9]{64}$/.test(container.Id))
      throw new Error(`容器 ${name} 的信息不完整`);
    const mounts: { Destination?: unknown; Source?: unknown }[] = Array.isArray(container.Mounts) ? container.Mounts : [];
    const data = mounts.find(mount => mount?.Destination === "/app/data")?.Source;
    // Docker builds Mounts from a map: successive inspections may list them in another order.
    containers.push({ name, id: container.Id, image: container.Image, running: container.State?.Running === true,
      data: typeof data === "string" ? data : null, mounts: [...mounts].sort((a, b) => canonical(a).localeCompare(canonical(b), "en")) });
  }
  if (!containers.length) return null;
  const folders = [...new Set(containers.map(container => container.data && posix.dirname(container.data)))];
  const directory = folders.length === 1 ? folders[0]! : null, running = containers.some(container => container.running);
  return { digest: planDigest(["linux", containers.map(({ name, id, image, mounts }) => [name, id, image, mounts])]), directory, running,
    description: `容器 ${containers.map(container => container.name).join("、")}（${place(directory, project, (a, b) => a === posix.resolve(b))}，${running ? "运行中" : "未运行"}）`,
    containers: containers.map(container => container.id) };
}

/** The service is not the one confirmed, or not one this can remove: nothing was changed. */
export class HostServiceChanged extends Error {}

/**
 * Removes the service the operator confirmed (`expected`, its digest) and returns what was done; a service already gone is
 * done. Anything else there now, or a task that does not name its directory, is refused before any change. A removal that
 * fails part way leaves the service stopped (Windows: also disabled), not started again.
 */
export async function removeHostService(project: string, expected: string, output: NativeOutput, facts: Partial<HostServiceFacts> = {}): Promise<string> {
  const run = facts.run ?? runCommand, launchd = facts.launchd ?? {}, native = facts.native ?? runNative, source = facts.source ?? SOURCE_DIR;
  const platform = facts.platform ?? process.platform;
  const say = (line: string) => output(`${line}\n`, "stderr");
  const found = await hostService(project, run, launchd, platform);
  if (!found) { say("本机已没有 mixin-bot 服务，无需移除。"); return "本机已没有 mixin-bot 服务"; }
  if (found.digest !== expected) throw new HostServiceChanged(`本机的 mixin-bot 服务与预览时不同（现在是${found.description}）；未移除，请重新预览`);
  // Windows refusals come before the announcement: the task's own directory and its identity there.
  let windows: { platform: WindowsPlatform; identity: string } | undefined;
  if (platform === "win32") {
    if (!found.directory) throw new HostServiceChanged("计划任务 mixin-bot 不是部署注册的形式（没有唯一的工作目录）：请在“任务计划程序”中确认后手动删除");
    const host = new WindowsPlatform(found.directory, source, native), task = await host.inspect();
    if (!task.owned || task.state === "absent") throw new HostServiceChanged("计划任务 mixin-bot 在核对期间发生了变化；未移除，请重新预览");
    windows = { platform: host, identity: task.identity };
  }
  say(`停止并移除${found.description}；那个目录的文件不删除。`);
  if (windows) {
    // One step that stops it, keeps it disabled and unregisters it, then checks neither the task nor its bot is left: the
    // supervisor trigger cannot start it in between. The identity read just now binds it.
    await windows.platform.remove(windows.identity);
  } else if (platform === "darwin") {
    const service = new LaunchdPlatform(project, { ...launchd, run });
    await service.halt();
    rmSync(service.plist, { force: true });
  } else {
    for (const id of found.containers ?? []) {
      // As the deployment stops its own container: 30 s for the bot to finish its work, then Docker kills it.
      const stopped = await native({ command: "docker", args: ["container", "stop", "--time", "30", id], cwd: source, timeoutMs: 90_000 },
        (text, stream) => { if (stream === "stderr") output(text, stream); });
      if (stopped.code !== 0) throw new Error(`无法停止容器 ${id.slice(0, 12)}（退出码 ${stopped.code}）`);
      const removed = await run(["docker", "container", "rm", id]);
      if (removed.code !== 0) throw new Error(`无法删除容器 ${id.slice(0, 12)}：${removed.stderr.trim() || "退出码 " + removed.code}`);
    }
  }
  // The Windows step checked this itself.
  if (platform !== "win32") {
    const left = await hostService(project, run, launchd, platform);
    if (left) throw new Error(`移除后仍有${left.description}`);
  }
  say(`已移除${found.description}。`);
  return `已移除${found.description}`;
}
