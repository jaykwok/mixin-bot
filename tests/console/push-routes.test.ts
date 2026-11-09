import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuditLog } from "../../console/server/audit.ts";
import { Auth } from "../../console/server/auth.ts";
import type { Bundle } from "../../console/server/bundle.ts";
import { guardConfig } from "../../console/server/guard.ts";
import { type PushSettingsSource, PushRoutes } from "../../console/server/push-routes.ts";
import type { RouteContext } from "../../console/server/routes.ts";
import { createHandler } from "../../console/server/server.ts";
import type { Overview } from "../../console/ui/src/contract.ts";
import { parseRoles, type PushAdmin, PushSettingsRefused } from "../../src/push/service.ts";
import { ROLE_LIMITS } from "../../src/push/role-limits.ts";
import { createApp } from "../../src/server/http-app.ts";
import { tempFixture } from "../helpers/temp.ts";

type Role = Awaited<ReturnType<PushSettingsSource["read"]>>["roles"][number];
type Shown = { view: string; departments: { key: string; path: string; gone?: true }[]; roles: { key: string; name: string | null; phone: string; admin: boolean;
  pusher: boolean; dailyLimit: number | null; grants: { all: boolean; group: boolean; department: "none" | "any" | string[] }; updatedAt: number }[] };
const DEPARTMENTS = [{ id: "10", path: "技术部" }, { id: "11", path: "技术部/研发组" }];

function source(initial: Role[], departments = DEPARTMENTS) {
  let roles = initial;
  const saved: unknown[][] = [];
  const settings: PushSettingsSource = {
    read: async () => ({ roles, departments }),
    save: async next => {
      saved.push(next);
      roles = (next as Role[]).map(role => ({ ...role, name: role.phone === "13900000003" ? "王五" : "张三", updatedAt: 2 }));
      return { roles, departments };
    },
  };
  return { settings, saved };
}

