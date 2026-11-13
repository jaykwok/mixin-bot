// The health check all three platforms share (ops/core/doctor.ts): rows, wording, the `doctor --json` shape and the lines
// the entries print. The hosts' probes are facts here; ops.sh is run with its probes replaced, ops.ps1 in
// platform-command.test.ts, the LaunchDaemon in macos-entry.test.ts.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { commandHint } from "../../ops/core/command-hint.ts";
import { doctorLines, doctorReport, linuxRows, main, savedPort, windowsRows, type DoctorInput, type DoctorReport, type DoctorRow } from "../../ops/core/doctor.ts";
import { tempFixture } from "../helpers/temp.ts";

const source = fileURLToPath(new URL("../../", import.meta.url));
const cli = (platform: "linux" | "windows" | "macos") => (command: string) => commandHint(platform, command, {});
const input = (project: string, over: Partial<DoctorInput> = {}): DoctorInput =>
  ({ platform: "linux", project, port: 10000, workspaceRoot: "", local: 0, service: [], healthFix: "按平台处理", models: "valid", env: {}, ...over });
const named = (report: DoctorReport | DoctorRow[]) => Object.fromEntries((Array.isArray(report) ? report : report.checks).map(item => [item.name, item]));
const noProbe = { status: async (): Promise<string[]> => { throw new Error("no service"); }, program: async () => undefined };

/** A project with the files a healthy deployment has. */
async function deployed(root: string): Promise<void> {
  await mkdir(join(root, "data/config"), { recursive: true });
  await mkdir(join(root, "data/state"), { recursive: true });
  await writeFile(join(root, "data/config/app-bot.json"), "{}");
  await writeFile(join(root, "data/state/data-version.json"), JSON.stringify({ dataVersion: 5, appVersion: "2.0.0", build: "abcdef1234567890" }));
}

test("命令提示：控制台里指向页面，终端里是各平台自己的命令；没有页面的命令在控制台里也给命令", () => {
  expect(commandHint("linux", "deploy", {})).toBe("scripts/ops.sh deploy");
  expect(commandHint("windows", "doctor -Repair", {})).toBe("scripts\\ops.ps1 doctor -Repair");
  expect(commandHint("macos", "doctor --repair", {})).toBe("sudo bash scripts/ops.sh doctor --repair");
  const console = { MIXIN_OPS_UI: "console" };
  for (const platform of ["linux", "windows", "macos"] as const) {
    expect(commandHint(platform, "logs", console)).toBe("「日志」");
    expect(commandHint(platform, "resume", console)).toBe("「维护 → 继续上次操作」");
    expect(commandHint(platform, "relay-configure", console)).toBe("「设置 → 外链配置」");
  }
  expect(commandHint("linux", "uninstall", console)).toBe("scripts/ops.sh uninstall");
  expect(commandHint("linux", "constructor", console)).toBe("scripts/ops.sh constructor");
});

test("三个平台的体检是同一份结构：五个键，每行四个键，通过的行没有建议，计数与行一致", async () => {
  const f = await tempFixture("doctor-contract-");
  try {
    await deployed(f.root);
    const windows = windowsRows({ task: { state: "Running", logon: "S4U", lastResult: 267009 }, listeners: [42], botPids: [42] }, 200, 10000, cli("windows"));
    const linux = linuxRows({ container: "running", rollback: "" }, cli("linux"));
    for (const [platform, service] of [["linux", linux], ["windows", windows], ["macos", { rows: [], healthFix: "x" }]] as const) {
      for (const local of [200, 503, 0] as const) {
        const report = await doctorReport(input(f.root, { platform, local, service: [...service.rows], healthFix: service.healthFix,
          probe: { status: async () => ["pass\t事件 Stream\t已连接 3 分钟", "warn\t通讯录同步\t正在应用"], program: async () => ({ appVersion: "2.0.0", build: "abcdef1234567890" }) } }));
        expect(Object.keys(report)).toEqual(["pass", "warn", "fail", "port", "checks"]);
        expect(JSON.stringify(report)).not.toContain("\n");
        for (const item of report.checks) {
          expect(Object.keys(item)).toEqual(["name", "status", "detail", "fix"]);
          expect(["pass", "warn", "fail"]).toContain(item.status);
          if (item.status === "pass") expect(item.fix).toBe("");
        }
        for (const status of ["pass", "warn", "fail"] as const) expect(report[status]).toBe(report.checks.filter(item => item.status === status).length);
        expect(report.checks.some(item => item.name === "事件 Stream")).toBe(local === 200);
      }
    }
  } finally { await f.cleanup(); }
});

