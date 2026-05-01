import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as readline from "node:readline";
import type { InitializeResponse } from "@agentclientprotocol/sdk";
import type { Config } from "../config/index.js";
import { FeishuBridgeClient } from "./feishu-bridge-client.js";
import type { BridgeAcpEvent } from "./types.js";
import type {
  AcpBackend,
  AcpModeInfo,
  AcpModelInfo,
  AcpNewSessionOptions,
  AcpNewSessionResult,
  AcpPromptResult,
  AcpSessionModeState,
  AcpSessionModelState,
  AcpSessionUsageState,
  BridgeAcpRuntime,
} from "./runtime-contract.js";
import { ContentLengthJsonRpcPeer, type JsonRpcError } from "./codex-app-server-rpc.js";

type SpawnSpec = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  label: string;
};

type ThreadModelOverride = {
  model?: string;
  reasoningEffort?: string;
};

type PendingTurn = {
  resolve: (result: AcpPromptResult) => void;
  reject: (reason: unknown) => void;
  turnId?: string;
  resolved: boolean;
};

const APP_SERVER_PROTOCOL_VERSION = "codex-app-server/v2";
const MODE_UNSUPPORTED_ERROR =
  "Codex app-server backend 当前未提供等价于 ACP `session/set_mode` 的稳定接口。";

const BUILTIN_MODE_STATE: AcpSessionModeState = {
  currentModeId: "agent",
  availableModes: [
    { modeId: "agent", name: "Agent" },
    { modeId: "plan", name: "Plan" },
  ],
};

const REASONING_EFFORT_VALUES = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

type ModelCatalogEntry = {
  selector: string;
  model: string;
  reasoningEffort?: string;
  name?: string;
};

export class CodexAppServerRuntime implements BridgeAcpRuntime {
  readonly backend = "codex-app-server" as const satisfies AcpBackend;
  readonly bridgeClient: FeishuBridgeClient;

  private readonly config: Config;
  private child: ChildProcess | null = null;
  private rpc: ContentLengthJsonRpcPeer | null = null;
  private initialized = false;
  private initResultValue: InitializeResponse | null = null;

  private readonly sessionModeStates = new Map<string, AcpSessionModeState>();
  private readonly sessionModelStates = new Map<string, AcpSessionModelState>();
  private readonly sessionUsageStates = new Map<string, AcpSessionUsageState>();
  private readonly threadModelOverrides = new Map<string, ThreadModelOverride>();
  private readonly pendingTurns = new Map<string, PendingTurn>();

  private availableModels: AcpModelInfo[] = [];
  private modelCatalog = new Map<string, ModelCatalogEntry>();

  constructor(config: Config, bridgeClient: FeishuBridgeClient) {
    this.config = config;
    this.bridgeClient = bridgeClient;
  }

  get initializeResult(): InitializeResponse | null {
    return this.initResultValue;
  }

  get supportsLoadSession(): boolean {
    return true;
  }

  get supportsSetSessionMode(): boolean {
    return false;
  }

  get supportsSetSessionModel(): boolean {
    return true;
  }

  supportsCloseSession(): boolean {
    return true;
  }

  getSessionModeState(_sessionId: string): AcpSessionModeState | undefined {
    return undefined;
  }

  getSessionModelState(sessionId: string): AcpSessionModelState | undefined {
    const state = this.sessionModelStates.get(sessionId);
    return state
      ? {
          currentModelId: state.currentModelId,
          availableModels: state.availableModels.map((model) => ({ ...model })),
        }
      : undefined;
  }

  getSessionUsageState(sessionId: string): AcpSessionUsageState | undefined {
    const state = this.sessionUsageStates.get(sessionId);
    return state ? { ...state } : undefined;
  }

