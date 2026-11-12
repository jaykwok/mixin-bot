/** @jsxImportSource preact */
// 推送页的推送记录：列表（按状态筛选、翻页），打开一条推送看每个接收人的发送、确认、选择和回复，补推送、修改抄送、
// 下载汇总包（汇总表和回复附件，号码打码）、删除已结束的推送。都经运行中的机器人；没有运行时只提示。
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.ts";
import type {
  PushDetailResponse, PushGroupKey, PushListCursor, PushListItemView, PushListResponse, PushRecipientView, PushState, PushTicket, PushTotalsView,
} from "./contract.ts";
import { bytes, dateTime } from "./format.ts";
import { Icon } from "./icons.tsx";
import { Chip, Section, Segmented, Skeleton, type Tone } from "./ui.tsx";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

const STATE: Record<PushState, [string, Tone]> = {
  preview: ["待确认", "info"], sending: ["发送中", "info"], open: ["进行中", "ok"], closed: ["已截止", "neutral"], cancelled: ["已取消", "neutral"],
  expired: ["已失效", "neutral"],
};
const MODE = { ack: "确认收到", options: "选项", reply: "需要回复" } as const;
const GROUPS: { value: PushGroupKey | "all"; label: string }[] = [
  { value: "all", label: "全部" }, { value: "live", label: "进行中" }, { value: "closed", label: "已结束" }, { value: "preview", label: "待确认" },
  { value: "void", label: "未发出" },
];
const live = (state: PushState) => state === "sending" || state === "open";

function stateChip(push: PushListItemView) {
  const [label, tone] = STATE[push.state];
  const closed = push.state === "closed" && push.closeReason === "complete" ? "已全部答复" : label;
  return <>
    <Chip tone={tone}>{closed}</Chip>
    {push.state === "closed" && push.summaryState === "pending" && <Chip tone="info">汇总待发</Chip>}
    {push.state === "closed" && push.summaryState === "failed" && <Chip tone="danger">汇总没有发出</Chip>}
  </>;
}

/** Started a one-time download link: a same-origin `download` link keeps the page where it is. */
function download(url: string) {
  const link = document.createElement("a");
  link.href = url; link.download = ""; link.hidden = true;
  document.body.append(link); link.click(); link.remove();
}

const rate = (part: number, whole: number) => `${Math.round(part / whole * 100)}%（${part}/${whole}）`;

/** The totals line: pushes sent, and over the closed ones how many recipients confirmed and replied. */
function totalsText(totals: PushTotalsView): string {
  if (!totals.sent) return "还没有发出过推送。";
  const sent = `已发出 ${totals.sent} 条推送${totals.followUps || totals.live ? `（${[totals.followUps ? `含补推送 ${totals.followUps} 条` : "",
    totals.live ? `进行中 ${totals.live} 条` : ""].filter(Boolean).join("，")}）` : ""}`;
  if (!totals.delivered) return `${sent}。`;
  return `${sent}。已结束的推送按送达的人或群计：确认率 ${rate(totals.acked, totals.delivered)}`
    + `${totals.replyDelivered ? `，回复率 ${rate(totals.replied, totals.replyDelivered)}` : ""}。`;
}

