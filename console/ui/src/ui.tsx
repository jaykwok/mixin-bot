/** @jsxImportSource preact */
// Building blocks shared by the pages, in the system's idiom: grouped lists, segmented controls with a sliding thumb,
// switches, sheets, steppers, progress and the activity indicator. Positions computed here go through object styles
// (CSSOM), which the page's CSP allows; markup never carries a style attribute.
import { Fragment, type ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Icon, type IconName } from "./icons.tsx";
import type { Tint } from "./nav.ts";

export type Tone = "ok" | "warn" | "danger" | "neutral" | "info";

export function Card({ title, icon, tint, children, span = 4, aside, class: className, flush }: {
  title: ComponentChildren; icon: IconName; children: ComponentChildren; span?: number; aside?: ComponentChildren; class?: string;
  /** The header's glyph is a coloured tile in this tint (otherwise a plain icon). */
  tint?: Tint;
  /** The body has no padding (tables and lists that run edge to edge). */
  flush?: boolean;
}) {
  return (
    <section class={`card span-${span}${className ? ` ${className}` : ""}`}>
      <header class="card-header">{tint ? <Tile icon={icon} tint={tint} size="small" /> : <Icon name={icon} />}<h2>{title}</h2>{aside && <div class="card-aside">{aside}</div>}</header>
      <div class={flush ? "card-body flush" : "card-body"}>{children}</div>
    </section>
  );
}

/** A page's large title, its one-line description and the page-wide actions. */
export function PageHeader({ title, description, actions }: { title: ComponentChildren; description?: ComponentChildren; actions?: ComponentChildren }) {
  return (
    <header class="page-header">
      <div class="page-heading"><h1 class="page-title">{title}</h1>{description && <p class="page-desc">{description}</p>}</div>
      {actions && <div class="page-actions">{actions}</div>}
    </header>
  );
}

/** An inset grouped list: a header above, rows in a rounded group, a footnote below. */
export function Section({ title, aside, footer, children, class: className, id }: {
  title?: ComponentChildren; aside?: ComponentChildren; footer?: ComponentChildren; children: ComponentChildren; class?: string; id?: string;
}) {
  return (
    <section class={`section${className ? ` ${className}` : ""}`} id={id}>
      {(title || aside) && <header class="section-header"><h2>{title}</h2>{aside && <div class="section-aside">{aside}</div>}</header>}
      <div class="group">{children}</div>
      {footer && <p class="section-footer">{footer}</p>}
    </section>
  );
}

/** A coloured rounded tile holding a white glyph, as the system's settings rows have. */
export function Tile({ icon, tint, size }: { icon: IconName; tint: Tint; size?: "small" }) {
  return <span class={`glyph tint-${tint}${size ? ` ${size}` : ""}`} aria-hidden="true"><Icon name={icon} size={size ? 13 : 14} /></span>;
}

/**
 * A form row: the name on the leading side, the control after it, and a note under the control. The row is the label of
 * its control; `group` holds controls that name themselves (a path field with its picker), which a label must not wrap:
 * a click anywhere inside a label, its picker sheet included, would also land on the label's first input.
 */
export function Field({ label, note, children, class: className, group }: {
  label: ComponentChildren; note?: ComponentChildren; children: ComponentChildren; class?: string; group?: boolean;
}) {
  const Tag = group ? "div" : "label";
  return (
    <Tag class={`field-row${className ? ` ${className}` : ""}`}>
      <span class="field-name">{label}</span>
      <span class="field-control">{children}</span>
      {note && <span class="field-note">{note}</span>}
    </Tag>
  );
}

/** One row of a group: an optional tile, a title with its detail, and what sits at the trailing edge. */
export function Row({ icon, tint, title, detail, children, class: className }: {
  icon?: IconName; tint?: Tint; title: ComponentChildren; detail?: ComponentChildren; children?: ComponentChildren; class?: string;
}) {
  return (
    <div class={`row${className ? ` ${className}` : ""}`}>
      {icon && <Tile icon={icon} tint={tint ?? "gray"} />}
      <div class="row-text"><div class="row-title">{title}</div>{detail && <div class="row-detail">{detail}</div>}</div>
      {children !== undefined && children !== null && children !== false && <div class="row-trailing">{children}</div>}
    </div>
  );
}

export function Rows({ rows }: { rows: [string, ComponentChildren][] }) {
  return <dl class="kv">{rows.map(([key, value]) => <Fragment key={key}><dt>{key}</dt><dd>{value}</dd></Fragment>)}</dl>;
}

