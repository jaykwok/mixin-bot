import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HostSetup, parseCheckLines, type SetupHost } from "../../console/server/setup-routes.ts";
import { CREATED_DEPENDENCIES, settleCreatedDependencies } from "../../console/server/host-dependencies.ts";
import { SOURCE_DIR } from "../../ops/core/platform.ts";
import type { HostService } from "../../ops/core/host-service.ts";
import type { AuditRecord } from "../../console/server/audit.ts";
import type { RunResult } from "../../console/server/query.ts";
import type { RouteContext } from "../../console/server/routes.ts";
import { tempFixture } from "../helpers/temp.ts";

const hosting = async () => ({ ok: true as const, mechanism: "systemd-system" as const, facts: ["systemd 257"] });
const service = async () => null;
const context = (body: unknown = {}): RouteContext => ({ body, session: { label: "one" } as RouteContext["session"], signal: new AbortController().signal });

test("依赖安装：只在尚未部署且缺依赖时、以检出属主运行；标记控制台新建的 node_modules，失败原因脱敏", async () => {
  const f = await tempFixture("setup-dependencies-");
  try {
    mkdirSync(join(f.root, ".console"));
    const state = { undeployed: false, installed: false }, audits: AuditRecord[] = [];
    const calls: { command: string; args: string[]; env?: NodeJS.ProcessEnv; timeout?: number }[] = [];
    let finish: (result: RunResult) => void = () => {};
    const host: SetupHost = { platform: "linux", undeployed: () => state.undeployed, installed: () => state.installed,
      operator: async () => ({ uid: 1000, gid: 1000, env: { HOME: "/home/owner", USER: "owner", LOGNAME: "owner" } }), hosting, service };
    const setup = new HostSetup(f.root, { write: record => { audits.push(record); } }, (command, args, options) => {
      calls.push({ command, args, env: options?.env, timeout: options?.timeout });
      return new Promise(resolve => { finish = resolve; });
    }, host);
    const routes = setup.routes(), install = () => routes["POST /api/setup/dependencies"]!.run(context());
    const settled = async () => { while (setup.dependencies().job?.state === "running") await Bun.sleep(1); return setup.dependencies(); };

    await expect(install()).rejects.toThrow("已有部署");
    state.undeployed = true; state.installed = true;
    await expect(install()).rejects.toThrow("已经安装");
    expect(audits).toEqual([]); expect(calls).toEqual([]);

    state.installed = false;
    expect(await install()).toMatchObject({ installed: false, job: { state: "running" } });
    expect(calls[0]).toMatchObject({ command: "setpriv", timeout: 20 * 60_000,
      args: ["--reuid=1000", "--regid=1000", "--init-groups", "--", process.execPath, "install", "--frozen-lockfile", "--cwd", f.root] });
    expect(calls[0]!.env).toMatchObject({ HOME: "/home/owner", USER: "owner" });
    expect(audits).toEqual([{ action: "setup-dependencies", session: "one", scope: "node_modules", mode: "default" }]);
    expect(JSON.parse(readFileSync(join(f.root, ".console", CREATED_DEPENDENCIES), "utf8"))).toMatchObject({ format: 1 });
    await expect(install()).rejects.toThrow("正在安装");
    expect(await routes["GET /api/setup"]!.run(context())).toMatchObject({ undeployed: true, dependencies: { job: { state: "running" } } });

    finish({ code: 1, stdout: "", stderr: "bun install v1.4.4\nerror: GET https://registry.example/x failed token=fixture-do-not-display\n", timedOut: false });
    const failed = await settled();
    expect(failed.job).toMatchObject({ state: "failed" });
    expect(failed.job!.message).toContain("依赖安装失败"); expect(failed.job!.message).not.toContain("fixture-do-not-display");
    expect(failed.job!.finishedAt).toBeNumber();

    // A retry over the partial node_modules: still the console's (the marker stays), and success needs the pinned versions.
    mkdirSync(join(f.root, "node_modules"));
    await install(); finish({ code: 0, stdout: "", stderr: "", timedOut: false });
    expect((await settled()).job).toMatchObject({ state: "failed", message: expect.stringContaining("不一致") });
    await install(); state.installed = true; finish({ code: 0, stdout: "", stderr: "", timedOut: false });
    expect(await settled()).toMatchObject({ installed: true, job: { state: "succeeded" } });
    expect(existsSync(join(f.root, ".console", CREATED_DEPENDENCIES))).toBe(true);

    state.installed = false; await install(); finish({ code: 124, stdout: "", stderr: "", timedOut: true });
    expect((await settled()).job!.message).toContain("超时");
    await expect(routes["POST /api/setup/dependencies"]!.run(context({ force: true }))).rejects.toThrow("参数无效");
  } finally { await f.cleanup(); }
});

