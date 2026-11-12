// 资料索引的排除规则：经运行中服务的本机控制接口（src/server/http-app.ts 的 /_admin/materials/*）读写，规则由服务校验并写入
// data/config/materials-ignore.txt，下一次索引随即按新规则生成，不需要停机。选文件夹时逐层列出共享资料里的文件夹名（只有名字，
// 不含文件）。服务没有运行时页面只提示：规则文件也可以手工编辑。
import { join } from "node:path";
import { adminPost } from "../../ops/tools/directory-admin.ts";
import { fields } from "../../ops/core/operations.ts";
import type { MaterialExclusionsResponse, MaterialFoldersResponse } from "../ui/src/contract.ts";
import type { AuditLog } from "./audit.ts";
import { ApiProblem, problemOf, type Route } from "./routes.ts";

const REQUEST_MS = 15_000;
/** Bounds of a request before the service checks the rules themselves (it allows fewer and shorter). */
const RULES_MAX = 1000, RULE_CHARS = 1000, PATH_CHARS = 4096;

export interface MaterialsSource {
  read(signal?: AbortSignal): Promise<MaterialExclusionsResponse>;
  save(rules: string[]): Promise<MaterialExclusionsResponse>;
  folders(path: string, signal?: AbortSignal): Promise<MaterialFoldersResponse>;
}

const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** The service's answer as the page gets it: only the fields the page shows. */
function exclusions(reply: Record<string, unknown>): MaterialExclusionsResponse {
  const raw = reply.index && typeof reply.index === "object" ? reply.index as Record<string, unknown> : null;
  const top = raw && Array.isArray(raw.topLevel) ? raw.topLevel as Record<string, unknown>[] : [];
  return {
    rules: Array.isArray(reply.rules) ? reply.rules.filter((rule): rule is string => typeof rule === "string") : [],
    index: raw ? { files: count(raw.files), bytes: count(raw.bytes), generatedAt: count(raw.generatedAt), truncated: raw.truncated === true, limit: count(raw.limit),
      topLevel: top.filter(item => typeof item?.name === "string").map(item => ({ name: item.name as string, files: count(item.files), bytes: count(item.bytes) })) } : null,
  };
}

/** 默认经本机控制接口；测试换成假的。 */
export function serviceMaterials(file: string): MaterialsSource {
  const post = async (path: string, body: unknown, signal?: AbortSignal) => {
    const { status, body: reply } = await adminPost(path, body, undefined, file, REQUEST_MS, signal);
    if (status !== 200) throw new Error(typeof reply.message === "string" ? reply.message : `服务拒绝了请求（HTTP ${status}）`);
    return reply;
  };
  return {
    read: async signal => exclusions(await post("/_admin/materials/exclusions", {}, signal)),
    save: async rules => exclusions(await post("/_admin/materials/exclusions/save", { rules })),
    folders: async (path, signal) => {
      const reply = await post("/_admin/materials/folders", { path }, signal);
      return { path, more: reply.more === true, folders: Array.isArray(reply.folders) ? reply.folders.filter((name): name is string => typeof name === "string") : [] };
    },
  };
}

export function materialsRoutes(project: string, audit: AuditLog, source = serviceMaterials(join(project, "data/state/instance.json"))): Record<string, Route> {
  const wrap = (run: Route["run"]): Route => ({ slow: true, run: async context => {
    try { return await run(context); } catch (error) {
      const problem = problemOf(error);
      if (problem instanceof ApiProblem) throw problem;
      throw new ApiProblem(409, "input", error instanceof Error ? error.message : "请求未完成");
    }
  } });
  return {
    "GET /api/materials/exclusions": wrap(({ signal }) => source.read(signal)),
    "POST /api/materials/folders": wrap(({ body, signal }) => {
      const params = body as Record<string, unknown>; fields(params, ["path"]);
      if (typeof params.path !== "string" || params.path.length > PATH_CHARS) throw new Error("文件夹路径无效");
      return source.folders(params.path, signal);
    }),
    "POST /api/materials/exclusions": wrap(async ({ session, body }) => {
      const params = body as Record<string, unknown>; fields(params, ["rules"]);
      const rules = params.rules;
      if (!Array.isArray(rules) || rules.length > RULES_MAX || rules.some(rule => typeof rule !== "string" || rule.length > RULE_CHARS)) throw new Error("规则无效");
      // The count only: folder names may name customers or projects.
      audit.write({ action: "materials-exclusions", session: session.label, scope: `rules:${rules.length}`, mode: "default" });
      return source.save(rules as string[]);
    }),
  };
}
