// Before the first deployment: the host dependencies the console's checks need (Pi, for the model check and catalogue).
// Installed only on request and only while nothing is deployed, as the checkout's owner. A node_modules the console created
// is marked in .console (host-dependencies.ts).
// The environment check runs the deploy entry's own read-only check (deploy.ps1 -Check, deploy.sh check, macOS deploy check)
// from this console's frozen code, plus what only the console knows: task hosting, its Bun and the owner's access to it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { capture } from "./query.ts";
import { dependenciesInstalled } from "../../ops/core/deployment-git.ts";
import { consoleDir, writeAtomic } from "../../ops/core/console-state.ts";
import { hostingCheck, type HostingCheck } from "../../ops/core/hosting.ts";
import { SOURCE_DIR } from "../../ops/core/platform.ts";
import { hostService, type HostService } from "../../ops/core/host-service.ts";
import { redactSecrets } from "../../src/lib/redact.ts";
import { asOperator, checkoutOwner, type Operator } from "./host-operator.ts";
import { CREATED_DEPENDENCIES } from "./host-dependencies.ts";
import { undeployed } from "./recovery.ts";
import type { AuditLog } from "./audit.ts";
import { ApiProblem, type Route } from "./routes.ts";

const INSTALL_MS = 20 * 60_000;
const CHECK_MS = 90_000;

export interface DependencyJob { state: "running" | "succeeded" | "failed"; startedAt: number; finishedAt?: number; message?: string }
/** One line of the environment check. */
export interface SetupCheck { state: "ok" | "fail"; name: string; detail: string }
/** A bot service already on this host (host-service.ts): the first deployment removes it first once the operator agrees. */
export interface Leftover { digest: string; description: string }
export interface SetupHost {
  platform: NodeJS.Platform;
  undeployed(project: string): boolean;
  installed(project: string): boolean;
  operator(project: string): Promise<Operator | null>;
  hosting(): Promise<HostingCheck>;
  service(project: string): Promise<HostService | null>;
}
const localSetup: SetupHost = { platform: process.platform, undeployed, installed: dependenciesInstalled, operator: project => checkoutOwner(project),
  hosting: () => hostingCheck(), service: project => hostService(project) };

function failure(stderr: string, stdout: string): string {
  const line = (stderr.trim() || stdout.trim()).split(/\r?\n/).map(value => value.trim()).filter(Boolean).at(-1) ?? "";
  return line ? `依赖安装失败：${redactSecrets(line).slice(0, 300)}` : "依赖安装失败，请在项目目录运行 bun install --frozen-lockfile 查看原因";
}

/**
 * The deploy entry's check in this console's frozen code, for this project, with what a deployment task gets: this
 * console's Bun (MIXIN_OPS_BUN, as operations.ts; macOS hands over to its TS entry with it) and no BOT_TASK_DOCKER_HOST
 * (the task gets only the Docker variables, task-host.ts, so it uses the default task socket and the check looks at that one).
 */
function entryCheck(platform: NodeJS.Platform, project: string): { command: string; args: string[]; env: Record<string, string> } {
  const env = { MIXIN_OPS_PROJECT: project, MIXIN_OPS_CONSOLE: "1", MIXIN_OPS_BUN: process.execPath, BOT_TASK_DOCKER_HOST: "" };
  if (platform === "win32") return { command: "powershell", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(SOURCE_DIR, "scripts/lib/deploy.ps1"), "-Check"], env };
  return { command: "bash", args: [join(SOURCE_DIR, "scripts/lib/deploy.sh"), "check"], env };
}

