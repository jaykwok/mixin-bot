// Opt-in, macOS as root (GitHub's macOS runners have passwordless sudo): a real LaunchDaemon for a fixture service, run as
// the service account, and its stop; the entry's account, identity switch and access checks; a console task as a one-shot
// LaunchDaemon; the deployment's file effects and what root refuses to follow in the account's directories.
// Run: sudo env MIXIN_TEST_REAL_LAUNCHD=1 bun test tests/ops/core-real-launchd.test.ts
// (MIXIN_TEST_MACOS_TOOLS=1 when Homebrew's bun, bash, coreutils and uv are installed; MIXIN_TEST_OFFICE_PYTHON with LibreOffice in
// /Applications for the Office preview.)
// The tests use the service's own label, definition path and account, so on a Mac that has any of them (a deployment)
// they refuse to run: one test fails saying what it found, the others are skipped, and nothing is changed. Otherwise the
// account, the definition and the fixtures they create are removed again, and nothing else.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, chownSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { accountIdentity, becomeCommand, LAUNCHD_LABEL, LAUNCHD_PLIST, LaunchdPlatform, SERVICE_ACCOUNT, serviceEnvironment } from "../../ops/core/launchd-host.ts";
import { ensureServiceAccount } from "../../ops/core/macos-account.ts";
import { checkProjectAccess, findMacosTools, handOverTree } from "../../ops/core/macos-deploy.ts";
import { assertToolsTrusted, createServiceDirectories, MacosDeployment, parseMacosTools, servicePlist } from "../../ops/core/macos-deployment.ts";
import { acquireDeploymentLock } from "../../ops/core/deployment-lock.ts";
import { HostServiceChanged, hostService, removeHostService } from "../../ops/core/host-service.ts";
import { runCommand } from "../../ops/core/hosting.ts";
import { runNative } from "../../ops/core/native-process.ts";
import { publish } from "../../src/lib/atomic-file.ts";
import { handOverLog } from "../../src/lib/operation-log.ts";
import { captured } from "../../ops/core/macos-terminal.ts";
import { hostedTask, launchTask, unregisterTask } from "../../console/server/task-host.ts";
import { TaskStore } from "../../ops/core/tasks.ts";
import { executeProcess } from "../../src/lib/process.ts";
import { accountProcesses } from "../../src/lib/darwin.ts";

const enabled = process.platform === "darwin" && process.env.MIXIN_TEST_REAL_LAUNCHD === "1" && process.geteuid?.() === 0;
const root = resolve(import.meta.dir, "../..");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** What a deployment on this Mac has: the service's definition, its job in launchd, the service account. */
function deployed(): string[] {
  const quiet = { stdout: "ignore", stderr: "ignore" } as const;
  const found = existsSync(LAUNCHD_PLIST) ? [LAUNCHD_PLIST] : [];
  // 113: launchd has no such job.
  if (Bun.spawnSync(["/bin/launchctl", "print", `system/${LAUNCHD_LABEL}`], quiet).exitCode !== 113) found.push(`system/${LAUNCHD_LABEL}`);
  for (const path of [`/Users/${SERVICE_ACCOUNT}`, `/Groups/${SERVICE_ACCOUNT}`]) if (Bun.spawnSync(["/usr/bin/dscl", ".", "-read", path, "RecordName"], quiet).exitCode === 0) found.push(path);
  return found;
}
const found = enabled ? deployed() : [];
const run = enabled && !found.length;
/** What this run made, and so removes. */
let created = false, defined = false, project = "";
const fixtures: string[] = [];

async function until<T>(work: () => T | null | Promise<T | null>, ms = 30_000): Promise<T> {
  const limit = performance.now() + ms;
  for (;;) { const value = await work(); if (value !== null) return value; if (performance.now() > limit) throw new Error("timed out"); await Bun.sleep(100); }
}
const report = () => { try { return JSON.parse(readFileSync(join(project, "data/runtime/report.json"), "utf8")); } catch { return null; } };

