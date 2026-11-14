/** @jsxImportSource preact */
// The settings page: what is configured now, and an editor per configuration. An edit is a private draft on the host:
// saved and checked first, then previewed and applied as a task; cancelling or leaving the page discards it.
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.ts";
import type { ReadPage } from "./contract.ts";
import { clock } from "./format.ts";
import { Icon, type IconName } from "./icons.tsx";
import { MaterialExclusionsForm } from "./materials.tsx";
import { ModelPicker } from "./model-picker.tsx";
import type { Tint } from "./nav.ts";
import { TaskAction, taskEnded, useFollowed } from "./tasks.tsx";
import { Banner, Field, PageHeader, Row, Section, Segmented, Skeleton, Spinner, Toggle } from "./ui.tsx";
import { RuntimeForm } from "./write-forms.tsx";

type Kind = "models" | "app" | "relay";
type Secret = { mode: "keep" | "set" | "clear"; value?: string };
type Model = { id: string; name?: string; contextWindow?: number; maxTokens?: number; input?: string[]; reasoning?: boolean;
  cost?: Record<string, number>; thinking?: string[] };
type Provider = { id: string; custom?: boolean; api?: string; baseUrl?: string; hasKey?: boolean; models: Model[] };
interface Form { kind: Kind; provider?: string; model?: string; thinking?: string; providers?: Provider[]; appId?: string; environment?: string; bound?: boolean;
  catalogModels?: (Model & { provider: string })[];
  hasSecret?: boolean; hasAccessKey?: boolean; hasToken?: boolean; enabled?: boolean; endpoint?: string; region?: string; bucket?: string; prefix?: string;
  forcePathStyle?: boolean; maxBytes?: number; expireHours?: number; cleanupGraceMinutes?: number }
interface Draft { id: string; revision: number; expiresAt: number; validated: boolean; summary: string[]; form: Form }
/** `listable`: the protocols whose endpoints list their models. */
interface Catalog { providers: { id: string; name: string }[]; apis: string[]; listable?: string[]; models: (Model & { provider: string })[] }
type Patch = Record<string, unknown>;
/** A custom endpoint's models, for the provider, protocol and endpoint they were fetched with. */
interface Listed { key: string; models: Model[] }
/** Pi's protocol IDs under the names providers document them by. */
const API_LABELS: Record<string, string> = { "openai-completions": "OpenAI Chat Completions", "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages", "google-generative-ai": "Google Gemini", "mistral-conversations": "Mistral",
  "azure-openai-responses": "Azure OpenAI Responses", "openai-codex-responses": "OpenAI Codex Responses", "google-vertex": "Google Vertex AI",
  "bedrock-converse-stream": "Amazon Bedrock Converse", "pi-messages": "Pi Messages" };
/**
 * Where each protocol's base URL ends: the clients add their own paths after it. Described, not shown as an address: the
 * page names no address outside this console (tests/console/bundle.test.ts).
 */
const ENDPOINTS: Record<string, string> = {
  "openai-completions": "通常到 /v1 为止，请求发到 <端点>/chat/completions；兼容服务按其文档填写。",
  "openai-responses": "通常到 /v1 为止，请求发到 <端点>/responses。",
  "anthropic-messages": "不含 /v1：请求发到 <端点>/v1/messages。",
  "google-generative-ai": "含 API 版本（例如 /v1beta）。",
  "mistral-conversations": "不含 /v1：请求发到 <端点>/v1/chat/completions。",
};
const listKey = (patch: Patch) => JSON.stringify([patch.provider, patch.api, patch.baseUrl]);
const titles = { models: "模型配置", app: "应用机器人凭据", relay: "外链配置" };
const SECTIONS: Record<Kind, { title: string; icon: IconName; tint: Tint; detail: string }> = {
  models: { title: "模型", icon: "sparkles", tint: "purple", detail: "机器人使用的服务商、模型和推理级别。" },
  app: { title: "应用机器人", icon: "bot", tint: "blue", detail: "量子密信应用机器人的 AppID、环境和密钥。" },
  relay: { title: "外链", icon: "link", tint: "indigo", detail: "大文件改用 S3 兼容存储的下载链接发送。" },
};
const errorText = (value: unknown) => value instanceof Error ? value.message : String(value);
const retained = (has?: boolean, optional = false): Secret => ({ mode: has ? "keep" : optional ? "clear" : "set" });