test("Linux：容器运行才通过，其余状态原样显示；留下的回滚容器是失败", () => {
  const rows = (container: string, rollback = "") => named(linuxRows({ container, rollback }, cli("linux")).rows);
  expect(rows("running")["容器"]).toEqual({ name: "容器", status: "pass", detail: "运行中", fix: "" });
  expect(rows("exited")["容器"]).toMatchObject({ status: "fail", detail: "已退出", fix: "使用 scripts/ops.sh start；尚未部署时请使用 scripts/ops.sh deploy。" });
  expect(rows("")["容器"]).toMatchObject({ status: "fail", detail: "缺少" });
  expect(rows("paused")["容器"]).toMatchObject({ status: "fail", detail: "paused" });
  expect(rows("running")["部署回滚容器"]).toMatchObject({ status: "pass", detail: "无" });
  expect(rows("running", "mixin-bot-rollback")["部署回滚容器"]).toMatchObject({ status: "fail", detail: "发现 mixin-bot-rollback，请确认后恢复或删除" });
  expect(linuxRows({ container: "", rollback: "" }, cli("linux")).healthFix).toBe("使用 scripts/ops.sh restart，再到 scripts/ops.sh logs 查看日志。");
});

test("Windows：计划任务、监听进程和无应答时的建议按任务状态与本机应答组合", () => {
  const hint = cli("windows"), ready = { state: "Ready", logon: "S4U", lastResult: -2147020576 };
  const rows = (service: Parameters<typeof windowsRows>[0], local: 200 | 503 | 0) => {
    const result = windowsRows(service, local, 10000, hint);
    return { ...named(result.rows), healthFix: result.healthFix } as Record<string, DoctorRow> & { healthFix: string };
  };
  // No task: a healthy foreground bot is a warning, nothing running is a failure.
  expect(rows({ task: null, listeners: [42], botPids: [42] }, 200)["计划任务"]).toMatchObject({ status: "warn", detail: "未安装；机器人当前以前台方式运行" });
  expect(rows({ task: null, listeners: [], botPids: [] }, 0)["计划任务"]).toMatchObject({ status: "fail", detail: "缺少，且没有健康的前台机器人", fix: "请以管理员身份使用 scripts\\ops.ps1 deploy。" });
  expect(rows({ task: null, listeners: [42], botPids: [] }, 200)["计划任务"]).toMatchObject({ status: "fail" });
  // The task: state and logon in Chinese, the last result as the unsigned code Task Scheduler shows.
  expect(rows({ task: { state: "Running", logon: "S4U", lastResult: 267009 }, listeners: [42], botPids: [42] }, 200)["计划任务"])
    .toEqual({ name: "计划任务", status: "pass", detail: "运行中，S4U（无需登录），上次结果 0x00041301", fix: "" });
  expect(rows({ task: { state: "Disabled", logon: "InteractiveToken" }, listeners: [], botPids: [] }, 0)["计划任务"])
    .toMatchObject({ status: "fail", detail: "已禁用，交互式登录", fix: "使用 scripts\\ops.ps1 start，会启用计划任务并启动机器人。" });
  expect(rows({ task: { state: "Queued", logon: "" }, listeners: [], botPids: [] }, 0)["计划任务"].detail).toBe("排队中，未知登录方式；机器人没有运行");
  expect(rows({ task: { state: "Odd", logon: "Password", lastResult: 0 }, listeners: [], botPids: [] }, 0)["计划任务"].detail).toBe("Odd，Password，上次结果 0x00000000；机器人没有运行");
  expect(rows({ task: ready, listeners: [42], botPids: [42] }, 200)["计划任务"]).toMatchObject({ status: "warn", detail: "就绪，S4U（无需登录），上次结果 0x800710E0；机器人可能在任务外运行" });
  // A task that is there but not running, with nothing answering: mostly a deliberate stop, so every row says both ways out.
  const stopped = rows({ task: ready, listeners: [], botPids: [] }, 0);
  const both = "有意停止的使用 scripts\\ops.ps1 start 启动；意外退出时先在 scripts\\ops.ps1 logs 查看日志，再使用 scripts\\ops.ps1 doctor -Repair。";
  expect(stopped["计划任务"]).toMatchObject({ status: "fail", fix: both });
  expect(stopped["机器人监听 :10000"]).toMatchObject({ status: "fail", detail: "没有监听", fix: both });
  expect(stopped.healthFix).toBe(both);
  // The verification-only instance answers: not a stop.
  expect(rows({ task: ready, listeners: [], botPids: [] }, 503)["机器人监听 :10000"].fix).toBe("使用 scripts\\ops.ps1 doctor -Repair。");
  expect(rows({ task: null, listeners: [], botPids: [] }, 0).healthFix).toBe("使用 scripts\\ops.ps1 doctor -Repair，再到 scripts\\ops.ps1 logs 查看日志。");
  // The listener: this project's bot, a healthy answer from a process not recognised, or somebody else's process.
  expect(rows({ task: null, listeners: [7, 42], botPids: [42, 43] }, 200)["机器人监听 :10000"]).toMatchObject({ status: "pass", detail: "pid 42（mixin-bot）" });
  expect(rows({ task: null, listeners: [7, 8], botPids: [42] }, 200)["机器人监听 :10000"]).toMatchObject({ status: "warn", detail: "pid 7, 8；健康检查有响应但未识别进程身份" });
  expect(rows({ task: null, listeners: [7], botPids: [] }, 0)["机器人监听 :10000"]).toMatchObject({ status: "fail", detail: "pid 7 不是健康的 mixin-bot" });
});

