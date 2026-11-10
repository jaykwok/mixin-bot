import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertDeploymentEnvironment, deploymentOptions, deploymentEnvironment, deploymentScope, sameWindowsPath, uninstallScope } from "../../ops/core/deployment-options.ts";
import { operationArgs, operationCommand } from "../../ops/core/operations.ts";
import { codeDigest } from "../../ops/core/source-runtime.ts";
import { checkTaskPlan } from "../../ops/core/check-plan.ts";
import { PlanStore, type PlanFacts } from "../../ops/core/plans.ts";
import { TaskStore } from "../../ops/core/tasks.ts";
import type { Runner } from "../../ops/core/hosting.ts";
import { RUNTIME_KEYS } from "../../src/core/runtime-schema.ts";
import { tempFixture } from "../helpers/temp.ts";
import { directoryAppHash } from "../../ops/lib/directory-choice.ts";
import type { LaunchdHostFacts } from "../../ops/core/launchd-host.ts";

const target = "a".repeat(40);
const choice = { target, switchMain: false, directory: "saved" };
test("升级脚本 unset 已清空的运行参数后仍可复核计划，显式覆盖和缺失的部署选择仍被拒绝", () => {
  const project = process.cwd(), env = deploymentEnvironment("update", choice, project);
  for (const [key, value] of Object.entries(env)) if (value === "") delete env[key];
  expect(() => assertDeploymentEnvironment("update", choice, project, env)).not.toThrow();
  expect(() => assertDeploymentEnvironment("update", choice, project, { ...env, BOT_PORT: "9999" })).toThrow("BOT_PORT");
  expect(() => assertDeploymentEnvironment("update", choice, project, { ...env, BOT_RUN_TIMEOUT_SECONDS: "5" })).toThrow("BOT_RUN_TIMEOUT_SECONDS");
  expect(() => assertDeploymentEnvironment("update", choice, project, { ...env, MIXIN_OPS_DIRECTORY: undefined })).toThrow("MIXIN_OPS_DIRECTORY");
  const deploy = { port: 2022, workspace: "", directory: "saved" };
  expect(() => assertDeploymentEnvironment("deploy", deploy, project, { ...deploymentEnvironment("deploy", deploy, project), BOT_PORT: undefined })).toThrow("BOT_PORT");
});

async function fixture() {
  const f = await tempFixture("console-deployment-");
  for (const name of ["console", "ops", "scripts", "src"]) mkdirSync(join(f.root, name), { recursive: true });
  for (const [path, value] of Object.entries({ "data/state/data-version.json": "{}", "data/state/bot-port": "1011", ".console/port": "10001",
    "data/config/app-bot.json": '{"secret":"synthetic-secret"}', "data/config/models.json": "{}", "data/runtime/pi/settings.json": "{}", "data/config/directory.json": '{"format":1,"all":true}' })) {
    mkdirSync(dirname(join(f.root, path)), { recursive: true }); writeFileSync(join(f.root, path), value);
  }
  // service: the scheduled task, container or LaunchDaemon exists; rollback: an old mixin-bot-rollback container is left.
  const state = { branch: "main", dirty: "", identity: "first", capability: 1, service: true, rollback: false };
  const run: Runner = async argv => {
    let stdout: string;
    if (argv[0] === "git" && argv[3] === "rev-parse") stdout = state.branch;
    else if (argv[0] === "git" && argv[3] === "status") stdout = state.dirty;
    else if (argv[0] === "git" && argv[3] === "show") stdout = JSON.stringify({ protocol: "mixin-console-lifecycle", version: state.capability });
    else if (argv[0] === "powershell") stdout = state.service ? JSON.stringify({ Principal: { UserId: state.identity }, Actions: [{ WorkingDirectory: f.root, Execute: "fixture" }] }) : "null";
    else if (argv[0] === "docker" && argv[1] === "ps") stdout = [...state.service ? ["mixin-bot"] : [], ...state.rollback ? ["mixin-bot-rollback"] : []].join("\n");
    else if (argv[0] === "docker") stdout = JSON.stringify([{ Id: state.identity, Image: "synthetic-image", Config: { User: "10001:10001" }, Mounts: [{ Type: "bind", RW: true, Source: realpathSync(join(f.root, "data")), Destination: "/app/data" }] }]);
    // macOS: the LaunchDaemon of this project, its definition naming the identity under test.
    else if (argv[0] === "/usr/bin/plutil") stdout = JSON.stringify({ Label: "com.mixin-bot.service", UserName: "_mixinbot", WorkingDirectory: f.root, ProgramArguments: [state.identity] });
    else if (argv[0] === "/bin/launchctl") { if (!state.service) return { code: 113, stdout: "", stderr: "" }; stdout = "state = running\n"; }
    else if (argv[0] === "/usr/bin/id") stdout = "499\n";
    else throw new Error(`unexpected command ${argv}`);
    return { code: 0, stdout, stderr: "" };
  };
  writeFileSync(join(f.root, "service.plist"), "<plist/>");
  const launchd: Partial<LaunchdHostFacts> = { plist: join(f.root, "service.plist"), processes: () => new Map() };
  return { ...f, state, run, launchd };
}

