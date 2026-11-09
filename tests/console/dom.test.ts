import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempFixture } from "../helpers/temp.ts";

test("关闭 UI 测试窗口会清理待执行效果，下一窗口仍能运行效果", async () => {
  const f = await tempFixture("console-dom-lifecycle-");
  try {
    const script = join(f.root, "probe.ts");
    await writeFile(script, `import assert from "node:assert/strict";
import { GlobalRegistrator } from ${JSON.stringify(import.meta.resolve("../helpers/dom.tsx"))};
GlobalRegistrator.register({ url: "http://127.0.0.1:10001/" });
const { h, render } = await import(${JSON.stringify(import.meta.resolve("preact"))});
const { useEffect } = await import(${JSON.stringify(import.meta.resolve("preact/hooks"))});
let effects = 0, cleanups = 0;
function View() { useEffect(() => { effects++; return () => { assert.equal(typeof window, "object"); cleanups++; }; }, []); return null; }
let root = document.createElement("div");
render(h(View, {}), root); render(null, root);
await GlobalRegistrator.unregister();
GlobalRegistrator.register({ url: "http://127.0.0.1:10001/" });
try {
  root = document.createElement("div"); render(h(View, {}), root);
  const end = performance.now() + 3000;
  while (effects === 0 && performance.now() < end) await Bun.sleep(10);
  assert.equal(effects, 1, "the next window's effects must not be stranded");
} finally { render(null, root); await GlobalRegistrator.unregister(); }
assert.equal(cleanups, 1, "unmount cleanup must finish while window still exists");
console.log("DOM lifecycle passed");
`);
    const child = Bun.spawn([process.execPath, "--no-env-file", script], { cwd: f.root, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stdout + stderr).toBe(0);
    expect(stdout).toContain("DOM lifecycle passed");
  } finally { await f.cleanup(); }
});
