/** @jsxImportSource preact */
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "../helpers/dom.tsx";
const registered = !GlobalRegistrator.isRegistered;
if (registered) GlobalRegistrator.register({ url: "http://127.0.0.1:10001/" });
const { render } = await import("preact");
const { act } = await import("preact/test-utils");
const { DocumentActions } = await import("../../console/ui/src/write-forms.tsx");
afterAll(async () => { if (registered) await GlobalRegistrator.unregister(); });

test("document actions use confirmed background tasks and Docker directs repairs to image deployment", async () => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root);
  const requests: any[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) });
    return Response.json({ error: "fixture preview" }, { status: 400 });
  }) as typeof fetch;
  try {
    await act(() => render(<DocumentActions platform="windows" />, root));
    const buttons = [...root.querySelectorAll("button")]; expect(buttons).toHaveLength(3);
    for (const [i, button] of buttons.entries()) {
      await act(async () => { button.click(); await Bun.sleep(20); });
      expect(requests[i]).toEqual({ url: "/api/plans", body: { operation: ["document-check", "document-install", "document-repair"][i], params: {} } });
    }
    await act(() => render(<DocumentActions platform="linux" />, root));
    expect(root.querySelectorAll("button")).toHaveLength(1);
    expect(root.querySelector("a")!.getAttribute("href")).toBe("#/maintain");
    expect(root.textContent).toContain("重建镜像");
  } finally { render(null, root); root.remove(); globalThis.fetch = previous; }
});
