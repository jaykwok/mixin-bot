// data/config/mcp.json: the administrator's MCP servers in the `mcpServers` shape MCP clients share (pi-mcp's
// McpServerConfig), so an entry can be copied from another client, with this service's rules on top:
// - `tools` is required: the tools of the server that members may call, by name; nothing else of it is offered;
// - a stdio `command` is an absolute path, and `cwd` is not taken (a server starts in the calling member's directory);
// - a URL is https (http on loopback only) and carries no credentials; every `headers` value and `oauth.clientSecret`
//   reference environment variables (`${NAME}`), so the file holds no request credential;
// - at most MCP_LIMITS.servers enabled servers, with names whose tool namespaces differ.
// No package is imported here: the host console reads the file where the robot's dependencies are not installed. The
// service checks every entry with pi-mcp's validateMcpServerConfig as well (src/integrations/mcp.ts).
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { MCP_CONFIG_PATH } from "./storage.ts";

export interface McpServerConfig {
  name: string;
  /** The tools members may call. */
  tools: string[];
  transport: "stdio" | "http";
  /** What the server offers, in a sentence: shown to the model with the server's tools. */
  description?: string;
  /** Seconds a tool call may take (default: McpTools' callMs). */
  timeout?: number;
  command?: string; args?: string[];
  /** Added to the server's environment; a value may reference variables of the service's. */
  env?: Record<string, string>;
  url?: string;
  /** Sent with every request; every value references variables. */
  headers?: Record<string, string>;
  /** `callbackPort`: the administrator's sign-in listens on `http://127.0.0.1:<port>/callback`. */
  oauth?: { callbackPort: number; clientId?: string; clientSecret?: string; scope?: string; clientName?: string };
}
/** The enabled servers, in the file's order. */
export interface McpConfig { servers: McpServerConfig[] }

export const MCP_LIMITS = { servers: 8, tools: 64, args: 64, timeoutSeconds: 600 } as const;

const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const references = (text: string) => [...text.matchAll(VARIABLE)].length;
/** Every `${` of the text starts a well-formed reference. */
const wellFormed = (text: string) => !text.replace(VARIABLE, "").includes("${");

/** `text` with every `${NAME}` replaced by that environment variable; an unset or empty one is an error that names it. */
export function expandVariables(text: string, env: Record<string, string | undefined> = process.env): string {
  return text.replace(VARIABLE, (_, name: string) => {
    const value = env[name];
    if (!value) throw new Error(`缺少环境变量 ${name}`);
    return value;
  });
}

/** The namespace of a server's tools as pi-mcp's mcpNamespace names it: two servers must not share one. */
const namespaceKey = (name: string) => name.replace(/-/g, "_");

const COMMON = ["type", "tools", "enabled", "description", "timeout"];
const STDIO = [...COMMON, "command", "args", "env"], HTTP = [...COMMON, "url", "headers", "oauth"];
const OAUTH = ["callbackPort", "clientId", "clientSecret", "scope", "clientName"];
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value !== "" && !value.includes("\0");