test("依赖安装：已有 node_modules 时不标记；没有属主切换时沿用控制台身份和环境", async () => {
  const f = await tempFixture("setup-dependencies-own-");
  try {
    mkdirSync(join(f.root, ".console")); mkdirSync(join(f.root, "node_modules"));
    const calls: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    const host: SetupHost = { platform: "win32", undeployed: () => true, installed: () => false, operator: async () => null, hosting, service };
    const setup = new HostSetup(f.root, { write: () => {} }, async (command, args, options) => {
      calls.push({ command, args, env: options?.env }); return { code: 0, stdout: "", stderr: "", timedOut: false };
    }, host);
    await setup.install("one");
    expect(calls).toEqual([{ command: process.execPath, args: ["install", "--frozen-lockfile", "--cwd", f.root], env: {} }]);
    expect(existsSync(join(f.root, ".console", CREATED_DEPENDENCIES))).toBe(false);
    // Two requests interleaving while the owner is looked up (a double click, two tabs): one install only.
    let release = () => {};
    const slow = new HostSetup(f.root, { write: () => {} }, async (command, args, options) => {
      calls.push({ command, args, env: options?.env }); return new Promise(() => {});
    }, { ...host, operator: () => new Promise(resolve => { release = () => resolve(null); }) });
    const first = slow.install("one");
    await expect(slow.install("two")).rejects.toThrow("正在安装");
    release(); await first;
    expect(calls).toHaveLength(2);
    await expect(slow.install("three")).rejects.toThrow("正在安装");
  } finally { await f.cleanup(); }
});

test("部署后收尾：Linux 删除控制台建的 node_modules，其他平台保留；没有标记或不是目录时不动", async () => {
  const f = await tempFixture("setup-settle-");
  try {
    const marker = join(f.root, ".console", CREATED_DEPENDENCIES), modules = join(f.root, "node_modules");
    mkdirSync(join(f.root, ".console")); mkdirSync(join(modules, "pkg"), { recursive: true });
    settleCreatedDependencies(f.root, "linux");
    expect(existsSync(modules)).toBe(true);
    writeFileSync(marker, "{}\n");
    settleCreatedDependencies(f.root, "win32");
    expect([existsSync(modules), existsSync(marker)]).toEqual([true, false]);
    writeFileSync(marker, "{}\n");
    settleCreatedDependencies(f.root, "linux");
    expect([existsSync(modules), existsSync(marker)]).toEqual([false, false]);
    writeFileSync(modules, "not ours"); writeFileSync(marker, "{}\n");
    settleCreatedDependencies(f.root, "linux");
    expect([readFileSync(modules, "utf8"), existsSync(marker)]).toEqual(["not ours", false]);
  } finally { await f.cleanup(); }
});

