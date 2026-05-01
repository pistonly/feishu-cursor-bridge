import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as readline from "node:readline";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type InitializeResponse,
} from "@agentclientprotocol/sdk";
import type { Config } from "../config/index.js";
import { FeishuBridgeClient } from "./feishu-bridge-client.js";
import { normalizeConfigOptionValues } from "./events.js";
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
import type {
  BridgeConfigOptionSelectValue,
  BridgeConfigOptionValue,
} from "./types.js";

type PromptParams = Parameters<ClientSideConnection["prompt"]>[0];
type NewSessionParams = Parameters<ClientSideConnection["newSession"]>[0];
type LoadSessionParams = Parameters<ClientSideConnection["loadSession"]>[0];
type PromptResponse = Awaited<ReturnType<ClientSideConnection["prompt"]>>;
type NewSessionResponse = Awaited<ReturnType<ClientSideConnection["newSession"]>>;

interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  label: string;
}

interface ConfigOptionModelSelection {
  modelConfigId: string;
  modelValue: string;
  reasoningConfigId?: string;
  reasoningValue?: string;
}

function normalizePositiveTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function extractPromptResponseTotalTokens(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = (raw as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  return normalizePositiveTokenCount(
    (usage as { totalTokens?: unknown }).totalTokens,
  );
}

/** 调试打印 env 时对疑似敏感变量名脱敏 */
function redactEnvForLog(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const sensitive = /secret|password|token|credential|authorization|api_?key|private/i;
  const out: Record<string, string | undefined> = {};
  for (const key of Object.keys(env).sort()) {
    const v = env[key];
    out[key] = sensitive.test(key) && v ? "***" : v;
  }
  return out;
}

function formatTraceValue(value: unknown, maxLen = 6000): string {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== "string") {
      return String(value);
    }
    return text.length > maxLen ? `${text.slice(0, maxLen)}...<truncated>` : text;
  } catch (error) {
    return `[unserializable:${error instanceof Error ? error.message : String(error)}]`;
  }
}

function cloneConfigOptionValue(
  option: BridgeConfigOptionValue,
): BridgeConfigOptionValue {
  return {
    id: option.id,
    currentValue: option.currentValue,
    ...(option.category ? { category: option.category } : {}),
    ...(option.options
      ? { options: option.options.map((selectOption) => ({ ...selectOption })) }
      : {}),
  };
}

function hasSelectorSuffix(modelId: string): boolean {
  const slash = modelId.lastIndexOf("/");
  return slash > 0 && slash < modelId.length - 1;
}

export abstract class SdkAcpRuntimeBase implements BridgeAcpRuntime {
  private static readonly STDERR_HISTORY_LIMIT = 20;
  readonly bridgeClient: FeishuBridgeClient;
  protected readonly config: Config;
  protected child: ChildProcess | null = null;
  protected connection: ClientSideConnection | null = null;
  protected initResult: InitializeResponse | null = null;
  private ensureStartedPromise: Promise<void> | null = null;
  private lastReadyErrorMessage: string | null = null;
  private recentStderrLines: string[] = [];
  private lastExitCode: number | null | undefined;
  private lastExitSignal: NodeJS.Signals | null | undefined;
  private readonly sessionModeStates = new Map<string, AcpSessionModeState>();
  private readonly sessionModelStates = new Map<string, AcpSessionModelState>();
  private readonly sessionConfigOptionStates = new Map<string, BridgeConfigOptionValue[]>();
  private readonly sessionUsageStates = new Map<string, AcpSessionUsageState>();
  private readonly sessionPromptUsageFallbacks = new Map<string, number>();

  protected constructor(
    config: Config,
    handler: FeishuBridgeClient,
  ) {
    this.config = config;
    this.bridgeClient = handler;
    if (typeof handler.on === "function") {
      handler.on("acp", (ev) => {
        if (ev.type === "current_mode_update") {
          const current = this.sessionModeStates.get(ev.sessionId);
          this.sessionModeStates.set(ev.sessionId, {
            currentModeId: ev.modeId,
            availableModes: current?.availableModes.map((mode) => ({ ...mode })) ?? [],
          });
          return;
        }
        if (ev.type === "config_option_update" && ev.configOptions?.length) {
          this.applyConfigOptionUpdate(ev.sessionId, ev.configOptions);
          return;
        }
        if (ev.type === "usage_update" && ev.usage) {
          const current = this.sessionUsageStates.get(ev.sessionId);
          this.sessionUsageStates.set(
            ev.sessionId,
            this.mergeSessionUsageState(ev.sessionId, current, ev.usage),
          );
        }
      });
    }
  }

  abstract readonly backend: AcpBackend;

  private shouldTraceOfficialModelFlow(): boolean {
    return this.config.acpReloadTraceLog && this.backend === "cursor-official";
  }

