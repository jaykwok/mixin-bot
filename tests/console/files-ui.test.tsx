/** @jsxImportSource preact */
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { BrowseEntry, BrowsePurpose, BrowseResponse } from "../../console/ui/src/contract.ts";
const registered = !GlobalRegistrator.isRegistered;
if (registered) GlobalRegistrator.register({ url: "http://127.0.0.1:10001/" });
const { render } = await import("preact");
const { useState } = await import("preact/hooks");
const { PathField } = await import("../../console/ui/src/files.tsx");
const { Field } = await import("../../console/ui/src/ui.tsx");
afterAll(async () => { if (registered) await GlobalRegistrator.unregister(); });
const until = async (check: () => boolean) => { const end = Date.now() + 3000; while (!check() && Date.now() < end) await Bun.sleep(10); expect(check()).toBe(true); };
const button = (root: ParentNode, text: string) => [...root.querySelectorAll("button")].find(value => value.textContent === text);
const type = (input: HTMLInputElement, value: string) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); };
/** A key, then the render it causes (the next key is handled against it, as between real key presses). */
const press = async (target: Element, key: string) => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); await Bun.sleep(20); };

const file = (dir: string, name: string, extra: Partial<BrowseEntry> = {}): BrowseEntry =>
  ({ name, path: `${dir}/${name}`, kind: "file", size: 4096, modified: 1_760_000_000_000, value: `${dir}/${name}`, ...extra });
const folder = (dir: string, name: string, extra: Partial<BrowseEntry> = {}): BrowseEntry =>
  ({ name, path: `${dir}/${name}`, kind: "directory", size: null, modified: 1_760_000_000_000, value: null, ...extra });
const TREE: Record<string, BrowseEntry[]> = {
  "/home": [folder("/home", "op")],
  "/home/op": [folder("/home/op", "backups"), folder("/home/op", ".cache", { hidden: true }), file("/home/op", "notes.txt")],
  "/home/op/backups": [file("/home/op/backups", "old.db"), file("/home/op/backups", "stats.sqlite"),
    file("/home/op/backups", "socket", { value: null, reason: "不是普通文件或目录" })],
};

/** The console's file listing over TREE, as the server answers it; `refuseFirst` fails the first request. */
function host(purpose: BrowsePurpose, refuseFirst = false) {
  const sent: Record<string, unknown>[] = [], intents: (string | null)[] = [];
  const directories = purpose === "workspace";
  const reply = (path: string, selected: string | null, hidden: boolean): BrowseResponse => {
    const parts = path.split("/").filter(Boolean);
    return {
      purpose, select: directories ? "directory" : "file", path, parent: parts.length ? `/${parts.slice(0, -1).join("/")}` : null,
      crumbs: [{ name: "/", path: "/" }, ...parts.map((name, at) => ({ name, path: `/${parts.slice(0, at + 1).join("/")}` }))],
      places: [{ label: "主目录", path: "/home/op", kind: "home" }, { label: "根目录", path: "/", kind: "root" }],
      entries: (TREE[path] ?? []).filter(entry => hidden || !entry.hidden).map(entry => !directories ? entry
        : entry.kind === "directory" ? { ...entry, value: entry.path } : { ...entry, value: null, reason: "这里需要选择目录" }),
      current: directories ? { value: path } : null, selected, truncated: false, note: "导入前会校验格式。",
    };
  };
  const fetch = async (url: string, options?: RequestInit) => {
    // Components of earlier files in the same process may still finish; only the picker's requests are answered.
    if (String(url) !== "/api/files/list") return new Response("{}");
    const body = JSON.parse(String(options!.body)) as { path?: string; from?: string; hidden?: boolean };
    sent.push(body); intents.push(new Headers(options!.headers).get("X-Console-Intent"));
    if (refuseFirst && sent.length === 1) return Response.json({ code: "input", error: "没有权限读取 /home/op/backups" }, { status: 409 });
    if (body.path !== undefined) {
      return TREE[body.path] ? Response.json(reply(body.path, null, !!body.hidden)) : Response.json({ code: "input", error: `找不到 ${body.path}` }, { status: 409 });
    }
    const at = body.from?.lastIndexOf("/") ?? -1;
    if (body.from && TREE[body.from.slice(0, at)]) return Response.json(reply(body.from.slice(0, at), body.from.slice(at + 1), !!body.hidden));
    return Response.json(reply("/home/op", null, !!body.hidden));
  };
  return { sent, intents, fetch: fetch as typeof globalThis.fetch };
}

