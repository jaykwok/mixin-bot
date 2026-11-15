// Runs in the maintenance writer, with the deployed service's identity and runtime configuration.
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runtimeSetting } from "../../src/core/runtime-config.ts";
import { ensureDocumentToolchain, verifyDocumentToolchain, venvPythonPath } from "../../src/agent/python-toolchain.ts";
import { runProcess } from "../../src/core/process.ts";
import { ProcessFailure } from "../../src/lib/process.ts";
import { redactSecrets } from "../../src/lib/redact.ts";

export async function documentEnvironment(args: string[], signal?: AbortSignal): Promise<number> {
  const [action, image] = args;
  if (!["preflight", "check", "install", "repair"].includes(action!) || args.length > 2 || image !== undefined && (action !== "check" || image !== "--image"))
    throw new Error("文档环境只接受 preflight、check、install 或 repair");
  const target = image ? "/app/.venv" : resolve(runtimeSetting("BOT_DOCUMENT_ENV") || "data/runtime/document-env");
  console.log(`文档环境：${target}${image ? "（部署镜像；隔离任务使用镜像内环境）" : ""}`);
  console.log(`LibreOffice：${runtimeSetting("BOT_DOCUMENT_OFFICE_PATH") || "自动查找"}`);
  const uv = Bun.which(process.platform === "win32" ? "uv.exe" : "uv");
  if (!uv) throw new Error("未找到 uv。请在部署机安装 uv，并确保机器人服务账户的 PATH 可以找到它，再运行本任务。");
  console.log(`uv：${uv}`);
  if (action === "preflight") return 0;
  if (action === "install" || action === "repair") {
    if (!await ensureDocumentToolchain(target, signal, { repair: action === "repair", timeoutMs: 30 * 60_000, report: console.log }))
      throw new Error("文档依赖安装未通过；请根据上面的 uv 输出检查下载网络、目录权限或锁等待，再重试。");
  } else if (!await verifyDocumentToolchain(target, signal, console.log)) {
    throw new Error(image ? "镜像内文档依赖未通过，请重新部署以重建镜像。" : "文档依赖未就绪，请运行“安装缺失依赖”；仍失败时运行“修复依赖”。");
  }
  const temporary = resolve("data/runtime/tmp/document-check"); await mkdir(temporary, { recursive: true });
  console.log("正在验证 DOCX、PPTX、XLSX、PDF 读写和 LibreOffice 页面预览…");
  const result = await runProcess({ command: venvPythonPath(target),
    args: [join(import.meta.dir, "../config/document-check.py"), temporary, runtimeSetting("BOT_DOCUMENT_OFFICE_PATH") || ""],
    cwd: process.cwd(), timeoutMs: 3 * 60_000, signal,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
  console.log(redactSecrets(result.output));
  if (result.exitCode !== 0) throw new Error("文档能力检查未全部通过。Python 依赖和 LibreOffice 分别检查；缺少 LibreOffice 时请安装并在本页填写程序路径。");
  console.log(image ? "部署镜像中的文档依赖、读写与页面预览验证通过；任务隔离服务的状态请结合实际任务日志检查。"
    : "文档环境验证完成，可以解析文档并生成页面预览。");
  return 0;
}

if (import.meta.main) {
  try { process.exitCode = await documentEnvironment(process.argv.slice(2)); }
  catch (error) {
    console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
    if (error instanceof ProcessFailure && error.result.output) console.error(redactSecrets(error.result.output.slice(-8000)));
    process.exitCode = 1;
  }
}
