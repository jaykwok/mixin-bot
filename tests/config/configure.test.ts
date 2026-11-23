import { describe, expect, test } from "bun:test";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { catalogDefaults, catalogMatches, discoverModels } from "../../ops/config/configure.ts";

/** 只读 Pi 随包目录，不碰仓库里的 data/ 和网络。 */
function builtinRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create({
    modelsPath: null, credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(), refreshOnCreate: false,
  });
}

describe("自定义端点的模型资料预填", () => {
  test("按精确 id 命中 Pi 目录，不靠子串猜", async () => {
    const runtime = await builtinRuntime();
    const matches = catalogMatches(runtime, "gpt-5.2");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((model) => model.id === "gpt-5.2")).toBe(true);
    // 官方那家也在候选里：自定义 id 取成内置 id 时，正该拿它的资料预填。
    expect(matches.some((model) => model.provider === "openai")).toBe(true);
    // 来源按 provider 排序，重复配置时选项顺序才是稳定的。
    expect(matches.map((model) => model.provider)).toEqual([...matches.map((model) => model.provider)].sort());
    // 近似 id 一律不算命中：猜错的价格和上下文比留空更难发现。
    expect(catalogMatches(runtime, "gpt-5.2-unknown-alias")).toEqual([]);
    expect(catalogMatches(runtime, "")).toEqual([]);
  });

  test("只复制模型资料，provider 的传输设置不跟着进中转站条目", async () => {
    const runtime = await builtinRuntime();
    const source = catalogMatches(runtime, "gpt-5.2")[0]!;
    const defaults = catalogDefaults({ ...source, headers: { "provider-specific": "value" }, compat: { supportsMaxOutputTokens: false },
      promptCache: { short: 300, long: 1800 }, inputLimits: { images: { resize: { maxWidth: 1280 } } } });
    expect(defaults).toEqual({
      contextWindow: source.contextWindow, maxTokens: source.maxTokens,
      input: source.input, reasoning: source.reasoning, cost: source.cost,
    });
    expect(defaults).not.toHaveProperty("id");
    expect(defaults).not.toHaveProperty("api");
    expect(defaults).not.toHaveProperty("baseUrl");
    expect(defaults).not.toHaveProperty("provider");
    expect(defaults).not.toHaveProperty("headers");
    expect(defaults).not.toHaveProperty("compat");
    expect(defaults).not.toHaveProperty("promptCache");
    expect(defaults).not.toHaveProperty("inputLimits");
    // 拷贝而非共享引用，后面的交互改动不会写回 Pi 的目录对象。
    expect(defaults.cost).not.toBe(source.cost);
    expect(defaults.input).not.toBe(source.input);
  });
});

describe("端点模型清单", () => {
  async function withEndpoint(
    handler: (request: Request) => Response, run: (baseUrl: string) => Promise<void>
  ): Promise<void> {
    const server = Bun.serve({ port: 0, fetch: handler });
    try {
      await run(`${server.url.origin}/v1`);
    } finally {
      await server.stop(true);
    }
  }

  test("OpenAI 兼容端点：GET {baseUrl}/models，Bearer 鉴权，去重排序并带回端点声明的上限", async () => {
    let seen: { path: string; auth: string | null } | undefined;
    await withEndpoint((request) => {
      const url = new URL(request.url);
      seen = { path: url.pathname, auth: request.headers.get("authorization") };
      return Response.json({
        data: [
          { id: "b-model", context_length: 65536, max_completion_tokens: 8192 },
          { id: "a-model" },
          { id: "a-model" },
          { id: 7 },
          { id: "  " },
        ],
      });
    }, async (baseUrl) => {
      expect(await discoverModels("openai-responses", baseUrl, "k")).toEqual([
        { id: "a-model" },
        { id: "b-model", contextWindow: 65536, maxTokens: 8192 },
      ]);
    });
    expect(seen).toEqual({ path: "/v1/models", auth: "Bearer k" });
  });

  test("Anthropic 端点：GET {baseUrl}/v1/models，x-api-key 鉴权并支持分页", async () => {
    const seen: { path: string; after: string | null; key: string | null; version: string | null }[] = [];
    await withEndpoint((request) => {
      const url = new URL(request.url);
      const after = url.searchParams.get("after_id");
      seen.push({
        path: url.pathname, after, key: request.headers.get("x-api-key"),
        version: request.headers.get("anthropic-version"),
      });
      if (!after) return Response.json({ data: [{ id: "claude-b" }], has_more: true, last_id: "claude-b" });
      return Response.json({ data: [{ id: "claude-a" }], has_more: false });
    }, async (baseUrl) => {
      // Anthropic 的 baseUrl 不带 /v1，这里故意传一个带尾斜杠的地址确认不会拼出双斜杠。
      expect((await discoverModels("anthropic-messages", `${baseUrl}/`, "k")).map(item => item.id)).toEqual(["claude-a", "claude-b"]);
    });
    expect(seen).toEqual([
      { path: "/v1/v1/models", after: null, key: "k", version: "2023-06-01" },
      { path: "/v1/v1/models", after: "claude-b", key: "k", version: "2023-06-01" },
    ]);
  });

  test("Google 端点：x-goog-api-key 鉴权，models[].name 去掉前缀", async () => {
    const seen: { key: string | null } = { key: null };
    await withEndpoint((request) => {
      seen.key = request.headers.get("x-goog-api-key");
      return Response.json({ models: [{ name: "models/gemini-test", inputTokenLimit: 1000000, outputTokenLimit: 8192 }] });
    }, async (baseUrl) => {
      expect(await discoverModels("google-generative-ai", baseUrl, "k")).toEqual([
        { id: "gemini-test", contextWindow: 1000000, maxTokens: 8192 },
      ]);
    });
    expect(seen.key).toBe("k");
  });

  test("不支持列表接口的协议返回空数组，不发请求", async () => {
    expect(await discoverModels("bedrock-converse-stream", "http://127.0.0.1:1", "k")).toEqual([]);
  });

  test("端点报错、重定向或返回非清单 JSON 时抛出，由调用方退回手填", async () => {
    await withEndpoint(() => new Response("nope", { status: 403, statusText: "Forbidden" }), async (baseUrl) => {
      expect(discoverModels("openai-completions", baseUrl, "k")).rejects.toThrow("403");
    });
    await withEndpoint(() => new Response(null, { status: 302, headers: { location: "https://other.invalid/models" } }), async (baseUrl) => {
      expect(discoverModels("openai-completions", baseUrl, "k")).rejects.toThrow("重定向");
    });
    await withEndpoint(() => Response.json({ object: "list" }), async (baseUrl) => {
      expect(discoverModels("openai-completions", baseUrl, "k")).rejects.toThrow("不是模型列表");
    });
  });
});
