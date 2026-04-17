#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ClaudeAcpAgent,
  claudeCliPath,
  resolvePermissionMode,
  runAcp,
} from "@agentclientprotocol/claude-agent-acp/dist/acp-agent.js";
import {
  Pushable,
  applyEnvironmentSettings,
  loadManagedSettings,
} from "@agentclientprotocol/claude-agent-acp/dist/utils.js";
import { SettingsManager } from "@agentclientprotocol/claude-agent-acp/dist/settings.js";
import { createPostToolUseHook } from "@agentclientprotocol/claude-agent-acp/dist/tools.js";

type ClaudeSdkMessage = {
  type?: unknown;
  subtype?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
  } | null;
};

type ClaudeUsageUpdateNotification = {
  sessionId: string;
  update: {
    sessionUpdate: string;
    used?: number;
    size?: number;
    cost?: unknown;
    configOptions?: unknown;
    [key: string]: unknown;
  };
};

type ClaudeUsageUpdateClient = {
  sessionUpdate(params: ClaudeUsageUpdateNotification): Promise<void>;
  extNotification: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<void>;
};

type ClaudeUsageUpdateLogger = {
  log?: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

type ClaudeUsagePatchedClient = ClaudeUsageUpdateClient & {
  [CLIENT_PATCH_MARKER]?: boolean;
  [SESSION_USAGE_PROXY_STATE]?: Map<string, SessionUsageProxyState>;
};

type SessionUsageProxyState = {
  latestUsedTokens?: number;
  compactedSinceLatestUsage?: boolean;
  lastKnownMaxTokens?: number;
  suppressCostUsageAfterCompact?: boolean;
};

type ClaudeEffortLevel = "low" | "medium" | "high" | "max";
type RuntimeClaudeEffortLevel = Exclude<ClaudeEffortLevel, "max">;

type ClaudeSupportedModel = {
  modelId: string;
  name?: string;
  supportedEffortLevels: ClaudeEffortLevel[];
};

type ClaudeSettingsResponse = {
  applied?: {
    model?: unknown;
    effort?: unknown;
  } | null;
};

type ClaudeSupportedModelInfo = {
  value?: unknown;
  displayName?: unknown;
  supportsEffort?: unknown;
  supportedEffortLevels?: unknown;
};

type ClaudeQueryLike = {
  setModel(model?: string): Promise<void>;
  applyFlagSettings(settings: Record<string, unknown>): Promise<void>;
  supportedModels(): Promise<unknown[]>;
  getSettings(): Promise<unknown>;
  close(): void;
};

type ClaudeSessionModelInfo = {
  modelId: string;
  name?: string;
};

type ClaudeSessionModelState = {
  currentModelId?: string;
  availableModels: ClaudeSessionModelInfo[];
};

type ClaudeSessionConfigSelectOption = {
  value: string;
  name?: string;
  description?: string;
};

type ClaudeSessionConfigOption = {
  id?: string;
  name?: string;
  description?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: ClaudeSessionConfigSelectOption[];
  [key: string]: unknown;
};

type ClaudeEffortState = {
  baseModels: ClaudeSupportedModel[];
  currentBaseModelId?: string;
  currentEffort?: ClaudeEffortLevel;
};

type ClaudePatchedSession = {
  query: ClaudeQueryLike;
  input?: Pushable<unknown>;
  models: ClaudeSessionModelState;
  configOptions: ClaudeSessionConfigOption[];
  modes?: {
    currentModeId: string;
    availableModes: Array<{
      id: string;
      name?: string;
      description?: string;
    }>;
  };
  settingsManager?: {
    dispose(): void;
  };
  abortController?: {
    abort(): void;
  };
  promptRunning?: boolean;
  pendingMessages?: Map<string, { resolve: (cancelled: boolean) => void }>;
  cancelled?: boolean;
  cwd?: string;
  [SESSION_EFFORT_STATE]?: ClaudeEffortState;
  [SESSION_EFFORT_OVERRIDE]?: ClaudeEffortLevel | undefined;
  [SESSION_REBUILD_CONTEXT]?: ClaudeSessionRebuildContext;
};

type ClaudeSessionParamsLike = {
  cwd: string;
  mcpServers?: unknown[];
  _meta?: Record<string, unknown>;
};

type ClaudeSessionRebuildContext = {
  params: ClaudeSessionParamsLike;
};

type ClaudeEffortPatchedAgent = {
  sessions: Record<string, ClaudePatchedSession | undefined>;
  client: ClaudeUsagePatchedClient;
  logger: ClaudeUsageUpdateLogger;
  newSession?: (params: unknown) => Promise<unknown>;
  unstable_forkSession?: (params: unknown) => Promise<unknown>;
  unstable_resumeSession?: (params: unknown) => Promise<unknown>;
  loadSession?: (params: unknown) => Promise<unknown>;
  unstable_setSessionModel?: (params: {
    sessionId: string;
    modelId: string;
  }) => Promise<unknown>;
  setSessionConfigOption?: (params: {
    sessionId: string;
    configId: string;
    value: unknown;
  }) => Promise<unknown>;
  [EFFORT_PATCH_MARKER]?: boolean;
  createSession?: (
    params: ClaudeSessionParamsLike,
    creationOpts?: Record<string, unknown>,
  ) => Promise<unknown>;
  sendAvailableCommandsUpdate?: (sessionId: string) => Promise<void>;
};

const CLIENT_PATCH_MARKER = Symbol.for(
  "feishu-cursor-bridge/claude-agent-acp-context-patch",
);
const SESSION_USAGE_PROXY_STATE = Symbol.for(
  "feishu-cursor-bridge/claude-agent-acp-context-proxy-state",
);
const EFFORT_PATCH_MARKER = Symbol.for(
  "feishu-cursor-bridge/claude-agent-acp-effort-patch",
);
const SESSION_EFFORT_STATE = Symbol.for(
  "feishu-cursor-bridge/claude-agent-acp-effort-state",
);
const SESSION_EFFORT_OVERRIDE = Symbol.for(
  "feishu-cursor-bridge/claude-agent-acp-effort-override",
);
const SESSION_REBUILD_CONTEXT = Symbol.for(
  "feishu-cursor-bridge/claude-agent-acp-rebuild-context",
);

const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "max"] as const;
const DEFAULT_RUNTIME_EFFORT_LEVELS = ["low", "medium", "high"] as const;
const LOCAL_ALLOW_BYPASS =
  ((process.geteuid?.() ?? process.getuid?.()) !== 0) || !!process.env["IS_SANDBOX"];