test("共享资料目录、本机健康、应用凭据和模型配置：每种状态一行，建议指向当前平台", async () => {
  const f = await tempFixture("doctor-rows-");
  try {
    const empty = named(await doctorReport(input(f.root, { models: "missing" })));
    expect(empty["共享资料目录"]).toMatchObject({ status: "pass", detail: `${join(f.root, "workspace")}（默认）` });
    expect(empty["本地机器人健康"]).toMatchObject({ status: "fail", detail: "未就绪或实例身份不匹配", fix: "按平台处理" });
    expect(empty["data/config/app-bot.json"]).toMatchObject({ status: "fail", detail: "缺少（服务拒绝启动）", fix: "使用 scripts/ops.sh configure-app-bot 填写 AppID 和 AppSecret。" });
    expect(empty["模型配置（models.json + Pi 设置）"]).toMatchObject({ status: "fail", detail: "缺少或无效", fix: "通过 scripts/ops.sh deploy 完成首次模型配置。" });
    expect(empty["应用机器人"]).toMatchObject({ status: "pass", detail: "尚未部署" });
    expect(empty["事件 Stream"]).toBeUndefined();

    await deployed(f.root);
    const external = join(f.root, "materials");
    const missing = named(await doctorReport(input(f.root, { platform: "windows", workspaceRoot: external, local: 503, models: "busy" })));
    expect(missing["共享资料目录"]).toMatchObject({ status: "fail", detail: `外置目录不存在：${external}`, fix: expect.stringContaining("WORKSPACE_ROOT=<目录> 后使用 scripts\\ops.ps1 deploy") });
    expect(missing["本地机器人健康"]).toMatchObject({ status: "fail", detail: "只验证实例，不处理消息", fix: "使用 scripts\\ops.ps1 resume 继续上次操作并完成提交。" });
    expect(missing["模型配置（models.json + Pi 设置）"]).toMatchObject({ status: "fail", detail: "部署、升级或运维操作尚未完成，未检查",
      fix: "完成或回滚上次操作（scripts\\ops.ps1 resume / scripts\\ops.ps1 rollback）后重新体检。" });
    expect(missing["data/config/app-bot.json"]).toMatchObject({ status: "pass", detail: "已配置（不显示凭据）" });
    expect(missing["应用机器人"]).toMatchObject({ status: "pass", detail: "v2.0.0（未运行，取自部署记录）" });
    expect(missing["事件 Stream"]).toBeUndefined();

    await mkdir(external);
    const invalid = named(await doctorReport(input(f.root, { workspaceRoot: external, models: "invalid" })));
    expect(invalid["共享资料目录"]).toMatchObject({ status: "pass", detail: `${external}（外置，只读）` });
    expect(invalid["模型配置（models.json + Pi 设置）"]).toMatchObject({ status: "fail", detail: "缺少或无效", fix: "先修正 data/config/models.json 与 data/runtime/pi/settings.json。" });
    expect(named(await doctorReport(input(f.root)))["模型配置（models.json + Pi 设置）"]).toMatchObject({ status: "pass", detail: "有效", fix: "" });
  } finally { await f.cleanup(); }
});

