/** @jsxImportSource preact */
// Write pages: temporary file and relay maintenance, the statistics import, the advanced runtime settings and the
// directory scope. Each write is previewed and confirmed as a task, except the directory scope, which applies on save.
import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import { api } from "./api.ts";
import type { BrowsePurpose, Overview } from "./contract.ts";
import { PathField } from "./files.tsx";
import { Icon } from "./icons.tsx";
import { TaskAction } from "./tasks.tsx";
import { Field, Row, Section, Segmented, Skeleton, Toggle } from "./ui.tsx";
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function StorageActions() {
  const [days, setDays] = useState("30");
  const [scopes, setScopes] = useState<{ key: string; label: string }[] | null>(null), [scope, setScope] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true); setError("");
    try { const result = await api<{ scopes: { key: string; label: string }[]; truncated: boolean }>("/api/storage/scopes", { intent: true, timeoutMs: 120_000 });
      setScopes(result.scopes); setScope(""); if (result.truncated) setError("成员超过 10000 位，列表只显示前 10000 位。"); }
    catch (error) { setError(message(error)); } finally { setBusy(false); }
  };
  const valid = /^\d+$/.test(days) && Number(days) <= 36500;
  return <Section title="维护" footer="每个操作先生成清单，核对后确认。物理回收和删除归档检查全部空间，各用独立清单。">
    <Field label="未改动天数" note="0 表示不限时间。">
      <input type="number" min="0" max="36500" value={days} onInput={event => setDays(event.currentTarget.value)} />
    </Field>
    <Field label="归档范围" note={scopes ? `可选 ${scopes.length} 个成员。` : "默认归档全部空间与成员；读取成员后可只归档其中一位。"}>
      <span class="inline-control">
        <select value={scope} disabled={!scopes} onChange={event => setScope(event.currentTarget.value)}>
          <option value="">全部空间与成员</option>{scopes?.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
        </select>
        <button type="button" class="btn small-btn" disabled={busy} onClick={() => void load()}>{busy ? "正在读取…" : scopes ? "重新读取" : "读取可归档成员"}</button>
      </span>
    </Field>
    {error && <div class="group-note form-error" role="alert">{error}</div>}
    <Row icon="archive" tint="cyan" title="归档" detail="把未改动且没有被引用的临时文件移入归档，可以恢复；归档本身不释放磁盘空间。">
      <TaskAction operation="tmp-purge" params={{ days: Number(days), ...(scope ? { scope } : {}) }} disabled={!valid}>预览归档</TaskAction>
    </Row>
    <Row icon="trash" tint="red" title="删除归档" detail="按归档清单永久删除已归档的文件，释放空间。不可撤销。">
      <TaskAction operation="tmp-discard" params={{}} danger>预览删除归档</TaskAction>
    </Row>
    <Row icon="scissors" tint="orange" title="物理回收" detail="物理删除超过天数、已登记的临时产物。不可撤销。">
      <TaskAction operation="tmp-reclaim" params={{ days: Number(days) }} disabled={!valid} danger>预览物理回收</TaskAction>
    </Row>
  </Section>;
}

export function RelayActions() {
  const [all, setAll] = useState(false), [keyword, setKeyword] = useState("");
  return <Section title="维护" footer="清理会删除对象，相关下载链接随即失效。">
    <Row icon="sparkles" tint="indigo" title="测试外链存储" detail="上传并删除一个测试文件，检查签名下载、未签名访问被拒和删除后失效；不需要停机。">
      <TaskAction operation="relay-test" params={{}}>测试外链存储</TaskAction>
    </Row>
    <Field label="名称或链接关键字" note="只清理名称或链接含这个关键字的外链。">
      <input value={keyword} disabled={all} placeholder={all ? "清理全部在册外链" : "关键字"} onInput={event => setKeyword(event.currentTarget.value)} />
    </Field>
    <div class="row"><Toggle label="清理全部在册外链" checked={all} onChange={setAll} /></div>
    <Row icon="trash" tint="red" title="清理外链" detail="预览列出将要删除的对象，确认后执行。">
      <TaskAction operation="relay-purge" params={all ? { all: true } : { keyword }} disabled={!all && !keyword.trim()} danger>预览清理</TaskAction>
    </Row>
  </Section>;
}

