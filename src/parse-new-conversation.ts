import { parseShellLikeArgs } from "./config.js";

export type NewConversationCommand =
  | { kind: "reset"; path?: string }
  | { kind: "new"; variant: "default" }
  | { kind: "new"; variant: "workspace"; path: string }
  /** 序号从 1 开始，对应列表中的第 N 项 */
  | { kind: "new"; variant: "preset"; index: number }
  | { kind: "new"; variant: "list" }
  | { kind: "new"; variant: "add-list"; path: string }
  | { kind: "new"; variant: "remove-list"; index: number };

/**
 * 解析重置会话类命令：`/reset`、`/new`（含 `/new 1`、`/new list`、`/new add-list`、`/new remove-list`）。
 */
export function parseNewConversationCommand(
  content: string,
): NewConversationCommand | null {
  const t = content.trim();
  if (!t.startsWith("/")) return null;
  const body = t.slice(1).trim();
  if (!body) return null;
  const tokens = parseShellLikeArgs(body);
  if (tokens.length === 0) return null;
  const cmd = tokens[0];
  if (cmd !== "reset" && cmd !== "new") return null;

  if (cmd === "reset") {
    if (tokens.length === 1) return { kind: "reset" };
    return { kind: "reset", path: tokens.slice(1).join(" ").trim() };
  }

  if (tokens.length === 1) return { kind: "new", variant: "default" };

  const sub = tokens[1];
  if (sub === "list") {
    return { kind: "new", variant: "list" };
  }
  if (sub === "add-list") {
    const rest = tokens.slice(2).join(" ").trim();
    return { kind: "new", variant: "add-list", path: rest };
  }
  if (sub === "remove-list") {
    const idxTok = tokens[2];
    if (!idxTok || !/^\d+$/.test(idxTok)) {
      return { kind: "new", variant: "remove-list", index: 0 };
    }
    return {
      kind: "new",
      variant: "remove-list",
      index: parseInt(idxTok, 10),
    };
  }
  if (/^\d+$/.test(sub)) {
    return { kind: "new", variant: "preset", index: parseInt(sub, 10) };
  }
  return {
    kind: "new",
    variant: "workspace",
    path: tokens.slice(1).join(" ").trim(),
  };
}
