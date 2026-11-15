import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { consoleDir, writeAtomic } from "../../ops/core/console-state.ts";
import { applicationBinding } from "../../src/core/data-version.ts";
import { directoryAppHash, type DirectoryChoice } from "../../ops/lib/directory-choice.ts";
import { parseScopeDepartments, readDirectoryScope, MAX_SCOPE_DEPARTMENTS, ROOT_DEPARTMENT } from "../../src/integrations/open-platform/directory-scope.ts";
import { readConfigurationState } from "../../src/core/configuration-state.ts";
import { loadPendingTransaction } from "../../ops/core/pending-transaction.ts";
import type { ConfigurationDrafts } from "../../ops/core/configuration-drafts.ts";
import { textParam } from "../../ops/core/operations.ts";
import { undeployed } from "./recovery.ts";
import { runtimeQuery } from "./runtime-query.ts";
import { ApiProblem, type Route } from "./routes.ts";
import type { AuditLog } from "./audit.ts";

type Department = { id: string; name: string };
/** `app`: before the first deployment, the checked application draft that stands in for data/config/app-bot.json. */
export type DepartmentQuery = (action: "children" | "verify", ids: string[], signal?: AbortSignal, app?: string) => Promise<{ appHash: string; departments: Department[] }>;
/** draft: a first deployment's application draft, whose text the tree is read with instead of the installed configuration. */
interface Selection { session: string; expires: number; appHash: string; draft?: string; codes: Map<string, string>; ids: Map<string, string> }
interface SavedScope { format: 1; application: string; mode: "all" | "departments"; departments: Department[] }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value: unknown, fields: string[]) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) throw new Error("部门选择参数无效");
  return value as Record<string, unknown>;
};

export function departmentQuery(project: string): DepartmentQuery {
  return async (action, ids, signal, app) => {
    const result = await runtimeQuery(project, "directory-query", action, app === undefined ? { ids } : { ids, app }, signal);
    if (result.code !== 0 || result.timedOut) throw new Error("部门查询未完成，请检查应用权限、网络和运行环境");
    try {
      const value = JSON.parse(result.stdout);
      if (value?.protocol !== "mixin-directory-query" || value.version !== 1 || typeof value.appHash !== "string" || !/^[a-f0-9]{64}$/.test(value.appHash)) throw new Error();
      return { appHash: value.appHash, departments: checkedDepartments(value.departments) };
    } catch { throw new Error("部门查询结果无效"); }
  };
}
function checkedDepartments(value: unknown): Department[] {
  if (!Array.isArray(value) || value.length > 10000) throw new Error("部门列表过大或无效");
  const ids = new Set<string>();
  return value.map(item => {
    const raw = object(item, ["id", "name"]);
    if (typeof raw.id !== "string" || !/^[0-9A-Za-z_-]{1,64}$/.test(raw.id) || raw.id === ROOT_DEPARTMENT || ids.has(raw.id)
      || typeof raw.name !== "string" || raw.name.length > 1024 || /[\x00-\x1f\x7f]/.test(raw.name)) throw new Error("部门详情无效");
    ids.add(raw.id); return { id: raw.id, name: raw.name };
  });
}

