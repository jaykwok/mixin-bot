import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DeploymentDirectory, type DepartmentQuery } from "../../console/server/deployment-directory.ts";
import { ConfigurationDrafts } from "../../ops/core/configuration-drafts.ts";
import { directoryAppHash } from "../../ops/lib/directory-choice.ts";
import { deploymentEnvironment } from "../../ops/core/deployment-options.ts";
import { operationPreparer } from "../../console/server/prepare-operation.ts";
import { Views } from "../../console/server/views.ts";
import type { RouteContext } from "../../console/server/routes.ts";
import { tempFixture } from "../helpers/temp.ts";

const context = (body: unknown = {}, label = "one"): RouteContext => ({ body, session: { label } as RouteContext["session"], signal: new AbortController().signal });
interface Opened { view: string; children: { key: string; name: string }[] }
async function fixture() {
  const f = await tempFixture("deployment-directory-");
  mkdirSync(join(f.root, "data/config"), { recursive: true }); writeFileSync(join(f.root, "data/config/app-bot.json"), '{"secret":"synthetic-private"}');
  const calls: { action: string; ids: string[] }[] = [], state = { time: 1000, fail: false, incomplete: false, during: () => {} };
  const query: DepartmentQuery = async (action, ids) => {
    calls.push({ action, ids }); const appHash = directoryAppHash(f.root); state.during();
    if (state.fail) throw new Error("合成平台不可用");
    const departments = action === "children" ? [{ id: ids[0] === "1" ? "dept-root" : "dept-child", name: "研发部" }] : ids.map(id => ({ id, name: "已核对部门" }));
    return { appHash, departments: state.incomplete ? [] : departments };
  };
  const picker = new DeploymentDirectory(f.root, query, () => state.time), routes = picker.routes();
  const open = (label = "one") => routes["POST /api/lifecycle/directory/open"]!.run(context({}, label)) as Promise<Opened>;
  return { ...f, picker, routes, open, calls, state };
}

test("机器人停止时直接查部门；只接受当前登录的树键，预览重新核对且不写配置", async () => {
  const f = await fixture();
  try {
    const opened = await f.open(), key = opened.children[0]!.key;
    expect(JSON.stringify(opened)).not.toContain("dept-root"); expect(JSON.stringify(opened)).not.toContain("synthetic-private");
    expect(f.calls).toEqual([{ action: "children", ids: ["1"] }]);
    const children = await f.routes["POST /api/lifecycle/directory/children"]!.run(context({ view: opened.view, parent: key })) as { children: { key: string }[] };
    const prepare = operationPreparer(f.root, new Views(), undefined, undefined, undefined, undefined, undefined, f.picker);
    const input = { port: 2022, workspace: "", directory: { view: opened.view, selected: [children.children[0]!.key] } };
    const params = await prepare("deploy", input, "one");
    expect(params.directory).toEqual({ departments: ["dept-child"], names: ["已核对部门"], appHash: directoryAppHash(f.root) });
    expect(f.calls.at(-1)).toEqual({ action: "verify", ids: ["dept-child"] });
    const env = deploymentEnvironment("deploy", params, f.root);
    expect(env.MIXIN_OPS_DIRECTORY).toBe("selected"); expect(env.BOT_DIRECTORY_SCOPE).toBe("");
    expect(JSON.parse(env.MIXIN_OPS_DIRECTORY_INPUT!)).toEqual({ format: 1, departments: ["dept-child"] });
    expect(env.MIXIN_OPS_DIRECTORY_INPUT).not.toContain("已核对部门");
    await expect(prepare("deploy", params, "one")).rejects.toThrow("参数无效"); // Browser cannot bypass the tree with normalized task data.
    await expect(prepare("deploy", input, "two")).rejects.toThrow("过期");
    await expect(f.picker.prepare({ view: opened.view, selected: ["dept-root"] }, "one")).rejects.toThrow("手填");
    await expect(f.picker.prepare({ view: opened.view, selected: [key, key] }, "one")).rejects.toThrow("重复");
    await expect(f.picker.prepare({ view: opened.view, selected: [] }, "one")).rejects.toThrow("请选择");
    expect(existsSync(join(f.root, "data/config/directory.json"))).toBe(false);
    expect(existsSync(join(f.root, "data/state"))).toBe(false);
    expect(existsSync(join(f.root, ".console"))).toBe(false);
  } finally { await f.cleanup(); }
});

