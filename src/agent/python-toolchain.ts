// Fixed document parser environment. Every command shares the supervised process lifecycle.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCUMENT_TOOLCHAIN_PACKAGES, DOCUMENT_TOOLCHAIN_TIMEOUT } from "../core/config.ts";
import { KeyedQueue, application, waitFor } from "../core/lifecycle.ts";
import { runProcess } from "../core/process.ts";
import { log } from "../core/log.ts";
import { DOCUMENT_TOOLCHAIN_MARKER, documentMarker } from "./document-manifest.ts";
import { redactSecrets } from "../lib/redact.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const lock = join(project, "uv.lock"), manifest = join(project, "pyproject.toml"), pythonPin = join(project, ".python-version");
const pythonVersion = async () => (await readFile(pythonPin, "utf8")).trim();
const expected = async () => documentMarker(DOCUMENT_TOOLCHAIN_PACKAGES, await readFile(lock, "utf8"), await pythonVersion());
const provisioning = new KeyedQueue();
const verified = new Map<string, { fingerprint: string; at: number }>();
interface Check { promise: Promise<boolean>; controller: AbortController; consumers: number; done: boolean; }
const checking = new Map<string, Check>();
const READY_TTL = 5 * 60_000;

async function fingerprint(venvDir: string): Promise<string> {
  const paths = [venvPythonPath(venvDir), join(venvDir, DOCUMENT_TOOLCHAIN_MARKER), lock, manifest, pythonPin];
  const metadata = await Promise.all(paths.map(async path => {
    const info = await stat(path, { bigint: true });
    if (!info.isFile()) throw new Error("文档环境文件缺失");
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
  }));
  return JSON.stringify(metadata);
}