let cachedClaudeSdkQuery:
  | ((params: { prompt: Pushable<unknown>; options?: Record<string, unknown> }) => {
      initializationResult(): Promise<unknown>;
      close(): void;
      setModel(model?: string): Promise<void>;
      applyFlagSettings(settings: Record<string, unknown>): Promise<void>;
      supportedModels(): Promise<unknown[]>;
      getSettings(): Promise<unknown>;
    })
  | undefined;

function isClaudeEffortLevel(value: unknown): value is ClaudeEffortLevel {
  return (
    typeof value === "string" &&
    (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(value)
  );
}

function isRuntimeClaudeEffortLevel(
  value: unknown,
): value is RuntimeClaudeEffortLevel {
  return value === "low" || value === "medium" || value === "high";
}

export function parseClaudeModelSelector(
  raw: string,
): { modelId: string; effort?: ClaudeEffortLevel } {
  const trimmed = raw.trim();
  const slash = trimmed.lastIndexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return { modelId: trimmed };
  }
  const tail = trimmed.slice(slash + 1).trim().toLowerCase();
  if (!isClaudeEffortLevel(tail)) {
    return { modelId: trimmed };
  }
  return {
    modelId: trimmed.slice(0, slash).trim(),
    effort: tail,
  };
}

function capitalizeLabel(value: string): string {
  return value.length > 0 ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}

function normalizeSupportedEffortLevels(
  raw: unknown,
  supportsEffort: boolean,
): ClaudeEffortLevel[] {
  if (Array.isArray(raw)) {
    const levels = raw.filter(isClaudeEffortLevel);
    if (levels.length > 0) {
      return [...new Set(levels)];
    }
  }
  return supportsEffort ? [...DEFAULT_RUNTIME_EFFORT_LEVELS] : [];
}

function normalizeClaudeSupportedModel(raw: unknown): ClaudeSupportedModel | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const model = raw as ClaudeSupportedModelInfo;
  const modelId =
    typeof model.value === "string" && model.value.trim()
      ? model.value.trim()
      : "";
  if (!modelId) return undefined;
  const name =
    typeof model.displayName === "string" && model.displayName.trim()
      ? model.displayName.trim()
      : undefined;
  const supportsEffort = model.supportsEffort === true;
  return {
    modelId,
    name,
    supportedEffortLevels: normalizeSupportedEffortLevels(
      model.supportedEffortLevels,
      supportsEffort,
    ),
  };
}

function dedupeClaudeSupportedModels(
  models: ClaudeSupportedModel[],
): ClaudeSupportedModel[] {
  const out: ClaudeSupportedModel[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    if (!model.modelId || seen.has(model.modelId)) continue;
    seen.add(model.modelId);
    out.push({
      modelId: model.modelId,
      name: model.name,
      supportedEffortLevels: [...new Set(model.supportedEffortLevels)],
    });
  }
  return out;
}

