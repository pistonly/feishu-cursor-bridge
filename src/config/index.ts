import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ACP_BACKENDS,
  CONFIG_BACKEND_ALIAS_MAP,
  parseBackendAlias,
} from "../acp/backend-metadata.js";
import {
  resolveClaudeAgentAcpDistEntry,
  resolveClaudeAgentAcpSourceEntry,
  resolveLegacyAdapterDistEntry,
  resolveLegacyAdapterSourceEntry,
  resolveBundledTsxCliEntry,
} from "../acp/paths.js";
import type { AcpBackend } from "../acp/runtime-contract.js";

/**
 * 是否由 `tsx src/index.ts`（即 `npm run dev`）启动桥接主进程。
 * 与 `tsx src/index.ts`（`npm run dev`）一致时，legacy 适配器用 `cursor-agent-acp` 源码；与 `node dist/index.js` 一致时用其 `dist`。
 */
function isBridgeMainScriptSourceIndex(): boolean {
  const raw = process.argv[1];
  if (!raw) return false;
  return path.resolve(raw).endsWith(path.join("src", "index.ts"));
}

export interface UpgradeAdminIds {
  openIds: Set<string>;
  userIds: Set<string>;
  unionIds: Set<string>;
}

export type GroupSessionScope = "per-user" | "shared";