function modelPatch(form: Form, providerId: string, catalog?: Catalog): Patch {
  const provider = form.providers?.find(value => value.id === providerId), model = provider?.models.find(value => value.id === form.model) ?? provider?.models[0];
  return { provider: providerId, mode: provider?.custom ? "custom" : "builtin", api: provider?.api ?? "openai-completions", baseUrl: provider?.baseUrl ?? "",
    key: retained(provider?.hasKey), model: provider?.custom ? model ?? { id: "", contextWindow: 128000, maxTokens: 8192, input: ["text"], reasoning: false }
      : (form.provider === providerId ? form.model : undefined) ?? catalog?.models.find(value => value.provider === providerId)?.id ?? "",
    thinking: form.thinking ?? "off" };
}
function initial(form: Form, catalog?: Catalog): Patch {
  if (form.kind === "models") return modelPatch(form, form.provider ?? form.providers?.[0]?.id ?? "", catalog);
  if (form.kind === "app") return { appId: form.appId ?? "", environment: form.environment ?? "production", secret: retained(form.hasSecret) };
  return { enabled: form.enabled ?? false, endpoint: form.endpoint ?? "", region: form.region ?? "", bucket: form.bucket ?? "", prefix: form.prefix ?? "",
    forcePathStyle: form.forcePathStyle ?? false, maxBytes: form.maxBytes, expireHours: form.expireHours, cleanupGraceMinutes: form.cleanupGraceMinutes,
    accessKey: retained(form.hasAccessKey), secret: retained(form.hasSecret), token: retained(form.hasToken, true) };
}
/** `stored`: a value exists (saved, or already in this draft) that "keep" can keep; without one there is only a new value to enter. */
function SecretField({ label, value, optional, stored, change }: { label: string; value: Secret; optional?: boolean; stored: boolean; change: (value: Secret) => void }) {
  const keep = stored || value.mode === "keep";
  return <Field label={label} note={keep ? "原值不回显。改端点或账户时需要重新填写凭据。" : undefined}>
    <span class="inline-control">
      <select aria-label={`${label}处理方式`} value={value.mode} onChange={event => change({ mode: event.currentTarget.value as Secret["mode"] })}>
        {keep && <option value="keep">保留已设置的值</option>}<option value="set">填写新值</option>{optional && <option value="clear">清除（可选）</option>}</select>
      {value.mode === "set" && <input aria-label={label} type="password" autoComplete="new-password" value={value.value ?? ""} onInput={event => change({ mode: "set", value: event.currentTarget.value })} />}
    </span>
  </Field>;
}

/**
 * A first deployment's configuration step: the draft must be checked online, and instead of being applied it is handed to
 * the deployment (`onReady` gets its id once checked, null once it is not). `round` changes when a deployment took the draft:
 * the form lets it go (the task finishes it) and keeps the fields it showed, without secrets, for another attempt.
 */
export interface DeployDraft { title: string; onReady(draft: string | null): void; blocked?: string; round: number }

/** What a released first-deployment draft leaves for the next one: the fields, with every secret to be entered again. */
const withoutSecrets = (patch: Patch): Patch => Object.fromEntries(Object.entries(patch).map(([key, value]) =>
  [key, value && typeof value === "object" && "mode" in value ? { mode: "set" } : value]));

