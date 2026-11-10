import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { assertDeploymentEnvironment, deploymentEnvironment, installScope } from "../../ops/core/deployment-options.ts";
import { operationArgs, operationCommand, opsCommandOf } from "../../ops/core/operations.ts";
import { ConfigurationDrafts, taskDrafts } from "../../ops/core/configuration-drafts.ts";
import { stageConsoleConfiguration } from "../../ops/core/console-stage.ts";
import { parseConfigurationStage } from "../../ops/config/configuration-stage.ts";
import { configurationDigest } from "../../ops/config/configuration-draft.ts";
import { consoleDirectoryScope, directoryChoiceText } from "../../ops/lib/directory-choice.ts";
import { operationPreparer } from "../../console/server/prepare-operation.ts";
import type { DeploymentDirectory } from "../../console/server/deployment-directory.ts";
import type { Views } from "../../console/server/views.ts";
import type { Runner } from "../../ops/core/hosting.ts";
import type { LaunchdHostFacts } from "../../ops/core/launchd-host.ts";
import { tempFixture } from "../helpers/temp.ts";

const appPatch = { appId: "fixture", environment: "production", secret: { mode: "set", value: "synthetic-private" } };
const modelPatch = { provider: "gateway", mode: "custom", api: "openai-completions", baseUrl: "https://example.test/v1", key: { mode: "set", value: "synthetic-model-key" },
  thinking: "low", model: { id: "fixture", contextWindow: 64000, maxTokens: 8000, input: ["text"], reasoning: true, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** A checked draft of `kind` in session "one", as the console's check route leaves it. */
function checked(drafts: ConfigurationDrafts, kind: "app" | "models", network = true): string {
  const draft = drafts.create(kind, "one"), edited = drafts.edit(draft.id, "one", draft.revision, kind === "app" ? appPatch : modelPatch);
  const input = drafts.validationInput(draft.id, "one", edited.revision);
  drafts.validated(draft.id, "one", edited.revision, input.digest, [kind === "app" ? "应用机器人：fixture（在线校验通过）" : "模型：gateway/fixture（在线校验通过）"], undefined, network);
  return draft.id;
}

/** A fresh checkout with its console, two checked drafts and a host without any bot service (state.service adds one). */
async function fixture() {
  const f = await tempFixture("console-install-");
  mkdirSync(join(f.root, ".console")); writeFileSync(join(f.root, ".console/port"), "10001");
  const drafts = new ConfigurationDrafts(f.root), app = checked(drafts, "app"), models = checked(drafts, "models");
  const reference = (id: string) => ({ draft: id, digest: configurationDigest(drafts.read(id)) });
  const state = { service: false };
  const run: Runner = async argv => {
    if (argv[0] === "git") return { code: 0, stdout: "main\n", stderr: "" };
    if (argv[0] === "powershell") return { code: 0, stdout: state.service ? '{"Actions":[{"WorkingDirectory":"C:\\\\other"}]}\n' : "null\n", stderr: "" };
    if (argv[0] === "docker") return { code: 0, stdout: state.service ? "mixin-bot\n" : "", stderr: "" };
    // macOS: no definition; a loaded job without one is someone else's LaunchDaemon.
    if (argv[0] === "/bin/launchctl") return state.service ? { code: 0, stdout: "state = running\n", stderr: "" } : { code: 113, stdout: "", stderr: "" };
    if (argv[0] === "/usr/bin/id") return { code: 1, stdout: "", stderr: "no such user" };
    throw new Error(`unexpected command ${argv}`);
  };
  const launchd: Partial<LaunchdHostFacts> = { plist: join(f.root, "absent.plist"), processes: () => new Map() };
  return { ...f, drafts, app, models, appRef: reference(app), modelsRef: reference(models), state, run, launchd };
}

test("首次部署只接受两份草稿引用和明确的通讯录范围，以 deploy 入口运行；草稿引用只出现在首次部署的环境里", () => {
  const ref = (letter: string) => ({ draft: "config-" + letter.repeat(32), digest: letter.repeat(64) });
  const params = { directory: "all", port: 2022, workspace: "", app: ref("a"), models: ref("b") };
  expect(operationArgs("install", params)).toEqual(["deploy"]);
  expect([opsCommandOf("install"), opsCommandOf("repair")]).toEqual(["deploy", "repair"]);
  for (const bad of [{ ...params, directory: "saved" }, { ...params, app: undefined }, { ...params, app: ref("a").draft }, { ...params, models: { ...ref("b"), extra: 1 } },
    { ...params, models: { draft: "config-x", digest: "b".repeat(64) } }, { ...params, argv: [] }, { directory: "all", port: 2022, workspace: "" }])
    expect(() => operationArgs("install", JSON.parse(JSON.stringify(bad)))).toThrow();
  const env = operationCommand("fixture", "install", params).env;
  expect(env).toMatchObject({ MIXIN_OPS_LIFECYCLE: "install", MIXIN_OPS_APP_DRAFT: `${"config-" + "a".repeat(32)}:${"a".repeat(64)}`,
    MIXIN_OPS_MODELS_DRAFT: `${"config-" + "b".repeat(32)}:${"b".repeat(64)}`, BOT_DIRECTORY_SCOPE: "all", BOT_PORT: "2022" });
  expect(() => assertDeploymentEnvironment("install", params, "fixture", { ...env, MIXIN_OPS_MODELS_DRAFT: "" })).toThrow("MIXIN_OPS_MODELS_DRAFT");
  const deploy = { directory: "saved", port: 2022, workspace: "" }, deployEnv = deploymentEnvironment("deploy", deploy, "fixture");
  expect([deployEnv.MIXIN_OPS_APP_DRAFT, deployEnv.MIXIN_OPS_MODELS_DRAFT]).toEqual(["", ""]);
  expect(() => assertDeploymentEnvironment("deploy", deploy, "fixture", { ...deployEnv, MIXIN_OPS_APP_DRAFT: env.MIXIN_OPS_APP_DRAFT })).toThrow("MIXIN_OPS_APP_DRAFT");
});

test("首次部署预览绑定在线校验过的草稿、范围、端口和资料目录；已部署、已有服务、草稿变化或未在线校验时拒绝", async () => {
  const f = await fixture();
  try {
    const params = { directory: "all", port: 2022, workspace: "", app: f.appRef, models: f.modelsRef };
    const first = await installScope(f.root, params, f.run, f.launchd);
    expect(first.summary.join("\n")).toContain("应用机器人：fixture"); expect(first.summary.join("\n")).toContain("整个通讯录");
    expect(JSON.stringify(first)).not.toContain("synthetic");
    expect((await installScope(f.root, params, f.run, f.launchd)).scope).toBe(first.scope);
    const appText = f.drafts.read(f.app).next.files.app!, departments = { departments: ["d1"], names: ["合成研发"] };
    expect((await installScope(f.root, { ...params, directory: { ...departments, appHash: sha(appText) } }, f.run, f.launchd)).summary.join("")).toContain("合成研发");
    await expect(installScope(f.root, { ...params, directory: { ...departments, appHash: "0".repeat(64) } }, f.run, f.launchd)).rejects.toThrow("另一份应用凭据");
    await expect(installScope(f.root, { ...params, port: 10001 }, f.run, f.launchd)).rejects.toThrow("控制台端口");
    f.state.service = true; await expect(installScope(f.root, params, f.run, f.launchd)).rejects.toThrow("卸载"); f.state.service = false;
    await expect(installScope(f.root, { ...params, app: { ...f.appRef, digest: "0".repeat(64) } }, f.run, f.launchd)).rejects.toThrow("请先在线校验应用机器人凭据");
    await expect(installScope(f.root, { ...params, app: f.modelsRef }, f.run, f.launchd)).rejects.toThrow("请先填写应用机器人凭据");
    const offline = checked(f.drafts, "models", false);
    await expect(installScope(f.root, { ...params, models: { draft: offline, digest: configurationDigest(f.drafts.read(offline)) } }, f.run, f.launchd)).rejects.toThrow("请先在线校验模型配置");
    mkdirSync(join(f.root, "data/config"), { recursive: true });
    writeFileSync(join(f.root, "data/config/directory.json"), '{"format":1,"all":true}');
    await expect(installScope(f.root, params, f.run, f.launchd)).rejects.toThrow("directory.json");
    rmSync(join(f.root, "data/config/directory.json"));
    mkdirSync(join(f.root, "data/groups"));
    await expect(installScope(f.root, params, f.run, f.launchd)).rejects.toThrow("版本标记");
    rmSync(join(f.root, "data/groups"), { recursive: true });
    // Another operation wrote the configuration the drafts were read against.
    writeFileSync(join(f.root, "data/config/app-bot.json"), "{}");
    await expect(installScope(f.root, params, f.run, f.launchd)).rejects.toThrow("已被其他操作修改");
  } finally { await f.cleanup(); }
});

test("配置草稿在最后一次使用 30 分钟后才过期：读部门树和预览也算使用", async () => {
  const f = await tempFixture("console-draft-ttl-");
  try {
    let now = 1_000_000;
    const drafts = new ConfigurationDrafts(f.root, () => now), id = checked(drafts, "app");
    now += 25 * 60_000; drafts.appText(id, "one");
    now += 25 * 60_000; expect(drafts.deploymentReference(id, "one", "app").draft).toBe(id);
    now += 31 * 60_000; expect(() => drafts.appText(id, "one")).toThrow("过期");
  } finally { await f.cleanup(); }
});

test("首次部署的预览准备：浏览器只给草稿编号，计划带上校验时的摘要；部门选择交给选择器核对", async () => {
  const f = await fixture();
  try {
    const picker = { prepare: async () => ({ departments: ["d1"], names: ["合成研发"], appHash: "e".repeat(64) }) } as unknown as DeploymentDirectory;
    const prepare = operationPreparer(f.root, {} as Views, undefined, undefined, undefined, undefined, f.drafts, picker);
    const input = { app: f.app, models: f.models, directory: "all", port: 2022, workspace: "" };
    expect(await prepare("install", input, "one")).toEqual({ ...input, app: f.appRef, models: f.modelsRef });
    expect((await prepare("install", { ...input, directory: { view: "v", selected: ["k"] } }, "one")).directory).toMatchObject({ names: ["合成研发"] });
    await expect(prepare("install", input, "two")).rejects.toThrow("过期");
    await expect(prepare("install", { ...input, app: f.appRef }, "one")).rejects.toThrow("参数无效");
    await expect(prepare("install", { ...input, app: f.models, models: f.app }, "one")).rejects.toThrow("请先填写");
    await expect(prepare("install", { ...input, directory: "saved" }, "one")).rejects.toThrow("通讯录");
    await expect(prepare("install", { ...input, env: {} }, "one")).rejects.toThrow("未允许");
  } finally { await f.cleanup(); }
});

test("暂存网页草稿：只给绑定到本任务的首次部署，写成配置向导的暂存格式且摘要与确认一致；部门核对用暂存的应用配置", async () => {
  const f = await fixture();
  try {
    const stage = join(f.root, "tmp/stage"), task = "task-" + "c".repeat(32); mkdirSync(stage, { recursive: true });
    const env = { MIXIN_OPS_CONSOLE: "1", MIXIN_OPS_LIFECYCLE: "install", MIXIN_OPS_TASK_ID: task,
      MIXIN_OPS_APP_DRAFT: `${f.appRef.draft}:${f.appRef.digest}`, MIXIN_OPS_MODELS_DRAFT: `${f.modelsRef.draft}:${f.modelsRef.digest}` };
    expect(() => stageConsoleConfiguration(f.root, stage, env)).toThrow("不属于这个任务");
    const request = { operation: "install", params: { app: f.appRef, models: f.modelsRef } };
    expect(taskDrafts(request)).toEqual([f.appRef, f.modelsRef]);
    for (const { draft, digest } of taskDrafts(request)) f.drafts.bind(draft, digest, task);
    expect(() => stageConsoleConfiguration(f.root, stage, { ...env, MIXIN_OPS_LIFECYCLE: "deploy" })).toThrow("首次部署");
    expect(() => stageConsoleConfiguration(f.root, stage, { ...env, MIXIN_OPS_APP_DRAFT: `${f.appRef.draft}:${"0".repeat(64)}` })).toThrow("在线校验");
    expect(() => stageConsoleConfiguration(f.root, stage, { ...env, MIXIN_OPS_MODELS_DRAFT: "" })).toThrow("草稿");
    rmSync(join(stage, "configuration-app.json"), { force: true });
    const written = stageConsoleConfiguration(f.root, stage, env);
    expect(written.map(path => basename(path))).toEqual(["configuration-app.json", "configuration-models.json"]);
    const app = parseConfigurationStage(readFileSync(written[0]!, "utf8"), "app");
    expect(configurationDigest(app)).toBe(f.appRef.digest);
    expect(configurationDigest(parseConfigurationStage(readFileSync(written[1]!, "utf8"), "models"))).toBe(f.modelsRef.digest);
    expect(() => stageConsoleConfiguration(f.root, stage, env), "never overwrites").toThrow();
    // The departments were read with this application: the hash the console confirmed is the staged text's.
    const choice = { departments: ["d1"], names: ["合成研发"], appHash: sha(app.next.files.app!) };
    const selected = { MIXIN_OPS_CONSOLE: "1", MIXIN_OPS_TASK_ID: task, MIXIN_OPS_DIRECTORY: "selected", MIXIN_OPS_DIRECTORY_INPUT: directoryChoiceText(choice),
      MIXIN_OPS_DIRECTORY_APP: choice.appHash };
    expect(consoleDirectoryScope(f.root, selected, app.next.files.app!)).toEqual({ kind: "departments", departments: ["d1"] });
    expect(() => consoleDirectoryScope(f.root, selected)).toThrow();
  } finally { await f.cleanup(); }
});
