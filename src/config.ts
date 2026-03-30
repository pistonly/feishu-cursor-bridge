import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveBundledAdapterEntry } from "./acp/paths.js";
import type { AcpBackend } from "./acp/runtime-contract.js";

export interface Config {
  feishu: {
    appId: string;
    appSecret: string;
    domain: string;
  };
  /** 上游 @blowmage/cursor-agent-acp 子进程与工作区 */
  acp: {
    backend: AcpBackend;
    nodePath: string;
    adapterEntry: string;
    /** 透传给 cursor-agent-acp 的额外参数（不含 --session-dir） */
    extraArgs: string[];
    /** Cursor 官方 ACP 命令路径（默认 `agent`） */
    officialAgentPath: string;
    officialApiKey?: string;
    officialAuthToken?: string;
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
    /**
     * 同一飞书用户存活 session（非空闲过期）总数上限；`0` 表示不限制。
     * @default 10
     */
    maxSessionsPerUser: number;
    sessionIdleTimeoutMs: number;
    sessionStorePath: string;
    cardUpdateThrottleMs: number;
    /** `/new list` 等使用的快捷列表 JSON 路径 */
    workspacePresetsPath: string;
    /** 列表文件为空时，用环境变量种子初始化（绝对路径） */
    workspacePresetsSeed: string[];
    /** 单实例锁文件路径（`BRIDGE_SINGLE_INSTANCE_LOCK`） */
    singleInstanceLockPath: string;
    /** 为 true 时不创建锁，允许多进程（仅调试用） */
    allowMultipleInstances: boolean;
    /** 实验参数：将 console.* 镜像写入日志文件 */
    experimentalLogToFile: boolean;
    /** 实验参数：日志文件路径 */
    experimentalLogFilePath: string;
  };
  autoApprovePermissions: boolean;
  bridgeDebug: boolean;
  /**
   * 为 true 时打印 `[acp reload-trace]`：`session/load` 前后与每条 `session/update` 入站摘要，便于观察 reload 时 bridge 收到什么。
   * 环境变量：`ACP_RELOAD_TRACE_LOG=true`
   */
  acpReloadTraceLog: boolean;
  logLevel: "debug" | "info" | "warn" | "error";
}

const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);
const ACP_BACKENDS = new Set<AcpBackend>(["legacy", "official"]);

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

/**
 * 启动 cursor-agent-acp 子进程使用的 Node 可执行文件。
 * 若 `ACP_NODE_PATH` 指向已删除或错误的路径（常见于换过 nvm 版本却仍保留旧路径），则回退为当前进程的 `process.execPath`，避免 `spawn ... ENOENT`。
 */