/** One configuration: its saved summary (`summary`, from the settings read) and its draft editor. */
export function ConfigurationForm({ kind, summary, deploy }: { kind: Kind; summary?: string[][]; deploy?: DeployDraft }) {
  const [draft, setDraft] = useState<Draft | null>(null), [patch, setPatch] = useState<Patch>({}), [catalog, setCatalog] = useState<Catalog>(),
    [busy, setBusy] = useState(false), [error, setError] = useState(""), [valid, setValid] = useState(false), [network, setNetwork] = useState(!!deploy), [refresh, setRefresh] = useState(false),
    [listed, setListed] = useState<Listed | null>(null), [listing, setListing] = useState(false), [listError, setListError] = useState("");
  const current = useRef<string | null>(null), generation = useRef(0), kept = useRef<Patch | null>(null), round = useRef(deploy?.round);
  const discard = (id: string) => api("/api/configuration/discard", { method: "POST", body: { id }, quiet: true }).catch(() => {});
  useEffect(() => () => { generation.current++; if (current.current) void discard(current.current); current.current = null; }, []);
  // A first deployment hears whether its draft is ready.
  const ready = valid && draft ? draft.id : null;
  useEffect(() => { deploy?.onReady(ready); }, [ready]);
  useEffect(() => {
    if (!deploy || deploy.round === round.current) return;
    round.current = deploy.round; generation.current++;
    if (current.current) kept.current = withoutSecrets(patch);
    current.current = null; setDraft(null); setPatch({}); setBusy(false); setValid(false); setListed(null); setListing(false); setListError("");
  }, [deploy?.round]);
  const change = (key: string, value: unknown) => { setPatch(previous => ({ ...previous, [key]: value })); setValid(false); };
  const open = async () => {
    const request = ++generation.current; setBusy(true); setError(""); setValid(false);
    try {
      if (current.current) { await discard(current.current); current.current = null; }
      const next = await api<Draft>("/api/configuration/open", { method: "POST", body: { kind }, intent: true });
      if (request !== generation.current) { void discard(next.id); return; }
      current.current = next.id; setDraft(next); setPatch({ ...initial(next.form), ...kept.current }); kept.current = null; setNetwork(!!deploy); setRefresh(false);
      setListed(null); setListing(false); setListError("");
      if (kind === "models") {
        const data = await api<Catalog>("/api/configuration/catalog", { intent: true, timeoutMs: 90_000 });
        if (request === generation.current) setCatalog(data);
      }
    } catch (error) { if (request === generation.current) setError(errorText(error)); }
    finally { if (request === generation.current) setBusy(false); }
  };
  const check = async () => {
    if (!draft || busy) return; const request = generation.current; setBusy(true); setError(""); setValid(false);
    try {
      const edited = await api<Draft>("/api/configuration/edit", { method: "POST", body: { id: draft.id, revision: draft.revision, patch }, intent: true });
      if (request !== generation.current) return;
      setDraft(edited); setPatch(initial(edited.form, catalog)); // clear new secret inputs after the private host draft took them
      const checked = await api<Draft>("/api/configuration/check", { method: "POST", body: { id: edited.id, revision: edited.revision, network, refresh }, intent: true, timeoutMs: 120_000 });
      if (request === generation.current) { setDraft(checked); setValid(checked.validated); }
    } catch (error) { if (request === generation.current) setError(errorText(error)); }
    finally { if (request === generation.current) setBusy(false); }
  };
  /** The custom endpoint's models, with the key as typed or the one the draft keeps; the draft itself is not changed. */
  const fetchModels = async () => {
    if (!draft || busy || listing) return; const request = generation.current, key = listKey(patch); setListing(true); setListError("");
    try {
      const result = await api<{ models: Model[] }>("/api/configuration/models", { method: "POST", intent: true, timeoutMs: 120_000,
        body: { id: draft.id, patch: { provider: patch.provider, mode: "custom", api: patch.api, baseUrl: patch.baseUrl, key: patch.key } } });
      if (request === generation.current) setListed({ key, models: result.models });
    } catch (error) { if (request === generation.current) { setListed(null); setListError(errorText(error)); } }
    finally { if (request === generation.current) setListing(false); }
  };
  const close = () => { generation.current++; if (current.current) void discard(current.current); current.current = null; setDraft(null); setPatch({}); setBusy(false); setError(""); setValid(false);
    setListed(null); setListing(false); setListError(""); };
  const text = (key: string, label: string, number = false) => <Field label={label}>{number
    ? <input type="number" value={String(patch[key] ?? "")} onInput={event => change(key, Number(event.currentTarget.value))} />
    : <input type="text" value={String(patch[key] ?? "")} onInput={event => change(key, event.currentTarget.value)} />}</Field>;
  // A secret can be kept only when the draft's form says one is set (for models: on the provider chosen now).
  const stored = (key: string) => !!draft && ((kind === "models" ? modelPatch(draft.form, String(patch.provider ?? ""), catalog)
    : initial(draft.form, catalog))[key] as Secret | undefined)?.mode === "keep";
  const secret = (key: string, label: string, optional = false) => <SecretField label={label} optional={optional} stored={stored(key)}
    value={(patch[key] as Secret) ?? retained(false, optional)} change={value => change(key, value)} />;
  const custom = patch.mode === "custom", model = typeof patch.model === "object" ? patch.model as Model : { id: String(patch.model ?? "") };
  const changeModel = (key: keyof Model, value: unknown) => change("model", { ...model, [key]: value });
  const models = [...new Map([...(catalog?.models ?? []), ...(draft?.form.catalogModels ?? [])].filter(value => value.provider === patch.provider).map(value => [value.id, value])).values()];
  const thinking = models.find(value => value.id === model.id)?.thinking ?? ["off", "minimal", "low", "medium", "high", "xhigh"];
  // A custom provider's candidates: the models it already has, then what its endpoint listed.
  const saved = draft?.form.providers?.find(value => value.id === patch.provider && value.custom)?.models ?? [];
  const fetched = listed?.key === listKey(patch) ? listed.models : null;
  const candidates = [...new Map([...saved, ...fetched ?? []].map(value => [value.id, value])).values()];
  const apis = [...new Set([...(catalog?.listable ?? []), ...(catalog?.apis ?? ["openai-completions"])])];
  const listable = (catalog?.listable ?? []).includes(String(patch.api)), endpoint = ENDPOINTS[String(patch.api)];
  const keyReady = (patch.key as Secret | undefined)?.mode === "keep" || !!(patch.key as Secret | undefined)?.value?.trim();
  /** A picked custom model takes its saved definition, else what the list and the bundled catalogue know of it. */
  const pickCustom = (picked: Model) => {
    const own = saved.find(value => value.id === picked.id);
    if (own) { change("model", { ...own }); return; }
    const known = catalog?.models.find(value => value.id === picked.id) ?? catalog?.models.find(value => value.id === picked.id.split("/").pop());
    change("model", { ...model, id: picked.id, name: picked.name ?? known?.name ?? picked.id, contextWindow: picked.contextWindow ?? known?.contextWindow ?? model.contextWindow,
      maxTokens: picked.maxTokens ?? known?.maxTokens ?? model.maxTokens, input: picked.input ?? known?.input ?? model.input, reasoning: known?.reasoning ?? model.reasoning });
  };
  const listNote = !listable ? "这个协议没有模型列表接口，请直接填写模型 ID。" : listing ? "正在向端点获取模型列表…"
    : fetched ? fetched.length ? `端点提供 ${fetched.length} 个模型：在“模型 ID”里输入关键词筛选，或点击选择。` : "端点没有返回模型，请直接填写模型 ID。"
      : "填写协议、API 端点和密钥后获取端点提供的模型（只请求模型列表，不发起推理）；也可以直接填写模型 ID。";
  const section = SECTIONS[kind];
  return <Section title={deploy?.title ?? section.title}
    aside={<button type="button" class={`btn small-btn${draft ? " ghost" : ""}`} disabled={busy && !draft || !draft && !!deploy?.blocked} onClick={() => void open()}>
      {draft ? deploy ? "放弃并重新填写" : "放弃并重新读取" : <><Icon name="pencil" size={13} />{deploy ? "填写" : "编辑配置"}</>}</button>}
    footer={draft ? deploy ? `保存草稿并${kind === "app" ? "在线校验（获取应用 token）" : "校验（Pi 核对服务商、模型和凭据引用，不发起模型推理）"}。草稿只保存在本机，确认首次部署后才写入正式配置。` : "先保存草稿并校验，再预览应用。取消或关闭页面不会修改正式配置。" : undefined}>
    {!draft && (summary?.length ? summary.map(([name, value]) => <Row key={name} class="value" title={name}>{value}</Row>)
      : <Row icon={section.icon} tint={section.tint} title={titles[kind]} detail={deploy?.blocked
        ?? (deploy && kept.current ? "这份配置已交给首次部署。部署没有完成时，重新填写会带上次的内容，密钥需要重新填写。" : section.detail)} />)}
    {error && <div class="group-note form-error" role="alert">{error}</div>}
    {draft && <>
      <fieldset class="draft-fields" disabled={busy}><legend class="sr-only">配置草稿</legend>
        {kind === "app" && <>{text("appId", "应用 AppID")}
          <Field label="环境"><select value={String(patch.environment)} onChange={event => change("environment", event.currentTarget.value)}><option value="production">生产环境</option><option value="staging">预发布环境</option></select></Field>
          {secret("secret", "应用密钥")}
          {draft.form.bound && <div class="group-note">现有数据已绑定应用；这里只能修改同一应用的凭据。切换应用请全新部署。</div>}</>}
        {kind === "relay" && <><div class="row"><Toggle label="启用外链" detail="关闭后大文件仍按平台限制直接发送。" checked={!!patch.enabled} onChange={value => change("enabled", value)} /></div>
          {!!patch.enabled && <>{text("endpoint", "S3 端点")}{text("region", "区域")}{text("bucket", "存储桶")}{text("prefix", "路径前缀（可为空）")}
            <div class="row"><Toggle label="使用路径式寻址" checked={!!patch.forcePathStyle} onChange={value => change("forcePathStyle", value)} /></div>
            {text("maxBytes", "文件上限（字节）", true)}{text("expireHours", "链接有效期（小时）", true)}{text("cleanupGraceMinutes", "清理宽限（分钟）", true)}
            {secret("accessKey", "访问密钥 ID")}{secret("secret", "访问密钥")}{secret("token", "临时会话令牌", true)}</>}</>}
        {kind === "models" && <><Field label="服务商 ID"><input list={`providers-${draft.id}`} value={String(patch.provider ?? "")} onInput={event => { setPatch(modelPatch(draft.form, event.currentTarget.value, catalog)); setValid(false); }} /></Field>
          <datalist id={`providers-${draft.id}`}>{[...new Set([...(draft.form.providers ?? []).map(value => value.id), ...(catalog?.providers ?? []).map(value => value.id)])].map(id => <option key={id} value={id} />)}</datalist>
          <Field group label="模型来源">
            <Segmented label="模型来源" size="small" value={patch.mode === "custom" ? "custom" : "builtin"}
              onChange={value => { change("mode", value); change("model", value === "custom" ? { id: model.id, contextWindow: 128000, maxTokens: 8192, input: ["text"], reasoning: false } : model.id); }}
              options={[{ value: "builtin", label: "内置服务商目录" }, { value: "custom", label: "自定义模型" }]} /></Field>
          {custom && <><div class="group-note">更改已有服务商的端点或协议，请使用新的服务商 ID。</div>
            <Field label="协议"><select value={String(patch.api)} onChange={event => change("api", event.currentTarget.value)}>{apis.map(api =>
              <option key={api} value={api}>{API_LABELS[api] ? `${API_LABELS[api]}（${api}）` : api}</option>)}</select></Field>
            <Field label="API 端点" note={endpoint}><input type="text" inputMode="url" spellcheck={false} placeholder="服务商的 API 地址，以 https 或 http 开头" value={String(patch.baseUrl ?? "")}
              onInput={event => change("baseUrl", event.currentTarget.value)} /></Field></>}
          {secret("key", "模型 API 密钥")}
          {custom ? <><Row title="模型列表" detail={listNote}>
              {listError && <div class="form-error" role="alert">{listError}</div>}
              <button type="button" class="btn small-btn" disabled={busy || listing || !listable || !String(patch.baseUrl ?? "").trim() || !keyReady} onClick={() => void fetchModels()}>
                {listing ? <><Icon name="loader" size={13} class="spin" />正在获取…</> : fetched ? "重新获取" : "获取模型列表"}</button></Row>
            <Field group label="模型 ID" note={candidates.length ? "可以输入关键词筛选，也可以填写列表里没有的模型 ID。" : undefined}>
              <ModelPicker label="模型 ID" value={model.id} models={candidates} placeholder={candidates.length ? "输入关键词筛选或填写模型 ID" : "填写模型 ID"}
                onInput={value => changeModel("id", value)} onPick={pickCustom} /></Field>
            <Field label="显示名称"><input value={model.name ?? ""} onInput={event => changeModel("name", event.currentTarget.value)} /></Field>
            <Field label="上下文上限"><input type="number" min="1" value={model.contextWindow} onInput={event => changeModel("contextWindow", Number(event.currentTarget.value))} /></Field>
            <Field label="输出上限"><input type="number" min="1" value={model.maxTokens} onInput={event => changeModel("maxTokens", Number(event.currentTarget.value))} /></Field>
            <div class="row"><Toggle label="支持推理" checked={model.reasoning ?? false} onChange={value => changeModel("reasoning", value)} /></div>
            <div class="row"><Toggle label="支持图片输入" checked={model.input?.includes("image") ?? false} onChange={value => changeModel("input", value ? ["text", "image"] : ["text"])} /></div>
            <Field label="每百万 token 单价"><span class="cost-grid">{[["input", "输入"], ["output", "输出"], ["cacheRead", "缓存读取"], ["cacheWrite", "缓存写入"]].map(([key, label]) =>
              <span class="cost-item" key={key}><span>{label}</span><input type="number" min="0" step="any" aria-label={`${label}单价`} value={model.cost?.[key!] ?? 0}
                onInput={event => changeModel("cost", { ...model.cost, [key!]: Number(event.currentTarget.value) })} /></span>)}</span></Field></>
            : <Field group label="模型" note={models.length ? `目录中有 ${models.length} 个模型，可以输入关键词筛选。` : "目录中没有这个服务商的模型；可以填写模型 ID。"}>
              <ModelPicker label="模型" value={model.id} models={models} placeholder="输入关键词筛选或选择模型"
                onInput={value => change("model", value)} onPick={picked => change("model", picked.id)} /></Field>}
          <Field label="推理级别"><select value={String(patch.thinking)} onChange={event => change("thinking", event.currentTarget.value)}>{[...new Set([String(patch.thinking), ...thinking])].map(value => <option key={value} value={value}>{value}</option>)}</select></Field></>}
        {kind !== "relay" && !deploy && <div class="row"><Toggle label={kind === "app" ? "联网验证应用凭据" : "允许刷新模型目录"} detail={kind === "app" ? "仅获取 token。" : "刷新所选服务商的模型目录，不发起推理。"}
          checked={network} onChange={value => { setNetwork(value); if (!value) setRefresh(false); setValid(false); }} /></div>}
        {kind === "models" && network && <div class="row"><Toggle label="本次刷新模型目录" checked={refresh} onChange={value => { setRefresh(value); setValid(false); }} /></div>}
      </fieldset>
      <div class="row"><span class="row-text" />
        <button class="btn" onClick={close}>取消草稿</button>
        <button class="btn" disabled={busy} onClick={() => void check()}>{busy ? "正在校验…" : "保存草稿并校验"}</button>
      </div>
      {valid && <div class="row-body draft-checked">
        <ul class="plan-summary">{draft.summary.map(line => <li key={line}>{line}</li>)}</ul>
        {deploy ? <p class="muted small"><Icon name="checkmark" size={13} />{kind === "app" ? "已在线校验" : "已校验"}，首次部署使用这份草稿。</p>
          : <div class="action-row"><TaskAction key={`${draft.id}-${draft.revision}`} operation="configuration-apply" params={{ draft: draft.id }} primary
            onStarted={() => { current.current = null; setDraft(null); setPatch({}); }}>预览应用配置</TaskAction></div>}
      </div>}
    </>}
  </Section>;
}

