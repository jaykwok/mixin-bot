import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpClient, StdioTransport, StreamableHttpTransport, validateMcpServerConfig, type AuthProvider, type CallToolResult, type McpTransport, type McpTransportSendOptions,
  type Tool } from "@earendil-works/pi-mcp";
import { expandVariables, type McpConfig, type McpServerConfig } from "../core/mcp-config.ts";
import { mcpOAuth } from "./mcp-oauth.ts";
import type { Scope } from "../core/layout.ts";
import { APP_VERSION } from "../core/version.ts";
import { SUPERVISOR_ENV } from "../lib/process.ts";

/** The calling member; `tempDir` is the directory a stdio server starts in (the request's directory in a run). */
export interface McpMember { scope: Scope; phone: string; workspaceDir: string; tempDir: string }
export type ExternalGate = <T>(dispatch: () => Promise<T>, signal: AbortSignal) => Promise<T>;
export interface McpCatalogueTool { server: McpServerConfig; tool: Tool }
/** Every request except tools/call ends after requestMs; a tools/call after callMs. */
export interface McpTimeouts { requestMs: number; callMs: number }
const supervisor = fileURLToPath(new URL("../lib/process-supervisor.ts", import.meta.url));
const sameSchema = (a: Tool, b: Tool) => JSON.stringify(a.inputSchema) === JSON.stringify(b.inputSchema) && JSON.stringify(a.outputSchema) === JSON.stringify(b.outputSchema);

/** A server as pi-mcp's `mcpServers` shape has it (the administrator's file, without this service's `tools`). */
export function officialEntry(server: McpServerConfig): Record<string, unknown> {
  const common = { ...(server.description === undefined ? {} : { description: server.description }), ...(server.timeout === undefined ? {} : { timeout: server.timeout }) };
  return server.transport === "stdio" ? { ...common, command: server.command, args: server.args ?? [], ...(server.env ? { env: server.env } : {}) }
    : { ...common, url: server.url, ...(server.headers ? { headers: server.headers } : {}), ...(server.oauth ? { oauth: server.oauth } : {}) };
}

/** Official protocol/transports, short-lived member sessions, and a fixed administrator tool allowlist. */
export class McpTools {
  readonly catalogue: McpCatalogueTool[] = [];
  readonly #clients = new Set<McpClient>();
  readonly #clientClose = new WeakMap<McpClient, Promise<void>>();
  readonly #closing = new AbortController();
  readonly #scope = new AsyncLocalStorage<{ signal: AbortSignal; gate?: ExternalGate }>();
  readonly #auth = new Map<string, AuthProvider>();
  readonly #timeouts: McpTimeouts;
  constructor(private readonly config: McpConfig, private readonly discoveryDir = "data/runtime/mcp/discovery",
    timeouts: Partial<McpTimeouts> = {}) {
    this.#timeouts = { requestMs: 30000, callMs: 120000, ...timeouts };
    for (const server of config.servers) {
      // The file was checked by this service's rules (src/core/mcp-config.ts); pi-mcp's own check must agree on every entry.
      const official = validateMcpServerConfig(server.name, officialEntry(server));
      if (official.kind !== server.transport) throw new Error(`MCP ${server.name} 配置无效：${official.kind === "invalid" ? official.error : "传输方式不符"}`);
      if (server.oauth) this.#auth.set(server.name, mcpOAuth(server).auth);
    }
  }

