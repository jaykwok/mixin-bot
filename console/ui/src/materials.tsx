/** @jsxImportSource preact */
// 设置页的「资料索引的排除目录」：共享资料里不进索引的文件夹。规则由运行中的服务读写（data/config/materials-ignore.txt），保存后
// 下一次索引就按新规则生成，不需要重启。可以逐层打开共享资料的文件夹来挑，也可以直接输入路径；以任意层级前缀开头的规则按名字
// 排除每一层的同名文件夹。
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.ts";
import type { MaterialExclusionsResponse, MaterialFoldersResponse } from "./contract.ts";
import { bytes, count, dateTime } from "./format.ts";
import { Icon } from "./icons.tsx";
import { Section, Skeleton } from "./ui.tsx";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const ANYWHERE = "**/";

/** A typed rule as the file takes it: `/` separators and no slash at either end. */
export const ruleText = (typed: string) => {
  const text = typed.trim().replace(/\\/g, "/"), anywhere = text.startsWith(ANYWHERE);
  return (anywhere ? ANYWHERE : "") + (anywhere ? text.slice(ANYWHERE.length) : text).replace(/^(?:\.?\/)+|\/+$/g, "");
};

/** Whether the rules leave `path` out, as the index decides it (src/agent/materials-index.ts isIgnored): by prefix, without regard to case. */
export function excludedBy(path: string, rules: readonly string[]): string | undefined {
  const target = path.toLowerCase();
  return rules.find(raw => {
    const rule = raw.toLowerCase();
    if (!rule.startsWith(ANYWHERE)) return target === rule || target.startsWith(`${rule}/`);
    const name = rule.slice(ANYWHERE.length);
    return target === name || target.startsWith(`${name}/`) || target.endsWith(`/${name}`) || target.includes(`/${name}/`);
  });
}