/**
 * A configuration change or maintenance left unfinished. `quiet`: show nothing while there is nothing to recover (the
 * settings page checks on opening; a failed check still shows).
 */
export function ConfigurationRecovery({ quiet = false }: { quiet?: boolean }) {
  type RecoveryState = { transaction: { id: string; phase: string; kind: Kind | "runtime" } | null; maintenancePending: boolean };
  const [state, setState] = useState<RecoveryState | null>(null), [error, setError] = useState(""), [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api<RecoveryState>("/api/configuration/state", { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { setState(value); setError(""); }
    }, error => { if (!controller.signal.aborted) { setState(null); setError(errorText(error)); } });
    return () => controller.abort();
  }, [version]);
  const transaction = state?.transaction;
  if (quiet && !error && (!state || !transaction && !state.maintenancePending)) return null;
  return <Section title="配置恢复" aside={<button type="button" class="btn ghost small-btn" onClick={() => setVersion(value => value + 1)}>检查配置事务</button>}>
    {error && <div class="group-note form-error" role="alert">{error}</div>}
    {!error && !state && <div class="row"><Spinner label="正在检查配置事务…" /></div>}
    {!error && state && <>
      {transaction && <Row icon="alert" tint="orange" title={<>{transaction.kind === "runtime" ? "高级运行参数" : titles[transaction.kind]}留下了待处理记录。</>} />}
      {state.maintenancePending ? <Row icon="wrench" tint="orange" title="上次维护尚未收尾" detail="如任务仍在运行，请等待完成；中断后从这里恢复。">
          <TaskAction operation="maintenance-recover" params={{}} onStarted={() => setState(null)} primary>预览恢复中断的维护</TaskAction></Row>
        : transaction ? <Row title={["committed", "rolled-back"].includes(transaction.phase) ? "完成收尾" : "恢复原配置"}
          detail={["committed", "rolled-back"].includes(transaction.phase) ? "配置已经提交或回滚，只差收尾。" : "按事务记录恢复修改前的配置。"}>
          <TaskAction operation="configuration-restore" params={{ draft: transaction.id }} onStarted={() => setState(null)} primary>
            {["committed", "rolled-back"].includes(transaction.phase) ? "预览完成配置收尾" : "预览恢复原配置"}</TaskAction></Row>
          : <Row icon="check" tint="green" title="没有未结束的配置事务。" />}
    </>}
  </Section>;
}