function tokenizeClaudeModelPreference(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .trim()
    .toLowerCase()
    .replace(/\[(\d+m)\]/g, " $1 ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((token) => token !== "claude")
    .map((token) => (token === "default" ? "" : token))
    .filter(Boolean);
}

function normalizeClaudeBaseModelId(
  baseModels: ClaudeSupportedModel[],
  requestedModelId: string | undefined,
): string | undefined {
  const trimmed = requestedModelId?.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  const direct = baseModels.find(
    (model) =>
      model.modelId === trimmed ||
      model.modelId.toLowerCase() === lower ||
      model.name?.toLowerCase() === lower,
  );
  if (direct) return direct.modelId;
  const tokens = tokenizeClaudeModelPreference(trimmed);
  if (tokens.length === 0) return trimmed;
  let bestMatch: ClaudeSupportedModel | undefined;
  let bestScore = 0;
  for (const model of baseModels) {
    const haystack = `${model.modelId} ${model.name ?? ""}`.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (haystack.includes(token)) {
        score += token.endsWith("m") ? 2 : 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = model;
    }
  }
  return bestMatch?.modelId ?? trimmed;
}

function buildFallbackClaudeSupportedModels(
  session: ClaudePatchedSession,
): ClaudeSupportedModel[] {
  const out: ClaudeSupportedModel[] = [];
  const modelOption = session.configOptions.find(
    (option) => option.id === "model" || option.category === "model",
  );
  const rawOptionEntries = Array.isArray(modelOption?.options)
    ? modelOption.options
    : [];
  for (const raw of rawOptionEntries) {
    if (!raw || typeof raw !== "object") continue;
    const value =
      typeof raw.value === "string" && raw.value.trim() ? raw.value.trim() : "";
    if (!value) continue;
    out.push({
      modelId: value,
      name:
        typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : undefined,
      supportedEffortLevels: [],
    });
  }
  for (const model of session.models.availableModels) {
    const parsed = parseClaudeModelSelector(model.modelId);
    if (parsed.effort) continue;
    out.push({
      modelId: parsed.modelId,
      name: model.name,
      supportedEffortLevels: [],
    });
  }
  const current = session.models.currentModelId
    ? parseClaudeModelSelector(session.models.currentModelId)
    : undefined;
  if (current?.modelId) {
    out.push({
      modelId: current.modelId,
      supportedEffortLevels: [],
    });
  }
  return dedupeClaudeSupportedModels(out);
}

function cloneRebuildParams(
  params: ClaudeSessionParamsLike,
): ClaudeSessionParamsLike {
  return {
    cwd: params.cwd,
    mcpServers: Array.isArray(params.mcpServers)
      ? structuredClone(params.mcpServers)
      : [],
    _meta:
      params._meta && typeof params._meta === "object"
        ? structuredClone(params._meta)
        : undefined,
  };
}

function captureClaudeSessionRebuildContext(
  agent: ClaudeEffortPatchedAgent,
  sessionId: string | undefined,
  rawParams: unknown,
): void {
  if (!sessionId || !rawParams || typeof rawParams !== "object") {
    return;
  }
  const params = rawParams as {
    cwd?: unknown;
    mcpServers?: unknown;
    _meta?: unknown;
  };
  const cwd = typeof params.cwd === "string" && params.cwd.trim() ? params.cwd : undefined;
  if (!cwd) return;
  const session = agent.sessions[sessionId];
  if (!session) return;
  session[SESSION_REBUILD_CONTEXT] = {
    params: cloneRebuildParams({
      cwd,
      mcpServers: Array.isArray(params.mcpServers) ? params.mcpServers : [],
      _meta:
        params._meta && typeof params._meta === "object"
          ? (params._meta as Record<string, unknown>)
          : undefined,
    }),
  };
}

function cleanupClaudeSessionResources(session: ClaudePatchedSession | undefined): void {
  if (!session) return;
  session.cancelled = true;
  if (session.pendingMessages) {
    for (const [, pending] of session.pendingMessages) {
      pending.resolve(true);
    }
    session.pendingMessages.clear();
  }
  session.settingsManager?.dispose();
  session.abortController?.abort();
  session.query.close();
}

async function loadClaudeSdkQuery() {
  if (cachedClaudeSdkQuery) {
    return cachedClaudeSdkQuery;
  }
  const acpAgentUrl = new URL(
    import.meta.resolve("@agentclientprotocol/claude-agent-acp/dist/acp-agent.js"),
  );
  const sdkUrl = new URL(
    "../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
    acpAgentUrl,
  );
  const module = (await import(sdkUrl.href)) as {
    query: typeof cachedClaudeSdkQuery;
  };
  if (typeof module.query !== "function") {
    throw new Error("Failed to load nested Claude SDK query() export.");
  }
  cachedClaudeSdkQuery = module.query;
  return module.query;
}

function computeClaudeSessionFingerprint(params: ClaudeSessionParamsLike): string {
  const servers = [...(params.mcpServers ?? [])].sort((a, b) => {
    const left =
      a && typeof a === "object" && "name" in (a as Record<string, unknown>)
        ? String((a as Record<string, unknown>).name ?? "")
        : "";
    const right =
      b && typeof b === "object" && "name" in (b as Record<string, unknown>)
        ? String((b as Record<string, unknown>).name ?? "")
        : "";
    return left.localeCompare(right);
  });
  return JSON.stringify({ cwd: params.cwd, mcpServers: servers });
}

function normalizeClaudeSessionMcpServers(
  rawServers: unknown,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  if (!Array.isArray(rawServers)) return out;
  for (const raw of rawServers) {
    if (!raw || typeof raw !== "object") continue;
    const server = raw as Record<string, unknown>;
    const name =
      typeof server.name === "string" && server.name.trim() ? server.name.trim() : "";
    if (!name) continue;
    if (server.type === "http" || server.type === "sse") {
      out[name] = {
        type: server.type,
        url: server.url,
        headers: Array.isArray(server.headers)
          ? Object.fromEntries(
              server.headers
                .map((entry) =>
                  entry && typeof entry === "object"
                    ? [
                        (entry as Record<string, unknown>).name,
                        (entry as Record<string, unknown>).value,
                      ]
                    : undefined,
                )
                .filter(
                  (
                    entry,
                  ): entry is [unknown, unknown] => Array.isArray(entry) && entry.length === 2,
                ),
            )
          : undefined,
      };
      continue;
    }
    out[name] = {
      type: "stdio",
      command: server.command,
      args: server.args,
      env: Array.isArray(server.env)
        ? Object.fromEntries(
            server.env
              .map((entry) =>
                entry && typeof entry === "object"
                  ? [
                      (entry as Record<string, unknown>).name,
                      (entry as Record<string, unknown>).value,
                    ]
                  : undefined,
              )
              .filter(
                (
                  entry,
                ): entry is [unknown, unknown] => Array.isArray(entry) && entry.length === 2,
              ),
          )
        : undefined,
    };
  }
  return out;
}

function buildManualClaudeModeState(currentModeId: string) {
  const availableModes = [
    {
      id: "auto",
      name: "Auto",
      description: "Use a model classifier to approve/deny permission prompts.",
    },
    {
      id: "default",
      name: "Default",
      description: "Standard behavior, prompts for dangerous operations",
    },
    {
      id: "acceptEdits",
      name: "Accept Edits",
      description: "Auto-accept file edit operations",
    },
    {
      id: "plan",
      name: "Plan Mode",
      description: "Planning mode, no actual tool execution",
    },
    {
      id: "dontAsk",
      name: "Don't Ask",
      description: "Don't prompt for permissions, deny if not pre-approved",
    },
  ];
  if (LOCAL_ALLOW_BYPASS) {
    availableModes.push({
      id: "bypassPermissions",
      name: "Bypass Permissions",
      description: "Bypass all permission checks",
    });
  }
  return {
    currentModeId,
    availableModes,
  };
}

function isClaudeSessionNotFoundError(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.message.includes("Resource not found") ||
      error.message.includes("No conversation found")
    );
  }
  if (!error || typeof error !== "object") return false;
  const maybe = error as { message?: unknown };
  return (
    typeof maybe.message === "string" &&
    (maybe.message.includes("Resource not found") ||
      maybe.message.includes("No conversation found"))
  );
}

