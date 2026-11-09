/** @jsxImportSource preact */
// Hover and keyboard hints. Elements carry their hint in `data-tip` rather than a native title: the browser draws native
// tooltips in a window of its own, outside the console's theme, and on some Windows systems that window first shows up
// empty. One layer listens on the document, so every element with `data-tip` gets the same hint.
import { useLayoutEffect, useRef, useState } from "preact/hooks";

/** The pause before the first hint shows, and how long after one hides the next shows at once (moving along a toolbar). */
const DELAY_MS = 500, WARM_MS = 400;
/** The space between a hint and its control, and the least space it keeps from the window's edges. */
const GAP = 8, EDGE = 8;
const TIP_ID = "console-tip";

type Source = "pointer" | "focus";
interface Tip { anchor: HTMLElement; text: string; x: number | null }

const anchorOf = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>("[data-tip]") : null;

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const box = useRef<HTMLDivElement>(null);

  // Listening starts with the first render: a control hovered at once still gets its hint.
  useLayoutEffect(() => {
    // `target` is the control hinted or waiting out the delay; `dismissed` the one pressed or dismissed with Esc, which stays
    // quiet until the pointer leaves it.
    let target: HTMLElement | null = null, by: Source | null = null, dismissed: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined, visible = false, warmUntil = 0, keyboard = false, x = 0;
    let described: { anchor: HTMLElement; previous: string | null } | null = null;
    // A hint follows its text and goes when its control leaves the page.
    const observer = new MutationObserver(() => {
      const text = target?.isConnected ? target.dataset.tip?.trim() : "";
      if (!text) hide();
      else setTip(current => current && current.text !== text ? { ...current, text } : current);
    });

    // The hint describes its control to assistive technology while it shows, unless the control's name already says it.
    const describe = (anchor: HTMLElement | null, text = "") => {
      if (described) {
        const { anchor: was, previous } = described;
        if (previous === null) was.removeAttribute("aria-describedby"); else was.setAttribute("aria-describedby", previous);
        described = null;
      }
      if (!anchor || anchor.getAttribute("aria-label") === text) return;
      const previous = anchor.getAttribute("aria-describedby");
      anchor.setAttribute("aria-describedby", previous ? `${previous} ${TIP_ID}` : TIP_ID);
      described = { anchor, previous };
    };
    const hide = () => {
      clearTimeout(timer); timer = undefined;
      if (visible) warmUntil = Date.now() + WARM_MS;
      visible = false; target = null; by = null;
      describe(null); observer.disconnect(); setTip(null);
    };
    const show = () => {
      timer = undefined;
      const anchor = target, text = anchor?.isConnected ? anchor.dataset.tip?.trim() : "";
      if (!anchor || !text) return hide();
      visible = true;
      describe(anchor, text);
      setTip({ anchor, text, x: by === "pointer" ? x : null });
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-tip"] });
    };
    const aim = (anchor: HTMLElement | null, source: Source) => {
      if (source === "pointer") {
        if (anchor !== dismissed) dismissed = null;
        else if (anchor) return;
      }
      if (anchor === target) return;
      if (!anchor) { if (by === source) hide(); return; }
      const warm = visible || Date.now() < warmUntil;
      hide();
      target = anchor; by = source;
      if (source === "focus" || warm) show(); else timer = setTimeout(show, DELAY_MS);
    };

    const onOver = (event: PointerEvent) => { if (event.pointerType !== "touch") { x = event.clientX; aim(anchorOf(event.target), "pointer"); } };
    const onOut = (event: PointerEvent) => { if (!event.relatedTarget && event.pointerType !== "touch") aim(null, "pointer"); };
    const onMove = (event: PointerEvent) => { x = event.clientX; };
    const onDown = (event: PointerEvent) => { keyboard = false; hide(); dismissed = anchorOf(event.target); };
    // Only focus the keyboard moved shows a hint: a click focuses the control it presses, and that hides the hint.
    const onFocusIn = (event: FocusEvent) => { if (keyboard) aim(anchorOf(event.target), "focus"); };
    const onFocusOut = (event: FocusEvent) => { if (by === "focus" && anchorOf(event.relatedTarget) !== target) hide(); };
    const onKey = (event: KeyboardEvent) => {
      keyboard = true;
      if (event.key === "Escape" && target) { const was = target; hide(); dismissed = was; }
    };
    // A scroll that moves the control takes its hint away; other panes (a log that follows its output) leave it.
    const onScroll = (event: Event) => {
      if (target && (event.target === document || event.target instanceof Node && event.target.contains(target))) hide();
    };
    const passive = { capture: true, passive: true };
    document.addEventListener("pointerover", onOver, passive);
    document.addEventListener("pointerout", onOut, passive);
    document.addEventListener("pointermove", onMove, passive);
    document.addEventListener("pointerdown", onDown, passive);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", onScroll, passive);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("pointerover", onOver, passive);
      document.removeEventListener("pointerout", onOut, passive);
      document.removeEventListener("pointermove", onMove, passive);
      document.removeEventListener("pointerdown", onDown, passive);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", onScroll, passive);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
      clearTimeout(timer); describe(null); observer.disconnect();
    };
  }, []);

  // Under the control, or above it near the bottom of the window. A wide control (a table cell, a ranked row) has its hint
  // where the pointer entered it rather than at its middle.
  useLayoutEffect(() => {
    const element = box.current;
    if (!tip || !element) return;
    const rect = tip.anchor.getBoundingClientRect(), { clientWidth, clientHeight } = document.documentElement;
    const width = element.offsetWidth, height = element.offsetHeight;
    const centre = tip.x !== null && rect.width > 160 ? Math.min(Math.max(tip.x, rect.left), rect.right) : rect.left + rect.width / 2;
    let top = rect.bottom + GAP;
    if (top + height > clientHeight - EDGE) top = Math.max(EDGE, rect.top - GAP - height);
    element.style.left = `${Math.round(Math.max(EDGE, Math.min(centre - width / 2, clientWidth - width - EDGE)))}px`;
    element.style.top = `${Math.round(top)}px`;
  }, [tip]);

  return tip ? <div ref={box} id={TIP_ID} class="tooltip" role="tooltip">{tip.text}</div> : null;
}