/** Settings rows are named "模型", "模型 · 推理级别", "外链 · 端点"…: each section takes the rows of its names. */
const rowsOf = (rows: string[][], names: string[]) => rows.filter(([name]) => names.some(prefix => name === prefix || name!.startsWith(`${prefix} · `)));
/** Tasks after which this page reads the saved settings again. */
const SETTINGS_TASKS = new Set(["configuration-apply", "configuration-restore", "runtime-configure", "maintenance-recover"]);

export function SettingsPage() {
  const [data, setData] = useState<ReadPage | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [version, setVersion] = useState(0);
  // A settings task confirmed on this page has ended since it opened: what is saved has changed, or a recovery is now due.
  // The runtime form starts over only after a runtime task (its unapplied changes would go too).
  const { followed } = useFollowed();
  const seen = useRef<Set<string> | null>(null), [ended, setEnded] = useState(0), [runtimeEnded, setRuntimeEnded] = useState(0);
  useEffect(() => {
    const done = followed.filter(item => SETTINGS_TASKS.has(item.operation) && taskEnded(item.task?.state));
    if (!seen.current) { seen.current = new Set(done.map(item => item.id)); return; }
    const fresh = done.filter(item => !seen.current!.has(item.id));
    if (!fresh.length) return;
    for (const item of fresh) seen.current.add(item.id);
    setEnded(value => value + 1);
    if (fresh.some(item => item.operation !== "configuration-apply" && item.operation !== "configuration-restore")) setRuntimeEnded(value => value + 1);
  }, [followed]);
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setError("");
    void api<ReadPage>("/api/read/settings", { method: "POST", body: {}, signal: controller.signal, intent: version > 0, timeoutMs: 95_000 }).then(value => {
      if (!controller.signal.aborted) { setData(value); setBusy(false); }
    }, error => { if (!controller.signal.aborted) { setError(errorText(error)); setBusy(false); } });
    return () => controller.abort();
  }, [version, ended]);
  const rows = data?.rows ?? [];
  const mcp = rowsOf(rows, ["MCP"]);
  return <>
    <PageHeader title="设置" description="模型、机器人凭据、外链与运行参数。修改先保存为草稿并校验，再预览应用。"
      actions={<button class="btn" disabled={busy} onClick={() => setVersion(value => value + 1)}><Icon name="refresh" size={14} class={busy ? "spin" : undefined} />刷新</button>} />
    {error && <Banner tone="danger" icon="alert" title="当前配置读取失败" action={<button class="btn small-btn" onClick={() => setVersion(value => value + 1)}>重试</button>}>{error}</Banner>}
    <ConfigurationRecovery key={ended} quiet />
    {!data && busy ? <Section><Skeleton lines={4} /></Section> : <>
      <ConfigurationForm kind="models" summary={rowsOf(rows, ["模型", "辅助模型"])} />
      <ConfigurationForm kind="app" summary={rowsOf(rows, ["应用机器人"])} />
      <ConfigurationForm kind="relay" summary={rowsOf(rows, ["外链", "外链配置"])} />
      {mcp.length > 0 && <Section title="MCP" footer="MCP 服务器在配置文件中设置，这里只显示摘要。">
        {mcp.map(([name, value]) => <Row key={name} class="value" icon="layers" tint="gray" title={name === "MCP" ? "MCP" : name!.slice("MCP · ".length)}>{value}</Row>)}
      </Section>}
    </>}
    <MaterialExclusionsForm />
    <RuntimeForm key={runtimeEnded} />
    {data && <p class="footnote">读取于 {clock(data.checkedAt)} · {data.note}</p>}
  </>;
}
