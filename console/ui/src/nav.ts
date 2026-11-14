// Console sections. `tint` colours the item's icon tile, as the system settings colour theirs.
import type { IconName } from "./icons.tsx";

export type Tint = "blue" | "green" | "orange" | "pink" | "gray" | "cyan" | "indigo" | "graphite" | "mint" | "red" | "purple" | "yellow";

export interface NavItem { id: string; label: string; icon: IconName; tint: Tint; group: string; description: string }

export const NAV: NavItem[] = [
  { id: "overview", label: "总览", icon: "dashboard", tint: "blue", group: "", description: "部署身份、机器人状态与版本" },
  { id: "conversations", label: "会话", icon: "messages", tint: "green", group: "使用与成员", description: "会话记录、压缩与清空、工具调用和交付状态" },
  { id: "stats", label: "统计", icon: "chart", tint: "orange", group: "使用与成员", description: "统计概览、导入与导出" },
  { id: "push", label: "推送", icon: "send", tint: "red", group: "使用与成员", description: "推送记录、补推送与推送设置" },
  { id: "directory", label: "通讯录", icon: "users", tint: "mint", group: "使用与成员", description: "同步状态与部门范围设置" },
  { id: "models", label: "模型", icon: "sparkles", tint: "purple", group: "服务配置", description: "服务商、模型、推理级别与 MCP" },
  { id: "bot", label: "应用机器人", icon: "bot", tint: "blue", group: "服务配置", description: "应用凭据与平台环境" },
  { id: "settings", label: "运行参数", icon: "gear", tint: "gray", group: "服务配置", description: "并发、超时、收到提示与模型缓存" },
  { id: "materials", label: "资料与文档", icon: "folder", tint: "mint", group: "文件与存储", description: "资料索引、排除目录、文档环境与默认模板" },
  { id: "relay", label: "外链", icon: "link", tint: "indigo", group: "文件与存储", description: "外链配置、文件、测试与清理" },
  { id: "storage", label: "临时文件", icon: "folder", tint: "cyan", group: "文件与存储", description: "临时文件、归档与回收" },
  { id: "maintain", label: "维护", icon: "wrench", tint: "graphite", group: "系统维护", description: "启停、版本更新、部署、备份与后台任务" },
  { id: "health", label: "体检", icon: "heartPulse", tint: "pink", group: "系统维护", description: "运行环境与依赖检查" },
  { id: "logs", label: "日志", icon: "logs", tint: "gray", group: "系统维护", description: "日志搜索与按任务导出" },
];

export function routeFromHash(hash: string): string {
  const id = hash.replace(/^#\/?/, "");
  return NAV.some(item => item.id === id) ? id : "overview";
}