export interface Config {
  feishu: {
    appId: string;
    appSecret: string;
    domain: string;
  };
  /** 多 backend 统一配置；默认 backend 由 `ACP_BACKEND` 指定。 */
  acp: {
    backend: AcpBackend;
    enabledBackends: AcpBackend[];
    nodePath: string;
    /** legacy 时为本仓库 `cursor-agent-acp` 入口（与桥接 dev/prod 同源：tsx+src 或 dist+node） */
    adapterEntry: string;
    /**
     * 与桥接一致从源码跑 legacy 时：`node <nodePath> <adapterTsxCli> <adapterEntry> ...`
     */
    adapterTsxCli?: string;
    /** 透传给 cursor-agent-acp 的额外参数（不含 --session-dir） */
    extraArgs: string[];
    /** Cursor 官方 ACP 命令路径（默认 `agent`） */
    officialAgentPath: string;
    officialApiKey?: string;
    officialAuthToken?: string;
    /** Claude ACP 子进程命令 */
    claudeSpawnCommand: string;
    claudeSpawnArgs: string[];
    /** Codex ACP 子进程命令 */
    codexSpawnCommand: string;
    codexSpawnArgs: string[];
    /**
     * ACP 子进程 spawn 使用的 `cwd`（取 `CURSOR_WORK_ALLOWLIST` 中第一项）；
     * `session/new` 仍传入各 session 自己的工作区路径。
     */
    workspaceRoot: string;
    /**
     * 允许作为会话 cwd 的根路径列表（绝对路径），须由环境变量显式配置，至少一项。
     */
    allowedWorkspaceRoots: string[];
    /** 传给适配器的会话存储目录 */
    adapterSessionDir: string;
  };
  bridge: {
    /** 允许执行 `/restart`、`/update` 的飞书用户 ID（逗号分隔） */
    adminUserIds: string[];
    /** 群聊 session 隔离粒度：`per-user` 或 `shared` */
    groupSessionScope: GroupSessionScope;
    /**
     * 同一飞书用户存活 session（非空闲过期）总数上限；`0` 表示不限制。
     * @default 10
     */
    maxSessionsPerUser: number;
    sessionIdleTimeoutMs: number;
    sessionStorePath: string;
    cardUpdateThrottleMs: number;
    /** 单张飞书卡片的软上限，超过后滚动到下一张 */
    cardSplitMarkdownThreshold: number;
    /** 单张飞书卡片最多聚合的工具条目数，超过后滚动到下一张 */
    cardSplitToolThreshold: number;
    /** `/new list` 等使用的快捷列表 JSON 路径 */
    workspacePresetsPath: string;
    /** 列表文件为空时，用环境变量种子初始化（绝对路径） */
    workspacePresetsSeed: string[];
    /** `/restart`、`/update` 的持久化状态文件 */
    maintenanceStatePath: string;
    /** 单实例锁文件路径（`BRIDGE_SINGLE_INSTANCE_LOCK`） */
    singleInstanceLockPath: string;
    /** 为 true 时不创建锁，允许多进程（仅调试用） */
    allowMultipleInstances: boolean;
    /** 当前进程是否由 launchd/systemd 等服务管理器拉起 */
    managedByService: boolean;
    /** 实验参数：将 console.* 镜像写入日志文件 */
    experimentalLogToFile: boolean;
    /** 实验日志文件路径 */
    experimentalLogFilePath: string;
    /** 是否按 session/slot 落盘 prompt/chunk/reply/error 调试日志 */
    slotMessageLogEnabled: boolean;
    /** 是否在卡片中显示 ACP availableCommands */
    showAcpAvailableCommands: boolean;
    /** 是否允许在飞书里使用 `/upgrade` 触发 bridge 自升级 */
    enableUpgradeCommand: boolean;
    /** 允许触发 `/upgrade` 的管理员飞书 ID 列表 */
    upgradeAdmins: UpgradeAdminIds;
    /** service.sh 的绝对路径，用于后台拉起 upgrade */
    serviceScriptPath: string;
    /** 最近一次升级结果 JSON 路径 */
    upgradeResultPath: string;
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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function expandHomeWith(p: string, homeDir: string): string {
  if (p.startsWith("~/")) {
    return path.join(homeDir, p.slice(2));
  }
  return p;
}

export function expandHome(p: string): string {
  return expandHomeWith(p, os.homedir());
}

/**
 * 启动 cursor-agent-acp 子进程使用的 Node 可执行文件。
 * 若 `ACP_NODE_PATH` 指向已删除或错误的路径（常见于换过 nvm 版本却仍保留旧路径），则回退为当前进程的 `process.execPath`，避免 `spawn ... ENOENT`。
 */
function resolveNodeExecutablePath(): string {
  const fromEnv =
    process.env["CURSOR_LEGACY_NODE_PATH"]?.trim() ||
    process.env["ACP_NODE_PATH"]?.trim();
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

function parseGroupSessionScope(
  raw: string | undefined,
): GroupSessionScope {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "shared") return "shared";
  return "per-user";
}

function hasCodexConfigOverride(args: string[], key: string): boolean {
  for (let i = 0; i < args.length; i++) {
    const current = args[i];
    if (!current) continue;
    if (current === "-c" || current === "--config") {
      const next = args[i + 1];
      if (typeof next === "string" && next.startsWith(`${key}=`)) {
        return true;
      }
      continue;
    }
    if (current.startsWith("--config=")) {
      const value = current.slice("--config=".length);
      if (value.startsWith(`${key}=`)) {
        return true;
      }
    }
  }
  return false;
}

function parseAcpBackend(raw: string | undefined): AcpBackend {
  const normalized = raw?.trim().toLowerCase() || "cursor-official";
  return parseBackendAlias(normalized, CONFIG_BACKEND_ALIAS_MAP) ?? "cursor-official";
}

function parseEnabledAcpBackends(
  raw: string | undefined,
  defaultBackend: AcpBackend,
): AcpBackend[] {
  const trimmed = raw?.trim();
  if (!trimmed) return [defaultBackend];
  const backends = trimmed
    .split(",")
    .map((item) => parseAcpBackend(item))
    .filter((item, index, all) => all.indexOf(item) === index);
  return backends.length > 0 ? backends : [defaultBackend];
}

function resolveBundledClaudeAgentAcpEntry(): string | undefined {
  const candidate = isBridgeMainScriptSourceIndex()
    ? resolveClaudeAgentAcpSourceEntry()
    : resolveClaudeAgentAcpDistEntry();
  return fs.existsSync(candidate) ? candidate : undefined;
}

function resolveClaudeAgentAcpSpawn(): { command: string; args: string[] } {
  const envRaw = process.env["CLAUDE_AGENT_ACP_COMMAND"]?.trim();
  const extra = parseExtraArgs(process.env["CLAUDE_AGENT_ACP_EXTRA_ARGS"]);
  if (envRaw) {
    const tokens = parseShellLikeArgs(envRaw);
    if (tokens.length === 0) {
      throw new Error("CLAUDE_AGENT_ACP_COMMAND 解析为空");
    }
    return {
      command: tokens[0]!,
      args: [...tokens.slice(1), ...extra],
    };
  }
  const bundled = resolveBundledClaudeAgentAcpEntry();
  if (bundled) {
    if (bundled.endsWith(".ts")) {
      return {
        command: process.execPath,
        args: [resolveBundledTsxCliEntry(), bundled, ...extra],
      };
    }
    return { command: process.execPath, args: [bundled, ...extra] };
  }
  return {
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp", ...extra],
  };
}

function resolveCodexAgentAcpSpawn(): { command: string; args: string[] } {
  const envRaw = process.env["CODEX_AGENT_ACP_COMMAND"]?.trim();
  const extra = parseExtraArgs(process.env["CODEX_AGENT_ACP_EXTRA_ARGS"]);
  const autoApprovePermissions =
    (process.env["AUTO_APPROVE_PERMISSIONS"] ?? "true").toLowerCase() ===
    "true";
  if (envRaw) {
    const tokens = parseShellLikeArgs(envRaw);
    if (tokens.length === 0) {
      throw new Error("CODEX_AGENT_ACP_COMMAND 解析为空");
    }
    const args = [...tokens.slice(1), ...extra];
    if (autoApprovePermissions) {
      if (!hasCodexConfigOverride(args, "sandbox_mode")) {
        args.push("-c", 'sandbox_mode="danger-full-access"');
      }
      if (!hasCodexConfigOverride(args, "approval_policy")) {
        args.push("-c", 'approval_policy="never"');
      }
    }
    return {
      command: tokens[0]!,
      args,
    };
  }
  const args = ["-y", "@zed-industries/codex-acp", ...extra];
  if (autoApprovePermissions) {
    if (!hasCodexConfigOverride(args, "sandbox_mode")) {
      args.push("-c", 'sandbox_mode="danger-full-access"');
    }
    if (!hasCodexConfigOverride(args, "approval_policy")) {
      args.push("-c", 'approval_policy="never"');
    }
  }
  return {
    command: "npx",
    args,
  };
}

const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60_000;

const DEFAULT_MAX_SESSIONS_PER_USER = 10;
const DEFAULT_CARD_SPLIT_MARKDOWN_THRESHOLD = 3_500;
const DEFAULT_CARD_SPLIT_TOOL_THRESHOLD = 8;

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

function parsePositiveIntegerThreshold(
  raw: string | undefined,
  defaultValue: number,
  minValue = 1,
): number {
  const trimmed = raw?.trim();
  if (!trimmed) return defaultValue;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.max(minValue, Math.floor(parsed));
}

function parseStringList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item, index, all) => item.length > 0 && all.indexOf(item) === index);
}

