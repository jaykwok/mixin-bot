import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tempFixture } from "../helpers/temp.ts";
import { deploymentEnvironment } from "../../ops/core/deployment-options.ts";
import { assertConsoleLifecycle, consoleLifecycle } from "../../ops/core/macos-deploy.ts";

const repo = resolve(import.meta.dir, "../.."), quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
test("真实平台选择检查：关闭 stdin 仍拒绝缺失选择，明确允许切分支才能执行，中文输出不污染返回值", async () => {
  const f = await tempFixture("lifecycle-choices-");
  try {
    for (const path of ["data/config/models.json", "data/config/app-bot.json", "data/runtime/pi/settings.json", "data/config/directory.json"]) {
      mkdirSync(dirname(join(f.root, path)), { recursive: true }); writeFileSync(join(f.root, path), "{}");
    }
    const windows = process.platform === "win32", script = join(f.root, windows ? "run.ps1" : "run.sh");
    writeFileSync(script, windows ? "\uFEFF" + [
      "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
      ". " + quote(join(repo, "scripts/lib/console-plan.ps1")),
      "try { $value=Assert-ConsoleLifecycle 'update' $env:FIXTURE_PROJECT $env:FIXTURE_BRANCH; if($null -ne $value){throw 'stdout pollution'}; Write-Host '已通过选择检查' } catch { Write-Host $_.Exception.Message; exit 3 }",
    ].join("\r\n") : ["set -euo pipefail", 'PROJECT_DIR="$FIXTURE_PROJECT"', `source '${join(repo, "scripts/lib/console-plan.sh")}'`,
      'value="$(assert_console_lifecycle update "$FIXTURE_BRANCH")" || exit 3', '[ -z "$value" ] || exit 4', "echo '已通过选择检查'"].join("\n"));
    const good = { ...deploymentEnvironment("update", { target: "a".repeat(40), switchMain: false, directory: "saved" }, f.root),
      MIXIN_OPS_CONSOLE: "1", MIXIN_OPS_TASK_ID: "synthetic", FIXTURE_BRANCH: "main", FIXTURE_PROJECT: f.root };
    const scenarios: [Record<string, string>, boolean, string][] = [
      [{}, true, "已通过"],
      [{ MIXIN_OPS_TASK_ID: "" }, false, "任务记录"], [{ MIXIN_OPS_DIRECTORY: "all", BOT_DIRECTORY_SCOPE: "all" }, false, "首次通讯录"],
      [{ FIXTURE_BRANCH: "feature" }, false, "未允许"], [{ FIXTURE_BRANCH: "feature", MIXIN_OPS_SWITCH_MAIN: "1" }, true, "已通过"],
      [{ MIXIN_OPS_CONSOLE: "", FIXTURE_BRANCH: "feature" }, true, "已通过"],
      [{ MIXIN_OPS_DIRECTORY: "selected", MIXIN_OPS_DIRECTORY_INPUT: "{}", MIXIN_OPS_DIRECTORY_APP: "a".repeat(64) }, false, "部门选择"],
    ];
    for (const [override, okay, message] of scenarios) {
      const child = Bun.spawn(windows ? ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script] : ["bash", script], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, env: { ...process.env, ...good, ...override },
      });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, out + err).toBe(okay ? 0 : 3); expect(out + err).toContain(message);
    }
    unlinkSync(join(f.root, "data/config/directory.json"));
    for (const input of ["", '{"format":1,"departments":["d2"]}']) {
      const child = Bun.spawn(windows ? ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script] : ["bash", script], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, env: { ...process.env, ...good, MIXIN_OPS_DIRECTORY: "selected", MIXIN_OPS_DIRECTORY_INPUT: input, MIXIN_OPS_DIRECTORY_APP: "a".repeat(64) },
      });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, out + err).toBe(input ? 0 : 3);
    }
  } finally { await f.cleanup(); }
}, 30_000);

