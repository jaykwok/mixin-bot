/** @jsxImportSource preact */
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "../helpers/dom.tsx";
const registered = !GlobalRegistrator.isRegistered;
if (registered) GlobalRegistrator.register({ url: "http://127.0.0.1:10001/" });
const { render } = await import("preact");
const { act } = await import("preact/test-utils");
const { SetupDirectory } = await import("../../console/ui/src/setup-directory.tsx");
afterAll(async () => { if (registered) await GlobalRegistrator.unregister(); });
const until = async (check: () => boolean) => { const end = Date.now() + 3000; while (!check() && Date.now() < end) await Bun.sleep(10); expect(check()).toBe(true); };

test("首次部署独立保存部门，重开并换成同应用的新凭据草稿后恢复；编辑和失败不会把未保存选择交给部署", async () => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root);
  const changes: unknown[] = [], saves: unknown[] = [];
  let saved: { saved: string; mode: string; count: number } | null = null, fail = false;
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    const body = JSON.parse(String(options?.body));
    if (url === "/api/setup/directory/read") return Response.json({ scope: saved });
    if (url === "/api/lifecycle/directory/open") return Response.json({ view: "tree", children: [{ key: "tech", name: "技术部" }],
      selected: saved?.mode === "departments" ? [{ key: "tech", name: "技术部" }] : [] });
    if (url === "/api/setup/directory/save") {
      saves.push(body);
      if (fail) return Response.json({ error: "平台暂不可用", code: "input" }, { status: 409 });
      saved = body.directory === "all" ? { saved: "all-saved", mode: "all", count: 0 } : { saved: "dept-saved", mode: "departments", count: 1 };
      return Response.json({ scope: saved });
    }
    throw new Error(`Unexpected ${url}`);
  }) as typeof fetch;
  const button = (name: string) => [...root.querySelectorAll("button")].find(item => item.textContent === name)!;
  const mode = (value: string) => root.querySelector<HTMLButtonElement>(`[data-value="${value}"]`)!;
  const mount = (draft: string | null) => act(() => render(<SetupDirectory draft={draft} disabled={false} onChange={value => changes.push(value)} />, root));
  try {
    await mount(null); await until(() => root.textContent!.includes("先完成第 2 步"));
    await mount("app-one"); await until(() => !!mode("departments") && !mode("departments").disabled);
    mode("departments").click(); await until(() => !!button("读取部署部门树"));
    button("读取部署部门树").click(); await until(() => !!root.querySelector(".department-tree input"));
    root.querySelector<HTMLInputElement>(".department-tree input")!.click();
    await until(() => !button("保存选择范围").disabled); expect(changes.at(-1)).toBeNull();
    expect(root.textContent).not.toContain("已选择：");
    button("保存选择范围").click(); await until(() => root.textContent!.includes("已保存：1 个部门"));
    expect(changes.at(-1)).toEqual({ saved: "dept-saved" });
    expect(saves[0]).toEqual({ draft: "app-one", directory: { view: "tree", selected: ["tech"] } });
    // Unmounting stands in for navigating away, login expiry or restarting the console.
    await act(() => render(null, root)); await mount("app-after-relogin");
    await until(() => root.textContent!.includes("已保存：1 个部门")); expect(changes.at(-1)).toEqual({ saved: "dept-saved" });
    button("修改范围").click(); await until(() => !!button("读取部署部门树")); expect(changes.at(-1)).toBeNull();
    button("读取部署部门树").click(); await until(() => root.querySelector<HTMLInputElement>(".department-tree input")?.checked === true);
    fail = true; button("保存选择范围").click(); await until(() => root.textContent!.includes("平台暂不可用"));
    expect(changes.at(-1)).toBeNull(); expect(root.querySelector<HTMLInputElement>(".department-tree input")!.checked).toBe(true);
    fail = false; mode("all").click(); await until(() => !root.querySelector(".department-tree"));
    button("保存选择范围").click(); await until(() => root.textContent!.includes("已保存：整个通讯录"));
    expect(changes.at(-1)).toEqual({ saved: "all-saved" });
    expect(saves.at(-1)).toEqual({ draft: "app-after-relogin", directory: "all" });
  } finally { await act(() => render(null, root)); root.remove(); globalThis.fetch = previous; }
});

test("切换应用时丢弃旧的延迟读取结果，未校验的凭据不能保存范围", async () => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root);
  const pending = Promise.withResolvers<Response>(), changes: unknown[] = [];
  globalThis.fetch = (async () => pending.promise) as unknown as typeof fetch;
  try {
    render(<SetupDirectory draft="old-app" disabled={false} onChange={value => changes.push(value)} />, root);
    await until(() => root.textContent!.includes("正在读取或保存"));
    render(<SetupDirectory draft={null} disabled={false} onChange={value => changes.push(value)} />, root);
    await until(() => root.textContent!.includes("先完成第 2 步"));
    pending.resolve(Response.json({ scope: { saved: "old-choice", mode: "all", count: 0 } }));
    await act(async () => { await pending.promise; });
    expect(changes.at(-1)).toBeNull(); expect(root.textContent).not.toContain("已保存：");
    expect(root.textContent).not.toContain("保存选择范围");
  } finally { await act(() => render(null, root)); root.remove(); globalThis.fetch = previous; }
});