test("部署部门草稿拒绝过期、配置变化、平台拒绝和不完整核对", async () => {
  const f = await fixture();
  try {
    let opened = await f.open(); let input = { view: opened.view, selected: [opened.children[0]!.key] };
    f.state.fail = true; await expect(f.picker.prepare(input, "one")).rejects.toThrow("不可用"); f.state.fail = false;
    f.state.incomplete = true; await expect(f.picker.prepare(input, "one")).rejects.toThrow("不完整"); f.state.incomplete = false;
    f.state.time += 600_000; await expect(f.picker.prepare(input, "one")).rejects.toThrow("过期");
    opened = await f.open(); input = { view: opened.view, selected: [opened.children[0]!.key] };
    writeFileSync(join(f.root, "data/config/app-bot.json"), "{}"); await expect(f.picker.prepare(input, "one")).rejects.toThrow("已变化");
    opened = await f.open(); input = { view: opened.view, selected: [opened.children[0]!.key] };
    f.state.during = () => writeFileSync(join(f.root, "data/config/app-bot.json"), '{"updated":true}');
    await expect(f.picker.prepare(input, "one")).rejects.toThrow("已变化"); f.state.during = () => {};
    opened = await f.open(); f.picker.end("one");
    await expect(f.picker.prepare({ view: opened.view, selected: [opened.children[0]!.key] }, "one")).rejects.toThrow("过期");
    f.state.during = () => f.picker.end("one"); await expect(f.open()).rejects.toThrow("过期"); f.state.during = () => {};
    writeFileSync(join(f.root, "data/config/directory.json"), '{"format":1,"all":true}'); await expect(f.open()).rejects.toThrow("已有同步范围");
  } finally { await f.cleanup(); }
});

test("首次部署：部门树用在线校验过的应用草稿读取；草稿变化、未在线校验或已有部署时拒绝", async () => {
  const f = await tempFixture("deployment-directory-draft-");
  try {
    const drafts = new ConfigurationDrafts(f.root), seen: (string | undefined)[] = [];
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    const query: DepartmentQuery = async (action, ids, _signal, app) => {
      seen.push(app);
      return { appHash: hash(app ?? ""), departments: action === "children" ? [{ id: "dept-root", name: "研发部" }] : ids.map(id => ({ id, name: "已核对部门" })) };
    };
    const picker = new DeploymentDirectory(f.root, query, Date.now, drafts), routes = picker.routes();
    const open = (draft: string) => routes["POST /api/lifecycle/directory/open"]!.run(context({ draft })) as Promise<Opened>;
    const patch = { appId: "fixture", environment: "production", secret: { mode: "set", value: "synthetic-private" } };
    const draft = drafts.create("app", "one"), edited = drafts.edit(draft.id, "one", draft.revision, patch);
    const check = (network: boolean) => {
      const input = drafts.validationInput(draft.id, "one", edited.revision);
      drafts.validated(draft.id, "one", edited.revision, input.digest, ["通过"], undefined, network);
      return input.snapshot.files.app!;
    };
    check(false); await expect(open(draft.id)).rejects.toThrow("请先在线校验");
    const app = check(true), opened = await open(draft.id);
    expect(JSON.stringify(opened)).not.toContain("synthetic-private"); expect(seen).toEqual([app]);
    const choice = await picker.prepare({ view: opened.view, selected: [opened.children[0]!.key] }, "one");
    expect(choice).toEqual({ departments: ["dept-root"], names: ["已核对部门"], appHash: hash(app) });
    await expect(routes["POST /api/lifecycle/directory/open"]!.run(context({ draft: draft.id }, "two"))).rejects.toThrow();
    await expect(routes["POST /api/lifecycle/directory/open"]!.run(context({ draft: draft.id, extra: 1 }))).rejects.toThrow("参数无效");
    expect(existsSync(join(f.root, "data"))).toBe(false);
    // Edited after the tree was opened: the view no longer matches the draft.
    drafts.edit(draft.id, "one", edited.revision, { ...patch, appId: "fixture-two" });
    await expect(picker.prepare({ view: opened.view, selected: [opened.children[0]!.key] }, "one")).rejects.toThrow("请先在线校验");
    // An existing deployment keeps its installed configuration.
    mkdirSync(join(f.root, "data/state"), { recursive: true }); writeFileSync(join(f.root, "data/state/data-version.json"), "{}");
    await expect(open(draft.id)).rejects.toThrow("只用于首次部署");
  } finally { await f.cleanup(); }
});

async function savedFixture() {
  const f = await tempFixture("setup-directory-saved-");
  const state = { time: 1_000_000, fail: false, incomplete: false, during: async () => {} }, calls: string[] = [];
  const drafts = new ConfigurationDrafts(f.root, () => state.time);
  const checked = (session = "one", appId = "fixture", secret = "synthetic-private", environment = "production") => {
    const created = drafts.create("app", session), edited = drafts.edit(created.id, session, created.revision,
      { appId, environment, secret: { mode: "set", value: secret } });
    const input = drafts.validationInput(created.id, session, edited.revision);
    drafts.validated(created.id, session, edited.revision, input.digest, ["通过"], undefined, true);
    return created.id;
  };
  const query: DepartmentQuery = async (action, ids, _signal, app) => {
    calls.push(action); await state.during();
    if (state.fail) throw new Error("平台暂不可用");
    return { appHash: createHash("sha256").update(app ?? "").digest("hex"), departments: state.incomplete ? [] :
      action === "children" ? [{ id: "dept-root", name: "研发部" }] : ids.map(id => ({ id, name: "研发部最新名称" })) };
  };
  const picker = new DeploymentDirectory(f.root, query, () => state.time, drafts), routes = picker.routes();
  const call = (action: string, body: unknown, session = "one") => routes[`POST /api/setup/directory/${action}`]!.run(context(body, session)) as Promise<{ scope: { saved: string; mode: string; count: number } | null }>;
  const choose = async (draft: string) => {
    const opened = await routes["POST /api/lifecycle/directory/open"]!.run(context({ draft })) as Opened;
    return { view: opened.view, selected: [opened.children[0]!.key] };
  };
  return { ...f, state, drafts, checked, picker, query, call, choose, calls };
}

