import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostedTask, unregisterTask } from "../../console/server/task-host.ts";
import { runCommand, type Runner } from "../../ops/core/hosting.ts";
import { TaskStore, type TaskObservers } from "../../ops/core/tasks.ts";
import { tempFixture } from "../helpers/temp.ts";

// Execute the production -Command in Windows PowerShell, replacing only the two
// Scheduler cmdlets. WriteError preserves ErrorAction and native exit semantics;
// returning canned Runner exit codes would miss the suppressed-error regression.
const harness = `
$global:fixtureMode = $env:FIXTURE_MODE
function Get-ScheduledTask {
    [CmdletBinding()]
    param($TaskName, $TaskPath)
    [IO.File]::AppendAllText($env:FIXTURE_CALLS, "get $TaskPath$TaskName\n")
    $id='CmdletizationQuery_NotFound'; $category=[Management.Automation.ErrorCategory]::ObjectNotFound
    switch ($global:fixtureMode) {
        'present' { [pscustomobject]@{State='Ready'}; return }
        'vanished' { [pscustomobject]@{State='Ready'}; return }
        'unregister-denied' { [pscustomobject]@{State='Ready'}; return }
        'absent-path' { $id='CmdletizationQuery_NotFound_TaskPath' }
        'absent-name' { $id='CmdletizationQuery_NotFound_TaskName' }
        'denied' { $id='AccessDenied'; $category=[Management.Automation.ErrorCategory]::PermissionDenied }
        'cim-error' { $id='CimException'; $category=[Management.Automation.ErrorCategory]::NotSpecified }
        'unrelated-not-found' { $id='OtherResourceMissing' }
        'not-found-id-permission' { $category=[Management.Automation.ErrorCategory]::PermissionDenied }
    }
    $PSCmdlet.WriteError([Management.Automation.ErrorRecord]::new([Exception]::new('fixture scheduler query failure'), $id, $category, $TaskName))
}
function Unregister-ScheduledTask {
    [CmdletBinding()]
    param($TaskName, $TaskPath, [switch]$Confirm)
    [IO.File]::AppendAllText($env:FIXTURE_CALLS, "unregister $TaskPath$TaskName\n")
    if ($global:fixtureMode -eq 'present') { return }
    $id='CmdletizationQuery_NotFound'; $category=[Management.Automation.ErrorCategory]::ObjectNotFound
    switch ($global:fixtureMode) {
        'absent-path' { $id='CmdletizationQuery_NotFound_TaskPath' }
        'absent-name' { $id='CmdletizationQuery_NotFound_TaskName' }
        'denied' { $id='AccessDenied'; $category=[Management.Automation.ErrorCategory]::PermissionDenied }
        'unregister-denied' { $id='AccessDenied'; $category=[Management.Automation.ErrorCategory]::PermissionDenied }
        'cim-error' { $id='CimException'; $category=[Management.Automation.ErrorCategory]::NotSpecified }
        'unrelated-not-found' { $id='OtherResourceMissing' }
        'not-found-id-permission' { $category=[Management.Automation.ErrorCategory]::PermissionDenied }
    }
    $PSCmdlet.WriteError([Management.Automation.ErrorRecord]::new([Exception]::new('fixture scheduler unregister failure'), $id, $category, $TaskName))
}
`;