test("运行中的服务：Stream、通讯录和运行状况的行来自 /health，建议按行给出；读不到时是一条警告；版本取运行中的程序", async () => {
  const f = await tempFixture("doctor-service-");
  try {
    await deployed(f.root);
    const status = ["pass\t事件 Stream\t已连接 3 分钟", "warn\t通讯录同步\t范围状态：正在应用，完成前之前的范围（整个通讯录）仍然生效", "warn\t运行状况\t自本次启动：交付超时放弃 1 次",
      "odd\t事件 Stream 备用\t未知状态", "pass\t\t没有名称"];
    for (const ui of ["console", "cli"] as const) {
      const web = ui === "console";
      const report = await doctorReport(input(f.root, { platform: "windows", local: 200, env: { MIXIN_OPS_UI: ui },
        probe: { status: async () => status, program: async () => ({ appVersion: "2.1.0", build: "1234567890abcdef" }) } }));
      const rows = named(report);
      expect(rows["本地机器人健康"]).toEqual({ name: "本地机器人健康", status: "pass", detail: "就绪且实例身份匹配", fix: "" });
      expect(rows["事件 Stream"]).toEqual({ name: "事件 Stream", status: "pass", detail: "已连接 3 分钟", fix: "" });
      expect(rows["通讯录同步"]).toMatchObject({ status: "warn", detail: "范围状态：正在应用，完成前之前的范围（整个通讯录）仍然生效" });
      expect(rows["通讯录同步"]!.fix).toContain(web ? "用 「通讯录」 查看范围状态" : "用 scripts\\ops.ps1 directory 查看范围状态");
      expect(rows["运行状况"]!.fix).toContain(web ? "在 「日志」 中查看对应记录" : "在 scripts\\ops.ps1 logs 中查看对应记录");
      // A status this version does not know is a failure, never a pass; a row without a name is dropped.
      expect(rows["事件 Stream 备用"]).toMatchObject({ status: "fail", detail: "未知状态", fix: "" });
      expect(report.checks.some(item => item.detail === "没有名称")).toBe(false);
      // The running program, not the deployment record (2.0.0).
      expect(rows["应用机器人"]).toMatchObject({ status: "pass", detail: "v2.1.0" });
      expect(rows["构建"]).toMatchObject({ status: "pass", detail: "1234567" });
      if (web) expect(JSON.stringify(report)).not.toMatch(/ops\.ps1|ops\.sh|bun run/);
    }
    const unreadable = named(await doctorReport(input(f.root, { local: 200, probe: noProbe })));
    expect(unreadable["事件 Stream"]).toMatchObject({ status: "warn", detail: "无法读取服务状态", fix: "查看 scripts/ops.sh logs。" });
    expect(unreadable["应用机器人"]).toMatchObject({ status: "pass", detail: "v2.0.0（未运行，取自部署记录）" });
    // An unreadable deployment record fails the check and warns against deploying over it.
    await writeFile(join(f.root, "data/state/data-version.json"), "{");
    const damaged = named(await doctorReport(input(f.root)));
    expect(damaged["应用机器人"]).toMatchObject({ status: "fail", detail: expect.stringMatching(/^未知：/), fix: expect.stringContaining("不要在此目录覆盖部署") });
  } finally { await f.cleanup(); }
});

test("S3 外链：没有配置时没有这一行；必填项缺一项即失败，齐全即通过，输出里没有凭据", async () => {
  const f = await tempFixture("doctor-relay-");
  try {
    await deployed(f.root);
    const path = join(f.root, "data/config/relay.json"), complete = { provider: "s3", endpoint: "https://s3.example.test", region: "test", bucket: "bucket",
      accessKeyId: "do-not-print-ak", secretAccessKey: "do-not-print-secret" };
    const relay = async () => (await doctorReport(input(f.root, { env: { MIXIN_OPS_UI: "console" } }))).checks.filter(item => /relay|外链/.test(item.name));
    expect(await relay()).toEqual([]);
    for (const state of ["provider", "endpoint", "region", "bucket", "accessKeyId", "secretAccessKey"] as const) {
      for (const value of ["", "   ", 7, null]) {
        await writeFile(path, JSON.stringify({ ...complete, [state]: value }));
        const rows = await relay();
        expect(rows, `${state}=${JSON.stringify(value)}`).toEqual([{ name: "data/config/relay.json", status: "fail", detail: "S3 必填项不全", fix: "使用 「设置 → 外链配置」 重新配置。" }]);
      }
    }
    for (const text of ["{", "[]", "null", '"s3"', JSON.stringify({ ...complete, provider: "oss" })]) {
      await writeFile(path, text);
      expect((await relay())[0], text).toMatchObject({ name: "data/config/relay.json", status: "fail" });
    }
    await writeFile(path, JSON.stringify(complete));
    expect(await relay()).toEqual([{ name: "S3 外链配置必填项", status: "pass", detail: "必填项齐全；启动时执行完整格式校验", fix: "" }]);
    expect(JSON.stringify(await doctorReport(input(f.root)))).not.toContain("do-not-print");
  } finally { await f.cleanup(); }
});