afterAll(async () => {
  if (!run) return;
  // The Mac had none of these before the run.
  if (defined) {
    Bun.spawnSync(["/bin/launchctl", "bootout", `system/${LAUNCHD_LABEL}`]);
    rmSync(LAUNCHD_PLIST, { force: true });
  }
  if (created) {
    const user = await accountIdentity(SERVICE_ACCOUNT);
    if (user) for (const pid of accountProcesses(user.uid).keys()) { try { process.kill(pid, "SIGKILL"); } catch {} }
    for (const path of [`/Users/${SERVICE_ACCOUNT}`, `/Groups/${SERVICE_ACCOUNT}`]) Bun.spawnSync(["/usr/bin/dscl", ".", "-delete", path]);
  }
  for (const path of [project, ...fixtures]) if (path) rmSync(path, { recursive: true, force: true });
});

test.skipIf(!enabled || run)("这台 Mac 有部署时真实测试拒绝运行，什么都不改", () => {
  throw new Error(`这台 Mac 有部署（${found.join("、")}）：真实测试会替换并删除它们，没有运行。请在没有部署的 Mac 上运行`);
});

/** The service account, created through the deploy entry's own path when missing: a dedicated group, not staff. */
async function account() {
  const made = await ensureServiceAccount();
  created ||= made.created;
  const group = await captured(["/usr/bin/dscl", ".", "-read", `/Groups/${SERVICE_ACCOUNT}`, "PrimaryGroupID"]);
  if (made.created) expect(group.stdout).toContain(String(made.identity.gid));
  expect(made.identity.gid).not.toBe(20);
  return made.identity;
}

test.skipIf(!run)("真实 LaunchDaemon：以服务账户运行、环境只来自定义；停止后连 setsid 逃逸的进程也清掉；状态如实反映", async () => {
  const user = await account();
  // /tmp, not the runner's private TMPDIR: the service account must reach the project.
  project = mkdtempSync("/tmp/mixin-real-launchd-"); chmodSync(project, 0o755);
  for (const dir of ["bin", "ops/core"]) mkdirSync(join(project, dir), { recursive: true, mode: 0o755 });
  for (const dir of ["data", "data/runtime", "data/runtime/home", "logs"]) { mkdirSync(join(project, dir), { recursive: true }); chownSync(join(project, dir), user.uid, user.gid); }
  // The runner's Bun lives in its home, which the service account cannot enter: a real deployment names a reachable one.
  copyFileSync(process.execPath, join(project, "bin/bun")); chmodSync(join(project, "bin/bun"), 0o755);
  writeFileSync(join(project, "ops/core/launchd-supervisor.ts"), `import { writeFileSync } from "node:fs";
const escapee = Bun.spawn(["/usr/bin/perl", "-MPOSIX", "-e", "POSIX::setsid(); sleep 600"], { stdio: ["ignore", "ignore", "ignore"] });
writeFileSync("data/runtime/report.json", JSON.stringify({ uid: process.getuid(), gid: process.getgid(), home: process.env.HOME, path: process.env.PATH,
  lang: process.env.LANG, git: process.env.GIT_CONFIG_VALUE_0, sudo: process.env.SUDO_USER ?? null, args: process.argv.slice(2), pid: process.pid, escapee: escapee.pid }));
setInterval(() => {}, 1000);
`, { mode: 0o644 });
  const tools = parseMacosTools(`format=1\nbun=${project}/bin/bun\ngit=/usr/bin/git\nuv=/usr/bin/true\nbash=/bin/bash\ncoreutils=/usr/bin\n`);
  defined = true;
  writeFileSync(LAUNCHD_PLIST, servicePlist(project, tools), { mode: 0o644 });
  const service = new LaunchdPlatform(project);
  expect((await service.inspect())).toMatchObject({ state: "stopped", owned: true, leftovers: 0, user });
  expect(await service.serviceDefinition()).toMatchObject({ directory: project, git: "/usr/bin/git", env: { HOME: join(project, "data/runtime/home") } });

  await service.boot();
  const seen = await until(report);
  expect(seen).toMatchObject({ uid: user.uid, gid: user.gid, home: join(project, "data/runtime/home"), lang: "C.UTF-8", git: project, sudo: null,
    args: ["--bun", `${project}/bin/bun`, "--git", "/usr/bin/git", "--stderr", join(project, "logs/service-stderr.log")] });
  expect(seen.path.startsWith("/usr/bin:")).toBe(true);
  expect(await service.inspect()).toMatchObject({ state: "running", owned: true, rawState: "running", leftovers: 0 });
  expect(alive(seen.escapee)).toBe(true);

  await service.halt();
  expect(alive(seen.pid)).toBe(false); expect(alive(seen.escapee)).toBe(false);
  expect(await service.inspect()).toMatchObject({ state: "stopped", rawState: "not-loaded", leftovers: 0 });
  // Stopped stays stopped: the disabled job refuses to load behind the core's back.
  expect(Bun.spawnSync(["/bin/launchctl", "bootstrap", "system", LAUNCHD_PLIST]).exitCode).not.toBe(0);

  // A supervised command as the service account: the identity is dropped before the command, and what escaped its session counts as a leftover.
  rmSync(join(project, "data/runtime/report.json"));
  // Real and effective IDs. (id -G would show the directory's default group list, not the groups this process holds.)
  const result = await executeProcess({ command: "/bin/sh", args: ["-c", "id -ru; id -u; id -rg; id -g; /usr/bin/perl -MPOSIX -e 'POSIX::setsid(); sleep 600' >/dev/null 2>&1 & sleep 1"],
    cwd: project, identity: user, timeoutMs: 20_000 });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim().split("\n")).toEqual([user.uid, user.uid, user.gid, user.gid].map(String));
  expect((await service.inspect()).leftovers).toBeGreaterThan(0);
  await service.sweep();
  expect(accountProcesses(user.uid).size).toBe(0);

  await service.boot();
  await until(report);
  await service.halt();
  expect(accountProcesses(user.uid).size).toBe(0);
  expect(existsSync(LAUNCHD_PLIST)).toBe(true);
}, 180_000);