async function createFreshClaudeSessionWithFixedId(
  agent: ClaudeEffortPatchedAgent,
  sessionId: string,
  params: ClaudeSessionParamsLike,
  effort: ClaudeEffortLevel | undefined,
): Promise<void> {
  const logger = {
    log: agent.logger.log ?? (() => {}),
    error: agent.logger.error,
  };
  const input = new Pushable();
  const settingsManager = new SettingsManager(params.cwd, {
    logger,
  });
  await settingsManager.initialize();

  let systemPrompt: string | { type: "preset"; preset: "claude_code"; append?: string } = {
    type: "preset",
    preset: "claude_code",
  };
  const meta =
    params._meta && typeof params._meta === "object"
      ? (params._meta as Record<string, unknown>)
      : undefined;
  const customPrompt = meta?.["systemPrompt"];
  if (typeof customPrompt === "string") {
    systemPrompt = customPrompt;
  } else if (
    customPrompt &&
    typeof customPrompt === "object" &&
    "append" in (customPrompt as Record<string, unknown>) &&
    typeof (customPrompt as Record<string, unknown>).append === "string"
  ) {
    systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append: (customPrompt as Record<string, string>).append,
    };
  }

  const sessionMeta =
    meta?.["claudeCode"] && typeof meta["claudeCode"] === "object"
      ? (meta["claudeCode"] as Record<string, unknown>)
      : undefined;
  const userProvidedOptions =
    sessionMeta?.["options"] && typeof sessionMeta["options"] === "object"
      ? (sessionMeta["options"] as Record<string, unknown>)
      : undefined;
  const maxThinkingTokens = process.env["MAX_THINKING_TOKENS"]
    ? Number.parseInt(process.env["MAX_THINKING_TOKENS"], 10)
    : undefined;
  const abortController =
    userProvidedOptions?.["abortController"] instanceof AbortController
      ? userProvidedOptions["abortController"]
      : new AbortController();
  const permissionMode = resolvePermissionMode(
    settingsManager.getSettings().permissions?.defaultMode,
  );
  const tools =
    userProvidedOptions?.["tools"] ??
    (meta?.["disableBuiltInTools"] === true
      ? []
      : { type: "preset", preset: "claude_code" });
  const mcpServers = normalizeClaudeSessionMcpServers(params.mcpServers);

  const resolvedClaudeCliPath = process.env["CLAUDE_CODE_EXECUTABLE"]
    ? process.env["CLAUDE_CODE_EXECUTABLE"]
    : await claudeCliPath();
  const pathToClaudeCodeExecutable = {
    pathToClaudeCodeExecutable:
      resolvedClaudeCliPath.startsWith("file:")
        ? fileURLToPath(resolvedClaudeCliPath)
        : resolvedClaudeCliPath,
  };

  const options = {
    systemPrompt,
    settingSources: ["user", "project", "local"],
    ...(maxThinkingTokens !== undefined ? { maxThinkingTokens } : {}),
    ...(userProvidedOptions ?? {}),
    ...(effort ? { effort } : {}),
    env: {
      ...process.env,
      ...(userProvidedOptions?.["env"] && typeof userProvidedOptions["env"] === "object"
        ? (userProvidedOptions["env"] as Record<string, string>)
        : {}),
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
    },
    cwd: params.cwd,
    includePartialMessages: true,
    mcpServers: {
      ...((userProvidedOptions?.["mcpServers"] &&
      typeof userProvidedOptions["mcpServers"] === "object"
        ? (userProvidedOptions["mcpServers"] as Record<string, unknown>)
        : {}) as Record<string, unknown>),
      ...mcpServers,
    },
    allowDangerouslySkipPermissions: LOCAL_ALLOW_BYPASS,
    permissionMode,
    canUseTool:
      typeof (agent as unknown as { canUseTool?: (sessionId: string) => unknown }).canUseTool ===
      "function"
        ? (agent as unknown as { canUseTool: (sessionId: string) => unknown }).canUseTool(
            sessionId,
          )
        : undefined,
    executable: process.execPath,
    ...pathToClaudeCodeExecutable,
    extraArgs: {
      ...((userProvidedOptions?.["extraArgs"] &&
      typeof userProvidedOptions["extraArgs"] === "object"
        ? (userProvidedOptions["extraArgs"] as Record<string, string>)
        : {}) as Record<string, string>),
      "replay-user-messages": "",
    },
    disallowedTools: [
      ...((Array.isArray(userProvidedOptions?.["disallowedTools"])
        ? userProvidedOptions?.["disallowedTools"]
        : []) as string[]),
      "AskUserQuestion",
    ],
    tools,
    hooks: {
      ...((userProvidedOptions?.["hooks"] &&
      typeof userProvidedOptions["hooks"] === "object"
        ? (userProvidedOptions["hooks"] as Record<string, unknown>)
        : {}) as Record<string, unknown>),
      PostToolUse: [
        ...((Array.isArray(
          (userProvidedOptions?.["hooks"] as Record<string, unknown> | undefined)?.[
            "PostToolUse"
          ],
        )
          ? ((userProvidedOptions?.["hooks"] as Record<string, unknown>)?.[
              "PostToolUse"
            ] as unknown[])
          : []) as unknown[]),
        {
          hooks: [
            createPostToolUseHook(logger, {
              onEnterPlanMode: async () => {
                await agent.client.sessionUpdate({
                  sessionId,
                  update: {
                    sessionUpdate: "current_mode_update",
                    currentModeId: "plan",
                  },
                });
              },
            }),
          ],
        },
      ],
    },
    abortController,
    sessionId,
  };

  (options as Record<string, unknown>).additionalDirectories = [
    ...(Array.isArray(userProvidedOptions?.["additionalDirectories"])
      ? (userProvidedOptions["additionalDirectories"] as unknown[])
      : []),
    ...(Array.isArray(meta?.["additionalRoots"]) ? (meta["additionalRoots"] as unknown[]) : []),
  ];

  if (abortController.signal.aborted) {
    throw new Error("Cancelled");
  }

  const q = (await loadClaudeSdkQuery())({
    prompt: input,
    options,
  });
  await q.initializationResult();

  agent.sessions[sessionId] = {
    query: q as unknown as ClaudeQueryLike,
    input,
    cancelled: false,
    cwd: params.cwd,
    sessionFingerprint: computeClaudeSessionFingerprint(params),
    settingsManager,
    accumulatedUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    },
    modes: buildManualClaudeModeState(
      oldSessionModeId(agent.sessions[sessionId]) ?? permissionMode,
    ),
    models: { currentModelId: undefined, availableModels: [] },
    configOptions: [],
    promptRunning: false,
    pendingMessages: new Map(),
    nextPendingOrder: 0,
    abortController,
    emitRawSDKMessages:
      sessionMeta?.["emitRawSDKMessages"] === undefined
        ? false
        : sessionMeta["emitRawSDKMessages"],
    [SESSION_EFFORT_OVERRIDE]: effort,
  } as ClaudePatchedSession;
}