/** A path field in a form row, as the stats import has it; the value is echoed for the test. */
function Form({ purpose = "stats", unavailable }: { purpose?: BrowsePurpose; unavailable?: string }) {
  const [value, setValue] = useState("");
  return <div class="group">
    <Field group label="统计文件" note="主机上的完整路径。"><PathField label="统计文件" purpose={purpose} value={value} onChange={setValue} unavailable={unavailable} /></Field>
    <output>{value}</output>
  </div>;
}

const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]');
const list = () => sheet()!.querySelector<HTMLElement>('[role="listbox"]')!;
const names = () => [...(sheet()?.querySelectorAll('[role="option"]') ?? [])].map(item => item.querySelector(".entry-name")!.textContent);
const entry = (name: string) => [...sheet()!.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.querySelector(".entry-name")!.textContent === name)!;
const chosen = () => sheet()!.querySelector('[aria-selected="true"] .entry-name')?.textContent;
const foot = () => sheet()!.querySelector(".browser-foot")!.textContent;

test("路径字段：可以直接粘贴路径，也可以在主机上选取；选择框按字段当前值打开并选中，选不了的条目说明原因", async () => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root);
  const server = host("stats"); globalThis.fetch = server.fetch;
  try {
    render(<Form />, root);
    const field = () => root.querySelector<HTMLInputElement>('input[aria-label="统计文件"]')!;
    type(field(), "/home/op/backups/stats.sqlite");
    await until(() => root.querySelector("output")!.textContent === "/home/op/backups/stats.sqlite");
    button(root, "选取…")!.click();
    await until(() => names().length === 3);
    expect(server.sent).toEqual([{ purpose: "stats", from: "/home/op/backups/stats.sqlite" }]);
    expect(server.intents).toEqual(["user"]);
    // The sheet is not inside a label: a click on an entry would also land on the label's input.
    expect(sheet()!.closest("label")).toBeNull();
    expect(chosen()).toBe("stats.sqlite");
    expect(foot()).toBe("将填入：/home/op/backups/stats.sqlite");
    expect([...sheet()!.querySelectorAll(".crumb-btn")].map(crumb => crumb.textContent)).toEqual(["/", "home", "op", "backups"]);
    entry("socket").click();
    await until(() => chosen() === "socket");
    expect(foot()).toBe("不是普通文件或目录");
    expect(button(sheet()!, "选取")!.disabled).toBe(true);
    entry("old.db").click();
    await until(() => foot() === "将填入：/home/op/backups/old.db");
    button(sheet()!, "选取")!.click();
    await until(() => !sheet());
    expect(field().value).toBe("/home/op/backups/old.db");
    expect(root.querySelector("output")!.textContent).toBe("/home/op/backups/old.db");
  } finally { render(null, root); root.remove(); globalThis.fetch = previous; }
});

