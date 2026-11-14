// The models a custom provider's endpoint offers, for the console's model picker: the endpoint's own list call, never an
// inference. The caller resolves the credential through Pi (configuration-check.ts), so the key is what the bot would send.
// Responses are bounded, redirects are refused (they could carry the key to another host), and only ids, names and limits
// leave this module. Error texts name the HTTP status, never the response body or the address.

/** Protocols whose endpoints have a model list, as Pi addresses them (the base URL Pi's SDK clients are given). */
export const LISTABLE_APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai", "mistral-conversations"] as const;
export type ListableApi = typeof LISTABLE_APIS[number];
export const isListableApi = (api: unknown): api is ListableApi => LISTABLE_APIS.includes(api as ListableApi);

export interface ListedModel { id: string; name?: string; contextWindow?: number; maxTokens?: number; input?: ("text" | "image")[] }
export interface ListAuth { apiKey?: string; headers?: Record<string, string> }

const MAX_BYTES = 8 * 1024 * 1024, MAX_PAGES = 20, MAX_MODELS = 5000, TIMEOUT_MS = 30_000;
type Value = Record<string, unknown>;
const object = (value: unknown): Value | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Value : undefined;
const string = (value: unknown) => typeof value === "string" && value.trim() && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : undefined;
const count = (...values: unknown[]) => values.find((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0);
const trimmed = (base: string) => base.replace(/\/+$/, "");

/** One listed model from the fields the common endpoints use (OpenAI-compatible gateways add their own limits). */
function model(id: unknown, item: Value, extra: Partial<ListedModel> = {}): ListedModel[] {
  const value = string(id);
  if (!value) return [];
  const top = object(item.top_provider), architecture = object(item.architecture);
  const name = string(item.display_name) ?? string(item.displayName) ?? string(item.name);
  const contextWindow = extra.contextWindow ?? count(item.context_length, item.context_window, item.max_model_len, item.max_context_length,
    item.max_input_tokens, item.inputTokenLimit, top?.context_length);
  const maxTokens = extra.maxTokens ?? count(item.max_completion_tokens, item.max_output_tokens, item.max_tokens, item.outputTokenLimit, top?.max_completion_tokens);
  const modalities = Array.isArray(architecture?.input_modalities) ? architecture.input_modalities : undefined;
  const input = extra.input ?? (modalities ? (modalities.includes("image") ? ["text", "image"] as const : ["text"] as const) : undefined);
  return [{ id: value, ...name && name !== value ? { name } : {}, ...contextWindow ? { contextWindow } : {}, ...maxTokens ? { maxTokens } : {},
    ...input ? { input: [...input] } : {} }];
}

interface Page { models: ListedModel[]; next?: string }
interface Protocol { url(base: string, next?: string): string; headers(auth: ListAuth): Record<string, string>; parse(body: unknown): Page }

const bearer = (auth: ListAuth): Record<string, string> => auth.apiKey ? { Authorization: `Bearer ${auth.apiKey}` } : {};
const openai: Protocol = {
  url: base => `${trimmed(base)}/models`,
  headers: bearer,
  parse(body) {
    // OpenAI and most compatible servers: { data: [...] }; a few return the array itself or { models: [...] }.
    const list = Array.isArray(body) ? body : object(body)?.data ?? object(body)?.models;
    if (!Array.isArray(list)) throw new ListError("模型端点返回的不是模型列表：请检查 API 地址和协议");
    return { models: list.flatMap(raw => { const item = object(raw); return item ? model(item.id ?? item.name, item) : []; }) };
  },
};
const PROTOCOLS: Record<ListableApi, Protocol> = {
  "openai-completions": openai,
  "openai-responses": openai,
  // The Anthropic SDK appends /v1/messages to the base URL; the list pages with after_id.
  "anthropic-messages": {
    url: (base, next) => `${trimmed(base)}/v1/models?limit=1000${next ? `&after_id=${encodeURIComponent(next)}` : ""}`,
    headers: auth => ({ ...auth.apiKey ? { "x-api-key": auth.apiKey } : {}, "anthropic-version": "2023-06-01" }),
    parse(body) {
      const value = object(body);
      if (!value || !Array.isArray(value.data)) throw new ListError("模型端点返回的不是模型列表：请检查 API 地址和协议");
      const models = value.data.flatMap(raw => { const item = object(raw); return item ? model(item.id, item) : []; });
      const next = value.has_more === true ? string(value.last_id) : undefined;
      return { models, ...next ? { next } : {} };
    },
  },
  // The base URL already names the API version (…/v1beta); ids come as "models/<id>".
  "google-generative-ai": {
    url: (base, next) => `${trimmed(base)}/models?pageSize=1000${next ? `&pageToken=${encodeURIComponent(next)}` : ""}`,
    headers: (auth): Record<string, string> => auth.apiKey ? { "x-goog-api-key": auth.apiKey } : {},
    parse(body) {
      const value = object(body);
      if (!value || !Array.isArray(value.models)) throw new ListError("模型端点返回的不是模型列表：请检查 API 地址和协议");
      const models = value.models.flatMap(raw => {
        const item = object(raw), methods = item?.supportedGenerationMethods;
        if (!item || Array.isArray(methods) && !methods.includes("generateContent")) return [];
        return model(typeof item.name === "string" ? item.name.replace(/^models\//, "") : undefined, { ...item, name: undefined });
      });
      const next = string(value.nextPageToken);
      return { models, ...next ? { next } : {} };
    },
  },
  // Pi resolves v1/chat/completions against the base URL; models are listed beside it.
  "mistral-conversations": {
    url: base => new URL("v1/models", trimmed(base) + "/").href,
    headers: bearer,
    parse(body) {
      const value = object(body);
      if (!value || !Array.isArray(value.data)) throw new ListError("模型端点返回的不是模型列表：请检查 API 地址和协议");
      return { models: value.data.flatMap(raw => {
        const item = object(raw), capabilities = object(item?.capabilities);
        if (!item || capabilities?.completion_chat === false) return [];
        return model(item.id, item, capabilities?.vision === true ? { input: ["text", "image"] } : {});
      }) };
    },
  },
};

/** A refusal whose text can be shown: Chinese, without the address, the key or the endpoint's body. */
export class ListError extends Error {}

async function body(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new ListError("模型列表超过 8 MiB，未读取");
  const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel(); throw new ListError("模型列表超过 8 MiB，未读取"); }
    chunks.push(value);
  }
  try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); }
  catch { throw new ListError("模型端点返回的不是 JSON：请检查 API 地址和协议"); }
}

