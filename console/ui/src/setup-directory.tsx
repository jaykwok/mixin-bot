/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.ts";
import { DeploymentDirectoryPicker, type DeploymentSelection } from "./deployment-directory.tsx";
import { Row, Section, Segmented } from "./ui.tsx";

export interface SavedDirectorySelection { saved: string }
interface SavedScope extends SavedDirectorySelection { mode: "all" | "departments"; count: number }
export function SetupDirectory({ draft, disabled, onChange }: {
  draft: string | null; disabled: boolean; onChange(value: SavedDirectorySelection | null): void;
}) {
  const [saved, setSaved] = useState<SavedScope | null>(null), [mode, setMode] = useState("none");
  const [editing, setEditing] = useState(false), [selection, setSelection] = useState<DeploymentSelection | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const load = async () => {
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    setSaved(null); setSelection(null); setMode("none"); setEditing(false); setError(""); onChange(null);
    if (!draft) { setBusy(false); return; }
    setBusy(true);
    try {
      const value = await api<{ scope: SavedScope | null }>("/api/setup/directory/read", { method: "POST", body: { draft }, signal: current.signal });
      if (current.signal.aborted) return;
      setSaved(value.scope); setMode(value.scope?.mode ?? "none"); setEditing(!value.scope);
      onChange(value.scope ? { saved: value.scope.saved } : null);
    } catch (error) { if (!current.signal.aborted) setError(error instanceof Error ? error.message : "读取范围失败"); }
    finally { if (!current.signal.aborted) setBusy(false); }
  };
  useEffect(() => { void load(); return () => controller.current?.abort(); }, [draft]);
  const save = async () => {
    if (!draft || busy || disabled || mode === "none" || mode === "departments" && !selection) return;
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    setBusy(true); setError("");
    try {
      const value = await api<{ scope: SavedScope }>("/api/setup/directory/save", { method: "POST",
        body: { draft, directory: mode === "all" ? "all" : selection }, intent: true, signal: current.signal, timeoutMs: 90_000 });
      if (current.signal.aborted) return;
      setSaved(value.scope); setMode(value.scope.mode); setEditing(false); onChange({ saved: value.scope.saved });
    } catch (error) { if (!current.signal.aborted) setError(error instanceof Error ? error.message : "保存范围失败"); }
    finally { if (!current.signal.aborted) setBusy(false); }
  };
  return <Section title="4. 通讯录同步范围" footer="范围单独保存在本机，重新登录或重开控制台后可恢复，不受模型配置超时影响。部署时再核对并应用。">
    {!draft ? <div class="group-note">先完成第 2 步的应用机器人在线校验，再读取或保存同步范围。</div> : <>
      <fieldset class="draft-fields" disabled={busy || disabled}><legend class="sr-only">首次部署的通讯录范围</legend>
        <Row title="同步范围" detail="机器人从平台同步哪些部门的成员。之后可在“通讯录”页修改。">
          <Segmented label="通讯录同步范围" size="small" value={mode} disabled={busy || disabled} onChange={value => {
            setMode(value); setSelection(null); setEditing(true); onChange(null);
          }} options={[{ value: "none", label: "未选择" }, { value: "all", label: "整个通讯录" }, { value: "departments", label: "部分部门" }]} />
        </Row>
        {editing && mode === "departments" && <div class="row-body flush-top"><DeploymentDirectoryPicker draft={draft} onChange={setSelection} /></div>}
        {!editing && saved ? <Row title={saved.mode === "all" ? "已保存：整个通讯录" : `已保存：${saved.count} 个部门及其下级部门`} detail="重新校验同一个应用的凭据后，选择仍会保留。">
          <button type="button" class="btn" onClick={() => { setEditing(true); setSelection(null); onChange(null); }}>修改范围</button>
        </Row> : editing && <Row title="保存选择" detail="选好即可保存，无需等待模型配置或完成部署。">
          <button type="button" class="btn primary" disabled={busy || disabled || mode === "none" || mode === "departments" && !selection} onClick={() => void save()}>保存选择范围</button>
        </Row>}
      </fieldset>
      {busy && <div class="group-note" role="status">正在读取或保存同步范围…</div>}
      {error && <div class="group-note form-error" role="alert">{error}<button type="button" class="btn ghost small-btn" disabled={busy || disabled} onClick={() => void load()}>重新读取已保存范围</button></div>}
    </>}
  </Section>;
}