export function MaterialExclusionsForm() {
  const [state, setState] = useState<MaterialExclusionsResponse | null>(null), [rules, setRules] = useState<string[]>([]);
  const [listing, setListing] = useState<MaterialFoldersResponse | null>(null), [typed, setTyped] = useState("");
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [opening, setOpening] = useState(false);
  const request = useRef(0), live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const open = async (path: string) => {
    const id = ++request.current; setOpening(true);
    try {
      const result = await api<MaterialFoldersResponse>("/api/materials/folders", { method: "POST", body: { path }, intent: true, timeoutMs: 30_000 });
      if (live.current && id === request.current) { setListing(result); setError(""); }
    } catch (cause) { if (live.current && id === request.current) setError(message(cause)); }
    finally { if (live.current && id === request.current) setOpening(false); }
  };
  const read = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api<MaterialExclusionsResponse>("/api/materials/exclusions", { intent: true, timeoutMs: 30_000 });
      if (!live.current) return;
      setState(result); setRules(result.rules);
      void open(listing?.path ?? "");
    } catch (cause) { if (live.current) setError(message(cause)); }
    finally { if (live.current) setBusy(false); }
  };
  useEffect(() => { void read(); }, []);

  const add = (value: string) => {
    const rule = ruleText(value);
    if (!rule || rule === "**") { setError("请输入文件夹的路径或名字"); return false; }
    if (rules.some(each => each.toLowerCase() === rule.toLowerCase())) { setError(`规则「${rule}」已在列表里`); return false; }
    setError(""); setNotice(""); setRules(previous => [...previous, rule]);
    return true;
  };
  const remove = (rule: string) => { setNotice(""); setRules(previous => previous.filter(each => each !== rule)); };
  const dirty = !!state && (state.rules.length !== rules.length || state.rules.some((rule, at) => rule !== rules[at]));
  const save = async () => {
    if (busy) return; setBusy(true); setError("");
    try {
      const result = await api<MaterialExclusionsResponse>("/api/materials/exclusions", { method: "POST", body: { rules }, intent: true, timeoutMs: 30_000 });
      if (!live.current) return;
      setState(result); setRules(result.rules);
      setNotice("已保存。索引正在按新规则重新生成，机器人下一次查资料时生效；稍后点「重新读取」查看文件数。");
    } catch (cause) { if (live.current) setError(message(cause)); }
    finally { if (live.current) setBusy(false); }
  };

  const index = state?.index, path = listing?.path ?? "", crumbs = path ? path.split("/") : [];
  const indexed = new Map((index?.topLevel ?? []).map(item => [item.name.replace(/\/$/, "").toLowerCase(), item]));
  return <Section title="资料索引的排除目录" id="materials-exclusions"
    aside={<button type="button" class="btn ghost small-btn" disabled={busy} onClick={() => void read()}><Icon name="refresh" size={13} class={busy ? "spin" : undefined} />{busy ? "正在读取…" : "重新读取"}</button>}
    footer={<>排除的文件夹不进资料索引，机器人查资料时也搜不到里面的文件（知道路径时仍然可以直接打开）。适合排除同步工具自己的目录、回收站、历史归档这类不需要检索的内容。
      规则按路径从共享资料目录算起，不区分大小写；写成 <code>**/名字</code> 则排除每一层叫这个名字的文件夹。点开头的文件夹、node_modules、软链接本来就不进索引。</>}>
    {error && <div class="group-note form-error" role="alert">{error}</div>}
    {notice && <div class="group-note ok-note" role="status"><Icon name="checkmark" size={13} />{notice}</div>}
    {!state && busy && <Skeleton lines={3} />}
    {state && <>
      <div class="group-note">{index
        ? <>当前索引 {count(index.files)} 个文件，{bytes(index.bytes)}，生成于 {dateTime(index.generatedAt)}。
          {index.truncated && <span class="materials-warn"> 索引不完整：达到 {count(index.limit)} 个文件的上限，或有读不到的文件夹。排除不需要检索的文件夹可以把名额让给其他资料。</span>}</>
        : "还没有索引数据：服务启动后的第一次对话或保存规则后生成，稍后点「重新读取」。"}</div>
      <div class="materials-rules" aria-label="排除规则">
        {!rules.length && <span class="muted">没有排除规则，共享资料里的文件夹都进索引。</span>}
        {rules.map(rule => <span class="chip neutral" key={rule}><span class="mono">{rule}</span>
          <button type="button" class="chip-remove" aria-label={`移除规则 ${rule}`} disabled={busy} onClick={() => remove(rule)}><Icon name="x" size={11} /></button></span>)}
      </div>
      <div class="materials-browser">
        <div class="crumb-trail" aria-label="当前位置">
          <button type="button" class="crumb-btn" disabled={opening} onClick={() => void open("")}>共享资料</button>
          {crumbs.map((name, at) => <span key={at} class="materials-crumb"><Icon name="chevronRight" size={12} />
            <button type="button" class="crumb-btn" disabled={opening} onClick={() => void open(crumbs.slice(0, at + 1).join("/"))}>{name}</button></span>)}
        </div>
        {!listing ? (opening ? <Skeleton lines={2} /> : null) : <ul class="materials-folders" aria-label={`${path || "共享资料"} 里的文件夹`} aria-busy={opening}>
          {!listing.folders.length && <li class="muted">这一层没有文件夹。</li>}
          {listing.folders.map(name => {
            const full = path ? `${path}/${name}` : name, by = excludedBy(full, rules), own = by?.toLowerCase() === full.toLowerCase();
            const size = path ? undefined : indexed.get(name.toLowerCase());
            return <li key={name}>
              <button type="button" class="materials-folder" disabled={opening} onClick={() => void open(full)}><Icon name="folder" size={15} /><span>{name}</span></button>
              {size && !by && <span class="muted materials-size">{count(size.files)} 个文件，{bytes(size.bytes)}</span>}
              <span class="row-text" />
              {by && <span class="chip warn" data-tip={own ? undefined : `规则 ${by}`}>已排除</span>}
              {own ? <button type="button" class="btn ghost small-btn" disabled={busy} onClick={() => remove(by!)}>恢复</button>
                : !by && <button type="button" class="btn small-btn" disabled={busy} aria-label={`排除 ${full}`} onClick={() => add(full)}>排除</button>}
            </li>;
          })}
          {listing.more && <li class="muted">文件夹太多，只列出前一部分；其余的请直接输入路径。</li>}
        </ul>}
      </div>
      <div class="row push-add">
        <input class="materials-input" placeholder="文件夹路径，如 归档/2023；或 **/名字" aria-label="添加排除规则" value={typed} disabled={busy} spellcheck={false} autoComplete="off"
          onInput={event => setTyped(event.currentTarget.value)} onKeyDown={event => { if (event.key === "Enter" && add(typed)) setTyped(""); }} />
        <button type="button" class="btn" disabled={busy || !typed.trim()} onClick={() => { if (add(typed)) setTyped(""); }}>加入规则</button>
        <span class="row-text" />
        <button type="button" class="btn primary" disabled={busy || !dirty} onClick={() => void save()}>保存</button>
      </div>
    </>}
  </Section>;
}