test("终端输出：标题、逐行结果、统计、去重后的建议，失败时给本平台的修复入口", () => {
  const report: DoctorReport = { pass: 1, warn: 1, fail: 2, port: 10000, checks: [
    { name: "容器", status: "fail", detail: "已退出", fix: "启动它" }, { name: "容器", status: "fail", detail: "已退出", fix: "启动它" },
    { name: "通讯录同步", status: "warn", detail: "正在应用", fix: "" }, { name: "应用机器人", status: "pass", detail: "v2.0.0", fix: "" }] };
  const lines = doctorLines(report, "linux", {});
  expect(lines[0]).toEqual({ level: "step", text: "mixin-bot 健康检查（本机端口=10000）" });
  expect(lines.slice(1, 5).map(line => line.level)).toEqual(["fail", "fail", "warn", "pass"]);
  expect(lines[1]!.text).toBe(`${"容器".padEnd(26)} 已退出`);
  const text = lines.map(line => line.text);
  expect(text).toContain("结果：1 项通过，1 项警告，2 项失败");
  expect(text.filter(line => line === "  - 容器: 启动它")).toHaveLength(1);
  expect(text.some(line => line.includes("通讯录同步:"))).toBe(false);
  expect(lines.at(-1)).toEqual({ level: "warn", text: "可尝试修复：scripts/ops.sh repair" });
  expect(doctorLines(report, "windows", {}).at(-1)!.text).toBe("可尝试修复：scripts\\ops.ps1 doctor -Repair");
  expect(doctorLines(report, "macos", {}).at(-1)!.text).toBe("可尝试修复：sudo bash scripts/ops.sh doctor --repair");
  for (const platform of ["linux", "windows", "macos"] as const)
    expect(doctorLines(report, platform, { MIXIN_OPS_UI: "console" }).at(-1)!.text).toBe("可尝试修复：「维护 → 修复部署」");
  const warned = doctorLines({ ...report, fail: 0, checks: report.checks.slice(2) }, "linux", {});
  expect(warned.at(-1)).toEqual({ level: "warn", text: "必需检查已通过，但仍有警告" });
  expect(warned.some(line => line.text === "建议操作：")).toBe(false);
  expect(doctorLines({ pass: 1, warn: 0, fail: 0, port: 1, checks: report.checks.slice(3) }, "linux", {}).at(-1)).toEqual({ level: "pass", text: "全部检查通过" });
});

test("已保存的端口：环境变量优先，其次 data/state/bot-port，都没有时 10000；无效值报错", async () => {
  const f = await tempFixture("doctor-port-");
  try {
    expect(savedPort(f.root, {})).toBe(10000);
    await mkdir(join(f.root, "data/state"), { recursive: true });
    await writeFile(join(f.root, "data/state/bot-port"), "18080\n");
    expect(savedPort(f.root, {})).toBe(18080);
    expect(savedPort(f.root, { BOT_PORT: "65535" })).toBe(65535);
    for (const value of ["0", "65536", "80a", "-1", "1e3"]) expect(() => savedPort(f.root, { BOT_PORT: value }), value).toThrow("端口无效");
  } finally { await f.cleanup(); }
});