test("首次部署的入口检查：只有控制台的 install 任务按首次部署检查，要求两份草稿引用且不要求已有配置；其他部署不接受草稿引用", async () => {
  const f = await tempFixture("lifecycle-install-");
  try {
    const windows = process.platform === "win32", script = join(f.root, windows ? "run.ps1" : "run.sh");
    writeFileSync(script, windows ? "\uFEFF" + [
      "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
      ". " + quote(join(repo, "scripts/lib/console-plan.ps1")),
      "try { $lifecycle=Get-ConsoleLifecycle; Assert-ConsoleLifecycle $lifecycle $env:FIXTURE_PROJECT; Write-Host \"通过：$lifecycle\" } catch { Write-Host $_.Exception.Message; exit 3 }",
    ].join("\r\n") : ["set -euo pipefail", 'PROJECT_DIR="$FIXTURE_PROJECT"', `source '${join(repo, "scripts/lib/console-plan.sh")}'`,
      'lifecycle="$(console_lifecycle)"', 'assert_console_lifecycle "$lifecycle" || exit 3', 'echo "通过：$lifecycle"'].join("\n"));
    const ref = (letter: string) => ({ draft: "config-" + letter.repeat(32), digest: letter.repeat(64) });
    const install: Record<string, string> = { ...deploymentEnvironment("install", { directory: "all", port: 2022, workspace: "", app: ref("a"), models: ref("b") }, f.root),
      MIXIN_OPS_CONSOLE: "1", MIXIN_OPS_TASK_ID: "synthetic", FIXTURE_PROJECT: f.root };
    const deploy = { ...deploymentEnvironment("deploy", { directory: "all", port: 2022, workspace: "" }, f.root), MIXIN_OPS_CONSOLE: "1", MIXIN_OPS_TASK_ID: "synthetic", FIXTURE_PROJECT: f.root };
    const scenarios: [Record<string, string>, boolean, string][] = [
      [install, true, "通过：install"],
      [{ ...install, MIXIN_OPS_MODELS_DRAFT: "" }, false, "配置草稿"],
      [{ ...install, MIXIN_OPS_TASK_ID: "" }, false, "任务记录"],
      [{ ...install, MIXIN_OPS_CONSOLE: "" }, true, "通过：deploy"],
      [deploy, false, "已有配置"],
      [{ ...deploy, MIXIN_OPS_APP_DRAFT: install.MIXIN_OPS_APP_DRAFT }, false, "只有首次部署"],
    ];
    for (const [env, okay, message] of scenarios) {
      const child = Bun.spawn(windows ? ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script] : ["bash", script], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, env: { ...process.env, ...env },
      });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, out + err).toBe(okay ? 0 : 3); expect(out + err).toContain(message);
      // macOS runs the same checks in TypeScript.
      let native = "";
      try { assertConsoleLifecycle(consoleLifecycle(env), f.root, "main", env); native = `通过：${consoleLifecycle(env)}`; } catch (error) { native = (error as Error).message; }
      expect(native).toContain(message);
    }
  } finally { await f.cleanup(); }
}, 30_000);

test.skipIf(process.platform !== "win32")("Windows 网页不接受 Read-YesNo 默认值", async () => {
  const f = await tempFixture("lifecycle-preview-");
  try {
    const script = join(f.root, "run.ps1");
    writeFileSync(script, "\uFEFF" + [
      "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
      ". " + quote(join(repo, "scripts/lib/common.ps1")),
      "$env:MIXIN_OPS_CONSOLE='1'",
      "try { Read-YesNo '不得询问' $true; throw 'unexpected default' } catch { if($_.Exception.Message -notlike '*未提供的交互选择*'){throw}; Write-Host $_.Exception.Message }",
    ].join("\r\n"));
    const child = Bun.spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, env: { ...process.env, FIXTURE_PROJECT: f.root },
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, out + err).toBe(0); expect(out).toContain("未提供的交互选择");
  } finally { await f.cleanup(); }
});
