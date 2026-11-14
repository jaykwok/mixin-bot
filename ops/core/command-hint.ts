// Where a message sends the operator next: the console's page when the console runs the command, else the command for the
// platform's terminal. The shell entries keep the same table for their own messages (ops_command_hint in common.sh,
// Get-OpsCommandHint in common.ps1).
export type OpsPlatform = "linux" | "windows" | "macos";

const PAGES: Record<string, string> = { deploy: "维护 → 重新部署", update: "维护 → 升级", resume: "维护 → 继续上次操作", rollback: "维护 → 回滚上次操作",
  start: "维护 → 启动", stop: "维护 → 停止", restart: "维护 → 重启", repair: "维护 → 修复部署", "doctor --repair": "维护 → 修复部署", "doctor -Repair": "维护 → 修复部署",
  doctor: "体检 → 刷新", status: "总览 → 刷新", logs: "日志", "configure-app-bot": "应用机器人 → 编辑配置", "relay-configure": "外链 → 编辑配置", directory: "通讯录" };

export function commandHint(platform: OpsPlatform, command: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.MIXIN_OPS_UI === "console" && Object.hasOwn(PAGES, command)) return `「${PAGES[command]}」`;
  return platform === "windows" ? `scripts\\ops.ps1 ${command}` : platform === "macos" ? `sudo bash scripts/ops.sh ${command}` : `scripts/ops.sh ${command}`;
}
