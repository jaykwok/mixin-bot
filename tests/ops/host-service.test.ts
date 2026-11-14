import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HostServiceChanged, hostService, removeHostService } from "../../ops/core/host-service.ts";
import { LAUNCHD_LABEL, SERVICE_ACCOUNT } from "../../ops/core/launchd-host.ts";
import type { Runner } from "../../ops/core/hosting.ts";
import type { NativeCommand, NativeRunner } from "../../ops/core/native-process.ts";
import { tempFixture } from "../helpers/temp.ts";

const silent = () => {};
const said = () => { const lines: string[] = []; return { lines, output: (text: string) => { lines.push(text); } }; };

/** Task Scheduler as the listing reports it; `native` answers windows-platform.ps1 the way the script does. */
function windowsHost(initial: Record<string, unknown> | null) {
  const host = { task: initial, identity: "9".repeat(64), owned: true, removed: [] as string[], requests: [] as Record<string, unknown>[] };
  const run: Runner = async argv => {
    if (argv[0] !== "powershell") throw new Error(`unexpected ${argv.join(" ")}`);
    return { code: 0, stdout: JSON.stringify(host.task) + "\n", stderr: "" };
  };
  const native: NativeRunner = async (command: NativeCommand) => {
    const request = JSON.parse(Buffer.from(command.args[command.args.indexOf("-RequestBase64") + 1]!, "base64").toString("utf8"));
    host.requests.push({ ...request, cwd: command.cwd, timeoutMs: command.timeoutMs });
    const value = request.action === "inspect" ? { identity: host.identity, owned: host.owned, state: host.task ? "running" : "absent", rawState: host.task ? "Running" : "absent" } : null;
    if (request.action === "remove") { if (request.expected !== host.identity) return { code: 1, stdout: "" }; host.removed.push(request.project); host.task = null; }
    return { code: 0, stdout: JSON.stringify({ protocol: "mixin-platform", version: 1, action: request.action, ok: true, value }) };
  };
  return { host, run, native };
}
const task = (directory: string, fields: Record<string, unknown> = {}) => ({ State: "Running", Path: "\\",
  Principal: { UserId: "SYSTEM", GroupId: null, LogonType: "ServiceAccount", RunLevel: "Highest" },
  Actions: [{ Execute: "powershell.exe", Arguments: "-File launcher.ps1", WorkingDirectory: directory }], ...fields });

test("Windows：任何目录的计划任务 mixin-bot 都列出来；确认的是定义而不是运行状态", async () => {
  const { host, run } = windowsHost(task("D:\\old\\mixin-bot"));
  const found = (await hostService("D:\\Projects\\mixin-bot", run, {}, "win32"))!;
  expect(found).toMatchObject({ directory: "D:\\old\\mixin-bot", running: true, description: "计划任务 mixin-bot（D:\\old\\mixin-bot，运行中）" });
  expect(found.digest).toMatch(/^[a-f0-9]{64}$/);
  host.task = task("D:\\old\\mixin-bot", { State: "Disabled" });
  expect((await hostService("D:\\Projects\\mixin-bot", run, {}, "win32"))!).toMatchObject({ digest: found.digest, running: false });
  host.task = task("D:\\old\\mixin-bot", { Principal: { UserId: "someone", GroupId: null, LogonType: "Password", RunLevel: "Highest" } });
  expect((await hostService("D:\\Projects\\mixin-bot", run, {}, "win32"))!.digest).not.toBe(found.digest);
  // This directory's own task, spelled another way.
  host.task = task("d:\\projects\\Mixin-Bot\\");
  expect((await hostService("D:\\Projects\\mixin-bot", run, {}, "win32"))!.description).toContain("即本目录");
  // Not as the deployment registers it: in a folder, or without exactly one directory.
  host.task = task("D:\\old", { Path: "\\Custom\\" });
  expect((await hostService("D:\\Projects\\mixin-bot", run, {}, "win32"))!).toMatchObject({ directory: null, description: expect.stringContaining("运行目录不明") });
  host.task = null;
  expect(await hostService("D:\\Projects\\mixin-bot", run, {}, "win32")).toBeNull();
  await expect(hostService("D:\\Projects\\mixin-bot", async () => ({ code: 1, stdout: "", stderr: "denied" }), {}, "win32")).rejects.toThrow("无法核对机器人计划任务");
});