test("推送设置只给页面姓名、打码号码、部门路径和随机键；保存按键找回号码、部门和群授权，新加的人用完整号码，名单按登录隔离", async () => {
  const f = await tempFixture("console-push-settings-");
  try {
    const fake = source([{ phone: "13800000001", name: "张三", admin: true, pusher: true, grants: { department: { departments: ["10", "99"] }, group: true }, dailyLimit: 5,
      updatedAt: 1 }]);
    const pushes = new PushRoutes(f.root, new AuditLog(join(f.root, "audit")), fake.settings);
    const routes = pushes.routes();
    const context = (body?: unknown, session = "s") => ({ body, signal: new AbortController().signal, session: { label: session } } as RouteContext);
    const shown = await routes["GET /api/push/settings"]!.run(context()) as Shown;
    expect(JSON.stringify(shown)).not.toContain("13800000001");
    expect(JSON.stringify(shown)).not.toContain('"id"');
    // A granted department no longer synced keeps a key, so saving keeps it.
    expect(shown.departments.map(department => [department.path, department.gone ?? false])).toEqual([["技术部", false], ["技术部/研发组", false], ["已不在同步范围的部门", true]]);
    const [tech, team, gone] = shown.departments.map(department => department.key);
    expect(shown.roles).toEqual([{ key: expect.any(String), name: "张三", phone: expect.stringContaining("*"), admin: true, pusher: true, dailyLimit: 5,
      grants: { all: false, group: true, department: [tech, gone] }, updatedAt: 1 }]);
    const key = shown.roles[0]!.key;
    // Grants name departments by this list's keys only, and at least one when chosen one by one.
    for (const [grants, reason] of [[{ department: ["nope"] }, "部门已过期"], [{ department: [] }, "至少选一个部门"], [{ department: "some" }, "部门授权无效"],
      [{ all: "yes" }, "全员授权无效"], [{ group: "yes" }, "群授权无效"], [{ groups: true }, "未允许的参数"]] as const) {
      await expect(routes["POST /api/push/settings"]!.run(context({ view: shown.view, roles: [{ key, admin: true, pusher: true, grants }] }))).rejects.toThrow(reason);
    }
    // Another login cannot use this list; an unknown field or a row without a person is refused before anything is saved.
    await expect(routes["POST /api/push/settings"]!.run(context({ view: shown.view, roles: [] }, "other"))).rejects.toThrow("过期");
    await expect(routes["POST /api/push/settings"]!.run(context({ view: shown.view, roles: [{ key, name: "张三" }] }))).rejects.toThrow("未允许的参数");
    await expect(routes["POST /api/push/settings"]!.run(context({ view: shown.view, roles: [{ admin: true }] }))).rejects.toThrow("第 1 项");
    expect(fake.saved).toEqual([]);
    const after = await routes["POST /api/push/settings"]!.run(context({ view: shown.view, roles: [
      { key, admin: false, pusher: true, dailyLimit: null, grants: { all: true, department: [team, gone, team] } },
      { phone: "139 0000-0003", admin: true, pusher: false }] })) as Shown;
    expect(fake.saved).toEqual([[
      { phone: "13800000001", admin: false, pusher: true, grants: { all: true, group: true, department: { departments: ["11", "99"] } }, dailyLimit: null },
      { phone: "13900000003", admin: true, pusher: false, grants: {}, dailyLimit: null }]]);
    expect(after.roles[0]!.grants).toEqual({ all: true, group: true, department: [after.departments[1]!.key, after.departments[2]!.key] });
    expect(after.view).not.toBe(shown.view);
    expect(after.roles.map(role => role.name)).toEqual(["张三", "王五"]);
    // A saved list's keys are spent; the new list's keys are fresh.
    await expect(routes["POST /api/push/settings"]!.run(context({ view: shown.view, roles: [] }))).rejects.toThrow("过期");
    expect(after.roles.map(role => role.key)).not.toContain(key);
    const audit = readdirSync(join(f.root, "audit")).map(name => readFileSync(join(f.root, "audit", name), "utf8")).join("");
    expect(audit).toContain('"action":"push-settings"'); expect(audit).toContain('"scope":"pushers:1,admins:1,granted:1"');
    expect(audit).not.toContain("13900000003");
    await routes["POST /api/push/settings"]!.run(context({ view: after.view, roles: [{ key: after.roles[0]!.key, admin: false, pusher: true },
      { phone: "13900000004", admin: false, pusher: true, grants: { all: false, department: "any" } }] }));
    expect(fake.saved[1]).toEqual([
      { phone: "13800000001", admin: false, pusher: true, grants: { all: true, group: true, department: { departments: ["11", "99"] } }, dailyLimit: null },
      { phone: "13900000004", admin: false, pusher: true, grants: { department: { any: true } }, dailyLimit: null }]);
    // The page's group grant replaces the one kept: off for the first, on for the new one.
    const third = await routes["GET /api/push/settings"]!.run(context()) as Shown;
    await routes["POST /api/push/settings"]!.run(context({ view: third.view, roles: [
      { key: third.roles[0]!.key, admin: false, pusher: true, grants: { all: false, group: false, department: "none" } },
      { key: third.roles[1]!.key, admin: false, pusher: true, grants: { all: false, group: true, department: "none" } }] }));
    expect(fake.saved[2]).toEqual([{ phone: "13800000001", admin: false, pusher: true, grants: {}, dailyLimit: null },
      { phone: "13900000004", admin: false, pusher: true, grants: { group: true }, dailyLimit: null }]);
    // Ending the login drops its lists.
    const latest = await routes["GET /api/push/settings"]!.run(context()) as Shown;
    pushes.end("s");
    await expect(routes["POST /api/push/settings"]!.run(context({ view: latest.view, roles: [] }))).rejects.toThrow("过期");
  } finally { await f.cleanup(); }
});

