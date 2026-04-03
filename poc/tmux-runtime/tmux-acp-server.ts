import * as crypto from "node:crypto";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Agent,
  type AgentSideConnection as AgentConnection,
  type ContentBlock,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionInfo,
  type SessionModeState,
  type SessionModelState,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
  type CloseSessionRequest,
  type CloseSessionResponse,
} from "@agentclientprotocol/sdk";
import {
  createStreamingHooks,
  type TmuxStreamingUpdate,
} from "../../src/acp/tmux-streaming.js";
import {
  TmuxCursorSession,
  probeTmuxBinding,
  type TmuxSessionBinding,
} from "./tmux-cursor-session.js";
import {
  TmuxAcpSessionStore,
  type PersistedTmuxAcpSessionRecord,
} from "./tmux-acp-session-store.js";

interface ServerOptions {
  storePath: string;
  startCommand?: string;
}

interface SessionRuntimeState {
  record: PersistedTmuxAcpSessionRecord;
  session: TmuxCursorSession;
  activePrompt: Promise<PromptResponse> | null;
}

const DEFAULT_MODE_ID = "default";
const DEFAULT_MODE_STATE: SessionModeState = {
  currentModeId: DEFAULT_MODE_ID,
  availableModes: [
    {
      id: DEFAULT_MODE_ID,
      name: "Default",
      description: "tmux-backed Cursor Agent interactive session",
    },
  ],
};

function parseArgs(argv: string[]): ServerOptions {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      values.set(arg, "true");
      continue;
    }
    values.set(arg, next);
    i += 1;
  }

  return {
    storePath: path.resolve(
      values.get("--store-path") ||
        path.join(process.cwd(), "poc/tmux-runtime/.tmp-tmux-acp-session-store.json"),
    ),
    startCommand: values.get("--start-command") || undefined,
  };
}

function summarizePromptText(text: string): string | undefined {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function extractPromptText(blocks: ContentBlock[]): string {
  return blocks
    .flatMap((block) => {
      if (block.type === "text") {
        return [block.text];
      }
      if (block.type === "resource_link") {
        return [block.uri];
      }
      return [];
    })
    .join("\n")
    .trim();
}

function isCancelledError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /cancel/i.test(message);
}

export class TmuxAcpAgent implements Agent {
  private readonly connection: AgentConnection;
  private readonly store: TmuxAcpSessionStore;
  private readonly runtime = new Map<string, SessionRuntimeState>();
  private readonly startCommand?: string;

