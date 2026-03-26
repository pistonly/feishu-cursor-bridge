import * as os from "node:os";
import * as path from "node:path";
import { resolveBundledAdapterEntry } from "./acp/paths.js";

export interface Config {
  feishu: {
    appId: string;
    appSecret: string;
    domain: string;
  };
  /** 上游 @blowmage/cursor-agent-acp 子进程与工作区 */
  acp: {
    nodePath: string;
    adapterEntry: string;
    /** 透传给 cursor-agent-acp 的额外参数（不含 --session-dir） */
    extraArgs: string[];
    /** Cursor 工作区根目录（ACP cwd / 客户端文件沙箱默认根） */
    workspaceRoot: string;
    /**
     * 允许作为会话 cwd 的根路径列表（绝对路径）。
     * 未设置 `CURSOR_WORK_ALLOWLIST` 时仅包含 `workspaceRoot`。
     */
    allowedWorkspaceRoots: string[];
    /** 传给适配器的会话存储目录 */
    adapterSessionDir: string;
  };
  bridge: {
    sessionIdleTimeoutMs: number;
    sessionStorePath: string;
    cardUpdateThrottleMs: number;
    /** `/new list` 等使用的快捷列表 JSON 路径 */
    workspacePresetsPath: string;
    /** 列表文件为空时，用环境变量种子初始化（绝对路径） */
    workspacePresetsSeed: string[];
  };
  autoApprovePermissions: boolean;
  bridgeDebug: boolean;
  logLevel: "debug" | "info" | "warn" | "error";
}

const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** 空格分隔，支持引号包裹片段（简单拆分） */
export function parseShellLikeArgs(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote: "" | "\"" | "'" = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = "";
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "\"" || ch === "'") {
      inQuote = ch as "\"" | "'";
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length) {
        out.push(expandHome(cur));
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length) out.push(expandHome(cur));
  return out;
}

function parseExtraArgs(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return parseShellLikeArgs(raw.trim());
}

export function loadConfig(): Config {
  const logLevel = process.env["LOG_LEVEL"] ?? "info";
  if (!LOG_LEVELS.has(logLevel)) {
    throw new Error(
      `Invalid LOG_LEVEL "${logLevel}". Must be one of: debug, info, warn, error`,
    );
  }

  const workspaceRoot = path.resolve(
    expandHome(process.env["CURSOR_WORK_DIR"]?.trim() || process.cwd()),
  );

  const allowlistRaw = process.env["CURSOR_WORK_ALLOWLIST"]?.trim();
  let allowedWorkspaceRoots = allowlistRaw
    ? allowlistRaw
        .split(",")
        .map((s) => path.resolve(expandHome(s.trim())))
        .filter((p) => p.length > 0)
    : [workspaceRoot];
  if (allowedWorkspaceRoots.length === 0) {
    allowedWorkspaceRoots = [workspaceRoot];
  }

  const defaultAdapterSession = path.join(
    os.homedir(),
    ".feishu-cursor-bridge",
    "cursor-acp-sessions",
  );
  const adapterSessionDir = path.resolve(
    expandHome(
      process.env["CURSOR_ACP_SESSION_DIR"]?.trim() || defaultAdapterSession,
    ),
  );

  const defaultStore = path.join(
    os.homedir(),
    ".feishu-cursor-bridge",
    ".feishu-bridge-sessions.json",
  );
  const sessionStorePath = path.resolve(
    expandHome(
      process.env["BRIDGE_SESSION_STORE"]?.trim() || defaultStore,
    ),
  );

  const defaultPresetsFile = path.join(
    os.homedir(),
    ".feishu-cursor-bridge",
    "workspace-presets.json",
  );
  const workspacePresetsPath = path.resolve(
    expandHome(
      process.env["CURSOR_WORK_PRESETS_FILE"]?.trim() || defaultPresetsFile,
    ),
  );

  const presetsSeedRaw = process.env["CURSOR_WORK_PRESETS"]?.trim();
  const workspacePresetsSeed = presetsSeedRaw
    ? presetsSeedRaw
        .split(",")
        .map((s) => path.resolve(expandHome(s.trim())))
        .filter((p) => p.length > 0)
    : [];

  const sessionIdleTimeoutMs = Math.max(
    60_000,
    Number(process.env["SESSION_IDLE_TIMEOUT_MS"] ?? 30 * 60_000) || 30 * 60_000,
  );

  const cardUpdateThrottleMs = Math.max(
    200,
    Number(process.env["FEISHU_CARD_THROTTLE_MS"] ?? 800) || 800,
  );

  const adapterEntry =
    process.env["CURSOR_ACP_ADAPTER_ENTRY"]?.trim() ||
    resolveBundledAdapterEntry();

  const nodePath =
    process.env["ACP_NODE_PATH"]?.trim() || process.execPath;

  const extraArgs = parseExtraArgs(process.env["CURSOR_ACP_EXTRA_ARGS"]);

  return {
    feishu: {
      appId: requireEnv("FEISHU_APP_ID"),
      appSecret: requireEnv("FEISHU_APP_SECRET"),
      domain: process.env["FEISHU_DOMAIN"] ?? "feishu",
    },
    acp: {
      nodePath,
      adapterEntry,
      extraArgs,
      workspaceRoot,
      allowedWorkspaceRoots,
      adapterSessionDir,
    },
    bridge: {
      sessionIdleTimeoutMs,
      sessionStorePath,
      cardUpdateThrottleMs,
      workspacePresetsPath,
      workspacePresetsSeed,
    },
    autoApprovePermissions:
      (process.env["AUTO_APPROVE_PERMISSIONS"] ?? "true").toLowerCase() ===
      "true",
    bridgeDebug:
      (process.env["BRIDGE_DEBUG"] ?? "false").toLowerCase() === "true",
    logLevel: logLevel as Config["logLevel"],
  };
}