test("选择框：双击或回车打开目录，后退和退格返回；路径栏跳转，读不到时保留列表；筛选当前目录；回车选取文件", async () => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root);
  const server = host("stats"); globalThis.fetch = server.fetch;
  try {
    render(<Form />, root);
    button(root, "选取…")!.click();
    await until(() => names().join() === "backups,notes.txt");
    expect(server.sent).toEqual([{ purpose: "stats" }]);
    // The list takes the keyboard once the first directory is shown.
    await until(() => document.activeElement === list());
    entry("backups").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await until(() => names().join() === "old.db,stats.sqlite,socket");
    expect(server.sent.at(-1)).toEqual({ purpose: "stats", path: "/home/op/backups" });
    expect(list().classList.contains("forward")).toBe(true);
    sheet()!.querySelector<HTMLButtonElement>('button[aria-label="后退"]')!.click();
    await until(() => names().join() === "backups,notes.txt");
    expect(server.sent.at(-1)).toEqual({ purpose: "stats", path: "/home/op" });
    expect(list().classList.contains("back")).toBe(true);
    // Arrows move the selection, Enter opens a directory, Backspace goes up a level.
    await press(list(), "ArrowDown");
    await until(() => chosen() === "backups");
    await press(list(), "Enter");
    await until(() => names().join() === "old.db,stats.sqlite,socket");
    await press(list(), "Backspace");
    await until(() => names().join() === "backups,notes.txt");
    expect(server.sent.at(-1)).toEqual({ purpose: "stats", path: "/home/op" });
    // The filter narrows only the directory shown.
    const filter = sheet()!.querySelector<HTMLInputElement>('input[aria-label="筛选当前目录"]')!;
    type(filter, "NOTE");
    await until(() => names().join() === "notes.txt");
    type(filter, "zzz");
    await until(() => sheet()!.querySelector(".browser-empty")?.textContent === "没有匹配的项目");
    type(filter, "");
    // A pasted path opens there; one that cannot be read says why and the list stays.
    const go = sheet()!.querySelector<HTMLInputElement>('input[aria-label="前往路径"]')!, form = sheet()!.querySelector("form.go-form")!;
    const submit = async (path: string) => { type(go, path); await Bun.sleep(20); form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); };
    expect(go.value).toBe("/home/op");
    await submit("/nope");
    await until(() => sheet()!.textContent!.includes("找不到 /nope"));
    expect(names().join()).toBe("backups,notes.txt");
    expect(button(sheet()!, "从默认位置打开")).toBeUndefined();
    await submit("/home/op/backups");
    await until(() => names().join() === "old.db,stats.sqlite,socket");
    expect(sheet()!.textContent).not.toContain("找不到 /nope");
    // Enter on a file chooses it.
    await press(list(), "ArrowDown");
    await press(list(), "ArrowDown");
    await until(() => chosen() === "stats.sqlite");
    await press(list(), "Enter");
    await until(() => !sheet());
    expect(root.querySelector("output")!.textContent).toBe("/home/op/backups/stats.sqlite");
  } finally { render(null, root); root.remove(); globalThis.fetch = previous; }
});

test("目录字段可以选取打开的目录或选中的子目录，文件说明不能选；打不开时从默认位置打开；可显示隐藏项；主机上选不了时只能粘贴", async () => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root);
  const server = host("workspace", true); globalThis.fetch = server.fetch;
  try {
    render(<Form unavailable="这里填任务镜像内的路径（例如 /usr/bin/soffice），不能从主机选取" />, root);
    expect(button(root, "选取…")!.disabled).toBe(true);
    expect(root.querySelector(".path-note")!.textContent).toBe("这里填任务镜像内的路径（例如 /usr/bin/soffice），不能从主机选取");
    render(null, root);

    render(<Form purpose="workspace" />, root);
    button(root, "选取…")!.click();
    await until(() => !!sheet()?.textContent?.includes("没有权限读取 /home/op/backups"));
    button(sheet()!, "从默认位置打开")!.click();
    await until(() => names().join() === "backups,notes.txt");
    expect(server.sent).toEqual([{ purpose: "workspace" }, { purpose: "workspace" }]);
    // Nothing selected: the directory shown is what 选取 writes.
    expect(foot()).toBe("将填入：/home/op");
    entry("notes.txt").click();
    await until(() => foot() === "这里需要选择目录");
    expect(button(sheet()!, "选取")!.disabled).toBe(true);
    sheet()!.querySelector<HTMLInputElement>('input[aria-label="显示隐藏项"]')!.click();
    await until(() => names().join() === "backups,.cache,notes.txt");
    expect(server.sent.at(-1)).toEqual({ purpose: "workspace", path: "/home/op", hidden: true });
    expect(entry(".cache").classList.contains("hidden-file")).toBe(true);
    entry("backups").click();
    await until(() => foot() === "将填入：/home/op/backups");
    button(sheet()!, "选取")!.click();
    await until(() => !sheet());
    expect(root.querySelector("output")!.textContent).toBe("/home/op/backups");
  } finally { render(null, root); root.remove(); globalThis.fetch = previous; }
});