export function Banner({ tone, icon, title, children, action }: {
  tone: Tone; icon: IconName; title: ComponentChildren; children?: ComponentChildren; action?: ComponentChildren;
}) {
  return (
    <div class={`banner ${tone}`} role={tone === "danger" ? "alert" : "status"}>
      <Icon name={icon} size={18} />
      <div class="banner-text"><strong>{title}</strong>{children && <div class="banner-body">{children}</div>}</div>
      {action && <div class="banner-action">{action}</div>}
    </div>
  );
}

export interface SegmentOption<T extends string> { value: T; label: ComponentChildren; tip?: string; icon?: IconName }

/**
 * A row of mutually exclusive buttons (radio semantics); arrow keys move the choice. A thumb slides under the chosen
 * one; until it is measured (or where layout is not computed) the chosen button paints its own background.
 */
export function Segmented<T extends string>({ label, options, value, onChange, disabled, size }: {
  label: string; options: SegmentOption<T>[]; value: T; onChange: (value: T) => void; disabled?: boolean; size?: "small";
}) {
  const box = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const chosen = box.current?.querySelector<HTMLElement>('[aria-checked="true"]');
      setThumb(chosen && chosen.offsetWidth ? { x: chosen.offsetLeft, width: chosen.offsetWidth } : null);
    };
    measure();
    if (typeof ResizeObserver === "undefined" || !box.current) return;
    const observer = new ResizeObserver(measure);
    observer.observe(box.current);
    return () => observer.disconnect();
  }, [value, options.length]);
  const move = (event: KeyboardEvent) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = options.findIndex(option => option.value === value);
    const next = options[(index + step + options.length) % options.length]!;
    onChange(next.value);
    (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus();
  };
  return (
    <div ref={box} class={`segmented${size ? ` ${size}` : ""}${thumb ? " measured" : ""}`} role="radiogroup" aria-label={label} onKeyDown={move}>
      {thumb && <span class="segmented-thumb" aria-hidden="true" style={{ transform: `translateX(${thumb.x}px)`, width: `${thumb.width}px` }} />}
      {options.map(option => (
        <button key={option.value} type="button" role="radio" aria-checked={option.value === value} data-value={option.value}
          tabIndex={option.value === value ? 0 : -1} data-tip={option.tip} disabled={disabled}
          onClick={() => { if (option.value !== value) onChange(option.value); }}>
          {option.icon && <Icon name={option.icon} size={14} />}{option.label}
        </button>
      ))}
    </div>
  );
}

/** An on/off switch: a real checkbox (keyboard, forms and tests use it) drawn as the system's switch. */
export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <span class={`switch${disabled ? " disabled" : ""}`}>
      <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={event => onChange(event.currentTarget.checked)} />
      <span class="switch-track" aria-hidden="true"><span class="switch-thumb" /></span>
    </span>
  );
}

/** A labelled switch row; the whole row toggles it. */
export function Toggle({ label, detail, checked, onChange, disabled }: {
  label: ComponentChildren; detail?: ComponentChildren; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean;
}) {
  return (
    <label class={`toggle${disabled ? " disabled" : ""}`}>
      <span class="toggle-text"><span class="toggle-label">{label}</span>{detail && <span class="toggle-detail">{detail}</span>}</span>
      <Switch checked={checked} onChange={onChange} disabled={disabled} />
    </label>
  );
}