// WindowsPlatform resolves the project with the host's path rules: it only ever runs on Windows.
test.skipIf(process.platform !== "win32")("Windows 移除：只移除确认过的那个任务，由平台脚本停止、保持禁用并注销；已不在时无事可做", async () => {
  const project = "D:\\Projects\\mixin-bot", { host, run, native } = windowsHost(task("D:\\old\\mixin-bot"));
  const facts = { run, native, source: "D:\\console", platform: "win32" as const };
  const expected = (await hostService(project, run, {}, "win32"))!.digest;
  const changed = await removeHostService(project, "d".repeat(64), silent, facts).catch((error: unknown) => error);
  expect(changed).toBeInstanceOf(HostServiceChanged); expect((changed as Error).message).toContain("与预览时不同");
  expect(host.requests).toEqual([]);
  host.owned = false;
  // Refused before anything is announced: the log never says it is removing a service it then leaves alone.
  const refusedLog = said();
  await expect(removeHostService(project, expected, refusedLog.output, facts)).rejects.toBeInstanceOf(HostServiceChanged);
  expect(host.requests.map(request => request.action)).toEqual(["inspect"]); expect(host.removed).toEqual([]);
  expect(refusedLog.lines).toEqual([]);
  host.owned = true; host.requests.length = 0;
  const { lines, output } = said();
  expect(await removeHostService(project, expected, output, facts)).toBe("已移除计划任务 mixin-bot（D:\\old\\mixin-bot，运行中）");
  // The task's own directory, from the console's code: that directory may be gone (deleted without uninstalling first).
  expect(host.requests).toEqual([{ action: "inspect", project: "D:\\old\\mixin-bot", task: "mixin-bot", cwd: "D:\\console", timeoutMs: 30_000 },
    { action: "remove", project: "D:\\old\\mixin-bot", task: "mixin-bot", expected: host.identity, cwd: "D:\\console", timeoutMs: 90_000 }]);
  expect(lines.join("")).toContain("那个目录的文件不删除");
  expect(await removeHostService(project, expected, silent, facts)).toBe("本机已没有 mixin-bot 服务");
  // A task that does not name its directory is left to the operator.
  host.task = task("D:\\old", { Path: "\\Custom\\" }); host.requests.length = 0;
  const custom = (await hostService(project, run, {}, "win32"))!.digest;
  const customLog = said();
  await expect(removeHostService(project, custom, customLog.output, facts)).rejects.toThrow("手动删除");
  expect(host.requests).toEqual([]); expect(customLog.lines).toEqual([]);
});

