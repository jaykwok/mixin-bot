// Console sections. Items with a `stage` are planned and shown disabled until that stage ships. `tint` colours the
// item's icon tile, as the system settings colour theirs.
import type { IconName } from "./icons.tsx";

export type Tint = "blue" | "green" | "orange" | "pink" | "gray" | "cyan" | "indigo" | "graphite" | "mint" | "red" | "purple" | "yellow";

export interface NavItem { id: string; label: string; icon: IconName; tint: Tint; group: string; description: string; stage?: string }

export const NAV: NavItem[] = [
  { id: "overview", label: "总览", icon: "dashboard", tint: "blue", group: "", description: "部署身份、机器人状态与版本" },
  { id: "conversations", label: "会话", icon: "messages", tint: "green", group: "洞察", description: "单聊与群聊记录、工具调用和交付状态" },
  { id: "stats", label: "统计", icon: "chart", tint: "orange", group: "洞察", description: "提问量、成员排行、趋势与导出" },
  { id: "health", label: "体检", icon: "heartPulse", tint: "pink", group: "监控", description: "运行环境与依赖检查" },
  { id: "logs", label: "日志", icon: "logs", tint: "gray", group: "监控", description: "日志搜索与按任务导出" },
  { id: "storage", label: "临时文件", icon: "folder", tint: "cyan", group: "数据", description: "临时文件、归档与回收" },
  { id: "relay", label: "外链", icon: "link", tint: "indigo", group: "数据", description: "外链存储与测试" },
  { id: "maintain", label: "维护", icon: "wrench", tint: "graphite", group: "系统", description: "启停、更新、重新部署与后台任务" },
  { id: "directory", label: "通讯录", icon: "users", tint: "mint", group: "系统", description: "同步状态与部门范围" },
  { id: "push", label: "推送", icon: "send", tint: "red", group: "系统", description: "推送记录、补推送与推送设置" },
  { id: "settings", label: "设置", icon: "gear", tint: "gray", group: "系统", description: "模型、机器人凭据与运行参数" },
];

export const available = (item: NavItem) => item.stage === undefined;

export function routeFromHash(hash: string): string {
  const id = hash.replace(/^#\/?/, "");
  return NAV.some(item => item.id === id && available(item)) ? id : "overview";
}
