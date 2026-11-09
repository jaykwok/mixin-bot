/** @jsxImportSource preact */
// 推送页的群名单：机器人在群里被 @ 过的群。推送管理员在群里发“@机器人 /登记群 群名”登记，也可以在这里补群名、登记、改名、
// 停用和重新启用；只有已登记的群能推送，有群授权的推送人按群名推送到群。机器人必须正在运行。
import { useEffect, useState } from "preact/hooks";
import { api } from "./api.ts";
import type { PushChatGroupsResponse, PushChatGroupView } from "./contract.ts";
import { dateTime } from "./format.ts";
import { Icon } from "./icons.tsx";
import { Chip, Section, Skeleton, type Tone } from "./ui.tsx";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const STATE: Record<PushChatGroupView["state"], [string, Tone]> = { registered: ["已登记", "ok"], disabled: ["已停用", "neutral"], seen: ["未登记", "warn"] };

export function PushGroups() {
  const [list, setList] = useState<PushChatGroupsResponse | null>(null), [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const load = (result: PushChatGroupsResponse) => { setList(result); setNames(Object.fromEntries(result.groups.map(group => [group.key, group.name ?? ""]))); };
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(""); setNotice(""); try { await work(); } catch (error) { setError(message(error)); } finally { setBusy(false); } };
  const open = () => run(async () => load(await api<PushChatGroupsResponse>("/api/push/groups", { method: "POST", body: {}, intent: true, timeoutMs: 30_000 })));
  useEffect(() => { void open(); }, []);
  const save = (group: PushChatGroupView, state: "registered" | "disabled", done: string) => run(async () => {
    const typed = (names[group.key] ?? "").trim(), renamed = typed !== "" && typed !== group.name;
    load(await api<PushChatGroupsResponse>("/api/push/group", { method: "POST", intent: true, timeoutMs: 30_000,
      body: { view: list!.view, key: group.key, state, ...(renamed ? { name: typed } : {}) } }));
    setNotice(done);
  });
  return <Section title="群名单" class="push-groups"
    aside={<button type="button" class="btn ghost small-btn" disabled={busy} onClick={() => void open()}><Icon name="refresh" size={13} class={busy ? "spin" : undefined} />{busy ? "正在读取…" : "重新读取"}</button>}
    footer={list?.steps ?? "只有已登记的群能推送：有群授权的推送人按群名推送到群，群里任何人都能确认和回复。"}>
    {error && <div class="group-note form-error" role="alert">{error}</div>}
    {notice && <div class="group-note ok-note" role="status"><Icon name="checkmark" size={13} />{notice}</div>}
    {!list && busy && <Skeleton lines={3} />}
    {list && (!list.groups.length ? <div class="group-note">机器人还没有在群里被 @ 过。</div> : <div class="table-wrap"><table class="data-table"><thead><tr>
      <th>群名</th><th>状态</th><th>最近 @ 机器人</th><th>登记</th><th /></tr></thead>
      <tbody>{list.groups.map(group => {
        const typed = (names[group.key] ?? "").trim(), renamed = typed !== "" && typed !== group.name;
        return <tr key={group.key}>
          <td><input aria-label="群名" maxLength={30} placeholder="填写群名" value={names[group.key] ?? ""} disabled={busy}
            onInput={event => { const value = event.currentTarget.value; setNames(previous => ({ ...previous, [group.key]: value })); }} /></td>
          <td><Chip tone={STATE[group.state][1]}>{STATE[group.state][0]}</Chip></td>
          <td class="muted">{dateTime(group.lastSeenAt)}</td>
          <td class="muted">{group.registeredAt ? `${dateTime(group.registeredAt)}${group.registeredBy ? ` · ${group.registeredBy}` : ""}` : "—"}</td>
          <td><div class="action-row">
            {group.state === "seen" && <button class="btn primary small-btn" disabled={busy || !typed} onClick={() => void save(group, "registered", `已登记为 ${typed}。`)}>登记</button>}
            {group.state !== "seen" && renamed && <button class="btn small-btn" disabled={busy} onClick={() => void save(group, group.state as "registered" | "disabled", `群名已改为 ${typed}。`)}>保存群名</button>}
            {group.state === "registered" && <button class="btn ghost small-btn" disabled={busy} onClick={() => void save(group, "disabled", "已停用：不能再推送到这个群；已发出的推送照常收确认和回复。")}>停用</button>}
            {group.state === "disabled" && <button class="btn small-btn" disabled={busy || !typed} onClick={() => void save(group, "registered", "已重新启用。")}>重新启用</button>}
          </div></td>
        </tr>;
      })}</tbody></table></div>)}
  </Section>;
}
