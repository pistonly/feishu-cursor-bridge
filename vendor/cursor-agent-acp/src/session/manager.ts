/**
 * SessionManager - Handles session lifecycle and persistence
 *
 * This class manages ACP sessions, including creation, persistence,
 * and cleanup of conversation sessions.
 */

import {
  SessionError,
  type AdapterConfig,
  type Logger,
  type SessionInfo,
  type SessionData,
  type SessionMetadata,
  type ConversationMessage,
  type SessionStatus,
  type InternalSessionModeConfig,
  type SessionModel,
} from '../types';
import type { CursorCliBridge } from '../cursor/cli-bridge';
import type {
  SessionMode,
  SessionModeId,
  SessionModeState,
} from '@agentclientprotocol/sdk';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

export interface SessionListOptions {
  limit?: number;
  offset?: number;
  filter?: Record<string, any>;
}

export interface SessionListResult {
  items: SessionInfo[];
  total: number;
  hasMore: boolean;
}

interface PersistedConversationMessage {
  id: string;
  role: ConversationMessage['role'];
  content: ConversationMessage['content'];
  timestamp: string;
  metadata?: Record<string, any>;
}

interface PersistedSessionRecord {
  version: 1;
  id: string;
  metadata: SessionMetadata;
  conversation: PersistedConversationMessage[];
  state: Omit<SessionData['state'], 'lastActivity'> & {
    lastActivity: string;
  };
  createdAt: string;
  updatedAt: string;
}

interface ModelContextWindowsConfig {
  default?: unknown;
  models?: Record<string, unknown>;
}

const DEFAULT_MODEL_CONTEXT_WINDOW = 272000;
const MODEL_CONTEXT_WINDOWS_CONFIG_CANDIDATES = [
  path.resolve(__dirname, '..', '..', 'model-context-windows.json'),
  path.resolve(__dirname, '..', '..', '..', 'model-context-windows.json'),
];