test("升级只接收完整显式选择；环境覆盖受限，不接受 argv、多余选择或隐式目标", () => {
  expect(operationArgs("update", choice)).toEqual(["update", target]);
  for (const params of [{}, { ...choice, target: "origin/main" }, { ...choice, switchMain: "false" }, { ...choice, cleanup: "apply" },
    { ...choice, directory: ["saved"] }, { ...choice, env: { BOT_PORT: "1" } }, { ...choice, argv: [] }, { ...choice, ai: "keep" }]) {
    expect(() => operationArgs("update", params)).toThrow();
  }
  const command = operationCommand("fixture", "update", choice);
  expect(command.env.MIXIN_OPS_SWITCH_MAIN).toBe("0");
  expect(command.env.BOT_DIRECTORY_SCOPE).toBe("");
  const deploy = { port: 2022, workspace: "", directory: "saved" };
  expect(operationArgs("deploy", deploy)).toEqual(["deploy"]);
  expect(operationCommand("fixture", "deploy", deploy).env.BOT_PORT).toBe("2022");
  const native = process.platform !== "linux";
  expect(operationArgs("repair", native ? {} : deploy)).toEqual(["repair"]);
  expect(() => operationArgs("repair", native ? { argv: [] } : {})).toThrow();
  for (const key of RUNTIME_KEYS) expect(command.env[key], key).toBe("");
  for (const params of [{ port: 10001, workspace: "relative" }, { port: 1.5, workspace: "" }, { port: 0, workspace: "" }]) {
    expect(() => deploymentOptions("deploy", { directory: "saved", ...params })).toThrow();
  }
});

test("预览绑定配置、部署身份及选择；拒绝脏树、旧协议、未确认分支和通讯录默认值", async () => {
  const f = await fixture();
  try {
    const initial = await deploymentScope(f.root, "update", choice, f.run, f.launchd);
    expect(initial.summary.join(" ")).not.toContain("synthetic-secret");
    writeFileSync(join(f.root, "data/config/app-bot.json"), '{"secret":"rotated-synthetic"}');
    expect((await deploymentScope(f.root, "update", choice, f.run, f.launchd)).scope).not.toBe(initial.scope);
    f.state.identity = "replacement"; const changed = await deploymentScope(f.root, "update", choice, f.run, f.launchd);
    expect(changed.scope).not.toBe(initial.scope);
    f.state.branch = "feature"; await expect(deploymentScope(f.root, "update", choice, f.run, f.launchd)).rejects.toThrow("允许切换");
    await deploymentScope(f.root, "update", { ...choice, switchMain: true }, f.run, f.launchd);
    f.state.branch = "main"; f.state.dirty = " M tracked";
    await expect(deploymentScope(f.root, "update", choice, f.run, f.launchd)).rejects.toThrow("已跟踪");
    f.state.dirty = ""; f.state.capability = 2;
    await expect(deploymentScope(f.root, "update", choice, f.run, f.launchd)).rejects.toThrow("协议");
    f.state.capability = 1;
    await expect(deploymentScope(f.root, "update", { ...choice, directory: "all" }, f.run, f.launchd)).rejects.toThrow("已有同步范围");
    unlinkSync(join(f.root, "data/config/directory.json"));
    await expect(deploymentScope(f.root, "update", choice, f.run, f.launchd)).rejects.toThrow("没有已保存");
    await deploymentScope(f.root, "update", { ...choice, directory: "all" }, f.run, f.launchd);
    writeFileSync(join(f.root, "data/state/deploy-transaction"), "corrupt");
    await expect(deploymentScope(f.root, "update", choice, f.run, f.launchd)).rejects.toThrow();
  } finally { await f.cleanup(); }
});