function oldSessionModeId(session: ClaudePatchedSession | undefined): string | undefined {
  return session?.modes?.currentModeId;
}

function getModelEffortLevels(
  state: ClaudeEffortState,
  modelId: string | undefined,
): ClaudeEffortLevel[] {
  if (!modelId) return [];
  return (
    state.baseModels.find((model) => model.modelId === modelId)?.supportedEffortLevels ?? []
  );
}

function resolveClaudeCurrentModelId(
  state: ClaudeEffortState,
): string | undefined {
  const base = state.currentBaseModelId?.trim();
  if (!base) return undefined;
  const effort = state.currentEffort;
  if (!effort) return base;
  return getModelEffortLevels(state, base).includes(effort)
    ? `${base}/${effort}`
    : base;
}

export function buildClaudeEffortEnhancedModelState(
  state: ClaudeEffortState,
): ClaudeSessionModelState {
  const availableModels: ClaudeSessionModelInfo[] = [];
  const seen = new Set<string>();
  const pushModel = (modelId: string, name?: string) => {
    if (!modelId || seen.has(modelId)) return;
    seen.add(modelId);
    availableModels.push(name ? { modelId, name } : { modelId });
  };
  for (const model of state.baseModels) {
    pushModel(model.modelId, model.name);
    for (const effort of model.supportedEffortLevels) {
      const effortSelector = `${model.modelId}/${effort}`;
      const effortName = model.name
        ? `${model.name} / ${effort}`
        : undefined;
      pushModel(effortSelector, effortName);
    }
  }
  const currentModelId = resolveClaudeCurrentModelId(state);
  return {
    currentModelId,
    availableModels,
  };
}

export function buildClaudeEffortConfigOptions(
  previous: ClaudeSessionConfigOption[],
  state: ClaudeEffortState,
): ClaudeSessionConfigOption[] {
  const next = previous
    .filter(
      (option) =>
        option.id !== "reasoning_effort" && option.category !== "thought_level",
    )
    .map((option) => ({ ...option }));
  const modelOptions = state.baseModels.map((model) => ({
    value: model.modelId,
    name: model.name ?? model.modelId,
  }));
  const modelOptionIndex = next.findIndex(
    (option) => option.id === "model" || option.category === "model",
  );
  const currentBaseModelId = state.currentBaseModelId;
  if (modelOptionIndex >= 0) {
    next[modelOptionIndex] = {
      ...next[modelOptionIndex],
      currentValue: currentBaseModelId,
      options: modelOptions,
    };
  } else {
    next.push({
      id: "model",
      name: "Model",
      description: "AI model to use",
      category: "model",
      type: "select",
      currentValue: currentBaseModelId,
      options: modelOptions,
    });
  }
  const effortLevels = getModelEffortLevels(state, currentBaseModelId);
  if (effortLevels.length > 0) {
    next.push({
      id: "reasoning_effort",
      name: "Reasoning Effort",
      description: "Claude reasoning effort level",
      category: "thought_level",
      type: "select",
      currentValue: state.currentEffort,
      options: effortLevels.map((level) => ({
        value: level,
        name: capitalizeLabel(level),
        description: `Claude ${level} reasoning effort`,
      })),
    });
  }
  return next;
}

function extractAppliedClaudeSettings(
  raw: unknown,
): {
  modelId?: string;
  effort?: ClaudeEffortLevel;
  hasModel: boolean;
  hasEffort: boolean;
} {
  if (!raw || typeof raw !== "object") {
    return {
      hasModel: false,
      hasEffort: false,
    };
  }
  const settings = raw as ClaudeSettingsResponse;
  const applied = settings.applied;
  const hasModel =
    !!applied && Object.prototype.hasOwnProperty.call(applied, "model");
  const hasEffort =
    !!applied && Object.prototype.hasOwnProperty.call(applied, "effort");
  const modelId =
    applied && typeof applied.model === "string" && applied.model.trim()
      ? applied.model.trim()
      : undefined;
  const effort = isClaudeEffortLevel(applied?.effort) ? applied.effort : undefined;
  return { modelId, effort, hasModel, hasEffort };
}