test("入口：宿主事实经环境变量传入，json 是一行，lines 是“级别<TAB>文字”；有失败退出 1，参数或事实不可用退出 2", async () => {
  const f = await tempFixture("doctor-main-");
  try {
    await deployed(f.root);
    const run = async (argv: string[], env: Record<string, string>) => {
      let text = "";
      const code = await main(argv, env, part => { text += part; }, () => {});
      return { code, text };
    };
    const facts = { MIXIN_DOCTOR_PORT: "18080", MIXIN_DOCTOR_LOCAL: "0", MIXIN_DOCTOR_MODELS: "valid" };
    const linux = await run(["--platform", "linux", "--project", f.root, "--format", "json"], { ...facts, MIXIN_DOCTOR_CONTAINER: "exited", MIXIN_DOCTOR_ROLLBACK: "mixin-bot-rollback" });
    expect(linux.code).toBe(1);
    expect(linux.text.endsWith("\n")).toBe(true);
    expect(linux.text.trim().split("\n")).toHaveLength(1);
    const report = JSON.parse(linux.text) as DoctorReport;
    expect(report.port).toBe(18080);
    expect(named(report)["容器"]).toMatchObject({ status: "fail", detail: "已退出" });
    expect(named(report)["部署回滚容器"]).toMatchObject({ status: "fail" });
    expect(named(report)["计划任务"]).toBeUndefined();

    const windows = await run(["--platform", "windows", "--project", f.root], { ...facts, MIXIN_OPS_UI: "console", MIXIN_DOCTOR_LOCAL: "503", MIXIN_DOCTOR_WORKSPACE: join(f.root, "absent"),
      MIXIN_DOCTOR_TASK: "Ready", MIXIN_DOCTOR_TASK_LOGON: "S4U", MIXIN_DOCTOR_TASK_RESULT: "2147946720", MIXIN_DOCTOR_LISTENERS: "7, 8,x", MIXIN_DOCTOR_BOT_PIDS: "9" });
    expect(windows.code).toBe(1);
    const lines = windows.text.trimEnd().split("\n").map(line => line.split("\t"));
    for (const parts of lines) { expect(parts).toHaveLength(2); expect(["step", "pass", "warn", "fail", "plain"]).toContain(parts[0]!); }
    expect(lines[0]).toEqual(["step", "mixin-bot 健康检查（本机端口=18080）"]);
    expect(windows.text).toContain("就绪，S4U（无需登录），上次结果 0x800710E0；机器人没有运行");
    expect(windows.text).toContain("pid 7, 8 不是健康的 mixin-bot");
    expect(windows.text).toContain("只验证实例，不处理消息");
    expect(windows.text).toContain("外置目录不存在");
    expect(lines.at(-1)).toEqual(["warn", "可尝试修复：「维护 → 修复部署」"]);

    // Healthy facts with no service to read: nothing fails (the unreadable status is a warning).
    await mkdir(join(f.root, "data/state"), { recursive: true });
    const healthy = await run(["--platform", "linux", "--project", f.root, "--format", "json"], { ...facts, MIXIN_DOCTOR_LOCAL: "200", MIXIN_DOCTOR_CONTAINER: "running" });
    expect(healthy.code).toBe(0);
    expect((JSON.parse(healthy.text) as DoctorReport).fail).toBe(0);

    for (const [argv, env] of [
      [["--platform", "macos", "--project", f.root], facts], [["--platform", "linux"], facts], [["--platform", "linux", "--project", f.root, "--format", "text"], facts],
      [["--platform", "linux", "--project", f.root, "--bogus"], facts],
      [["--platform", "linux", "--project", f.root], { ...facts, MIXIN_DOCTOR_LOCAL: "" }], [["--platform", "linux", "--project", f.root], { ...facts, MIXIN_DOCTOR_LOCAL: "404" }],
      [["--platform", "linux", "--project", f.root], { ...facts, MIXIN_DOCTOR_MODELS: "ok" }], [["--platform", "linux", "--project", f.root], { ...facts, MIXIN_DOCTOR_PORT: "70000" }],
      [["--platform", "linux", "--project", f.root], { MIXIN_DOCTOR_PORT: "18080", MIXIN_DOCTOR_MODELS: "valid" }],
    ] as [string[], Record<string, string>][]) {
      const refused = await run(argv, env);
      expect(refused.code, argv.join(" ") + JSON.stringify(env)).toBe(2);
      expect(refused.text).toBe("");
    }
  } finally { await f.cleanup(); }
});

