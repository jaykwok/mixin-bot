// Host file browsing for the console's path fields. The console runs on the deployment host while the browser may sit on
// another computer (SSH forwarding), so the page cannot pick host files itself: this lists one host directory at a time
// (names and metadata, never contents) and says what choosing each entry writes into the field. The Docker service sees
// container paths, so values are translated into its view, or refused where it sees nothing.
import { existsSync, readFileSync, realpathSync, type Dirent, type Stats } from "node:fs";
import { lstat, opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { BrowseEntry, BrowsePlace, BrowsePurpose, BrowseResponse } from "../ui/src/contract.ts";
import { TEMPLATE_EXTENSIONS, type AdvancedRuntimeKey } from "../../src/core/runtime-schema.ts";
import { appLayout, workspaceBoundary } from "../../src/core/layout.ts";
import { isPathInside } from "../../src/contracts/paths.ts";
import { fields } from "../../ops/core/operations.ts";
import { hostPlatform, type Platform } from "../../ops/core/platform.ts";
import { ApiProblem, type Route } from "./routes.ts";

const PURPOSES: readonly BrowsePurpose[] = ["workspace", "stats", "document-env", "pptx-template", "docx-template", "office"];
/** Entries listed per directory; a larger one is cut short and says so. */
const MAX_ENTRIES = 2000;
/** Reading one directory stops here; a slow share lists what was read in time. */
const LIST_BUDGET_MS = 4000;
const TEMPLATES: Partial<Record<BrowsePurpose, readonly string[]>> = {
  "pptx-template": TEMPLATE_EXTENSIONS.BOT_DOCUMENT_PPTX_TEMPLATE, "docx-template": TEMPLATE_EXTENSIONS.BOT_DOCUMENT_DOCX_TEMPLATE };
/** Windows clutter Explorer hides by attribute, which Node cannot read. */
const WINDOWS_HIDDEN = new Set(["system volume information", "pagefile.sys", "swapfile.sys", "hiberfil.sys", "dumpstack.log", "dumpstack.log.tmp",
  "config.msi", "recovery", "documents and settings", "desktop.ini", "thumbs.db"]);

/** The runtime settings that hold a path, and the picker each opens. */
export const RUNTIME_BROWSE: Partial<Record<AdvancedRuntimeKey, BrowsePurpose>> = {
  BOT_DOCUMENT_ENV: "document-env", BOT_DOCUMENT_PPTX_TEMPLATE: "pptx-template", BOT_DOCUMENT_DOCX_TEMPLATE: "docx-template", BOT_DOCUMENT_OFFICE_PATH: "office",
};

/** Why a field's picker cannot work on this host, or null. */
export function browseUnavailable(purpose: BrowsePurpose, platform: Platform = hostPlatform()): string | null {
  return purpose === "office" && platform === "linux"
    ? "Linux 上 LibreOffice 在隔离任务的容器里运行，这里填任务镜像内的路径（例如 /usr/bin/soffice），不能从主机选取" : null;
}

interface Host {
  platform: Platform;
  project: string;
  /** As the operator knows them: where places and start locations point. */
  dataPath: string;
  workspacePath: string;
  /** Real paths for comparisons and container translation; "" when missing. */
  data: string;
  workspace: string;
  defaultWorkspace: string;
  home: string;
  boundary?: (target: string, shown?: string) => string | null;
}

type Choice = { value: string | null; reason?: string };

const realOrEmpty = (path: string) => { try { return realpathSync.native(path); } catch { return ""; } };
const problem = (message: string) => new ApiProblem(409, "input", message);

function hostOf(project: string, platform: Platform): Host {
  const dataPath = join(project, "data");
  let saved = "";
  try { saved = readFileSync(join(dataPath, "state", "workspace-root"), "utf8").trim(); } catch {}
  const layout = appLayout(dataPath, saved || undefined);
  return { platform, project, dataPath, workspacePath: layout.workspace, data: realOrEmpty(dataPath), workspace: realOrEmpty(layout.workspace),
    defaultWorkspace: realOrEmpty(join(project, "workspace")), home: homeOf(platform) };
}

/** sudo (macOS always, Linux sometimes) leaves HOME at root's; the operator's own home is the useful start. */
function homeOf(platform: Platform): string {
  const user = process.env.SUDO_USER;
  if (platform !== "windows" && user && /^[\w.-]+$/.test(user)) {
    const own = (platform === "macos" ? "/Users/" : "/home/") + user;
    if (existsSync(own)) return own;
  }
  return homedir();
}

function windowsOffice(): string {
  for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
    const program = root ? join(root, "LibreOffice", "program") : "";
    if (program && existsSync(program)) return program;
  }
  return "";
}