/** "ok|fail<TAB>item<TAB>detail" lines; anything else (a refusal before the check began) becomes one failed line. */
export function parseCheckLines(stdout: string, stderr: string, code: number): SetupCheck[] {
  const items = stdout.split(/\r?\n/).flatMap(line => {
    const match = /^(ok|fail)\t([^\t]{1,40})\t([^\t]{0,2000})$/.exec(line);
    return match ? [{ state: match[1] as SetupCheck["state"], name: match[2]!, detail: redactSecrets(match[3]!) }] : [];
  });
  if (code !== 0 && !items.some(item => item.state === "fail")) {
    const last = (stderr.trim() || stdout.trim()).split(/\r?\n/).map(value => value.trim()).filter(Boolean).at(-1);
    items.push({ state: "fail", name: "部署入口", detail: last ? redactSecrets(last).slice(0, 500) : `环境检查没有完成（退出码 ${code}）` });
  }
  return items;
}

function atLeast(version: string, minimum: string): boolean {
  const parts = (text: string) => (/(\d+)\.(\d+)\.(\d+)/.exec(text) ?? []).slice(1).map(Number);
  const [have, need] = [parts(version), parts(minimum)];
  if (have.length !== 3 || need.length !== 3) return false;
  for (let index = 0; index < 3; index++) if (have[index] !== need[index]) return have[index]! > need[index]!;
  return true;
}

export class HostSetup {
  private job: DependencyJob | null = null;
  private starting = false;
  constructor(readonly project: string, readonly audit: Pick<AuditLog, "write">, readonly query = capture, readonly host: SetupHost = localSetup,
    readonly now = Date.now) {}

  dependencies() { return { installed: this.host.installed(this.project), job: this.job }; }

  /** Everything a first deployment needs from this host, read-only; the deployment checks it all again before it starts. */
  async check(signal?: AbortSignal): Promise<{ ok: boolean; items: SetupCheck[]; leftover: Leftover | null }> {
    const items: SetupCheck[] = [];
    const hosting = await this.host.hosting();
    items.push(hosting.ok ? { state: "ok", name: "后台任务", detail: hosting.facts.join("；") || "可以在后台运行部署任务" }
      : { state: "fail", name: "后台任务", detail: hosting.reason });
    let minimum = "";
    try { minimum = String(JSON.parse(readFileSync(join(this.project, "package.json"), "utf8")).engines?.bun ?? ""); } catch { /* reported below */ }
    const bun = process.versions.bun ?? "";
    items.push(minimum && atLeast(bun, minimum) ? { state: "ok", name: "Bun", detail: `控制台的 Bun ${bun}（${process.execPath}）` }
      : { state: "fail", name: "Bun", detail: `控制台的 Bun ${bun || "版本未知"} 不满足 package.json 要求的 ${minimum || "版本"}；请升级 Bun 后重新启动控制台` });
    items.push(this.host.installed(this.project) ? { state: "ok", name: "依赖", detail: "node_modules 与 package.json 一致" }
      : { state: "fail", name: "依赖", detail: "缺少依赖或版本不一致：先安装依赖（bun install --frozen-lockfile），模型校验要用它" });
    const operator = await this.host.operator(this.project);
    if (operator) {
      const run = asOperator(this.host.platform, operator, [process.execPath, "--version"]);
      const result = await this.query(run.command, run.args, { env: run.env, signal, timeout: 30_000 });
      items.push(result.code === 0 && !result.timedOut ? { state: "ok", name: "检出属主", detail: `校验和安装依赖以 ${operator.env.USER ?? `UID ${operator.uid}`} 的身份运行` }
        : { state: "fail", name: "检出属主", detail: `项目目录的属主（UID ${operator.uid}）无法运行 ${process.execPath}：请把 Bun 安装在属主可以执行的位置（例如 /usr/local/bin），或由属主自己启动控制台${this.host.platform === "linux" ? "；还需要 util-linux 的 setpriv" : ""}` });
    }
    // Read beside the entry's check (each is a process of its own, slow to start on Windows); settled, so neither waits on the other's failure.
    const service = this.host.service(this.project).then(found => ({ found }), (error: unknown) => ({ error }));
    const entry = entryCheck(this.host.platform, this.project);
    const result = await this.query(entry.command, entry.args, { env: entry.env, signal, timeout: CHECK_MS });
    items.push(...result.timedOut ? [{ state: "fail" as const, name: "部署入口", detail: "环境检查超时，请稍后重试" }] : parseCheckLines(result.stdout, result.stderr, result.code));
    // Not a failure: the deployment removes it first once the operator agrees (the plan then binds exactly this one).
    let leftover: Leftover | null = null;
    try {
      const read = await service;
      if ("error" in read) throw read.error;
      const found = read.found;
      if (found) {
        leftover = { digest: found.digest, description: found.description };
        items.push({ state: "ok", name: "已有服务", detail: `本机已有${found.description}。一台机器只运行一个部署：可以选择在部署前移除它（包括开机启动），那个目录的文件不删除` });
      }
    } catch (error) {
      items.push({ state: "fail", name: "已有服务", detail: `无法核对本机已有的机器人服务：${error instanceof Error ? redactSecrets(error.message).slice(0, 300) : "原因未知"}` });
    }
    return { ok: items.every(item => item.state === "ok"), items, leftover };
  }

