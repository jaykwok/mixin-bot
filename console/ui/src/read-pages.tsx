/** @jsxImportSource preact */
// Read pages: health checks, logs, temporary files, relay objects and the directory status, each read from the host on
// demand. The page's own actions (`children`) follow what was read.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.ts";
import type { ReadPage } from "./contract.ts";
import { clock } from "./format.ts";
import { Icon, type IconName } from "./icons.tsx";
import { NAV } from "./nav.ts";
import { Banner, EmptyState, PageHeader, Row, Section, Segmented, Skeleton } from "./ui.tsx";

type Filters = { keyword: string; level: string; task: string };
const LEVELS = [{ value: "all", label: "全部" }, { value: "error", label: "错误" }, { value: "warn", label: "警告" }, { value: "info", label: "信息" }];
/** Directory rows that only matter while they say something. */
const OPTIONAL = new Set(["正在处理", "错误", "自动复核"]);

/** `refresh`: read the page again whenever it changes (a write elsewhere on the page has ended). */
export function ReadOnlyPage({ page, refresh = 0, children }: { page: string; refresh?: number; children?: ComponentChildren }) {
  const [data, setData] = useState<ReadPage | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState<Filters>({ keyword: "", level: "all", task: "" });
  const current = useRef<AbortController | null>(null);
  const item = NAV.find(item => item.id === page)!;
  /** `intent`: the user asked for it (renews the login's idle timer); an automatic read does not. */
  const load = async (download = false, intent = true, using = filters) => {
    current.current?.abort();
    const controller = new AbortController(); current.current = controller;
    setBusy(true); setError("");
    try {
      const result = await api<ReadPage>(`/api/read/${page}`, { method: "POST", body: { ...using, export: download },
        signal: controller.signal, intent, timeoutMs: 95_000 });
      if (controller.signal.aborted) return;
      setData(result);
      if (download) {
        const url = URL.createObjectURL(new Blob([result.rows.map(row => row.join("\t")).join("\n") + "\n"], { type: "text/plain;charset=utf-8" }));
        const a = document.createElement("a"); a.href = url; a.download = `logs-${new Date().toISOString().slice(0, 10)}.txt`; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  useEffect(() => { setData(null); void load(); return () => current.current?.abort(); }, [page]);
  useEffect(() => { if (refresh) void load(false, false); }, [refresh]);
  const filter = (patch: Partial<Filters>) => setFilters(previous => ({ ...previous, ...patch }));
  return <>
    <PageHeader title={item.label} description={item.description} actions={<>
      {page === "logs" && <button class="btn" type="button" disabled={busy} onClick={() => void load(true)}><Icon name="download" size={14} />导出筛选结果</button>}
      <button class="btn" type="button" disabled={busy} onClick={() => void load()}><Icon name="refresh" size={14} class={busy ? "spin" : undefined} />刷新</button>
    </>} />
    {page === "logs" && <form class="filter-bar read-filters" onSubmit={event => { event.preventDefault(); void load(); }}>
      <div class="input-icon"><Icon name="search" size={14} />
        <input type="search" aria-label="关键词" placeholder="关键词" value={filters.keyword} maxLength={128} onInput={event => filter({ keyword: event.currentTarget.value })} /></div>
      <input class="task-filter" aria-label="任务编号" placeholder="任务编号" value={filters.task} maxLength={128} spellcheck={false} onInput={event => filter({ task: event.currentTarget.value })} />
      <Segmented label="级别" size="small" options={LEVELS} value={filters.level} disabled={busy}
        onChange={level => { const next = { ...filters, level }; setFilters(next); void load(false, true, next); }} />
      <button class="btn small-btn" disabled={busy}>筛选</button>
    </form>}
    {error && <Banner tone="danger" icon="alert" title="读取失败" action={<button class="btn small-btn" onClick={() => void load()}>重试</button>}>{error}</Banner>}
    {!data && busy && <Section><Skeleton lines={4} /></Section>}
    {data && <Result page={page} data={data} />}
    {children}
  </>;
}

function Result({ page, data }: { page: string; data: ReadPage }) {
  const meta = <div class="read-meta"><span>读取于 {clock(data.checkedAt)}</span><span>{data.note}</span></div>;
  if (page === "health") return <Health data={data} />;
  if (page === "directory") return <>
    <Section title="同步状态">
      {data.rows.filter(([key, value]) => !(OPTIONAL.has(key!) && value === "—")).map(([key, value]) => <Row key={key} class="value" title={key}>{value}</Row>)}
    </Section>
    {meta}
  </>;
  return <>
    {meta}
    {!data.rows.length ? <Section><EmptyState icon={page === "logs" ? "logs" : "folder"} title="暂无记录" /></Section> : (
      <div class="group section">
        <div class="table-wrap scroll">
          <table class="data-table read-table">
            <thead><tr>{data.columns.map(column => <th key={column}>{column}</th>)}</tr></thead>
            <tbody>{data.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => page === "logs"
              ? <td key={column} class={column === 0 ? undefined : "wrap"}>{column === 0 ? <span class={`level ${cell}`}>{cell}</span> : <span class="log-text">{cell}</span>}</td>
              : <td key={column} class={column === 0 ? "wrap" : undefined}>{cell}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </div>
    )}
  </>;
}

const CHECKS: Record<string, { icon: IconName; tint: "green" | "orange" | "red"; tone: "ok" | "warn" | "danger" }> = {
  通过: { icon: "check", tint: "green", tone: "ok" }, 警告: { icon: "alert", tint: "orange", tone: "warn" }, 失败: { icon: "x", tint: "red", tone: "danger" },
};

/** Health checks: how many passed, then what needs attention (failures first) with what to do, then what passed. */
function Health({ data }: { data: ReadPage }) {
  const rows = data.rows.map(([name, result, detail, fix]) => ({ name: name!, result: result!, detail: detail!, fix: fix! }));
  const count = (result: string) => rows.filter(row => row.result === result).length;
  const attention = rows.filter(row => row.result !== "通过").toSorted((a, b) => (a.result === "失败" ? 0 : 1) - (b.result === "失败" ? 0 : 1));
  const check = (row: typeof rows[number]) => {
    const look = CHECKS[row.result] ?? CHECKS.警告!;
    return <div key={row.name} class="row check-row">
      <span class={`glyph tint-${look.tint}`} aria-hidden="true"><Icon name={look.icon} size={14} /></span>
      <div class="row-text">
        <div class="row-title">{row.name}<span class="sr-only">：{row.result}</span></div>
        {row.detail && <div class="row-detail">{row.detail}</div>}
        {row.result !== "通过" && row.fix && <div class="check-fix"><strong>处理建议</strong>{row.fix}</div>}
      </div>
    </div>;
  };
  return <>
    <div class="health-summary">
      {(["通过", "警告", "失败"] as const).map(result => <div key={result} class={`stat tone-${count(result) ? CHECKS[result]!.tone : "neutral"}`}>
        <div class="stat-value">{count(result)}</div><div class="stat-label">{result}</div></div>)}
    </div>
    {attention.length > 0 && <Section title="需要处理">{attention.map(check)}</Section>}
    {count("通过") > 0 && <Section title="已通过">{rows.filter(row => row.result === "通过").map(check)}</Section>}
    <p class="footnote">读取于 {clock(data.checkedAt)} · {data.note}</p>
  </>;
}