/** Where a piece of work stands: steps before `current` are done; `tone` marks how the last one ended. */
export function Stepper({ steps, current, tone, label = "进度" }: { steps: string[]; current: number; tone?: "ok" | "danger" | "warn"; label?: string }) {
  return (
    <ol class={`stepper${tone ? ` tone-${tone}` : ""}`} aria-label={label}>
      {steps.map((step, index) => {
        const state = index < current ? "done" : index === current ? "current" : "todo";
        const glyph: IconName | null = state === "done" || state === "current" && tone === "ok" ? "checkmark" : state === "current" && tone === "danger" ? "x"
          : state === "current" && tone === "warn" ? "alert" : null;
        return (
          <li key={step} class={`step ${state}`} aria-current={state === "current" ? "step" : undefined}>
            <span class="step-dot" aria-hidden="true">{glyph ? <Icon name={glyph} size={12} /> : state === "current" ? <span class="step-pulse" /> : null}</span>
            <span class="step-label">{step}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Determinate when `value` (0..1) is given, otherwise a sweeping bar. */
export function ProgressBar({ value, label, tone }: { value?: number; label: string; tone?: Tone }) {
  return (
    <div class={`progress${value === undefined ? " indeterminate" : ""}${tone ? ` tone-${tone}` : ""}`} role="progressbar" aria-label={label}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === undefined ? undefined : Math.round(value * 100)}>
      <span class="progress-fill" style={value === undefined ? undefined : { width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

/** A ring that empties as `left` runs down from `total` (milliseconds), with the time left in it. */
export function Countdown({ total, left, label }: { total: number; left: number; label: string }) {
  const fraction = total > 0 ? Math.max(0, Math.min(1, left / total)) : 0, radius = 9, length = 2 * Math.PI * radius;
  const seconds = Math.max(0, Math.ceil(left / 1000));
  return (
    <span class={`countdown${fraction < 0.2 ? " low" : ""}`} role="timer" aria-label={label}>
      <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
        <circle class="countdown-track" cx="12" cy="12" r={radius} />
        <circle class="countdown-ring" cx="12" cy="12" r={radius} stroke-dasharray={`${length}`} stroke-dashoffset={`${length * (1 - fraction)}`} />
      </svg>
      <span class="countdown-text">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>
    </span>
  );
}

/** A section that opens in place; the head names it, the chevron turns when it opens. */
export function Disclosure({ title, detail, icon, tint, open, onToggle, children, label }: {
  title: ComponentChildren; detail?: ComponentChildren; icon?: IconName; tint?: Tint; open: boolean; onToggle: (open: boolean) => void;
  children: ComponentChildren; label?: string;
}) {
  return (
    <section class={`disclosure${open ? " open" : ""}`}>
      <button type="button" class="disclosure-head" aria-expanded={open} aria-label={label} onClick={() => onToggle(!open)}>
        {icon && <Tile icon={icon} tint={tint ?? "gray"} />}
        <span class="disclosure-text"><span class="disclosure-title">{title}</span>{detail && <span class="disclosure-detail">{detail}</span>}</span>
        <Icon name="chevronRight" class="disclosure-chevron" />
      </button>
      {open && <div class="disclosure-body">{children}</div>}
    </section>
  );
}

/** A modal sheet: Escape and the backdrop close it, focus moves in and returns to where it was. */
export function Dialog({ title, icon, onClose, children, footer, size, header, class: className }: {
  title: string; icon?: IconName; onClose: () => void; children: ComponentChildren; footer?: ComponentChildren; size?: "wide" | "tall" | "wide tall";
  /** Shown under the title (a stepper, a path). */
  header?: ComponentChildren;
  class?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    (box.current?.querySelector<HTMLElement>("[data-autofocus]") ?? box.current?.querySelector<HTMLElement>("input, select, textarea, button:not(.dialog-close)"))?.focus();
    return () => before?.focus?.();
  }, []);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key !== "Tab" || !box.current) return;
    // Keep Tab inside the dialog.
    const focusable = [...box.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select, textarea, a[href], [tabindex='0']")];
    if (!focusable.length) return;
    const first = focusable[0]!, last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return (
    <div class="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={box} class={`dialog${size ? ` ${size}` : ""}${className ? ` ${className}` : ""}`} role="dialog" aria-modal="true" aria-label={title} onKeyDown={onKeyDown}>
        <header class="dialog-header">
          {icon && <span class="dialog-icon"><Icon name={icon} size={18} /></span>}
          <h2>{title}</h2>
          <button type="button" class="btn ghost icon-btn dialog-close" aria-label="关闭" onClick={onClose}><Icon name="x" /></button>
        </header>
        {header && <div class="dialog-subheader">{header}</div>}
        <div class="dialog-body">{children}</div>
        {footer && <footer class="dialog-footer">{footer}</footer>}
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, children, action, tone }: {
  icon: IconName; title: ComponentChildren; children?: ComponentChildren; action?: ComponentChildren; tone?: Tone;
}) {
  return (
    <div class={`empty-state${tone ? ` tone-${tone}` : ""}`}>
      <div class="empty-icon"><Icon name={icon} size={22} class={icon === "loader" ? "spin" : undefined} /></div>
      <div class="empty-title">{title}</div>
      {children && <div class="empty-body">{children}</div>}
      {action && <div class="empty-action">{action}</div>}
    </div>
  );
}

export function Spinner({ label = "正在加载" }: { label?: string }) {
  return <span class="spinner" role="status"><Icon name="loader" size={14} class="spin" />{label}</span>;
}

/** Placeholder lines while content loads. */
export function Skeleton({ lines = 3 }: { lines?: number }) {
  return <div class="skeleton-block" aria-busy="true" aria-label="正在加载">{Array.from({ length: lines }, (_, index) =>
    <div key={index} class={`skeleton w${[80, 60, 70, 40, 30][index % 5]}`} />)}</div>;
}

/** A small labelled count or state, e.g. a delivery part. */
export function Chip({ tone = "neutral", children, tip }: { tone?: Tone; children: ComponentChildren; tip?: string }) {
  return <span class={`chip ${tone}`} data-tip={tip}>{children}</span>;
}