async function resolveClaudeEffortState(
  session: ClaudePatchedSession,
): Promise<ClaudeEffortState> {
  const supportedModelsRaw = await session.query
    .supportedModels()
    .catch(() => [] as unknown[]);
  const supportedModels = dedupeClaudeSupportedModels(
    supportedModelsRaw
      .map(normalizeClaudeSupportedModel)
      .filter((model): model is ClaudeSupportedModel => model != null),
  );
  const baseModels =
    supportedModels.length > 0
      ? supportedModels
      : buildFallbackClaudeSupportedModels(session);
  const settings = extractAppliedClaudeSettings(
    await session.query.getSettings().catch(() => undefined),
  );
  const parsedCurrent = session.models.currentModelId
    ? parseClaudeModelSelector(session.models.currentModelId)
    : undefined;
  const currentBaseModelId = normalizeClaudeBaseModelId(
    baseModels,
    (settings.hasModel ? settings.modelId : undefined) ??
      parsedCurrent?.modelId ??
      baseModels[0]?.modelId,
  );
  const requestedEffort = settings.hasEffort
    ? settings.effort
    : parsedCurrent?.effort ?? session[SESSION_EFFORT_OVERRIDE];
  const supportedEffortLevels = getModelEffortLevels(
    { baseModels, currentBaseModelId },
    currentBaseModelId,
  );
  const currentEffort = requestedEffort
    ? supportedEffortLevels.includes(requestedEffort)
      ? requestedEffort
      : undefined
    : undefined;
  return {
    baseModels,
    currentBaseModelId,
    currentEffort,
  };
}

async function refreshClaudeSessionEffortState(
  agent: ClaudeEffortPatchedAgent,
  sessionId: string,
): Promise<void> {
  const session = agent.sessions[sessionId];
  if (!session) return;
  const state = await resolveClaudeEffortState(session);
  session[SESSION_EFFORT_STATE] = state;
  session[SESSION_EFFORT_OVERRIDE] = state.currentEffort;
  session.models = buildClaudeEffortEnhancedModelState(state);
  session.configOptions = buildClaudeEffortConfigOptions(
    session.configOptions,
    state,
  );
}

async function recreateClaudeSessionWithEffort(
  agent: ClaudeEffortPatchedAgent,
  sessionId: string,
  modelId: string,
  effort: ClaudeEffortLevel | undefined,
): Promise<void> {
  const oldSession = assertClaudeSession(agent, sessionId);
  if (oldSession.promptRunning) {
    throw new Error(
      "Claude session cannot be rebuilt for effort changes while a prompt is still running.",
    );
  }
  const rebuildParams = oldSession[SESSION_REBUILD_CONTEXT]?.params ?? {
    cwd: oldSession.cwd?.trim() || process.cwd(),
    mcpServers: [],
  };
  if (typeof agent.createSession !== "function") {
    throw new Error("Claude ACP createSession() is unavailable for effort rebuild.");
  }

  let newSessionReady = false;
  try {
    try {
      await agent.createSession(cloneRebuildParams(rebuildParams), {
        resume: sessionId,
        ...(effort ? { effort } : {}),
      });
    } catch (error) {
      if (!isClaudeSessionNotFoundError(error)) {
        throw error;
      }
      await createFreshClaudeSessionWithFixedId(
        agent,
        sessionId,
        cloneRebuildParams(rebuildParams),
        effort,
      );
    }
    const newSession = assertClaudeSession(agent, sessionId);
    captureClaudeSessionRebuildContext(agent, sessionId, rebuildParams);
    await newSession.query.setModel(modelId);
    if (effort && effort !== "max") {
      await newSession.query.applyFlagSettings({
        model: modelId,
        effortLevel: effort,
      });
    }
    await refreshClaudeSessionEffortState(agent, sessionId);
    await agent.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: newSession.configOptions,
      },
    });
    await agent.sendAvailableCommandsUpdate?.(sessionId);
    newSessionReady = true;
  } finally {
    if (newSessionReady) {
      cleanupClaudeSessionResources(oldSession);
    } else {
      const maybeNewSession = agent.sessions[sessionId];
      if (maybeNewSession && maybeNewSession !== oldSession) {
        cleanupClaudeSessionResources(maybeNewSession);
        agent.sessions[sessionId] = oldSession;
      }
    }
  }
}

function assertClaudeSession(
  agent: ClaudeEffortPatchedAgent,
  sessionId: string,
): ClaudePatchedSession {
  const session = agent.sessions[sessionId];
  if (!session) {
    throw new Error("Session not found");
  }
  return session;
}

function buildUnsupportedEffortError(
  modelId: string,
  effort: ClaudeEffortLevel,
): Error {
  return new Error(
    `Model \`${modelId}\` does not support Claude effort \`${effort}\`.`,
  );
}

async function applyClaudeModelSelector(
  agent: ClaudeEffortPatchedAgent,
  sessionId: string,
  rawModelId: string,
): Promise<void> {
  const session = assertClaudeSession(agent, sessionId);
  await refreshClaudeSessionEffortState(agent, sessionId);
  const selector = parseClaudeModelSelector(rawModelId);
  if (!selector.modelId) {
    throw new Error("Invalid Claude model selector.");
  }
  const currentState = session[SESSION_EFFORT_STATE] ?? {
    baseModels: buildFallbackClaudeSupportedModels(session),
  };
  const supportedEffortLevels = getModelEffortLevels(currentState, selector.modelId);
  const nextEffort =
    selector.effort ??
    (currentState.currentEffort &&
    supportedEffortLevels.includes(currentState.currentEffort)
      ? currentState.currentEffort
      : undefined);
  if (
    nextEffort &&
    supportedEffortLevels.length > 0 &&
    !supportedEffortLevels.includes(nextEffort)
  ) {
    throw buildUnsupportedEffortError(selector.modelId, nextEffort);
  }
  if (nextEffort === "max" || currentState.currentEffort === "max") {
    await recreateClaudeSessionWithEffort(
      agent,
      sessionId,
      selector.modelId,
      nextEffort,
    );
    return;
  }

  await session.query.setModel(selector.modelId);
  const nextSettings: Record<string, unknown> = {
    model: selector.modelId,
  };
  if (nextEffort) {
    nextSettings.effortLevel = nextEffort;
  }
  await session.query.applyFlagSettings(nextSettings);
  await refreshClaudeSessionEffortState(agent, sessionId);
  await agent.client.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: "config_option_update",
      configOptions: session.configOptions,
    },
  });
}