  /** A server's time limits: its `timeout` bounds a tool call, and the other requests when it is the shorter. */
  #limits(server: McpServerConfig): McpTimeouts {
    const callMs = server.timeout === undefined ? this.#timeouts.callMs : server.timeout * 1000;
    return { callMs, requestMs: Math.min(this.#timeouts.requestMs, callMs) };
  }

  async initialize(signal: AbortSignal): Promise<void> {
    try {
      await mkdir(this.discoveryDir, { recursive: true, mode: 0o700 });
      for (const server of this.config.servers) {
        const tools = await this.#use(server, undefined, signal, undefined, client => client.listTools({ signal, timeoutMs: this.#limits(server).requestMs }));
        const names = new Set<string>();
        for (const tool of tools) {
          if (names.has(tool.name)) throw new Error(`MCP ${server.name} 返回重复工具名称`);
          names.add(tool.name);
          if (server.tools.includes(tool.name)) this.catalogue.push({ server, tool });
        }
        if (server.tools.some(name => !names.has(name))) throw new Error(`MCP ${server.name} 的工具白名单有未发现的名称`);
      }
    } catch (error) { await this.close(); throw error; }
  }

  async call(entry: McpCatalogueTool, member: McpMember, args: Record<string, unknown>, signal: AbortSignal, gate: ExternalGate): Promise<CallToolResult> {
    const { requestMs, callMs } = this.#limits(entry.server);
    return this.#use(entry.server, member, signal, gate, async client => {
      const current = (await client.listTools({ signal, timeoutMs: requestMs })).find(tool => tool.name === entry.tool.name);
      if (!current || !sameSchema(current, entry.tool)) throw new Error("MCP 工具目录变化，请由管理员检查并重启后重新发现；本次工具未执行");
      signal.throwIfAborted();
      const callSignal = AbortSignal.any([signal, this.#closing.signal, AbortSignal.timeout(callMs)]);
      return this.#scope.run({ signal: callSignal, gate }, () => client.callTool(entry.tool.name, args, { signal: callSignal, timeoutMs: callMs }));
    });
  }

  async #use<T>(server: McpServerConfig, member: McpMember | undefined, signal: AbortSignal, gate: ExternalGate | undefined,
    work: (client: McpClient) => Promise<T>): Promise<T> {
    if (this.#clients.size >= 8) throw new Error("MCP 活跃会话已达上限");
    const requestSignal = AbortSignal.any([signal, this.#closing.signal]);
    return this.#scope.run({ signal: requestSignal, gate }, async () => {
      requestSignal.throwIfAborted();
      const client = new McpClient({ name: "mixin-bot", version: APP_VERSION, requestTimeoutMs: this.#limits(server).requestMs,
        roots: member ? [{ uri: pathToFileURL(member.workspaceDir).href, name: "workspace (read only)" }, { uri: pathToFileURL(member.tempDir).href, name: "member tmp" }] : [],
      });
      this.#clients.add(client);
      const abort = () => { void this.#close(client).catch(() => {}); };
      requestSignal.addEventListener("abort", abort, { once: true });
      try {
        const transport = this.#transport(server, member);
        await client.connect(transport);
        requestSignal.throwIfAborted();
        return await work(client);
      } finally {
        requestSignal.removeEventListener("abort", abort);
        try { await this.#close(client); } finally { this.#clients.delete(client); }
      }
    });
  }

  #close(client: McpClient): Promise<void> {
    let work = this.#clientClose.get(client);
    if (!work) { work = client.close(); this.#clientClose.set(client, work); }
    return work;
  }

  #transport(server: McpServerConfig, member: McpMember | undefined): McpTransport {
    if (server.transport === "stdio") {
      const env: Record<string, string> = {};
      for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "PATHEXT", "TEMP", "TMP", "LANG"]) if (process.env[name]) env[name] = process.env[name]!;
      Object.assign(env, this.#expanded(server, server.env), { MIXIN_CHAT_KIND: member?.scope.kind ?? "", MIXIN_GROUP_ID: member?.scope.kind === "group" ? member.scope.groupId : "",
        MIXIN_MEMBER_PHONE: member?.phone ?? "" });
      // The supervisor starts with its small JIT region (SUPERVISOR_ENV); the server gets the administrator's value, or none.
      const jit = server.env?.BUN_JSC_jitMemoryReservationSize;
      Object.assign(env, SUPERVISOR_ENV, jit === undefined ? {} : { MIXIN_STDIO_COMMAND_JIT: jit });
      const transport = new StdioTransport({ command: process.execPath, args: [supervisor, "--stdio", server.command!, ...server.args ?? []],
        cwd: member?.tempDir ?? this.discoveryDir, env, inheritEnv: false, maxMessageBytes: 8 * 1024 * 1024, maxStderrBytes: 65536, closeTimeoutMs: 2000 });
      return new Proxy(transport, { get: (target, property) => {
        // A tools/call waits for the request door. pi-mcp aborts the send signal once the request ended (answered, timed
        // out or cancelled); StdioTransport.send ignores it, so the gate waits on it too and, when it lets the call
        // through, sends nothing for a request that ended meanwhile.
        if (property === "send") return (message: Parameters<McpTransport["send"]>[0], options?: McpTransportSendOptions) => {
          const scope = this.#scope.getStore();
          if (!("method" in message && message.method === "tools/call" && scope?.gate)) return target.send(message);
          const ended = options?.signal;
          return scope.gate(async () => {
            ended?.throwIfAborted();
            scope.signal.throwIfAborted();
            return target.send(message);
          }, ended ? AbortSignal.any([scope.signal, ended]) : scope.signal);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    }
    const headers = this.#expanded(server, server.headers);
    for (const name of Object.keys(headers)) if (["x-mixin-chat", "x-mixin-group", "x-mixin-member"].includes(name.toLowerCase())) delete headers[name];
    if (member) Object.assign(headers, { "x-mixin-chat": member.scope.kind, "x-mixin-member": encodeURIComponent(member.phone),
      ...(member.scope.kind === "group" ? { "x-mixin-group": encodeURIComponent(member.scope.groupId) } : {}) });
    return new StreamableHttpTransport({ url: server.url!, headers, authProvider: this.#auth.get(server.name),
      maxMessageBytes: 8 * 1024 * 1024, openGetStream: false,
      fetch: (url, init) => {
        const scope = this.#scope.getStore();
        // Session DELETE and cancellation must still reach the server after a tool's cancellation.
        let method: string | undefined;
        if (init?.method === "POST" && typeof init.body === "string") {
          try { method = JSON.parse(init.body).method; } catch { /* The official transport owns protocol validation. */ }
        }
        const signal = AbortSignal.any([this.#closing.signal, ...(scope ? [scope.signal] : []), ...(init?.signal ? [init.signal] : []),
          ...(method === "tools/call" ? [] : [AbortSignal.timeout(this.#limits(server).requestMs)])]);
        const dispatch = () => { signal.throwIfAborted(); return fetch(url, { ...init, signal }); };
        return init?.method === "DELETE" || method === "notifications/cancelled" ? fetch(url, { ...init, signal: AbortSignal.timeout(5000) }) : scope?.gate ? scope.gate(dispatch, signal) : dispatch();
      },
    });
  }

  /** The configured values with their variable references filled in from the service's environment. */
  #expanded(server: McpServerConfig, values: Record<string, string> | undefined): Record<string, string> {
    try { return Object.fromEntries(Object.entries(values ?? {}).map(([name, value]) => [name, expandVariables(value)])); }
    catch (error) { throw new Error(`MCP ${server.name}：${(error as Error).message}`); }
  }

  async close(): Promise<void> {
    this.#closing.abort();
    const results = await Promise.allSettled([...this.#clients].map(client => this.#close(client)));
    const failed = results.filter(result => result.status === "rejected");
    if (failed.length) throw new AggregateError(failed.map(result => (result as PromiseRejectedResult).reason), "MCP 会话关闭失败");
  }
}
