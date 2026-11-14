import { afterAll, beforeAll, expect, test } from "bun:test";
import { listModels, ListError } from "../../ops/config/model-list.ts";

/** One fake endpoint for every protocol; each request is recorded with its headers. */
const seen: { path: string; headers: Record<string, string> }[] = [];
let server: ReturnType<typeof Bun.serve>, base = "";
beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const url = new URL(request.url), path = url.pathname + url.search;
    seen.push({ path, headers: Object.fromEntries(request.headers) });
    switch (url.pathname) {
      case "/openai/v1/models": return Response.json({ object: "list", data: [
        { id: "gpt-b", object: "model", owned_by: "fixture" },
        { id: "gpt-a", context_length: 200000, top_provider: { max_completion_tokens: 32000 }, name: "GPT A", architecture: { input_modalities: ["text", "image"] } },
        { id: "gpt-a" }, { id: "" }, { id: "bad\u0000id" }, { object: "model" }] });
      case "/bare/v1/models": return Response.json([{ id: "local-model", max_model_len: 32768 }]);
      case "/anthropic/v1/models": return url.searchParams.get("after_id") === "claude-b"
        ? Response.json({ data: [{ id: "claude-c", display_name: "Claude C", type: "model" }], has_more: false, last_id: "claude-c" })
        : Response.json({ data: [{ id: "claude-a", display_name: "Claude A", max_input_tokens: 200000, max_tokens: 64000 }, { id: "claude-b" }], has_more: true, last_id: "claude-b" });
      case "/gemini/v1beta/models": return url.searchParams.get("pageToken") === "next-page"
        ? Response.json({ models: [{ name: "models/gemini-b", displayName: "Gemini B", supportedGenerationMethods: ["generateContent", "countTokens"] }] })
        : Response.json({ models: [
          { name: "models/gemini-a", displayName: "Gemini A", inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ["generateContent"] },
          { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] }], nextPageToken: "next-page" });
      case "/mistral/v1/models": return Response.json({ object: "list", data: [
        { id: "mistral-large", max_context_length: 131072, capabilities: { completion_chat: true, vision: true } },
        { id: "mistral-embed", capabilities: { completion_chat: false } }] });
      case "/denied/v1/models": return Response.json({ error: { message: "invalid key sk-fixture-echoed" } }, { status: 401 });
      case "/missing/v1/models": return new Response("not here", { status: 404 });
      case "/moved/v1/models": return new Response(null, { status: 302, headers: { Location: `${base}/elsewhere/v1/models` } });
      case "/elsewhere/v1/models": return Response.json({ data: [{ id: "should-not-be-reached" }] });
      case "/html/v1/models": return new Response("<html>login</html>", { headers: { "content-type": "text/html" } });
      case "/shape/v1/models": return Response.json({ object: "list" });
      case "/huge/v1/models": return new Response(new ReadableStream({ start(controller) {
        const chunk = new TextEncoder().encode("x".repeat(1024 * 1024));
        for (let index = 0; index < 9; index++) controller.enqueue(chunk);
        controller.close();
      } }));
      case "/loop/v1/models": return Response.json({ data: [{ id: `loop-${url.searchParams.get("after_id") ?? 0}` }], has_more: true, last_id: "same" });
      default: return new Response("unexpected", { status: 500 });
    }
  } });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));
const last = () => seen.at(-1)!;
const refusal = (run: Promise<unknown>) => run.then(() => { throw new Error("expected a refusal"); }, (error: Error) => error);