  constructor(
    connection: AgentConnection,
    store: TmuxAcpSessionStore,
    options: ServerOptions,
  ) {
    this.connection = connection;
    this.store = store;
    this.startCommand = options.startCommand;
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: "tmux-cursor-acp-poc",
        version: "0.1.0",
      },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          embeddedContext: false,
        },
        sessionCapabilities: {
          list: {},
          resume: {},
          close: {},
        },
      },
    };
  }

  async authenticate(): Promise<Record<string, never>> {
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const cwd = path.resolve(params.cwd);
    const preferredCursorCliChatId = this.extractCursorChatId(params._meta);
    const sessionId = crypto.randomUUID();
    const session = new TmuxCursorSession({
      cwd,
      startCommand: this.startCommand,
      cursorCliChatId: preferredCursorCliChatId,
      verbose: false,
    });

    await session.startAgent();

    const now = Date.now();
    const binding = session.describeBinding();
    const record: PersistedTmuxAcpSessionRecord = {
      sessionId,
      paneId: binding.paneId,
      tmuxSessionName: binding.tmuxSessionName,
      ...(binding.cursorCliChatId ? { cursorCliChatId: binding.cursorCliChatId } : {}),
      workspaceRoot: binding.workspaceRoot,
      startCommand: binding.startCommand,
      createdAt: now,
      lastActiveAt: now,
      currentModeId: DEFAULT_MODE_ID,
    };
    this.store.set(record);
    await this.store.flush();
    this.runtime.set(sessionId, {
      record,
      session,
      activePrompt: null,
    });

    return {
      sessionId,
      modes: this.toModeState(record),
      _meta: {
        cursorChatId: session.getCursorCliChatId(),
      },
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const runtime = await this.ensureRuntime(params.sessionId, path.resolve(params.cwd));
    await this.touchRecord(runtime.record);
    return {
      modes: this.toModeState(runtime.record),
      ...(this.toModelState(runtime.record)
        ? { models: this.toModelState(runtime.record) }
        : {}),
      _meta: {
        cursorChatId: runtime.record.cursorCliChatId,
      },
    };
  }

  async unstable_resumeSession(
    params: ResumeSessionRequest,
  ): Promise<ResumeSessionResponse> {
    const runtime = await this.ensureRuntime(params.sessionId, path.resolve(params.cwd));
    await this.touchRecord(runtime.record);
    return {
      modes: this.toModeState(runtime.record),
      ...(this.toModelState(runtime.record)
        ? { models: this.toModelState(runtime.record) }
        : {}),
      _meta: {
        cursorChatId: runtime.record.cursorCliChatId,
      },
    };
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const cwd = params.cwd ? path.resolve(params.cwd) : undefined;
    const sessions = this.store
      .list()
      .filter((record) => (cwd ? path.resolve(record.workspaceRoot) === cwd : true))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .map((record): SessionInfo => ({
        sessionId: record.sessionId,
        cwd: record.workspaceRoot,
        title: record.title ?? null,
        updatedAt: new Date(record.lastActiveAt).toISOString(),
        _meta: {
          cursorChatId: record.cursorCliChatId,
          tmuxPaneId: record.paneId,
          tmuxSessionName: record.tmuxSessionName,
        },
      }));
    return { sessions };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const runtime = await this.ensureRuntime(params.sessionId);
    const promptText = extractPromptText(params.prompt);
    if (!promptText) {
      return {
        stopReason: "end_turn",
        ...(params.messageId ? { userMessageId: params.messageId } : {}),
      };
    }

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        content: {
          type: "text",
          text: promptText,
        },
      },
    });

    let updateChain = Promise.resolve();
    const enqueueSessionUpdate = (update: TmuxStreamingUpdate): void => {
      updateChain = updateChain.then(() =>
        this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update,
        }),
      );
    };
    const streaming = createStreamingHooks(
      promptText,
      enqueueSessionUpdate,
    );

    const promptPromise = (async (): Promise<PromptResponse> => {
      try {
        const result = await runtime.session.runPrompt(promptText, 90, streaming.hooks);
        await updateChain;
        streaming.finalize("completed");
        await updateChain;
        runtime.record.lastActiveAt = Date.now();
        runtime.record.title = summarizePromptText(promptText) ?? runtime.record.title;
        this.syncBindingToRecord(runtime.record, runtime.session.describeBinding());
        this.store.set(runtime.record);
        await this.store.flush();

        if (!streaming.hasStreamedContent() && result.replyText.trim()) {
          await this.connection.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: result.replyText,
              },
            },
          });
        }

        return {
          stopReason: "end_turn",
          ...(params.messageId ? { userMessageId: params.messageId } : {}),
          _meta: {
            cursorChatId: runtime.record.cursorCliChatId,
            tmuxPaneId: runtime.record.paneId,
          },
        };
      } catch (error) {
        if (isCancelledError(error)) {
          streaming.finalize("failed");
        }
        await updateChain.catch(() => undefined);
        if (isCancelledError(error)) {
          return {
            stopReason: "cancelled",
            ...(params.messageId ? { userMessageId: params.messageId } : {}),
          };
        }
        throw error;
      } finally {
        runtime.activePrompt = null;
      }
    })();

    runtime.activePrompt = promptPromise;
    return promptPromise;
  }

  async cancel(params: { sessionId: string }): Promise<void> {
    const runtime = this.runtime.get(params.sessionId);
    if (!runtime?.activePrompt) return;
    try {
      await runtime.session.cancelCurrentTurn();
    } catch {
      // ignore best-effort cancellation failures
    }
  }

  async unstable_closeSession(
    params: CloseSessionRequest,
  ): Promise<CloseSessionResponse> {
    const runtime = this.runtime.get(params.sessionId);
    if (runtime) {
      try {
        await runtime.session.close();
      } catch {
        // ignore cleanup failures
      }
      await runtime.session.stop();
      this.runtime.delete(params.sessionId);
    }
    this.store.delete(params.sessionId);
    await this.store.flush();
    return {};
  }

  async setSessionMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse> {
    const runtime = await this.ensureRuntime(params.sessionId);
    runtime.record.currentModeId = params.modeId || DEFAULT_MODE_ID;
    runtime.record.lastActiveAt = Date.now();
    this.store.set(runtime.record);
    await this.store.flush();
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: runtime.record.currentModeId,
      },
    });
    return {};
  }

  async unstable_setSessionModel(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse> {
    const runtime = await this.ensureRuntime(params.sessionId);
    runtime.record.currentModelId = params.modelId;
    runtime.record.lastActiveAt = Date.now();
    this.store.set(runtime.record);
    await this.store.flush();
    return {};
  }

  async shutdown(): Promise<void> {
    for (const runtime of this.runtime.values()) {
      await runtime.session.stop();
    }
    this.runtime.clear();
  }

  private async ensureRuntime(
    sessionId: string,
    cwdOverride?: string,
  ): Promise<SessionRuntimeState> {
    const existing = this.runtime.get(sessionId);
    if (existing) {
      return existing;
    }

    const record = this.store.get(sessionId);
    if (!record) {
      throw new Error(`Unknown tmux ACP session: ${sessionId}`);
    }

    const binding: TmuxSessionBinding = {
      paneId: record.paneId,
      tmuxSessionName: record.tmuxSessionName,
      workspaceRoot: cwdOverride ?? record.workspaceRoot,
      startCommand: record.startCommand,
      ...(record.cursorCliChatId ? { cursorCliChatId: record.cursorCliChatId } : {}),
    };
    const probe = await probeTmuxBinding(binding);

    let session: TmuxCursorSession;
    if (probe.exists) {
      session = new TmuxCursorSession({
        cwd: cwdOverride ?? record.workspaceRoot,
        paneId: record.paneId,
        sessionName: record.tmuxSessionName,
        startCommand: record.startCommand,
        cursorCliChatId: record.cursorCliChatId,
        verbose: false,
      });
    } else {
      session = new TmuxCursorSession({
        cwd: cwdOverride ?? record.workspaceRoot,
        startCommand: record.startCommand,
        cursorCliChatId: record.cursorCliChatId,
        verbose: false,
      });
    }

    await session.startAgent();
    this.syncBindingToRecord(record, session.describeBinding());
    if (cwdOverride) {
      record.workspaceRoot = cwdOverride;
    }
    record.lastActiveAt = Date.now();
    this.store.set(record);
    await this.store.flush();

    const runtime: SessionRuntimeState = {
      record,
      session,
      activePrompt: null,
    };
    this.runtime.set(sessionId, runtime);
    return runtime;
  }

  private toModeState(record: PersistedTmuxAcpSessionRecord): SessionModeState {
    return {
      currentModeId: record.currentModeId || DEFAULT_MODE_STATE.currentModeId,
      availableModes: DEFAULT_MODE_STATE.availableModes.map((mode) => ({ ...mode })),
    };
  }

  private toModelState(
    record: PersistedTmuxAcpSessionRecord,
  ): SessionModelState | undefined {
    if (!record.currentModelId) {
      return undefined;
    }
    return {
      currentModelId: record.currentModelId,
      availableModels: [
        {
          modelId: record.currentModelId,
          name: record.currentModelId,
        },
      ],
    };
  }

  private async touchRecord(record: PersistedTmuxAcpSessionRecord): Promise<void> {
    record.lastActiveAt = Date.now();
    this.store.set(record);
    await this.store.flush();
  }

  private syncBindingToRecord(
    record: PersistedTmuxAcpSessionRecord,
    binding: TmuxSessionBinding,
  ): void {
    record.paneId = binding.paneId;
    record.tmuxSessionName = binding.tmuxSessionName;
    record.workspaceRoot = binding.workspaceRoot;
    record.startCommand = binding.startCommand;
    record.cursorCliChatId = binding.cursorCliChatId;
  }

  private extractCursorChatId(meta: unknown): string | undefined {
    if (!meta || typeof meta !== "object") return undefined;
    const value = (meta as Record<string, unknown>).cursorChatId;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const store = new TmuxAcpSessionStore(options.storePath);
  await store.load();

  const input = Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>;
  const output = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(input, output);

  let agent: TmuxAcpAgent | null = null;
  const connection = new AgentSideConnection((conn) => {
    agent = new TmuxAcpAgent(conn, store, options);
    return agent;
  }, stream);

  try {
    await connection.closed;
  } finally {
    await agent?.shutdown();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