async function wrapClaudeSessionResponse(
  agent: ClaudeEffortPatchedAgent,
  sessionId: string | undefined,
  response: unknown,
): Promise<unknown> {
  if (!sessionId) return response;
  await refreshClaudeSessionEffortState(agent, sessionId);
  const session = agent.sessions[sessionId];
  if (!session || !response || typeof response !== "object") {
    return response;
  }
  const result = response as {
    models?: ClaudeSessionModelState;
    configOptions?: ClaudeSessionConfigOption[];
  };
  if ("models" in result) {
    result.models = session.models;
  }
  if ("configOptions" in result) {
    result.configOptions = session.configOptions;
  }
  return result;
}

export function patchClaudeAcpAgentEffortSupport(
  agent: ClaudeEffortPatchedAgent,
): void {
  if (agent[EFFORT_PATCH_MARKER]) {
    return;
  }

  const originalNewSession = agent.newSession?.bind(agent);
  const originalForkSession = agent.unstable_forkSession?.bind(agent);
  const originalResumeSession = agent.unstable_resumeSession?.bind(agent);
  const originalLoadSession = agent.loadSession?.bind(agent);
  const originalSetSessionModel = agent.unstable_setSessionModel?.bind(agent);
  const originalSetSessionConfigOption = agent.setSessionConfigOption?.bind(agent);

  if (originalNewSession) {
    agent.newSession = async (params: unknown) => {
      const response = await originalNewSession(params);
      captureClaudeSessionRebuildContext(
        agent,
        (response as { sessionId?: string }).sessionId,
        params,
      );
      return wrapClaudeSessionResponse(
        agent,
        (response as { sessionId?: string }).sessionId,
        response,
      );
    };
  }

  if (originalForkSession) {
    agent.unstable_forkSession = async (params: unknown) => {
      const response = await originalForkSession(params);
      captureClaudeSessionRebuildContext(
        agent,
        (response as { sessionId?: string }).sessionId,
        params,
      );
      return wrapClaudeSessionResponse(
        agent,
        (response as { sessionId?: string }).sessionId,
        response,
      );
    };
  }

  if (originalResumeSession) {
    agent.unstable_resumeSession = async (params: unknown) => {
      const response = await originalResumeSession(params);
      captureClaudeSessionRebuildContext(
        agent,
        (response as { sessionId?: string }).sessionId,
        params,
      );
      return wrapClaudeSessionResponse(
        agent,
        (response as { sessionId?: string }).sessionId,
        response,
      );
    };
  }

  if (originalLoadSession) {
    agent.loadSession = async (params: unknown) => {
      const response = await originalLoadSession(params);
      const sessionId =
        response && typeof response === "object" && "sessionId" in response
          ? (response as { sessionId?: string }).sessionId
          : params &&
              typeof params === "object" &&
              "sessionId" in (params as Record<string, unknown>)
            ? ((params as { sessionId?: string }).sessionId ?? undefined)
            : undefined;
      captureClaudeSessionRebuildContext(agent, sessionId, params);
      return wrapClaudeSessionResponse(agent, sessionId, response);
    };
  }

  if (originalSetSessionModel) {
    agent.unstable_setSessionModel = async ({ sessionId, modelId }) => {
      await applyClaudeModelSelector(agent, sessionId, modelId);
      return undefined;
    };
  }

  if (originalSetSessionConfigOption) {
    agent.setSessionConfigOption = async ({ sessionId, configId, value }) => {
      if (configId === "model") {
        if (typeof value !== "string") {
          throw new Error(`Invalid value for config option ${configId}: ${value}`);
        }
        await applyClaudeModelSelector(agent, sessionId, value);
        return {
          configOptions: assertClaudeSession(agent, sessionId).configOptions,
        };
      }
      if (configId === "reasoning_effort" || configId === "thought_level") {
        if (typeof value !== "string" || !isRuntimeClaudeEffortLevel(value.trim())) {
          throw new Error(`Invalid value for config option ${configId}: ${value}`);
        }
        await refreshClaudeSessionEffortState(agent, sessionId);
        const session = assertClaudeSession(agent, sessionId);
        const baseModelId =
          session[SESSION_EFFORT_STATE]?.currentBaseModelId ??
          parseClaudeModelSelector(session.models.currentModelId ?? "").modelId;
        if (!baseModelId) {
          throw new Error(
            "Claude effort cannot be changed before the current base model is known.",
          );
        }
        await applyClaudeModelSelector(
          agent,
          sessionId,
          `${baseModelId}/${value.trim()}`,
        );
        return {
          configOptions: assertClaudeSession(agent, sessionId).configOptions,
        };
      }
      return originalSetSessionConfigOption({ sessionId, configId, value });
    };
  }

  agent[EFFORT_PATCH_MARKER] = true;
}

function extractUsedTokensFromResultMessage(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const message = raw as ClaudeSdkMessage;
  if (message.type !== "result") return undefined;
  const usage = message.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  if (
    typeof inputTokens !== "number" ||
    !Number.isFinite(inputTokens) ||
    inputTokens < 0 ||
    typeof outputTokens !== "number" ||
    !Number.isFinite(outputTokens) ||
    outputTokens < 0
  ) {
    return undefined;
  }
  return Math.floor(inputTokens + outputTokens);
}

function isCompactBoundaryMessage(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const message = raw as ClaudeSdkMessage;
  return message.type === "system" && message.subtype === "compact_boundary";
}

