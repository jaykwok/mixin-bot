import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CodemodeSandbox, toCodemodeIdentifier } from "@earendil-works/pi-codemode";
import { mcpMemberTools, mcpToolNames } from "../../src/durable/mcp.ts";
import { spaceDoor } from "../../src/durable/models.ts";
import { McpTools, type McpCatalogueTool } from "../../src/integrations/mcp.ts";
import { tempFixture } from "../helpers/temp.ts";
import { scopeOf } from "../helpers/layout.ts";
import { appLayout } from "../../src/core/layout.ts";

test("MCP tools are named as pi-mcp names them; tools whose names come out alike both get the hash suffix, whatever the order", () => {
  const entry = (server: string, tool: string) => ({ server: { name: server, tools: [tool], transport: "http", url: "https://example.invalid/mcp" }, tool: { name: tool, inputSchema: {} } }) as McpCatalogueTool;
  const catalogue = [entry("docs", "search"), entry("docs", "get-page"), entry("docs", "get_page"), entry("my-files", "read.file"), entry("a", "b__c"), entry("a__b", "c"),
    entry("docs", "x".repeat(80))];
  const names = mcpToolNames(catalogue);
  expect(names.slice(0, 1)).toEqual(["mcp__docs__search"]);
  expect(names[3]).toBe("mcp__my_files__read_file");
  // `get-page` and `get_page`, and the two servers whose tools meet in one name: suffixed, and different.
  for (const at of [1, 2, 4, 5]) expect(names[at]).toMatch(/_[0-9a-f]{8}$/);
  expect(names[1]!.slice(0, -9)).toBe("mcp__docs__get_page");
  expect(names[4]!.slice(0, -9)).toBe("mcp__a__b__c");
  // A name longer than a provider takes is cut and suffixed.
  expect(names[6]).toHaveLength(64);
  expect(new Set(names).size).toBe(names.length);
  for (const name of names) expect(name).toMatch(/^[A-Za-z0-9_]{1,64}$/);
  // The names do not depend on the order the servers list their tools in.
  const reversed = mcpToolNames([...catalogue].reverse()).reverse();
  expect(reversed).toEqual(names);
});

test("two tools of one MCP server whose names normalize alike remain independently callable through the official sandbox", async () => {
  const f = await tempFixture("mcp-names-"), dispatched: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    const rpc = await request.json() as { id?: number; method: string; params?: { protocolVersion: string; name?: string } };
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (rpc.method === "initialize") result = { protocolVersion: rpc.params!.protocolVersion, serverInfo: { name: "docs", version: "1" }, capabilities: { tools: {} } };
    // One of them without `type` or `properties`, as servers may send it.
    else if (rpc.method === "tools/list") result = { tools: [{ name: "search-a", inputSchema: { type: "object", properties: {} } }, { name: "search_a", inputSchema: {} }] };
    else if (rpc.method === "tools/call") { dispatched.push(rpc.params!.name!); result = { content: [{ type: "text", text: rpc.params!.name }] }; }
    else throw new Error("unexpected RPC");
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
  } });
  const manager = new McpTools({ servers: [{ name: "docs", description: "产品文档库", transport: "http", tools: ["search-a", "search_a"], url: `http://127.0.0.1:${server.port}/mcp` }] },
    join(f.root, "discovery"));
  const door = spaceDoor({}), signal = new AbortController().signal;
  const member = { scope: scopeOf("group"), phone: "alice", workspaceDir: join(f.root, "workspace"), tempDir: join(f.root, "tmp") };
  let sandbox: CodemodeSandbox | undefined;
  try {
    await mkdir(member.workspaceDir); await mkdir(member.tempDir); await manager.initialize(signal);
    const adapters = mcpMemberTools({ layout: appLayout(f.root), scope: member.scope }, manager, door);
    expect(adapters.map(adapter => adapter.registration.name.slice(0, -9))).toEqual(["mcp__docs__search_a", "mcp__docs__search_a"]);
    // One namespace for the server's tools, with the administrator's description; every schema is an object schema.
    expect(adapters.map(adapter => adapter.namespace)).toEqual(Array(2).fill({ name: "mcp__docs", description: "产品文档库（管理员批准的外部工具）" }));
    expect(adapters.map(adapter => adapter.registration.parameters)).toEqual(Array(2).fill({ type: "object", properties: {} }));
    const tools = adapters.map((adapter, i) => ({ name: adapter.registration.name,
      execute: (args: unknown) => manager.call(manager.catalogue[i]!, member, args as Record<string, unknown>, signal, dispatch => dispatch()),
    }));
    sandbox = new CodemodeSandbox({ tools });
    const names = tools.map(tool => toCodemodeIdentifier(tool.name));
    const output = await sandbox.execute(`return [await tools.${names[0]}({}), await tools.${names[1]}({})];`);
    expect(output.ok).toBe(true);
    expect(dispatched).toEqual(["search-a", "search_a"]);
  } finally { await sandbox?.close(); await manager.close(); await door.close(); await server.stop(true); await f.cleanup(); }
}, 15000);