test("OpenAI 兼容端点：Bearer 密钥和配置的请求头，去重、排序，读出网关给的上下文和输出上限", async () => {
  const models = await listModels("openai-completions", `${base}/openai/v1/`, { apiKey: "sk-fixture", headers: { "X-Gateway": "fixture" } });
  expect(models).toEqual([
    { id: "gpt-a", name: "GPT A", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
    { id: "gpt-b" },
  ]);
  expect(last().path).toBe("/openai/v1/models");
  expect(last().headers).toMatchObject({ authorization: "Bearer sk-fixture", "x-gateway": "fixture", accept: "application/json" });
  expect(await listModels("openai-responses", `${base}/bare/v1`, {})).toEqual([{ id: "local-model", contextWindow: 32768 }]);
  expect(last().headers.authorization).toBeUndefined();
});

test("Anthropic 端点：x-api-key 与版本头，按 after_id 翻页；Gemini 按 pageToken 翻页并只留生成模型；Mistral 去掉非对话模型", async () => {
  expect(await listModels("anthropic-messages", `${base}/anthropic`, { apiKey: "sk-ant-fixture" })).toEqual([
    { id: "claude-a", name: "Claude A", contextWindow: 200000, maxTokens: 64000 }, { id: "claude-b" }, { id: "claude-c", name: "Claude C" }]);
  const anthropic = seen.filter(value => value.path.startsWith("/anthropic/")).slice(-2);
  expect(anthropic.map(value => value.path)).toEqual(["/anthropic/v1/models?limit=1000", "/anthropic/v1/models?limit=1000&after_id=claude-b"]);
  expect(anthropic[0]!.headers).toMatchObject({ "x-api-key": "sk-ant-fixture", "anthropic-version": "2023-06-01" });
  expect(anthropic[0]!.headers.authorization).toBeUndefined();

  expect(await listModels("google-generative-ai", `${base}/gemini/v1beta`, { apiKey: "gemini-fixture" })).toEqual([
    { id: "gemini-a", name: "Gemini A", contextWindow: 1048576, maxTokens: 65536 }, { id: "gemini-b", name: "Gemini B" }]);
  expect(last()).toMatchObject({ path: "/gemini/v1beta/models?pageSize=1000&pageToken=next-page", headers: { "x-goog-api-key": "gemini-fixture" } });

  expect(await listModels("mistral-conversations", `${base}/mistral`, { apiKey: "mistral-fixture" })).toEqual([
    { id: "mistral-large", contextWindow: 131072, input: ["text", "image"] }]);
  expect(last().path).toBe("/mistral/v1/models");
});

test("拒绝说明只给状态码：不带响应正文、密钥和地址；重定向不跟随，另一个地址收不到密钥", async () => {
  const denied = await refusal(listModels("openai-completions", `${base}/denied/v1`, { apiKey: "sk-fixture-private" }));
  expect(denied).toBeInstanceOf(ListError);
  expect(denied.message).toContain("HTTP 401");
  for (const leaked of ["sk-fixture", "127.0.0.1", "invalid key"]) expect(denied.message).not.toContain(leaked);
  expect((await refusal(listModels("openai-completions", `${base}/missing/v1`, {}))).message).toContain("没有模型列表接口（HTTP 404）");

  const before = seen.length;
  const moved = await refusal(listModels("openai-completions", `${base}/moved/v1`, { apiKey: "sk-fixture-private" }));
  expect(moved.message).toContain("重定向（HTTP 302）");
  expect(seen.slice(before).map(value => value.path)).toEqual(["/moved/v1/models"]);

  expect((await refusal(listModels("openai-completions", `${base}/html/v1`, {}))).message).toContain("不是 JSON");
  expect((await refusal(listModels("openai-completions", `${base}/shape/v1`, {}))).message).toContain("不是模型列表");
  expect((await refusal(listModels("openai-completions", `${base}/huge/v1`, {}))).message).toContain("超过 8 MiB");
  const closed = Bun.serve({ port: 0, fetch: () => new Response() }), port = closed.port; closed.stop(true);
  expect((await refusal(listModels("openai-completions", `http://127.0.0.1:${port}/v1`, {}))).message).toContain("无法连接模型端点");
});

test("翻页有上限：游标不再前进时停止，取消立即结束", async () => {
  expect(await listModels("anthropic-messages", `${base}/loop`, {})).toEqual([{ id: "loop-0" }, { id: "loop-same" }]);
  const controller = new AbortController(); controller.abort();
  expect((await refusal(listModels("openai-completions", `${base}/openai/v1`, {}, { signal: controller.signal }))).message).toContain("已取消");
});