/** Docker with the bot's containers; `stop` answers the long stop step, `rm` the removal. */
function dockerHost(containers: Record<string, { id: string; running: boolean; data: string; mounts?: unknown[] }>) {
  const calls: string[] = [], failing = { stop: false };
  const run: Runner = async argv => {
    calls.push(argv.join(" "));
    if (argv[1] === "ps") return { code: 0, stdout: Object.keys(containers).map(name => name + "\n").join(""), stderr: "" };
    if (argv[1] === "container" && argv[2] === "inspect") {
      const found = containers[argv[3]!];
      return found ? { code: 0, stdout: JSON.stringify([{ Id: found.id, Image: "sha256:" + "e".repeat(64), State: { Running: found.running },
        Mounts: found.mounts ?? [{ Type: "bind", Source: found.data, Destination: "/app/data" }, { Type: "bind", Source: "/srv/shared", Destination: "/app/workspace" }] }]), stderr: "" }
        : { code: 1, stdout: "", stderr: "No such container" };
    }
    if (argv[1] === "container" && argv[2] === "rm") {
      for (const [name, value] of Object.entries(containers)) if (value.id === argv[3]) delete containers[name];
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected ${argv.join(" ")}`);
  };
  const native: NativeRunner = async (command, output) => {
    calls.push(`native ${command.command} ${command.args.join(" ")} ${command.timeoutMs}`);
    if (failing.stop) { output?.("Error response from daemon: fixture\n", "stderr"); return { code: 1, stdout: "" }; }
    return { code: 0, stdout: "" };
  };
  return { calls, run, native, failing, containers };
}

test("Linux：两个容器作为一个服务列出，摘要不随挂载顺序和运行状态变化；移除按预览的容器 ID 停止并删除", async () => {
  const id = (letter: string) => letter.repeat(64);
  const docker = dockerHost({ "mixin-bot": { id: id("a"), running: true, data: "/srv/old/data" }, "mixin-bot-rollback": { id: id("b"), running: false, data: "/srv/old/data" } });
  const found = (await hostService("/srv/new", docker.run, {}, "linux"))!;
  expect(found).toMatchObject({ directory: "/srv/old", running: true, containers: [id("a"), id("b")], description: "容器 mixin-bot、mixin-bot-rollback（/srv/old，运行中）" });
  const reordered = dockerHost({ "mixin-bot": { id: id("a"), running: false, data: "/srv/old/data",
    mounts: [{ Type: "bind", Source: "/srv/shared", Destination: "/app/workspace" }, { Type: "bind", Source: "/srv/old/data", Destination: "/app/data" }] },
  "mixin-bot-rollback": { id: id("b"), running: false, data: "/srv/old/data" } });
  expect((await hostService("/srv/new", reordered.run, {}, "linux"))!.digest).toBe(found.digest);
  expect((await hostService("/srv/old", docker.run, {}, "linux"))!.description).toContain("/srv/old，即本目录");

  docker.failing.stop = true;
  const { lines, output } = said();
  await expect(removeHostService("/srv/new", found.digest, output, { run: docker.run, native: docker.native, source: "/console", platform: "linux" })).rejects.toThrow("无法停止容器 aaaaaaaaaaaa");
  expect(lines.join("")).toContain("fixture"); expect(docker.calls.some(call => call.includes(" rm "))).toBe(false);
  docker.failing.stop = false; docker.calls.length = 0;
  expect(await removeHostService("/srv/new", found.digest, silent, { run: docker.run, native: docker.native, source: "/console", platform: "linux" }))
    .toBe("已移除容器 mixin-bot、mixin-bot-rollback（/srv/old，运行中）");
  expect(docker.calls.filter(call => !call.includes(" ps ") && !call.includes(" inspect "))).toEqual([
    `native docker container stop --time 30 ${id("a")} 90000`, `docker container rm ${id("a")}`,
    `native docker container stop --time 30 ${id("b")} 90000`, `docker container rm ${id("b")}`]);
  expect(docker.containers).toEqual({});

  // A container recreated since the preview is another one: refused before anything stops.
  const recreated = dockerHost({ "mixin-bot": { id: id("c"), running: true, data: "/srv/old/data" } });
  await expect(removeHostService("/srv/new", found.digest, silent, { run: recreated.run, native: recreated.native, platform: "linux" })).rejects.toBeInstanceOf(HostServiceChanged);
  expect(recreated.calls.some(call => call.startsWith("native"))).toBe(false);
});

test("macOS：另一个目录的 LaunchDaemon 列出来；移除先停用并卸载、清理服务账户的进程，再删除定义", async () => {
  const f = await tempFixture("host-service-launchd-");
  try {
    const plist = join(f.root, "service.plist"), project = join(f.root, "new"), calls: string[] = [];
    let loaded = true;
    writeFileSync(plist, "<plist/>");
    const launchd = { plist, euid: () => 0, processes: () => new Map(), kill: () => 0 };
    const run: Runner = async argv => {
      const line = argv.join(" "); calls.push(line);
      if (argv[0] === "/usr/bin/id") return { code: 0, stdout: argv[1] === "-u" ? "499\n" : "20\n", stderr: "" };
      if (argv[0] === "/usr/bin/plutil") return { code: 0, stdout: JSON.stringify({ Label: LAUNCHD_LABEL, UserName: SERVICE_ACCOUNT, WorkingDirectory: "/opt/old", ProgramArguments: ["/opt/homebrew/bin/bun", "x"], EnvironmentVariables: { LANG: "C.UTF-8" } }), stderr: "" };
      if (line.endsWith(`print system/${LAUNCHD_LABEL}`)) return loaded ? { code: 0, stdout: "state = running\n", stderr: "" } : { code: 113, stdout: "", stderr: "" };
      if (argv[1] === "bootout" && argv[2] === `system/${LAUNCHD_LABEL}`) loaded = false;
      return { code: 0, stdout: "", stderr: "" };
    };
    const found = (await hostService(project, run, launchd, "darwin"))!;
    expect(found).toMatchObject({ directory: "/opt/old", running: true, description: `LaunchDaemon ${plist}（/opt/old，已加载）` });
    expect(await removeHostService(project, found.digest, silent, { run, launchd, platform: "darwin" })).toBe(`已移除LaunchDaemon ${plist}（/opt/old，已加载）`);
    expect(calls.filter(line => line.startsWith("/bin/launchctl") && !line.includes(" print "))).toEqual([`/bin/launchctl disable system/${LAUNCHD_LABEL}`,
      `/bin/launchctl bootout system/${LAUNCHD_LABEL}`, "/bin/launchctl bootout user/499"]);
    expect(existsSync(plist)).toBe(false);
    expect(await hostService(project, run, launchd, "darwin")).toBeNull();
  } finally { await f.cleanup(); }
});