let driveCache: { at: number; drives: string[] } | undefined;
/** Drive letters answering within a moment; a disconnected network drive is left out rather than waited for. */
async function drives(): Promise<string[]> {
  if (driveCache && Date.now() - driveCache.at < 15_000) return driveCache.drives;
  const found: string[] = [];
  await Promise.race([Promise.all([..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map(letter => stat(`${letter}:\\`).then(() => { found.push(`${letter}:\\`); }, () => {}))), Bun.sleep(400)]);
  driveCache = { at: Date.now(), drives: found.sort() };
  return driveCache.drives;
}

async function places(host: Host, purpose: BrowsePurpose): Promise<BrowsePlace[]> {
  const list: BrowsePlace[] = [{ label: "项目目录", path: host.project, kind: "project" }, { label: "数据目录", path: host.dataPath, kind: "data" }];
  if (host.workspace) list.push({ label: "共享资料", path: host.workspacePath, kind: "workspace" });
  list.push({ label: "主目录", path: host.home, kind: "home" });
  if (host.platform === "windows") {
    const office = purpose === "office" ? windowsOffice() : "";
    if (office) list.push({ label: "LibreOffice", path: office, kind: "office" });
    for (const drive of await drives()) list.push({ label: drive.slice(0, 2), path: drive, kind: "drive" });
    return list;
  }
  if (host.platform === "macos") list.push({ label: "应用程序", path: "/Applications", kind: "apps" }, { label: "宗卷", path: "/Volumes", kind: "drive" });
  list.push({ label: "根目录", path: "/", kind: "root" });
  return list;
}

function start(host: Host, purpose: BrowsePurpose): string {
  const first = (...paths: string[]) => paths.find(path => path && existsSync(path)) ?? host.home;
  switch (purpose) {
    case "document-env": return first(join(host.dataPath, "runtime"), host.dataPath);
    case "pptx-template": case "docx-template": return first(host.workspacePath);
    case "office": return host.platform === "windows" ? first(windowsOffice(), process.env.ProgramFiles ?? "") : first("/Applications");
    default: return host.home;
  }
}

function hiddenName(name: string, platform: Platform): boolean {
  if (name.startsWith(".")) return true;
  const lower = name.toLowerCase();
  return platform === "windows" && (lower.startsWith("$") || lower.startsWith("ntuser.") || WINDOWS_HIDDEN.has(lower));
}

const selects = (purpose: BrowsePurpose) => purpose === "workspace" || purpose === "document-env" ? "directory" : "file";
const isApp = (host: Host, purpose: BrowsePurpose, name: string) => purpose === "office" && host.platform === "macos" && /\.app$/i.test(name);

/** The Docker service's path for a host location: the data directory is /app/data, the workspace /app/workspace. */
function container(host: Host, real: string, refusal: string): Choice {
  for (const [root, mount] of [[host.workspace, "/app/workspace"], [host.data, "/app/data"]] as const) {
    if (!root || !real || !isPathInside(real, root)) continue;
    const rest = relative(root, real);
    return { value: rest ? `${mount}/${rest.split(sep).join("/")}` : mount };
  }
  return { value: null, reason: refusal };
}

/** What choosing `path` (resolved: `real`) writes into the field. Directories of file fields only open. */
function choice(host: Host, purpose: BrowsePurpose, kind: BrowseEntry["kind"], path: string, real: string): Choice {
  const wanted = selects(purpose);
  if (kind === "directory" && wanted === "file") return { value: null };
  if (kind !== "directory" && wanted === "directory") return { value: null, reason: "这里需要选择目录" };
  const docker = host.platform === "linux";
  switch (purpose) {
    case "workspace": {
      if (real && real === host.defaultWorkspace) return { value: null, reason: "这是默认的共享资料目录：输入框留空即可" };
      const refused = (host.boundary ??= workspaceBoundary(appLayout(host.dataPath), host.project))(real, path);
      return refused ? { value: null, reason: refused } : { value: path };
    }
    case "stats":
      return { value: path };
    case "document-env":
      return docker ? container(host, real, "服务容器看不到这里：只能选数据目录或共享资料目录里的目录") : { value: path };
    case "pptx-template": case "docx-template": {
      const types = TEMPLATES[purpose]!;
      if (!types.includes(extname(path).toLowerCase())) return { value: null, reason: `需要 ${types.join(" 或 ")} 文件` };
      if (host.workspace && real && isPathInside(real, host.workspace)) return { value: relative(host.workspace, real).split(sep).join("/") };
      return docker ? container(host, real, "服务容器看不到这里：请把模板放进共享资料目录") : { value: path };
    }
    case "office": {
      if (kind === "app") {
        const program = join(path, "Contents", "MacOS", "soffice");
        return existsSync(program) ? { value: program } : { value: null, reason: "这个应用里没有 soffice" };
      }
      if (host.platform === "windows") return /^soffice\.(exe|com)$/i.test(basename(path)) ? { value: path } : { value: null, reason: "请选择 LibreOffice 的 soffice.exe" };
      return basename(path) === "soffice" ? { value: path } : { value: null, reason: "请选择 LibreOffice.app 或 soffice 程序" };
    }
  }
}

/** What describe() reads of a directory entry. */
type Item = Pick<Dirent, "name" | "isSymbolicLink">;

async function describe(host: Host, purpose: BrowsePurpose, dir: string, realDir: string, item: Item): Promise<BrowseEntry> {
  const path = join(dir, item.name), link = item.isSymbolicLink();
  let info: Stats | null = null, real = join(realDir, item.name), hidden = hiddenName(item.name, host.platform);
  try { info = link ? await stat(path) : await lstat(path); } catch {}
  if (link) real = await realpath(path).catch(() => "");
  const directory = info ? info.isDirectory() : false;
  // Windows keeps legacy names (My Documents, Application Data) as junctions nobody may list; Explorer hides them.
  if (link && directory && host.platform === "windows" && !hidden) {
    try { await (await opendir(path)).close(); } catch (error) { hidden = ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""); }
  }
  const kind: BrowseEntry["kind"] = directory ? isApp(host, purpose, item.name) ? "app" : "directory" : "file";
  const entry: BrowseEntry = { name: item.name, path, kind, size: info?.isFile() ? info.size : null, modified: info ? Math.round(info.mtimeMs) : null,
    value: null, ...(link ? { link: true } : {}), ...(hidden ? { hidden: true } : {}) };
  if (!info) return { ...entry, reason: link ? "链接指向的位置不存在" : "无法读取" };
  if (!directory && !info.isFile()) return { ...entry, reason: "不是普通文件或目录" };
  return { ...entry, ...choice(host, purpose, kind, path, real) };
}

