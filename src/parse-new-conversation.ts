import { parseShellLikeArgs } from "./config.js";

export type NewConversationCommand =
  | { kind: "reset"; path?: string }
  | { kind: "new"; variant: "default"; name?: string }
  | { kind: "new"; variant: "workspace"; path: string; name?: string }
  /** 序号从 1 开始，对应列表中的第 N 项 */
  | { kind: "new"; variant: "preset"; index: number; name?: string }
  | { kind: "new"; variant: "list" }
  | { kind: "new"; variant: "add-list"; path: string }
  | { kind: "new"; variant: "remove-list"; index: number }
  | { kind: "switch"; target: number | string | null }
  | { kind: "rename"; target: number | string | null; name: string }
  | { kind: "close"; target: number | string }
  | { kind: "sessions" };

/**
 * 解析重置/会话类命令：
 * - `/reset`、`/new`（含 `/new 1`、`/new list`、`/new add-list`、`/new remove-list`、`/new --name`）
 * - `/switch [编号或名称]`
 * - `/rename <新名字>`、`/rename <编号或名称> <新名字>`
 * - `/close <编号或名称>`
 * - `/sessions`
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
  /** 首 token 一律按小写识别，避免飞书端自动大写首字母导致命令失效 */
  const cmd = tokens[0].toLowerCase();

  if (
    cmd !== "reset" &&
    cmd !== "new" &&
    cmd !== "switch" &&
    cmd !== "rename" &&
    cmd !== "close" &&
    cmd !== "sessions" &&
    cmd !== "session"
  ) {
    return null;
  }

  // /sessions — list all slots（/session 为别名）
  if (cmd === "sessions" || cmd === "session") {
    return { kind: "sessions" };
  }

  // /switch [target]
  if (cmd === "switch") {
    if (tokens.length === 1) {
      return { kind: "switch", target: null };
    }
    const arg = tokens[1];
    const num = parseInt(arg, 10);
    return { kind: "switch", target: isNaN(num) ? arg : num };
  }

  // /rename <name>
  // /rename <target> <name>
  if (cmd === "rename") {
    if (tokens.length < 2) {
      return { kind: "rename", target: NaN as unknown as number, name: "" };
    }
    if (tokens.length === 2) {
      return { kind: "rename", target: null, name: tokens[1] };
    }
    const arg = tokens[1];
    const num = parseInt(arg, 10);
    return {
      kind: "rename",
      target: isNaN(num) ? arg : num,
      name: tokens.slice(2).join(" ").trim(),
    };
  }

  // /close <target>
  if (cmd === "close") {
    if (tokens.length < 2) {
      // Return a sentinel that bridge.ts will handle as missing-arg error
      return { kind: "close", target: NaN as unknown as number };
    }
    const arg = tokens[1];
    const num = parseInt(arg, 10);
    return { kind: "close", target: isNaN(num) ? arg : num };
  }

  // /reset
  if (cmd === "reset") {
    if (tokens.length === 1) return { kind: "reset" };
    return { kind: "reset", path: tokens.slice(1).join(" ").trim() };
  }

  // /new ...
  if (tokens.length === 1) return { kind: "new", variant: "default" };

  // Extract optional --name <value> from remaining tokens (can appear anywhere after cmd)
  const { name, remainingTokens } = extractNameFlag(tokens.slice(1));

  if (remainingTokens.length === 0) {
    return { kind: "new", variant: "default", name };
  }

  const sub = remainingTokens[0];
  const subLc = sub.toLowerCase();

  if (subLc === "list") {
    return { kind: "new", variant: "list" };
  }
  if (subLc === "add-list") {
    const rest = remainingTokens.slice(1).join(" ").trim();
    return { kind: "new", variant: "add-list", path: rest };
  }
  if (subLc === "remove-list") {
    const idxTok = remainingTokens[1];
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
    return { kind: "new", variant: "preset", index: parseInt(sub, 10), name };
  }
  return {
    kind: "new",
    variant: "workspace",
    path: remainingTokens.join(" ").trim(),
    name,
  };
}

// ---------------------------------------------------------------------------
// Helper: extract --name <value> flag from token list
// ---------------------------------------------------------------------------

function extractNameFlag(tokens: string[]): { name: string | undefined; remainingTokens: string[] } {
  const remaining: string[] = [];
  let name: string | undefined;
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    const tokLc = tok.toLowerCase();
    if (tokLc === "--name" && i + 1 < tokens.length) {
      name = tokens[i + 1];
      i += 2;
    } else if (tokLc.startsWith("--name=")) {
      const eq = tok.indexOf("=");
      name = eq >= 0 ? tok.slice(eq + 1) : "";
      i++;
    } else {
      remaining.push(tok);
      i++;
    }
  }
  return { name, remainingTokens: remaining };
}
