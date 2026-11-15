import { nativeService } from "./platform.ts";
import { runMaintenance } from "./maintenance.ts";
import { createMaintenanceHost, maintenanceRequest, type MaintenanceHostOptions } from "./maintenance-host.ts";

export const DOCUMENT_ACTIONS = ["document-check", "document-install", "document-repair"] as const;
export type DocumentAction = typeof DOCUMENT_ACTIONS[number];
export function documentRequest(action: string, args: string[]): DocumentAction {
  if (!(DOCUMENT_ACTIONS as readonly string[]).includes(action) || args.length) throw new Error("文档环境操作不接受额外参数");
  if (action !== "document-check" && !nativeService()) throw new Error("Docker 文档依赖固定在镜像中，请在“维护”中重新部署以重建镜像");
  return action as DocumentAction;
}

export async function runDocuments(action: DocumentAction, options: MaintenanceHostOptions, signal?: AbortSignal, create = createMaintenanceHost) {
  documentRequest(action, []);
  const online = action === "document-check", labels = { "document-check": "检查文档环境", "document-install": "安装文档依赖", "document-repair": "修复文档依赖" };
  const request = maintenanceRequest(options.source, { command: action, intent: "service", label: labels[action], ...(online ? { online: true } : {}) });
  const context = create(options, request), script = "ops/tools/document-environment.ts";
  return runMaintenance(request, context.host, {
    async prepare(signal) {
      await context.prepare();
      if (!online && (await context.data({ script, args: ["preflight"], online: true, currentCode: true, runtimeEnvironment: true, timeoutMs: 60_000 }, signal)).code !== 0)
        throw new Error("文档环境预检失败，机器人未停止；请查看任务日志");
    },
    async run(signal) {
      return (await context.data({ script, args: [online ? "check" : action.slice(9), ...(!nativeService() ? ["--image"] : [])],
        ...(online ? { online: true } : { network: "bridge" as const }), currentCode: true, runtimeEnvironment: true,
        timeoutMs: online ? 5 * 60_000 : 35 * 60_000 }, signal)).code;
    },
  }, signal);
}