const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
const order = (a: BrowseEntry, b: BrowseEntry) => Number(b.kind === "directory") - Number(a.kind === "directory") || collator.compare(a.name, b.name);

/**
 * Lists a directory, at most MAX_ENTRIES entries within the time budget. The entry to select (`keep`) is always in the
 * result, wherever the listing stops; `selected` is its listed name.
 */
async function list(host: Host, purpose: BrowsePurpose, dir: string, hidden: boolean, keep: string | null)
  : Promise<{ entries: BrowseEntry[]; truncated: boolean; selected: string | null }> {
  const deadline = Date.now() + LIST_BUDGET_MS, items: Item[] = [];
  // The entry the path names. Windows and macOS usually ignore case, so a typed path may differ in case from the listed
  // name; but a macOS volume (or a Windows directory) may tell case apart and hold both. The exact name wins, and a name
  // differing only in case is the same entry only when it is the same file.
  const target = keep === null ? null : await lstat(join(dir, keep)).catch(() => null);
  const folded = keep !== null && target && host.platform !== "linux" ? keep.toLowerCase() : null;
  const aliases: Item[] = [];
  let truncated = false, kept: Item | null = null;
  const handle = await opendir(dir).catch(error => { throw unreadable(dir, error); });
  try {
    for await (const item of handle) {
      if (target && item.name === keep) { kept = item; continue; }
      if (folded !== null && item.name.toLowerCase() === folded) { aliases.push(item); continue; }
      if (!hidden && hiddenName(item.name, host.platform)) continue;
      if (items.length >= MAX_ENTRIES || Date.now() > deadline) { truncated = true; break; }
      items.push(item);
    }
  } catch (error) { throw unreadable(dir, error); }
  for (const alias of aliases) {
    const info = kept ? null : await lstat(join(dir, alias.name)).catch(() => null);
    if (info && target && info.dev === target.dev && info.ino === target.ino) kept = alias;
    // Another file: listed like any other.
    else if (hidden || !hiddenName(alias.name, host.platform)) {
      if (items.length < MAX_ENTRIES) items.push(alias); else truncated = true;
    }
  }
  // Not reached before the listing stopped: looked up by itself.
  if (keep !== null && target && !kept) kept = { name: keep, isSymbolicLink: () => target.isSymbolicLink() };
  const realDir = await realpath(dir).catch(() => dir), entries: BrowseEntry[] = kept ? [await describe(host, purpose, dir, realDir, kept)] : [];
  for (let index = 0; index < items.length; index += 64) {
    if (Date.now() > deadline) { truncated = true; break; }
    entries.push(...await Promise.all(items.slice(index, index + 64).map(item => describe(host, purpose, dir, realDir, item))));
  }
  return { entries: entries.filter(entry => hidden || !entry.hidden || entry.name === kept?.name).sort(order), truncated, selected: kept?.name ?? null };
}