function normalizeContextWindow(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export class SessionManager {
  private config: AdapterConfig;
  private logger: Logger;
  private sessions = new Map<string, SessionData>();
  private sessionCleanupInterval: ReturnType<typeof setInterval> | null = null;
  private processingSessions = new Set<string>(); // Track sessions actively processing prompts
  private modelContextWindows = new Map<string, number>();
  private defaultModelContextWindow = DEFAULT_MODEL_CONTEXT_WINDOW;

  // Session modes per ACP spec
  // Using SDK SessionMode type for ACP compliance
  // Matches Cursor IDE mode names and order: Agent, Plan, Ask
  private readonly availableModes: SessionMode[] = [
    {
      id: 'agent',
      name: 'Agent',
      description: 'Write and modify code with full tool access',
    },
    {
      id: 'plan',
      name: 'Plan',
      description: 'Design and plan software systems without implementation',
    },
    {
      id: 'ask',
      name: 'Ask',
      description: 'Request permission before making any changes',
    },
  ];

  // Internal configuration for modes (not part of ACP spec)
  private readonly modeConfigs: Map<SessionModeId, InternalSessionModeConfig> =
    new Map([
      ['ask', { permissionBehavior: 'strict' }],
      [
        'agent',
        {
          availableTools: ['filesystem', 'terminal'],
          permissionBehavior: 'strict',
        },
      ],
      [
        'plan',
        { availableTools: ['filesystem'], permissionBehavior: 'strict' },
      ],
    ]);

  // Available models (dynamically loaded from cursor-agent CLI)
  // Starts with default "auto" model, then populated from `cursor-agent models` command
  private availableModels: SessionModel[] = [
    {
      id: 'auto',
      name: 'Auto',
      provider: 'cursor',
    },
  ];

  constructor(config: AdapterConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.loadModelContextWindows();

    this.logger.debug('SessionManager initialized', {
      maxSessions: config.maxSessions,
      sessionTimeout: config.sessionTimeout,
      availableModes: this.availableModes.length,
      availableModels: this.availableModels.length,
      defaultModelContextWindow: this.defaultModelContextWindow,
      configuredModelContextWindows: this.modelContextWindows.size,
    });

    // Start session cleanup interval
    this.startCleanupInterval();
  }

  /**
   * Creates a new session
   */
  async createSession(metadata: SessionMetadata = {}): Promise<SessionData> {
    this.logger.debug('Creating new session', { metadata });

    try {
      // Check session limits and cleanup expired sessions first
      if (this.sessions.size >= this.config.maxSessions) {
        await this.cleanupExpiredSessions();

        // If we still don't have room after cleanup, throw error
        if (this.sessions.size >= this.config.maxSessions) {
          throw new SessionError('Maximum number of sessions reached');
        }
      }

      // Generate session ID
      const sessionId = uuidv4();

      // Create session data
      const now = new Date();
      const defaultMode = 'ask';
      const defaultModel = 'auto';

      const sessionData: SessionData = {
        id: sessionId,
        metadata: {
          name: metadata.name || `Session ${sessionId.slice(0, 8)}`,
          mode: metadata.mode || defaultMode,
          model: metadata.model || defaultModel,
          ...metadata,
        },
        conversation: [],
        state: {
          lastActivity: now,
          messageCount: 0,
          tokenCount: 0,
          status: 'active',
          currentMode: metadata.mode || defaultMode,
          currentModel: metadata.model || defaultModel,
        },
        createdAt: now,
        updatedAt: now,
      };

      // Store in memory
      this.sessions.set(sessionId, sessionData);

      // TODO: Persist to disk
      await this.persistSession(sessionData);

      this.logger.info(`Session created: ${sessionId}`, { metadata });
      return sessionData;
    } catch (error) {
      this.logger.error('Failed to create session', error);
      throw error instanceof SessionError
        ? error
        : new SessionError(
            `Failed to create session: ${error instanceof Error ? error.message : String(error)}`,
            undefined,
            error instanceof Error ? error : undefined
          );
    }
  }

  /**
   * Check if a session exists in memory
   * Does not load from disk - only checks in-memory sessions
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Loads an existing session
   */
  async loadSession(sessionId: string): Promise<SessionData> {
    this.logger.debug(`Loading session: ${sessionId}`);

    try {
      // Check in-memory cache first
      let session = this.sessions.get(sessionId);

      if (!session) {
        // Try to load from disk
        session = (await this.loadSessionFromDisk(sessionId)) || undefined;

        if (session) {
          this.sessions.set(sessionId, session);
        }
      }

      if (!session) {
        throw new SessionError(`Session not found: ${sessionId}`, sessionId);
      }

      // Update last activity
      session.state.lastActivity = new Date();
      session.updatedAt = new Date();

      this.logger.debug(`Session loaded: ${sessionId}`);
      return session;
    } catch (error) {
      this.logger.error(`Failed to load session: ${sessionId}`, error);
      throw error instanceof SessionError
        ? error
        : new SessionError(
            `Failed to load session: ${error instanceof Error ? error.message : String(error)}`,
            sessionId,
            error instanceof Error ? error : undefined
          );
    }
  }

  /**
   * Lists sessions with optional filtering and pagination
   */
  async listSessions(
    limit = 50,
    offset = 0,
    filter?: Record<string, any>
  ): Promise<SessionListResult> {
    this.logger.debug('Listing sessions', { limit, offset, filter });

    try {
      // Get all sessions (in-memory + from disk)
      const allSessions = await this.getAllSessions();

      // Apply filters
      let filteredSessions = allSessions;
      if (filter) {
        filteredSessions = this.applyFilters(allSessions, filter);
      }

      // Sort by last activity (most recent first)
      filteredSessions.sort(
        (a, b) =>
          b.state.lastActivity.getTime() - a.state.lastActivity.getTime()
      );

      // Apply pagination
      const total = filteredSessions.length;
      const paginatedSessions = filteredSessions.slice(offset, offset + limit);

      // Convert to SessionInfo
      const sessionInfos: SessionInfo[] = paginatedSessions.map((session) => ({
        id: session.id,
        metadata: session.metadata,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        status: this.getSessionStatus(session),
      }));

      return {
        items: sessionInfos,
        total,
        hasMore: offset + limit < total,
      };
    } catch (error) {
      this.logger.error('Failed to list sessions', error);
      throw new SessionError(
        `Failed to list sessions: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Updates session metadata
   */
  async updateSession(
    sessionId: string,
    updates: Partial<SessionMetadata>
  ): Promise<SessionData> {
    this.logger.debug(`Updating session: ${sessionId}`, { updates });

    try {
      const session = await this.loadSession(sessionId);

      // Update metadata
      session.metadata = { ...session.metadata, ...updates };
      const now = new Date();
      session.updatedAt = now;
      session.state.lastActivity = now;

      // Save changes
      await this.persistSession(session);

      this.logger.info(`Session updated: ${sessionId}`);
      return session;
    } catch (error) {
      this.logger.error(`Failed to update session: ${sessionId}`, error);
      throw error instanceof SessionError
        ? error
        : new SessionError(
            `Failed to update session: ${error instanceof Error ? error.message : String(error)}`,
            sessionId,
            error instanceof Error ? error : undefined
          );
    }
  }

  /**
   * Deletes a session
   */
  async deleteSession(sessionId: string): Promise<void> {
    this.logger.debug(`Deleting session: ${sessionId}`);

    try {
      // Remove from memory
      this.sessions.delete(sessionId);

      // Remove from disk
      await this.deleteSessionFromDisk(sessionId);

      this.logger.info(`Session deleted: ${sessionId}`);
    } catch (error) {
      this.logger.error(`Failed to delete session: ${sessionId}`, error);
      throw new SessionError(
        `Failed to delete session: ${error instanceof Error ? error.message : String(error)}`,
        sessionId,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Adds a message to a session's conversation
   */
  async addMessage(
    sessionId: string,
    message: ConversationMessage
  ): Promise<void> {
    this.logger.debug(`Adding message to session: ${sessionId}`);

    try {
      const session = await this.loadSession(sessionId);

      // Add message to conversation
      session.conversation.push(message);

      // Update session state
      session.state.messageCount = session.conversation.length;
      session.state.lastActivity = new Date();
      session.updatedAt = new Date();

      // Save changes
      await this.persistSession(session);

      this.logger.debug(`Message added to session: ${sessionId}`);
    } catch (error) {
      this.logger.error(
        `Failed to add message to session: ${sessionId}`,
        error
      );
      throw new SessionError(
        `Failed to add message: ${error instanceof Error ? error.message : String(error)}`,
        sessionId,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Gets available session modes
   * Per ACP spec: Returns the list of modes available for sessions
   * Returns ACP-compliant SessionMode types from SDK
   */
  getAvailableModes(): SessionMode[] {
    return this.availableModes;
  }

  /**
   * Gets the complete session mode state
   * Per ACP spec: Returns SessionModeState with currentModeId and availableModes
   * @param sessionId - Optional session ID to get current mode for specific session
   * @returns SessionModeState with current mode and available modes
   */
  getSessionModeState(sessionId?: string): SessionModeState {
    const currentModeId = sessionId
      ? this.getSessionMode(sessionId)
      : ('ask' as SessionModeId);

    return {
      currentModeId,
      availableModes: this.availableModes,
    };
  }

  /**
   * Gets internal configuration for a mode
   * Returns implementation-specific config (not part of ACP spec)
   */
  getModeConfig(modeId: SessionModeId): InternalSessionModeConfig | undefined {
    return this.modeConfigs.get(modeId);
  }

  /**
   * Gets available session models
   * Per ACP spec (UNSTABLE): Returns the list of models available for sessions
   */
  getAvailableModels(): SessionModel[] {
    return this.availableModels;
  }

  /**
   * Sets available models (for testing purposes)
   * This allows tests to populate the models list without calling cursor-agent
   */
  setAvailableModels(models: SessionModel[]): void {
    this.availableModels = models;
    this.logger.debug('Available models updated', {
      count: models.length,
      models: models.map((m) => m.id),
    });
  }

  /**
   * Loads available models from cursor-agent CLI
   * Parses the output of `cursor-agent models` command
   * Falls back to default "auto" model if loading fails
   */
  async loadModelsFromCursorAgent(
    cursorBridge: CursorCliBridge
  ): Promise<void> {
    this.logger.debug('Loading models from cursor-agent CLI');

    try {
      const response = await cursorBridge.executeCommand(['models']);

      if (!response.success) {
        this.logger.warn(
          'Failed to load models from cursor-agent, using default "auto" model',
          { error: response.error }
        );
        return;
      }

      const models = this.parseModelsOutput(response.stdout || '');
      if (models.length > 0) {
        this.availableModels = models;
        this.logger.info(`Loaded ${models.length} models from cursor-agent`, {
          models: models.map((m) => m.id),
        });
      } else {
        this.logger.warn(
          'No models parsed from cursor-agent output, using default "auto" model'
        );
      }
    } catch (error) {
      this.logger.warn(
        'Error loading models from cursor-agent, using default "auto" model',
        { error }
      );
      // Keep default "auto" model
    }
  }

  /**
   * Parses the output of `cursor-agent models` command
   * Expected format:
   *   Available models
   *
   *   auto - Auto  (current)
   *   composer-1 - Composer 1
   *   gpt-5.2-codex - GPT-5.2 Codex
   *   ...
   */
  private parseModelsOutput(output: string): SessionModel[] {
    const models: SessionModel[] = [];
    const lines = output.split('\n');

    // Skip header line "Available models" and empty lines
    let inModelsSection = false;
    for (const line of lines) {
      const trimmed = line.trim();

      // Skip empty lines
      if (!trimmed) {
        continue;
      }

      // Detect start of models list
      if (trimmed.toLowerCase().includes('available models')) {
        inModelsSection = true;
        continue;
      }

      // Skip tip lines
      if (trimmed.toLowerCase().startsWith('tip:')) {
        continue;
      }

      // Parse model lines: "model-id - Model Name  (current)" or "model-id - Model Name"
      // Format: model ID and name are separated by " - "
      // The text "(default)" and "(current)" should be ignored
      if (inModelsSection) {
        // Split on " - " to separate model ID from name
        const dashIndex = trimmed.indexOf(' - ');
        if (dashIndex === -1) {
          continue; // Not a valid model line
        }

        // Extract model ID (everything before " - ") and trim whitespace
        const id = trimmed.substring(0, dashIndex).trim();

        // Extract model name (everything after " - ")
        let name = trimmed.substring(dashIndex + 3);

        // Remove optional "(current)" or "(default)" suffix (case-insensitive, with any whitespace)
        name = name.replace(/\s*\((?:current|default)\)\s*$/i, '');

        // Trim whitespace from model name
        name = name.trim();

        if (!id || !name) {
          continue;
        }

        // Skip if already have "auto" (we start with it)
        if (id === 'auto' && models.some((m) => m.id === 'auto')) {
          continue;
        }

        // Infer provider from model ID
        const provider = this.inferProvider(id);

        const contextWindow = this.resolveContextWindowForModel(id);

        models.push({
          id,
          name,
          provider,
          ...(contextWindow !== undefined && { contextWindow }),
        });
      }
    }

    // Ensure "auto" is first if it exists
    const autoIndex = models.findIndex((m) => m.id === 'auto');
    if (autoIndex > 0) {
      const autoModel = models.splice(autoIndex, 1)[0];
      if (autoModel) {
        models.unshift(autoModel);
      }
    } else if (autoIndex === -1) {
      // Add auto if not found
      const autoContextWindow = this.resolveContextWindowForModel('auto');
      models.unshift({
        id: 'auto',
        name: 'Auto',
        provider: 'cursor',
        ...(autoContextWindow !== undefined && { contextWindow: autoContextWindow }),
      });
    }

    return models;
  }

  /**
   * Infers the provider from model ID
   */
  private inferProvider(modelId: string): string {
    const id = modelId.toLowerCase();

    if (id.includes('gpt') || id.includes('codex')) {
      return 'openai';
    }
    if (id.includes('opus') || id.includes('sonnet') || id.includes('claude')) {
      return 'anthropic';
    }
    if (id.includes('gemini')) {
      return 'google';
    }
    if (id.includes('grok')) {
      return 'xai';
    }
    if (id === 'auto' || id.includes('composer')) {
      return 'cursor';
    }

    // Default to unknown if we can't infer
    return 'unknown';
  }

  getSessionModelContextWindow(sessionId: string): number {
    const currentModel = this.getSessionModel(sessionId);
    return this.resolveContextWindowForModel(currentModel);
  }

  private loadModelContextWindows(): void {
    this.modelContextWindows.clear();
    this.defaultModelContextWindow = DEFAULT_MODEL_CONTEXT_WINDOW;

    const configPath = MODEL_CONTEXT_WINDOWS_CONFIG_CANDIDATES.find((candidate) =>
      fsSync.existsSync(candidate)
    );
    if (!configPath) {
      this.logger.warn('Model context windows config not found, using defaults', {
        candidates: MODEL_CONTEXT_WINDOWS_CONFIG_CANDIDATES,
      });
      return;
    }

    try {
      const raw = fsSync.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw) as ModelContextWindowsConfig;
      const fallback = normalizeContextWindow(parsed.default);
      if (fallback != null) {
        this.defaultModelContextWindow = fallback;
      }

      const configured = parsed.models;
      if (configured && typeof configured === 'object') {
        for (const [modelId, size] of Object.entries(configured)) {
          const normalized = normalizeContextWindow(size);
          if (normalized != null) {
            this.modelContextWindows.set(modelId, normalized);
          }
        }
      }
    } catch (error) {
      this.logger.warn('Failed to load model context windows config, using defaults', {
        path: configPath,
        error,
      });
      this.modelContextWindows.clear();
      this.defaultModelContextWindow = DEFAULT_MODEL_CONTEXT_WINDOW;
    }
  }

  private resolveContextWindowForModel(modelId: string): number {
    return (
      this.modelContextWindows.get(modelId) ?? this.defaultModelContextWindow
    );
  }

  /**
   * Gets the current mode for a session
   * Per ACP spec: Returns the currentModeId
   */
  getSessionMode(sessionId: string): SessionModeId {
    const session = this.sessions.get(sessionId);
    return (session?.state.currentMode || 'ask') as SessionModeId;
  }

  /**
   * Gets the current model for a session
   */
  getSessionModel(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    return session?.state.currentModel || 'auto';
  }

  /**
   * Gets the cursor-agent chat ID for a session
   * Returns undefined if no chat ID is stored
   */
  getCursorChatId(sessionId: string): string | undefined {
    const session = this.sessions.get(sessionId);
    return session?.metadata['cursorChatId'] as string | undefined;
  }

  /**
   * Sets the cursor-agent chat ID for a session
   */
  async setCursorChatId(sessionId: string, chatId: string): Promise<void> {
    const session = await this.loadSession(sessionId);
    session.metadata['cursorChatId'] = chatId;
    session.updatedAt = new Date();
    await this.persistSession(session);
    this.logger.debug('Set cursor-agent chat ID for session', {
      sessionId,
      chatId,
    });
  }

  /**
   * Sets the mode for a session
   * Per ACP spec: Validates mode exists before setting
   * @param sessionId - The session ID
   * @param modeId - The mode ID (must be one of availableModes)
   * @returns The previous mode ID
   */
  async setSessionMode(
    sessionId: string,
    modeId: SessionModeId
  ): Promise<SessionModeId> {
    // Validate mode exists
    const mode = this.availableModes.find((m) => m.id === modeId);
    if (!mode) {
      throw new SessionError(
        `Invalid mode: ${modeId}. Available modes: ${this.availableModes.map((m) => m.id).join(', ')}`,
        sessionId
      );
    }

    // Load session to ensure it exists
    const session = await this.loadSession(sessionId);

    // Update mode
    const previousMode = (session.state.currentMode || 'ask') as SessionModeId;
    session.state.currentMode = modeId;
    session.metadata.mode = modeId;
    session.updatedAt = new Date();
    session.state.lastActivity = new Date();

    // Persist changes
    await this.persistSession(session);

    this.logger.info('Session mode changed', {
      sessionId,
      previousMode,
      newMode: modeId,
    });

    return previousMode;
  }

  /**
   * Sets the model for a session
   * Per ACP spec (UNSTABLE): Validates model exists before setting
   */
  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    // Validate model exists
    const model = this.availableModels.find((m) => m.id === modelId);
    if (!model) {
      const availableModelIds = this.availableModels
        .map((m) => m.id)
        .filter((id): id is string => id !== undefined)
        .join(', ');
      throw new SessionError(
        `Invalid model: ${modelId}. Available models: ${availableModelIds}`,
        sessionId
      );
    }

    // Load session to ensure it exists
    const session = await this.loadSession(sessionId);

    // Update model
    const previousModel = session.state.currentModel;
    session.state.currentModel = modelId;
    session.metadata.model = modelId;
    session.updatedAt = new Date();
    session.state.lastActivity = new Date();

    // Persist changes
    await this.persistSession(session);

    this.logger.info('Session model changed', {
      sessionId,
      previousModel,
      newModel: modelId,
    });
  }

  /**
   * Marks a session as actively processing a prompt
   * Sessions marked as processing will not be cleaned up
   */
  markSessionProcessing(sessionId: string): void {
    this.processingSessions.add(sessionId);
    this.logger.debug(`Marked session as processing: ${sessionId}`);
  }

  /**
   * Unmarks a session as actively processing
   */
  unmarkSessionProcessing(sessionId: string): void {
    this.processingSessions.delete(sessionId);
    this.logger.debug(`Unmarked session as processing: ${sessionId}`);
  }

  /**
   * Checks if a session is actively processing
   */
  isSessionProcessing(sessionId: string): boolean {
    return this.processingSessions.has(sessionId);
  }

  /**
   * Cleans up expired sessions
   * Skips sessions that are actively processing prompts
   */
  async cleanupExpiredSessions(): Promise<number> {
    this.logger.debug('Running session cleanup');

    const now = new Date();
    const expiredSessionIds: string[] = [];

    // Find expired sessions (excluding those actively processing)
    for (const [sessionId, session] of this.sessions) {
      // Skip sessions that are actively processing
      if (this.processingSessions.has(sessionId)) {
        this.logger.debug(
          `Skipping cleanup for processing session: ${sessionId}`
        );
        continue;
      }

      const timeSinceLastActivity =
        now.getTime() - session.state.lastActivity.getTime();
      if (timeSinceLastActivity > this.config.sessionTimeout) {
        expiredSessionIds.push(sessionId);
      }
    }

    // Remove expired sessions
    let successfullyCleanedCount = 0;
    for (const sessionId of expiredSessionIds) {
      try {
        await this.deleteSession(sessionId);
        successfullyCleanedCount++;
      } catch (error) {
        this.logger.warn(`Failed to cleanup session: ${sessionId}`, error);
      }
    }

    this.logger.info(
      `Cleaned up ${successfullyCleanedCount} of ${expiredSessionIds.length} expired sessions`
    );
    return successfullyCleanedCount;
  }

  /**
   * Performs full cleanup and shutdown
   */
  async cleanup(): Promise<void> {
    this.logger.info('Starting session manager cleanup');

    try {
      // Stop cleanup interval FIRST and set to null
      if (this.sessionCleanupInterval) {
        clearInterval(this.sessionCleanupInterval);
        this.sessionCleanupInterval = null;
      }

      // Persist all active sessions
      const persistPromises = Array.from(this.sessions.values()).map(
        (session) => this.persistSession(session)
      );

      await Promise.all(persistPromises);

      // Clear memory
      this.sessions.clear();
      this.processingSessions.clear();

      this.logger.info('Session manager cleanup completed');
    } catch (error) {
      this.logger.error('Error during session manager cleanup', error);
      throw new SessionError(
        `Cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Gets metrics about session usage
   */
  getMetrics(): Record<string, any> {
    return {
      totalSessions: this.sessions.size,
      maxSessions: this.config.maxSessions,
      sessionTimeout: this.config.sessionTimeout,
      // TODO: Add more detailed metrics
    };
  }

  // Private helper methods

  private startCleanupInterval(): void {
    const intervalMs = Math.min(this.config.sessionTimeout / 4, 300000); // Every 5 minutes max

    this.sessionCleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions().catch((error) => {
        this.logger.error('Session cleanup error', error);
      });
    }, intervalMs);
  }

  private async getAllSessions(): Promise<SessionData[]> {
    const sessions = new Map<string, SessionData>(this.sessions);
    const diskSessions = await this.loadAllSessionsFromDisk();
    for (const session of diskSessions) {
      if (!sessions.has(session.id)) {
        sessions.set(session.id, session);
      }
    }
    return Array.from(sessions.values());
  }

  private applyFilters(
    sessions: SessionData[],
    filter: Record<string, any>
  ): SessionData[] {
    return sessions.filter((session) => {
      for (const [key, value] of Object.entries(filter)) {
        // TODO: Implement more sophisticated filtering
        if (key === 'name' && !session.metadata.name?.includes(String(value))) {
          return false;
        }
        if (key === 'tags' && !session.metadata.tags?.includes(String(value))) {
          return false;
        }
      }
      return true;
    });
  }

  private getSessionStatus(session: SessionData): SessionStatus {
    const now = new Date();
    const timeSinceLastActivity =
      now.getTime() - session.state.lastActivity.getTime();

    if (timeSinceLastActivity > this.config.sessionTimeout) {
      return 'expired';
    }

    if (timeSinceLastActivity > this.config.sessionTimeout / 2) {
      return 'inactive';
    }

    return 'active';
  }

  private async persistSession(session: SessionData): Promise<void> {
    const filePath = this.sessionFilePath(session.id);
    const tempPath = `${filePath}.tmp`;
    this.logger.debug(`Persisting session: ${session.id}`, { filePath });
    await this.ensureSessionDir();
    const payload = JSON.stringify(this.serializeSession(session), null, 2);
    await fs.writeFile(tempPath, payload, 'utf8');
    await fs.rename(tempPath, filePath);
  }

  private async loadSessionFromDisk(
    sessionId: string
  ): Promise<SessionData | null> {
    const filePath = this.sessionFilePath(sessionId);
    this.logger.debug(`Loading session from disk: ${sessionId}`, { filePath });
    try {
      const payload = await fs.readFile(filePath, 'utf8');
      return this.deserializeSession(JSON.parse(payload), filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  private async deleteSessionFromDisk(sessionId: string): Promise<void> {
    const filePath = this.sessionFilePath(sessionId);
    this.logger.debug(`Deleting session from disk: ${sessionId}`, { filePath });
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  private sessionFilePath(sessionId: string): string {
    return path.join(path.resolve(this.config.sessionDir), `${sessionId}.json`);
  }

  private async ensureSessionDir(): Promise<void> {
    await fs.mkdir(path.resolve(this.config.sessionDir), { recursive: true });
  }

  private serializeSession(session: SessionData): PersistedSessionRecord {
    return {
      version: 1,
      id: session.id,
      metadata: session.metadata,
      conversation: session.conversation.map((message) => ({
        ...message,
        timestamp: message.timestamp.toISOString(),
      })),
      state: {
        ...session.state,
        lastActivity: session.state.lastActivity.toISOString(),
      },
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
    };
  }

  private deserializeSession(raw: unknown, source: string): SessionData {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Invalid session file at ${source}: expected object`);
    }
    const record = raw as Partial<PersistedSessionRecord>;
    if (record.version !== 1) {
      throw new Error(`Invalid session file at ${source}: unsupported version`);
    }
    if (typeof record.id !== 'string' || record.id.trim() === '') {
      throw new Error(`Invalid session file at ${source}: missing id`);
    }
    if (!record.metadata || typeof record.metadata !== 'object') {
      throw new Error(`Invalid session file at ${source}: missing metadata`);
    }
    if (!Array.isArray(record.conversation)) {
      throw new Error(`Invalid session file at ${source}: invalid conversation`);
    }
    if (!record.state || typeof record.state !== 'object') {
      throw new Error(`Invalid session file at ${source}: missing state`);
    }
    const state = record.state as PersistedSessionRecord['state'];
    const createdAt = new Date(String(record.createdAt));
    const updatedAt = new Date(String(record.updatedAt));
    const lastActivity = new Date(String(state.lastActivity));
    if (
      Number.isNaN(createdAt.getTime()) ||
      Number.isNaN(updatedAt.getTime()) ||
      Number.isNaN(lastActivity.getTime())
    ) {
      throw new Error(`Invalid session file at ${source}: invalid timestamps`);
    }
    return {
      id: record.id,
      metadata: { ...(record.metadata as SessionMetadata) },
      conversation: record.conversation.map((message) => {
        const timestamp = new Date(String(message.timestamp));
        if (Number.isNaN(timestamp.getTime())) {
          throw new Error(
            `Invalid session file at ${source}: invalid message timestamp`
          );
        }
        return {
          ...message,
          timestamp,
        } as ConversationMessage;
      }),
      state: {
        ...state,
        lastActivity,
      },
      createdAt,
      updatedAt,
    };
  }

  private async loadAllSessionsFromDisk(): Promise<SessionData[]> {
    try {
      await this.ensureSessionDir();
      const entries = await fs.readdir(path.resolve(this.config.sessionDir), {
        withFileTypes: true,
      });
      const sessions: SessionData[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
          continue;
        }
        const filePath = path.join(path.resolve(this.config.sessionDir), entry.name);
        try {
          const payload = await fs.readFile(filePath, 'utf8');
          sessions.push(this.deserializeSession(JSON.parse(payload), filePath));
        } catch (error) {
          this.logger.warn('Skipping unreadable session file', {
            filePath,
            error,
          });
        }
      }
      return sessions;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }
}