// ops.sh: the real `doctor` function with the host probes replaced, handing its facts to the real core.
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const forward = (path: string) => path.replaceAll("\\", "/");
test.skipIf(!bash || !existsSync(bash))("ops.sh 体检：容器、健康检查和模型校验的结果作为事实交给核心；--json 原样转交，终端按级别输出；没有 Bun 时只报告这一项", async () => {
  const f = await tempFixture("doctor-ops-sh-");
  try {
    await deployed(f.root);
    await writeFile(join(f.root, "data/config/models.json"), "{}");
    const script = (await readFile(join(source, "scripts/ops.sh"), "utf8")).replaceAll("\r\n", "\n");
    const fn = (name: string) => {
      const start = script.indexOf(`\n${name}() {\n`), end = script.indexOf("\n}\n", start);
      expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
      return script.slice(start + 1, end + 3);
    };
    const runner = join(f.root, "doctor.sh");
    await writeFile(runner, ["#!/usr/bin/env bash", "set -u",
      'PORT=18080; DEPLOYED_WORKSPACE_ROOT=""; CONTAINER=mixin-bot; ROLLBACK_CONTAINER=mixin-bot-rollback',
      'PROJECT_DIR="$T_PROJECT"; OPS_SOURCE_DIR="$T_SOURCE"; MODELS_FILE="$PROJECT_DIR/data/config/models.json"; JSON_OUTPUT="$T_JSON"',
      'P() { echo "[*] $1"; }; OK() { echo "[+] $1"; }; WA() { echo "[!] $1"; }; ER() { echo "[x] $1"; }',
      'has_container() { [ -n "$T_CONTAINER" ]; }', 'has_rollback_container() { [ "$T_ROLLBACK" = 1 ]; }', 'docker() { printf "%s\\n" "$T_CONTAINER"; }',
      'bot_local_ready() { return "$T_HEALTH"; }', 'deployment_in_progress() { [ "$T_BUSY" = 1 ]; }', 'validate_model_configuration() { [ "$T_MODELS" = 1 ]; }',
      'ops_bun_present() { [ -n "$T_BUN" ] && printf "%s\\n" "$T_BUN"; }',
      'ops_command_hint() { printf "scripts/ops.sh %s" "$1"; }',
      fn("json_escape"), fn("doctor_unavailable"), fn("doctor"), "doctor", "exit $?", ""].join("\n"));
    const run = async (env: Record<string, string>) => {
      const child = Bun.spawn([bash!, "--noprofile", "--norc", forward(runner)], { cwd: f.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
        env: { ...process.env, MIXIN_OPS_UI: "cli", T_PROJECT: forward(f.root), T_SOURCE: forward(source), T_BUN: forward(process.execPath), T_JSON: "1", T_CONTAINER: "running",
          T_ROLLBACK: "0", T_HEALTH: "0", T_BUSY: "0", T_MODELS: "1", ...env } });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr };
    };
    const healthy = await run({});
    expect(healthy.code, healthy.stdout + healthy.stderr).toBe(0);
    expect(healthy.stdout.trim().split("\n")).toHaveLength(1);
    const report = JSON.parse(healthy.stdout) as DoctorReport, rows = named(report);
    expect(Object.keys(report)).toEqual(["pass", "warn", "fail", "port", "checks"]);
    expect(report.port).toBe(18080);
    expect(rows["容器"]).toMatchObject({ status: "pass", detail: "运行中" });
    expect(rows["本地机器人健康"]).toMatchObject({ status: "pass" });
    expect(rows["模型配置（models.json + Pi 设置）"]).toMatchObject({ status: "pass" });

    // The health check's exit code 3 is the verification-only instance; a busy deployment skips the model check.
    const verifying = await run({ T_HEALTH: "3", T_BUSY: "1", T_MODELS: "0", T_ROLLBACK: "1", T_CONTAINER: "exited" });
    expect(verifying.code).toBe(1);
    const second = named(JSON.parse(verifying.stdout) as DoctorReport);
    expect(second["本地机器人健康"]).toMatchObject({ detail: "只验证实例，不处理消息", fix: "使用 scripts/ops.sh resume 继续上次操作并完成提交。" });
    expect(second["模型配置（models.json + Pi 设置）"]).toMatchObject({ status: "fail", detail: "部署、升级或运维操作尚未完成，未检查" });
    expect(second["容器"]).toMatchObject({ status: "fail", detail: "已退出" });
    expect(second["部署回滚容器"]).toMatchObject({ status: "fail" });

    const printed = await run({ T_JSON: "0", T_HEALTH: "1", T_CONTAINER: "", T_MODELS: "0" });
    expect(printed.code).toBe(1);
    const lines = printed.stdout.split("\n");
    expect(lines[0]).toBe("[*] mixin-bot 健康检查（本机端口=18080）");
    expect(lines.some(line => line.startsWith("[x] 容器") && line.endsWith("缺少"))).toBe(true);
    expect(lines.some(line => line.startsWith("[+] 共享资料目录"))).toBe(true);
    expect(lines.some(line => line.startsWith("[x] 模型配置") && line.endsWith("缺少或无效"))).toBe(true);
    expect(lines).toContain("结果：6 项通过，0 项警告，3 项失败");
    expect(lines).toContain("建议操作：");
    expect(lines).toContain("  - 容器: 使用 scripts/ops.sh start；尚未部署时请使用 scripts/ops.sh deploy。");
    expect(lines).toContain("[!] 可尝试修复：scripts/ops.sh repair");
    expect(printed.stdout).not.toMatch(/^(step|pass|warn|fail|plain)\t/m);

    const noRuntime = await run({ T_BUN: "" });
    expect(noRuntime.code).toBe(1);
    const single = JSON.parse(noRuntime.stdout) as DoctorReport;
    expect(single).toMatchObject({ pass: 0, warn: 0, fail: 1, port: 18080 });
    expect(single.checks).toEqual([{ name: "宿主机 Bun", status: "fail", detail: "没有可用的 Bun 1.4.4 或更高版本，未体检", fix: expect.stringContaining("https://bun.sh/docs/installation") }]);
    const noRuntimePrinted = await run({ T_BUN: "", T_JSON: "0" });
    expect(noRuntimePrinted.code).toBe(1);
    expect(noRuntimePrinted.stdout).toContain("[x] 宿主机 Bun：没有可用的 Bun 1.4.4 或更高版本，未体检");
    // A core that cannot run (its file is gone) is the same one-row result, never an empty answer.
    const noCore = await run({ T_SOURCE: forward(join(f.root, "absent")) });
    expect(noCore.code).toBe(1);
    expect(noCore.stdout.trim().split("\n")).toHaveLength(1);
    expect((JSON.parse(noCore.stdout) as DoctorReport).checks).toEqual([{ name: "体检", status: "fail", detail: expect.stringMatching(/^体检核心没有给出结果（退出码 \d+），未体检$/),
      fix: "确认代码目录完整后重试；scripts/ops.sh deploy 可重建部署。" }]);
    expect((await run({ T_SOURCE: forward(join(f.root, "absent")), T_JSON: "0" })).stdout).toContain("[x] 体检：体检核心没有给出结果");
  } finally { await f.cleanup(); }
}, 60_000);