  private summarizeModelStateForTrace(
    state: AcpSessionModelState | undefined,
  ): Record<string, unknown> | null {
    if (!state) return null;
    return {
      currentModelId: state.currentModelId ?? null,
      availableModelIds: state.availableModels.map((model) => model.modelId),
    };
  }

  private logOfficialModelTrace(
    stage: string,
    sessionId: string,
    details: Record<string, unknown>,
  ): void {
    if (!this.shouldTraceOfficialModelFlow()) return;
    console.log(
      `[acp reload-trace] official-model ${stage} sessionId=${sessionId} details=${formatTraceValue(details)}`,
    );
  }

  get initializeResult(): InitializeResponse | null {
    return this.initResult;
  }

  getSessionModeState(sessionId: string): AcpSessionModeState | undefined {
    const state = this.sessionModeStates.get(sessionId);
    if (!state) return undefined;
    return {
      currentModeId: state.currentModeId,
      availableModes: state.availableModes.map((mode) => ({ ...mode })),
    };
  }

  getSessionModelState(sessionId: string): AcpSessionModelState | undefined {
    const state = this.sessionModelStates.get(sessionId);
    if (!state) return undefined;
    return {
      currentModelId: state.currentModelId,
      availableModels: state.availableModels.map((model) => ({ ...model })),
    };
  }

  getSessionUsageState(sessionId: string): AcpSessionUsageState | undefined {
    const state = this.sessionUsageStates.get(sessionId);
    if (!state) return undefined;
    const fallbackUsedTokens = this.sessionPromptUsageFallbacks.get(sessionId);
    if (
      state.usedTokens <= 0 &&
      state.maxTokens > 0 &&
      fallbackUsedTokens != null &&
      fallbackUsedTokens > 0 &&
      this.shouldUsePromptUsageFallback(
        sessionId,
        state,
        fallbackUsedTokens,
      )
    ) {
      return {
        usedTokens: fallbackUsedTokens,
        maxTokens: state.maxTokens,
        percent: (fallbackUsedTokens / state.maxTokens) * 100,
      };
    }
    if (
      state.usedTokens <= 0 &&
      state.maxTokens > 0 &&
      this.shouldHideReportedZeroUsage(
        sessionId,
        state,
        fallbackUsedTokens,
      )
    ) {
      return undefined;
    }
    return { ...state };
  }

  protected shouldUsePromptUsageFallback(
    _sessionId: string,
    _state: AcpSessionUsageState,
    _fallbackUsedTokens: number,
  ): boolean {
    return true;
  }

  protected shouldHideReportedZeroUsage(
    _sessionId: string,
    _state: AcpSessionUsageState,
    _fallbackUsedTokens: number | undefined,
  ): boolean {
    return false;
  }

  protected shouldStorePromptUsageFallback(): boolean {
    return true;
  }

  protected mergeSessionUsageState(
    _sessionId: string,
    _current: AcpSessionUsageState | undefined,
    next: AcpSessionUsageState,
  ): AcpSessionUsageState {
    return { ...next };
  }

  get supportsLoadSession(): boolean {
    return this.initResult?.agentCapabilities?.loadSession === true;
  }

  /**
   * 某些 backend（如 codex）对“刚创建好的活跃 session”执行 `loadSession`
   * 并不稳定；默认仍启用探活，仅在具体 runtime 中按需关闭。
   */
  get shouldProbeSessionAvailability(): boolean {
    return true;
  }

  /** ACP `initialize` 对 set_mode / set_model 的宣告与真实能力经常不一致，桥接不据此禁用。 */
  get supportsSetSessionMode(): boolean {
    return true;
  }

  get supportsSetSessionModel(): boolean {
    return true;
  }

  protected get supportsListSessions(): boolean {
    const list = this.initResult?.agentCapabilities?.sessionCapabilities?.list;
    return list != null && typeof list === "object";
  }

  supportsCloseSession(): boolean {
    const c = this.initResult?.agentCapabilities?.sessionCapabilities?.close;
    return c != null && typeof c === "object";
  }

  protected abstract createSpawnSpec(): SpawnSpec;

  protected buildPromptParams(sessionId: string, text: string): PromptParams {
    return {
      sessionId,
      prompt: [{ type: "text", text }],
    } as PromptParams;
  }

  protected buildNewSessionParams(
    cwd: string,
    _options?: AcpNewSessionOptions,
  ): NewSessionParams {
    return {
      cwd,
      mcpServers: [],
    } as NewSessionParams;
  }

  protected extractNewSessionResult(
    res: NewSessionResponse,
    _options?: AcpNewSessionOptions,
  ): AcpNewSessionResult {
    return { sessionId: res.sessionId };
  }

  protected async authenticate(_conn: ClientSideConnection): Promise<void> {
    // Most ACP backends are already authenticated by their launch environment.
  }

  protected buildLoadSessionParams(
    sessionId: string,
    cwd: string,
  ): LoadSessionParams {
    return {
      sessionId,
      cwd,
      mcpServers: [],
    };
  }

