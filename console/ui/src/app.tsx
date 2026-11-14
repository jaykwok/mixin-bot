/** @jsxImportSource preact */
// Login gate and the console shell (sidebar, top bar, command palette, the task sheet and the activity tray). When the
// session ends or the console goes away, the shell unmounts so no page content stays on screen.
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { ActivityTray, TaskSheet } from "./activity.tsx";
import { api, ApiFailure, type CallOptions, loginGeneration, newLoginGeneration, onConnectionLost } from "./api.ts";
import { adoptServerTime, serverTime } from "./clock.ts";
import type { Overview, SessionResponse, SessionView } from "./contract.ts";
import { duration, platformName } from "./format.ts";
import { BrandMark, Icon, type IconName } from "./icons.tsx";
import { NAV, routeFromHash, type NavItem } from "./nav.ts";
import { ConversationsPage } from "./conversations.tsx";
import { resetExports } from "./exports.tsx";
import { OverviewPage, StatusPill } from "./overview.tsx";
import { CommandPalette, type Command } from "./palette.tsx";
import { takeLoginToken } from "./login.ts";
import { StatsWorkspace } from "./stats.tsx";
import { PushPage } from "./push.tsx";
import { ReadOnlyPage } from "./read-pages.tsx";
import { TasksPage, resetTasks, taskEnded, useFollowed } from "./tasks.tsx";
import { FirstDeployWizard } from "./first-deploy.tsx";
import { TooltipLayer } from "./tooltip.tsx";
import { DirectoryForm, StorageActions } from "./write-forms.tsx";
import { SettingsPage } from "./configuration.tsx";
import { applyTheme, nextTheme, storedTheme, themeLabel, type Theme } from "./theme.ts";
import { Banner, EmptyState, Row, Section, Tile } from "./ui.tsx";

const OVERVIEW_POLL_MS = 15_000;
const SESSION_POLL_MS = 60_000;
/** User activity renews the idle timer at most this often. */
const TOUCH_INTERVAL_MS = 60_000;
/** Pages of tables and conversations use the full width; settings-like pages read best narrower. */
const WIDE = new Set(["conversations", "stats", "push", "logs"]);
const NARROW = new Set(["maintain", "settings", "models", "bot", "materials", "directory", "storage", "relay", "health"]);

/** Tasks after which the overview is read at once rather than at the next poll. */
const LIFECYCLE = new Set(["install", "uninstall", "deploy", "repair", "update", "resume", "rollback"]);

/** A logout that gets no answer within this time is reported as unconfirmed (a half-open SSH tunnel may never answer). */
const LOGOUT_TIMEOUT_MS = 10_000;

type Gate = "checking" | "exchanging" | "ready" | "login" | "exchange-failed" | "expired" | "offline"
  | "logging-out" | "logged-out" | "logout-unconfirmed" | "error";

const failureOf = (error: unknown) => error instanceof ApiFailure ? error : new ApiFailure(String(error), 0);

