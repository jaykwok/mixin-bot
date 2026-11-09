import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browse } from "../../console/server/files.ts";
import type { BrowseEntry, BrowseResponse } from "../../console/ui/src/contract.ts";
import { tempFixture } from "../helpers/temp.ts";

const entry = (listing: BrowseResponse, name: string): BrowseEntry => {
  const found = listing.entries.find(item => item.name === name);
  if (!found) throw new Error(`没有 ${name}：${listing.entries.map(item => item.name).join(", ")}`);
  return found;
};
const link = (target: string, path: string) => symlink(target, path, process.platform === "win32" ? "junction" : "dir");

/** A project with the default workspace, an external directory, a stray template and a runtime environment. */
async function project(prefix: string, external = false) {
  const f = await tempFixture(prefix), root = join(f.root, "project");
  for (const dir of ["data/state", "data/runtime/document-env", "workspace/templates", "shared/venv", "elsewhere"]) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, "workspace/templates/brand.pptx"), "x");
  await writeFile(join(root, "workspace/notes.txt"), "x");
  await writeFile(join(root, "data/brand.potx"), "x");
  await writeFile(join(root, "shared/deck.pptx"), "x");
  await writeFile(join(root, "elsewhere/a.pptx"), "x");
  await writeFile(join(root, "elsewhere/.secret"), "x");
  await writeFile(join(root, "elsewhere/stats.sqlite"), "x");
  if (external) await writeFile(join(root, "data/state/workspace-root"), join(root, "shared") + "\n");
  return { ...f, project: root };
}

test("原生部署：选择框按主机路径填值，模板在共享资料里填相对路径，按字段当前值打开并选中", async () => {
  const f = await project("console-files-native-");
  try {
    const run = (body: unknown) => browse(f.project, body, "windows");
    const templates = await run({ purpose: "pptx-template", path: join(f.project, "workspace/templates") });
    expect(templates).toMatchObject({ select: "file", path: join(f.project, "workspace/templates"), current: null, selected: null, truncated: false });
    expect(entry(templates, "brand.pptx")).toMatchObject({ kind: "file", size: 1, value: "templates/brand.pptx" });
    const workspace = await run({ purpose: "pptx-template", path: join(f.project, "workspace") });
    expect(entry(workspace, "templates")).toMatchObject({ kind: "directory", value: null });
    expect(entry(workspace, "notes.txt")).toMatchObject({ value: null, reason: "需要 .pptx 或 .potx 文件" });
    const elsewhere = await run({ purpose: "pptx-template", path: join(f.project, "elsewhere") });
    expect(entry(elsewhere, "a.pptx").value).toBe(join(f.project, "elsewhere/a.pptx"));
    // Dotfiles stay out of the list unless asked for.
    expect(elsewhere.entries.map(item => item.name)).not.toContain(".secret");
    expect(entry(await run({ purpose: "pptx-template", path: join(f.project, "elsewhere"), hidden: true }), ".secret")).toMatchObject({ hidden: true });
    // The field's present value opens its directory with it selected; a relative template is found in the shared workspace.
    expect(await run({ purpose: "pptx-template", from: "templates/brand.pptx" })).toMatchObject({ path: join(f.project, "workspace/templates"), selected: "brand.pptx" });
    expect(await run({ purpose: "pptx-template", from: join(f.project, "elsewhere/missing/deck.pptx") })).toMatchObject({ path: join(f.project, "elsewhere"), selected: null });
    // A typed file path opens its directory with the file selected.
    expect(await run({ purpose: "stats", path: join(f.project, "elsewhere/stats.sqlite") })).toMatchObject({ path: join(f.project, "elsewhere"), selected: "stats.sqlite" });
    expect(entry(await run({ purpose: "stats", path: join(f.project, "elsewhere") }), "stats.sqlite").value).toBe(join(f.project, "elsewhere/stats.sqlite"));
    const env = await run({ purpose: "document-env", path: join(f.project, "data/runtime") });
    expect(env).toMatchObject({ select: "directory", current: { value: join(f.project, "data/runtime") } });
    expect(entry(env, "document-env").value).toBe(join(f.project, "data/runtime/document-env"));
    // Without a value the environment picker starts beside the default environment.
    expect((await run({ purpose: "document-env" })).path).toBe(join(f.project, "data/runtime"));
    const places = (await run({ purpose: "stats" })).places;
    expect(places.slice(0, 3)).toEqual([{ label: "项目目录", path: f.project, kind: "project" }, { label: "数据目录", path: join(f.project, "data"), kind: "data" },
      { label: "共享资料", path: join(f.project, "workspace"), kind: "workspace" }]);
  } finally { await f.cleanup(); }
});