// A first deployment in another directory (host-service.ts): the loaded LaunchDaemon of the old one is listed with that
// directory; what the operator confirms names the definition, not whether it runs. Removal stops it, clears what the
// service account left running and deletes the definition; the old directory's files and the account stay.
test.skipIf(!run)("另一目录的首次部署：列出已加载的 LaunchDaemon，确认后停用、卸载并删除定义；不同的确认不动它；那个目录的文件和服务账户保留", async () => {
  const user = await account();
  const old = mkdtempSync("/tmp/mixin-real-launchd-old-"), fresh = mkdtempSync("/tmp/mixin-real-launchd-new-");
  fixtures.push(old, fresh); chmodSync(old, 0o755);
  for (const dir of ["bin", "ops/core"]) mkdirSync(join(old, dir), { recursive: true, mode: 0o755 });
  for (const dir of ["data", "data/runtime", "data/runtime/home", "logs"]) { mkdirSync(join(old, dir), { recursive: true }); chownSync(join(old, dir), user.uid, user.gid); }
  copyFileSync(process.execPath, join(old, "bin/bun")); chmodSync(join(old, "bin/bun"), 0o755);
  writeFileSync(join(old, "ops/core/launchd-supervisor.ts"), `import { writeFileSync } from "node:fs";
const escapee = Bun.spawn(["/usr/bin/perl", "-MPOSIX", "-e", "POSIX::setsid(); sleep 600"], { stdio: ["ignore", "ignore", "ignore"] });
writeFileSync("data/runtime/report.json", JSON.stringify({ pid: process.pid, escapee: escapee.pid }));
setInterval(() => {}, 1000);
`, { mode: 0o644 });
  const reported = () => { try { return JSON.parse(readFileSync(join(old, "data/runtime/report.json"), "utf8")) as { pid: number; escapee: number }; } catch { return null; } };
  const tools = parseMacosTools(`format=1\nbun=${old}/bin/bun\ngit=/usr/bin/git\nuv=/usr/bin/true\nbash=/bin/bash\ncoreutils=/usr/bin\n`);
  defined = true;
  writeFileSync(LAUNCHD_PLIST, servicePlist(old, tools), { mode: 0o644 });
  const service = new LaunchdPlatform(old);
  await service.boot();
  await until(reported);
  const loaded = await hostService(fresh);
  expect(loaded).toMatchObject({ directory: old, running: true, description: `LaunchDaemon ${LAUNCHD_PLIST}（${old}，已加载）` });
  await service.halt();
  const stopped = await hostService(fresh);
  expect(stopped).toMatchObject({ directory: old, running: false, description: `LaunchDaemon ${LAUNCHD_PLIST}（${old}，未加载）` });
  expect(stopped!.digest).toBe(loaded!.digest);
  rmSync(join(old, "data/runtime/report.json"));
  await service.boot();
  const seen = await until(reported);

  const said: string[] = [], output = (text: string) => { said.push(text); };
  await expect(removeHostService(fresh, "0".repeat(64), output)).rejects.toBeInstanceOf(HostServiceChanged);
  expect({ said, pid: alive(seen.pid), plist: existsSync(LAUNCHD_PLIST) }).toEqual({ said: [], pid: true, plist: true });

  expect(await removeHostService(fresh, loaded!.digest, output)).toBe(`已移除${loaded!.description}`);
  expect(said.join("")).toContain("那个目录的文件不删除");
  expect({ pid: alive(seen.pid), escapee: alive(seen.escapee), plist: existsSync(LAUNCHD_PLIST), left: accountProcesses(user.uid).size })
    .toEqual({ pid: false, escapee: false, plist: false, left: 0 });
  // 113: launchd has no such job.
  expect(Bun.spawnSync(["/bin/launchctl", "print", `system/${LAUNCHD_LABEL}`], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(113);
  expect(await hostService(fresh)).toBeNull();
  expect(existsSync(join(old, "ops/core/launchd-supervisor.ts"))).toBe(true);
  expect(await accountIdentity(SERVICE_ACCOUNT)).toMatchObject({ uid: user.uid, gid: user.gid });
}, 180_000);

test.skipIf(!run)("macOS 入口的真实环境：交互命令以服务账户运行；服务账户进不去的检出被拒绝；工具都按服务账户实测", async () => {
  const user = await account();
  // The command gets exactly the environment it was given; the switch holds none of root's (here a marker in this process).
  process.env.MIXIN_TEST_ROOT_ONLY = "root";
  try {
    const switched = becomeCommand(user, ["/bin/sh", "-c", "id -ru; id -u; id -rg; id -g; echo \"$HOME|${MIXIN_TEST_ROOT_ONLY:-none}|$MARK\""], { PATH: "/usr/bin:/bin", HOME: "/var/empty", MARK: "命令" });
    expect(switched.env.MIXIN_TEST_ROOT_ONLY).toBeUndefined();
    const become = await captured(switched.argv, { env: switched.env });
    expect(become.code, become.stderr).toBe(0);
    expect(become.stdout.trim().split("\n")).toEqual([...[user.uid, user.uid, user.gid, user.gid].map(String), "/var/empty|none|命令"]);
  } finally { delete process.env.MIXIN_TEST_ROOT_ONLY; }
  expect((await captured([process.execPath, "--no-env-file", join(root, "ops/core/macos-become.ts"), "x", "1", "--", "/usr/bin/true"])).code).toBe(2);
  expect((await captured([process.execPath, "--no-env-file", join(root, "ops/core/macos-become.ts"), String(user.uid), String(user.gid), "--", "/usr/bin/true"])).code).toBe(2);

  const open = mkdtempSync("/tmp/mixin-real-access-"); fixtures.push(open);
  chmodSync(open, 0o755);
  for (const file of ["package.json", "src/server/index.ts"]) { mkdirSync(join(open, file, ".."), { recursive: true, mode: 0o755 }); writeFileSync(join(open, file), "{}", { mode: 0o644 }); }
  await checkProjectAccess(open, user);
  const closed = mkdtempSync("/tmp/mixin-real-private-"); fixtures.push(closed);
  chmodSync(closed, 0o700);
  const inside = join(closed, "checkout");
  for (const file of ["package.json", "src/server/index.ts"]) { mkdirSync(join(inside, file, ".."), { recursive: true, mode: 0o755 }); writeFileSync(join(inside, file), "{}", { mode: 0o644 }); }
  await expect(checkProjectAccess(inside, user)).rejects.toThrow("读不到");

  if (process.env.MIXIN_TEST_MACOS_TOOLS === "1") {
    const tools = await findMacosTools(open, user);
    expect(tools.bash.startsWith("/opt/homebrew/")).toBe(true);
    expect(tools.coreutils).toBe("/opt/homebrew/opt/coreutils/libexec/gnubin");
    for (const path of [tools.bun, tools.git, tools.uv, tools.bash]) expect(existsSync(path)).toBe(true);
    assertToolsTrusted(tools, user);
    // A Git in a directory the service account owns is one it could replace: never recorded for root.
    const planted = join(open, "planted"); mkdirSync(planted); copyFileSync("/usr/bin/true", join(planted, "git")); chmodSync(join(planted, "git"), 0o755); chownSync(planted, user.uid, user.gid);
    expect(() => assertToolsTrusted({ ...tools, git: join(planted, "git") }, user)).toThrow("可被服务账户");
  }
}, 120_000);

test.skipIf(!run)("控制台任务是真实的一次性 LaunchDaemon：以 root 运行一次、交回执；结束后保持已加载但不运行，清理后不留定义", async () => {
  const fixture = mkdtempSync("/tmp/mixin-real-task-"); fixtures.push(fixture);
  const dir = join(fixture, ".console"); mkdirSync(dir, { mode: 0o711 });
  const store = new TaskStore(dir), { id } = store.create({ project: fixture, mechanism: "launchd-system", planId: "fixture", operation: "stop", params: {} }, "real");
  // A stand-in executor: the claim, then a few seconds of work, then a record of who ran it.
  const executor = join(dir, "executor.js");
  writeFileSync(executor, `const { writeFileSync } = require("node:fs"); const { join } = require("node:path");
const at = name => join(process.argv[3], ".console/tasks", process.argv[5], name);
writeFileSync(at("claim"), "fixture");
setTimeout(() => { writeFileSync(at("done"), JSON.stringify({ uid: process.getuid(), cwd: process.cwd(), ppid: process.ppid })); process.exit(0); }, 3000);
`, { mode: 0o600 });
  const bundle = { path: executor, digest: createHash("sha256").update(readFileSync(executor)).digest("hex") };
  await launchTask(store, id, bundle);
  const request = store.request(id);
  expect(existsSync(join(dir, "launchd", `com.mixin-bot.console.${id}.plist`))).toBe(true);
  const running = await hostedTask(request, { pid: 1, startedAt: "x" });
  expect(running.state).toBe("running");
  await until(async () => (await hostedTask(request, { pid: 1, startedAt: "x" })).state === "ended" ? true : null, 20_000);
  expect(JSON.parse(readFileSync(join(store.dir(id), "done"), "utf8"))).toMatchObject({ uid: 0, cwd: realpathSync(fixture), ppid: 1 }); // /tmp is a link to /private/tmp
  // Ended jobs stay loaded until somebody boots them out.
  expect(Bun.spawnSync(["/bin/launchctl", "print", `system/com.mixin-bot.console.${id}`]).exitCode).toBe(0);
  await unregisterTask(request);
  expect(Bun.spawnSync(["/bin/launchctl", "print", `system/com.mixin-bot.console.${id}`]).exitCode).toBe(113);
  expect(existsSync(join(dir, "launchd", `com.mixin-bot.console.${id}.plist`))).toBe(false);
}, 120_000);

// MIXIN_TEST_OFFICE_PYTHON: a Python with the project's dependencies that the service account can run (not under a home).
const officePython = process.env.MIXIN_TEST_OFFICE_PYTHON;
test.skipIf(!run || !officePython)("macOS 的 LibreOffice 预览以服务账户运行：从它进不去的目录启动、只靠标准安装位置，中文不丢", async () => {
  const user = await account();
  const work = mkdtempSync("/tmp/mixin-real-office-"); fixtures.push(work); chmodSync(work, 0o755);
  // The account cannot reach the checkout, so the scripts it runs are copied next to the job.
  const scripts = join(work, "scripts"); mkdirSync(scripts, { mode: 0o755 });
  for (const name of ["document_ops.py", "macos-fonts.conf"]) copyFileSync(join(root, "src/agent/modules/document-work/scripts", name), join(scripts, name));
  writeFileSync(join(scripts, "drive.py"), `import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import document_ops
import pypdfium2 as pdfium
from docx import Document
from docx.oxml.ns import qn
work = Path(sys.argv[2])
document = Document()
style = document.styles["Normal"]; style.font.name = "微软雅黑"
style.element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), "微软雅黑")
document.add_paragraph("流程图预览测试：资料与中文字体")
source = work / "中文 文档.docx"; document.save(source)
(work / "job").mkdir(); (work / "profile").mkdir()
pdf = document_ops.convert_office(source, work / "job", work / "profile")
print(json.dumps({"office": document_ops.office_binary(), "text": pdfium.PdfDocument(str(pdf))[0].get_textpage().get_text_range()}, ensure_ascii=False))
`);
  for (const name of ["document_ops.py", "macos-fonts.conf", "drive.py"]) chmodSync(join(scripts, name), 0o644);
  const job = join(work, "job-root"); mkdirSync(job); chownSync(job, user.uid, user.gid);
  const closed = mkdtempSync("/tmp/mixin-real-office-cwd-"); fixtures.push(closed); chmodSync(closed, 0o700);
  const switched = becomeCommand(user, [officePython!, join(scripts, "drive.py"), scripts, job], { PATH: "/usr/bin:/bin", HOME: "/var/empty", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" });
  const result = await captured(switched.argv, { cwd: closed, env: switched.env });
  expect(result.code, result.stderr).toBe(0);
  const seen = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect(seen.office).toBe("/Applications/LibreOffice.app/Contents/MacOS/soffice");
  expect(seen.text).toContain("流程图预览测试：资料与中文字体");
}, 240_000);

/** A command as the service account (as the deployment runs its file effects); refuses when it fails. */
const asAccount = (user: { uid: number; gid: number }, cwd: string) => async (argv: string[]) => {
  const result = await runNative({ command: argv[0]!, args: argv.slice(1), cwd, identity: user, protocol: true, timeoutMs: 30_000 }, () => {});
  if (result.code !== 0) throw new Error(`${argv.join(" ")} failed: ${result.code}`);
};

test.skipIf(!run)("root 在服务账户的目录里不跟随它放下的链接或第二个名称：部署锁、运维日志、整棵交接、发布", async () => {
  const user = await account();
  const work = mkdtempSync("/tmp/mixin-real-links-"); fixtures.push(work); chmodSync(work, 0o755);
  const project = realpathSync(work), own = (path: string) => chownSync(path, user.uid, user.gid);
  // A root file the account must never get, nor change the mode of.
  const secret = join(project, "secret"); writeFileSync(secret, "root", { mode: 0o600 });
  const unchanged = () => { const info = statSync(secret); expect([info.uid, info.mode & 0o777, readFileSync(secret, "utf8")]).toEqual([0, 0o600, "root"]); };
  mkdirSync(join(project, "data")); own(join(project, "data"));

  // data/state as a link to a root directory: no lock appears there.
  const elsewhere = join(project, "elsewhere"); mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(project, "data/state"));
  expect(() => acquireDeploymentLock(project)).toThrow("链接");
  expect(existsSync(join(elsewhere, "deploy.lock"))).toBe(false);
  rmSync(join(project, "data/state"));
  mkdirSync(join(project, "data/state")); own(join(project, "data/state"));
  // deploy.lock as a second name of the root file: whether refused or locked, the file keeps its mode.
  linkSync(secret, join(project, "data/state/deploy.lock"));
  try { acquireDeploymentLock(project).close(); } catch { /* Refused as replaced: also fine. */ }
  unchanged();
  rmSync(join(project, "data/state/deploy.lock"));
  const lock = acquireDeploymentLock(project);
  expect(statSync(join(project, "data/state/deploy.lock")).mode & 0o777).toBe(0o644);
  lock.close();

  // A log root created, replaced by a second name of the root file before the hand-over.
  mkdirSync(join(project, "logs/operations"), { recursive: true }); own(join(project, "logs")); own(join(project, "logs/operations"));
  const log = join(project, "logs/operations/deploy-x.log");
  writeFileSync(log, ""); expect(handOverLog(log, user)).toBe(true); expect(statSync(log).uid).toBe(user.uid);
  rmSync(log); linkSync(secret, log);
  expect(handOverLog(log, user)).toBe(false);
  unchanged();

  // The hand-over of a whole tree: a second name anywhere refuses all of it; links themselves change owner, never their target.
  const tree = join(project, "backup"); mkdirSync(join(tree, "rm/deep"), { recursive: true });
  writeFileSync(join(tree, "rm/deep/file"), "x"); symlinkSync(secret, join(tree, "rm/link")); linkSync(secret, join(tree, "rm/deep/second"));
  expect(() => handOverTree(tree, user)).toThrow("硬链接");
  expect(lstatSync(join(tree, "rm/deep/file")).uid).toBe(0); unchanged();
  rmSync(join(tree, "rm/deep/second"));
  handOverTree(tree, user);
  for (const path of ["", "rm", "rm/deep", "rm/deep/file", "rm/link"]) expect(lstatSync(join(tree, path)).uid, path).toBe(user.uid);
  unchanged();

  // A publication through a directory the account replaced by a link: refused, and nothing left where the link points.
  mkdirSync(join(project, "data/state/sub")); own(join(project, "data/state/sub"));
  await publish(join(project, "data/state/sub/file"), "ok", { within: project, owner: user });
  expect(statSync(join(project, "data/state/sub/file")).uid).toBe(user.uid);
  rmSync(join(project, "data/state/sub"), { recursive: true }); symlinkSync(elsewhere, join(project, "data/state/sub"));
  await expect(publish(join(project, "data/state/sub/file"), "no", { within: project })).rejects.toThrow("被替换");
  expect(Bun.spawnSync(["/bin/ls", "-A", elsewhere]).stdout.toString()).toBe("");
}, 120_000);

test.skipIf(!run)("macOS 部署的文件效果：root 的记录在 .console/deployments，设置副本、归档和删除以服务账户进行，账户放下的链接不被 root 跟随", async () => {
  const user = await account();
  const work = mkdtempSync("/tmp/mixin-real-effects-"); fixtures.push(work); chmodSync(work, 0o755);
  const project = realpathSync(work), name = "deploy-realfixture", run = asAccount(user, project);
  mkdirSync(join(project, ".console"), { mode: 0o711 });
  const outside = join(project, "outside"); writeFileSync(outside, "root", { mode: 0o644 });
  // The service account's directories, as a deployment makes them; then its settings.
  await createServiceDirectories(project, user, run);
  for (const directory of ["data", "data/config", "logs/operations", "backup/snapshots"]) expect(lstatSync(join(project, directory)).uid, directory).toBe(user.uid);
  await run(["/bin/sh", "-c", "printf old > data/config/app.json"]);
  // The definition this transaction finds; launchd and the account's processes are stood in for.
  const plist = join(project, "service.plist"); writeFileSync(plist, "<plist/>", { mode: 0o644 });
  const definition = { Label: LAUNCHD_LABEL, UserName: SERVICE_ACCOUNT, WorkingDirectory: project, ProgramArguments: ["/opt/homebrew/bin/bun"] };
  const service = new LaunchdPlatform(project, { plist, euid: () => 0, processes: () => new Map(), kill: () => 0, run: async argv => {
    if (argv[0] === "/usr/bin/id") return runCommand(argv);
    if (argv[0] === "/usr/bin/plutil") return { code: 0, stdout: JSON.stringify(definition), stderr: "" };
    if (argv[1] === "print") return { code: 113, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  } });
  const effects = new MacosDeployment(project, name, service, runNative, user, "deploy");
  const state = await effects.capture();
  expect(state).toMatchObject({ hasService: true, wasRunning: false });
  const records = join(project, ".console/deployments", name);
  expect([lstatSync(records).uid, lstatSync(records).mode & 0o777]).toEqual([0, 0o711]);
  for (const file of ["macos-state.json", "service.plist"]) expect(lstatSync(join(records, file)).uid, file).toBe(0);
  expect(lstatSync(join(project, "backup/snapshots", name)).uid).toBe(user.uid);
  expect(readFileSync(join(project, "backup/snapshots", name, "data/config/app.json"), "utf8")).toBe("old");
  expect(lstatSync(join(project, "backup/snapshots", name, "data/config/app.json")).uid).toBe(user.uid);

  // The account plants a link to a root file where root restores: it is archived as the account, never followed.
  await run(["/bin/sh", "-c", `rm data/config/app.json && ln -s ${outside} data/config/app.json`]);
  await effects.restoreConfiguration();
  expect(readFileSync(join(project, "data/config/app.json"), "utf8")).toBe("old");
  expect(lstatSync(join(project, "data/config/app.json")).uid).toBe(user.uid);
  expect([readFileSync(outside, "utf8"), statSync(outside).uid]).toEqual(["root", 0]);
  expect(Bun.spawnSync(["/bin/ls", join(project, "backup/rm", name)]).stdout.toString()).toContain("config");

  // Dependencies go aside into root's records and come back; a planted backup in the account's snapshot means nothing.
  mkdirSync(join(project, "node_modules/pkg"), { recursive: true }); writeFileSync(join(project, "node_modules/pkg/index.js"), "original");
  await run(["/bin/mkdir", "-p", join(project, "backup/snapshots", name, "node_modules")]);
  await effects.saveDependencies();
  expect(existsSync(join(project, "node_modules"))).toBe(false);
  expect(readFileSync(join(records, "node_modules/pkg/index.js"), "utf8")).toBe("original");
  mkdirSync(join(project, "node_modules")); writeFileSync(join(project, "node_modules/candidate"), "new");
  await effects.restoreDependencies();
  expect(readFileSync(join(project, "node_modules/pkg/index.js"), "utf8")).toBe("original");

  // The definition comes back from root's copy; the configuration directories stay the account's, tightened by it.
  writeFileSync(plist, "<changed/>");
  await effects.restoreService();
  expect(readFileSync(plist, "utf8")).toBe("<plist/>");
  await effects.prepareDirectories();
  expect(lstatSync(join(project, "data/config")).mode & 0o777).toBe(0o700);

  await effects.cleanup(true);
  for (const path of [records, join(project, "backup/snapshots", name), join(project, "backup/rm", name)]) expect(existsSync(path), path).toBe(false);
  expect(serviceEnvironment(project).SUDO_USER).toBeUndefined();
}, 180_000);