export function StatsImportForm() {
  const [path, setPath] = useState("");
  return <>
    <Section title="从主机文件导入" footer="使用停止写入的一致快照；WAL 尚未合并时须保留同目录的 -wal 文件。">
      <div class="group-note">把已保存的统计账本恢复到全新部署的空账本。已有统计或已导入另一份时不能覆盖；同一份文件重复导入不会增加统计。</div>
      <Field group label="主机上的统计文件" note="运行控制台的主机上 stats.sqlite 的完整路径。">
        <PathField label="统计文件" purpose="stats" value={path} onChange={setPath} placeholder="stats.sqlite 的完整路径" />
      </Field>
      <div class="row"><span class="row-text" />
        <TaskAction operation="stat-import" params={{ path }} disabled={!path.trim()} primary>校验并预览导入</TaskAction>
      </div>
    </Section>
    <StatsUpload />
  </>;
}

function StatsUpload() {
  const [database, setDatabase] = useState<File | null>(null), [wal, setWal] = useState<File | null>(null), [id, setId] = useState<string | null>(null),
    [busy, setBusy] = useState(false), [status, setStatus] = useState(""), [walMerged, setWalMerged] = useState(false);
  const upload = async () => {
    if (!database || busy) return; setBusy(true); setStatus("正在上传统计文件…"); let created: string | undefined;
    try {
      const result = await api<{ id: string }>("/api/uploads", { method: "POST", body: { databaseBytes: database.size, walBytes: wal?.size ?? 0, walMerged: !wal && walMerged }, intent: true });
      created = result.id;
      for (const [part, file] of [["database", database], ["wal", wal]] as const) {
        if (!file) continue;
        const response = await fetch(`/api/uploads/${result.id}/${part}`, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", body: file,
          headers: { "Content-Type": "application/octet-stream", "X-Console-Request": "1", "X-Console-Intent": "user" }, signal: AbortSignal.timeout(120_000) });
        if (!response.ok) { const body = await response.json().catch(() => null); throw new Error(body?.error ?? "文件上传失败"); }
      }
      await api(`/api/uploads/${result.id}/seal`, { method: "POST", body: {}, intent: true });
      setId(result.id); setStatus("文件已上传。核对预览后确认导入；任务结束会删除上传副本。");
    } catch (error) {
      setStatus(error instanceof TypeError || (error as Error)?.name === "TimeoutError" ? "上传连接中断或超时，请重试" : message(error));
      if (created) await api(`/api/uploads/${created}/cancel`, { method: "POST", body: {}, quiet: true }).catch(() => {});
    } finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!id || busy) return; setBusy(true);
    try { await api(`/api/uploads/${id}/cancel`, { method: "POST", body: {}, intent: true }); setId(null); setStatus("上传副本已删除。"); }
    catch (error) { setStatus(message(error)); } finally { setBusy(false); }
  };
  return <Section title="或从这台电脑上传" footer="数据库和 WAL 合计最多 512 MB。WAL 模式的数据库如果同目录还有 -wal 文件，须一并选择，否则会缺少其中尚未合并的改动；正常关闭后通常没有 -wal。未提交的上传一小时后清理。">
    <Field label="统计数据库"><input type="file" accept=".sqlite,.sqlite3,.db" disabled={busy || !!id} onChange={event => setDatabase(event.currentTarget.files?.[0] ?? null)} /></Field>
    <Field label="对应的 WAL（可选）"><input type="file" disabled={busy || !!id} onChange={event => setWal(event.currentTarget.files?.[0] ?? null)} /></Field>
    {!wal && <div class="row"><Toggle label="同目录没有 -wal 文件" detail="WAL 模式的数据库已正常关闭。" checked={walMerged} disabled={busy || !!id} onChange={setWalMerged} /></div>}
    {status && <div class="group-note" role="status">{busy && <Icon name="loader" size={13} class="spin" />} {status}</div>}
    <div class="row"><span class="row-text" />
      {id ? <><button class="btn" disabled={busy} onClick={() => void cancel()}>删除上传副本</button>
        <TaskAction operation="stat-import" params={{ upload: id }} onStarted={() => setId(null)} primary>校验上传并预览</TaskAction></>
        : <button class="btn" disabled={busy || !database} onClick={() => void upload()}><Icon name={busy ? "loader" : "upload"} size={14} class={busy ? "spin" : undefined} />{busy ? "上传中…" : "上传文件"}</button>}
    </div>
  </Section>;
}

interface RuntimeOption { key: string; label: string; description: string; unit?: string; default: string; empty?: string; range?: number[]; choices?: { value: string; label: string }[];
  browse?: { purpose: BrowsePurpose; unavailable?: string } }