export function PushRecords() {
  const [group, setGroup] = useState<PushGroupKey | "all">("all");
  const [pushes, setPushes] = useState<PushListItemView[]>([]), [more, setMore] = useState(false);
  const [totals, setTotals] = useState<PushTotalsView | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [open, setOpen] = useState<string | null>(null);
  const load = async (before?: PushListCursor) => {
    setBusy(true); setError("");
    try {
      const result = await api<PushListResponse>("/api/push/list", { method: "POST", body: { group: group === "all" ? null : group, ...(before ? { before } : {}) },
        timeoutMs: 30_000 });
      setPushes(previous => before ? [...previous, ...result.pushes] : result.pushes); setMore(result.more); setTotals(result.totals);
    } catch (error) { setError(message(error)); } finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, [group]);
  return <>
    <Section title="推送记录"
      aside={<>
        <Segmented label="推送状态" options={GROUPS} value={group} onChange={value => { setOpen(null); setGroup(value); }} disabled={busy} size="small" />
        <button class="btn ghost small-btn" disabled={busy} onClick={() => void load()}><Icon name="refresh" size={13} class={busy ? "spin" : undefined} />{busy ? "正在读取…" : "刷新"}</button>
      </>}
      footer="推送人点预览卡片上的「确认推送」后发出。打开一条推送可以补推送、修改抄送和下载汇总包。">
      {totals && <div class="group-note push-totals">{totalsText(totals)}</div>}
      {error && <div class="group-note form-error" role="alert">{error}</div>}
      {!pushes.length && busy && <Skeleton lines={3} />}
      {!error && !busy && !pushes.length && <div class="group-note">没有推送。</div>}
      {pushes.length > 0 && <div class="table-wrap"><table class="data-table push-records"><thead><tr>
        <th>主题</th><th>推送人</th><th>状态</th><th>要求</th><th>发出</th><th>截止</th><th>答复</th><th /></tr></thead>
        <tbody>{pushes.map(push => <tr key={push.id} class={open === push.id ? "selected" : undefined}>
          <td class="wrap">{push.subject}{push.of && <> <Chip tone="info" tip={`补推送：推送编号 ${push.of}`}>补推送</Chip></>}<div class="muted mono">{push.id}</div></td>
          <td class="wrap">{push.pusher}</td>
          <td>{stateChip(push)}</td>
          <td>{MODE[push.mode]}</td>
          <td>{push.confirmedAt ? dateTime(push.confirmedAt) : <><span class="muted">{dateTime(push.createdAt)}</span><div class="muted">准备，未发出</div></>}</td>
          <td>{dateTime(push.deadline)}</td>
          <td>{push.counts.answered}/{push.counts.delivered}{push.counts.failed ? <div class="muted">失败 {push.counts.failed}</div> : null}</td>
          <td><button class={`btn small-btn${open === push.id ? " active" : " ghost"}`} onClick={() => setOpen(open === push.id ? null : push.id)}>{open === push.id ? "收起" : "查看"}</button></td>
        </tr>)}</tbody></table></div>}
      {more && <div class="row"><span class="row-text" /><button class="btn small-btn" disabled={busy} onClick={() => { const last = pushes.at(-1)!; void load({ createdAt: last.createdAt, id: last.id }); }}>更早的推送</button></div>}
    </Section>
    {open && <PushDetailCard key={open} id={open} onChanged={() => void load()} onDeleted={() => { setOpen(null); void load(); }} />}
  </>;
}

type Filter = "all" | "waiting" | "answered" | "failed";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "全部" }, { value: "waiting", label: "未答复" }, { value: "answered", label: "已答复" }, { value: "failed", label: "发送失败" },
];
const matches = (filter: Filter, recipient: PushRecipientView) => filter === "all" ? true : filter === "answered" ? recipient.answered
  : filter === "failed" ? recipient.sendState === "failed" : !recipient.answered;
const SEND = { pending: "未发出", sending: "发送中", sent: "已发出", uncertain: "可能已发出", failed: "发送失败" } as const;

/** "3 人", "2 个群", "3 人、2 个群". */
function reach(total: number, groups: number): string {
  const people = total - groups;
  return [...(people || !groups ? [`${people} 人`] : []), ...(groups ? [`${groups} 个群`] : [])].join("、");
}

/** `；已转给 张三、李四`, or nothing. */
const handedOn = (recipient: PushRecipientView) => recipient.forwardedTo.length ? `；已转给 ${recipient.forwardedTo.join("、")}` : "";

function answerOf(push: PushDetailResponse["push"], recipient: PushRecipientView): string {
  if (recipient.sendState === "failed") return recipient.sendError ? `没有送达：${recipient.sendError}` : "没有送达";
  if (push.mode === "options") return (recipient.choice === null ? "未选择" : `选择「${recipient.choice}」${recipient.choiceAt ? `（${dateTime(recipient.choiceAt)}）` : ""}`) + handedOn(recipient);
  // A group's 「已收到」 is anyone's click there: the first one's time and how many there were.
  const acked = recipient.ackedAt === null ? "" : recipient.group ? `首次 ${dateTime(recipient.ackedAt)}，共点击 ${recipient.clicks} 次` : dateTime(recipient.ackedAt);
  if (push.mode === "ack") return (recipient.ackedAt === null ? "未确认" : `已确认（${acked}）`) + handedOn(recipient);
  if (!recipient.reply) return (recipient.ackedAt === null ? "未确认，未回复" : "已确认，未回复") + handedOn(recipient);
  const files = recipient.reply.files.map(file => file.name).join("、");
  return `${recipient.reply.text || "（没有文字）"}${files ? `；附件：${files}` : ""}${handedOn(recipient)}`;
}

