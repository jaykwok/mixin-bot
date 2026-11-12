/** Single source of truth for command recognition and /help output. */
export const SUPPORTED_COMMANDS: ReadonlyMap<string, string> = new Map([
  ["/help", "查看本帮助"],
  ["/clear", "重新开始对话，之前的聊天记录还留着"],
  ["/stop", "停止你的当前任务，取消还在排队的消息"],
  ["/status", "查看处理进度、排队消息和正在运行的工具"],
  ["/compact", "压缩你在当前群或单聊的会话，保留聊天记录；会产生模型用量"],
]);

/**
 * Extract a case-insensitive slash command token. The platform removes the
 * @bot mention from textMsg.content before forwarding, wherever it was typed.
 */
export function canonicalCommand(content: string): string {
  const [token = ""] = content.trim().split(/\s+/, 1);
  return token.toLowerCase();
}

/** Any message whose first token starts with / is command syntax. */
export function isSlashCommandMessage(content: string): boolean {
  return canonicalCommand(content).startsWith("/");
}

const commandHelp = [...SUPPORTED_COMMANDS]
  .map(([command, description]) => `${command.padEnd(7)} ${description}`)
  .join("\n");

export const HELP_TEXT = `可用指令（群里需 @机器人，@ 放在指令前后均可；单聊直接发送。指令以 / 开头，大小写不敏感）：
${commandHelp}

收到要回复的推送：直接把回复发给机器人（群里 @机器人），要改、要撤回或者想转给别人，也直接说。

推送管理员在群里：
/登记群 群名   登记这个群，推送人之后可以按群名推送到群

提示：你在每个群和单聊里的消息分别按顺序处理；/stop 不会撤回已发出的内容。回复没发出去时机器人会自动重发。`;

export function unknownCommandText(content: string): string {
  return `⚠️ 未知指令「${canonicalCommand(content)}」\n\n${HELP_TEXT}`;
}
