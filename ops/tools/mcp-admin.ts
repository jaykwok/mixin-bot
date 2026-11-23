import { createInterface } from "node:readline/promises";
import { completeMcpSignIn, listenForLoopbackSignIn, startMcpSignIn, waitForLoopbackSignIn } from "@earendil-works/pi-mcp/oauth";
import { readMcpConfig } from "../../src/core/mcp-config.ts";
import { acquireLease } from "../../src/core/maintenance.ts";
import { clearPendingMcpChallenge, loadPendingMcpChallenge, mcpOAuthClient, type McpOAuthChallenge } from "../../src/integrations/mcp-oauth.ts";

const USAGE = "用法：停机后 bun run mcp login <服务器名> [--reauth] [--scope \"<权限列表>\"] [--prompt-scope]";

/**
 * Parse `mcp login` CLI arguments.
 * @internal Exported for tests only; knip --production skips `@internal`.
 */
export function parseMcpLoginArgs(argv: readonly string[]): { name: string; reauth: boolean; promptScope?: true; scope?: string } {
  const [command, name, ...rest] = argv;
  if (command !== "login" || !name || name.startsWith("-")) throw new Error(USAGE);
  let reauth = false;
  let promptScope = false;
  let scope: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--reauth" || arg === "--force") reauth = true;
    else if (arg === "--prompt-scope") promptScope = true;
    else if (arg === "--scope") {
      const value = rest[++i]?.trim();
      if (!value) throw new Error(USAGE);
      scope = value;
    } else if (arg.startsWith("--scope=")) {
      const value = arg.slice("--scope=".length).trim();
      if (!value) throw new Error(USAGE);
      scope = value;
    } else {
      throw new Error(USAGE);
    }
  }
  return { name, reauth, ...(promptScope ? { promptScope: true } : {}), ...(scope ? { scope } : {}) };
}

/**
 * Combine a persisted runtime challenge (`insufficient_scope`, `resourceMetadataUrl`) with explicit admin flags.
 * @internal Exported for tests only; knip --production skips `@internal`.
 */
export function buildSignInChallenge(pending: McpOAuthChallenge | undefined, options: { reauth?: boolean; scope?: string }): McpOAuthChallenge | undefined {
  if (!pending && !options.reauth && !options.scope) return undefined;
  const stepUp = options.reauth === true || Boolean(options.scope) || pending?.error === "insufficient_scope";
  const scope = [pending?.scope, options.scope].filter(Boolean).join(" ").trim() || undefined;
  return {
    ...(pending ?? {}),
    ...(stepUp ? { error: "insufficient_scope" } : {}),
    ...(scope ? { scope } : {}),
  };
}

/** Read additional OAuth scope interactively so remote values containing shell metacharacters never pass through a shell. */
async function readInteractiveScope(signal: AbortSignal): Promise<string | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const abort = () => rl.close();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const answer = await rl.question("请输入需要授权的 scope（多个以空格分隔，留空跳过）：", { signal });
    return answer.trim() || undefined;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if ((error as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE") return undefined;
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    rl.close();
  }
}

if (import.meta.main) {
  let parsed: ReturnType<typeof parseMcpLoginArgs>;
  try { parsed = parseMcpLoginArgs(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
  const { name, reauth, promptScope, scope } = parsed;
  const server = readMcpConfig()?.servers.find(server => server.name === name);
  if (!server?.oauth || !server.url) throw new Error("服务器未配置 HTTP OAuth");
  const release = await acquireLease("service");
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
  const cancel = () => controller.abort(new Error("登录取消"));
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    const client = mcpOAuthClient(server);
    const explicitRecovery = reauth || Boolean(scope) || promptScope === true;
    let pending: McpOAuthChallenge | undefined;
    try {
      pending = await loadPendingMcpChallenge(server);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (!explicitRecovery) {
        throw new Error(
          `无法读取 MCP ${name} 的权限挑战文件（${reason}）；如确认需要重新授权，请改用 --reauth、--scope "<权限列表>" 或 --prompt-scope，并清理异常挑战路径`,
          { cause: error },
        );
      }
      console.error(`警告：无法读取 MCP ${name} 的权限挑战文件（${reason}），将继续按管理员显式参数执行重新授权。`);
    }
    const promptedScope = promptScope ? await readInteractiveScope(signal) : undefined;
    const requestedScope = [scope, promptedScope].filter(Boolean).join(" ").trim() || undefined;
    const challenge = buildSignInChallenge(pending, { reauth: reauth || promptScope === true, scope: requestedScope });
    if (challenge?.error === "insufficient_scope") {
      console.log(`正在为 MCP ${name} 执行重新授权${challenge.scope ? `（附加 scope：${challenge.scope}）` : ""}…`);
    }
    const { callback, redirectUrl } = await listenForLoopbackSignIn({
      serverUrl: client.serverUrl,
      store: client.store,
      settings: client.settings,
    });
    try {
      const signIn = { ...client, redirectUrl, signal, ...(challenge ? { challenge } : {}) };
      const authorization = await startMcpSignIn(signIn);
      if (authorization.kind === "redirect") {
        console.log(`请在浏览器打开：${authorization.authorizationUrl}`);
        const response = await waitForLoopbackSignIn({ callback, authorization, signal });
        await completeMcpSignIn({ ...signIn, authorization, response });
      }
      signal.throwIfAborted();
      console.log(`MCP ${name} 授权已保存`);
      try {
        await clearPendingMcpChallenge(server);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`警告：MCP ${name} 凭据已保存，但未能清理旧的权限挑战文件（${reason}）；请手动移除残留挑战路径。`);
      }
    } finally {
      await callback.close();
    }
  } finally {
    await release();
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
  }
}