export function Root({ loginToken }: { loginToken: string | null }) {
  const [gate, setGate] = useState<Gate>(loginToken ? "exchanging" : "checking");
  const [session, setSession] = useState<SessionView | null>(null);
  const [message, setMessage] = useState("");
  // Every login check, exchange and logout takes a new number; an answer that arrives after a newer one started is
  // dropped, so a slow old exchange cannot overwrite the result of a link opened later. The shown page's requests are
  // tied to it the same way (newLoginGeneration): a late failure of an earlier page cannot end a newer login.
  const attempt = useRef(0);
  const shown = useRef(gate);
  shown.current = gate;

  const begin = (next: Gate) => {
    newLoginGeneration();
    setSession(null);
    setMessage("");
    setGate(next);
    return ++attempt.current;
  };
  const settle = (id: number, next: Gate, text = "") => {
    if (id !== attempt.current) return;
    setMessage(text);
    setGate(next);
  };

  const enter = async (token: string | null) => {
    const id = begin(token === null ? "checking" : "exchanging"), sentAt = Date.now();
    try {
      const result = token === null
        ? await api<SessionResponse>("/api/session", { quiet: true })
        : await api<SessionResponse>("/api/session/exchange", { method: "POST", body: { token }, quiet: true });
      if (id !== attempt.current) return;
      adoptServerTime(result.now, sentAt, { login: true }); setSession(result.session);
      setGate("ready");
    } catch (error) {
      const failure = failureOf(error);
      settle(id, failure.status === 401 ? (token === null ? "login" : "exchange-failed") : failure.code === "offline" ? "offline" : "error",
        failure.message);
    }
  };

  // The content leaves the screen at once, but "logged out" is claimed only when the console confirms the session is
  // gone: otherwise the cookie may still be valid and a reload would walk straight back in.
  const logout = async () => {
    const id = begin("logging-out");
    try {
      await api("/api/session/logout", { method: "POST", intent: true, quiet: true, timeoutMs: LOGOUT_TIMEOUT_MS });
      settle(id, "logged-out");
    } catch (error) {
      const failure = failureOf(error);
      // 401: the console no longer knows this session (expired, already revoked, or a restarted console).
      settle(id, failure.status === 401 ? "logged-out" : "logout-unconfirmed", failure.message);
    }
  };

  useEffect(() => {
    // Only a visible shell can lose its session. Requests of an earlier shell no longer report here at all (api.ts).
    onConnectionLost(reason => { if (shown.current === "ready") begin(reason === "session" ? "expired" : "offline"); });
    // A login link opened in this tab after it loaded is a same-document navigation: only hashchange reports it.
    const onHash = () => {
      const token = takeLoginToken();
      if (token !== null) void enter(token);
    };
    window.addEventListener("hashchange", onHash);
    void enter(loginToken);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (gate === "ready" && session) return <Shell initial={session} onEnd={next => void begin(next)} onLogout={() => void logout()} />;
  return <GateScreen gate={gate} message={message} onRetryLogout={() => void logout()} onReconnect={() => void enter(null)} />;
}

function GateScreen({ gate, message, onRetryLogout, onReconnect }: { gate: Gate; message: string; onRetryLogout: () => void; onReconnect: () => void }) {
  const screens: Record<Exclude<Gate, "ready">, { icon: IconName; title: string; body: ComponentChildren; tone?: string }> = {
    checking: { icon: "loader", title: "正在连接控制台", body: "请稍候…" },
    exchanging: { icon: "loader", title: "正在登录", body: "正在验证一次性登录链接…" },
    login: { icon: "lock", title: "需要登录", body: <>在运行 <code>bun run console</code> 的终端复制登录链接打开。链接 5 分钟内有效，只能使用一次；在终端按 <kbd>Enter</kbd> 可生成新链接。</> },
    "exchange-failed": { icon: "lock", title: "登录链接不可用", tone: "warn", body: <>{message || "登录链接无效、已使用或已过期。"}<br />在运行控制台的终端按 <kbd>Enter</kbd> 获取新链接。</> },
    expired: { icon: "clock", title: "登录已失效", tone: "warn", body: <>为保护会话内容，闲置 30 分钟或登录满 8 小时后需要重新登录。在运行控制台的终端按 <kbd>Enter</kbd> 获取新链接。</> },
    offline: { icon: "wifiOff", title: "无法连接控制台", tone: "danger", body: <>网络中断、SSH 端口转发断开，或控制台已经退出。恢复后点“重新连接”，登录仍有效时直接回到页面；控制台已退出时，重新运行 <code>bun run console</code> 并使用新的登录链接。</> },
    "logging-out": { icon: "loader", title: "正在退出", body: "正在请控制台撤销这次登录…" },
    "logged-out": { icon: "logout", title: "已退出登录", body: <>要再次进入，在运行控制台的终端按 <kbd>Enter</kbd> 获取新链接。</> },
    "logout-unconfirmed": { icon: "alert", title: "无法确认已退出", tone: "warn", body: <>{message ? `${message}。` : ""}控制台没有确认撤销这次登录，它可能仍然有效。恢复连接后点"重试退出"；也可以在运行控制台的终端按 <kbd>Ctrl+C</kbd> 关闭控制台，所有登录随即失效。</> },
    error: { icon: "alert", title: "控制台出错", tone: "danger", body: message || "请查看运行控制台的终端。" },
  };
  const screen = screens[gate as Exclude<Gate, "ready">];
  const busy = gate === "checking" || gate === "exchanging" || gate === "logging-out";
  return (
    <div class="gate">
      <div class="gate-card" role={busy ? "status" : "alert"}>
        <div class="gate-brand"><BrandMark size={32} /><span>量子密信应用机器人控制台</span></div>
        <div class={`gate-icon ${screen.tone ?? ""}`}><Icon name={screen.icon} size={22} class={busy ? "spin" : undefined} /></div>
        <h1>{screen.title}</h1>
        <p>{screen.body}</p>
        {gate === "logout-unconfirmed" && <div class="gate-actions"><button class="btn primary" onClick={onRetryLogout}>重试退出</button></div>}
        {gate === "offline" && <div class="gate-actions"><button class="btn primary" onClick={onReconnect}>重新连接</button></div>}
      </div>
      <p class="gate-foot"><Icon name="shield" size={14} />仅监听 127.0.0.1 · 登录链接一次有效 · 不保存聊天内容</p>
    </div>
  );
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function Shell({ initial, onEnd, onLogout }: { initial: SessionView; onEnd: (gate: Gate) => void; onLogout: () => void }) {
  const [session, setSession] = useState(initial);
  const [route, setRoute] = useState(() => routeFromHash(location.hash));
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [palette, setPalette] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [resultsOnly, setResultsOnly] = useState(false);
  const [runtimeChecked, setRuntimeChecked] = useState(false);
  /** Bumped when a directory scope save has ended, so the directory page reads its status again. */
  const [directorySettled, setDirectorySettled] = useState(0);
  const replaced = useRef(false);
  const lastTouch = useRef(Date.now());
  const now = useNow(1_000);

  const serverNow = serverTime(now);
  const idleLeft = session.idleExpiresAt - serverNow;
  const absoluteLeft = session.expiresAt - serverNow;

  /**
   * Asks for the session state and takes the answer's clock and session, unless a login check, login or logout began
   * after it was sent: that answer belongs to an earlier login, and the clock is shared by every page of this tab.
   */
  const refreshSession = useCallback((path: string, options: CallOptions = {}) => {
    const sentIn = loginGeneration(), sentAt = Date.now();
    api<SessionResponse>(path, options).then(response => {
      if (sentIn !== loginGeneration()) return;
      adoptServerTime(response.now, sentAt); setSession(response.session);
    }, () => {});
  }, []);

  const loadOverview = useCallback(async (intent: boolean) => {
    if (intent) setRefreshing(true);
    try {
      if (replaced.current) return;
      const runtime = await api<{ current: boolean }>("/api/runtime");
      if (runtime.current === false) {
        replaced.current = true; setResultsOnly(true); setOverview(null); resetExports(); return;
      }
      setRuntimeChecked(true);
      setOverview(await api<Overview>("/api/overview", { intent }));
      setOverviewError(null);
      if (intent) lastTouch.current = Date.now();
    } catch (error) {
      if (error instanceof ApiFailure && (error.status === 401 || error.code === "offline")) return;
      if (error instanceof ApiFailure && error.code === "version-changed") {
        replaced.current = true; setResultsOnly(true); setOverview(null); resetExports(); return;
      }
      setOverviewError((error as Error).message);
    } finally {
      if (intent) setRefreshing(false);
    }
  }, []);

  // Background polls: overview and session state; neither renews the idle timer.
  useEffect(() => {
    void loadOverview(false);
    const overviewTimer = setInterval(() => void loadOverview(false), OVERVIEW_POLL_MS);
    const sessionTimer = setInterval(() => refreshSession("/api/session"), SESSION_POLL_MS);
    // Leaving the shell (logout, expiry, a lost console) forgets the exports it was following.
    return () => { clearInterval(overviewTimer); clearInterval(sessionTimer); resetExports(); resetTasks(); };
  }, []);

  // A lifecycle task confirmed in this tab has ended: what is deployed may have changed (a first deployment, an uninstall).
  const { followed } = useFollowed(), settled = useRef(new Set<string>());
  // A first deployment this tab follows keeps its wizard until it ends: the transaction it publishes makes the checkout
  // count as deployed while it still runs, and a rollback makes it undeployed again (the wizard keeps what was filled in).
  const installing = followed.some(item => item.operation === "install" && !taskEnded(item.task?.state));
  useEffect(() => {
    const ended = followed.filter(item => LIFECYCLE.has(item.operation) && taskEnded(item.task?.state) && !settled.current.has(item.id));
    for (const item of ended) settled.current.add(item.id);
    if (ended.length) void loadOverview(false);
  }, [followed]);

  // The session ends on the client clock too, so content disappears even if a poll never comes back.
  useEffect(() => { if (idleLeft <= 0 || absoluteLeft <= 0) onEnd("expired"); }, [idleLeft <= 0, absoluteLeft <= 0]);

  // Real user activity (keys, clicks, scrolling) renews the idle timer, throttled.
  useEffect(() => {
    const touch = () => {
      if (Date.now() - lastTouch.current < TOUCH_INTERVAL_MS) return;
      lastTouch.current = Date.now();
      refreshSession("/api/session/touch", { method: "POST", intent: true });
    };
    const events = ["pointerdown", "keydown", "wheel"] as const;
    for (const name of events) window.addEventListener(name, touch, { passive: true });
    return () => { for (const name of events) window.removeEventListener(name, touch); };
  }, []);

  useEffect(() => {
    const onHash = () => { setRoute(routeFromHash(location.hash)); setDrawer(false); };
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setPalette(open => !open); }
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("hashchange", onHash); window.removeEventListener("keydown", onKey); };
  }, []);

  // A new page starts at its top, before it is painted.
  useLayoutEffect(() => { window.scrollTo(0, 0); }, [route]);

  const changeTheme = (value: Theme) => { applyTheme(value); setTheme(value); };

  const commands = useMemo<Command[]>(() => [
    ...NAV.filter(item => !resultsOnly || item.id === "maintain").map(item => ({ id: `go-${item.id}`, label: `前往${item.label}`, hint: item.description, icon: item.icon,
      tint: item.tint, keywords: item.id, run: () => { location.hash = `#/${item.id}`; } })),
    { id: "refresh", label: "刷新数据", icon: "refresh", keywords: "reload refresh", run: () => void loadOverview(true) },
    ...(["system", "light", "dark"] as const).filter(value => value !== theme).map(value => ({
      id: `theme-${value}`, label: `外观：${themeLabel[value]}`, icon: (value === "dark" ? "moon" : value === "light" ? "sun" : "monitor") as IconName,
      keywords: "theme dark light 主题 深色 浅色", run: () => changeTheme(value) })),
    { id: "logout", label: "退出登录", icon: "logout", keywords: "logout sign out", run: onLogout },
  ], [theme, resultsOnly]);

  const current = NAV.find(item => item.id === route)!;
  const themeIcon: IconName = theme === "dark" ? "moon" : theme === "light" ? "sun" : "monitor";
  const width = resultsOnly || NARROW.has(route) ? " narrow" : WIDE.has(route) ? " wide" : "";

  return (
    <div class={`layout${drawer ? " drawer-open" : ""}`}>
      <Sidebar route={resultsOnly ? "maintain" : route} overview={overview} resultsOnly={resultsOnly} onSearch={() => setPalette(true)} onClose={() => setDrawer(false)} />
      <div class="scrim" onClick={() => setDrawer(false)} />
      <div class="main">
        <header class="topbar">
          <button class="btn ghost icon-btn menu-btn" aria-label="打开导航" onClick={() => setDrawer(true)}><Icon name="menu" /></button>
          <nav class="crumbs" aria-label="位置">
            <span class="crumb-host">{overview?.console.hostname ?? "控制台"}</span>
            <Icon name="chevronRight" size={12} />
            <span class="crumb-page">{resultsOnly ? "任务结果" : current.label}</span>
          </nav>
          <div class="topbar-right">
            {resultsOnly ? <span class="pill neutral" data-tip="代码已变化，控制台不再读取部署"><span class="dot" />只看任务结果</span>
              : <StatusPill service={overview?.service} undeployed={overview?.undeployed} loading={!overview} />}
            <span class={`session-chip${idleLeft < 5 * 60_000 ? " warn" : ""}`} data-tip={`闲置 ${duration(idleLeft)}后失效；登录 ${duration(absoluteLeft)}后到期`}>
              <Icon name="clock" size={14} />{duration(Math.min(idleLeft, absoluteLeft))}
            </span>
            <button class="btn ghost icon-btn" aria-label={`外观：${themeLabel[theme]}，点击切换`} data-tip={`外观：${themeLabel[theme]}`}
              onClick={() => changeTheme(nextTheme(theme))}><Icon name={themeIcon} /></button>
            <button class="btn ghost icon-btn" aria-label="退出登录" data-tip="退出登录" onClick={onLogout}><Icon name="logout" /></button>
          </div>
        </header>
        <main class={`content${width}`} id="content">
          {resultsOnly ? <div class="view">
            <Banner tone="warn" icon="alert" title="代码已变化">
              当前控制台只能查看任务结果。请退出当前控制台并重新运行 <code>bun run console</code>，再使用终端里的新链接登录。
            </Banner>
            <TasksPage resultsOnly />
          </div> : !runtimeChecked ? (overviewError
            ? <EmptyState icon="alert" tone="danger" title="无法确认控制台版本" action={<button class="btn" onClick={() => void loadOverview(true)}>重试</button>}>{overviewError}</EmptyState>
            : <EmptyState icon="loader" title="正在检查控制台版本…" />) : (
            // Keyed by page: each page enters with its own animation.
            <div class="view" key={route}>
              {route === "overview" && <OverviewPage data={overview} error={overviewError} refreshing={refreshing}
                onRefresh={() => void loadOverview(true)} sessionLeft={Math.min(idleLeft, absoluteLeft)} />}
              {route === "conversations" && <ConversationsPage />}
              {route === "stats" && <StatsWorkspace />}
              {route === "maintain" && <TasksPage platform={overview?.console.platform}
                setup={!overview ? <Section title="首次部署"><Row icon={overviewError ? "alert" : "loader"} tint={overviewError ? "red" : "blue"}
                    title={overviewError ? "无法读取部署状态" : "正在读取部署状态…"} detail={overviewError ?? "读到之后显示首次部署向导或已有部署的操作。"} /></Section>
                  : overview.undeployed || installing ? <FirstDeployWizard platform={overview.console.platform} consolePort={overview.console.port} /> : undefined} />}
              {route === "health" && <ReadOnlyPage page="health" />}
              {route === "logs" && <ReadOnlyPage page="logs" />}
              {route === "storage" && <ReadOnlyPage page="storage"><StorageActions /></ReadOnlyPage>}
              {route === "relay" && <SettingsPage page="relay" />}
              {route === "directory" && <ReadOnlyPage page="directory" refresh={directorySettled}>
                <DirectoryForm onSettled={() => { setDirectorySettled(count => count + 1); void loadOverview(false); }} />
              </ReadOnlyPage>}
              {route === "push" && <PushPage />}
              {route === "settings" && <SettingsPage />}
              {route === "models" && <SettingsPage page="models" />}
              {route === "bot" && <SettingsPage page="bot" />}
              {route === "materials" && <SettingsPage page="materials" />}
            </div>
          )}
        </main>
      </div>
      {!resultsOnly && <><TaskSheet /><ActivityTray /></>}
      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
      <TooltipLayer />
    </div>
  );
}

function Sidebar({ route, overview, resultsOnly = false, onSearch, onClose }: { route: string; overview: Overview | null; resultsOnly?: boolean; onSearch: () => void; onClose: () => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, NavItem[]>();
    for (const item of NAV) map.set(item.group, [...map.get(item.group) ?? [], item]);
    return [...map];
  }, []);
  const deployment = overview?.deployment;
  return (
    <aside class="sidebar" aria-label="导航">
      <div class="brand">
        <BrandMark />
        <div class="brand-text"><div class="brand-name">量子密信应用机器人</div><div class="brand-sub">管理控制台</div></div>
        <button class="btn ghost icon-btn drawer-close" aria-label="关闭导航" onClick={onClose}><Icon name="x" /></button>
      </div>
      <button class="search-trigger" onClick={onSearch}>
        <Icon name="search" /><span>搜索或跳转…</span><kbd>Ctrl K</kbd>
      </button>
      <nav class="nav">
        {groups.map(([group, items]) => {
          const shown = items.filter(item => !resultsOnly || item.id === "maintain");
          if (!shown.length) return null;
          return (
            <div class="nav-group" key={group || "top"}>
              {group && <div class="nav-group-label">{group}</div>}
              {shown.map(item => (
                <a key={item.id} class="nav-item" href={`#/${item.id}`} aria-current={route === item.id ? "page" : undefined}>
                  <Tile icon={item.icon} tint={item.tint} /><span>{item.label}</span>
                </a>
              ))}
            </div>
          );
        })}
      </nav>
      <div class="sidebar-footer">
        <div class="host-card">
          <Tile icon="server" tint="graphite" />
          <div class="host-text">
            <div class="host-name">{overview?.console.hostname ?? "—"}</div>
            <div class="host-sub">{resultsOnly ? "代码已变化，不再读取部署" : overview?.undeployed ? "尚未部署" : deployment ?`${platformName(deployment.platform)} · ${deployment.mode}` : "读取部署中…"}</div>
          </div>
        </div>
        {!resultsOnly && <div class="version-line">控制台 v{overview?.console.version ?? "—"}</div>}
      </div>
    </aside>
  );
}