function statusError(status: number): ListError {
  if (status >= 300 && status < 400) return new ListError(`模型端点返回重定向（HTTP ${status}）：请填写重定向后的最终地址`);
  if (status === 401 || status === 403) return new ListError(`模型端点拒绝了请求（HTTP ${status}）：请检查 API 密钥及其权限`);
  if (status === 404 || status === 405) return new ListError(`模型端点没有模型列表接口（HTTP ${status}）：请检查 API 地址和协议，或直接填写模型 ID`);
  if (status === 429) return new ListError("模型端点限流（HTTP 429）：请稍后重试");
  return new ListError(`模型端点返回 HTTP ${status}：请检查 API 地址和协议，或稍后重试`);
}

/**
 * Every page of the endpoint's list (bounded), de-duplicated and sorted by id. `fetcher` is for tests; `signal` ends it early.
 */
export async function listModels(api: ListableApi, baseUrl: string, auth: ListAuth, options: { fetcher?: typeof fetch; signal?: AbortSignal } = {}): Promise<ListedModel[]> {
  const protocol = PROTOCOLS[api], fetcher = options.fetcher ?? fetch;
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  const headers = { Accept: "application/json", ...auth.headers, ...protocol.headers(auth) };
  const found = new Map<string, ListedModel>();
  let next: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    let response: Response;
    try { response = await fetcher(protocol.url(baseUrl, next), { method: "GET", headers, redirect: "manual", signal }); }
    catch (error) {
      if (signal.aborted) throw new ListError(options.signal?.aborted ? "已取消获取模型列表" : "模型端点 30 秒内没有返回列表：请检查地址、网络和代理设置");
      throw new ListError("无法连接模型端点：请检查 API 地址、网络和代理设置");
    }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw statusError(response.status); }
    const parsed = protocol.parse(await body(response));
    for (const item of parsed.models) if (!found.has(item.id)) found.set(item.id, item);
    if (found.size > MAX_MODELS) throw new ListError(`模型列表超过 ${MAX_MODELS} 个，请直接填写模型 ID`);
    if (!parsed.next || parsed.next === next) break;
    next = parsed.next;
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id, "en", { sensitivity: "base" }));
}