interface RuntimeForm { hash: string | null; values: Record<string, string>; groups: { label: string; description: string; options: RuntimeOption[] }[] }
/** The advanced runtime settings, a group at a time. A change is kept until it is applied or dropped, whichever group is shown. */
export function RuntimeForm({ area = "runtime" }: { area?: "runtime" | "materials" }) {
  const [data, setData] = useState<RuntimeForm | null>(null), [changes, setChanges] = useState<Record<string, string | null>>({}), [error, setError] = useState(""), [version, setVersion] = useState(0);
  const [group, setGroup] = useState("");
  useEffect(() => {
    const controller = new AbortController(); setData(null); setChanges({});
    void api<RuntimeForm>("/api/forms/runtime", { signal: controller.signal }).then(value => {
      const groups = value.groups.map(group => ({ ...group, ...(group.label === "缓存与索引" ? {
        label: area === "materials" ? "资料索引" : "模型缓存", description: area === "materials" ? "资料索引容量与刷新" : "模型服务商的缓存保留策略",
      } : {}), options: group.options.filter(option =>
        (option.key.startsWith("BOT_DOCUMENT_") || option.key.startsWith("BOT_INDEX_")) === (area === "materials")) })).filter(group => group.options.length);
      if (!controller.signal.aborted) { setData({ ...value, groups }); setError(""); setGroup(previous => groups.some(item => item.label === previous) ? previous : groups[0]?.label ?? ""); }
    }, error => { if (!controller.signal.aborted) setError(message(error)); });
    return () => controller.abort();
  }, [version, area]);
  const change = (key: string, value: string) => setChanges(previous => ({ ...previous, [key]: value || null }));
  const shown = data?.groups.find(item => item.label === group) ?? data?.groups[0];
  const changed = data ? data.groups.flatMap(item => item.options).filter(option => Object.hasOwn(changes, option.key)) : [];
  return <Section title={area === "materials" ? "文档与索引参数" : "运行参数"}
    aside={<button type="button" class="btn ghost small-btn" onClick={() => setVersion(value => value + 1)}><Icon name="refresh" size={13} />重新读取</button>}
    footer="保存前校验；执行时短暂停机，结束后恢复原来的运行状态。留空表示恢复默认值。">
    {error && <div class="group-note form-error" role="alert">{error}</div>}
    {!data && !error && <Skeleton lines={3} />}
    {data && shown && <>
      <div class="row tabs-row">
        <Segmented label="参数分组" size="small" value={shown.label} onChange={setGroup}
          options={data.groups.map(item => ({ value: item.label, label: <>{item.label}{item.options.some(option => Object.hasOwn(changes, option.key)) && <span class="change-dot" aria-hidden="true" />}</> }))} />
      </div>
      <div class="group-note">{shown.description}</div>
      {shown.options.map(option => {
        const edited = Object.hasOwn(changes, option.key), current = edited ? changes[option.key] ?? "" : data.values[option.key] ?? "";
        // The change bar names every changed option; the dot only marks it here.
        const label = <>{option.label}{option.unit ? `（${option.unit}）` : ""}{edited && <span class="change-dot" aria-hidden="true" />}</>;
        return option.browse ? <Field key={option.key} group class="stack" label={label} note={option.description}>
          <PathField label={option.label} purpose={option.browse.purpose} value={current} unavailable={option.browse.unavailable}
            placeholder={option.default || option.empty || "默认"} onChange={value => change(option.key, value)} />
        </Field> : <Field key={option.key} label={label} note={option.description}>
          {option.choices ? <select value={current} onChange={event => change(option.key, event.currentTarget.value)}>
            <option value="">默认：{option.choices.find(item => item.value === option.default)?.label ?? option.default}</option>
            {option.choices.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
            : option.range ? <input value={current} type="number" min={option.range[0]} max={option.range[1]} placeholder={option.default} onInput={event => change(option.key, event.currentTarget.value)} />
              : <input value={current} type="text" placeholder={option.default || option.empty || "默认"} onInput={event => change(option.key, event.currentTarget.value)} />}
        </Field>;
      })}
      <div class={`row change-bar${changed.length ? " active" : ""}`}>
        <span class="row-text">{changed.length ? `已修改 ${changed.length} 项：${changed.map(option => option.label).join("、")}` : "尚未修改"}</span>
        {changed.length > 0 && <button type="button" class="btn ghost small-btn" onClick={() => setChanges({})}>放弃修改</button>}
        <TaskAction operation="runtime-configure" params={{ hash: data.hash, changes }} disabled={!changed.length} primary>校验并预览</TaskAction>
      </div>
    </>}
  </Section>;
}

interface Department { key: string; name: string }
/** The service's limit (MAX_SCOPE_DEPARTMENTS, which this bundle cannot import); the service refuses more anyway. */
export const MAX_DEPARTMENTS = 200;
/** How often, and how long, the form follows a saved scope being applied; after that the status above tells. */
const APPLY_POLL_MS = 2_000, APPLY_FOLLOW_MS = 10 * 60_000;
interface Selection { view: string; mode: string; state: string; selected: Department[]; unavailable: number; children: Department[] }
const keysOf = (items: Department[]) => items.map(item => item.key).toSorted().join(" ");
/** `onSettled`: a save has ended (applied, failed, or nothing to apply), so the status shown elsewhere is out of date. */
export function DirectoryForm({ onSettled }: { onSettled?: () => void }) {
  const [data, setData] = useState<Selection | null>(null), [mode, setMode] = useState("departments"), [selected, setSelected] = useState<Department[]>([]),
    [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [tree, setTree] = useState<Record<string, Department[]>>({});
  // The mode and departments as last read from the service (ticks that differ are not saved yet), and when a save started applying.
  const [loaded, setLoaded] = useState({ mode: "", keys: "" }), [applying, setApplying] = useState(0);
  const open = async () => { setBusy(true); setError(""); try {
    const value = await api<Selection>("/api/directory/selection", { intent: true, timeoutMs: 180_000 });
    const fresh = { mode: value.mode === "all" ? "all" : "departments", keys: keysOf(value.selected) };
    // Reading the tree again keeps ticks not saved yet: the keys of a login stay the same, so they still name the same departments.
    const edited = data !== null && (mode !== loaded.mode || keysOf(selected) !== loaded.keys);
    setData(value); setLoaded(fresh); setTree({}); setNotice("");
    if (!edited) { setSelected(value.selected); setMode(fresh.mode); }
  } catch (error) { setError(message(error)); } finally { setBusy(false); } };
  const expand = async (parent: string) => { if (!data || busy) return; setBusy(true); setError(""); try {
    const result = await api<{ children: Department[] }>("/api/directory/children", { method: "POST", body: { view: data.view, parent }, intent: true, timeoutMs: 90_000 });
    setTree(previous => ({ ...previous, [parent]: result.children }));
  } catch (error) { setError(message(error)); } finally { setBusy(false); } };
  const save = async () => { if (!data || busy) return; setBusy(true); setError(""); try {
    const result = await api<{ status: string }>("/api/directory/apply", { method: "POST", body: { view: data.view, mode, selected: mode === "all" ? [] : selected.map(item => item.key) }, intent: true, timeoutMs: 90_000 });
    setNotice(result.status === "started" ? "已保存，正在应用新范围。应用期间原名单继续生效。" : result.status === "unchanged" ? "这个范围已经生效。" : "已恢复当前生效范围。"); setData(null);
    if (result.status === "started") setApplying(Date.now()); else onSettled?.();
  } catch (error) { setError(message(error)); } finally { setBusy(false); } };
  // Follows the scope being applied (the console's status reads, which do not keep the login alive) and says how it ended.
  useEffect(() => {
    if (!applying) return;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (text: string) => { setNotice(text); setApplying(0); onSettled?.(); };
    const poll = async () => {
      try {
        const directory = (await api<Overview>("/api/overview")).service.directory;
        if (stopped) return;
        if (directory?.state === "effective") return settle(`新范围已生效：在册成员 ${directory.mappings} 名。`);
        if (directory?.state === "failed") return settle(`新范围没有应用成功：${directory.stateText}`);
        if (directory?.running) setNotice(`已保存，正在应用新范围（${directory.running}）。应用期间原名单继续生效。`);
      } catch { if (stopped) return; }
      if (Date.now() - applying < APPLY_FOLLOW_MS) timer = setTimeout(() => void poll(), APPLY_POLL_MS);
      else settle("新范围仍在应用，完成前原名单继续生效；可在上方刷新查看进度。");
    };
    timer = setTimeout(() => void poll(), APPLY_POLL_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }, [applying]);
  // A department includes all of its subdepartments: below a selected one the boxes show it, and selecting a department
  // drops its subdepartments chosen one by one (as far as the tree has been opened).
  const below = (key: string, seen = new Set<string>()): Set<string> => {
    for (const child of tree[key] ?? []) if (!seen.has(child.key)) { seen.add(child.key); below(child.key, seen); }
    return seen;
  };
  const nodes = (items: Department[], ancestors: Department[] = []): JSX.Element => <ul class="department-tree">{items.filter(item => !ancestors.some(value => value.key === item.key)).map(item => {
    const covering = ancestors.find(ancestor => selected.some(value => value.key === ancestor.key));
    return <li key={item.key}>
      <label class="check-label"><input type="checkbox" disabled={busy || mode === "all" || !!covering} checked={!!covering || selected.some(value => value.key === item.key)}
        onChange={event => { const checked = event.currentTarget.checked, inner = below(item.key);
          setSelected(previous => checked ? [...previous.filter(value => value.key !== item.key && !inner.has(value.key)), item] : previous.filter(value => value.key !== item.key)); }} />
        {item.name}{covering && <small>（已包含在「{covering.name}」中）</small>}</label>
      <button class="btn ghost" disabled={busy} onClick={() => void expand(item.key)}>下级部门</button>
      {tree[item.key] && (tree[item.key]!.length ? nodes(tree[item.key]!, [...ancestors, item]) : <small>无下级部门</small>)}
    </li>;
  })}</ul>;
  const tooMany = mode === "departments" && selected.length > MAX_DEPARTMENTS;
  // All: every top-level department (each includes its subdepartments, so nothing else stays selected); none: nothing at all.
  const top = data?.children ?? [], allTop = top.length > 0 && top.every(item => selected.some(value => value.key === item.key));
  // Selected departments without a box on screen (below a department not opened yet) can still be dropped.
  const shown = new Set(top.flatMap(item => [item.key, ...below(item.key)])), hidden = selected.filter(item => !shown.has(item.key));
  return <Section title="同步范围" footer="选择范围后保存即开始应用，不需要再预览确认。机器人必须正在运行。重新读取部门树时，尚未保存的勾选会保留。">
    <Row icon="users" tint="mint" title="部门范围" detail={data ? "整个通讯录，或选定的部门（包含其全部下级部门）。" : "读取部门树后选择整个通讯录或部分部门。"}>
      <button class="btn" disabled={busy} onClick={() => void open()}>{busy ? "正在读取…" : data ? "重新读取部门树" : "选择同步范围"}</button>
    </Row>
    {error && <div class="group-note form-error" role="alert">{error}</div>}
    {notice && <div class="group-note" role="status">{notice}</div>}
    {data && <>
      <Row title="同步范围">
        <Segmented label="同步范围" size="small" value={mode} disabled={busy} onChange={setMode}
          options={[{ value: "all", label: "整个通讯录" }, { value: "departments", label: "选定部门" }]} />
      </Row>
      {data.unavailable > 0 && <div class="group-note form-error" role="alert">有 {data.unavailable} 个原选部门已不可查询，保存时将移除。</div>}
      {mode === "departments" && <div class="row-body">
        <p class="selected-line">已选择：{selected.map(item => item.name).join("、") || "无"}</p>
        {hidden.length > 0 && <p class="selected-line">其中 {hidden.length} 个在尚未展开的下级部门里（{hidden.slice(0, 5).map(item => item.name).join("、")}{hidden.length > 5 ? " 等" : ""}），展开到它们可以取消勾选。
          <button class="btn ghost small-btn" disabled={busy} onClick={() => setSelected(previous => previous.filter(value => shown.has(value.key)))}>取消这 {hidden.length} 个</button></p>}
        <label class="check-label select-all"><input type="checkbox" checked={allTop} indeterminate={!allTop && selected.length > 0} disabled={busy || !top.length || top.length > MAX_DEPARTMENTS}
          onChange={event => setSelected(event.currentTarget.checked ? top : [])} />全选（{top.length} 个一级部门）</label>
        {nodes(data.children)}
      </div>}
      {tooMany && <div class="group-note form-error" role="alert">最多选 {MAX_DEPARTMENTS} 个部门；可以改选它们的上级部门。</div>}
      <div class="row"><span class="row-text muted">{mode === "all" ? "保存后同步整个通讯录。" : `已选 ${selected.length} 个部门。`}</span>
        <button class="btn primary" disabled={busy || mode === "departments" && (!selected.length || tooMany)} onClick={() => void save()}>保存并立即应用</button></div>
    </>}
  </Section>;
}