function resolveNodeExecutablePath(): string {
  const fromEnv = process.env["ACP_NODE_PATH"]?.trim();
  const raw = fromEnv ? expandHome(fromEnv) : process.execPath;
  const abs = path.resolve(raw);
  try {
    if (fs.existsSync(abs)) {
      const st = fs.statSync(abs);
      if (st.isFile()) {
        return abs;
      }
    }
  } catch {
    // ignore
  }
  const fallback = process.execPath;
  if (fromEnv && path.resolve(fallback) !== abs) {
    console.warn(
      `[config] ACP_NODE_PATH 指向的路径不存在或不可用: ${abs}，已回退为当前进程 Node: ${fallback}`,
    );
  }
  return fallback;
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

function parseAcpBackend(raw: string | undefined): AcpBackend {
  const normalized = (raw?.trim().toLowerCase() || "official") as AcpBackend;
  return ACP_BACKENDS.has(normalized) ? normalized : "official";
}

const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60_000;

const DEFAULT_MAX_SESSIONS_PER_USER = 10;

/** `0` 或负数表示不限制 */
function parseMaxSessionsPerUser(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_MAX_SESSIONS_PER_USER;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return DEFAULT_MAX_SESSIONS_PER_USER;
  if (n <= 0) return 0;
  return Math.max(1, Math.floor(n));
}

function parseSessionIdleTimeoutMs(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_SESSION_IDLE_TIMEOUT_MS;
  if (trimmed === "0" || /^infinity$/i.test(trimmed) || /^inf$/i.test(trimmed)) {
    return Number.POSITIVE_INFINITY;
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SESSION_IDLE_TIMEOUT_MS;
  }
  return Math.max(60_000, parsed);
}

/**
 * ACP 子进程 `spawn(..., { cwd: workspaceRoot })` 要求 cwd 必须存在；若目录缺失，Node 会报
 * `spawn <node 路径> ENOENT`，易误判为 Node 可执行文件丢失。
 */
function ensureWorkspaceRootReady(workspaceRoot: string): void {
  try {
    if (fs.existsSync(workspaceRoot)) {
      if (!fs.statSync(workspaceRoot).isDirectory()) {
        throw new Error(`CURSOR_WORK_DIR 不是目录: ${workspaceRoot}`);
      }
      return;
    }
    fs.mkdirSync(workspaceRoot, { recursive: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `CURSOR_WORK_DIR 不可用: ${workspaceRoot}\n` +
        `请创建该目录或修正 .env。若 cwd 不存在，子进程会启动失败（常被误报为 Node ENOENT）。\n` +
        `底层原因: ${msg}`,
    );
  }
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
  ensureWorkspaceRootReady(workspaceRoot);
  const backend = parseAcpBackend(process.env["ACP_BACKEND"]);

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

  const defaultSingleInstanceLock = path.join(
    os.homedir(),
    ".feishu-cursor-bridge",
    "bridge.lock",
  );
  const singleInstanceLockPath = path.resolve(
    expandHome(
      process.env["BRIDGE_SINGLE_INSTANCE_LOCK"]?.trim() ||
        defaultSingleInstanceLock,
    ),
  );
  const allowMultipleInstances =
    (process.env["BRIDGE_ALLOW_MULTIPLE_INSTANCES"] ?? "false").toLowerCase() ===
    "true";

  const defaultExperimentalLogFile = path.join(
    os.homedir(),
    ".feishu-cursor-bridge",
    "logs",
    "bridge.log",
  );
  const experimentalLogToFile =
    (process.env["EXPERIMENT_LOG_TO_FILE"] ?? "false").toLowerCase() === "true";
  const experimentalLogFilePath = path.resolve(
    expandHome(
      process.env["EXPERIMENT_LOG_FILE"]?.trim() || defaultExperimentalLogFile,
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

  const sessionIdleTimeoutMs = parseSessionIdleTimeoutMs(
    process.env["SESSION_IDLE_TIMEOUT_MS"],
  );

  const maxSessionsPerUser = parseMaxSessionsPerUser(
    process.env["BRIDGE_MAX_SESSIONS_PER_USER"],
  );

  const cardUpdateThrottleMs = Math.max(
    200,
    Number(process.env["FEISHU_CARD_THROTTLE_MS"] ?? 800) || 800,
  );

  const adapterEntry =
    process.env["CURSOR_ACP_ADAPTER_ENTRY"]?.trim() ||
    (backend === "legacy" ? resolveBundledAdapterEntry() : "");

  const nodePath = resolveNodeExecutablePath();

  const extraArgs = parseExtraArgs(process.env["CURSOR_ACP_EXTRA_ARGS"]);
  const officialAgentPath =
    process.env["CURSOR_AGENT_PATH"]?.trim() || "agent";
  const officialApiKey = process.env["CURSOR_API_KEY"]?.trim() || undefined;
  const officialAuthToken =
    process.env["CURSOR_AUTH_TOKEN"]?.trim() || undefined;

  return {
    feishu: {
      appId: requireEnv("FEISHU_APP_ID"),
      appSecret: requireEnv("FEISHU_APP_SECRET"),
      domain: process.env["FEISHU_DOMAIN"] ?? "feishu",
    },
    acp: {
      backend,
      nodePath,
      adapterEntry,
      extraArgs,
      officialAgentPath,
      officialApiKey,
      officialAuthToken,
      workspaceRoot,
      allowedWorkspaceRoots,
      adapterSessionDir,
    },
    bridge: {
      maxSessionsPerUser,
      sessionIdleTimeoutMs,
      sessionStorePath,
      cardUpdateThrottleMs,
      workspacePresetsPath,
      workspacePresetsSeed,
      singleInstanceLockPath,
      allowMultipleInstances,
      experimentalLogToFile,
      experimentalLogFilePath,
    },
    autoApprovePermissions:
      (process.env["AUTO_APPROVE_PERMISSIONS"] ?? "true").toLowerCase() ===
      "true",
    bridgeDebug:
      (process.env["BRIDGE_DEBUG"] ?? "false").toLowerCase() === "true",
    acpReloadTraceLog:
      (process.env["ACP_RELOAD_TRACE_LOG"] ?? "false").toLowerCase() === "true",
    logLevel: logLevel as Config["logLevel"],
  };
}