function server(name: string, raw: unknown): { enabled: boolean; config: McpServerConfig } {
  const fail = (reason: string): never => { throw new Error(`MCP ${name}：${reason}`); };
  if (!isRecord(raw)) return fail("必须是对象");
  const strings = (value: unknown, field: string, limit: number): string[] => {
    if (!Array.isArray(value) || value.length > limit || !value.every(text)) fail(`${field} 必须是字符串数组（最多 ${limit} 项）`);
    return value as string[];
  };
  const record = (value: unknown, field: string): Record<string, string> | undefined => {
    if (value === undefined) return undefined;
    if (!isRecord(value) || Object.entries(value).some(([key, item]) => !key || key.includes("\0") || typeof item !== "string" || item.includes("\0"))) fail(`${field} 必须是名称到字符串的对象`);
    for (const [key, item] of Object.entries(value as Record<string, string>)) if (!wellFormed(item)) fail(`${field}.${key} 里的变量引用写法无效，应为 \${变量名}`);
    return value as Record<string, string>;
  };
  const stdio = raw.command !== undefined, known = stdio ? STDIO : HTTP;
  if (raw.cwd !== undefined) fail("不支持 cwd：程序在调用成员的临时目录里启动");
  if (stdio === (raw.url !== undefined)) fail("需要 command（本机程序）或 url（HTTP 服务）之一");
  const unknown = Object.keys(raw).filter(key => !known.includes(key));
  if (unknown.length) fail(`不支持的字段：${unknown.join("、")}`);
  if (raw.type !== undefined && !(stdio ? ["stdio"] : ["http", "streamable-http"]).includes(raw.type as string)) fail(stdio ? "command 对应的 type 是 stdio" : "url 对应的 type 是 http");
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") fail("enabled 必须是 true 或 false");
  if (raw.description !== undefined && (!text(raw.description) || raw.description.length > 200)) fail("description 必须是不超过 200 字的文字");
  if (raw.timeout !== undefined && !(typeof raw.timeout === "number" && raw.timeout >= 1 && raw.timeout <= MCP_LIMITS.timeoutSeconds)) fail(`timeout 是秒数，1 到 ${MCP_LIMITS.timeoutSeconds}`);
  const tools = strings(raw.tools, "tools", MCP_LIMITS.tools);
  if (!tools.length || new Set(tools).size !== tools.length) fail("tools 必须列出允许成员调用的工具名，不能为空或重复");
  const common = { name, tools, ...(raw.description === undefined ? {} : { description: raw.description as string }), ...(raw.timeout === undefined ? {} : { timeout: raw.timeout as number }) };
  const enabled = raw.enabled !== false;
  if (stdio) {
    if (!text(raw.command) || !isAbsolute(raw.command)) fail("command 必须是程序的绝对路径");
    const env = record(raw.env, "env");
    if (Object.keys(env ?? {}).some(key => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) fail("env 的变量名无效");
    return { enabled, config: { ...common, transport: "stdio", command: raw.command as string, args: strings(raw.args ?? [], "args", MCP_LIMITS.args), ...(env ? { env } : {}) } };
  }
  if (typeof raw.url !== "string" || !URL.canParse(raw.url)) fail("url 无效");
  const url = new URL(raw.url as string);
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    fail("url 必须是 HTTPS（本机回环地址可以用 HTTP），不能带账号、口令或 # 片段");
  }
  const headers = record(raw.headers, "headers");
  for (const [key, item] of Object.entries(headers ?? {})) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) fail(`请求头名称无效：${key}`);
    if (!references(item)) fail(`headers.${key} 必须引用环境变量（例如 "Bearer \${DOCS_TOKEN}"），不把凭证写进配置文件`);
  }
  let oauth: McpServerConfig["oauth"];
  if (raw.oauth !== undefined) {
    const auth = raw.oauth;
    if (!isRecord(auth)) return fail("oauth 必须是对象");
    const extra = Object.keys(auth).filter(key => !OAUTH.includes(key));
    if (extra.length) fail(`oauth 不支持的字段：${extra.join("、")}`);
    const port = auth.callbackPort;
    if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1024 || port > 65535) fail("oauth.callbackPort 必填，1024 到 65535：管理员登录时在本机这个端口接收回调");
    for (const field of ["clientId", "scope", "clientName"] as const) if (auth[field] !== undefined && (!text(auth[field]) || !(auth[field] as string).trim())) fail(`oauth.${field} 必须是非空文字`);
    if (auth.clientSecret !== undefined && !(typeof auth.clientSecret === "string" && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(auth.clientSecret))) {
      fail("oauth.clientSecret 必须是一个环境变量引用（\${变量名}），不把密钥写进配置文件");
    }
    oauth = { callbackPort: port as number, ...Object.fromEntries(["clientId", "clientSecret", "scope", "clientName"].flatMap(field => auth[field] === undefined ? [] : [[field, auth[field]]])) };
  }
  return { enabled, config: { ...common, transport: "http", url: url.href, ...(headers ? { headers } : {}), ...(oauth ? { oauth } : {}) } };
}

/** The file's enabled servers; undefined without a file. A disabled entry is checked like the others and left out. */
export function readMcpConfig(path = MCP_CONFIG_PATH): McpConfig | undefined {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!isRecord(raw)) throw new Error(`${path} 必须是对象`);
  if (!isRecord(raw.mcpServers) || Object.keys(raw).some(key => key !== "mcpServers")) throw new Error(`${path} 格式无效：只有一个 mcpServers 对象，按服务器名称列出各个服务器`);
  const servers: McpServerConfig[] = [], namespaces = new Map<string, string>();
  for (const [name, entry] of Object.entries(raw.mcpServers)) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new Error(`MCP 服务器名称无效：${name}（小写字母开头，只用小写字母、数字、_ 和 -，最多 32 个字符）`);
    const other = namespaces.get(namespaceKey(name));
    if (other !== undefined) throw new Error(`MCP 服务器 ${other} 和 ${name} 只差 - 和 _，工具会混在一起，请改名`);
    namespaces.set(namespaceKey(name), name);
    const { enabled, config } = server(name, entry);
    if (enabled) servers.push(config);
  }
  if (servers.length > MCP_LIMITS.servers) throw new Error(`MCP 最多启用 ${MCP_LIMITS.servers} 个服务器`);
  return { servers };
}
