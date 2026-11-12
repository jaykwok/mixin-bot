// The console's side of the materials exclusion rules (src/agent/materials-exclusions.ts): what a rule may be, a save that
// keeps the file's comment lines and that the index then follows, and the folder listing the page chooses from.
import { afterAll, expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EXCLUSION_LIMITS, materialExclusions, materialFolders, parseExclusionRules, readExclusionRules,
  saveExclusionRules } from "../../src/agent/materials-exclusions.ts";
import { ensureMaterialsIndex, isIgnored, loadIgnorePrefixes } from "../../src/agent/materials-index.ts";
import { MATERIALS_INDEX_MAX_DEPTH, MATERIALS_INDEX_MAX_FILES } from "../../src/core/config.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("materials-exclusions-");
afterAll(() => fixture.cleanup());
let counter = 0;
async function instance() {
  const root = join(fixture.root, `case-${++counter}`), workspace = join(root, "workspace");
  await mkdir(join(root, "config"), { recursive: true });
  await mkdir(join(root, "index"), { recursive: true });
  for (const dir of ["产品资料/安全大脑", "归档/2023/旧版", "归档/2024", "sync-tools/rm", ".venv/Scripts", "node_modules/x"]) await mkdir(join(workspace, dir), { recursive: true });
  await Promise.all([["产品资料/安全大脑/介绍.pptx", 2048], ["归档/2023/旧版/手册.pdf", 1024], ["归档/2024/手册.pdf", 512], ["sync-tools/rm/tool.exe", 4096], ["说明.txt", 10]]
    .map(([path, size]) => writeFile(join(workspace, path as string), "a".repeat(size as number))));
  return { workspace, ignorePath: join(root, "config", "materials-ignore.txt"), indexPath: join(root, "index", "materials.md") };
}

test("a rule is a path from the workspace or a name at any level: normalised, without repeats, and refused with the reason otherwise", () => {
  expect(parseExclusionRules([" 归档\\2023\\ ", "./sync-tools/", "/产品资料/旧版", "**/#recycle", "**/回收站/", "SYNC-TOOLS", "a b/c d"]))
    .toEqual(["归档/2023", "sync-tools", "产品资料/旧版", "**/#recycle", "**/回收站", "a b/c d"]);
  expect(parseExclusionRules([])).toEqual([]);
  for (const [value, reason] of [
    ["归档", "规则必须是列表"], [[1], "第 1 条：规则必须是文字"], [["归档", "  "], "第 2 条：没有写文件夹的名字或路径"], [["**/"], "没有写文件夹的名字或路径"],
    [["归档/*"], "第 1 条「归档/*」：除开头的 **/ 外不支持通配符"], [["a/**/b"], "不支持通配符"], [["a//b"], "路径里不能有空的一级、. 或 .."], [["a/../b"], ". 或 .."],
    [["#recycle"], "以 # 开头的名字请写成 **/#recycle"], [["a\nb"], "有不能使用的字符"], [["长".repeat(EXCLUSION_LIMITS.ruleChars + 1)], `规则不能超过 ${EXCLUSION_LIMITS.ruleChars} 个字`],
    [Array.from({ length: EXCLUSION_LIMITS.rules + 1 }, (_, at) => `f${at}`), `最多 ${EXCLUSION_LIMITS.rules} 条规则`],
  ] as const) expect(() => parseExclusionRules(value), String(reason)).toThrow(reason);
  // The longest rule and the fullest list are accepted.
  expect(parseExclusionRules(["长".repeat(EXCLUSION_LIMITS.ruleChars)])).toHaveLength(1);
  expect(parseExclusionRules(Array.from({ length: EXCLUSION_LIMITS.rules }, (_, at) => `f${at}`))).toHaveLength(EXCLUSION_LIMITS.rules);
});