async function fixture() {
  const f = await tempFixture("windows-task-cleanup-");
  const script = join(f.root, "scheduler.ps1"), callsFile = join(f.root, "calls.txt");
  writeFileSync(script, "\ufeff" + harness);
  writeFileSync(callsFile, "");
  let mode = "absent";
  const run: Runner = async (argv, env) => {
    expect(argv.slice(0, -1)).toEqual(["powershell", "-NoProfile", "-NonInteractive", "-Command"]);
    // Set Stop before loading the fixture: a blocked/missing script must never
    // fall through to the real Scheduler cmdlets. Bypass is local to this child.
    const command = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; . $env:FIXTURE_SCRIPT; "
      + "if ((Get-Command Get-ScheduledTask).CommandType -ne 'Function' -or (Get-Command Unregister-ScheduledTask).CommandType -ne 'Function') { throw 'Scheduler fixture not loaded' }; " + argv.at(-1);
    return runCommand([argv[0]!, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
      ...env, FIXTURE_SCRIPT: script, FIXTURE_CALLS: callsFile, FIXTURE_MODE: mode,
    });
  };
  const store = new TaskStore(join(f.root, ".console"), () => 1000);
  const observers: TaskObservers = { hosting: (request, actor) => hostedTask(request, actor, run), needsRecovery: async () => false };
  const create = (key: string, failed = false) => {
    const { id } = store.create({ project: f.root, mechanism: "windows-task", planId: key, operation: "stop", params: {} }, key);
    store.bindKey(key, id);
    store.accept(id, { pid: 1, startedAt: "fixture" });
    store.finish(id, { outcome: failed ? "failed" : "success", exitCode: failed ? 1 : 0, finalState: "stopped", message: "done" });
    return store.request(id);
  };
  return { ...f, store, observers, run, create, mode: (value: string) => { mode = value; },
    calls: () => readFileSync(callsFile, "utf8").trim().split("\n"),
    clear: () => store.clearHistory(observers, { cleanup: request => unregisterTask(request, run) }),
  };
}

test.skipIf(process.platform !== "win32")("Windows 已注销的托管任务不阻止成功和失败历史清理，防重放键继续保留", async () => {
  const f = await fixture();
  try {
    const success = f.create("success"), failed = f.create("failed", true);
    const cleared = await f.clear();
    expect({ ...cleared, removed: cleared.removed.sort() }).toEqual({ removed: [success.id, failed.id].sort(), retained: 0, failed: 0 });
    for (const request of [success, failed]) {
      expect(existsSync(f.store.dir(request.id))).toBe(false);
      expect(f.store.lookupSubmission(request.planId)).toBe(request.id);
      expect(f.calls()).toContain(`unregister \\MixinConsole\\mixin-console-${request.id}`);
    }
  } finally { await f.cleanup(); }
}, 60_000);

test.skipIf(process.platform !== "win32")("Windows 注销接受正常完成、并发已删除和不同形式的不存在错误", async () => {
  const f = await fixture();
  try {
    const request = f.create("variants");
    for (const mode of ["present", "vanished", "absent-path", "absent-name"]) {
      f.mode(mode);
      await expect(unregisterTask(request, f.run)).resolves.toBeUndefined();
      expect(await hostedTask(request, { pid: 1, startedAt: "fixture" }, f.run)).toEqual({ state: "ended" });
    }
  } finally { await f.cleanup(); }
}, 60_000);

test.skipIf(process.platform !== "win32")("Windows 权限和 CIM 错误不能当作任务不存在，无法确认状态时不清理记录", async () => {
  const f = await fixture();
  try {
    const request = f.create("query-failure");
    for (const mode of ["denied", "cim-error", "unrelated-not-found", "not-found-id-permission"]) {
      f.mode(mode);
      const callsBefore = f.calls().length;
      expect(await f.clear()).toEqual({ removed: [], retained: 1, failed: 0 });
      expect(f.calls().slice(callsBefore).some(call => call.startsWith("unregister "))).toBe(false);
      expect(f.store.request(request.id)).toEqual(request);
      await expect(unregisterTask(request, f.run)).rejects.toThrow("托管项尚未清除");
    }
  } finally { await f.cleanup(); }
}, 60_000);

test.skipIf(process.platform !== "win32")("Windows 注销真正失败时保留记录，之后托管项已不存在可重试清理", async () => {
  const f = await fixture();
  try {
    const request = f.create("retry");
    f.mode("unregister-denied");
    expect(await f.clear()).toEqual({ removed: [], retained: 0, failed: 1 });
    expect(f.store.request(request.id)).toEqual(request);
    f.mode("absent");
    expect(await f.clear()).toEqual({ removed: [request.id], retained: 0, failed: 0 });
    expect(f.store.lookupSubmission("retry")).toBe(request.id);
  } finally { await f.cleanup(); }
}, 60_000);
