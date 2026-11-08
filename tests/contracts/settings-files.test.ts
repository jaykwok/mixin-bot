import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { REQUIRED_SETTINGS, SETTINGS_FILES, snapshotPaths } from "../../ops/lib/settings-files.ts";

const repository = resolve(import.meta.dir, "../..");
const read = (path: string) => readFile(join(repository, path), "utf8");
/** The quoted items of the first `pattern` match in `text`: a shell word list or a PowerShell @(...) array. */
function listed(text: string, pattern: RegExp): string[] {
  const match = text.match(pattern);
  if (!match) throw new Error(`no list for ${pattern}`);
  return match[1]!.trim().split(/[\s,]+/).map(item => item.replace(/^'|'$/g, "").replaceAll("\\", "/"));
}

test("设置文件清单：路径唯一，快照集合与恢复次序在各平台一致", () => {
  expect(new Set(SETTINGS_FILES.map(file => file.path)).size).toBe(SETTINGS_FILES.length);
  for (const file of SETTINGS_FILES) {
    expect(file.path, file.path).toMatch(/^(?:data\/(?:config|runtime|state)\/)[\w./-]+$/);
    // data/config is saved as one directory, so a file in it cannot leave a snapshot out.
    if (file.path.startsWith("data/config/")) expect(file.snapshot, file.path).toEqual(["docker", "windows", "macos"]);
  }
  expect(snapshotPaths("docker")).toEqual(["data/config", "data/runtime/pi/settings.json", "data/runtime/models-store.json", "data/state/bot-port",
    "data/state/workspace-root", "data/state/task-runtime"]);
  expect(snapshotPaths("macos")).toEqual(["data/config", "data/runtime/pi/settings.json", "data/runtime/models-store.json", "data/state/bot-port", "data/state/workspace-root"]);
  expect(REQUIRED_SETTINGS).toEqual(["data/config/models.json", "data/config/app-bot.json", "data/runtime/pi/settings.json"]);
});

test("Shell 和 PowerShell 入口的设置文件列表与清单一致", async () => {
  expect(listed(await read("ops/core/windows-deployment-platform.ps1"), /^\s*\$paths = @\(([^)]*)\)/m)).toEqual(snapshotPaths("windows"));
  expect(listed(await read("scripts/lib/console-plan.sh"), /for required in ([^;]*);/)).toEqual(REQUIRED_SETTINGS);
  expect(listed(await read("scripts/lib/console-plan.ps1"), /foreach \(\$required in @\(([^)]*)\)\)/)).toEqual(REQUIRED_SETTINGS);
});

test("代码提到的 data/config 文件都在设置文件清单里", async () => {
  const registered = new Set(SETTINGS_FILES.map(file => file.path)), named = new Set<string>();
  for (const directory of ["src", "ops", "console/server", "scripts"]) {
    const entries = await readdir(join(repository, directory), { recursive: true, withFileTypes: true });
    for (const entry of entries.filter(entry => entry.isFile() && /\.(?:tsx?|sh|ps1)$/.test(entry.name))) {
      const text = await readFile(join(entry.parentPath, entry.name), "utf8");
      for (const match of text.matchAll(/data\/config\/([\w-]+\.\w+)|(?:CONFIG_DIR, |"config", )"([\w-]+\.\w+)"/g)) named.add(`data/config/${match[1] ?? match[2]}`);
    }
  }
  expect([...named].filter(path => !registered.has(path))).toEqual([]);
  expect(named.size).toBeGreaterThan(5);
});