test("重部署目标端口与控制台相同时停机前拒绝；预览期间配置变化也拒绝", async () => {
  const f = await fixture();
  try {
    const params = { directory: "saved", port: 10001, workspace: "" };
    await expect(deploymentScope(f.root, "deploy", params, f.run, f.launchd)).rejects.toThrow("控制台端口");
    params.port = 1011; await deploymentScope(f.root, "deploy", params, f.run, f.launchd);
    await expect(deploymentScope(f.root, "deploy", params, async (...args) => {
      writeFileSync(join(f.root, "data/config/runtime.json"), '{"BOT_BASH_TIMEOUT":"123"}'); return f.run(...args);
    }, f.launchd)).rejects.toThrow("预览期间");
  } finally { await f.cleanup(); }
});

test("重新部署：服务不在（卸载保留了数据）时预览写明会重新创建并绑定这一事实；升级仍要求服务存在", async () => {
  const f = await fixture();
  try {
    const params = { directory: "saved", port: 1011, workspace: "" };
    const present = await deploymentScope(f.root, "deploy", params, f.run, f.launchd);
    f.state.service = false; rmSync(join(f.root, "service.plist"));
    const missing = await deploymentScope(f.root, "deploy", params, f.run, f.launchd);
    expect(missing.scope).not.toBe(present.scope);
    expect(missing.summary.join("\n")).toMatch(/重新注册|重新安装|重新创建/);
    if (process.platform === "linux") expect(missing.summary.join("\n")).toContain(`${statSync(join(f.root, "data/state")).uid}:${statSync(join(f.root, "data/state")).gid}`);
    // Rootless (a non-root operator): the container runs as 0:0, mapped to the data's owner, as deploy.sh service_user_from_data.
    if (process.platform === "linux" && process.geteuid!() !== 0) expect(missing.summary.join("\n")).toContain("以 0:0 运行");
    await expect(deploymentScope(f.root, "update", choice, f.run, f.launchd)).rejects.toThrow("请先在维护页重新部署");
    if (process.platform === "linux") {
      f.state.rollback = true;
      await expect(deploymentScope(f.root, "deploy", params, f.run, f.launchd)).rejects.toThrow("回滚容器");
    }
  } finally { await f.cleanup(); }
});

