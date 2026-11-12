// The console's side of the materials exclusion rules (data/config/materials-ignore.txt; materials-index.ts reads the file on
// every check, so a save applies to the next index without a restart): the rules as written, a validated save that keeps the
// file's comment lines, and the workspace's folders one level at a time for choosing among them. The folders listed are the
// ones the index would walk: no links, no dot folders, none of the names it always skips.
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MATERIALS_INDEX_MAX_DEPTH, MATERIALS_INDEX_MAX_FILES } from "../core/config.ts";
import { publish } from "../lib/atomic-file.ts";
import { ALWAYS_SKIPPED, IGNORE_TEMPLATE, indexedSummary } from "./materials-index.ts";

export const EXCLUSION_LIMITS = { rules: 200, ruleChars: 300, folders: 500 } as const;

/** A rule or a folder path the console sent that cannot be used; the message is for the page. */
export class ExclusionInput extends Error { override name = "ExclusionInput"; }

const ANYWHERE = "**/";
const CONTROL = /[\u0000-\u001f\u007f]/;

// One rule as the file takes it: `/` separators, no slash at either end, the any-level prefix only at the start.
function rule(raw: unknown, at: string): string {
  if (typeof raw !== "string") throw new ExclusionInput(`${at}：规则必须是文字`);
  const text = raw.trim().replace(/\\/g, "/"), anywhere = text.startsWith(ANYWHERE);
  const path = (anywhere ? text.slice(ANYWHERE.length) : text).replace(/^(?:\.?\/)+|\/+$/g, "");
  if (!path) throw new ExclusionInput(`${at}：没有写文件夹的名字或路径`);
  if (path.length > EXCLUSION_LIMITS.ruleChars) throw new ExclusionInput(`${at}：规则不能超过 ${EXCLUSION_LIMITS.ruleChars} 个字`);
  if (CONTROL.test(path)) throw new ExclusionInput(`${at}：规则里有不能使用的字符`);
  if (path.includes("*")) throw new ExclusionInput(`${at}「${path}」：除开头的 **/ 外不支持通配符`);
  if (path.split("/").some(segment => !segment.trim() || segment === "." || segment === "..")) throw new ExclusionInput(`${at}「${path}」：路径里不能有空的一级、. 或 ..`);
  // A line starting with # is a comment in the file.
  if (!anywhere && path.startsWith("#")) throw new ExclusionInput(`${at}「${path}」：以 # 开头的名字请写成 **/${path}`);
  return (anywhere ? ANYWHERE : "") + path;
}

/** The rules of a save, in order, without repeats (rules match without regard to case). */
export function parseExclusionRules(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ExclusionInput("规则必须是列表");
  if (value.length > EXCLUSION_LIMITS.rules) throw new ExclusionInput(`最多 ${EXCLUSION_LIMITS.rules} 条规则`);
  const rules = new Map<string, string>();
  for (const [at, raw] of value.entries()) {
    const parsed = rule(raw, `第 ${at + 1} 条`);
    if (!rules.has(parsed.toLowerCase())) rules.set(parsed.toLowerCase(), parsed);
  }
  return [...rules.values()];
}

const stripBom = (text: string) => text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

async function fileText(ignorePath: string): Promise<string | null> {
  try { return stripBom(await readFile(ignorePath, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

const isRule = (line: string) => line.trim() !== "" && !line.trim().startsWith("#");

/** The rules as the file has them (case kept), in order; the lines the index ignores are left out. */
export async function readExclusionRules(ignorePath: string): Promise<string[]> {
  const text = await fileText(ignorePath);
  return (text ?? "").split(/\r?\n/).filter(isRule).map(line => line.trim().replace(/\\/g, "/").replace(/\/+$/, "")).filter(line => line !== "" && line !== "**");
}

/** Writes the rules below the file's comment lines (the template's, for a file that does not exist yet). */
export async function saveExclusionRules(ignorePath: string, rules: readonly string[]): Promise<void> {
  const kept = ((await fileText(ignorePath)) ?? IGNORE_TEMPLATE).split(/\r?\n/).filter(line => !isRule(line));
  while (kept.length && kept.at(-1)!.trim() === "") kept.pop();
  // 0644: the operator may read and edit it under another identity, as the template allows.
  await publish(ignorePath, [...kept, ...(kept.length && rules.length ? [""] : []), ...rules, ""].join("\n"), { mode: 0o644 });
}

export interface MaterialFolders {
  /** The folder listed, relative to the workspace (`""` is the workspace itself). */
  path: string;
  /** Its folders by name. */
  folders: string[];
  /** There are more folders than listed. */
  more: boolean;
}

/** The folders of one workspace folder, by name. */
export async function materialFolders(workspaceDir: string, value: unknown): Promise<MaterialFolders> {
  if (typeof value !== "string" || value.length > 4096 || CONTROL.test(value)) throw new ExclusionInput("文件夹路径无效");
  const segments = value === "" ? [] : value.split("/");
  if (segments.length >= MATERIALS_INDEX_MAX_DEPTH) throw new ExclusionInput("这一层已经超出资料索引的深度，不需要排除");
  if (segments.some(segment => !segment || segment === "." || segment === ".." || segment.includes("\\") || segment.startsWith(".") || ALWAYS_SKIPPED.has(segment))) {
    throw new ExclusionInput("文件夹路径无效");
  }
  let dir = resolve(workspaceDir);
  for (const segment of segments) {
    dir = join(dir, segment);
    const info = await lstat(dir).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink()) throw new ExclusionInput(`共享资料里已经没有文件夹 ${value}`);
  }
  let children;
  try { children = await readdir(dir, { withFileTypes: true }); }
  catch (error) { throw new Error(`读不到${segments.length ? `文件夹 ${value}` : "共享资料目录"}：${(error as NodeJS.ErrnoException).code ?? String(error)}`); }
  const names = children.filter(child => child.isDirectory() && !child.isSymbolicLink() && !child.name.startsWith(".") && !ALWAYS_SKIPPED.has(child.name))
    .map(child => child.name).sort((a, b) => a.localeCompare(b));
  return { path: value, folders: names.slice(0, EXCLUSION_LIMITS.folders), more: names.length > EXCLUSION_LIMITS.folders };
}

export interface MaterialExclusions {
  rules: string[];
  /** The index as this process last built it: null before the first conversation after a start. */
  index: { files: number; bytes: number; generatedAt: number; truncated: boolean; limit: number; topLevel: { name: string; files: number; bytes: number }[] } | null;
}

/** What the console's page shows: the saved rules and the index they produced. */
export async function materialExclusions(ignorePath: string, indexPath: string): Promise<MaterialExclusions> {
  const summary = indexedSummary(indexPath);
  return { rules: await readExclusionRules(ignorePath),
    index: summary ? { files: summary.totalFiles, bytes: summary.totalBytes, generatedAt: summary.generatedAt, truncated: summary.truncated, limit: MATERIALS_INDEX_MAX_FILES,
      topLevel: summary.topLevel } : null };
}
