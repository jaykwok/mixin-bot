import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { opsCommand, type Platform } from "../../ops/core/platform.ts";
import { upgradeRoutes } from "../../console/server/upgrade-routes.ts";
import { operationArgs } from "../../ops/core/operations.ts";
import { operationPreparer } from "../../console/server/prepare-operation.ts";
import { Views } from "../../console/server/views.ts";
import type { RouteContext } from "../../console/server/routes.ts";
import { DATA_VERSION } from "../../src/core/version.ts";
import { tempFixture } from "../helpers/temp.ts";
import { opsShellFunctions } from "../helpers/ops-shell.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const posix = (value: string) => value.replaceAll(String.fromCharCode(92), "/");
const quote = (value: string) => "'" + posix(value).replaceAll("'", "'\\''") + "'";
const quotePS = (value: string) => "'" + value.replaceAll("'", "''") + "'";
async function execute(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, output: stdout + stderr };
}

for (const platform of ["linux", "windows"] as Platform[]) test.skipIf(platform === "windows" ? process.platform !== "win32" : process.platform !== "linux")(
  `${platform}: console dispatch retains confirmed SHA after a newer release; plain CLI fetches the release tags and takes the latest`, async () => {
    const fixture = await tempFixture("upgrade-target-");
    try {
      const repo = join(fixture.root, "repo"), marker = join(fixture.root, "target"), fetches = join(fixture.root, "fetches");
      await mkdir(repo);
      const git = async (...args: string[]) => {
        const result = await execute(["git", "-c", "core.autocrlf=false", ...args], repo);
        if (result.code) throw new Error(result.output);
        return result.output.trim();
      };
      await git("init", "-b", "main"); await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid");
      await mkdir(join(repo, "scripts/lib"), { recursive: true });
      await writeFile(join(repo, "scripts/lib/console-lifecycle.json"), '{"protocol":"mixin-console-lifecycle","version":1}');
      const commits: string[] = [];
      for (const value of ["original", "confirmed", "later"]) {
        await writeFile(join(repo, "version.txt"), value); await git("add", "."); await git("commit", "--quiet", "-m", value);
        commits.push(await git("rev-parse", "HEAD"));
      }
      const [original, confirmed, later] = commits as [string, string, string];
      // Local main is the deployed release; origin's main has moved past the latest release, which never counts. Only
      // stable vX.Y.Z tags are releases, compared by number (v1.0.10 is newer than v1.0.9).
      await git("checkout", "--detach", original); await git("branch", "-f", "main", original);
      await git("tag", "v1.0.0", original); await git("tag", "v1.0.9", original); await git("tag", "-a", "-m", "release", "v1.0.10", confirmed);
      for (const tag of ["v1.1.0-rc.1", "v01.2.0", "v2.0", "vnext", "release-9.9.9"]) await git("tag", tag, original);
      const origin = join(fixture.root, "origin.git");
      await git("init", "--quiet", "--bare", origin); await git("remote", "add", "origin", origin);
      await git("push", "--quiet", "origin", `${later}:refs/heads/main`, "refs/tags/*:refs/tags/*");
      const stateDir = join(repo, "data/state"); await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, "data-version.json"), JSON.stringify({ dataVersion: DATA_VERSION, appVersion: "1.0.9",
        build: original.slice(0, 12), transaction: "deploy-fixture", application: "a".repeat(64) }));
      const sourcePath = platform === "windows" ? "scripts/ops.ps1" : "scripts/ops.sh";
      const source = (await readFile(join(project, sourcePath), "utf8")).replaceAll("\r\n", "\n");
      const script = join(fixture.root, platform === "windows" ? "dispatch.ps1" : "dispatch.sh");
      if (platform === "linux") {
        const start = source.indexOf("\nupdate() {") + 1, end = source.indexOf("\n}\n", start);
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        await writeFile(script, `#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR=${quote(repo)}; STATE_DIR=${quote(stateDir)}
git_here() {
    if [ "\${1:-}" = fetch ]; then
        printf '%s' "$*" >> ${quote(fetches)}
    fi
    git -C "$PROJECT_DIR" "$@"
}
operation_start() { :; }; operation_finish() { :; }; operation_stage() { :; }; operation_event() { :; }
operation_capture() { "$@"; }
remove_upgrade_stage() { :; }; acquire_deploy_lock() { :; }; require_git_checkout() { :; }
P() { :; }; ER() { printf '%s\\n' "$*" >&2; }; WA() { :; }; OK() { printf '%s\\n' "$*"; }; after_upgrade() { :; }
run_target_upgrader() { printf '%s' "$1" > ${quote(marker)}; }
docker() { printf '%s\\n' 'real Docker forbidden' >&2; return 97; }
${await opsShellFunctions("core_reported", "finish_update", "finish_lifecycle_result", "latest_release")}
${source.slice(start, end + 3)}
shift
update "$@"
`);
      } else {
        const definition = source.match(/^function Invoke-Update\([^\n]+[\s\S]*?^\}/m)?.[0];
        const releases = source.match(/^function Get-LatestRelease \{[\s\S]*?^\}/m)?.[0];
        expect(definition).toBeDefined(); expect(releases).toBeDefined();
        await writeFile(script, String.fromCharCode(0xfeff) + `param([string]$RequestBase64)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$Project = ${quotePS(repo)}
function Start-OperationLog {}; function Stop-OperationLog {}; function Set-OperationStage {}; function Write-OperationEvent {}
function Write-OperationFailure {}; function Test-Administrator { $true }; function Get-GitPath { 'git' }; function Get-BunPath { 'synthetic-bun' }
function Err($text) { Write-Host $text }; function Done($text) { Write-Host $text }; function Warn {}; function Step {}; function Remove-UpgradeStage {}
function Invoke-GitCapture([string[]]$Arguments) {
    if ($Arguments[0] -eq 'archive') {
        [IO.File]::WriteAllText(${quotePS(marker)}, $Arguments[3])
        # Stop at the target-upgrader handoff; no deployment or external process runs.
        return [pscustomobject]@{ ExitCode = 91; Text = 'synthetic handoff' }
    }
    if ($Arguments[0] -eq 'fetch') {
        [IO.File]::AppendAllText(${quotePS(fetches)}, ($Arguments -join ' '))
    }
    $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        $text = (& git -C $Project @Arguments 2>&1) -join [Environment]::NewLine
        return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Text = "$text".Trim() }
    } finally { $ErrorActionPreference = $previous }
}
${releases}
${definition}
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RequestBase64)) | ConvertFrom-Json
Invoke-Update -ConfirmedTarget $request.Target | Out-Null
`);
      }
      const dispatch = async (args: string[]) => {
        await writeFile(marker, ""); await writeFile(fetches, "");
        const command = opsCommand(platform, args);
        const cmd = platform === "windows"
          ? ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-RequestBase64", command.args.at(-1)!]
          : [process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash", posix(script), ...command.args.slice(1)];
        return execute(cmd, fixture.root);
      };
      let checkedFetches = 0;
      const routes = upgradeRoutes(repo, async argv => {
        // The remote is a local bare repository; every command is the real one.
        if (argv[3] === "fetch") checkedFetches++;
        const result = await execute(argv, repo);
        return { code: result.code, stdout: result.output, stderr: "" };
      });
      const context: RouteContext = { body: {}, signal: new AbortController().signal, session: {} as RouteContext["session"] };
      const checked = await routes["POST /api/lifecycle/check-update"]!.run(context) as { target: string; release: string };
      expect(checked).toMatchObject({ current: "1.0.9", available: true, target: confirmed, release: "v1.0.10" }); expect(checkedFetches).toBe(1);
      const params = await operationPreparer(repo, new Views())("update", {
        target: checked.target, switchMain: true, directory: "all",
      }, "fixture");
      // A newer release after the preview; the console task keeps the confirmed commit.
      await git("push", "--quiet", "origin", `${later}:refs/tags/v1.0.11`);
      const args = operationArgs("update", params);
      expect(args).toEqual(["update", confirmed]);
      const result = await dispatch(args); expect(result.code, result.output).toBe(0);
      expect(await readFile(marker, "utf8"), result.output).toBe(confirmed); expect(await readFile(fetches, "utf8")).toBe("");
      expect(checkedFetches).toBe(1);
      // The terminal fetches origin's release tags as they are: a local tag that differs is replaced, one origin no
      // longer has is removed, and other tags stay.
      await git("tag", "-f", "v1.0.9", later); await git("tag", "v9.9.9", original); await git("tag", "keep", original);
      const ordinary = await dispatch(["update"]);
      expect(ordinary.code, ordinary.output).toBe(0); expect(await readFile(marker, "utf8")).toBe(later);
      expect(await readFile(fetches, "utf8")).toBe("fetch --prune --no-tags origin +refs/tags/v*:refs/tags/v*");
      expect(await git("rev-parse", "v1.0.9^{commit}")).toBe(original); expect(await git("rev-parse", "keep")).toBe(original);
      expect(await git("tag", "--list", "v9.9.9")).toBe("");
      // Local main already holds the latest release and more: nothing to upgrade to.
      await git("branch", "-f", "main", await git("commit-tree", "-m", "ahead", "-p", later, `${later}^{tree}`));
      const behind = await dispatch(["update"]);
      expect(behind.code, behind.output).toBe(0); expect(behind.output).toContain("本地 main 已包含最新发布 v1.0.11");
      expect(await readFile(marker, "utf8")).toBe("");
      // Main at the release itself still hands over (the upgrader checks the data and redeploys).
      await git("branch", "-f", "main", later);
      expect((await dispatch(["update"])).code).toBe(0); expect(await readFile(marker, "utf8")).toBe(later);
      await git("branch", "-f", "main", original);
      // An origin without releases: nothing is chosen.
      const empty = join(fixture.root, "empty.git");
      await git("init", "--quiet", "--bare", empty); await git("remote", "set-url", "origin", empty);
      const none = await dispatch(["update"]);
      expect(none.output).toContain("远端没有正式发布"); expect(await readFile(marker, "utf8")).toBe("");
      expect(await git("tag", "--list", "v*")).toBe("");
      await git("remote", "set-url", "origin", origin);
      for (const invalid of ["main", "0".repeat(40)]) {
        await dispatch(["update", invalid]); expect(await readFile(marker, "utf8")).toBe("");
        expect(await readFile(fetches, "utf8")).toBe("");
      }
      await writeFile(join(stateDir, platform === "windows" ? "upgrade-transaction" : "deploy-transaction"), "new pending transaction");
      const pending = await dispatch(["update", confirmed]);
      expect(pending.output).toContain("预览后出现未完成的事务"); expect(await readFile(marker, "utf8")).toBe("");
      expect(await git("rev-parse", "HEAD")).toBe(original); expect(await readFile(join(repo, "version.txt"), "utf8")).toBe("original");
    } finally { await fixture.cleanup(); }
  }, 120000,
);
