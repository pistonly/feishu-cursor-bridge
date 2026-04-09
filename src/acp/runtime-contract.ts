import type { InitializeResponse } from "@agentclientprotocol/sdk";
import type { FeishuBridgeClient } from "./feishu-bridge-client.js";

export type AcpBackend =
  | "cursor-official"
  | "cursor-legacy"
  | "cursor-tmux"
  | "claude";

export type SessionRecovery =
  | { kind: "cursor-cli"; cursorCliChatId: string }
  | { kind: "claude-session"; resumeSessionId: string };

export interface AcpNewSessionOptions {
  recovery?: SessionRecovery;
}

export interface AcpNewSessionResult {
  sessionId: string;
  recovery?: SessionRecovery;
}

export interface AcpPromptResult {
  stopReason: string;
}

export interface AcpModelInfo {
  modelId: string;
  name?: string;
}

export interface AcpSessionModelState {
  currentModelId?: string;
  availableModels: AcpModelInfo[];
}

export interface AcpModeInfo {
  modeId: string;
  name?: string;
  description?: string;
}

export interface AcpSessionModeState {
  currentModeId?: string;
  availableModes: AcpModeInfo[];
}

export interface BridgeAcpRuntime {
  readonly backend: AcpBackend;
  readonly bridgeClient: FeishuBridgeClient;
  readonly initializeResult: InitializeResponse | null;
  readonly supportsLoadSession: boolean;

  start(): Promise<void>;
  initializeAndAuth(): Promise<void>;
  newSession(
    cwd?: string,
    options?: AcpNewSessionOptions,
  ): Promise<AcpNewSessionResult>;
  loadSession(sessionId: string, cwd: string): Promise<void>;
  prompt(sessionId: string, text: string): Promise<AcpPromptResult>;
  setSessionMode(sessionId: string, modeId: string): Promise<void>;
  getSessionModeState(sessionId: string): AcpSessionModeState | undefined;
  setSessionModel(sessionId: string, modelId: string): Promise<void>;
  getSessionModelState(sessionId: string): AcpSessionModelState | undefined;
  cancelSession(sessionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  supportsCloseSession(): boolean;
  stop(): Promise<void>;
}

export interface AcpRuntimeResolver {
  getRuntime(backend: AcpBackend): BridgeAcpRuntime;
}

export function isCursorLegacyBackend(backend: AcpBackend): boolean {
  return backend === "cursor-legacy";
}

export function isTmuxBackend(backend: AcpBackend): boolean {
  return backend === "cursor-tmux";
}

export function isOfficialCursorBackend(backend: AcpBackend): boolean {
  return backend === "cursor-official";
}

export function isClaudeBackend(backend: AcpBackend): boolean {
  return backend === "claude";
}
