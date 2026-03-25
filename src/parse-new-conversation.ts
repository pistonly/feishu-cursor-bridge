import { parseShellLikeArgs } from "./config.js";

/**
 * 解析重置会话类命令：`/reset`、`/new`，可选后跟工作区路径（支持引号含空格）。
 */
export function parseNewConversationCommand(content: string): {
  path?: string;
} | null {
  const t = content.trim();
  if (!t.startsWith("/")) return null;
  const body = t.slice(1).trim();
  if (!body) return null;
  const tokens = parseShellLikeArgs(body);
  if (tokens.length === 0) return null;
  const cmd = tokens[0];
  if (cmd !== "reset" && cmd !== "new") return null;
  if (tokens.length === 1) return {};
  return { path: tokens.slice(1).join(" ").trim() };
}
