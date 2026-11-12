// The administrator's MCP tools as member tools, named and shaped the way pi-mcp names and shapes them for models and code
// mode scripts: `mcp__<server>__<tool>` in the namespace `mcp__<server>`, object input schemas, and model-facing text cut
// in the middle beyond pi-mcp's limit with the full text saved among the member's results.
import { mkdir } from "node:fs/promises";
import { createMcpToolName, limitMcpContent, mcpNamespace, normalizeMcpInputSchema, toLlmContent } from "@earendil-works/pi-mcp";
import type { McpCatalogueTool, McpTools } from "../integrations/mcp.ts";
import type { RequestDoor } from "./door.ts";
import { memberTool, type BaseToolsOptions, type MemberTool } from "./tools.ts";
import { ResultFiles, resultsDirName } from "./results/files.ts";
import { resultRegistration } from "./results/ownership.ts";

const IMAGES_MAX = 4;

/**
 * The model-facing name of each catalogue tool. Two tools whose names come out alike (`a-b` and `a_b` of one server) both
 * get pi-mcp's hash suffix, so a name does not depend on the order the server lists its tools in.
 */
export function mcpToolNames(catalogue: readonly McpCatalogueTool[]): string[] {
  const plain = catalogue.map(entry => createMcpToolName(entry.server.name, entry.tool.name));
  const shared = new Set(plain.filter((name, at) => plain.indexOf(name) !== at));
  return catalogue.map((entry, at) => shared.has(plain[at]!) ? createMcpToolName(entry.server.name, entry.tool.name, () => true) : plain[at]!);
}

export function mcpMemberTools(options: BaseToolsOptions, manager: McpTools, door: RequestDoor): MemberTool[] {
  const names = mcpToolNames(manager.catalogue);
  return manager.catalogue.map((entry, at) => {
    const approved = "管理员批准的外部工具";
    return memberTool({
      name: names[at]!, description: entry.tool.description ?? `Call ${entry.tool.name} on ${entry.server.name}.`,
      parameters: normalizeMcpInputSchema(entry.tool.inputSchema),
      ...(entry.tool.outputSchema ? { structuredOutputSchema: entry.tool.outputSchema } : {}),
      namespace: { name: mcpNamespace(entry.server.name), description: entry.server.description ? `${entry.server.description}（${approved}）` : approved },
      callers: ["tools"], deferred: true,
      async run(args, { phone, places }, call) {
        if (!call.signal) throw new Error("MCP 工具需要可取消的任务");
        await mkdir(places.tempDir, { recursive: true });
        const result = await manager.call(entry, { scope: options.scope, phone, workspaceDir: places.workspaceDir, tempDir: places.requestDir ?? places.tempDir },
          args as Record<string, unknown>, call.signal, (dispatch, signal) => door.external(call.api, call.context, dispatch, signal));
        call.signal.throwIfAborted();
        const content = toLlmContent(result);
        const directoryName = resultsDirName(call.api.taskId as number, `mcp-${call.callId}`);
        const files = new ResultFiles(places.tempDir, directoryName, resultRegistration(call.api, call.context, phone, directoryName));
        try {
          // Images stay in the answer and are saved as well, so a later step can send or open them by path.
          const saved: string[] = [];
          for (const item of content) if (item.type === "image") {
            if (saved.length >= IMAGES_MAX) throw new Error("MCP 返回图片超限");
            saved.push(await files.saveOutputImage(saved.length + 1, Buffer.from(item.data, "base64"), item.mimeType));
          }
          const limited = await limitMcpContent(content, data => files.saveOutputText(typeof data === "string" ? data : Buffer.from(data).toString("utf8")));
          if ((await files.recheck()).size) throw new Error("MCP 结果目录变化，结果路径已撤回");
          return { output: [...limited.content, ...saved.map(path => ({ type: "text" as const, text: `Image saved to ${path}` }))],
            details: { server: entry.server.name, tool: entry.tool.name },
            ...(result.structuredContent !== undefined ? { structuredOutput: result.structuredContent } : {}), ...(result.isError ? { isError: true } : {}) };
        } finally { await files.release(); }
      },
    }, options);
  });
}