function PushDetailCard({ id, onChanged, onDeleted }: { id: string; onChanged: () => void; onDeleted: () => void }) {
  const [detail, setDetail] = useState<PushDetailResponse | null>(null), [filter, setFilter] = useState<Filter>("all");
  const [chosen, setChosen] = useState<Set<string>>(new Set()), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false), [deleting, setDeleting] = useState(false);
  const [cc, setCc] = useState<{ key?: string; name: string; phone: string }[] | null>(null), [ccPhone, setCcPhone] = useState(""), [ccName, setCcName] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(""); setNotice(""); try { await work(); } catch (error) { setError(message(error)); } finally { setBusy(false); } };
  const reload = () => run(async () => { setDetail(await api<PushDetailResponse>("/api/push/detail", { method: "POST", body: { id }, intent: true, timeoutMs: 30_000 })); setChosen(new Set()); });
  useEffect(() => { void reload(); }, [id]);
  // The detail opens under the list: bring it into view.
  useEffect(() => { box.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" }); }, [detail !== null]);
  if (!detail) return <div ref={box} class="push-detail"><Section title={`推送 ${id}`}>{error ? <div class="group-note form-error" role="alert">{error}</div> : <Skeleton lines={4} />}</Section></div>;
  const { push, recipients, view } = detail;
  const shown = recipients.filter(recipient => matches(filter, recipient));
  const waiting = recipients.filter(recipient => !recipient.answered && recipient.sendState !== "pending" && recipient.sendState !== "sending");
  const canRemind = (live(push.state) || push.state === "closed") && waiting.length > 0 && !(push.state === "closed" && push.followUp);
  const waitingGroups = waiting.filter(recipient => recipient.group).length;
  const chosenGroups = recipients.filter(recipient => recipient.group && chosen.has(recipient.key)).length;
  const canDelete = push.state === "cancelled" || push.state === "expired" || (push.state === "closed" && push.summaryState !== "pending");
  const canCc = push.state === "preview" || live(push.state) || (push.state === "closed" && push.summaryState === "pending");
  const remind = (people?: string[]) => run(async () => {
    const result = await api<{ resent?: number; followUp?: string }>("/api/push/remind", { method: "POST", body: { view, id, ...(people ? { people } : {}) }, intent: true, timeoutMs: 30_000 });
    setNotice(result.followUp ? `已把补推送预览发给推送人（推送编号 ${result.followUp}），推送人点「确认推送」后才发出。`
      : result.resent ? `已重新发出 ${result.resent} 张卡片。` : "没有需要补推送的对象（已答复的和还在发送中的卡片不重发）。");
    setDetail(await api<PushDetailResponse>("/api/push/detail", { method: "POST", body: { id }, intent: true, timeoutMs: 30_000 })); setChosen(new Set());
    onChanged();
  });
  const pack = (person?: string) => run(async () => {
    const ticket = await api<PushTicket>("/api/push/package", { method: "POST", body: { view, id, ...(person ? { person } : {}) }, intent: true });
    download(ticket.url);
    // The page cannot see the browser's download, so the note says only what stays true.
    setNotice(`已开始下载 ${ticket.filename}，进度见浏览器的下载列表；附件多时机器人要先打包，下载会晚一些开始。`);
  });
  const saveCc = () => run(async () => {
    setDetail(await api<PushDetailResponse>("/api/push/cc", { method: "POST", intent: true, timeoutMs: 30_000,
      body: { view, id, cc: cc!.map(person => person.key ? { key: person.key } : { phone: person.phone, name: person.name }) } }));
    setCc(null); setNotice("抄送人已保存，汇总时发给他们。");
  });
  const addCc = () => {
    const phone = ccPhone.replace(/[\s-]/g, "");
    if (!/^\+?\d{5,20}$/.test(phone)) { setError("请输入抄送人的完整手机号"); return; }
    setError(""); setCc(previous => [...previous ?? [], { phone, name: ccName.trim() }]); setCcPhone(""); setCcName("");
  };
  const remove = () => run(async () => { await api("/api/push/delete", { method: "POST", body: { id }, intent: true, timeoutMs: 30_000 }); onDeleted(); });
  const toggle = (key: string) => setChosen(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const selectable = (recipient: PushRecipientView) => !recipient.answered && recipient.sendState !== "pending" && recipient.sendState !== "sending";
  return <div ref={box} class="push-detail">
    <Section title={<span class="push-detail-head">{push.subject}<span class="muted mono">{push.id}</span>{stateChip(push)}</span>}
      aside={<button class="btn ghost small-btn" disabled={busy} onClick={() => void reload()}><Icon name="refresh" size={13} class={busy ? "spin" : undefined} />刷新</button>}>
      <div class="group-content">
        <dl class="kv">
          <dt>推送人</dt><dd>{push.pusher}</dd>
          <dt>对象</dt><dd>{push.target.map(line => <div key={line}>{line}</div>)}</dd>
          <dt>要求</dt><dd>{MODE[push.mode]}{push.options.length ? `：${push.options.join(" / ")}` : ""}</dd>
          {push.files.length > 0 && <><dt>附件</dt><dd>{push.files.map(file => `${file.name}（${bytes(file.size)}）`).join("、")}</dd></>}
          <dt>时间</dt><dd>{dateTime(push.createdAt)} 准备{push.confirmedAt ? `，${dateTime(push.confirmedAt)} 发出` : ""}，截止 {dateTime(push.deadline)}{push.defaultDeadline ? "（未指定，默认 3 天）" : ""}
            {push.closedAt ? `，${dateTime(push.closedAt)} ${push.closeReason === "complete" ? "全部答复" : "结束"}` : ""}</dd>
          <dt>答复</dt><dd>共 {reach(push.counts.total, push.counts.groups)}，已送达 {push.counts.delivered}，已答复 {push.counts.answered}{push.counts.failed ? `，发送失败 ${push.counts.failed}` : ""}</dd>
          <dt>汇总</dt><dd>{push.summaryState === "sent" ? `已发出${push.summaryAt ? `（${dateTime(push.summaryAt)}）` : ""}` : push.summaryState === "failed" ? `没有发出：${push.summaryError ?? "原因未知"}`
            : push.summaryState === "pending" ? "待发" : "截止或全部答复后发给推送人和抄送人"}</dd>
          {(push.reminders.sent > 0 || push.reminders.next !== null) && <><dt>提醒</dt><dd>{push.reminders.recipients ? `已自动提醒 ${push.reminders.sent} 次` : "不自动提醒接收人"}
            {push.reminders.next !== null && live(push.state) ? `，下一次进度通知${push.reminders.recipients ? "和提醒" : ""} ${dateTime(push.reminders.next)}` : ""}</dd></>}
          {push.of && <><dt>补推送</dt><dd>推送编号 {push.of} 中没有答复的人</dd></>}
          {push.followUp && <><dt>已补推送</dt><dd>推送编号 {push.followUp}</dd></>}
          <dt>抄送</dt><dd>{cc === null ? <>{push.cc.length ? push.cc.map(person => `${person.name} · ${person.phone}`).join("、") : "无"}
            {canCc && <> <button class="link-btn" disabled={busy} onClick={() => setCc(push.cc.map(person => ({ key: person.key, name: person.name, phone: person.phone })))}>修改</button></>}</>
            : <div class="push-cc">
              {cc.map((person, index) => <span class="chip neutral" key={person.key ?? `new-${person.phone}`}>{person.name || "（保存时核对姓名）"} · {person.phone}
                <button class="chip-remove" aria-label="移除抄送人" disabled={busy} onClick={() => setCc(cc.filter((_, at) => at !== index))}><Icon name="x" size={11} /></button></span>)}
              <div class="action-row">
                <input aria-label="抄送人手机号" inputMode="tel" placeholder="完整手机号" value={ccPhone} disabled={busy || cc.length >= 10} onInput={event => setCcPhone(event.currentTarget.value)} />
                <input aria-label="抄送人姓名" placeholder="姓名（可不填）" value={ccName} disabled={busy || cc.length >= 10} onInput={event => setCcName(event.currentTarget.value)} />
                <button class="btn small-btn" disabled={busy || !ccPhone.trim()} onClick={addCc}>加入</button>
                <button class="btn primary small-btn" disabled={busy} onClick={() => void saveCc()}>保存抄送</button>
                <button class="btn ghost small-btn" disabled={busy} onClick={() => setCc(null)}>不改了</button>
              </div>
            </div>}</dd>
        </dl>
        <details class="push-body-details"><summary><Icon name="chevronRight" size={13} />正文</summary><pre class="push-body">{push.body}</pre></details>
      </div>
      {error && <div class="group-note form-error" role="alert">{error}</div>}
      {notice && <div class="group-note ok-note" role="status"><Icon name="checkmark" size={13} />{notice}</div>}
      <div class="row push-actions">
        <Segmented label="接收人筛选" options={FILTERS} value={filter} onChange={setFilter} size="small" />
        <span class="row-text" />
        {canRemind && <button class="btn small-btn" disabled={busy} onClick={() => void remind()}>{`给没有答复的 ${reach(waiting.length, waitingGroups)}${push.state === "closed" ? "补推送" : "重发卡片"}`}</button>}
        {canRemind && chosen.size > 0 && <button class="btn small-btn" disabled={busy} onClick={() => void remind([...chosen])}>只给选中的 {reach(chosen.size, chosenGroups)}</button>}
        {push.state !== "preview" && push.state !== "cancelled" && push.state !== "expired" && <button class="btn small-btn" disabled={busy} onClick={() => void pack()}><Icon name="download" size={13} />下载汇总包</button>}
        {canDelete && (deleting
          ? <><button class="btn danger small-btn" disabled={busy} onClick={() => void remove()}>确认删除</button><button class="btn ghost small-btn" disabled={busy} onClick={() => setDeleting(false)}>不删除</button></>
          : <button class="btn destructive small-btn" disabled={busy} onClick={() => setDeleting(true)}>删除推送</button>)}
      </div>
      {push.state === "closed" && push.followUp && <div class="group-note">这条推送已经准备过补推送（推送编号 {push.followUp}）；补推送取消或失效后才能再补。</div>}
      {deleting && <div class="group-note form-error" role="alert">删除后推送记录、接收情况和回复都从机器人里删掉，接收人的卡片不再更新；会话里的推送备注保留。</div>}
      <div class="table-wrap"><table class="data-table push-recipients"><thead><tr><th />
        <th>{push.counts.groups ? "姓名或群" : "姓名"}</th><th>手机号</th><th>发送</th><th>{push.mode === "reply" ? "回复" : push.mode === "options" ? "选择" : "确认"}</th><th /></tr></thead>
        <tbody>{shown.map(recipient => <tr key={recipient.key}>
          <td>{canRemind && selectable(recipient) && <input type="checkbox" aria-label={`选择 ${recipient.name}`} checked={chosen.has(recipient.key)} disabled={busy}
            onChange={() => toggle(recipient.key)} />}</td>
          <td>{recipient.name}{recipient.forwardedBy ? <div class="muted">{recipient.forwardedBy} 转来</div> : null}</td>
          <td class="mono">{recipient.phone}</td>
          <td>{SEND[recipient.sendState]}{recipient.sentAt ? <div class="muted">{dateTime(recipient.sentAt)}</div> : null}</td>
          <td class="push-answer">{answerOf(push, recipient)}{recipient.repliedAt ? <div class="muted">{dateTime(recipient.repliedAt)}</div> : null}</td>
          <td>{push.mode === "reply" && recipient.reply && <button class="btn ghost small-btn" disabled={busy} onClick={() => void pack(recipient.key)}>下载</button>}</td>
        </tr>)}</tbody></table></div>
      {!shown.length && <div class="group-note">没有符合筛选的接收人。</div>}
    </Section>
  </div>;
}
