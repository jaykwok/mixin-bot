// macOS effects of a deployment transaction: the LaunchDaemon definition, the snapshot's settings copies, the dependencies
// and the directories the service account writes. runDeployment owns ordering, commit boundaries and rollback; nothing here
// decides them. The core runs as root and the service account owns data/, logs/ and backup/. So root keeps what it trusts
// (the transaction record, the definition it may reinstall, the tool paths, the snapshot state, the saved dependencies) in
// .console/deployments/<name> (transactionDirectory), out of the account's reach, and changes the account's own trees only as
// the account (the settings copies in backup/snapshots/<name>, archives, removals): a link or a second name the account may
// have left there is then followed with the account's rights, never with root's.
import { closeSync, constants, fchownSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { publish, publishJson } from "../../src/lib/atomic-file.ts";
import { parseRecord, serializeRecord, type Values } from "./key-value-record.ts";
import type { NativeRunner } from "./native-process.ts";
import type { Owner } from "./deployment-files.ts";
import { transactionDirectory } from "../lib/confirmed-transaction.ts";
import { EXIT_TIMEOUT_SECONDS, LAUNCHD_LABEL, plistDocument, SERVICE_ACCOUNT, serviceEnvironment, type LaunchdPlatform, type LaunchdService } from "./launchd-host.ts";
import { MaintenanceRefused } from "./maintenance.ts";
import { snapshotPaths } from "../lib/settings-files.ts";

// The deploy entry finds these before the stop; the service definition runs exactly them.
const TOOL_KEYS = ["format", "bun", "git", "uv", "bash", "coreutils"] as const;
export type MacosTools = Values<typeof TOOL_KEYS[number]>;
const toolPath = /^\/[^\x00-\x1f\x7f]*$/;
export const parseMacosTools = (text: string): MacosTools => parseRecord(text, TOOL_KEYS,
  { format: /^1$/, bun: toolPath, git: toolPath, uv: toolPath, bash: toolPath, coreutils: toolPath }, "部署工具记录");
export const serializeMacosTools = (tools: MacosTools) => serializeRecord(tools, TOOL_KEYS);

const MACOS_FILES = snapshotPaths("macos");
/** What the service account writes, parents first. Created for it when missing; an existing one must already be its own. */
export const SERVICE_DIRECTORIES = ["data", "data/config", "data/state", "data/runtime", "data/runtime/home", "logs", "logs/operations", "backup", "backup/snapshots", "backup/rm"];
const SYSTEM = { cp: "/bin/cp", mv: "/bin/mv", mkdir: "/bin/mkdir", rm: "/bin/rm", chmod: "/bin/chmod" };
const STATE_FILE = "macos-state.json", PLIST_COPY = "service.plist";
export const TOOLS_FILE = "macos-tools";

export interface MacosSnapshot {
  format: 1;
  operation: "upgrade" | "deploy";
  project: string;
  identity: string;
  wasRunning: boolean;
  hasService: boolean;
  dependenciesAttempted: boolean;
  dependenciesMoved: boolean;
}

/** The service's PATH: the recorded tools first, then the system's. */
export const servicePath = (tools: MacosTools) =>
  [...new Set([tools.coreutils, dirname(tools.bash), dirname(tools.uv), dirname(tools.bun), dirname(tools.git), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");

/**
 * The LaunchDaemon: the service account, the supervisor of this checkout, and the recorded tools first in PATH. launchd itself
 * writes nothing into the account's directories: the supervisor, already the account, opens the stderr log.
 */
export function servicePlist(project: string, tools: MacosTools): string {
  const root = resolve(project);
  const definition = {
    Label: LAUNCHD_LABEL, UserName: SERVICE_ACCOUNT, WorkingDirectory: root,
    ProgramArguments: [tools.bun, "--no-env-file", "run", join(root, "ops/core/launchd-supervisor.ts"), "--bun", tools.bun, "--git", tools.git,
      "--stderr", join(root, "logs/service-stderr.log")],
    EnvironmentVariables: { PATH: servicePath(tools), LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HOME: join(root, "data/runtime/home"),
      // The checkout belongs to the operator: the service only reads it, and Git refuses that without this.
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: root },
    RunAtLoad: true, KeepAlive: { SuccessfulExit: false }, ThrottleInterval: 10, ExitTimeOut: EXIT_TIMEOUT_SECONDS, Umask: 0o077, ProcessType: "Standard",
    SoftResourceLimits: { NumberOfFiles: 8192 }, HardResourceLimits: { NumberOfFiles: 8192 },
    StandardOutPath: "/dev/null", StandardErrorPath: "/dev/null",
  };
  return plistDocument(definition);
}

/**
 * Where the service account could replace the tool at `path`, or null: neither the path as given nor the file it resolves to,
 * nor any directory above them, may belong to the account or be writable to it (its group, or everyone).
 */
export function toolReplaceable(path: string, account: Owner): string | null {
  for (const start of [resolve(path), realpathSync(path)]) {
    for (let at = start; ; at = dirname(at)) {
      const info = lstatSync(at), link = info.isSymbolicLink();
      if (info.uid === account.uid || !link && ((info.mode & 0o002) !== 0 || (info.mode & 0o020) !== 0 && info.gid === account.gid)) return at;
      if (dirname(at) === at) break;
    }
  }
  return null;
}
/** Refuses a recorded tool the service account could replace (toolReplaceable). Root runs the recorded Git. */
export function assertToolsTrusted(tools: MacosTools, account: Owner): void {
  for (const key of ["bun", "git", "uv", "bash", "coreutils"] as const) {
    const at = toolReplaceable(tools[key], account);
    if (at) throw new MaintenanceRefused(`${key} 的路径 ${tools[key]} 可被服务账户 ${SERVICE_ACCOUNT} 改动（${at}）；请用 Homebrew 或系统自带的版本重新部署`);
  }
}

const present = (path: string) => {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
};

/**
 * Root's own records of transaction `name` (transactionDirectory), under root's .console. 0711 like .console: the account
 * reads the plans root gave it there, by name, and can neither list, replace nor read anything else. `create` makes it.
 */
export function rootRecords(project: string, name: string, create = false): string {
  const path = join(project, transactionDirectory(name)), parent = dirname(path);
  if (create) { mkdirSync(parent, { recursive: true, mode: 0o711 }); mkdirSync(path, { mode: 0o711 }); }
  for (const directory of [join(project, ".console"), parent, path]) {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid?.() || (info.mode & 0o022) !== 0)
      throw new Error(`事务记录目录 ${directory} 不是本运维身份私有的目录，保留现场`);
  }
  return path;
}

/**
 * Creates the missing service directories for the account. The top ones, in the operator's checkout, are root's to make; their
 * owner changes through a descriptor of the new directory. The ones below are made by the account itself. Existing ones keep
 * their owner; `ownParentsOnly` skips a missing one whose parent is not the account's yet (the handover comes later).
 */
export async function createServiceDirectories(project: string, account: Owner, asAccount: (argv: string[]) => Promise<void>, ownParentsOnly = false): Promise<void> {
  for (const relative of SERVICE_DIRECTORIES) {
    const path = join(project, relative);
    if (present(path)) {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new MaintenanceRefused(`${relative} 不是目录（或是链接）`);
      continue;
    }
    if (!relative.includes("/")) {
      mkdirSync(path, { mode: 0o700 });
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fchownSync(fd, account.uid, account.gid); } finally { closeSync(fd); }
    } else if (!ownParentsOnly || lstatSync(dirname(path)).uid === account.uid) await asAccount([SYSTEM.mkdir, "-m", "700", "--", path]);
  }
}

export class MacosDeployment {
  readonly snapshot: string;
  /** An upgrade binds every effect to the definition it confirmed (expected); a deployment replaces it and only requires it to be this project's. */
  constructor(readonly project: string, readonly name: string, private readonly service: LaunchdPlatform, private readonly run: NativeRunner,
    private readonly account: Owner, readonly operation: "upgrade" | "deploy", readonly expected = "") {
    this.snapshot = join(project, "backup/snapshots", name);
  }
  /** Root's records of this transaction (rootRecords); the capture creates them. */
  records(): string { return rootRecords(this.project, this.name); }
  private async current(): Promise<LaunchdService> {
    const facts = await this.service.inspect();
    if (!facts.owned) throw new MaintenanceRefused("LaunchDaemon 属于其他目录或其他账户");
    if (this.operation === "upgrade" && facts.identity !== this.expected) throw new Error("服务定义已变化，未执行操作");
    if (facts.user && (facts.user.uid !== this.account.uid || facts.user.gid !== this.account.gid)) throw new Error("服务账户的身份已变化，未执行操作");
    return facts;
  }
  /** Files, dependencies and the definition change only while nothing of the service runs or is loaded. */
  private async stopped(): Promise<LaunchdService> {
    const facts = await this.current();
    if (facts.state === "running" || facts.leftovers > 0) throw new Error("服务仍在运行，未改动文件或服务定义");
    return facts;
  }
  /** A file command in the account's own trees, as the account. */
  private async asAccount(argv: string[], what = "服务账户的文件操作"): Promise<void> {
    const result = await this.run({ command: argv[0]!, args: argv.slice(1), cwd: this.project, env: serviceEnvironment(this.project), identity: this.account,
      protocol: true, timeoutMs: 10 * 60_000 });
    if (result.code !== 0) throw new Error(`${what}失败（退出码 ${result.code}）`);
  }
  private async own(): Promise<void> {
    for (const relative of SERVICE_DIRECTORIES) {
      const info = lstatSync(join(this.project, relative), { throwIfNoEntry: false });
      if (info && info.uid !== this.account.uid) throw new MaintenanceRefused(`${relative} 不属于服务账户 ${SERVICE_ACCOUNT}；请先用部署入口把数据目录交给服务账户`);
    }
    await createServiceDirectories(this.project, this.account, argv => this.asAccount(argv, "建立服务目录"));
  }
  /** Moved aside under backup/rm/<name> by the account, never deleted. A rerun archives what it restored and copies it again. */
  private async archive(path: string): Promise<void> {
    const archive = join(this.project, "backup/rm", this.name);
    await this.asAccount([SYSTEM.mkdir, "-p", "--", archive], "建立归档目录");
    await this.asAccount([SYSTEM.mv, "--", path, join(archive, `${Math.floor(Date.now() / 1000)}-${randomBytes(4).toString("hex")}-${basename(path)}`)], `归档 ${path}`);
  }
  private async copy(source: string, target: string): Promise<void> {
    await this.asAccount([SYSTEM.mkdir, "-p", "--", dirname(target)], "建立目录");
    await this.asAccount([SYSTEM.cp, "-a", "--", source, target], `复制 ${source}`);
  }

  async capture(): Promise<MacosSnapshot> {
    const facts = await this.current();
    if (present(this.snapshot)) throw new Error("快照目录已存在");
    // A bot this project runs in the foreground has no definition to stop or restore.
    if (facts.state !== "running" && facts.leftovers > 0) throw new MaintenanceRefused("服务账户有进程在运行（前台运行的机器人或残留进程），未做快照");
    if (facts.state === "unsupported") throw new MaintenanceRefused(`LaunchDaemon 的状态（${facts.rawState}）不支持部署`);
    await this.own();
    // Only a fresh transaction captures, under the lock and without a pointer: other records belong to no transaction.
    const deployments = join(this.project, ".console", "deployments");
    if (present(deployments)) for (const entry of readdirSync(deployments)) if (entry !== this.name) rmSync(join(deployments, entry), { recursive: true, force: true });
    const records = rootRecords(this.project, this.name, true);
    // The snapshot is the account's: its data tools read the plans there, and the settings copies are its own files.
    await this.asAccount([SYSTEM.mkdir, "-m", "700", "--", this.snapshot], "建立快照目录");
    for (const relative of MACOS_FILES) if (present(join(this.project, relative))) await this.copy(join(this.project, relative), join(this.snapshot, relative));
    if (facts.state !== "absent") await publish(join(records, PLIST_COPY), readFileSync(this.service.plist), { createOnly: true, mode: 0o644 });
    const state: MacosSnapshot = { format: 1, operation: this.operation, project: resolve(this.project), identity: facts.identity, wasRunning: facts.state === "running",
      hasService: facts.state !== "absent", dependenciesAttempted: false, dependenciesMoved: false };
    await publishJson(join(records, STATE_FILE), state, { createOnly: true });
    return state;
  }
  read(): MacosSnapshot {
    const path = join(this.records(), STATE_FILE), info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("快照状态不是普通文件");
    const state = JSON.parse(readFileSync(path, "utf8")) as MacosSnapshot;
    if (!state || state.format !== 1 || state.operation !== this.operation || state.project !== resolve(this.project) || !/^[a-f0-9]{64}$/.test(String(state.identity))
      || [state.wasRunning, state.hasService, state.dependenciesAttempted, state.dependenciesMoved].some(value => typeof value !== "boolean")
      || this.operation === "upgrade" && (state.identity !== this.expected || !state.hasService)) throw new Error("macOS 部署快照属于其他项目或格式不支持");
    return state;
  }
  private save(state: MacosSnapshot): Promise<void> { return publishJson(join(this.records(), STATE_FILE), state); }

  async stop(): Promise<void> { await this.current(); await this.service.halt(); }
  async start(): Promise<void> {
    const facts = await this.current();
    if (facts.state === "absent") throw new Error("LaunchDaemon 不存在，无法启动");
    await this.service.boot();
  }

  async saveDependencies(): Promise<void> {
    await this.stopped();
    const state = this.read(), source = join(this.project, "node_modules"), target = join(this.records(), "node_modules");
    // A resumed transaction already recorded that there were no original dependencies; the ones present now came from the interrupted install.
    if (state.dependenciesAttempted && !state.dependenciesMoved) return;
    if (present(target)) { await this.save({ ...state, dependenciesAttempted: true, dependenciesMoved: true }); return; }
    // Intent before the same-volume move: recovery tells a completed move by the saved directory and never overwrites it.
    const moved = present(source);
    await this.save({ ...state, dependenciesAttempted: true, dependenciesMoved: moved });
    if (moved) renameSync(source, target);
  }
  async restoreDependencies(): Promise<void> {
    await this.stopped();
    const state = this.read(), current = join(this.project, "node_modules"), saved = join(this.records(), "node_modules");
    if (!state.dependenciesAttempted) return;
    // The candidate's dependencies go with root's records when the transaction ends: an install makes them again.
    const aside = () => { if (present(current)) renameSync(current, join(this.records(), `replaced-node_modules-${randomBytes(4).toString("hex")}`)); };
    if (!state.dependenciesMoved) { aside(); return; }
    if (present(saved)) { aside(); renameSync(saved, current); }
    else if (!present(current)) throw new Error("原依赖和备份都不存在");
  }
  async restoreConfiguration(): Promise<void> {
    await this.stopped(); this.read();
    for (const relative of MACOS_FILES) {
      const current = join(this.project, relative), saved = join(this.snapshot, relative);
      if (present(current)) await this.archive(current);
      if (present(saved)) await this.copy(saved, current);
    }
  }
  /** The definition the transaction found, or none for a first deployment. Stays disabled: a start boots it. */
  async restoreService(): Promise<void> {
    await this.current();
    const state = this.read();
    await this.service.halt();
    if (state.hasService) await publish(this.service.plist, readFileSync(join(this.records(), PLIST_COPY)), { mode: 0o644, owner: { uid: 0, gid: 0 } });
    else rmSync(this.service.plist, { force: true });
  }
  async prepareDirectories(): Promise<void> {
    await this.stopped();
    await this.own();
    // BSD chmod reads "--" after the mode as a file; the paths are absolute, so none is needed.
    await this.asAccount([SYSTEM.chmod, "700", join(this.project, "data/config"), join(this.project, "data/state")], "收紧配置目录权限");
  }
  /** Written, not loaded: the core boots the verification instance once the other steps agree. */
  async installService(tools: MacosTools): Promise<void> {
    await this.stopped();
    assertToolsTrusted(tools, this.account);
    await this.service.halt();
    await publish(this.service.plist, servicePlist(this.project, tools), { mode: 0o644, owner: { uid: 0, gid: 0 } });
  }
  /** An unpublished capture: its snapshot (as the account) and root's records. */
  async discard(): Promise<void> {
    if (present(this.snapshot)) await this.asAccount([SYSTEM.rm, "-rf", "--", this.snapshot], "删除未发布的快照");
    rmSync(join(this.project, ".console", "deployments", this.name), { recursive: true, force: true });
  }
  /** After the pointers are gone: root's records always; the snapshot and the archive only after a forward completion. */
  async cleanup(forward: boolean): Promise<void> {
    if (forward) await this.asAccount([SYSTEM.rm, "-rf", "--", this.snapshot, join(this.project, "backup/rm", this.name)], "删除快照");
    rmSync(join(this.project, ".console", "deployments", this.name), { recursive: true, force: true });
  }
}
