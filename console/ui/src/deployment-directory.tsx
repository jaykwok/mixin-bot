/** @jsxImportSource preact */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.ts";

type Department = { key: string; name: string };
export interface DeploymentSelection { view: string; selected: string[] }
/** `draft`: before the first deployment, the checked application draft the tree is read with. */
export function DeploymentDirectoryPicker({ onChange, draft }: { onChange(value: DeploymentSelection | null): void; draft?: string }) {
  const [data, setData] = useState<{ view: string; children: Department[]; selected?: Department[] } | null>(null), [selected, setSelected] = useState<Department[]>([]);
  const [tree, setTree] = useState<Record<string, Department[]>>({}), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null), locked = useRef(false);
  useEffect(() => () => { controller.current?.abort(); }, []);
  const read = async (parent?: string) => {
    if (locked.current) return; locked.current = true; setBusy(true); setError("");
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    if (!parent) { onChange(null); setData(null); setSelected([]); setTree({}); }
    try {
      if (parent && data) {
        const value = await api<{ children: Department[] }>("/api/lifecycle/directory/children", { method: "POST", body: { view: data.view, parent }, intent: true, signal: current.signal, timeoutMs: 90_000 });
        if (!current.signal.aborted) setTree(previous => ({ ...previous, [parent]: value.children }));
      } else {
        const value = await api<NonNullable<typeof data>>("/api/lifecycle/directory/open", { method: "POST", body: draft === undefined ? {} : { draft }, intent: true, signal: current.signal, timeoutMs: 90_000 });
        if (!current.signal.aborted) {
          setData(value); setSelected(value.selected ?? []);
          onChange(value.selected?.length ? { view: value.view, selected: value.selected.map(item => item.key) } : null);
        }
      }
    } catch (error) { if (!current.signal.aborted) setError(error instanceof Error ? error.message : "部门查询失败"); }
    finally { locked.current = false; if (!current.signal.aborted) setBusy(false); }
  };
  const choose = (next: Department[]) => { setSelected(next); onChange(data && next.length ? { view: data.view, selected: next.map(value => value.key) } : null); };
  const below = (key: string, seen = new Set<string>()): Set<string> => {
    for (const child of tree[key] ?? []) if (!seen.has(child.key)) { seen.add(child.key); below(child.key, seen); }
    return seen;
  };
  const select = (item: Department, checked: boolean) => {
    const inner = below(item.key);
    choose(checked ? [...selected.filter(value => value.key !== item.key && !inner.has(value.key)), item] : selected.filter(value => value.key !== item.key));
  };
  // All: every top-level department (each includes its subdepartments); none: nothing at all.
  const top = data?.children ?? [], allTop = top.length > 0 && top.every(item => selected.some(value => value.key === item.key));
  const shown = new Set(top.flatMap(item => [item.key, ...below(item.key)])), hidden = selected.filter(item => !shown.has(item.key));
  const cancel = () => { controller.current?.abort(); setData(null); setSelected([]); setTree({}); setBusy(false); setError(""); onChange(null); };
  const nodes = (items: Department[], ancestors: Department[] = []): JSX.Element => <ul class="department-tree">{items.filter(item => !ancestors.some(value => value.key === item.key)).map(item => {
    const covering = ancestors.find(ancestor => selected.some(value => value.key === ancestor.key));
    return <li key={item.key}>
    <label class="check-label"><input type="checkbox" checked={!!covering || selected.some(value => value.key === item.key)} disabled={busy || !!covering || selected.length >= 200 && !selected.some(value => value.key === item.key)}
      onChange={event => select(item, event.currentTarget.checked)} />{item.name}{covering && <small>（已包含在「{covering.name}」中）</small>}</label>
    <button class="btn ghost" disabled={busy} onClick={() => void read(item.key)}>下级部门</button>
    {tree[item.key] && (tree[item.key]!.length ? nodes(tree[item.key]!, [...ancestors, item]) : <small>无下级部门</small>)}
  </li>; })}</ul>;
  return <div class="dept-picker">
    <p class="muted small">直接向平台查询，不要求机器人运行。{draft ? "选好后可单独保存范围，部署时应用。" : "预览时重新核对，部署时应用。"}最多选择 200 个部门，包含其全部子部门。</p>
    <div class="action-row">
      <button class="btn small-btn" disabled={busy} onClick={() => void read()}>{busy ? "正在查询部门…" : data ? "重新读取部署部门树" : "读取部署部门树"}</button>
      {(data || busy) && <button class="btn ghost small-btn" onClick={cancel}>取消部门选择</button>}
    </div>
    {error && <p role="alert" class="form-error">{error}</p>}
    {data && <>
      {hidden.length > 0 && <p class="selected-line">有 {hidden.length} 个已选部门在尚未展开的下级中。
        <button class="btn ghost small-btn" disabled={busy} onClick={() => choose(selected.filter(item => shown.has(item.key)))}>取消这 {hidden.length} 个</button></p>}
      <label class="check-label select-all"><input type="checkbox" checked={allTop} indeterminate={!allTop && selected.length > 0} disabled={busy || !top.length || top.length > 200}
        onChange={event => choose(event.currentTarget.checked ? top : [])} />全选（{top.length} 个一级部门）</label>
      {nodes(data.children)}<p class="muted small">已选 {selected.length} 个部门。</p></>}
  </div>;
}
