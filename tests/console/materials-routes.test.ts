// The console's materials exclusion routes (console/server/materials-routes.ts) against the service's local control
// interface (src/server/http-app.ts /_admin/materials/*) with the real rules module behind it.
import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuditLog } from "../../console/server/audit.ts";
import { materialsRoutes } from "../../console/server/materials-routes.ts";
import type { RouteContext } from "../../console/server/routes.ts";
import type { MaterialExclusionsResponse, MaterialFoldersResponse } from "../../console/ui/src/contract.ts";
import { materialExclusions, materialFolders, parseExclusionRules, saveExclusionRules } from "../../src/agent/materials-exclusions.ts";
import { refreshMaterialsIndex } from "../../src/agent/materials-index.ts";
import { createApp } from "../../src/server/http-app.ts";
import { tempFixture } from "../helpers/temp.ts";

const context = (body?: unknown) => ({ body, signal: new AbortController().signal, session: { label: "s" } } as RouteContext);

test("排除规则经服务读写：页面读到规则和索引，逐层列出文件夹，保存后索引按新规则生成；审计只记条数", async () => {
  const f = await tempFixture("console-materials-");
  const workspaceDir = join(f.root, "workspace"), ignorePath = join(f.root, "data/config/materials-ignore.txt"), indexPath = join(f.root, "data/index/materials.md");
  for (const dir of ["workspace/产品资料", "workspace/归档/2023", "workspace/sync-tools", "data/config", "data/state"]) mkdirSync(join(f.root, dir), { recursive: true });
  for (const file of ["产品资料/介绍.pptx", "归档/2023/手册.pdf", "sync-tools/tool.exe"]) writeFileSync(join(workspaceDir, file), "x".repeat(100));
  const paths = { workspaceDir, ignorePath, indexPath };
  let built: Promise<unknown> = Promise.resolve();
  // Wired as the service wires it (src/server/app.ts).
  const service = createApp({ isStopping: () => false, adminToken: "materials-token", shutdown: () => {}, materials: {
    exclusions: () => materialExclusions(ignorePath, indexPath),
    save: async rules => { await saveExclusionRules(ignorePath, parseExclusionRules(rules)); built = refreshMaterialsIndex(paths, true); return materialExclusions(ignorePath, indexPath); },
    folders: path => materialFolders(workspaceDir, path),
  } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: service.fetch });
  try {
    const audit = join(f.root, "audit");
    const offline = materialsRoutes(f.root, new AuditLog(audit));
    await expect(offline["GET /api/materials/exclusions"]!.run(context())).rejects.toMatchObject({ status: 409, message: expect.stringContaining("服务可能没有运行") });
    writeFileSync(join(f.root, "data/state/instance.json"), JSON.stringify({ port: server.port, token: "materials-token", instanceId: "i", pid: 1, startedAt: 1 }));
    const routes = materialsRoutes(f.root, new AuditLog(audit));
    expect(await routes["GET /api/materials/exclusions"]!.run(context())).toEqual({ rules: [], index: null });
    // Folders one level at a time; a path outside the workspace is the service's refusal.
    expect(await routes["POST /api/materials/folders"]!.run(context({ path: "" })) as MaterialFoldersResponse).toMatchObject({ path: "", more: false });
    expect((await routes["POST /api/materials/folders"]!.run(context({ path: "归档" })) as MaterialFoldersResponse).folders).toEqual(["2023"]);
    await expect(routes["POST /api/materials/folders"]!.run(context({ path: "../x" }))).rejects.toMatchObject({ status: 409, message: "文件夹路径无效" });
    for (const body of [{ path: 1 }, { path: "a", extra: true }, {}]) await expect(routes["POST /api/materials/folders"]!.run(context(body))).rejects.toMatchObject({ status: 409 });
    // A save: malformed lists never reach the service; a rule it refuses comes back with the reason and nothing is written.
    for (const body of [{ rules: "归档" }, { rules: [1] }, { rules: ["a"], more: 1 }, { rules: Array(1001).fill("a") }]) {
      await expect(routes["POST /api/materials/exclusions"]!.run(context(body))).rejects.toMatchObject({ status: 409 });
    }
    await expect(routes["POST /api/materials/exclusions"]!.run(context({ rules: ["sync-tools", "归档/*"] }))).rejects
      .toMatchObject({ status: 409, message: "第 2 条「归档/*」：除开头的 **/ 外不支持通配符" });
    expect(() => readFileSync(ignorePath)).toThrow();
    const saved = await routes["POST /api/materials/exclusions"]!.run(context({ rules: ["sync-tools\\", "归档/2023"] })) as MaterialExclusionsResponse;
    expect(saved.rules).toEqual(["sync-tools", "归档/2023"]);
    expect(readFileSync(ignorePath, "utf8")).toEndWith("\n\nsync-tools\n归档/2023\n");
    // The index follows the save without a conversation.
    await built;
    const after = await routes["GET /api/materials/exclusions"]!.run(context()) as MaterialExclusionsResponse;
    expect(after.index).toMatchObject({ files: 1, bytes: 100, truncated: false });
    expect(after.index!.topLevel).toEqual([{ name: "产品资料/", files: 1, bytes: 100 }]);
    // The audit has the saves that reached the service's check, by count, without a folder name.
    const lines = readdirSync(audit).flatMap(name => readFileSync(join(audit, name), "utf8").trim().split("\n")).map(line => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map(line => [line.action, line.scope])).toEqual([["materials-exclusions", "rules:2"], ["materials-exclusions", "rules:2"]]);
    expect(JSON.stringify(lines)).not.toContain("归档");
    // A wrong token is the service's 404, told as such.
    writeFileSync(join(f.root, "data/state/instance.json"), JSON.stringify({ port: server.port, token: "other", instanceId: "i", pid: 1, startedAt: 1 }));
    await expect(materialsRoutes(f.root, new AuditLog(audit))["GET /api/materials/exclusions"]!.run(context())).rejects.toMatchObject({ message: expect.stringContaining("实例口令不符") });
    // An audit that cannot be written refuses the save before the service hears of it.
    writeFileSync(join(f.root, "data/state/instance.json"), JSON.stringify({ port: server.port, token: "materials-token", instanceId: "i", pid: 1, startedAt: 1 }));
    writeFileSync(join(f.root, "audit-file"), "");
    await expect(materialsRoutes(f.root, new AuditLog(join(f.root, "audit-file", "audit")))["POST /api/materials/exclusions"]!.run(context({ rules: [] })))
      .rejects.toMatchObject({ status: 503, code: "audit" });
    expect(readFileSync(ignorePath, "utf8")).toEndWith("sync-tools\n归档/2023\n");
  } finally { await server.stop(true); await f.cleanup(); }
});
