/*
 * Adapted from Pi 0.85.1, packages/coding-agent/src/utils/paths.ts.
 * MIT License
 * Copyright (c) 2025 Mario Zechner
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Windows 上 Git Bash 和 WSL 写法的盘符路径（成员 shell 里 `pwd` 打印 `/d/x`）转成 `D:\x`；其他路径和其他平台不变。
 * 所有工具一致：成员环境的 absolutePath（Durable 的 read、edit、write）也用它。
 */
export function fromShellPath(path: string): string {
  if (process.platform !== "win32" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return path;
  const match = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  return match ? `${match[1]!.toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}` : path;
}

/**
 * Durable 工具的路径语义（tools/path-utils + 成员环境的 absolutePath）。上游未公开该函数；send_file 和文档工具用这份，
 * tests/agent/tool-path.test.ts 用官方 write 工具做差分回归，升级 Pi 时必须一起核对。
 * 来源：packages/coding-agent/src/utils/paths.ts（MIT）。
 */
function normalizePath(input: string, toolPath: boolean): string {
  let path = toolPath ? input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ") : input;
  if (toolPath && path.startsWith("@")) path = path.slice(1);
  path = fromShellPath(path);
  if (path === "~") return homedir();
  if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
    return join(homedir(), path.slice(2));
  }
  return path.startsWith("file://") ? fileURLToPath(path) : path;
}

export function resolveToolPath(path: string, cwd: string): string {
  const normalized = normalizePath(path, true);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(normalizePath(cwd, false), normalized);
}

/** 交付快照所在的目录名：登记时在成员临时目录下建立，请求结束并交付后清理（agent/deliverables.ts）。 */
export const SNAPSHOT_DIRECTORY = ".deliverables";

/** 快照路径的形状：`.deliverables/<请求摘要 24 位>/<UUID>/<文件名>`（freezeFile）。资料库里同名的普通目录不算。 */
function snapshotPath(path: string): boolean {
  const parts = path.split(sep), at = parts.lastIndexOf(SNAPSHOT_DIRECTORY);
  return at >= 0 && parts.length === at + 4 && /^[0-9a-f]{24}$/.test(parts[at + 1]!) && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(parts[at + 2]!);
}

/**
 * 工具的源文件：解析后的真实路径。快照在登记它的请求结束后清理，而登记结果里的路径留在对话历史中，模型曾在下一个请求里
 * 继续用它；这时说明原因和该用哪个路径，不让模型面对一条 ENOENT 去猜。
 */
export async function realToolPath(path: string, cwd: string): Promise<string> {
  const resolved = resolveToolPath(path, cwd);
  try { return await realpath(resolved); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !snapshotPath(resolved)) throw error;
    throw new Error("这个路径是之前请求登记交付物时的快照，那次请求结束后已清理。请改用文件原来的生成路径（登记时传入的 path）；原文件也不在时重新生成。");
  }
}