test("超过 2000 项的目录只列前 2000 项，但输入的完整路径或字段当前值指向的文件总在结果里并被选中", async () => {
  const f = await project("console-files-large-");
  try {
    const big = join(f.project, "elsewhere/big");
    await mkdir(big);
    for (let start = 0; start < 2100; start += 100) {
      await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(big, `stats-${String(start + index).padStart(4, "0")}.sqlite`), "")));
    }
    const run = (body: unknown) => browse(f.project, body, "windows");
    const listing = await run({ purpose: "stats", path: big });
    expect({ count: listing.entries.length, truncated: listing.truncated }).toEqual({ count: 2000, truncated: true });
    // The listing order is the file system's: take a file it left out.
    const shown = new Set(listing.entries.map(item => item.name));
    const outside = Array.from({ length: 2100 }, (_, index) => `stats-${String(index).padStart(4, "0")}.sqlite`).find(name => !shown.has(name))!;
    for (const body of [{ purpose: "stats", path: join(big, outside) }, { purpose: "stats", from: join(big, outside) }]) {
      const opened = await run(body);
      expect({ path: opened.path, selected: opened.selected, truncated: opened.truncated }).toEqual({ path: big, selected: outside, truncated: true });
      expect(entry(opened, outside).value).toBe(join(big, outside));
      expect(opened.entries.filter(item => item.name === outside)).toHaveLength(1);
    }
    // Windows and macOS ignore case: a typed path in another case selects the listed name, listed once.
    if (process.platform !== "linux") {
      const listed = listing.entries[0]!.name, typed = await run({ purpose: "stats", path: join(big, listed.toUpperCase()) });
      expect(typed.selected).toBe(listed);
      expect(typed.entries.filter(item => item.name.toLowerCase() === listed.toLowerCase()).map(item => item.name)).toEqual([listed]);
    }
  } finally { await f.cleanup(); }
}, 60_000);

/** Whether the temporary directory tells case apart (Linux; a case-sensitive macOS volume or Windows directory). */
const caseSensitive = (() => {
  const dir = mkdtempSync(join(tmpdir(), "console-files-case-probe-"));
  try { writeFileSync(join(dir, "a"), ""); return !existsSync(join(dir, "A")); } finally { rmSync(dir, { recursive: true, force: true }); }
})();

test.skipIf(!caseSensitive)("区分大小写的目录里，Windows 和 macOS 的规则也先认精确的名字；只差大小写的是另一个文件，单独列出", async () => {
  const f = await project("console-files-case-");
  try {
    const dir = join(f.project, "elsewhere/case");
    await mkdir(dir);
    await writeFile(join(dir, "report.sqlite"), "lower"); await writeFile(join(dir, "Report.sqlite"), "upper!");
    for (const platform of ["macos", "windows"] as const) for (const typed of ["report.sqlite", "Report.sqlite"]) {
      const opened = await browse(f.project, { purpose: "stats", path: join(dir, typed) }, platform);
      expect(opened.selected).toBe(typed);
      expect(opened.entries.map(item => item.name).sort()).toEqual(["Report.sqlite", "report.sqlite"]);
      expect(entry(opened, typed)).toMatchObject({ size: typed === "report.sqlite" ? 5 : 6, value: join(dir, typed) });
    }
  } finally { await f.cleanup(); }
});