function unreadable(path: string, error: unknown): ApiProblem {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return problem(code === "ENOENT" ? `找不到 ${path}` : code === "EACCES" || code === "EPERM" ? `没有权限读取 ${path}`
    : code === "ENOTDIR" ? `${path} 不是目录` : `无法读取 ${path}（${code ?? "未知错误"}）`);
}

/** A host path typed or clicked in the picker: absolute, no control characters, no Windows device namespace. */
function typedPath(host: Host, text: string): string {
  let value = text.trim();
  if (!value) throw problem("请输入路径");
  if (/[\x00-\x1f\x7f]/.test(value)) throw problem("路径包含控制字符");
  if (/^[\\/]{2}[.?][\\/]/.test(value)) throw problem("不支持 Windows 设备路径");
  if (value === "~" || /^~[\\/]/.test(value)) value = join(host.home, value.slice(1));
  if (host.platform === "windows" && /^[a-z]:$/i.test(value)) value += "\\";
  if (!isAbsolute(value)) throw problem("请输入绝对路径");
  return resolve(value);
}

/** The host location a field's present value names, or null when it names nothing on this host. */
function valueLocation(host: Host, purpose: BrowsePurpose, value: string): string | null {
  const text = value.trim();
  if (!text || /[\x00-\x1f\x7f]/.test(text) || /^[\\/]{2}[.?][\\/]/.test(text)) return null;
  if (TEMPLATES[purpose] && !isAbsolute(text)) return resolve(host.workspacePath, text);
  if (host.platform === "linux" && purpose !== "workspace" && purpose !== "stats") {
    const inside = /^\/app\/(data|workspace)(?:\/(.*))?$/.exec(text);
    const root = inside?.[1] === "data" ? host.dataPath : inside?.[1] === "workspace" ? host.workspacePath : "";
    return root ? join(root, ...(inside![2] ?? "").split("/").filter(Boolean)) : null;
  }
  if (!isAbsolute(text)) return null;
  const bundle = purpose === "office" && host.platform === "macos" ? /^(.+\.app)[\\/]Contents[\\/]MacOS[\\/]soffice$/i.exec(text) : null;
  return resolve(bundle ? bundle[1]! : text);
}

