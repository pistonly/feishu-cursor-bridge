import { parseShellLikeArgs } from "../config/index.js";
import type { AcpBackend } from "../acp/runtime-contract.js";

const NEW_COMMAND_BACKEND_ALIASES: Record<string, AcpBackend> = {
  official: "cursor-official",
  "cursor-official": "cursor-official",
  legacy: "cursor-legacy",
  "cursor-legacy": "cursor-legacy",
  tmux: "cursor-tmux",
  "cursor-tmux": "cursor-tmux",
  claude: "claude",
  cc: "claude",
  codex: "codex",
  cx: "codex",
};

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

export function matchesBridgeHelpCommand(content: string): boolean {
  const normalized = content
    .replace(/^\uFEFF/, "")
    .replace(/\uFF0F/g, "/")
    .trim();
  if (!normalized) return false;
  if (normalized === "/" || normalized === "/帮助") return true;

  const lower = normalized.toLowerCase();
  return lower === "/help" || lower === "/commands";
}

export function matchesBridgeStartCommand(content: string): boolean {
  const normalized = content
    .replace(/^﻿/, "")
    .replace(/／/g, "/")
    .trim();
  if (!normalized) return false;

  return normalized.toLowerCase() === "/start";
}

export type NewConversationCommand =
  | { kind: "mode"; modeId?: string }
  | { kind: "new"; variant: "default"; name?: string; backend?: AcpBackend }
  | { kind: "new"; variant: "workspace"; path: string; name?: string; backend?: AcpBackend }
  | { kind: "new"; variant: "preset"; index: number; name?: string; backend?: AcpBackend }
  | { kind: "new"; variant: "list"; backend?: AcpBackend }
  | { kind: "new"; variant: "add-list"; path: string; backend?: AcpBackend }
  | { kind: "new"; variant: "remove-list"; index: number; backend?: AcpBackend }
  | { kind: "switch"; target: number | string | null }
  | { kind: "reply"; target: number | string | null }
  | { kind: "rename"; target: number | string | null; name: string }
  | { kind: "close"; target: number | string }
  | { kind: "whoami" }
  | { kind: "sessions" }
  | { kind: "resume" }
  | { kind: "restart"; force: boolean; invalidUsage?: boolean }
  | { kind: "update"; force: boolean; invalidUsage?: boolean };

export function parseNewConversationCommand(
  content: string,
): NewConversationCommand | null {
  const t = content.trim();
  if (!t.startsWith("/")) return null;
  const body = t.slice(1).trim();
  if (!body) return null;
  const tokens = parseShellLikeArgs(body);
  if (tokens.length === 0) return null;
  const cmd = tokens[0].toLowerCase();

  if (
    cmd !== "new" &&
    cmd !== "switch" &&
    cmd !== "reply" &&
    cmd !== "rename" &&
    cmd !== "close" &&
    cmd !== "whoami" &&
    cmd !== "mode" &&
    cmd !== "sessions" &&
    cmd !== "session" &&
    cmd !== "resume" &&
    cmd !== "restart" &&
    cmd !== "update"
  ) {
    return null;
  }

  if (cmd === "whoami") return { kind: "whoami" };
  if (cmd === "sessions" || cmd === "session") return { kind: "sessions" };
  if (cmd === "resume") return { kind: "resume" };
  if (cmd === "restart" || cmd === "update") {
    return parseMaintenanceCommand(cmd, tokens.slice(1));
  }
  if (cmd === "mode") {
    const modeId = tokens[1]?.trim();
    return modeId ? { kind: "mode", modeId } : { kind: "mode" };
  }

  if (cmd === "switch" || cmd === "reply") {
    if (tokens.length === 1) return { kind: cmd, target: null };
    const arg = tokens[1];
    return { kind: cmd, target: /^\d+$/.test(arg) ? parseInt(arg, 10) : arg };
  }

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

  if (cmd === "close") {
    if (tokens.length < 2) {
      return { kind: "close", target: NaN as unknown as number };
    }
    const arg = tokens[1];
    if (arg.toLowerCase() === "all") return { kind: "close", target: "all" };
    const num = parseInt(arg, 10);
    return { kind: "close", target: isNaN(num) ? arg : num };
  }

  if (tokens.length === 1) return { kind: "new", variant: "list" };

  const { name, backend, remainingTokens } = extractNewFlags(tokens.slice(1));
  if (remainingTokens.length === 0) {
    return { kind: "new", variant: "default", name, backend };
  }

  const sub = remainingTokens[0];
  const subLc = sub.toLowerCase();
  if (subLc === "list") return { kind: "new", variant: "list", backend };
  if (subLc === "add-list") {
    return { kind: "new", variant: "add-list", path: remainingTokens.slice(1).join(" ").trim(), backend };
  }
  if (subLc === "remove-list") {
    const idxTok = remainingTokens[1];
    if (!idxTok || !/^\d+$/.test(idxTok)) {
      return { kind: "new", variant: "remove-list", index: 0, backend };
    }
    return { kind: "new", variant: "remove-list", index: parseInt(idxTok, 10), backend };
  }
  if (/^\d+$/.test(sub)) {
    return { kind: "new", variant: "preset", index: parseInt(sub, 10), name, backend };
  }
  return { kind: "new", variant: "workspace", path: remainingTokens.join(" ").trim(), name, backend };
}

function normalizeBackend(raw: string | undefined): AcpBackend | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return undefined;
  return NEW_COMMAND_BACKEND_ALIASES[normalized];
}

function extractNewFlags(tokens: string[]): {
  name: string | undefined;
  backend: AcpBackend | undefined;
  remainingTokens: string[];
} {
  const remaining: string[] = [];
  let name: string | undefined;
  let backend: AcpBackend | undefined;
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
      i += 1;
    } else if ((tokLc === "--backend" || tokLc === "-b") && i + 1 < tokens.length) {
      backend = normalizeBackend(tokens[i + 1]);
      if (!backend) remaining.push(tok, tokens[i + 1]);
      i += 2;
    } else if (tokLc.startsWith("--backend=") || tokLc.startsWith("-b=")) {
      const value = tokLc.startsWith("-b=") ? tok.slice(3) : tok.slice("--backend=".length);
      backend = normalizeBackend(value);
      if (!backend) remaining.push(tok);
      i += 1;
    } else {
      remaining.push(tok);
      i += 1;
    }
  }
  return { name, backend, remainingTokens: remaining };
}

function parseMaintenanceCommand(
  cmd: "restart" | "update",
  tokens: string[],
): Extract<NewConversationCommand, { kind: "restart" | "update" }> {
  let force = false;
  let invalidUsage = false;
  for (const token of tokens) {
    const normalized = token.trim().toLowerCase();
    if (normalized === "--force") {
      force = true;
      continue;
    }
    invalidUsage = true;
  }
  return invalidUsage ? { kind: cmd, force, invalidUsage: true } : { kind: cmd, force };
}
