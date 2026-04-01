import type { InitializeResponse } from "@agentclientprotocol/sdk";
import type { FeishuBridgeClient } from "./feishu-bridge-client.js";

export type AcpBackend = "legacy" | "official";

export interface AcpNewSessionOptions {
  cursorCliChatId?: string;
}

export interface AcpNewSessionResult {
  sessionId: string;
  cursorCliChatId?: string;
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