export function buildAccurateClaudeContextUsageUpdate(
  sessionId: string,
  usedTokens: number,
  maxTokens: number,
): ClaudeUsageUpdateNotification | undefined {
  if (
    !Number.isFinite(usedTokens) ||
    usedTokens <= 0 ||
    !Number.isFinite(maxTokens) ||
    maxTokens <= 0
  ) {
    return undefined;
  }
  return {
    sessionId,
    update: {
      sessionUpdate: "usage_update",
      used: Math.floor(usedTokens),
      size: Math.floor(maxTokens),
    },
  };
}

export function patchClaudeAcpAgentContextUsage(
  agent: {
    client: ClaudeUsagePatchedClient;
    logger: ClaudeUsageUpdateLogger;
  },
): void {
  const client = agent.client;
  if (client[CLIENT_PATCH_MARKER]) {
    return;
  }

  const originalSessionUpdate = client.sessionUpdate.bind(client);
  const originalExtNotification = client.extNotification.bind(client);
  const stateBySession = new Map<string, SessionUsageProxyState>();
  client[SESSION_USAGE_PROXY_STATE] = stateBySession;

  client.extNotification = async (method, notificationParams) => {
    if (method === "_claude/sdkMessage") {
      const sessionId =
        typeof notificationParams.sessionId === "string"
          ? notificationParams.sessionId
          : undefined;
      if (sessionId) {
        const current = stateBySession.get(sessionId) ?? {};
        const usedTokens = extractUsedTokensFromResultMessage(
          notificationParams.message,
        );
        if (usedTokens != null) {
          if (!current.suppressCostUsageAfterCompact) {
            current.latestUsedTokens = usedTokens;
            current.compactedSinceLatestUsage = false;
          }
        } else if (isCompactBoundaryMessage(notificationParams.message)) {
          current.latestUsedTokens = undefined;
          current.compactedSinceLatestUsage = true;
          current.suppressCostUsageAfterCompact = true;
        }
        stateBySession.set(sessionId, current);
      }
    }

    await originalExtNotification(method, notificationParams);
  };

  client.sessionUpdate = async (notification) => {
    const update = notification.update;
    if (
      update?.sessionUpdate === "usage_update" &&
      update.cost == null &&
      typeof notification.sessionId === "string"
    ) {
      const current = stateBySession.get(notification.sessionId);
      if (
        current?.compactedSinceLatestUsage &&
        typeof current.lastKnownMaxTokens === "number" &&
        Number.isFinite(current.lastKnownMaxTokens) &&
        current.lastKnownMaxTokens > 0
      ) {
        current.compactedSinceLatestUsage = false;
        stateBySession.set(notification.sessionId, current);
        await originalSessionUpdate({
          ...notification,
          update: {
            ...update,
            size: current.lastKnownMaxTokens,
          },
        });
        return;
      }
    }
    if (
      update?.sessionUpdate === "usage_update" &&
      update.cost != null &&
      typeof notification.sessionId === "string"
    ) {
      const current = stateBySession.get(notification.sessionId);
      if (current?.compactedSinceLatestUsage) {
        current.compactedSinceLatestUsage = false;
        stateBySession.set(notification.sessionId, current);
        await originalSessionUpdate(notification);
        return;
      }
      if (
        current?.suppressCostUsageAfterCompact &&
        typeof current.lastKnownMaxTokens === "number" &&
        Number.isFinite(current.lastKnownMaxTokens) &&
        current.lastKnownMaxTokens > 0
      ) {
        current.suppressCostUsageAfterCompact = false;
        current.latestUsedTokens = undefined;
        stateBySession.set(notification.sessionId, current);
        await originalSessionUpdate({
          ...notification,
          update: {
            ...update,
            used: 0,
            size: current.lastKnownMaxTokens,
          },
        });
        return;
      }
      if (
        current?.latestUsedTokens != null &&
        typeof update.size === "number" &&
        Number.isFinite(update.size) &&
        update.size > 0
      ) {
        const corrected = buildAccurateClaudeContextUsageUpdate(
          notification.sessionId,
          current.latestUsedTokens,
          update.size,
        );
        if (corrected) {
          current.lastKnownMaxTokens = corrected.update.size;
          current.latestUsedTokens = undefined;
          stateBySession.set(notification.sessionId, current);
          await originalSessionUpdate(corrected);
          return;
        }
      }
      if (
        current &&
        typeof update.size === "number" &&
        Number.isFinite(update.size) &&
        update.size > 0
      ) {
        current.lastKnownMaxTokens = update.size;
        stateBySession.set(notification.sessionId, current);
      }
    }

    await originalSessionUpdate(notification);
  };

  client[CLIENT_PATCH_MARKER] = true;
}

function isEntrypoint(): boolean {
  return (
    process.argv[1] != null &&
    pathToFileURL(process.argv[1]).href === import.meta.url
  );
}

if (isEntrypoint()) {
  if (process.argv.includes("--cli")) {
    process.argv = process.argv.filter((arg) => arg !== "--cli");
    await import(await claudeCliPath());
  } else {
    const managedSettings = loadManagedSettings();
    if (managedSettings) {
      applyEnvironmentSettings(managedSettings);
    }

    // stdout is used by ACP transport; route incidental logging to stderr.
    console.log = console.error;
    console.info = console.error;
    console.warn = console.error;
    console.debug = console.error;

    process.on("unhandledRejection", (reason, promise) => {
      console.error("Unhandled Rejection at:", promise, "reason:", reason);
    });

    const { connection, agent } = runAcp();
    patchClaudeAcpAgentEffortSupport(agent as unknown as ClaudeEffortPatchedAgent);
    patchClaudeAcpAgentContextUsage(agent);

    async function shutdown() {
      await agent.dispose().catch((err) => {
        console.error("Error during cleanup:", err);
      });
      process.exit(0);
    }

    connection.closed.then(shutdown);
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    process.stdin.resume();
  }
}
