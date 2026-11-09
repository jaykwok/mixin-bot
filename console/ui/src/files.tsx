/** @jsxImportSource preact */
// Path fields: a path can be pasted or typed, or chosen in a picker. The console runs on the deployment host while the
// browser may sit on another computer (SSH forwarding), so the picker lists the host's directories through the console;
// what an entry writes into the field (a container path, a path inside the shared workspace) comes from the console.
import { Fragment } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.ts";
import type { BrowseEntry, BrowsePlace, BrowsePurpose, BrowseRequest, BrowseResponse } from "./contract.ts";
import { bytes, stamp } from "./format.ts";
import { Icon, type IconName } from "./icons.tsx";
import { Banner, Dialog, Spinner, Switch } from "./ui.tsx";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

const PLACE_ICONS: Record<BrowsePlace["kind"], IconName> = {
  project: "layers", data: "database", workspace: "folder", home: "home", drive: "hardDrive", apps: "app", office: "app", root: "hardDrive",
};
const ENTRY_ICONS: Record<BrowseEntry["kind"], IconName> = { directory: "folder", file: "file", app: "app" };

/** A text field for a host path with a 选取… button that opens the picker. `unavailable` says why the picker cannot work here. */
export function PathField({ label, purpose, value, onChange, placeholder, disabled, unavailable }: {
  label: string; purpose: BrowsePurpose; value: string; onChange: (value: string) => void; placeholder?: string; disabled?: boolean; unavailable?: string;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <div class="path-field">
      <input type="text" aria-label={label} value={value} placeholder={placeholder} disabled={disabled} spellcheck={false} autoComplete="off"
        onInput={event => onChange(event.currentTarget.value)} />
      <button type="button" class="btn" disabled={disabled || !!unavailable} data-tip={unavailable ?? `在主机上选取${label}`} onClick={() => setOpen(true)}>
        <Icon name="folderOpen" size={15} />选取…</button>
    </div>
    {unavailable && <p class="path-note">{unavailable}</p>}
    {open && <FileBrowser label={label} purpose={purpose} from={value} onClose={() => setOpen(false)} onChoose={chosen => { setOpen(false); onChange(chosen); }} />}
  </>;
}

type Move = "forward" | "back" | "";

/** The picker: places, a path bar, the listing of one host directory, and what choosing writes into the field. */
export function FileBrowser({ label, purpose, from, onClose, onChoose }: {
  label: string; purpose: BrowsePurpose; from: string; onClose: () => void; onChoose: (value: string) => void;
}) {
  const [listing, setListing] = useState<BrowseResponse | null>(null), [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState(""), [move, setMove] = useState<Move>("");
  const [filter, setFilter] = useState(""), [hidden, setHidden] = useState(false), [typed, setTyped] = useState("");
  const history = useRef<string[]>([]), request = useRef(0), list = useRef<HTMLUListElement>(null), live = useRef(true);
  const placed = useRef(false), refocus = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const load = async (target: { path?: string; from?: string }, how: Move, showHidden = hidden) => {
    const id = ++request.current; setBusy(true); setError("");
    try {
      const body: BrowseRequest = { purpose, ...target, ...(showHidden ? { hidden: true } : {}) };
      const result = await api<BrowseResponse>("/api/files/list", { method: "POST", intent: true, timeoutMs: 30_000, body });
      if (!live.current || id !== request.current) return;
      refocus.current = !!list.current?.contains(document.activeElement);
      setListing(result); setSelected(result.selected); setFilter(""); setMove(how); setTyped(result.path);
    } catch (cause) { if (live.current && id === request.current) setError(message(cause)); }
    finally { if (live.current && id === request.current) setBusy(false); }
  };
  useEffect(() => { void load(from.trim() ? { from } : {}, ""); }, []);

  const open = (path: string) => { if (listing) history.current.push(listing.path); void load({ path }, "forward"); };
  const jump = (path: string, how: Move) => { if (listing && path !== listing.path) history.current.push(listing.path); void load({ path }, how); };
  const back = () => { const previous = history.current.pop(); if (previous) void load({ path: previous }, "back"); };
  const up = () => { if (listing?.parent) jump(listing.parent, "back"); };

  const words = filter.trim().toLowerCase();
  const visible = (listing?.entries ?? []).filter(entry => !words || entry.name.toLowerCase().includes(words));
  const focused = visible.find(entry => entry.name === selected) ?? null;
  // What 选取 writes: the chosen entry, or in a directory field the directory shown.
  const choice = focused ? focused.kind === "directory" && listing?.select === "file" ? null : { value: focused.value, reason: focused.reason }
    : listing?.current ?? null;
  const activate = (entry: BrowseEntry) => {
    if (entry.kind === "directory") open(entry.path);
    else if (entry.value !== null) onChoose(entry.value);
  };
  useLayoutEffect(() => { list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" }); }, [selected, listing]);
  // The list takes the keyboard once the first directory is shown (the sheet opened before anything could take focus), and
  // keeps it when the keyboard moves to another directory (the list of each directory is a new element).
  useEffect(() => { if (listing && (!placed.current || refocus.current)) { placed.current = true; refocus.current = false; list.current?.focus(); } }, [listing]);

  const onKeyDown = (event: KeyboardEvent) => {
    const index = visible.findIndex(entry => entry.name === selected), last = visible.length - 1;
    const pick = (at: number) => { const entry = visible[Math.max(0, Math.min(last, at))]; if (entry) setSelected(entry.name); };
    if (event.key === "ArrowDown") pick(index + 1);
    else if (event.key === "ArrowUp") pick(index < 0 ? last : index - 1);
    else if (event.key === "Home") pick(0);
    else if (event.key === "End") pick(last);
    else if (event.key === "Enter" && focused) activate(focused);
    else if (event.key === "ArrowRight" && focused?.kind === "directory") open(focused.path);
    else if (event.key === "Backspace" || event.key === "ArrowLeft" || event.altKey && event.key === "ArrowUp") up();
    else return;
    event.preventDefault();
  };

  const footer = <>
    <div class="browser-foot">
      {choice?.value ? <>将填入：<code data-tip={choice.value}>{choice.value}</code></>
        : choice?.reason ? <span class="reason">{choice.reason}</span>
        : <span>{listing?.select === "directory" ? "选择一个目录，或打开目录后直接选取它" : "选择一个文件；双击目录打开"}</span>}
    </div>
    <div class="action-row">
      <button type="button" class="btn" onClick={onClose}>取消</button>
      <button type="button" class="btn primary" disabled={!choice?.value} onClick={() => { if (choice?.value) onChoose(choice.value); }}>选取</button>
    </div>
  </>;

  return (
    <Dialog title={`选取${label}`} icon="folderOpen" size="wide tall" class="picker" onClose={onClose} footer={footer}>
      <div class="browser">
        <nav class="browser-places" aria-label="位置">
          <div class="browser-places-label">位置</div>
          {(listing?.places ?? []).map(place => (
            <button key={place.path} type="button" class="place" aria-current={listing?.path === place.path} data-tip={place.path} onClick={() => jump(place.path, "")}>
              <Icon name={PLACE_ICONS[place.kind]} size={15} /><span>{place.label}</span>
            </button>
          ))}
        </nav>
        <div class="browser-main">
          <div class="browser-bar">
            <button type="button" class="btn ghost small-btn icon-btn" aria-label="后退" data-tip="后退" disabled={busy || !history.current.length} onClick={back}><Icon name="chevronLeft" size={15} /></button>
            <button type="button" class="btn ghost small-btn icon-btn" aria-label="上一级" data-tip="上一级" disabled={busy || !listing?.parent} onClick={up}><Icon name="arrowUp" size={15} /></button>
            <div class="crumb-trail" aria-label="当前位置">
              {listing?.crumbs.map((crumb, index) => <Fragment key={crumb.path}>
                {index > 0 && <Icon name="chevronRight" size={12} />}
                <button type="button" class="crumb-btn" onClick={() => jump(crumb.path, "back")}>{crumb.name}</button>
              </Fragment>)}
            </div>
            {busy && listing && <Spinner label="正在读取" />}
          </div>
          <div class="browser-tools">
            <div class="input-icon"><Icon name="search" size={14} />
              <input type="search" aria-label="筛选当前目录" placeholder="筛选" value={filter} onInput={event => setFilter(event.currentTarget.value)} /></div>
            <form class="go-form" onSubmit={event => { event.preventDefault(); if (typed.trim()) jump(typed.trim(), ""); }}>
              <input type="text" aria-label="前往路径" placeholder="粘贴路径后按回车" value={typed} spellcheck={false} onInput={event => setTyped(event.currentTarget.value)} />
              <button type="submit" class="btn small-btn" disabled={busy || !typed.trim()}>前往</button>
            </form>
            <label class="toggle"><span class="toggle-text">显示隐藏项</span>
              <Switch checked={hidden} label="显示隐藏项" onChange={next => { setHidden(next); if (listing) void load({ path: listing.path }, "", next); }} /></label>
          </div>
          {error && <Banner tone="danger" icon="alert" title="无法打开" action={listing ? undefined : <button type="button" class="btn small-btn" onClick={() => void load({}, "")}>从默认位置打开</button>}>{error}</Banner>}
          {!listing ? (busy ? <div class="browser-status"><Spinner label="正在读取主机目录…" /></div> : null) : (
            <ul key={listing.path} ref={list} class={`browser-list${move ? ` ${move}` : ""}`} role="listbox" aria-label={`${listing.path} 的内容`} tabIndex={0}
              onKeyDown={onKeyDown}>
              {!visible.length && <li class="browser-empty">{listing.entries.length ? "没有匹配的项目" : "这个目录是空的"}</li>}
              {visible.map(entry => {
                const usable = entry.kind === "directory" || entry.value !== null;
                return (
                  <li key={entry.name} role="option" aria-selected={entry.name === selected} aria-disabled={!usable}
                    class={`entry ${entry.kind}${entry.value !== null ? " choosable" : ""}${usable ? "" : " unavailable"}${entry.hidden ? " hidden-file" : ""}`}
                    data-tip={entry.reason ?? entry.path} onClick={() => setSelected(entry.name)} onDblClick={() => activate(entry)}>
                    <Icon name={ENTRY_ICONS[entry.kind]} size={17} />
                    <span class="entry-main">
                      <span class="entry-name">{entry.name}{entry.link && <span class="link-mark"> · 链接</span>}</span>
                      {entry.reason && <span class="entry-reason">{entry.reason}</span>}
                    </span>
                    <span class="entry-meta">{[entry.size !== null ? bytes(entry.size) : "", entry.modified !== null ? stamp(entry.modified) : ""].filter(Boolean).join(" · ")}</span>
                  </li>
                );
              })}
            </ul>
          )}
          {listing && <p class="browser-note">{listing.truncated ? "目录太大，只列出了一部分；可以在上方粘贴完整路径。" : ""}{listing.note}</p>}
        </div>
      </div>
    </Dialog>
  );
}