function parseIdList(raw: string | undefined): Set<string> {
  return new Set(parseStringList(raw));
}

/**
 * 允许列表中的每个根须为目录；不存在则 `mkdir -p`（与旧版单一路径行为一致）。
 * ACP 子进程 `spawn(..., { cwd })` 要求 cwd 必须存在。
 */
function ensureAllowedWorkspaceRootsReady(roots: string[]): void {
  for (const workspaceRoot of roots) {
    try {
      if (fs.existsSync(workspaceRoot)) {
        if (!fs.statSync(workspaceRoot).isDirectory()) {
          throw new Error(`BRIDGE_WORK_ALLOWLIST 项不是目录: ${workspaceRoot}`);
        }
        continue;
      }
      fs.mkdirSync(workspaceRoot, { recursive: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `BRIDGE_WORK_ALLOWLIST 路径不可用: ${workspaceRoot}\n` +
          `请创建该目录或修正 .env。若 cwd 不存在，子进程会启动失败（常被误报为 Node ENOENT）。\n` +
          `底层原因: ${msg}`,
      );
    }
  }
}

export function loadConfig(): Config {
  const logLevel = process.env["LOG_LEVEL"] ?? "info";
  if (!LOG_LEVELS.has(logLevel)) {
    throw new Error(
      `Invalid LOG_LEVEL "${logLevel}". Must be one of: debug, info, warn, error`,
    );
  }

  const backend = parseAcpBackend(process.env["ACP_BACKEND"]);
  const enabledBackends = parseEnabledAcpBackends(
    process.env["ACP_ENABLED_BACKENDS"],
    backend,
  );
  if (!enabledBackends.includes(backend)) {
    throw new Error(
      `ACP_BACKEND=${backend} 必须包含在 ACP_ENABLED_BACKENDS 中。`,
    );
  }

  const allowlistRaw =
    process.env["BRIDGE_WORK_ALLOWLIST"]?.trim() ||
    process.env["CURSOR_WORK_ALLOWLIST"]?.trim();
  if (!allowlistRaw) {
    throw new Error(
      "必须设置环境变量 BRIDGE_WORK_ALLOWLIST（推荐）或 CURSOR_WORK_ALLOWLIST（兼容）：\n" +
        "逗号分隔的绝对路径，至少一个。请用 /new list 与 /new <序号> 或 /new <路径> 创建 session。",
    );
  }
  const allowedWorkspaceRoots = allowlistRaw
    .split(",")
    .map((s) => path.resolve(expandHome(s.trim())))
    .filter((p) => p.length > 0);
  if (allowedWorkspaceRoots.length === 0) {
    throw new Error(
      "工作区允许列表解析后为空，请提供至少一个有效路径。",
    );
  }
  ensureAllowedWorkspaceRootsReady(allowedWorkspaceRoots);

  const workspaceRoot = allowedWorkspaceRoots[0]!;

  const defaultAdapterSession = path.join(
    os.homedir(),
    ".feishu-cursor-bridge",
    "cursor-acp-sessions",
  );
  const adapterSessionDir = path.resolve(
    expandHome(
        process.env["CURSOR_LEGACY_SESSION_DIR"]?.trim() ||
        process.env["CURSOR_ACP_SESSION_DIR"]?.trim() ||
        defaultAdapterSession,
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

  const defaultMaintenanceState = path.join(
    os.homedir(),
    ".feishu-cursor-bridge",
    "maintenance-state.json",
  );
  const maintenanceStatePath = path.resolve(
    expandHome(
      process.env["BRIDGE_MAINTENANCE_STATE_FILE"]?.trim() || defaultMaintenanceState,
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
  const managedByService =
    ["1", "true", "yes"].includes(
      (process.env["BRIDGE_MANAGED_BY_SERVICE"] ?? "").trim().toLowerCase(),
    ) ||
    !!process.env["INVOCATION_ID"]?.trim();

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
  const showAcpAvailableCommands =
    (process.env["BRIDGE_SHOW_ACP_AVAILABLE_COMMANDS"] ?? "false").toLowerCase() ===
    "true";

  const defaultPresetsFile = path.join(
    os.homedir(),
    ".feishu-cursor-bridge",
    "workspace-presets.json",
  );
  const workspacePresetsPath = path.resolve(
    expandHome(
      process.env["BRIDGE_WORK_PRESETS_FILE"]?.trim() ||
        process.env["CURSOR_WORK_PRESETS_FILE"]?.trim() ||
        defaultPresetsFile,
    ),
  );

  const presetsSeedRaw =
    process.env["BRIDGE_WORK_PRESETS"]?.trim() ||
    process.env["CURSOR_WORK_PRESETS"]?.trim();
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
  const adminUserIds = parseStringList(process.env["BRIDGE_ADMIN_USER_IDS"]);
  const groupSessionScope = parseGroupSessionScope(
    process.env["BRIDGE_GROUP_SESSION_SCOPE"],
  );

  const cardUpdateThrottleMs = Math.max(
    200,
    Number(process.env["FEISHU_CARD_THROTTLE_MS"] ?? 800) || 800,
  );
  const cardSplitMarkdownThreshold = parsePositiveIntegerThreshold(
    process.env["FEISHU_CARD_SPLIT_MARKDOWN_THRESHOLD"],
    DEFAULT_CARD_SPLIT_MARKDOWN_THRESHOLD,
    500,
  );
  const cardSplitToolThreshold = parsePositiveIntegerThreshold(
    process.env["FEISHU_CARD_SPLIT_TOOL_THRESHOLD"],
    DEFAULT_CARD_SPLIT_TOOL_THRESHOLD,
  );

  const defaultUpgradeResultPath = path.join(
    os.homedir(),
    ".feishu-cursor-bridge",
    "upgrade-result.json",
  );
  const upgradeResultPath = path.resolve(
    expandHome(
      process.env["BRIDGE_UPGRADE_RESULT_FILE"]?.trim() || defaultUpgradeResultPath,
    ),
  );
  const enableUpgradeCommand =
    (process.env["BRIDGE_ENABLE_UPGRADE_COMMAND"] ?? "false").toLowerCase() ===
    "true";
  const upgradeAdmins: UpgradeAdminIds = {
    openIds: parseIdList(process.env["BRIDGE_UPGRADE_ADMIN_OPEN_IDS"]),
    userIds: parseIdList(process.env["BRIDGE_UPGRADE_ADMIN_USER_IDS"]),
    unionIds: parseIdList(process.env["BRIDGE_UPGRADE_ADMIN_UNION_IDS"]),
  };
  const serviceScriptPath = path.resolve(process.cwd(), "service.sh");

  const bridgeFromSource = isBridgeMainScriptSourceIndex();

  let adapterEntry = "";
  let adapterTsxCli: string | undefined;

  if (enabledBackends.includes("cursor-legacy")) {
    if (bridgeFromSource) {
      adapterTsxCli = resolveBundledTsxCliEntry();
      adapterEntry = resolveLegacyAdapterSourceEntry();
    } else {
      adapterEntry = resolveLegacyAdapterDistEntry();
    }
  }

  const nodePath = resolveNodeExecutablePath();

  const extraArgs = parseExtraArgs(
    process.env["CURSOR_LEGACY_EXTRA_ARGS"] ?? process.env["CURSOR_ACP_EXTRA_ARGS"],
  );
  const officialAgentPath =
    process.env["CURSOR_AGENT_PATH"]?.trim() || "agent";
  const officialApiKey = process.env["CURSOR_API_KEY"]?.trim() || undefined;
  const officialAuthToken =
    process.env["CURSOR_AUTH_TOKEN"]?.trim() || undefined;

  const claudeSpawn = resolveClaudeAgentAcpSpawn();
  const codexSpawn = resolveCodexAgentAcpSpawn();

  return {
    feishu: {
      appId: requireEnv("FEISHU_APP_ID"),
      appSecret: requireEnv("FEISHU_APP_SECRET"),
      domain: process.env["FEISHU_DOMAIN"] ?? "feishu",
    },
    acp: {
      backend,
      enabledBackends,
      nodePath,
      adapterEntry,
      ...(adapterTsxCli ? { adapterTsxCli } : {}),
      extraArgs,
      officialAgentPath,
      officialApiKey,
      officialAuthToken,
      claudeSpawnCommand: claudeSpawn.command,
      claudeSpawnArgs: claudeSpawn.args,
      codexSpawnCommand: codexSpawn.command,
      codexSpawnArgs: codexSpawn.args,
      workspaceRoot,
      allowedWorkspaceRoots,
      adapterSessionDir,
    },
    bridge: {
      adminUserIds,
      groupSessionScope,
      maxSessionsPerUser,
      sessionIdleTimeoutMs,
      sessionStorePath,
      cardUpdateThrottleMs,
      cardSplitMarkdownThreshold,
      cardSplitToolThreshold,
      workspacePresetsPath,
      workspacePresetsSeed,
      maintenanceStatePath,
      singleInstanceLockPath,
      allowMultipleInstances,
      managedByService,
      experimentalLogToFile,
      experimentalLogFilePath,
      slotMessageLogEnabled:
        (process.env["BRIDGE_SLOT_LOG_ENABLED"] ?? "false").toLowerCase() ===
        "true",
      showAcpAvailableCommands,
      enableUpgradeCommand,
      upgradeAdmins,
      serviceScriptPath,
      upgradeResultPath,
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
