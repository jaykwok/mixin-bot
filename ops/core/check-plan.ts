// Called by the platform wrapper while it holds the deployment lock, before any stop or write.
import { resolve } from "node:path";
import { cliArgs } from "../lib/cli.ts";
import { codeDigest } from "./source-runtime.ts";
import { PlanStore } from "./plans.ts";
import type { ObservePlan } from "./plans.ts";
import { operationObserver } from "./operations.ts";
import { TaskStore } from "./tasks.ts";
import { consoleDir } from "./console-state.ts";
import { assertDeploymentEnvironment } from "./deployment-options.ts";

export async function checkTaskPlan(project: string, task: string, expected: string, observe: ObservePlan = operationObserver(project)): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(expected) || codeDigest(project) !== expected) throw new Error("代码已变化，请重新打开控制台并预览；未执行操作");
  const store = new TaskStore(consoleDir(project)), request = store.request(task);
  if (resolve(request.project) !== resolve(project)) throw new Error("任务所属部署不符");
  assertDeploymentEnvironment(request.operation, request.params, project);
  await new PlanStore(consoleDir(project), observe).verify(request.planId, request);
  if (codeDigest(project) !== expected) throw new Error("复核期间代码变化；未执行操作");
}

/**
 * An uninstall entry, under the lock it holds: a console run must be the confirmed uninstall task, run by the code that
 * planned it, whose plan (the service it binds and the two choices) still holds. A terminal run has no task.
 */
export async function checkUninstallTask(project: string, source: string, env: NodeJS.ProcessEnv, check = checkTaskPlan): Promise<void> {
  if (env.MIXIN_OPS_CONSOLE === "1" && !env.MIXIN_OPS_TASK_ID) throw new Error("控制台任务缺少接单记录，未执行操作");
  if (!env.MIXIN_OPS_TASK_ID) return;
  const expected = env.MIXIN_OPS_EXPECT_CODE ?? "";
  if (codeDigest(source) !== expected) throw new Error("控制台任务执行版本不符，未执行操作");
  if (new TaskStore(consoleDir(project)).request(env.MIXIN_OPS_TASK_ID).operation !== "uninstall") throw new Error("命令与确认的控制台任务不符");
  await check(project, env.MIXIN_OPS_TASK_ID, expected);
}

if (import.meta.main) {
  try {
    const { values, positionals } = cliArgs(process.argv.slice(2), { project: { type: "string" }, task: { type: "string" }, digest: { type: "string" } });
    if (positionals.length || !values.project || !values.task || !values.digest) throw new Error("计划复核参数不完整");
    await checkTaskPlan(resolve(values.project), values.task, values.digest);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