const exists = (path: string) => lstat(path).then(() => true, () => false);

/** The directory to list and the entry to select in it. */
async function opening(host: Host, purpose: BrowsePurpose, path: string | undefined, from: string | undefined): Promise<{ dir: string; keep: string | null }> {
  const around = (target: string) => dirname(target) === target ? { dir: target, keep: null } : { dir: dirname(target), keep: basename(target) };
  if (path !== undefined) {
    const target = typedPath(host, path);
    const info = await stat(target).catch(error => { throw unreadable(target, error); });
    return info.isDirectory() && !isApp(host, purpose, basename(target)) ? { dir: target, keep: null } : around(target);
  }
  let target = from === undefined ? null : valueLocation(host, purpose, from);
  if (target && await exists(target)) return around(target);
  for (let step = 0; target && step < 64; step++) {
    const parent = dirname(target);
    if (parent === target) break;
    if (await exists(parent)) return { dir: parent, keep: null };
    target = parent;
  }
  return { dir: start(host, purpose), keep: null };
}

function note(host: Host, purpose: BrowsePurpose): string {
  const account = host.platform === "macos" ? "机器人以 _mixinbot 账户运行，这个账户需要能读取所选位置。" : "";
  switch (purpose) {
    case "workspace": return "选择已经存在的目录。共享资料只读开放给成员，不能包含数据目录，也不能位于受管目录内。" + account;
    case "stats": return "选择以前保存的统计账本（通常名为 stats.sqlite），导入前会校验格式。";
    case "document-env": return host.platform === "linux"
      ? "服务在容器里运行：数据目录里的位置填作 /app/data/…，共享资料目录里的填作 /app/workspace/…。"
      : "选择现成的 Python 文档环境目录；通常保持默认。" + account;
    case "pptx-template": case "docx-template": return "共享资料目录里的文件填相对路径。"
      + (host.platform === "linux" ? "其他位置只接受数据目录里的文件，填作 /app/data/…。" : account);
    case "office": return (host.platform === "windows" ? "选择 LibreOffice 安装目录 program 下的 soffice.exe。" : "选择 LibreOffice.app。") + account;
  }
}

export async function browse(project: string, body: unknown, platform: Platform = hostPlatform()): Promise<BrowseResponse> {
  const params = (body ?? {}) as Record<string, unknown>;
  try { fields(params, ["purpose", "path", "from", "hidden"]); } catch { throw new ApiProblem(400, "input", "选择框参数无效"); }
  const purpose = params.purpose as BrowsePurpose;
  if (!PURPOSES.includes(purpose) || ["path", "from"].some(key => params[key] !== undefined && (typeof params[key] !== "string" || (params[key] as string).length > 4096))
    || params.hidden !== undefined && typeof params.hidden !== "boolean") throw new ApiProblem(400, "input", "选择框参数无效");
  const unavailable = browseUnavailable(purpose, platform);
  if (unavailable) throw problem(unavailable);
  const host = hostOf(resolve(project), platform);
  const { dir, keep } = await opening(host, purpose, params.path as string | undefined, params.from as string | undefined);
  const { entries, truncated, selected } = await list(host, purpose, dir, params.hidden === true, keep);
  const parent = dirname(dir);
  return {
    purpose, select: selects(purpose), path: dir, parent: parent === dir ? null : parent, crumbs: crumbs(dir), places: await places(host, purpose), entries,
    current: selects(purpose) === "directory" ? choice(host, purpose, "directory", dir, realOrEmpty(dir)) : null,
    selected, truncated, note: note(host, purpose),
  };
}

function crumbs(path: string): BrowseResponse["crumbs"] {
  const { root } = parse(path);
  const list = [{ name: root.length > 1 ? root.replace(/[\\/]+$/, "") : root, path: root }];
  let current = root;
  for (const part of path.slice(root.length).split(/[\\/]+/).filter(Boolean)) list.push({ name: part, path: current = join(current, part) });
  return list;
}

export function fileRoutes(project: string, platform: Platform = hostPlatform()): Record<string, Route> {
  return { "POST /api/files/list": { run: ({ body }) => browse(project, body, platform) } };
}