async function toolchainEnv() {
  const temporary = resolve("data/runtime/tmp/document-toolchain");
  await mkdir(temporary, { recursive: true });
  return { ...process.env, TMPDIR: temporary, TEMP: temporary, TMP: temporary,
    UV_CACHE_DIR: join(temporary, "uv-cache"), UV_PYTHON_INSTALL_DIR: process.env.UV_PYTHON_INSTALL_DIR || join(temporary, "python"),
    PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", UV_NO_CONFIG: "1", UV_LINK_MODE: "copy" };
}

export function venvPythonPath(venvDir: string): string {
  return join(resolve(venvDir), process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
}

function uvPath(): string {
  const path = Bun.which(process.platform === "win32" ? "uv.exe" : "uv");
  if (!path) throw new Error("缺少 uv 可执行文件；请在部署阶段安装 uv");
  return path;
}

/** A fresh offline check; the console reports each stage instead of reusing the tool-call proof cache. */
export async function verifyDocumentToolchain(venvDir: string, signal?: AbortSignal, report?: (text: string) => void): Promise<boolean> {
  const env = { ...await toolchainEnv(), VIRTUAL_ENV: resolve(venvDir), UV_PROJECT_ENVIRONMENT: resolve(venvDir) };
  report?.("核对 Python 与 uv.lock 中的依赖版本（离线）…");
  // Check the complete platform-specific lock resolution, including transitive dependencies.
  const check = await runProcess({ command: uvPath(),
    args: ["sync", "--check", "--locked", "--offline", "--no-python-downloads", "--no-dev", "--no-install-project", "--project", project, "--python", await pythonVersion()],
    cwd: process.cwd(), timeoutMs: 30000, signal, env });
  if (check.exitCode !== 0) { report?.(redactSecrets(check.output.slice(-4000))); return false; }
  report?.("依赖版本一致，正在导入文档解析库…");
  const pin = await pythonVersion();
  const code = "import sys; assert '.'.join(map(str,sys.version_info[:" + pin.split(".").length + "])) == " + JSON.stringify(pin) +
    "; import pptx, docx, openpyxl, pypdf, pandas, numpy, dateutil, xlsxwriter, PIL, docxcompose, pypdfium2, lxml";
  const result = await runProcess({ command: venvPythonPath(venvDir), args: ["-c", code],
    cwd: process.cwd(), timeoutMs: 30000, signal,
    env,
  });
  if (result.exitCode !== 0) report?.(redactSecrets(result.output.slice(-4000)));
  else report?.("Python 版本和文档解析库导入通过。");
  return result.exitCode === 0;
}

/** A still-fresh proof for exactly these file states, moved to the recent end of the cache. */
function proven(target: string, stamp: string): boolean {
  const cached = verified.get(target);
  if (cached?.fingerprint !== stamp || Date.now() - cached.at >= READY_TTL) return false;
  verified.delete(target); verified.set(target, cached);
  return true;
}

export async function documentToolchainReady(venvDir: string, signal?: AbortSignal): Promise<boolean> {
  try {
    if (!(await stat(venvPythonPath(venvDir))).isFile()) return false;
    const target = resolve(venvDir);
    const stamp = await fingerprint(target);
    if (proven(target, stamp)) { signal?.throwIfAborted(); return true; }
    // An observed mismatch invalidates the old proof even if files later regain
    // the same metadata (for example a marker is removed and immediately restored).
    verified.delete(target);
    const content = await readFile(join(target, DOCUMENT_TOOLCHAIN_MARKER), "utf8");
    if (content.replace(/\r\n?/g, "\n").trim() !== await expected()) return false;
    // A check of these same file states may have finished while the marker was read. Its proof covers this call only
    // while the files are still in that state; if they changed meanwhile, they are not ready, as a check would find.
    if (proven(target, stamp)) {
      const current = await fingerprint(target);
      signal?.throwIfAborted();
      return current === stamp;
    }
    const key = target + stamp;
    let job = checking.get(key);
    if (!job || job.controller.signal.aborted) {
      const controller = new AbortController();
      const owner: Check = { controller, consumers: 0, done: false, promise: Promise.resolve(false) };
      owner.promise = application.track((async () => {
        if (!await verifyDocumentToolchain(target, AbortSignal.any([application.signal, controller.signal])) || await fingerprint(target) !== stamp) return false;
        verified.delete(target);
        if (verified.size >= 128) verified.delete(verified.keys().next().value!);
        verified.set(target, { fingerprint: stamp, at: Date.now() });
        return true;
      })()).finally(() => { owner.done = true; if (checking.get(key) === owner) checking.delete(key); });
      job = owner;
      checking.set(key, owner);
    }
    job.consumers++;
    try { return await waitFor(job.promise, signal); }
    finally {
      job.consumers--;
      if (!job.consumers && !job.done) job.controller.abort(new Error("文档环境检查已全部取消"));
    }
  } catch (error) { signal?.throwIfAborted(); application.signal.throwIfAborted(); return false; }
}

export async function ensureDocumentToolchain(venvDir: string, signal?: AbortSignal,
  options: { repair?: boolean; timeoutMs?: number; report?: (text: string) => void } = {}): Promise<boolean> {
  const target = resolve(venvDir);
  return provisioning.run(target, async () => {
    const timeoutMs = options.timeoutMs ?? DOCUMENT_TOOLCHAIN_TIMEOUT;
    const budget = AbortSignal.any([application.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    if (!options.repair && await documentToolchainReady(target, budget)) { options.report?.("文档依赖已经就绪，无需安装。"); return true; }
    verified.delete(target);
    const uv = uvPath();
    const env = { ...await toolchainEnv(), VIRTUAL_ENV: target, UV_PROJECT_ENVIRONMENT: target };
    const args = ["sync", "--locked", "--no-dev", "--no-install-project", "--project", project, "--python", await pythonVersion(), ...(options.repair ? ["--reinstall", "--refresh"] : [])];
    options.report?.(`${options.repair ? "重新下载并安装" : "安装缺失的"}固定版本依赖，最长等待 ${Math.round(timeoutMs / 60_000)} 分钟…`);
    const started = Date.now(), timer = options.report ? setInterval(() => options.report?.(`依赖安装仍在进行，已等待 ${Math.round((Date.now() - started) / 1000)} 秒；若持续等待，请检查部署机网络、代理和 uv 锁。`), 30_000) : undefined;
    try {
      const result = await runProcess({ command: uv, args, cwd: process.cwd(), env, signal: budget, timeoutMs });
      if (options.report && result.output.trim()) options.report(redactSecrets(result.output.slice(-8000)));
      if (result.exitCode !== 0) { log.warn("文档环境准备失败: " + redactSecrets(result.output.slice(-1000))); return false; }
    } finally { if (timer) clearInterval(timer); }
    if (!await verifyDocumentToolchain(target, budget, options.report)) return false;
    await writeFile(join(target, DOCUMENT_TOOLCHAIN_MARKER), await expected(), "utf8");
    verified.set(target, { fingerprint: await fingerprint(target), at: Date.now() });
    return true;
  }, signal);
}