test("环境检查：托管、Bun、依赖、属主能否运行 Bun，加上部署入口自己的只读检查；已有部署时拒绝", async () => {
  const f = await tempFixture("setup-check-");
  try {
    writeFileSync(join(f.root, "package.json"), JSON.stringify({ engines: { bun: ">=1.0.0" } }));
    const state = { undeployed: true, service: null as HostService | null | Error }, calls: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    const host: SetupHost = { platform: "linux", undeployed: () => state.undeployed, installed: () => false, hosting,
      operator: async () => ({ uid: 1000, gid: 1000, env: { HOME: "/home/owner", USER: "owner", LOGNAME: "owner" } }),
      service: async () => { if (state.service instanceof Error) throw state.service; return state.service; } };
    const setup = new HostSetup(f.root, { write: () => {} }, async (command, args, options) => {
      calls.push({ command, args, env: options?.env });
      if (args.includes("--version")) return { code: 0, stdout: "1.4.4\n", stderr: "", timedOut: false };
      return { code: 1, stdout: "ok\tDocker\trootful\nfail\t任务隔离\t需要 socket token=fixture-do-not-display\nnoise\n", stderr: "", timedOut: false };
    }, host);
    const routes = setup.routes(), check = () => routes["POST /api/setup/check"]!.run(context()) as Promise<{ ok: boolean; items: { state: string; name: string; detail: string }[]; leftover: unknown }>;
    const result = await check();
    expect(result.ok).toBe(false); expect(result.leftover).toBeNull();
    expect(result.items.map(item => [item.name, item.state])).toEqual([["后台任务", "ok"], ["Bun", "ok"], ["依赖", "fail"], ["检出属主", "ok"], ["Docker", "ok"], ["任务隔离", "fail"]]);
    expect(JSON.stringify(result)).not.toContain("fixture-do-not-display");
    expect(calls[0]).toMatchObject({ command: "setpriv", args: ["--reuid=1000", "--regid=1000", "--init-groups", "--", process.execPath, "--version"] });
    expect(calls[1]).toMatchObject({ command: "bash", args: [join(SOURCE_DIR, "scripts/lib/deploy.sh"), "check"], env: { MIXIN_OPS_PROJECT: f.root, MIXIN_OPS_BUN: process.execPath, BOT_TASK_DOCKER_HOST: "" } });
    // A service already on the host is no failure: it is listed with what the operator confirms to remove it first.
    state.service = { digest: "d".repeat(64), directory: "/srv/old", running: true, description: "容器 mixin-bot（/srv/old，运行中）", containers: ["c".repeat(64)] };
    const found = await check();
    expect(found.leftover).toEqual({ digest: "d".repeat(64), description: "容器 mixin-bot（/srv/old，运行中）" });
    expect(found.items.at(-1)).toMatchObject({ state: "ok", name: "已有服务", detail: expect.stringContaining("/srv/old") });
    state.service = new Error("无法读取 Docker 中的机器人容器");
    const unread = await check();
    expect(unread.leftover).toBeNull(); expect(unread.items.at(-1)).toMatchObject({ state: "fail", name: "已有服务", detail: expect.stringContaining("无法读取 Docker") });
    await expect(routes["POST /api/setup/check"]!.run(context({ all: true }))).rejects.toThrow("参数无效");
    state.undeployed = false; await expect(check()).rejects.toThrow("已有部署");
  } finally { await f.cleanup(); }
});

test("环境检查输出：只认三段的结果行；入口在检查开始前就拒绝时，取最后一行原因", () => {
  expect(parseCheckLines("ok\t工具\tgit\r\n", "", 0)).toEqual([{ state: "ok", name: "工具", detail: "git" }]);
  expect(parseCheckLines("", "Bun 太旧\n找不到 Bun。请用 Homebrew 安装\n", 1)).toEqual([{ state: "fail", name: "部署入口", detail: "找不到 Bun。请用 Homebrew 安装" }]);
  expect(parseCheckLines("warn\tx\ty\n", "", 2)).toEqual([{ state: "fail", name: "部署入口", detail: "warn\tx\ty" }]);
});