test("a save writes the rules below the comment lines it found (the template's for a new file), and the index reads them", async () => {
  const { ignorePath } = await instance();
  expect(await readExclusionRules(ignorePath)).toEqual([]);
  await saveExclusionRules(ignorePath, ["归档/2023", "**/#recycle"]);
  const first = await readFile(ignorePath, "utf8");
  expect(first).toStartWith("# 共享资料索引的排除规则");
  expect(first).toEndWith("\n\n归档/2023\n**/#recycle\n");
  expect(await readExclusionRules(ignorePath)).toEqual(["归档/2023", "**/#recycle"]);
  const prefixes = await loadIgnorePrefixes(ignorePath);
  expect(["归档/2023/旧版/手册.pdf", "a/#Recycle/x", "归档/2024/手册.pdf"].map(path => isIgnored(path, prefixes))).toEqual([true, true, false]);
  // A file edited by hand: a BOM, CRLF, the operator's own comments between rules, a trailing slash, a rule the page would not take.
  await writeFile(ignorePath, "\uFEFF# 我的说明\r\nSync-Tools/\r\n\r\n# 归档先不要\r\n归档\\2023\r\n旧*\r\n**\r\n");
  expect(await readExclusionRules(ignorePath)).toEqual(["Sync-Tools", "归档/2023", "旧*"]);
  await saveExclusionRules(ignorePath, ["Sync-Tools"]);
  expect(await readFile(ignorePath, "utf8")).toBe("# 我的说明\n\n# 归档先不要\n\nSync-Tools\n");
  // Saved again unchanged, the file is the same; without rules only the comments stay.
  await saveExclusionRules(ignorePath, ["Sync-Tools"]);
  expect(await readFile(ignorePath, "utf8")).toBe("# 我的说明\n\n# 归档先不要\n\nSync-Tools\n");
  await saveExclusionRules(ignorePath, []);
  expect(await readFile(ignorePath, "utf8")).toBe("# 我的说明\n\n# 归档先不要\n");
});

test("the folders of one level are the ones the index would walk; a path that leaves the workspace or is gone is refused", async () => {
  const { workspace } = await instance();
  let linked = true;
  try { await symlink(join(workspace, "归档"), join(workspace, "链接"), "junction"); } catch { linked = false; }
  expect(await materialFolders(workspace, "")).toEqual({ path: "", folders: ["sync-tools", "产品资料", "归档"].sort((a, b) => a.localeCompare(b)), more: false });
  expect(linked ? (await materialFolders(workspace, "")).folders.includes("链接") : false).toBe(false);
  expect(await materialFolders(workspace, "归档")).toEqual({ path: "归档", folders: ["2023", "2024"], more: false });
  expect((await materialFolders(workspace, "归档/2023")).folders).toEqual(["旧版"]);
  expect((await materialFolders(workspace, "归档/2024")).folders).toEqual([]);
  for (const [path, reason] of [["../outside", "文件夹路径无效"], ["归档/../..", "文件夹路径无效"], ["/归档", "文件夹路径无效"], ["归档\\2023", "文件夹路径无效"], [".venv", "文件夹路径无效"],
    ["node_modules", "文件夹路径无效"], [7, "文件夹路径无效"], ["没有的", "共享资料里已经没有文件夹 没有的"], ["说明.txt", "已经没有文件夹"],
    [Array(MATERIALS_INDEX_MAX_DEPTH).fill("a").join("/"), "超出资料索引的深度"], ...(linked ? [["链接", "已经没有文件夹"]] : [])] as const) {
    await expect(materialFolders(workspace, path), String(path)).rejects.toMatchObject({ name: "ExclusionInput", message: expect.stringContaining(reason) });
  }
  // More folders than one answer lists.
  await Promise.all(Array.from({ length: EXCLUSION_LIMITS.folders + 1 }, (_, at) => mkdir(join(workspace, "归档/2024", `f${String(at).padStart(4, "0")}`))));
  const many = await materialFolders(workspace, "归档/2024");
  expect([many.folders.length, many.more, many.folders[0], many.folders.at(-1)]).toEqual([EXCLUSION_LIMITS.folders, true, "f0000", `f${String(EXCLUSION_LIMITS.folders - 1).padStart(4, "0")}`]);
});

test("the page's view: no index before the first build, then the index of the saved rules", async () => {
  const { workspace, ignorePath, indexPath } = await instance();
  const options = { workspaceDir: workspace, ignorePath, indexPath };
  expect(await materialExclusions(ignorePath, indexPath)).toEqual({ rules: [], index: null });
  await ensureMaterialsIndex(options);
  const before = await materialExclusions(ignorePath, indexPath);
  expect(before.index).toMatchObject({ files: 5, bytes: 2048 + 1024 + 512 + 4096 + 10, truncated: false, limit: MATERIALS_INDEX_MAX_FILES });
  expect(before.index!.topLevel.map(item => [item.name, item.files])).toEqual(expect.arrayContaining([["sync-tools/", 1], ["归档/", 2], ["产品资料/", 1], ["（根目录）", 1]]));
  await saveExclusionRules(ignorePath, parseExclusionRules(["sync-tools", "归档/2023"]));
  await ensureMaterialsIndex(options);
  const after = await materialExclusions(ignorePath, indexPath);
  expect(after.rules).toEqual(["sync-tools", "归档/2023"]);
  expect(after.index).toMatchObject({ files: 3, bytes: 2048 + 512 + 10 });
  expect(after.index!.topLevel.map(item => item.name)).not.toContain("sync-tools/");
  expect(await readFile(indexPath, "utf8")).not.toContain("tool.exe");
});