/** Browser trees are session-local; a first deployment can separately save its scope under the application's identity. */
export class DeploymentDirectory {
  private readonly views = new Map<string, Selection>();
  constructor(readonly project: string, readonly query: DepartmentQuery = departmentQuery(project), readonly now = Date.now,
    readonly drafts?: Pick<ConfigurationDrafts, "appText">, readonly audit?: Pick<AuditLog, "write">) {}
  end(session: string) { for (const [key, view] of this.views) if (view.session === session) this.views.delete(key); }
  /** The application the tree is read with: the installed one, or before the first deployment a checked application draft. */
  private base(session: string, draft?: string): { appHash: string; app?: string } {
    if (loadPendingTransaction(this.project) || readConfigurationState(this.project)) throw new Error("请先处理未完成的维护事务");
    if (draft !== undefined) {
      if (!this.drafts || !undeployed(this.project)) throw new Error("应用草稿只用于首次部署；已有部署请使用通讯录设置");
      const app = this.drafts.appText(draft, session);
      return { appHash: createHash("sha256").update(app).digest("hex"), app };
    }
    if (readDirectoryScope(join(this.project, "data/config/directory.json"))) throw new Error("已有同步范围，请沿用保存值；修改范围请使用通讯录设置");
    return { appHash: directoryAppHash(this.project) };
  }
  private view(session: string, key: unknown): { view: Selection; app?: string } {
    const at = this.now(); for (const [id, value] of this.views) if (value.expires <= at) this.views.delete(id);
    const value = typeof key === "string" ? this.views.get(key) : undefined;
    if (!value || value.session !== session) throw new Error("部门列表已过期，请重新打开");
    const base = this.base(session, value.draft);
    if (base.appHash !== value.appHash) throw new Error("应用配置已变化，请重新读取部门树");
    return { view: value, app: base.app };
  }
  private display(view: Selection, items: Department[]) {
    return items.map(item => {
      let key = view.ids.get(item.id);
      if (!key) {
        if (view.ids.size >= 10000) throw new Error("部门树过大，请重新打开并缩小范围");
        key = randomUUID(); view.ids.set(item.id, key); view.codes.set(key, item.id);
      }
      return { key, name: item.name };
    });
  }
  private async read(session: string, key: string, action: "children" | "verify", ids: string[], signal?: AbortSignal) {
    const { view, app } = this.view(session, key), result = await this.query(action, ids, signal, app);
    signal?.throwIfAborted();
    if (this.view(session, key).view !== view || result.appHash !== view.appHash) throw new Error("应用配置或登录已变化，请重新打开部门树");
    return checkedDepartments(result.departments);
  }
  private saved(application: string): SavedScope | null {
    const path = join(consoleDir(this.project), "setup-directory.json");
    let text: string;
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) throw new Error("已保存的通讯录范围不是有效文件");
      text = readFileSync(path, "utf8");
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const raw = object(JSON.parse(text), ["format", "application", "mode", "departments"]);
    if (raw.format !== 1 || typeof raw.application !== "string" || !/^[a-f0-9]{64}$/.test(raw.application) || !["all", "departments"].includes(String(raw.mode))) throw new Error("已保存的通讯录范围无效，请重新保存");
    const departments = checkedDepartments(raw.departments);
    if (raw.mode === "all" ? departments.length !== 0 : !departments.length || departments.length > MAX_SCOPE_DEPARTMENTS) throw new Error("已保存的通讯录范围无效，请重新保存");
    return raw.application === application ? { format: 1, application, mode: raw.mode as SavedScope["mode"], departments } : null;
  }
  private initial(session: string, draft: string) {
    const base = this.base(session, draft);
    if (!base.app) throw new Error("请先在线校验应用机器人凭据");
    return { ...base, app: base.app, application: applicationBinding(JSON.parse(base.app)) };
  }
  private summary(saved: SavedScope) { return { saved: digest(saved), mode: saved.mode, count: saved.departments.length }; }
  /** Saved scopes outlive sessions and configuration drafts. A fresh application draft and platform check are still required. */
  async prepareSaved(input: unknown, session: string, draft: string): Promise<DirectoryChoice | "all"> {
    const params = object(input, ["saved"]), base = this.initial(session, draft), saved = this.saved(base.application);
    if (!saved || params.saved !== digest(saved)) throw new Error("已保存的通讯录范围已变化，请重新读取");
    if (saved.mode === "all") return "all";
    const ids = saved.departments.map(item => item.id), result = await this.query("verify", ids, undefined, base.app);
    if (this.initial(session, draft).appHash !== base.appHash || result.appHash !== base.appHash || digest(this.saved(base.application)) !== params.saved) throw new Error("应用配置或已保存范围已变化，请重新读取");
    const checked = checkedDepartments(result.departments), names = new Map(checked.map(item => [item.id, item.name]));
    if (checked.length !== ids.length || ids.some(id => !names.has(id))) throw new Error("部门核对不完整，请修改已保存的范围");
    return { departments: ids, names: ids.map(id => names.get(id)!), appHash: base.appHash };
  }
  async prepare(input: unknown, session: string): Promise<DirectoryChoice> {
    const params = object(input, ["view", "selected"]), { view } = this.view(session, params.view);
    if (!Array.isArray(params.selected) || !params.selected.length || params.selected.length > MAX_SCOPE_DEPARTMENTS) throw new Error(`请选择 1 至 ${MAX_SCOPE_DEPARTMENTS} 个部门`);
    const ids = parseScopeDepartments(params.selected.map(key => {
      const id = typeof key === "string" ? view.codes.get(key) : undefined;
      if (!id) throw new Error("请从部门树中选择，不接受手填 ID"); return id;
    }));
    const checked = await this.read(session, String(params.view), "verify", ids);
    const names = new Map(checked.map(item => [item.id, item.name]));
    if (checked.length !== ids.length || ids.some(id => !names.has(id))) throw new Error("部门核对不完整，请重新选择");
    return { departments: ids, names: ids.map(id => names.get(id)!), appHash: view.appHash };
  }
  routes(): Record<string, Route> {
    const wrap = (run: Route["run"]): Route => ({ slow: true, run: async context => {
      try { return await run(context); } catch (error) { throw new ApiProblem(409, "input", error instanceof Error ? error.message : "部门查询失败"); }
    } });
    return {
      "POST /api/setup/directory/read": wrap(async ({ body, session }) => {
        const { draft } = object(body, ["draft"]), base = this.initial(session.label, textParam(draft)), saved = this.saved(base.application);
        return { scope: saved ? this.summary(saved) : null };
      }),
      "POST /api/setup/directory/save": wrap(async ({ body, session, signal }) => {
        const params = object(body, ["draft", "directory"]), draft = textParam(params.draft), base = this.initial(session.label, draft);
        let departments: Department[] = [];
        if (params.directory !== "all") {
          const chosen = object(params.directory, ["view", "selected"]);
          if (this.view(session.label, chosen.view).view.draft !== draft) throw new Error("请使用当前应用草稿的部门树");
          const choice = await this.prepare(chosen, session.label);
          departments = choice.departments.map((id, i) => ({ id, name: choice.names[i]! }));
        }
        signal.throwIfAborted();
        if (this.initial(session.label, draft).appHash !== base.appHash) throw new Error("应用配置已变化，请重新选择");
        const saved: SavedScope = { format: 1, application: base.application, mode: params.directory === "all" ? "all" : "departments", departments };
        if (Buffer.byteLength(JSON.stringify(saved)) > 64 * 1024) throw new Error("部门选择过大，请缩小范围");
        this.audit?.write({ action: "setup-directory-save", session: session.label, scope: `${saved.mode}:${departments.length}`, mode: "default" });
        writeAtomic(join(consoleDir(this.project), "setup-directory.json"), JSON.stringify(saved) + "\n");
        return { scope: this.summary(saved) };
      }),
      "POST /api/lifecycle/directory/open": wrap(async ({ body, session, signal }) => {
        // A first deployment reads the tree with its application draft; otherwise with the installed configuration.
        const draft = body && typeof body === "object" && "draft" in body ? textParam(object(body, ["draft"]).draft) : (object(body, []), undefined);
        const { appHash } = this.base(session.label, draft), at = this.now();
        for (const [id, value] of this.views) if (value.expires <= at) this.views.delete(id);
        const prior = [...this.views].filter(([, value]) => value.session === session.label);
        while (prior.length >= 8) this.views.delete(prior.shift()![0]);
        const key = randomUUID(), view: Selection = { session: session.label, expires: at + 600_000, appHash, ...draft === undefined ? {} : { draft }, codes: new Map(), ids: new Map() };
        this.views.set(key, view);
        try {
          const children = this.display(view, await this.read(session.label, key, "children", [ROOT_DEPARTMENT], signal));
          const saved = draft === undefined ? null : this.saved(this.initial(session.label, draft).application);
          return { view: key, children, ...(draft === undefined ? {} : { selected: this.display(view, saved?.departments ?? []) }) };
        }
        catch (error) { this.views.delete(key); throw error; }
      }),
      "POST /api/lifecycle/directory/children": wrap(async ({ body, session, signal }) => {
        const params = object(body, ["view", "parent"]), { view } = this.view(session.label, params.view);
        const id = typeof params.parent === "string" ? view.codes.get(params.parent) : undefined;
        if (!id) throw new Error("请从部门树中选择，不接受手填 ID");
        return { children: this.display(view, await this.read(session.label, String(params.view), "children", [id], signal)) };
      }),
    };
  }
}