  private rememberStderrLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.recentStderrLines.push(trimmed);
    if (
      this.recentStderrLines.length >
      SdkAcpRuntimeBase.STDERR_HISTORY_LIMIT
    ) {
      this.recentStderrLines.splice(
        0,
        this.recentStderrLines.length - SdkAcpRuntimeBase.STDERR_HISTORY_LIMIT,
      );
    }
  }

  private formatRecentStderrSummary(): string | undefined {
    if (this.recentStderrLines.length === 0) {
      return undefined;
    }
    const summary = this.recentStderrLines
      .slice(-4)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .join(" | ");
    if (!summary) {
      return undefined;
    }
    return summary.length > 500 ? `${summary.slice(0, 500)}...` : summary;
  }

  private formatChildExitSummary(): string | undefined {
    if (this.lastExitCode == null && this.lastExitSignal == null) {
      return undefined;
    }
    const parts: string[] = [];
    if (this.lastExitCode != null) {
      parts.push(`exit code=${this.lastExitCode}`);
    }
    if (this.lastExitSignal) {
      parts.push(`signal=${this.lastExitSignal}`);
    }
    return parts.length > 0 ? parts.join(", ") : undefined;
  }

  private buildStartupFailureDetail(error: unknown): string {
    const base = error instanceof Error ? error.message : String(error);
    const details = [base];
    const exit = this.formatChildExitSummary();
    const stderr = this.formatRecentStderrSummary();
    if (exit) {
      details.push(exit);
    }
    if (stderr) {
      details.push(`stderr: ${stderr}`);
    }
    return details.join("；");
  }

  private formatBackendReadyError(): string {
    if (this.lastReadyErrorMessage?.trim()) {
      return `backend ${this.backend} 启动失败：${this.lastReadyErrorMessage.trim()}`;
    }
    if (this.connection && !this.initResult) {
      return `backend ${this.backend} 正在启动或等待认证，暂未就绪。请稍后重试，或发送 /status 查看 backend 状态。`;
    }
    return `backend ${this.backend} 当前未连接。请稍后重试；若持续失败，请联系管理员检查服务状态或执行 /restart。`;
  }

  async ensureStarted(): Promise<void> {
    if (this.connection && this.initResult) {
      return;
    }
    if (this.ensureStartedPromise) {
      return this.ensureStartedPromise;
    }
    this.ensureStartedPromise = (async () => {
      if (!this.child) {
        this.lastReadyErrorMessage = null;
        this.lastExitCode = undefined;
        this.lastExitSignal = undefined;
        this.recentStderrLines = [];
        await this.start();
      }
      try {
        if (!this.initResult) {
          await this.initializeAndAuth();
        }
        this.lastReadyErrorMessage = null;
      } catch (error) {
        const detail = this.buildStartupFailureDetail(error);
        this.lastReadyErrorMessage = detail;
        try {
          await this.stop();
        } catch {
          // ignore secondary stop failures while already surfacing startup error
        }
        throw new Error(detail);
      }
    })().finally(() => {
      this.ensureStartedPromise = null;
    });
    return this.ensureStartedPromise;
  }

  protected async requireReadyConnection(): Promise<ClientSideConnection> {
    await this.ensureStarted();
    const conn = this.connection;
    if (!conn || !this.initResult) {
      throw new Error(this.formatBackendReadyError());
    }
    return conn;
  }

  protected updateSessionModelState(
    sessionId: string,
    rawModels: unknown,
    traceSource?: string,
  ): void {
    const next = this.normalizeSessionModelState(rawModels);
    if (next) {
      this.sessionModelStates.set(
        sessionId,
        this.transformSessionModelState(next),
      );
    }
    if (traceSource) {
      this.logOfficialModelTrace(traceSource, sessionId, {
        rawModels,
        normalized: this.summarizeModelStateForTrace(next),
      });
    }
  }

  protected transformSessionModelState(
    state: AcpSessionModelState,
  ): AcpSessionModelState {
    return state;
  }

  protected deleteSessionModelState(sessionId: string): void {
    this.sessionModelStates.delete(sessionId);
  }

  protected deleteSessionUsageState(sessionId: string): void {
    this.sessionUsageStates.delete(sessionId);
    this.sessionPromptUsageFallbacks.delete(sessionId);
  }

  protected updateSessionModeState(
    sessionId: string,
    rawModes: unknown,
  ): void {
    const next = this.normalizeSessionModeState(rawModes);
    if (next) {
      this.sessionModeStates.set(sessionId, next);
    }
  }

  protected deleteSessionModeState(sessionId: string): void {
    this.sessionModeStates.delete(sessionId);
  }

  protected deleteSessionConfigOptionState(sessionId: string): void {
    this.sessionConfigOptionStates.delete(sessionId);
  }

  private updateSessionConfigOptionState(
    sessionId: string,
    rawOptions: unknown,
    traceSource?: string,
  ): void {
    const configOptions = normalizeConfigOptionValues(rawOptions);
    if (!configOptions) return;
    this.applyConfigOptionUpdate(sessionId, configOptions, traceSource);
  }

  private applyConfigOptionUpdate(
    sessionId: string,
    options: BridgeConfigOptionValue[],
    traceSource = "config_option_update",
  ): void {
    this.sessionConfigOptionStates.set(
      sessionId,
      options.map((option) => cloneConfigOptionValue(option)),
    );

    const pickOption = (predicate: (option: BridgeConfigOptionValue) => boolean) =>
      options.find((option) => predicate(option));

    const modeOption = pickOption(
      (option) => option.id === "mode" || option.category === "mode",
    );
    const nextModeId = modeOption?.currentValue;
    if (nextModeId) {
      const current = this.sessionModeStates.get(sessionId);
      this.sessionModeStates.set(sessionId, {
        currentModeId: nextModeId,
        availableModes: current?.availableModes.map((mode) => ({ ...mode })) ?? [],
      });
    }

    const modelOption = pickOption(
      (option) => option.id === "model" || option.category === "model",
    );
    const reasoningEffortOption = pickOption(
      (option) =>
        option.id === "reasoning_effort" || option.category === "thought_level",
    );
    const modelBase = modelOption?.currentValue;
    const reasoningEffort = reasoningEffortOption?.currentValue;
    const current = this.sessionModelStates.get(sessionId);
    const availableModelsFromConfig =
      this.normalizeModelOptionsFromConfig(modelOption, reasoningEffortOption);
    const availableModels = this.resolveAvailableModelsForConfigUpdate(
      current,
      availableModelsFromConfig,
    );
    const resolutionState = modelBase || reasoningEffort || availableModelsFromConfig
      ? this.transformSessionModelState({
          currentModelId: current?.currentModelId ?? modelBase,
          availableModels: availableModels.map((model) => ({ ...model })),
        })
      : current;
    const nextModelId = this.resolveModelIdFromConfigOptions(
      resolutionState,
      modelBase,
      reasoningEffort,
    );
    if (!nextModelId) {
      if (modelBase || reasoningEffort) {
        this.logOfficialModelTrace(traceSource, sessionId, {
          options,
          modelBase: modelBase ?? null,
          reasoningEffort: reasoningEffort ?? null,
          previous: this.summarizeModelStateForTrace(current),
          resolvedModelId: null,
        });
      }
      return;
    }
    this.sessionModelStates.set(sessionId, this.transformSessionModelState({
      currentModelId: nextModelId,
      availableModels,
    }));
    this.logOfficialModelTrace(traceSource, sessionId, {
      options,
      modelBase: modelBase ?? null,
      reasoningEffort: reasoningEffort ?? null,
      previous: this.summarizeModelStateForTrace(current),
      resolvedModelId: nextModelId,
      next: this.summarizeModelStateForTrace(this.sessionModelStates.get(sessionId)),
    });
  }

  protected shouldExpandConfigModelOptionsWithReasoningEffort(
    _modelOption: BridgeConfigOptionValue | undefined,
    _reasoningEffortOption: BridgeConfigOptionValue | undefined,
  ): boolean {
    return false;
  }

  private normalizeReasoningEffortOptions(
    reasoningEffortOption: BridgeConfigOptionValue | undefined,
  ): BridgeConfigOptionSelectValue[] {
    return reasoningEffortOption?.options?.filter((option) => option.value) ?? [];
  }

  private resolveAvailableModelsForConfigUpdate(
    current: AcpSessionModelState | undefined,
    availableModelsFromConfig: AcpModelInfo[] | undefined,
  ): AcpModelInfo[] {
    if (!availableModelsFromConfig) {
      return current?.availableModels.map((model) => ({ ...model })) ?? [];
    }
    if (!current?.availableModels.length) {
      return availableModelsFromConfig.map((model) => ({ ...model }));
    }
    const currentHasSelectors = current.availableModels.some((model) =>
      hasSelectorSuffix(model.modelId),
    );
    const configHasSelectors = availableModelsFromConfig.some((model) =>
      hasSelectorSuffix(model.modelId),
    );
    if (currentHasSelectors && !configHasSelectors) {
      return current.availableModels.map((model) => ({ ...model }));
    }
    return availableModelsFromConfig.map((model) => ({ ...model }));
  }

  protected normalizeModelOptionsFromConfig(
    modelOption: BridgeConfigOptionValue | undefined,
    reasoningEffortOption: BridgeConfigOptionValue | undefined,
  ): AcpModelInfo[] | undefined {
    if (!modelOption?.options?.length) return undefined;
    const out: AcpModelInfo[] = [];
    const seen = new Set<string>();
    const effortOptions = this.shouldExpandConfigModelOptionsWithReasoningEffort(
      modelOption,
      reasoningEffortOption,
    )
      ? this.normalizeReasoningEffortOptions(reasoningEffortOption)
      : [];
    const pushModel = (modelId: string, name?: string) => {
      if (!modelId || seen.has(modelId)) return;
      seen.add(modelId);
      out.push({
        modelId,
        ...(name && name !== modelId ? { name } : {}),
      });
    };
    for (const option of modelOption.options) {
      const modelId = option.value.trim();
      if (!modelId || seen.has(modelId)) continue;
      if (effortOptions.length > 0 && !hasSelectorSuffix(modelId)) {
        const baseName = option.name?.trim() || modelId;
        for (const effort of effortOptions) {
          pushModel(`${modelId}/${effort.value}`, `${baseName} (${effort.value})`);
        }
        continue;
      }
      pushModel(modelId, option.name);
    }
    return out.length > 0 ? out : undefined;
  }

  private resolveModelIdFromConfigOptions(
    current: AcpSessionModelState | undefined,
    modelBase: string | undefined,
    reasoningEffort: string | undefined,
  ): string | undefined {
    if (!modelBase && !reasoningEffort) return undefined;

    const knownModels = new Set(
      current?.availableModels.map((model) => model.modelId) ?? [],
    );
    const currentModelId = current?.currentModelId;
    const [currentBase, currentReasoning] = currentModelId?.split("/", 2) ?? [];

    if (modelBase && reasoningEffort) {
      const combined = `${modelBase}/${reasoningEffort}`;
      if (knownModels.size === 0 || knownModels.has(combined)) {
        return combined;
      }
      if (knownModels.has(modelBase)) {
        return modelBase;
      }
      return currentModelId;
    }

    const candidate = modelBase
      ? currentReasoning && knownModels.has(`${modelBase}/${currentReasoning}`)
        ? `${modelBase}/${currentReasoning}`
        : modelBase
      : currentBase
        ? `${currentBase}/${reasoningEffort}`
        : undefined;

    if (!candidate) return undefined;
    if (knownModels.size === 0 || knownModels.has(candidate)) {
      return candidate;
    }
    return currentModelId;
  }

  private normalizeSessionModelState(rawModels: unknown): AcpSessionModelState | undefined {
    if (!rawModels || typeof rawModels !== "object") {
      return undefined;
    }
    const models = rawModels as {
      currentModelId?: unknown;
      availableModels?: unknown;
    };
    const availableModelsRaw = Array.isArray(models.availableModels)
      ? models.availableModels
      : [];
    const availableModels: AcpModelInfo[] = [];
    const seen = new Set<string>();
    for (const item of availableModelsRaw) {
      if (!item || typeof item !== "object") continue;
      const model = item as { modelId?: unknown; name?: unknown };
      const modelId =
        typeof model.modelId === "string" ? model.modelId.trim() : "";
      if (!modelId || seen.has(modelId)) continue;
      seen.add(modelId);
      const normalized: AcpModelInfo = { modelId };
      if (typeof model.name === "string" && model.name.trim()) {
        normalized.name = model.name.trim();
      }
      availableModels.push(normalized);
    }
    const currentModelId =
      typeof models.currentModelId === "string" && models.currentModelId.trim()
        ? models.currentModelId.trim()
        : undefined;
    if (!currentModelId && availableModels.length === 0) {
      return undefined;
    }
    return {
      currentModelId,
      availableModels,
    };
  }

  private normalizeSessionModeState(rawModes: unknown): AcpSessionModeState | undefined {
    if (!rawModes || typeof rawModes !== "object") {
      return undefined;
    }
    const modes = rawModes as {
      currentModeId?: unknown;
      availableModes?: unknown;
    };
    const availableModesRaw = Array.isArray(modes.availableModes)
      ? modes.availableModes
      : [];
    const availableModes: AcpModeInfo[] = [];
    const seen = new Set<string>();
    for (const item of availableModesRaw) {
      if (!item || typeof item !== "object") continue;
      const mode = item as {
        id?: unknown;
        name?: unknown;
        description?: unknown;
      };
      const modeId = typeof mode.id === "string" ? mode.id.trim() : "";
      if (!modeId || seen.has(modeId)) continue;
      seen.add(modeId);
      const normalized: AcpModeInfo = { modeId };
      if (typeof mode.name === "string" && mode.name.trim()) {
        normalized.name = mode.name.trim();
      }
      if (typeof mode.description === "string" && mode.description.trim()) {
        normalized.description = mode.description.trim();
      }
      availableModes.push(normalized);
    }
    const currentModeId =
      typeof modes.currentModeId === "string" && modes.currentModeId.trim()
        ? modes.currentModeId.trim()
        : undefined;
    if (!currentModeId && availableModes.length === 0) {
      return undefined;
    }
    return {
      currentModeId,
      availableModes,
    };
  }

  protected async logPromptNullDiagnostics(
    sessionId: string,
    conn: ClientSideConnection,
  ): Promise<void> {
    const snap: Record<string, unknown> = {
      backend: this.backend,
      sessionId,
      connectionAborted: conn.signal.aborted,
      adapterChildMissing: this.child == null,
      adapterPid: this.child?.pid,
      adapterKilled: this.child?.killed === true,
      agentAdvertisesListSessions: this.supportsListSessions,
      agentAdvertisesLoadSession: this.supportsLoadSession,
    };
    if (this.child) {
      snap.adapterExitCode = this.child.exitCode;
      snap.adapterSignal = this.child.signalCode;
    }
    if (this.supportsListSessions) {
      try {
        const listed = await conn.listSessions({});
        const ids = listed.sessions.map((s: { sessionId: string }) => s.sessionId);
        snap.listSessionsCount = listed.sessions.length;
        snap.promptSessionIdInAgentList = ids.includes(sessionId);
        snap.agentSessionIdsSample = ids.slice(0, 12);
      } catch (e) {
        snap.listSessionsError = e instanceof Error ? e.message : String(e);
      }
    } else {
      snap.listSessions = "agent_did_not_advertise_session_list";
    }
    console.warn(
      "[acp] session/prompt 返回 null（无 stopReason，可观测快照）:",
      JSON.stringify(snap),
    );
  }

  async start(): Promise<void> {
    if (this.child) {
      throw new Error("ACP runtime already running");
    }

    const spec = this.createSpawnSpec();
    const runtimeEnv = spec.env ?? { ...process.env };
    if (this.config.bridgeDebug || this.config.logLevel === "debug") {
      console.log(
        `[acp] spawn backend=${this.backend} cwd=${spec.cwd} command=${spec.command} args=${JSON.stringify(spec.args)}`,
      );
      console.log(
        "[acp] spawn env (敏感键名已脱敏，需完整明文可临时改 redactEnvForLog):",
        JSON.stringify(redactEnvForLog(runtimeEnv), null, 2),
      );
    }

    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: runtimeEnv,
    });

    this.child = child;

    child.on("error", (err) => {
      console.error(`[acp] ${spec.label} process error:`, err);
    });

    child.on("close", (code, signal) => {
      console.log(
        `[acp] ${spec.label} exited code=${code} signal=${signal}`,
      );
      this.lastExitCode = code;
      this.lastExitSignal = signal;
      this.child = null;
      this.connection = null;
      this.initResult = null;
    });

    if (child.stderr) {
      const rl = readline.createInterface({ input: child.stderr });
      rl.on("line", (line) => {
        this.rememberStderrLine(line);
        if (this.config.logLevel === "debug") {
          console.warn("[acp stderr]", line);
        } else if (line.toLowerCase().includes("error")) {
          console.warn("[acp stderr]", line);
        }
      });
    }

    if (!child.stdin || !child.stdout) {
      throw new Error(`${spec.label} missing stdio pipes`);
    }

    const toAgent = Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>;
    const fromAgent = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(toAgent, fromAgent);
    this.connection = new ClientSideConnection(
      () => this.bridgeClient,
      stream,
    );
  }

  async initializeAndAuth(): Promise<void> {
    const conn = this.connection;
    if (!conn) throw new Error("ACP not started");

    this.initResult = await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: false,
      },
      clientInfo: {
        name: "feishu-cursor-bridge",
        version: "1.0.0",
      },
    });

    await this.authenticate(conn);
  }

  async newSession(
    cwd?: string,
    options?: AcpNewSessionOptions,
  ): Promise<AcpNewSessionResult> {
    const conn = await this.requireReadyConnection();
    const dir = path.resolve(cwd ?? this.config.acp.workspaceRoot);
    const res = await conn.newSession(this.buildNewSessionParams(dir, options));
    this.updateSessionModeState(res.sessionId, (res as { modes?: unknown }).modes);
    this.updateSessionModelState(
      res.sessionId,
      (res as { models?: unknown }).models,
      "session/new",
    );
    this.updateSessionConfigOptionState(
      res.sessionId,
      (res as { configOptions?: unknown }).configOptions,
      "session/new",
    );
    return this.extractNewSessionResult(res, options);
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    const conn = await this.requireReadyConnection();
    if (!this.supportsLoadSession) {
      throw new Error("Agent does not advertise loadSession");
    }
    const dir = path.resolve(cwd);
    if (this.config.acpReloadTraceLog) {
      console.log(
        `[acp reload-trace] session/load begin backend=${this.backend} sessionId=${sessionId} cwd=${dir}`,
      );
    }
    const t0 = this.config.acpReloadTraceLog ? Date.now() : 0;
    try {
      const res = await conn.loadSession(this.buildLoadSessionParams(sessionId, dir));
      this.updateSessionModeState(sessionId, (res as { modes?: unknown }).modes);
      this.updateSessionModelState(
        sessionId,
        (res as { models?: unknown }).models,
        "session/load",
      );
      this.updateSessionConfigOptionState(
        sessionId,
        (res as { configOptions?: unknown }).configOptions,
        "session/load",
      );
      if (this.config.acpReloadTraceLog) {
        console.log(
          `[acp reload-trace] session/load ok backend=${this.backend} sessionId=${sessionId} elapsedMs=${Date.now() - t0}`,
        );
      }
    } catch (e) {
      if (this.config.acpReloadTraceLog) {
        console.warn(
          `[acp reload-trace] session/load FAILED backend=${this.backend} sessionId=${sessionId} elapsedMs=${Date.now() - t0}`,
          e instanceof Error ? e.message : e,
        );
      }
      throw e;
    }
  }

  async prompt(sessionId: string, text: string): Promise<AcpPromptResult> {
    const conn = await this.requireReadyConnection();
    this.logOfficialModelTrace("prompt_begin", sessionId, {
      cached: this.summarizeModelStateForTrace(this.sessionModelStates.get(sessionId)),
    });
    let res: PromptResponse | null;
    try {
      res = await conn.prompt(this.buildPromptParams(sessionId, text));
    } catch (error) {
      this.logOfficialModelTrace("prompt_error", sessionId, {
        cached: this.summarizeModelStateForTrace(this.sessionModelStates.get(sessionId)),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (res == null) {
      await this.logPromptNullDiagnostics(sessionId, conn);
      return { stopReason: "unknown" };
    }
    const totalTokens = extractPromptResponseTotalTokens(res);
    if (totalTokens != null && this.shouldStorePromptUsageFallback()) {
      this.sessionPromptUsageFallbacks.set(sessionId, totalTokens);
    }
    this.logOfficialModelTrace("prompt_ok", sessionId, {
      cached: this.summarizeModelStateForTrace(this.sessionModelStates.get(sessionId)),
      stopReason: String(res.stopReason),
    });
    return { stopReason: String((res as PromptResponse).stopReason) };
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<void> {
    const conn = await this.requireReadyConnection();
    await conn.setSessionMode({ sessionId, modeId });
    const current = this.sessionModeStates.get(sessionId);
    this.sessionModeStates.set(sessionId, {
      currentModeId: modeId,
      availableModes: current?.availableModes.map((mode) => ({ ...mode })) ?? [],
    });
  }

  private findSessionConfigOption(
    sessionId: string,
    predicate: (option: BridgeConfigOptionValue) => boolean,
  ): BridgeConfigOptionValue | undefined {
    return this.sessionConfigOptionStates.get(sessionId)?.find(predicate);
  }

  private configOptionHasValue(
    option: BridgeConfigOptionValue,
    value: string,
  ): boolean {
    return option.options?.some((selectOption) => selectOption.value === value) ?? false;
  }

  private splitModelReasoningSelector(
    modelId: string,
  ): { base: string; reasoning: string } | undefined {
    const slash = modelId.lastIndexOf("/");
    if (slash <= 0 || slash >= modelId.length - 1) return undefined;
    return {
      base: modelId.slice(0, slash),
      reasoning: modelId.slice(slash + 1),
    };
  }

  private resolveConfigOptionModelSelection(
    sessionId: string,
    modelId: string,
  ): ConfigOptionModelSelection | undefined {
    const modelOption = this.findSessionConfigOption(
      sessionId,
      (option) => option.id === "model" || option.category === "model",
    );
    if (!modelOption) return undefined;

    if (this.configOptionHasValue(modelOption, modelId)) {
      return {
        modelConfigId: modelOption.id,
        modelValue: modelId,
      };
    }

    const parsed = this.splitModelReasoningSelector(modelId);
    if (!parsed || !this.configOptionHasValue(modelOption, parsed.base)) {
      return undefined;
    }

    const reasoningOption = this.findSessionConfigOption(
      sessionId,
      (option) =>
        option.id === "reasoning_effort" || option.category === "thought_level",
    );
    if (
      !reasoningOption ||
      !this.configOptionHasValue(reasoningOption, parsed.reasoning)
    ) {
      return undefined;
    }

    return {
      modelConfigId: modelOption.id,
      modelValue: parsed.base,
      reasoningConfigId: reasoningOption.id,
      reasoningValue: parsed.reasoning,
    };
  }

  private applySetSessionConfigOptionResponse(
    sessionId: string,
    response: unknown,
  ): boolean {
    const configOptions = normalizeConfigOptionValues(
      (response as { configOptions?: unknown } | null | undefined)?.configOptions,
    );
    if (!configOptions) return false;
    this.applyConfigOptionUpdate(sessionId, configOptions, "set_config_option");
    return true;
  }

  private async setSessionModelViaConfigOptions(
    conn: ClientSideConnection,
    sessionId: string,
    selection: ConfigOptionModelSelection,
  ): Promise<boolean> {
    const modelResponse = await conn.setSessionConfigOption({
      sessionId,
      configId: selection.modelConfigId,
      value: selection.modelValue,
    });
    let appliedResponse = this.applySetSessionConfigOptionResponse(
      sessionId,
      modelResponse,
    );

    if (selection.reasoningConfigId && selection.reasoningValue) {
      const reasoningResponse = await conn.setSessionConfigOption({
        sessionId,
        configId: selection.reasoningConfigId,
        value: selection.reasoningValue,
      });
      appliedResponse =
        this.applySetSessionConfigOptionResponse(sessionId, reasoningResponse) ||
        appliedResponse;
    }

    return appliedResponse;
  }

  private updateLocalModelStateAfterSetSessionModel(
    sessionId: string,
    modelId: string,
  ): boolean {
    const current = this.sessionModelStates.get(sessionId);
    if (!current) return false;
    if (!current.availableModels.some((model) => model.modelId === modelId)) {
      return false;
    }
    this.sessionModelStates.set(sessionId, {
      currentModelId: modelId,
      availableModels: current.availableModels.map((model) => ({ ...model })),
    });
    return true;
  }

  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    const conn = await this.requireReadyConnection();
    this.logOfficialModelTrace("set_model_begin", sessionId, {
      requestedModelId: modelId,
      cached: this.summarizeModelStateForTrace(this.sessionModelStates.get(sessionId)),
    });
    const configSelection = this.resolveConfigOptionModelSelection(sessionId, modelId);
    let configOptionError: unknown;
    if (configSelection) {
      this.logOfficialModelTrace("set_model_config_option_begin", sessionId, {
        requestedModelId: modelId,
        selection: configSelection,
        cached: this.summarizeModelStateForTrace(this.sessionModelStates.get(sessionId)),
      });
      try {
        const appliedResponse = await this.setSessionModelViaConfigOptions(
          conn,
          sessionId,
          configSelection,
        );
        const localCacheUpdated = appliedResponse
          ? true
          : this.updateLocalModelStateAfterSetSessionModel(sessionId, modelId);
        this.logOfficialModelTrace("set_model_config_option_ok", sessionId, {
          requestedModelId: modelId,
          selection: configSelection,
          cached: this.summarizeModelStateForTrace(this.sessionModelStates.get(sessionId)),
          localCacheUpdated,
        });
        return;
      } catch (error) {
        configOptionError = error;
        this.logOfficialModelTrace("set_model_config_option_error", sessionId, {
          requestedModelId: modelId,
          selection: configSelection,
          cached: this.summarizeModelStateForTrace(this.sessionModelStates.get(sessionId)),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      await conn.unstable_setSessionModel({ sessionId, modelId });
    } catch (error) {
      this.logOfficialModelTrace("set_model_error", sessionId, {
        requestedModelId: modelId,
        cached: this.summarizeModelStateForTrace(this.sessionModelStates.get(sessionId)),
        ...(configOptionError
          ? {
              configOptionError:
                configOptionError instanceof Error
                  ? configOptionError.message
                  : String(configOptionError),
            }
          : {}),
        error: error instanceof Error ? error.message : String(error),
      });
      if (configOptionError) {
        throw new Error(
          `session/set_config_option failed: ${
            configOptionError instanceof Error
              ? configOptionError.message
              : String(configOptionError)
          }; unstable_setSessionModel failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      throw error;
    }
    const localCacheUpdated =
      this.updateLocalModelStateAfterSetSessionModel(sessionId, modelId);
    this.logOfficialModelTrace("set_model_ok", sessionId, {
      requestedModelId: modelId,
      cached: this.summarizeModelStateForTrace(this.sessionModelStates.get(sessionId)),
      localCacheUpdated,
    });
  }

  async cancelSession(sessionId: string): Promise<void> {
    const conn = this.connection;
    if (!conn) return;
    await conn.cancel({ sessionId });
  }

  async closeSession(sessionId: string): Promise<void> {
    const conn = this.connection;
    this.deleteSessionModeState(sessionId);
    this.deleteSessionModelState(sessionId);
    this.deleteSessionConfigOptionState(sessionId);
    this.deleteSessionUsageState(sessionId);
    if (!conn || !this.supportsCloseSession()) return;
    try {
      await conn.unstable_closeSession({ sessionId });
    } catch {
      /* ignore */
    }
  }

  async stop(): Promise<void> {
    if (this.child) {
      this.child.stdin?.end();
      this.child.kill();
      this.child = null;
    }
    this.ensureStartedPromise = null;
    this.connection = null;
    this.initResult = null;
    this.sessionModeStates.clear();
    this.sessionModelStates.clear();
    this.sessionUsageStates.clear();
    this.sessionPromptUsageFallbacks.clear();
  }
}