test("共享资料目录的选择与部署前检查同一规则：包含数据目录、位于受管目录内或就是默认目录的不能选", async () => {
  const f = await project("console-files-workspace-");
  try {
    const run = (path: string) => browse(f.project, { purpose: "workspace", path }, "windows");
    const root = await run(f.project);
    expect(root.current?.value).toBeNull(); expect(root.current?.reason).toContain("包含数据目录");
    expect(entry(root, "data").reason).toContain("包含数据目录");
    expect(entry(root, "shared").value).toBe(join(f.project, "shared"));
    expect(entry(root, "workspace")).toMatchObject({ value: null, reason: "这是默认的共享资料目录：输入框留空即可" });
    const data = await run(join(f.project, "data"));
    expect(entry(data, "state").reason).toContain("位于受管目录");
    expect(entry(data, "brand.potx")).toMatchObject({ kind: "file", value: null, reason: "这里需要选择目录" });
  } finally { await f.cleanup(); }
});

test("Docker 部署：文档环境和模板换成服务容器里的路径，容器看不到的位置不能选；LibreOffice 路径不能从主机选", async () => {
  const f = await project("console-files-docker-", true);
  try {
    // Links resolve before translation: what the container sees is where they point.
    await link(join(f.project, "elsewhere"), join(f.project, "data/outside"));
    await link(join(f.project, "data/runtime"), join(f.project, "elsewhere/inside"));
    const run = (body: unknown) => browse(f.project, body, "linux");
    const runtime = await run({ purpose: "document-env", path: join(f.project, "data/runtime") });
    expect(runtime.current?.value).toBe("/app/data/runtime");
    expect(entry(runtime, "document-env").value).toBe("/app/data/runtime/document-env");
    expect(entry(await run({ purpose: "document-env", path: join(f.project, "shared") }), "venv").value).toBe("/app/workspace/venv");
    const root = await run({ purpose: "document-env", path: f.project });
    expect(entry(root, "elsewhere")).toMatchObject({ value: null, reason: "服务容器看不到这里：只能选数据目录或共享资料目录里的目录" });
    expect(entry(await run({ purpose: "document-env", path: join(f.project, "data") }), "outside")).toMatchObject({ link: true, value: null });
    expect(entry(await run({ purpose: "document-env", path: join(f.project, "elsewhere") }), "inside")).toMatchObject({ link: true, value: "/app/data/runtime" });
    // Templates: in the shared workspace a relative path, elsewhere in data its container path, outside both refused.
    expect(entry(await run({ purpose: "pptx-template", path: join(f.project, "shared") }), "deck.pptx").value).toBe("deck.pptx");
    expect(entry(await run({ purpose: "pptx-template", path: join(f.project, "data") }), "brand.potx").value).toBe("/app/data/brand.potx");
    expect(entry(await run({ purpose: "pptx-template", path: join(f.project, "elsewhere") }), "a.pptx")).toMatchObject({ value: null, reason: "服务容器看不到这里：请把模板放进共享资料目录" });
    // Container paths in the field open where they live on the host; a path inside the image opens the start location.
    expect(await run({ purpose: "document-env", from: "/app/data/runtime/document-env" })).toMatchObject({ path: join(f.project, "data/runtime"), selected: "document-env" });
    expect(await run({ purpose: "document-env", from: "/app/workspace/venv" })).toMatchObject({ path: join(f.project, "shared"), selected: "venv" });
    expect(await run({ purpose: "document-env", from: "/opt/env" })).toMatchObject({ path: join(f.project, "data/runtime"), selected: null });
    expect(await run({ purpose: "pptx-template", from: "deck.pptx" })).toMatchObject({ path: join(f.project, "shared"), selected: "deck.pptx" });
    // The deployment's own workspace field is a host path even under Docker.
    expect(entry(await run({ purpose: "workspace", path: f.project }), "shared").value).toBe(join(f.project, "shared"));
    await expect(run({ purpose: "office" })).rejects.toThrow("隔离任务的容器");
    expect((await run({ purpose: "stats" })).places.at(-1)).toEqual({ label: "根目录", path: "/", kind: "root" });
  } finally { await f.cleanup(); }
});