test("首次部署范围独立保存：草稿超时、退出登录和重启后按同一应用恢复，部署前重新核对且保存不写正式配置", async () => {
  const f = await savedFixture();
  try {
    const draft = f.checked(), chosen = await f.choose(draft), saved = (await f.call("save", { draft, directory: chosen })).scope!;
    expect(saved).toMatchObject({ mode: "departments", count: 1 });
    expect(existsSync(join(f.root, "data"))).toBe(false);
    const persisted = readFileSync(join(f.root, ".console/setup-directory.json"), "utf8");
    expect(persisted).not.toContain("synthetic-private"); expect(persisted).not.toContain(draft);
    f.state.time += 31 * 60_000;
    await expect(f.call("read", { draft })).rejects.toThrow("过期");
    f.picker.end("one"); f.drafts.end("one");
    const next = f.checked("two", "fixture", "rotated-secret"), restarted = new DeploymentDirectory(f.root, f.query, () => f.state.time, f.drafts);
    const restored = await restarted.routes()["POST /api/setup/directory/read"]!.run(context({ draft: next }, "two"));
    expect(restored).toEqual({ scope: saved });
    const opened = await restarted.routes()["POST /api/lifecycle/directory/open"]!.run(context({ draft: next }, "two")) as Opened & { selected: { key: string; name: string }[] };
    expect(opened.selected).toHaveLength(1); expect(opened.selected[0]!.key).toBe(opened.children[0]!.key);
    expect(opened.selected[0]!.key).not.toBe(chosen.selected[0]);
    const choice = await restarted.prepareSaved({ saved: saved.saved }, "two", next);
    expect(choice).toMatchObject({ departments: ["dept-root"], names: ["研发部最新名称"],
      appHash: createHash("sha256").update(f.drafts.appText(next, "two")).digest("hex") });
    expect(f.calls.at(-1)).toBe("verify");
    expect(existsSync(join(f.root, "data"))).toBe(false);
  } finally { await f.cleanup(); }
});

test("首次部署范围按应用和环境隔离；整个通讯录可独立保存，其他登录不能借用草稿或部门键", async () => {
  const f = await savedFixture();
  try {
    const draft = f.checked(), choice = await f.choose(draft);
    await expect(f.call("save", { draft, directory: choice }, "two")).rejects.toThrow();
    await expect(f.call("save", { draft, directory: { ...choice, selected: ["dept-root"] } })).rejects.toThrow("手填");
    const saved = (await f.call("save", { draft, directory: "all" })).scope!;
    expect(await f.picker.prepareSaved({ saved: saved.saved }, "one", draft)).toBe("all");
    const other = f.checked("other", "another-app"), testing = f.checked("testing", "fixture", "synthetic-private", "staging");
    expect(await f.call("read", { draft: other }, "other")).toEqual({ scope: null });
    expect(await f.call("read", { draft: testing }, "testing")).toEqual({ scope: null });
    await expect(f.picker.prepareSaved({ saved: saved.saved }, "other", other)).rejects.toThrow("已变化");
    await expect(f.call("save", { draft: other, directory: choice }, "other")).rejects.toThrow();
    expect(await f.call("read", { draft })).toEqual({ scope: saved });
    mkdirSync(join(f.root, "data/state"), { recursive: true }); writeFileSync(join(f.root, "data/state/data-version.json"), "{}");
    await expect(f.call("save", { draft, directory: "all" })).rejects.toThrow("只用于首次部署");
  } finally { await f.cleanup(); }
});

test("已保存范围的在线核对失败或不完整时保留草稿，预览期间另存范围时拒绝旧引用", async () => {
  const f = await savedFixture();
  try {
    const draft = f.checked(), chosen = await f.choose(draft), saved = (await f.call("save", { draft, directory: chosen })).scope!;
    const before = readFileSync(join(f.root, ".console/setup-directory.json"), "utf8");
    f.state.fail = true;
    await expect(f.picker.prepareSaved({ saved: saved.saved }, "one", draft)).rejects.toThrow("不可用");
    await expect(f.call("save", { draft, directory: chosen })).rejects.toThrow("不可用");
    f.state.fail = false; f.state.incomplete = true;
    await expect(f.picker.prepareSaved({ saved: saved.saved }, "one", draft)).rejects.toThrow("不完整");
    expect(readFileSync(join(f.root, ".console/setup-directory.json"), "utf8")).toBe(before);
    f.state.incomplete = false;
    f.state.during = async () => { await f.call("save", { draft, directory: "all" }); };
    await expect(f.picker.prepareSaved({ saved: saved.saved }, "one", draft)).rejects.toThrow("已变化");
    expect((await f.call("read", { draft })).scope!.mode).toBe("all");
  } finally { await f.cleanup(); }
});