  /** Starts `bun install --frozen-lockfile`; the page polls dependencies() for the outcome. */
  async install(session: string) {
    if (!this.host.undeployed(this.project)) throw new Error("已有部署：依赖随部署和升级维护，控制台不另行安装");
    if (this.job?.state === "running" || this.starting) throw new Error("依赖正在安装，请稍候");
    if (this.host.installed(this.project)) throw new Error("依赖已经安装");
    // Claimed before the await: a second request (a double click, another tab) must not start a second install.
    this.starting = true;
    let operator: Operator | null;
    try { operator = await this.host.operator(this.project); } finally { this.starting = false; }
    this.audit.write({ action: "setup-dependencies", session, scope: "node_modules", mode: "default" });
    // Marked before the install starts: a partial node_modules left by a failed one is the console's too.
    if (!existsSync(join(this.project, "node_modules"))) writeAtomic(join(consoleDir(this.project), CREATED_DEPENDENCIES), JSON.stringify({ format: 1, createdAt: this.now() }) + "\n");
    const job: DependencyJob = this.job = { state: "running", startedAt: this.now() };
    const run = asOperator(this.host.platform, operator, [process.execPath, "install", "--frozen-lockfile", "--cwd", this.project]);
    void this.query(run.command, run.args, { env: run.env, timeout: INSTALL_MS }).then(result => {
      if (result.timedOut) Object.assign(job, { state: "failed", message: "依赖安装超时（20 分钟），请检查网络后重试" });
      else if (result.code !== 0) Object.assign(job, { state: "failed", message: failure(result.stderr, result.stdout) });
      else if (!this.host.installed(this.project)) Object.assign(job, { state: "failed", message: "安装结束，但依赖与 package.json 不一致；请重试" });
      else job.state = "succeeded";
    }, (error: unknown) => {
      Object.assign(job, { state: "failed", message: `依赖安装未完成：${error instanceof Error ? error.message : String(error)}` });
    }).finally(() => { job.finishedAt = this.now(); });
    return this.dependencies();
  }

  routes(): Record<string, Route> {
    // The console's own refusals are plain Errors; an unavailable audit or a system fault keeps its own mapping.
    const problem = (error: unknown) => error instanceof Error && error.constructor === Error ? new ApiProblem(409, "input", error.message) : error;
    const empty = (body: unknown) => { if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) throw new Error("请求参数无效"); };
    return {
      "GET /api/setup": { run: async () => {
        try { return { undeployed: this.host.undeployed(this.project), dependencies: this.dependencies() }; } catch (error) { throw problem(error); }
      } },
      "POST /api/setup/check": { slow: true, run: async ({ body, signal }) => {
        try {
          empty(body);
          if (!this.host.undeployed(this.project)) throw new Error("已有部署：环境检查只用于首次部署");
          return await this.check(signal);
        } catch (error) { throw problem(error); }
      } },
      "POST /api/setup/dependencies": { run: async ({ body, session }) => {
        try { empty(body); return await this.install(session.label); } catch (error) { throw problem(error); }
      } },
    };
  }
}
