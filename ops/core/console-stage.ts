// A console first deployment's configuration: the two checked drafts the task was confirmed with (MIXIN_OPS_APP_DRAFT and
// MIXIN_OPS_MODELS_DRAFT, "<draft>:<digest>"), bound to this task, written into the deploy stage in the format the terminal
// wizards stage (configuration-stage.ts). The core compares the staged files with the task's drafts again under its lock.
// Run by the deploy entries on the host with the console's Bun; built-in modules only (Linux hosts have no node_modules).
// 用法：console-stage.ts --project <目录> --stage <暂存目录>
import { closeSync, fchownSync, openSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cliArgs } from "../lib/cli.ts";
import { ConfigurationDrafts } from "./configuration-drafts.ts";
import { parseConfigurationStage, serializeConfigurationStage, stageName } from "../config/configuration-stage.ts";

const REFERENCE = /^(config-[a-f0-9]{32}):([a-f0-9]{64})$/;

/**
 * Writes configuration-app.json and configuration-models.json into `stage`; returns their paths. Refuses anything not confirmed.
 * `owner`: whom the files belong to (macOS, the service account whose stage this is), set through the new file's descriptor:
 * the stage is the account's, so a path could already name something else by the time a chown by path ran.
 */
export function stageConsoleConfiguration(project: string, stage: string, env: NodeJS.ProcessEnv = process.env, owner?: { uid: number; gid: number }): string[] {
  const task = env.MIXIN_OPS_TASK_ID ?? "";
  if (env.MIXIN_OPS_CONSOLE !== "1" || env.MIXIN_OPS_LIFECYCLE !== "install" || !/^task-[a-f0-9]{32}$/.test(task)) throw new Error("只有控制台的首次部署任务使用网页配置草稿");
  const drafts = new ConfigurationDrafts(project), written: string[] = [];
  for (const [kind, reference] of [["app", env.MIXIN_OPS_APP_DRAFT], ["models", env.MIXIN_OPS_MODELS_DRAFT]] as const) {
    const match = REFERENCE.exec(reference ?? "");
    if (!match) throw new Error("首次部署缺少已确认的配置草稿");
    const [, id, digest] = match as unknown as [string, string, string];
    if (drafts.task(id) !== task) throw new Error("配置草稿不属于这个任务，请重新预览");
    const draft = drafts.deploymentDraft(id, kind, digest), text = serializeConfigurationStage({ version: 1, base: draft.base, next: draft.next });
    parseConfigurationStage(text, kind);
    const path = join(stage, stageName(kind));
    // Exclusive create: never an existing file or a link the stage's owner left there.
    const fd = openSync(path, "wx", 0o600);
    try {
      if (owner) fchownSync(fd, owner.uid, owner.gid);
      writeFileSync(fd, text);
    } finally { closeSync(fd); }
    written.push(path);
  }
  return written;
}

if (import.meta.main) {
  try {
    const { values, positionals } = cliArgs(process.argv.slice(2), { project: { type: "string" }, stage: { type: "string" } });
    if (positionals.length || !values.project || !values.stage) throw new Error("用法：console-stage.ts --project <目录> --stage <暂存目录>");
    stageConsoleConfiguration(resolve(values.project), resolve(values.stage));
    console.log("已暂存网页确认的应用机器人与模型配置（停止服务后写入）");
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
