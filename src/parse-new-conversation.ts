import { parseShellLikeArgs } from "./config.js";

/**
 * 是否应走桥接「中断本轮」逻辑（/stop、/cancel）。
 *
 * 飞书 **post** 等场景下，`extractPostText` 会得到「标题 + 换行 + 正文」，整段不再是单独的 `"/stop"`，
 * 若仅用全字匹配会漏判，消息会落入普通对话并进入 Agent。此处支持：
 * - 单行精确匹配（兼容全角斜杠 ／）
 * - 仅由一个或多个空白行分隔的多行，且**每一非空行**均为 /stop 或 /cancel
 * - **最后一行**为 /stop 或 /cancel，且前面各行均**不以 /** 开头（避免误匹配「/new …」+ 粘贴）
 */
export function matchesInterruptUserCommand(content: string): boolean {
  const normalized = content
    .replace(/^\uFEFF/, "")
    .replace(/\uFF0F/g, "/")
    .trim();
  if (!normalized) return false;

  const lines = normalized
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return false;

  const interruptLine = /^\/(stop|cancel)$/i;

  if (lines.length === 1) {
    return interruptLine.test(lines[0]!);
  }

  if (lines.every((l) => interruptLine.test(l))) {
    return true;
  }

  const last = lines[lines.length - 1]!;
  if (!interruptLine.test(last)) return false;
  const head = lines.slice(0, -1);
  if (head.some((l) => l.startsWith("/"))) return false;
  return true;
}

export type NewConversationCommand =
  | { kind: "mode"; modeId?: string }
  | { kind: "new"; variant: "default"; name?: string }
  | { kind: "new"; variant: "workspace"; path: string; name?: string }
  /** 序号从 1 开始，对应列表中的第 N 项 */
  | { kind: "new"; variant: "preset"; index: number; name?: string }
  | { kind: "new"; variant: "list" }
  | { kind: "new"; variant: "add-list"; path: string }
  | { kind: "new"; variant: "remove-list"; index: number }
  | { kind: "switch"; target: number | string | null }
  | { kind: "reply"; target: number | string | null }
  | { kind: "rename"; target: number | string | null; name: string }
  | { kind: "close"; target: number | string }
  | { kind: "sessions" }
  /** 对当前活跃 slot 调用 ACP `session/load`（测试/恢复用） */
  | { kind: "resume" };

/**
 * 解析重置/会话类命令：
 * - `/new`（裸 `/new` 同 `list`；另含 `/new 1`、`/new add-list`、`/new remove-list`、`/new --name`+路径 等）
 * - `/switch [编号或名称]`
 * - `/reply [编号或名称]`
 * - `/rename <新名字>`、`/rename <编号或名称> <新名字>`
 * - `/close <编号或名称>`、`/close all`
 * - `/mode <模式ID>`
 * - `/sessions`
 * - `/resume`
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
    cmd !== "new" &&
    cmd !== "switch" &&
    cmd !== "reply" &&
    cmd !== "rename" &&
    cmd !== "close" &&
    cmd !== "mode" &&
    cmd !== "sessions" &&
    cmd !== "session" &&
    cmd !== "resume"
  ) {
    return null;
  }

  // /sessions — list all slots（/session 为别名）
  if (cmd === "sessions" || cmd === "session") {
    return { kind: "sessions" };
  }

  // /resume — ACP session/load 当前活跃 session
  if (cmd === "resume") {
    return { kind: "resume" };
  }

  // /mode [modeId]
  if (cmd === "mode") {
    const modeId = tokens[1]?.trim();
    return modeId ? { kind: "mode", modeId } : { kind: "mode" };
  }

  // /switch [target]
  // /reply [target]
  if (cmd === "switch" || cmd === "reply") {
    if (tokens.length === 1) {
      return { kind: cmd, target: null };
    }
    const arg = tokens[1];
    // 仅整串为数字时按槽位编号解析，避免 parseInt("12abc") === 12 误切到 #12
    return {
      kind: cmd,
      target: /^\d+$/.test(arg) ? parseInt(arg, 10) : arg,
    };
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

  // /close <target> | /close all
  if (cmd === "close") {
    if (tokens.length < 2) {
      // Return a sentinel that bridge.ts will handle as missing-arg error
      return { kind: "close", target: NaN as unknown as number };
    }
    const arg = tokens[1];
    if (arg.toLowerCase() === "all") {
      return { kind: "close", target: "all" };
    }
    const num = parseInt(arg, 10);
    return { kind: "close", target: isNaN(num) ? arg : num };
  }

  // /new（无参数）等价于 /new list
  if (tokens.length === 1) return { kind: "new", variant: "list" };

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