test("锁内复核拒绝丢失或污染的命名选择，不只检查保存的计划", async () => {
  const f = await fixture();
  const env = deploymentEnvironment("update", choice, f.root), previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  try {
    const facts: PlanFacts = { project: f.root, identity: "fixture", platform: process.platform, head: target, protocol: 1, scope: "fixture", runState: "running" };
    const observe = async () => ({ facts, summary: [] });
    const plan = await new PlanStore(join(f.root, ".console"), observe).create("update", choice);
    const task = new TaskStore(join(f.root, ".console")).create({ project: f.root, planId: plan.id, operation: "update", params: choice,
      mechanism: process.platform === "win32" ? "windows-task" : "systemd-system" }, "fixture");
    Object.assign(process.env, env); const digest = codeDigest(f.root);
    await checkTaskPlan(f.root, task.id, digest, observe);
    for (const key of ["MIXIN_OPS_DIRECTORY", "MIXIN_OPS_DIRECTORY_INPUT", "MIXIN_OPS_DIRECTORY_APP", "MIXIN_OPS_SWITCH_MAIN", "BOT_PORT", "BOT_BASH_TIMEOUT"]) {
      process.env[key] = "polluted";
      await expect(checkTaskPlan(f.root, task.id, digest, observe)).rejects.toThrow("选择未完整传递"); process.env[key] = env[key];
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await f.cleanup();
  }
});

test("部署部门选择绑定应用摘要并进入锁内环境核对，已有范围时拒绝覆盖", async () => {
  const f = await fixture();
  try {
    const selected = { ...choice, directory: { departments: ["d1"], names: ["合成研发"], appHash: directoryAppHash(f.root) } };
    await expect(deploymentScope(f.root, "update", selected, f.run, f.launchd)).rejects.toThrow("已有同步范围");
    unlinkSync(join(f.root, "data/config/directory.json"));
    const result = await deploymentScope(f.root, "update", selected, f.run, f.launchd);
    expect(result.summary.join(" ")).toContain("合成研发");
    const env = deploymentEnvironment("update", selected, f.root);
    expect(env.MIXIN_OPS_DIRECTORY_APP).toBe(selected.directory.appHash);
    expect(env.MIXIN_OPS_DIRECTORY_INPUT).not.toContain("合成研发");
    writeFileSync(join(f.root, "data/config/app-bot.json"), "{}");
    await expect(deploymentScope(f.root, "update", selected, f.run, f.launchd)).rejects.toThrow("应用配置已变化");
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform !== "linux")("Docker mount order is not a deployment change; mount properties and identity still are", async () => {
  const f = await fixture();
  try {
    const mount = (source: string, destination: string) => ({ Type: "bind", Source: source, Destination: destination, RW: true, Propagation: "rprivate" });
    const original = [mount(realpathSync(join(f.root, "data")), "/app/data"), mount("/run/user/1001/docker.sock", "/run/mixin-task/docker.sock"),
      mount(join(f.root, "workspace"), "/app/workspace")];
    let mounts = structuredClone(original), user = "1001:1001", id = "same-container";
    const run: Runner = async (argv, env) => argv[0] === "docker" && argv[1] !== "ps"
      ? { code: 0, stderr: "", stdout: JSON.stringify([{ Id: id, Image: "same-image", Config: { User: user }, Mounts: mounts }]) }
      : f.run(argv, env);
    const scope = async () => (await deploymentScope(f.root, "update", choice, run)).scope;
    const initial = await scope();
    for (const order of [[2, 0, 1], [1, 2, 0], [2, 1, 0]]) {
      mounts = order.map(index => structuredClone(original[index]!));
      expect(await scope()).toBe(initial);
    }
    mounts[0]!.RW = false; expect(await scope()).not.toBe(initial);
    mounts = structuredClone(original); mounts[1]!.Source = "/run/user/1002/docker.sock";
    expect(await scope()).not.toBe(initial);
    mounts = structuredClone(original); user = "0:0"; expect(await scope()).not.toBe(initial);
    user = "1001:1001"; id = "replaced-container"; expect(await scope()).not.toBe(initial);
  } finally { await f.cleanup(); }
});

test("卸载只接收两项明确选择并逐项传给入口；预览绑定本部署的服务，拒绝别的目录的服务、未完成的事务和空目录", async () => {
  const f = await fixture();
  try {
    const keep = { data: false, image: false }, archive = { data: true, image: false }, linux = process.platform === "linux";
    expect(operationArgs("uninstall", keep)).toEqual(["uninstall"]);
    for (const params of [{}, { data: false }, { data: "false", image: false }, { ...keep, argv: [] }]) expect(() => operationArgs("uninstall", params)).toThrow();
    if (linux) expect(operationArgs("uninstall", { data: false, image: true })).toEqual(["uninstall"]);
    else expect(() => operationArgs("uninstall", { data: false, image: true })).toThrow("只有 Linux");
    const env = operationCommand(f.root, "uninstall", archive).env;
    expect([env.MIXIN_OPS_UNINSTALL_DATA, env.MIXIN_OPS_UNINSTALL_IMAGE]).toEqual(["1", "0"]);
    expect(() => assertDeploymentEnvironment("uninstall", keep, f.root, { MIXIN_OPS_UNINSTALL_DATA: "0", MIXIN_OPS_UNINSTALL_IMAGE: "0" })).not.toThrow();
    for (const polluted of [{ MIXIN_OPS_UNINSTALL_DATA: "1", MIXIN_OPS_UNINSTALL_IMAGE: "0" }, { MIXIN_OPS_UNINSTALL_IMAGE: "0" }])
      expect(() => assertDeploymentEnvironment("uninstall", keep, f.root, polluted)).toThrow("卸载选择未完整传递");

    const kept = await uninstallScope(f.root, keep, f.run, f.launchd), archived = await uninstallScope(f.root, archive, f.run, f.launchd);
    expect(kept.scope).not.toBe(archived.scope);
    expect(kept.summary.join("\n")).toContain("保留 data/ 和 logs/");
    expect(archived.summary.join("\n")).toContain("移入 backup/rm");
    expect(archived.summary.join("\n")).toContain("workspace/ 目录（共享资料）不删除");
    expect(archived.summary.join("\n")).toMatch(/注销计划任务|删除 LaunchDaemon|删除容器 mixin-bot/);
    if (linux) {
      expect((await uninstallScope(f.root, { data: false, image: true }, f.run)).summary.join("\n")).toContain("删除镜像 mixin-bot");
      f.state.rollback = true;
      expect((await uninstallScope(f.root, keep, f.run)).summary.join("\n")).toContain("mixin-bot、mixin-bot-rollback");
      f.state.rollback = false;
    }
    // The service it removes is bound: a replaced one needs a new preview.
    f.state.identity = "replacement";
    expect((await uninstallScope(f.root, keep, f.run, f.launchd)).scope).not.toBe(kept.scope);
    writeFileSync(join(f.root, "data/state/workspace-root"), "/srv/shared\n");
    expect((await uninstallScope(f.root, archive, f.run, f.launchd)).summary.join("\n")).toContain("外置共享资料目录 /srv/shared 不删除");
    // Another directory's service is removed by name by the entries: refuse it.
    const foreign: Runner = async (argv, environment) => argv[0] === "powershell"
      ? { code: 0, stderr: "", stdout: JSON.stringify({ Actions: [{ WorkingDirectory: join(f.root, "other"), Execute: "fixture" }] }) }
      : argv[0] === "docker" && argv[1] !== "ps"
        ? { code: 0, stderr: "", stdout: JSON.stringify([{ Id: "other", Mounts: [{ Type: "bind", RW: true, Source: join(f.root, "other/data"), Destination: "/app/data" }] }]) }
        : argv[0] === "/usr/bin/plutil"
          ? { code: 0, stderr: "", stdout: JSON.stringify({ Label: "com.mixin-bot.service", UserName: "_mixinbot", WorkingDirectory: join(f.root, "other"), ProgramArguments: ["x"] }) }
          : f.run(argv, environment);
    await expect(uninstallScope(f.root, keep, foreign, f.launchd)).rejects.toThrow("请在");
    // Without a service the data can still be archived; with neither there is nothing to uninstall.
    f.state.service = false; rmSync(join(f.root, "service.plist"));
    expect((await uninstallScope(f.root, archive, f.run, f.launchd)).summary.join("\n")).toMatch(/不存在/);
    writeFileSync(join(f.root, "data/state/deploy-transaction"), "corrupt");
    await expect(uninstallScope(f.root, keep, f.run, f.launchd)).rejects.toThrow();
    rmSync(join(f.root, "data"), { recursive: true });
    await expect(uninstallScope(f.root, archive, f.run, f.launchd)).rejects.toThrow("没有可卸载");
  } finally { await f.cleanup(); }
});

test("the scheduled task's directory is compared as Windows compares paths: case and a trailing separator do not make another deployment", async () => {
  expect(sameWindowsPath("d:\\projects\\Mixin-Bot\\", "D:\\Projects\\mixin-bot")).toBe(true);
  expect(sameWindowsPath("D:/Projects/mixin-bot", "D:\\Projects\\mixin-bot")).toBe(true);
  expect(sameWindowsPath("D:\\Projects\\mixin-bot2", "D:\\Projects\\mixin-bot")).toBe(false);
  expect(sameWindowsPath("", "D:\\Projects\\mixin-bot")).toBe(false);
  if (process.platform !== "win32") return;
  // The task keeps the directory as typed at deployment; the console has it as the file system spells it.
  const f = await fixture();
  try {
    const typed: Runner = async (argv, environment) => argv[0] === "powershell"
      ? { code: 0, stderr: "", stdout: JSON.stringify({ Principal: { UserId: "first" }, Actions: [{ WorkingDirectory: `${f.root.toUpperCase()}\\`, Execute: "fixture" }] }) }
      : f.run(argv, environment);
    expect((await uninstallScope(f.root, { data: false, image: false }, typed, f.launchd)).summary.join("\n")).toContain("注销计划任务 mixin-bot");
    expect((await deploymentScope(f.root, "update", choice, typed, f.launchd)).scope).toBeString();
  } finally { await f.cleanup(); }
});