test("经本机控制接口读写：服务拒绝的号码打码后给页面，不在运行时说明原因，审计写不了时不保存", async () => {
  const f = await tempFixture("console-push-settings-refused-");
  const saved: unknown[] = [];
  const service = createApp({ isStopping: () => false, adminToken: "push-token", shutdown: () => {}, push: {
    settings: () => ({ roles: [], departments: [] }),
    saveSettings: roles => { saved.push(roles); throw new PushSettingsRefused("1 个手机号不在同步的通讯录里", ["13900000009"]); },
  } as Partial<PushAdmin> as PushAdmin });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: service.fetch });
  try {
    const context = { body: undefined, signal: new AbortController().signal, session: { label: "s" } } as RouteContext;
    const offline = new PushRoutes(f.root, new AuditLog(join(f.root, "audit"))).routes();
    await expect(offline["GET /api/push/settings"]!.run(context)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("服务可能没有运行") });
    mkdirSync(join(f.root, "data/state"), { recursive: true });
    writeFileSync(join(f.root, "data/state/instance.json"), JSON.stringify({ port: server.port, token: "push-token", instanceId: "i", pid: 1, startedAt: 1 }));
    const routes = new PushRoutes(f.root, new AuditLog(join(f.root, "audit"))).routes();
    const shown = await routes["GET /api/push/settings"]!.run(context) as Shown;
    expect(shown.roles).toEqual([]);
    const refused = await routes["POST /api/push/settings"]!.run({ ...context, body: { view: shown.view, roles: [{ phone: "13900000009", pusher: true }] } })
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ status: 409, message: "1 个手机号不在同步的通讯录里：139****0009" });
    expect(saved).toEqual([[{ phone: "13900000009", admin: undefined, pusher: true, grants: {}, dailyLimit: null }]]);
    // The audit directory is a file: the save is refused with the console's audit answer and never reaches the service.
    const blocked = join(f.root, "audit-file");
    writeFileSync(blocked, "");
    const unaudited = new PushRoutes(f.root, new AuditLog(join(blocked, "audit"))).routes();
    const again = await unaudited["GET /api/push/settings"]!.run(context) as Shown;
    await expect(unaudited["POST /api/push/settings"]!.run({ ...context, body: { view: again.view, roles: [] } })).rejects.toMatchObject({ status: 503, code: "audit" });
    expect(saved).toHaveLength(1);
  } finally { await server.stop(true); await f.cleanup(); }
});

test("推送设置经控制台服务保存时，服务接受的最大名单（1000 人、每人 200 个部门和全部其他授权）能保存；更大的请求和其余接口超过 16 KiB 时都是 400", async () => {
  const f = await tempFixture("console-push-settings-size-");
  try {
    const departments = Array.from({ length: ROLE_LIMITS.departments }, (_, index) => ({ id: `d${index}`, path: `分公司/部门 ${index}` }));
    const roles: Role[] = Array.from({ length: ROLE_LIMITS.people }, (_, index) => ({ phone: `138${String(index).padStart(8, "0")}`, name: "张三", admin: true, pusher: true,
      grants: { department: { departments: departments.map(department => department.id) }, all: true, group: true }, dailyLimit: ROLE_LIMITS.dailyLimit, updatedAt: 1 }));
    const fake = source(roles, departments);
    const routes = new PushRoutes(f.root, new AuditLog(join(f.root, "audit")), fake.settings).routes();
    const auth = new Auth(), login = auth.exchange(auth.issueToken().token)!;
    const bundle: Bundle = { index: { path: "/", type: "text/html; charset=utf-8", body: new Uint8Array() }, assets: new Map() };
    const handle = createHandler({ port: 10001, guard: guardConfig(10001), bundle, auth, instanceId: "i", overview: async () => ({} as Overview),
      routes: { ...routes, "POST /api/echo": { run: async ({ body }) => body } } });
    const request = (path: string, body?: string) => new Request(`http://127.0.0.1:10001${path}`, { method: body === undefined ? "GET" : "POST", body,
      headers: { host: "127.0.0.1:10001", "sec-fetch-site": "same-origin", "x-console-request": "1", cookie: `${auth.cookieName}=${login.sessionId}`,
        ...(body === undefined ? {} : { origin: "http://127.0.0.1:10001", "content-type": "application/json" }) } });
    const shown = await (await handle(request("/api/push/settings"))).json() as Shown;
    const body = JSON.stringify({ view: shown.view, roles: shown.roles.map(role => ({ key: role.key, admin: role.admin, pusher: role.pusher,
      dailyLimit: role.dailyLimit, grants: role.grants })) });
    expect(body.length).toBeGreaterThan(7_900_000);
    const response = await handle(request("/api/push/settings", body));
    expect(response.status, (await response.clone().text()).slice(0, 300)).toBe(200);
    // What reached the service passes its own check, every person with all 200 departments.
    const parsed = parseRoles(fake.saved[0]);
    expect(parsed).toHaveLength(ROLE_LIMITS.people);
    expect(parsed.every(role => role.grants.department && "departments" in role.grants.department && role.grants.department.departments.length === ROLE_LIMITS.departments)).toBe(true);
    const tooLarge = (path: string, size: number) => handle(request(path, JSON.stringify({ text: "x".repeat(size) })));
    for (const large of [await tooLarge("/api/push/settings", 16 * 1024 * 1024), await tooLarge("/api/echo", 17 * 1024)]) {
      expect({ status: large.status, body: await large.json() }).toEqual({ status: 400, body: { error: "请求内容过大", code: "input" } });
    }
  } finally { await f.cleanup(); }
});
