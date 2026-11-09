/** @jsxImportSource preact */
import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
const registered = !GlobalRegistrator.isRegistered;
if (registered) GlobalRegistrator.register({ url: "http://127.0.0.1:10001/" });
const { render } = await import("preact");
const { useState } = await import("preact/hooks");
const { TooltipLayer } = await import("../../console/ui/src/tooltip.tsx");
afterAll(async () => { if (registered) await GlobalRegistrator.unregister(); });
const until = async (check: () => boolean) => { const end = Date.now() + 3000; while (!check() && Date.now() < end) await Bun.sleep(10); expect(check()).toBe(true); };

const tip = () => document.querySelector<HTMLElement>('[role="tooltip"]');
const pointer = (type: string, target: Element, pointerType = "mouse") =>
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType, clientX: 40, clientY: 20 }));
const hover = (target: Element, pointerType?: string) => pointer("pointerover", target, pointerType);
const key = (name: string) => document.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));

let change: { text(value: string): void; shown(value: boolean): void } | undefined;
function Page() {
  const [text, setText] = useState("主机上的完整路径"), [shown, setShown] = useState(true);
  change = { text: setText, shown: setShown };
  return <div>
    <button type="button" class="refresh" aria-label="刷新统计" data-tip="刷新"><span class="icon">↻</span></button>
    <span class="pill" data-tip="机器人状态">运行中</span>
    <p class="plain">普通文字</p>
    <button type="button" class="logout" aria-label="退出登录" data-tip="退出登录"><span class="icon">⎋</span></button>
    {shown && <input aria-describedby="note" data-tip={text} />}
    <span id="note">说明</span>
    <TooltipLayer />
  </div>;
}

const root = document.createElement("div");
document.body.append(root);
afterEach(() => { render(null, root); change = undefined; });
const at = (selector: string) => root.querySelector<HTMLElement>(selector)!;

test("悬停提示：停留片刻后显示，在相邻控件间移动时立即切换；移开、按下或 Esc 后隐藏，按过的控件要移开后才再显示", async () => {
  render(<Page />, root);
  const refresh = at(".refresh");
  hover(refresh.querySelector(".icon")!);
  await Bun.sleep(150);
  expect(tip()).toBeNull();
  await until(() => tip()?.textContent === "刷新");
  // The hint describes the control; the hint of a control named by it is not read twice.
  expect(refresh.getAttribute("aria-describedby")).toBe(tip()!.id);
  hover(at(".pill"));
  await until(() => tip()?.textContent === "机器人状态");
  expect(refresh.hasAttribute("aria-describedby")).toBe(false);
  expect(at(".pill").getAttribute("aria-describedby")).toBe(tip()!.id);
  hover(at(".plain"));
  await until(() => !tip());
  expect(at(".pill").hasAttribute("aria-describedby")).toBe(false);
  hover(at(".logout"));
  await until(() => tip()?.textContent === "退出登录");
  expect(at(".logout").hasAttribute("aria-describedby")).toBe(false);

  // A press hides the hint; moving within the pressed control does not bring it back, leaving and coming back does.
  pointer("pointerdown", at(".logout .icon"));
  await until(() => !tip());
  hover(at(".logout"));
  await Bun.sleep(650);
  expect(tip()).toBeNull();
  hover(at(".plain"));
  hover(at(".logout .icon"));
  await until(() => tip()?.textContent === "退出登录");
  key("Escape");
  await until(() => !tip());
  hover(at(".logout"));
  await Bun.sleep(650);
  expect(tip()).toBeNull();

  // Touch has no hover: a tap shows nothing.
  hover(at(".plain"));
  hover(at(".pill"), "touch");
  await Bun.sleep(650);
  expect(tip()).toBeNull();
});

test("键盘移到控件上立即显示提示，点击得到的焦点不显示；提示随文字更新，控件移除时消失；保留控件原有的描述", async () => {
  render(<Page />, root);
  const input = () => root.querySelector("input")!;
  pointer("pointerdown", input());
  input().focus();
  await Bun.sleep(650);
  expect(tip()).toBeNull();
  input().blur();

  key("Tab");
  input().focus();
  await until(() => tip()?.textContent === "主机上的完整路径");
  expect(input().getAttribute("aria-describedby")).toBe(`note ${tip()!.id}`);
  change!.text("新的说明");
  await until(() => tip()?.textContent === "新的说明");
  // The pointer passing over plain text leaves the keyboard's hint.
  hover(at(".plain"));
  await Bun.sleep(30);
  expect(tip()?.textContent).toBe("新的说明");
  input().blur();
  await until(() => !tip());
  expect(input().getAttribute("aria-describedby")).toBe("note");

  hover(at(".pill"));
  await until(() => tip()?.textContent === "机器人状态");
  key("Tab");
  input().focus();
  await until(() => tip()?.textContent === "新的说明");
  change!.shown(false);
  await until(() => !tip());
});