test("LibreOffice：Windows 只接受 soffice.exe，macOS 选整个 LibreOffice.app 并填入其中的 soffice", async () => {
  const f = await tempFixture("console-files-office-");
  try {
    await mkdir(join(f.root, "data"), { recursive: true });
    await mkdir(join(f.root, "program"), { recursive: true });
    await writeFile(join(f.root, "program/soffice.exe"), "x"); await writeFile(join(f.root, "program/swriter.exe"), "x");
    const windows = await browse(f.root, { purpose: "office", path: join(f.root, "program") }, "windows");
    expect(entry(windows, "soffice.exe").value).toBe(join(f.root, "program/soffice.exe"));
    expect(entry(windows, "swriter.exe")).toMatchObject({ value: null, reason: "请选择 LibreOffice 的 soffice.exe" });
    await mkdir(join(f.root, "Applications/LibreOffice.app/Contents/MacOS"), { recursive: true });
    await writeFile(join(f.root, "Applications/LibreOffice.app/Contents/MacOS/soffice"), "x");
    await mkdir(join(f.root, "Applications/Notes.app"), { recursive: true });
    const macos = await browse(f.root, { purpose: "office", path: join(f.root, "Applications") }, "macos");
    expect(entry(macos, "LibreOffice.app")).toMatchObject({ kind: "app", value: join(f.root, "Applications/LibreOffice.app/Contents/MacOS/soffice") });
    expect(entry(macos, "Notes.app")).toMatchObject({ kind: "app", value: null, reason: "这个应用里没有 soffice" });
    // An application is chosen as a whole: typed or as the field's value, it opens its folder with it selected.
    expect(await browse(f.root, { purpose: "office", path: join(f.root, "Applications/LibreOffice.app") }, "macos")).toMatchObject({ path: join(f.root, "Applications"), selected: "LibreOffice.app" });
    expect(await browse(f.root, { purpose: "office", from: join(f.root, "Applications/LibreOffice.app/Contents/MacOS/soffice") }, "macos"))
      .toMatchObject({ path: join(f.root, "Applications"), selected: "LibreOffice.app" });
  } finally { await f.cleanup(); }
});

test("选择框拒绝无效参数、相对路径、控制字符和设备路径，读不到的目录说明原因", async () => {
  const f = await project("console-files-refuse-");
  try {
    const run = (body: unknown) => browse(f.project, body, "windows");
    for (const body of [null, { purpose: "secrets" }, { purpose: "stats", extra: 1 }, { purpose: "stats", path: 1 }, { purpose: "stats", hidden: "yes" }, { purpose: "stats", path: "x".repeat(4097) }]) {
      await expect(run(body), JSON.stringify(body)).rejects.toMatchObject({ status: 400, message: "选择框参数无效" });
    }
    await expect(run({ purpose: "stats", path: "data" })).rejects.toMatchObject({ status: 409, message: "请输入绝对路径" });
    await expect(run({ purpose: "stats", path: join(f.project, "a\u0001b") })).rejects.toThrow("控制字符");
    await expect(run({ purpose: "stats", path: "\\\\.\\PhysicalDrive0" })).rejects.toThrow("设备路径");
    await expect(run({ purpose: "stats", path: "//?/C:/Windows" })).rejects.toThrow("设备路径");
    await expect(run({ purpose: "stats", path: join(f.project, "missing") })).rejects.toThrow(`找不到 ${join(f.project, "missing")}`);
    // A broken field value is no error: the picker opens at its start.
    expect((await run({ purpose: "stats", from: "a\u0001b" })).path).toBeTruthy();
  } finally { await f.cleanup(); }
});