// ops-runtime.sh: the read-only commands use the Bun the host already has. GNU stat and sha256sum: Linux only, like the script.
test.skipIf(process.platform !== "linux")("ops_bun_present：只用宿主机已有的 Bun（任务指定的、PATH 中的、部署保存的固定版本），不下载也不创建目录", async () => {
  const f = await tempFixture("doctor-runtime-");
  try {
    const { chmod, copyFile } = await import("node:fs/promises");
    const { basename, dirname } = await import("node:path");
    const library = join(source, "scripts/lib/ops-runtime.sh"), own = dirname(process.execPath);
    const run = async (command: string, env: Record<string, string>) => {
      const child = Bun.spawn(["bash", "--noprofile", "--norc", "-c", `. "$T_LIB"; PROJECT_DIR="$T_PROJECT"; ${command}`], { cwd: f.root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: { HOME: f.root, PATH: "/usr/bin:/bin", T_LIB: library, T_PROJECT: f.root, ...env } });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout: stdout.trim(), stderr };
    };
    // The task's runtime, and nothing else when it is unusable.
    expect(await run("ops_bun_present", { MIXIN_OPS_BUN: process.execPath })).toMatchObject({ code: 0, stdout: process.execPath });
    expect(await run("ops_bun_present", { MIXIN_OPS_BUN: join(f.root, "absent"), PATH: `${own}:/usr/bin:/bin` })).toMatchObject({ code: 1, stdout: "" });
    if (basename(process.execPath) === "bun") expect(await run("ops_bun_present", { PATH: `${own}:/usr/bin:/bin` })).toMatchObject({ code: 0, stdout: process.execPath });
    if (existsSync("/usr/bin/bun") || existsSync("/bin/bun")) return;
    // Nothing on PATH and nothing saved: no runtime, and nothing was created or downloaded.
    expect(await run("ops_bun_present", {})).toMatchObject({ code: 1, stdout: "" });
    expect(existsSync(join(f.root, ".console"))).toBe(false);
    // The pinned runtime a deployment saved: private directories, the recorded source and digest, a usable binary.
    const asset = await run("ops_bun_asset", {});
    expect(asset.code, asset.stderr).toBe(0);
    const [name] = asset.stdout.split(" "), saved = join(f.root, ".console/bun", `1.4.4-${name}`);
    await mkdir(saved, { recursive: true });
    for (const directory of [join(f.root, ".console"), join(f.root, ".console/bun"), saved]) await chmod(directory, 0o700);
    await copyFile(process.execPath, join(saved, "bun"));
    await chmod(join(saved, "bun"), 0o700);
    const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(join(saved, "bun")).arrayBuffer()).digest("hex");
    await writeFile(join(saved, "bun.sha256"), digest + "\n");
    await writeFile(join(saved, "source"), asset.stdout + "\n");
    expect(await run("ops_bun_present", {})).toMatchObject({ code: 0, stdout: join(saved, "bun") });
    // A directory others can enter, or a binary that is not the recorded one, is not used.
    await chmod(saved, 0o755);
    expect(await run("ops_bun_present", {})).toMatchObject({ code: 1, stdout: "" });
    await chmod(saved, 0o700);
    await writeFile(join(saved, "bun.sha256"), "0".repeat(64) + "\n");
    expect(await run("ops_bun_present", {})).toMatchObject({ code: 1, stdout: "" });
  } finally { await f.cleanup(); }
}, 60_000);
