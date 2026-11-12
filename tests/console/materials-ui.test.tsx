/** @jsxImportSource preact */
// The settings page's materials exclusions form (console/ui/src/materials.tsx): rules as chips, folders opened one level
// at a time, a save of the whole list; and its own copy of the index's matching rule agrees with the index.
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "../helpers/dom.tsx";
import { isIgnored } from "../../src/agent/materials-index.ts";
const registered = !GlobalRegistrator.isRegistered;
if (registered) GlobalRegistrator.register({ url: "http://127.0.0.1:10001/" });
const { render } = await import("preact");
const { MaterialExclusionsForm, excludedBy, ruleText } = await import("../../console/ui/src/materials.tsx");
afterAll(async () => { if (registered) await GlobalRegistrator.unregister(); });
const until = async (check: () => boolean) => { const end = Date.now() + 3000; while (!check() && Date.now() < end) await Bun.sleep(10); expect(check()).toBe(true); };
const button = (root: Element, text: string) => [...root.querySelectorAll("button")].find(value => value.textContent === text)!;
const type = (input: HTMLInputElement, value: string) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); };

test("页面判断文件夹是否已被排除的规则与索引一致；输入的规则按文件的写法整理", () => {
  const rules = ["归档/2023", "**/#Recycle", "sync-tools", "**/旧版/草稿"];
  const lower = rules.map(rule => rule.toLowerCase());
  for (const path of ["归档", "归档/2023", "归档/2023/旧版", "归档/20234", "归档/2024", "Sync-Tools", "sync-tools/rm", "sync-tools2", "a/#recycle", "#recycle/x", "a/#recycle2",
    "产品/旧版/草稿", "旧版/草稿/x", "旧版", "产品/旧版/草稿2"]) {
    expect(excludedBy(path, rules) !== undefined, path).toBe(isIgnored(path, lower));
  }
  expect(excludedBy("归档/2023/旧版", rules)).toBe("归档/2023");
  expect([" 归档\\2023\\ ", "./a/", "/a/b", "**/名字/", "**/"].map(ruleText)).toEqual(["归档/2023", "a", "a/b", "**/名字", "**/"]);
});

test("排除目录表单：列出规则和索引，逐层打开文件夹来排除或恢复，手工输入规则，保存整份列表", async () => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root);
  const saved: { rules: string[] }[] = [], opened: string[] = [];
  let state = { rules: ["sync-tools", "**/#recycle"],
    index: { files: 12345, bytes: 3 * 1024 ** 3, generatedAt: new Date(2026, 10, 12, 9, 30).getTime(), truncated: true, limit: 50000,
      topLevel: [{ name: "产品资料/", files: 300, bytes: 1024 ** 2 }, { name: "归档/", files: 12000, bytes: 2 * 1024 ** 3 }, { name: "（根目录）", files: 45, bytes: 1024 }] } };
  const tree: Record<string, string[]> = { "": ["sync-tools", "产品资料", "归档"], "归档": ["2023", "2024", "#recycle"], "归档/2023": [] };
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    // Components of earlier files in the same process may still finish; only this form's requests are answered.
    if (!String(url).startsWith("/api/materials/")) return new Response("{}");
    if (String(url) === "/api/materials/folders") {
      const { path } = JSON.parse(String(options!.body)) as { path: string };
      opened.push(path);
      return Response.json({ path, folders: tree[path] ?? [], more: path === "归档" });
    }
    if (options?.method === "POST") {
      const body = JSON.parse(String(options.body)) as { rules: string[] };
      saved.push(body);
      if (body.rules.includes("坏*")) return Response.json({ error: "第 4 条「坏*」：除开头的 **/ 外不支持通配符", code: "input" }, { status: 409 });
      state = { ...state, rules: body.rules };
    }
    return Response.json(state);
  }) as typeof fetch;
  try {
    render(<MaterialExclusionsForm />, root);
    await until(() => root.querySelectorAll(".materials-folders li").length === 3);
    const chips = () => [...root.querySelectorAll(".materials-rules .chip")].map(chip => chip.textContent);
    const rows = () => [...root.querySelectorAll(".materials-folders li")].map(row => row.textContent);
    expect(chips()).toEqual(["sync-tools", "**/#recycle"]);
    expect(root.textContent).toContain("当前索引 12,345 个文件，3.00 GB，生成于 2026-11-12 09:30。");
    expect(root.textContent).toContain("索引不完整：达到 50,000 个文件的上限");
    // The top level shows what each folder has in the index; an excluded folder says so and can be restored.
    expect(rows()).toEqual(["sync-tools已排除恢复", "产品资料300 个文件，1.0 MB排除", "归档12,000 个文件，2.00 GB排除"]);
    expect(button(root, "保存").disabled).toBe(true);
    // Into 归档: 2023 is excluded by a click; #recycle is already left out by the any-level rule, which is not this folder's own to restore.
    button(root, "归档").click();
    await until(() => rows().length === 4);
    expect(rows()).toEqual(["2023排除", "2024排除", "#recycle已排除", "文件夹太多，只列出前一部分；其余的请直接输入路径。"]);
    root.querySelector<HTMLButtonElement>('button[aria-label="排除 归档/2023"]')!.click();
    await until(() => chips().length === 3);
    expect(chips()).toEqual(["sync-tools", "**/#recycle", "归档/2023"]);
    expect(rows()[0]).toBe("2023已排除恢复");
    // Back at the top through the trail: 归档 itself is not excluded, only a folder in it.
    button(root, "共享资料").click();
    await until(() => rows().length === 3);
    expect(rows()[2]).toBe("归档12,000 个文件，2.00 GB排除");
    button(root, "恢复").click();
    await until(() => chips().length === 2);
    expect(rows()[0]).toBe("sync-tools排除");
    // Typed rules: tidied, no repeats (in any case), an empty one refused.
    const input = root.querySelector<HTMLInputElement>('input[aria-label="添加排除规则"]')!;
    type(input, " 产品资料\\旧版\\ ");
    await until(() => !button(root, "加入规则").disabled);
    button(root, "加入规则").click();
    await until(() => chips().length === 3);
    expect(input.value).toBe("");
    type(input, "归档/2023/");
    await until(() => !button(root, "加入规则").disabled);
    button(root, "加入规则").click();
    await until(() => root.textContent!.includes("规则「归档/2023」已在列表里"));
    expect(chips()).toEqual(["**/#recycle", "归档/2023", "产品资料/旧版"]);
    // A rule the service refuses: its reason is shown and the list on the page stays as edited.
    type(input, "坏*");
    await until(() => input.value === "坏*");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await until(() => chips().length === 4);
    button(root, "保存").click();
    await until(() => root.textContent!.includes("除开头的 **/ 外不支持通配符"));
    expect(chips()).toHaveLength(4);
    root.querySelector<HTMLButtonElement>('button[aria-label="移除规则 坏*"]')!.click();
    await until(() => chips().length === 3);
    button(root, "保存").click();
    await until(() => root.textContent!.includes("已保存。索引正在按新规则重新生成"));
    expect(saved.at(-1)).toEqual({ rules: ["**/#recycle", "归档/2023", "产品资料/旧版"] });
    expect(button(root, "保存").disabled).toBe(true);
    expect(opened).toEqual(["", "归档", ""]);
  } finally { render(null, root); root.remove(); globalThis.fetch = previous; }
});
