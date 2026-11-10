/** @jsxImportSource preact */
// The first deployment, in the browser. Every step stays on the page: check this host (installing the dependencies the model
// check needs), fill in and check the application bot and the model online, choose the directory scope, the port and the
// shared folder, then preview and confirm. The drafts stay private on this host until the deployment takes them, and the
// deployment checks everything again in its own runtime before it changes anything.
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.ts";
import { ConfigurationForm } from "./configuration.tsx";
import type { ConsoleInfo } from "./contract.ts";
import { DeploymentDirectoryPicker, type DeploymentSelection } from "./deployment-directory.tsx";
import { PathField } from "./files.tsx";
import { Icon } from "./icons.tsx";
import { TaskAction, taskEnded, useFollowed } from "./tasks.tsx";
import { Row, Section, Segmented, Spinner } from "./ui.tsx";

interface DependencyJob { state: "running" | "succeeded" | "failed"; message?: string }
interface Setup { undeployed: boolean; dependencies: { installed: boolean; job: DependencyJob | null } }
interface CheckItem { state: "ok" | "fail"; name: string; detail: string }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** How the console has to be started for a first deployment on each platform (README). */
const STARTED: Record<ConsoleInfo["platform"], string> = {
  windows: "在管理员 PowerShell 中启动控制台。",
  linux: "rootful Docker 用 sudo bun run console 启动控制台；rootless Docker 由它所属的用户启动。",
  macos: "用 sudo bun run console 启动控制台。",
};
const DEPLOYS: Record<ConsoleInfo["platform"], string> = {
  windows: "注册开机启动的计划任务 mixin-bot",
  linux: "构建镜像并创建服务容器 mixin-bot",
  macos: "创建服务账户（尚未创建时）并安装 LaunchDaemon",
};

/** Step 1: the dependencies the model check needs, and the deployment's own read-only check of this host. */
function HostCheck({ platform, onChange }: { platform: ConsoleInfo["platform"]; onChange(value: { checked: boolean; installed: boolean }): void }) {
  const [setup, setSetup] = useState<Setup | null>(null), [items, setItems] = useState<CheckItem[] | null>(null);
  const [checking, setChecking] = useState(false), [error, setError] = useState("");
  const live = useRef(true), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), following = useRef(false);
  const read = async () => {
    try {
      const value = await api<Setup>("/api/setup");
      if (!live.current) return;
      setSetup(value); setError("");
      // An install under way is followed until it ends.
      following.current = value.dependencies.job?.state === "running";
      if (following.current) timer.current = setTimeout(() => void read(), 2000);
    } catch (error) {
      if (!live.current) return;
      setError(message(error));
      // A failed read (a dropped SSH tunnel) does not end the install: keep following it.
      if (following.current) timer.current = setTimeout(() => void read(), 5000);
    }
  };
  useEffect(() => { live.current = true; void read(); return () => { live.current = false; clearTimeout(timer.current); }; }, []);
  const installed = !!setup?.dependencies.installed, job = setup?.dependencies.job, installing = job?.state === "running";
  const checked = !!items && items.every(item => item.state === "ok");
  useEffect(() => { onChange({ checked, installed }); }, [checked, installed]);
  const install = async () => {
    setError(""); setItems(null);
    try { const dependencies = await api<Setup["dependencies"]>("/api/setup/dependencies", { method: "POST", body: {}, intent: true });
      if (live.current) { following.current = dependencies.job?.state === "running"; setSetup(previous => ({ undeployed: previous?.undeployed ?? true, dependencies })); clearTimeout(timer.current); timer.current = setTimeout(() => void read(), 2000); } }
    catch (error) { if (live.current) setError(message(error)); }
  };
  const check = async () => {
    setChecking(true); setError(""); setItems(null);
    try { const value = await api<{ ok: boolean; items: CheckItem[] }>("/api/setup/check", { method: "POST", body: {}, intent: true, timeoutMs: 150_000 });
      if (live.current) setItems(value.items); }
    catch (error) { if (live.current) setError(message(error)); }
    finally { if (live.current) setChecking(false); }
  };
  return <Section title="1. 检查本机环境" footer={STARTED[platform] + "部署开始时会在目标运行环境里再检查一次。"}>
    <Row icon="layers" tint={installed ? "green" : "orange"} title="依赖" detail={!setup ? "正在读取…" : installed ? "node_modules 与 package.json 一致。"
      : installing ? "正在安装依赖（bun install --frozen-lockfile），可能需要几分钟…" : job?.state === "failed" ? job.message ?? "依赖安装失败"
      : "模型校验和模型目录要用依赖里的 Pi。安装以项目目录属主的身份运行。"}>
      {setup && !installed && <button type="button" class="btn" disabled={installing} onClick={() => void install()}>
        {installing ? <><Icon name="loader" size={14} class="spin" />正在安装…</> : job?.state === "failed" ? "重新安装依赖" : "安装依赖"}</button>}
    </Row>
    <Row icon="shield" tint={checked ? "green" : items ? "red" : "blue"} title="部署环境"
      detail={checked ? "全部检查通过。" : items ? "有未通过的检查，处理后重新检查。" : "检查管理员权限、Docker 或服务账户、后台任务和工具，不做任何改动。"}>
      <button type="button" class="btn" disabled={checking || installing} onClick={() => void check()}>
        {checking ? <><Icon name="loader" size={14} class="spin" />正在检查…</> : items ? "重新检查" : "开始检查"}</button>
    </Row>
    {items && items.map(item => <Row key={item.name + item.detail} icon={item.state === "ok" ? "check" : "x"} tint={item.state === "ok" ? "green" : "red"} title={item.name} detail={item.detail} />)}
    {error && <div class="group-note form-error" role="alert">{error}</div>}
  </Section>;
}