  async start(): Promise<void> {
    if (this.child) {
      throw new Error("Codex app-server runtime already running");
    }

    const spec = this.createSpawnSpec();
    if (this.config.bridgeDebug || this.config.logLevel === "debug") {
      console.log(
        `[app-server] spawn backend=${this.backend} cwd=${spec.cwd} command=${spec.command} args=${JSON.stringify(spec.args)}`,
      );
    }

    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.on("error", (error) => {
      console.error(`[app-server] ${spec.label} process error:`, error);
    });

    child.on("close", (code, signal) => {
      console.log(
        `[app-server] ${spec.label} exited code=${code} signal=${signal}`,
      );
      this.rpc?.dispose(
        new Error(
          `Codex app-server exited unexpectedly (code=${code}, signal=${signal})`,
        ),
      );
      this.rpc = null;
      this.child = null;
      this.initialized = false;
      this.rejectPendingTurns(
        new Error("Codex app-server stopped while a turn was still running"),
      );
    });

    if (child.stderr) {
      const rl = readline.createInterface({ input: child.stderr });
      rl.on("line", (line) => {
        if (this.config.logLevel === "debug") {
          console.warn("[app-server stderr]", line);
        } else if (line.toLowerCase().includes("error")) {
          console.warn("[app-server stderr]", line);
        }
      });
    }

    if (!child.stdin || !child.stdout) {
      throw new Error(`${spec.label} missing stdio pipes`);
    }

    this.rpc = new ContentLengthJsonRpcPeer({
      stdin: child.stdin,
      stdout: child.stdout,
      requestHandler: async (method, params) =>
        await this.handleServerRequest(method, params),
      notificationHandler: async (method, params) =>
        await this.handleServerNotification(method, params),
    });
  }