/** The first deployment wizard, shown on the maintenance page while this checkout is not deployed (and while its deployment runs). */
export function FirstDeployWizard({ platform, consolePort }: { platform: ConsoleInfo["platform"]; consolePort: number }) {
  const [host, setHost] = useState({ checked: false, installed: false });
  const [app, setApp] = useState<string | null>(null), [models, setModels] = useState<string | null>(null);
  const [scope, setScope] = useState<"" | "all" | "departments">(""), [selection, setSelection] = useState<DeploymentSelection | null>(null);
  const [port, setPort] = useState("10000"), [workspace, setWorkspace] = useState("");
  // A deployment took the drafts: each form lets its draft go. `task` is that deployment, followed until it ends.
  const [round, setRound] = useState(0), [task, setTask] = useState<string | null>(null);
  const { followed } = useFollowed();
  const running = followed.find(item => item.id === task);
  // Only a followed task runs: one closed in the activity tray had ended.
  const busy = !!running && !taskEnded(running.task?.state);
  // Departments are read with the application draft: another draft needs another choice.
  useEffect(() => { setSelection(null); }, [app]);
  const portValid = /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
  const directory = scope === "departments" ? selection : scope || null;
  const missing = [!host.checked && "环境检查未全部通过", !app && "应用机器人凭据未在线校验", !models && "模型配置未校验",
    !directory && "未选择通讯录范围", !portValid ? "端口无效" : Number(port) === consolePort && `端口 ${port} 是控制台正在用的端口`].filter((value): value is string => !!value);
  const started = (accepted: { id: string }) => { setTask(accepted.id); setRound(value => value + 1); };
  return <>
    <Section title="首次部署" footer="确认前不会改动本机；草稿只保存在本机，确认部署后才写入正式配置。">
      <Row icon="server" tint="blue" title="在浏览器中完成首次部署"
        detail="按顺序完成下面几步，最后预览并确认。部署在后台运行，关掉网页不会取消；完成后控制台自动切换到已部署的状态。" />
    </Section>
    <HostCheck platform={platform} onChange={setHost} />
    <ConfigurationForm kind="app" deploy={{ title: "2. 应用机器人凭据", onReady: setApp, round, blocked: busy ? "首次部署正在进行。" : undefined }} />
    <ConfigurationForm kind="models" deploy={{ title: "3. 模型", onReady: setModels, round,
      blocked: busy ? "首次部署正在进行。" : host.installed ? undefined : "先在第 1 步安装依赖：模型校验和模型目录要用它。" }} />
    <Section title="4. 通讯录同步范围">
      <Row title="同步范围" detail="机器人从平台同步哪些部门的成员。之后可在“通讯录”页修改。">
        <Segmented label="通讯录同步范围" size="small" value={scope || "none"} onChange={value => { setScope(value === "none" ? "" : value); setSelection(null); }}
          options={[{ value: "none", label: "未选择" }, { value: "all", label: "整个通讯录" }, { value: "departments", label: "部分部门" }]} />
      </Row>
      {scope === "departments" && <div class="row-body flush-top">{app
        ? <DeploymentDirectoryPicker key={app} draft={app} onChange={setSelection} />
        : <p class="muted small">先完成第 2 步：部门树用在线校验过的应用机器人凭据读取。</p>}</div>}
    </Section>
    <Section title="5. 端口与共享资料">
      <Row title="机器人端口" detail="机器人在本机监听的端口，不能与控制台相同。">
        <input aria-label="机器人端口" type="number" min="1" max="65535" value={port} onInput={event => setPort(event.currentTarget.value)} />
      </Row>
      <Row class="stack" title="共享资料目录" detail="留空使用项目目录下的 workspace/；外置目录必须已经存在。部署不会移动或删除共享资料。">
        <PathField label="共享资料目录" purpose="workspace" value={workspace} onChange={setWorkspace} placeholder="留空使用项目目录下的 workspace/" />
      </Row>
    </Section>
    <Section title="6. 预览并部署">
      <Row icon="play" tint="green" title="首次部署" detail={busy ? "首次部署正在后台运行，进度见任务详情。"
        : missing.length ? `还差：${missing.join("、")}。` : `${DEPLOYS[platform]}，部署完成后启动机器人。预览列出全部步骤，确认后在后台运行。`}>
        <TaskAction operation="install" params={{ app, models, directory, port: Number(port), workspace }} primary disabled={busy || missing.length > 0}
          onStarted={started}>预览首次部署</TaskAction>
      </Row>
      {running && taskEnded(running.task?.state) && running.task?.state !== "succeeded" && <div class="group-note form-error" role="alert">
        首次部署没有完成：{running.task?.result?.message ?? "原因见任务详情"}。表单已放下这次交给部署的草稿，请在第 2、3 步重新填写密钥并校验后再部署。</div>}
      {busy && <div class="row"><Spinner label="正在部署…" /></div>}
    </Section>
  </>;
}