  async initializeAndAuth(): Promise<void> {
    const rpc = this.requireStartedRpc();
    const raw = (await rpc.request("initialize", {
      clientInfo: {
        name: "feishu-cursor-bridge",
        version: "1.0.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    })) as {
      userAgent?: string;
      codexHome?: string;
      platformOs?: string;
    };

    this.initResultValue = {
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
      },
      _meta: {
        codexHome:
          typeof raw.codexHome === "string" ? raw.codexHome : undefined,
        platformOs:
          typeof raw.platformOs === "string" ? raw.platformOs : undefined,
        userAgent:
          typeof raw.userAgent === "string" ? raw.userAgent : undefined,
      },
    } as unknown as InitializeResponse;
    this.initialized = true;

    try {
      await this.refreshAvailableModels();
    } catch (error) {
      console.warn(
        "[app-server] failed to fetch Codex app-server model list:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  async newSession(
    cwd?: string,
    _options?: AcpNewSessionOptions,
  ): Promise<AcpNewSessionResult> {
    const rpc = this.requireRpc();
    const dir = path.resolve(cwd ?? this.config.acp.workspaceRoot);
    const response = (await rpc.request("thread/start", {
      cwd: dir,
      sandbox: this.resolveSandboxMode(),
      approvalPolicy: this.resolveApprovalPolicy(),
      serviceName: "feishu-cursor-bridge",
    })) as ThreadResponseShape;
    const threadId = extractThreadId(response);
    if (!threadId) {
      throw new Error("Codex app-server thread/start returned no thread id");
    }
    this.bridgeClient.setSessionWorkspace(threadId, dir);
    this.sessionModeStates.set(threadId, { ...BUILTIN_MODE_STATE });
    this.updateModelState(threadId, response);
    return { sessionId: threadId };
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    const rpc = this.requireRpc();
    const dir = path.resolve(cwd);
    const response = (await rpc.request("thread/resume", {
      threadId: sessionId,
      cwd: dir,
      sandbox: this.resolveSandboxMode(),
      approvalPolicy: this.resolveApprovalPolicy(),
      excludeTurns: true,
    })) as ThreadResponseShape;
    const threadId = extractThreadId(response);
    if (threadId && threadId !== sessionId) {
      throw new Error(
        `Codex app-server resumed thread id mismatch: expected ${sessionId}, got ${threadId}`,
      );
    }
    this.bridgeClient.setSessionWorkspace(sessionId, dir);
    this.sessionModeStates.set(sessionId, { ...BUILTIN_MODE_STATE });
    this.updateModelState(sessionId, response);
  }

  async prompt(sessionId: string, text: string): Promise<AcpPromptResult> {
    const rpc = this.requireRpc();
    if (this.pendingTurns.has(sessionId)) {
      throw new Error("当前 Codex thread 已有正在进行中的 turn。");
    }

    const pending = createPendingTurn();
    this.pendingTurns.set(sessionId, pending);

    const override = this.threadModelOverrides.get(sessionId);
    try {
      const response = (await rpc.request("turn/start", {
        threadId: sessionId,
        input: [{ type: "text", text }],
        ...(override?.model ? { model: override.model } : {}),
        ...(override?.reasoningEffort
          ? { effort: override.reasoningEffort }
          : {}),
      })) as {
        turn?: {
          id?: string;
          status?: string;
          error?: { message?: string | null } | null;
        };
      };

      const turnId =
        typeof response.turn?.id === "string" ? response.turn.id : undefined;
      if (turnId) {
        pending.turnId = turnId;
      }

      const turnStatus =
        typeof response.turn?.status === "string"
          ? response.turn.status
          : "inProgress";
      if (turnStatus !== "inProgress") {
        this.completeTurnFromStatus(
          sessionId,
          turnStatus,
          response.turn?.error?.message ?? undefined,
        );
      }
      return await pending.promise;
    } catch (error) {
      this.pendingTurns.delete(sessionId);
      throw error;
    }
  }

  async setSessionMode(_sessionId: string, _modeId: string): Promise<void> {
    throw new Error(MODE_UNSUPPORTED_ERROR);
  }

  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    const trimmed = modelId.trim();
    if (!trimmed) {
      throw new Error("模型 ID 不能为空。");
    }

    const resolved = this.resolveModelSelector(trimmed);
    const nextSelector = resolved.selector;
    this.threadModelOverrides.set(sessionId, {
      model: resolved.model,
      reasoningEffort: resolved.reasoningEffort,
    });

    const current = this.sessionModelStates.get(sessionId);
    this.sessionModelStates.set(sessionId, {
      currentModelId: nextSelector,
      availableModels:
        current?.availableModels.map((model) => ({ ...model })) ??
        this.availableModels.map((model) => ({ ...model })),
    });
  }

  async cancelSession(sessionId: string): Promise<void> {
    const rpc = this.rpc;
    const pending = this.pendingTurns.get(sessionId);
    if (!rpc || !pending?.turnId) return;
    try {
      await rpc.request("turn/interrupt", {
        threadId: sessionId,
        turnId: pending.turnId,
      });
    } catch {
      // ignore interrupt failures so /stop remains best-effort
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    const rpc = this.rpc;
    this.pendingTurns.delete(sessionId);
    this.threadModelOverrides.delete(sessionId);
    this.sessionModeStates.delete(sessionId);
    this.sessionModelStates.delete(sessionId);
    this.sessionUsageStates.delete(sessionId);
    this.bridgeClient.removeSessionWorkspace(sessionId);
    if (!rpc) return;
    try {
      await rpc.request("thread/unsubscribe", { threadId: sessionId });
    } catch {
      // ignore unsubscribe failures when bridge is dropping a session
    }
  }

  async stop(): Promise<void> {
    this.rejectPendingTurns(new Error("Codex app-server runtime stopped"));
    this.rpc?.dispose(new Error("Codex app-server runtime stopped"));
    this.rpc = null;
    if (this.child) {
      this.child.stdin?.end();
      this.child.kill();
      this.child = null;
    }
    this.initialized = false;
    this.initResultValue = null;
    this.sessionModeStates.clear();
    this.sessionModelStates.clear();
    this.sessionUsageStates.clear();
    this.threadModelOverrides.clear();
  }

  private createSpawnSpec(): SpawnSpec {
    const command =
      this.config.acp.codexAppServerSpawnCommand?.trim() || "codex";
    const configuredArgs = [
      ...(this.config.acp.codexAppServerSpawnArgs ?? []),
    ];
    const args =
      configuredArgs[0] === "app-server"
        ? configuredArgs
        : ["app-server", ...configuredArgs];
    return {
      command,
      args,
      cwd: this.config.acp.workspaceRoot,
      env: { ...process.env },
      label: "codex app-server",
    };
  }

  private requireRpc(): ContentLengthJsonRpcPeer {
    if (!this.rpc || !this.initialized) {
      throw new Error("Codex app-server runtime is not initialized");
    }
    return this.rpc;
  }

  private requireStartedRpc(): ContentLengthJsonRpcPeer {
    if (!this.rpc) {
      throw new Error("Codex app-server runtime has not been started");
    }
    return this.rpc;
  }

  private resolveSandboxMode(): string {
    return this.config.autoApprovePermissions
      ? "danger-full-access"
      : "workspace-write";
  }

  private resolveApprovalPolicy(): string {
    return this.config.autoApprovePermissions ? "never" : "on-request";
  }

  private async refreshAvailableModels(): Promise<void> {
    const rpc = this.requireRpc();
    const availableModels: AcpModelInfo[] = [];
    const catalog = new Map<string, ModelCatalogEntry>();
    let cursor: string | undefined;

    while (true) {
      const response = (await rpc.request("model/list", {
        ...(cursor ? { cursor } : {}),
      })) as {
        data?: Array<{
          id?: string;
          model?: string;
          displayName?: string;
          defaultReasoningEffort?: string;
          supportedReasoningEfforts?: Array<{
            reasoningEffort?: string;
            description?: string;
          }>;
        }>;
        nextCursor?: string | null;
      };

      for (const item of response.data ?? []) {
        const baseModel =
          typeof item.model === "string" && item.model.trim()
            ? item.model.trim()
            : typeof item.id === "string" && item.id.trim()
              ? item.id.trim()
              : "";
        if (!baseModel) continue;
        const displayName =
          typeof item.displayName === "string" && item.displayName.trim()
            ? item.displayName.trim()
            : undefined;
        const supportedEfforts = [
          ...(item.supportedReasoningEfforts ?? [])
            .map((effort) =>
              typeof effort.reasoningEffort === "string"
                ? effort.reasoningEffort
                : undefined,
            )
            .filter((effort): effort is string => !!effort),
        ];
        if (
          typeof item.defaultReasoningEffort === "string" &&
          item.defaultReasoningEffort &&
          !supportedEfforts.includes(item.defaultReasoningEffort)
        ) {
          supportedEfforts.unshift(item.defaultReasoningEffort);
        }

        if (supportedEfforts.length === 0) {
          const selector = baseModel;
          if (!catalog.has(selector)) {
            catalog.set(selector, { selector, model: baseModel, name: displayName });
            availableModels.push({
              modelId: selector,
              ...(displayName ? { name: displayName } : {}),
            });
          }
          continue;
        }

        for (const effort of supportedEfforts) {
          const selector = composeModelSelector(baseModel, effort);
          if (catalog.has(selector)) continue;
          const effortLabel = effort === "none" ? "default" : effort;
          const name = displayName ? `${displayName} (${effortLabel})` : selector;
          catalog.set(selector, {
            selector,
            model: baseModel,
            reasoningEffort: effort === "none" ? undefined : effort,
            name,
          });
          availableModels.push({ modelId: selector, name });
        }
      }

      if (!response.nextCursor) break;
      cursor = response.nextCursor;
    }

    this.availableModels = availableModels;
    this.modelCatalog = catalog;
  }

  private resolveModelSelector(input: string): {
    selector: string;
    model: string;
    reasoningEffort?: string;
  } {
    const exact = this.modelCatalog.get(input);
    if (exact) {
      return {
        selector: exact.selector,
        model: exact.model,
        ...(exact.reasoningEffort ? { reasoningEffort: exact.reasoningEffort } : {}),
      };
    }

    const folded = [...this.modelCatalog.values()].find(
      (entry) => entry.selector.toLowerCase() === input.toLowerCase(),
    );
    if (folded) {
      return {
        selector: folded.selector,
        model: folded.model,
        ...(folded.reasoningEffort
          ? { reasoningEffort: folded.reasoningEffort }
          : {}),
      };
    }

    const parsed = parseModelSelector(input);
    return {
      selector: input,
      model: parsed.model,
      ...(parsed.reasoningEffort ? { reasoningEffort: parsed.reasoningEffort } : {}),
    };
  }

  private updateModelState(
    sessionId: string,
    response: ThreadResponseShape,
  ): void {
    const modelState: AcpSessionModelState = {
      currentModelId: this.normalizeCurrentModelId(
        response.model,
        response.reasoningEffort,
      ),
      availableModels: this.availableModels.map((model) => ({ ...model })),
    };
    this.sessionModelStates.set(sessionId, modelState);
  }

  private normalizeCurrentModelId(
    model: unknown,
    reasoningEffort: unknown,
  ): string | undefined {
    const base =
      typeof model === "string" && model.trim() ? model.trim() : undefined;
    if (!base) return undefined;
    const effort =
      typeof reasoningEffort === "string" && reasoningEffort.trim()
        ? reasoningEffort.trim()
        : undefined;
    if (effort && REASONING_EFFORT_VALUES.has(effort)) {
      const selector = composeModelSelector(base, effort);
      return this.modelCatalog.has(selector) ? selector : selector;
    }
    if (this.modelCatalog.has(base)) {
      return base;
    }
    const noneSelector = composeModelSelector(base, "none");
    if (this.modelCatalog.has(noneSelector)) {
      return noneSelector;
    }
    return base;
  }

  private async handleServerNotification(
    method: string,
    params: unknown,
  ): Promise<void> {
    switch (method) {
      case "thread/tokenUsage/updated":
        this.handleThreadTokenUsageUpdated(params);
        return;
      case "turn/plan/updated":
        this.handleTurnPlanUpdated(params);
        return;
      case "item/agentMessage/delta":
        this.handleAgentMessageDelta(params);
        return;
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        this.handleReasoningDelta(params);
        return;
      case "item/started":
        this.handleItemStarted(params);
        return;
      case "item/completed":
        this.handleItemCompleted(params);
        return;
      case "turn/completed":
        this.handleTurnCompleted(params);
        return;
      case "thread/started":
        this.handleThreadStarted(params);
        return;
      case "model/rerouted":
        this.handleModelRerouted(params);
        return;
      default:
        return;
    }
  }

  private async handleServerRequest(
    method: string,
    params: unknown,
  ): Promise<unknown> {
    switch (method) {
      case "item/commandExecution/requestApproval":
        return this.handleCommandExecutionApprovalRequest(params);
      case "item/fileChange/requestApproval":
        return this.handleFileChangeApprovalRequest(params);
      case "item/permissions/requestApproval":
        return this.handlePermissionsApprovalRequest(params);
      default:
        throw new Error(
          `Codex app-server server request not supported by bridge: ${method}`,
        );
    }
  }

  private handleThreadTokenUsageUpdated(params: unknown): void {
    const data = params as {
      threadId?: unknown;
      tokenUsage?: {
        total?: { totalTokens?: unknown };
        modelContextWindow?: unknown;
      };
    };
    const threadId =
      typeof data.threadId === "string" ? data.threadId.trim() : "";
    const totalTokens = data.tokenUsage?.total?.totalTokens;
    const modelContextWindow = data.tokenUsage?.modelContextWindow;
    if (
      !threadId ||
      typeof totalTokens !== "number" ||
      !Number.isFinite(totalTokens) ||
      totalTokens < 0 ||
      typeof modelContextWindow !== "number" ||
      !Number.isFinite(modelContextWindow) ||
      modelContextWindow <= 0
    ) {
      return;
    }
    const usage: AcpSessionUsageState = {
      usedTokens: totalTokens,
      maxTokens: modelContextWindow,
      percent: (totalTokens / modelContextWindow) * 100,
    };
    this.sessionUsageStates.set(threadId, usage);
    this.emitEvent({
      type: "usage_update",
      sessionId: threadId,
      summary: `用量统计已更新（${usage.percent.toFixed(1).replace(/\.0$/, "")}%）`,
      usage,
    });
  }

  private handleTurnPlanUpdated(params: unknown): void {
    const data = params as {
      threadId?: unknown;
      plan?: Array<{ step?: unknown; status?: unknown }>;
      explanation?: unknown;
    };
    const threadId =
      typeof data.threadId === "string" ? data.threadId.trim() : "";
    if (!threadId || !Array.isArray(data.plan) || data.plan.length === 0) {
      return;
    }
    const lines = data.plan
      .map((entry, index) => {
        const step =
          typeof entry.step === "string" && entry.step.trim()
            ? entry.step.trim()
            : `Step ${index + 1}`;
        const status =
          typeof entry.status === "string" && entry.status.trim()
            ? entry.status.trim()
            : "?";
        return `${index + 1}. [${status}] ${step}`;
      })
      .join("\n");
    const explanation =
      typeof data.explanation === "string" && data.explanation.trim()
        ? `${data.explanation.trim()}\n\n`
        : "";
    this.emitEvent({
      type: "plan",
      sessionId: threadId,
      summary: `${explanation}${lines}`,
    });
  }

  private handleAgentMessageDelta(params: unknown): void {
    const data = params as { threadId?: unknown; delta?: unknown };
    const threadId =
      typeof data.threadId === "string" ? data.threadId.trim() : "";
    const delta = typeof data.delta === "string" ? data.delta : "";
    if (!threadId || !delta) return;
    this.emitEvent({
      type: "agent_message_chunk",
      sessionId: threadId,
      text: delta,
    });
  }

  private handleReasoningDelta(params: unknown): void {
    const data = params as { threadId?: unknown; delta?: unknown };
    const threadId =
      typeof data.threadId === "string" ? data.threadId.trim() : "";
    const delta = typeof data.delta === "string" ? data.delta : "";
    if (!threadId || !delta) return;
    this.emitEvent({
      type: "agent_thought_chunk",
      sessionId: threadId,
      text: delta,
    });
  }

  private handleItemStarted(params: unknown): void {
    const mapped = this.mapToolEventFromItem(params, "tool_call");
    if (mapped) {
      this.emitEvent(mapped);
    }
  }

  private handleItemCompleted(params: unknown): void {
    const mapped = this.mapToolEventFromItem(params, "tool_call_update");
    if (mapped) {
      this.emitEvent(mapped);
    }
  }

  private handleTurnCompleted(params: unknown): void {
    const data = params as {
      threadId?: unknown;
      turn?: {
        status?: unknown;
        error?: { message?: unknown } | null;
      };
    };
    const threadId =
      typeof data.threadId === "string" ? data.threadId.trim() : "";
    const status =
      typeof data.turn?.status === "string"
        ? data.turn.status
        : "completed";
    const message =
      typeof data.turn?.error?.message === "string"
        ? data.turn.error.message
        : undefined;
    this.completeTurnFromStatus(threadId, status, message);
  }

  private handleThreadStarted(params: unknown): void {
    const data = params as ThreadResponseShape & { threadId?: unknown };
    const threadId = extractThreadId(data) ?? "";
    if (!threadId) return;
    this.updateModelState(threadId, data);
  }

  private handleModelRerouted(params: unknown): void {
    const data = params as {
      threadId?: unknown;
      toModel?: unknown;
    };
    const threadId =
      typeof data.threadId === "string" ? data.threadId.trim() : "";
    const toModel =
      typeof data.toModel === "string" ? data.toModel.trim() : "";
    if (!threadId || !toModel) return;
    const current = this.sessionModelStates.get(threadId);
    this.sessionModelStates.set(threadId, {
      currentModelId: toModel,
      availableModels:
        current?.availableModels.map((model) => ({ ...model })) ??
        this.availableModels.map((model) => ({ ...model })),
    });
  }

  private async handleCommandExecutionApprovalRequest(
    params: unknown,
  ): Promise<unknown> {
    const data = params as {
      threadId?: unknown;
      itemId?: unknown;
      approvalId?: unknown;
      command?: unknown;
      reason?: unknown;
    };
    const threadId =
      typeof data.threadId === "string" ? data.threadId.trim() : "";
    if (!this.config.autoApprovePermissions && threadId) {
      const title = [
        typeof data.command === "string" && data.command.trim()
          ? data.command.trim()
          : "命令执行",
        typeof data.reason === "string" && data.reason.trim()
          ? `(${data.reason.trim()})`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
      this.emitEvent({
        type: "tool_call",
        sessionId: threadId,
        toolCallId:
          (typeof data.approvalId === "string" && data.approvalId.trim()) ||
          (typeof data.itemId === "string" && data.itemId.trim()) ||
          "command-approval",
        title: `等待批准: ${title}`.trim(),
        status: "permission_required",
      });
    }
    return { decision: "accept" };
  }

  private async handleFileChangeApprovalRequest(params: unknown): Promise<unknown> {
    const data = params as {
      threadId?: unknown;
      itemId?: unknown;
      reason?: unknown;
    };
    const threadId =
      typeof data.threadId === "string" ? data.threadId.trim() : "";
    if (!this.config.autoApprovePermissions && threadId) {
      this.emitEvent({
        type: "tool_call",
        sessionId: threadId,
        toolCallId:
          (typeof data.itemId === "string" && data.itemId.trim()) ||
          "file-change-approval",
        title: `等待批准: 文件修改${typeof data.reason === "string" && data.reason.trim() ? ` (${data.reason.trim()})` : ""}`,
        status: "permission_required",
      });
    }
    return { decision: "accept" };
  }

  private async handlePermissionsApprovalRequest(
    params: unknown,
  ): Promise<unknown> {
    const data = params as {
      threadId?: unknown;
      itemId?: unknown;
      permissions?: unknown;
      reason?: unknown;
    };
    const threadId =
      typeof data.threadId === "string" ? data.threadId.trim() : "";
    if (!this.config.autoApprovePermissions && threadId) {
      this.emitEvent({
        type: "tool_call",
        sessionId: threadId,
        toolCallId:
          (typeof data.itemId === "string" && data.itemId.trim()) ||
          "permissions-approval",
        title: `等待批准: 权限提升${typeof data.reason === "string" && data.reason.trim() ? ` (${data.reason.trim()})` : ""}`,
        status: "permission_required",
      });
    }
    return {
      permissions:
        data.permissions && typeof data.permissions === "object"
          ? data.permissions
          : {},
      scope: "turn",
    };
  }

  private mapToolEventFromItem(
    params: unknown,
    eventType: "tool_call" | "tool_call_update",
  ): Extract<
    BridgeAcpEvent,
    { type: "tool_call" | "tool_call_update" }
  > | undefined {
    const data = params as {
      threadId?: unknown;
      item?: Record<string, unknown> | null;
    };
    const threadId =
      typeof data.threadId === "string" ? data.threadId.trim() : "";
    const item = data.item;
    if (!threadId || !item || typeof item !== "object") {
      return undefined;
    }
    const itemId = typeof item.id === "string" ? item.id : undefined;
    const itemType = typeof item.type === "string" ? item.type : undefined;
    if (!itemId || !itemType) return undefined;

    const status = normalizeToolStatus(item.status);
    switch (itemType) {
      case "commandExecution":
        return {
          type: eventType,
          sessionId: threadId,
          toolCallId: itemId,
          title:
            typeof item.command === "string" && item.command.trim()
              ? item.command.trim()
              : "commandExecution",
          status,
        };
      case "fileChange":
        return {
          type: eventType,
          sessionId: threadId,
          toolCallId: itemId,
          title: `fileChange (${Array.isArray(item.changes) ? item.changes.length : 0})`,
          status,
        };
      case "mcpToolCall": {
        const server =
          typeof item.server === "string" && item.server.trim()
            ? `${item.server.trim()}:`
            : "";
        const tool =
          typeof item.tool === "string" && item.tool.trim()
            ? item.tool.trim()
            : "mcpToolCall";
        return {
          type: eventType,
          sessionId: threadId,
          toolCallId: itemId,
          title: `${server}${tool}`,
          status,
        };
      }
      case "dynamicToolCall": {
        const namespace =
          typeof item.namespace === "string" && item.namespace.trim()
            ? `${item.namespace.trim()}:`
            : "";
        const tool =
          typeof item.tool === "string" && item.tool.trim()
            ? item.tool.trim()
            : "dynamicToolCall";
        return {
          type: eventType,
          sessionId: threadId,
          toolCallId: itemId,
          title: `${namespace}${tool}`,
          status,
        };
      }
      case "webSearch":
        return {
          type: eventType,
          sessionId: threadId,
          toolCallId: itemId,
          title:
            typeof item.query === "string" && item.query.trim()
              ? `webSearch: ${item.query.trim()}`
              : "webSearch",
          status,
        };
      case "collabAgentToolCall":
        return {
          type: eventType,
          sessionId: threadId,
          toolCallId: itemId,
          title:
            typeof item.tool === "string" && item.tool.trim()
              ? item.tool.trim()
              : "collabAgentToolCall",
          status,
        };
      case "imageGeneration":
        return {
          type: eventType,
          sessionId: threadId,
          toolCallId: itemId,
          title: "imageGeneration",
          status,
        };
      default:
        return undefined;
    }
  }

  private emitEvent(event: BridgeAcpEvent): void {
    this.bridgeClient.emit("acp", event);
  }

  private completeTurnFromStatus(
    threadId: string,
    status: string,
    errorMessage?: string,
  ): void {
    const pending = this.pendingTurns.get(threadId);
    if (!pending || pending.resolved) return;
    pending.resolved = true;
    this.pendingTurns.delete(threadId);

    if (status === "failed" && errorMessage) {
      this.emitEvent({
        type: "agent_message_chunk",
        sessionId: threadId,
        text: `\n\n❌ ${errorMessage}`,
      });
    }

    pending.resolve({
      stopReason:
        status === "interrupted"
          ? "cancelled"
          : status === "failed"
            ? "failed"
            : "completed",
    });
  }

  private rejectPendingTurns(error: unknown): void {
    for (const pending of this.pendingTurns.values()) {
      if (pending.resolved) continue;
      pending.resolved = true;
      pending.reject(error);
    }
    this.pendingTurns.clear();
  }
}

type ThreadResponseShape = {
  thread?: { id?: unknown } | null;
  model?: unknown;
  reasoningEffort?: unknown;
};

function createPendingTurn(): PendingTurn & { promise: Promise<AcpPromptResult> } {
  let resolve!: (value: AcpPromptResult) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<AcpPromptResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    resolve,
    reject,
    promise,
    resolved: false,
  };
}

function extractThreadId(response: ThreadResponseShape): string | undefined {
  return typeof response.thread?.id === "string"
    ? response.thread.id
    : undefined;
}

function normalizeToolStatus(status: unknown): string {
  if (typeof status !== "string" || !status.trim()) {
    return "in_progress";
  }
  switch (status.trim()) {
    case "inProgress":
      return "in_progress";
    case "declined":
      return "failed";
    default:
      return status.trim();
  }
}

function parseModelSelector(input: string): {
  model: string;
  reasoningEffort?: string;
} {
  const trimmed = input.trim();
  const slash = trimmed.lastIndexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return { model: trimmed };
  }
  const maybeEffort = trimmed.slice(slash + 1);
  if (!REASONING_EFFORT_VALUES.has(maybeEffort)) {
    return { model: trimmed };
  }
  return {
    model: trimmed.slice(0, slash),
    ...(maybeEffort !== "none" ? { reasoningEffort: maybeEffort } : {}),
  };
}

function composeModelSelector(model: string, reasoningEffort?: string): string {
  if (!reasoningEffort || reasoningEffort === "none") {
    return model;
  }
  return `${model}/${reasoningEffort}`;
}
