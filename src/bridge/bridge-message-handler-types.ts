import type {
  AcpBackend,
  AcpSessionModelState,
  AcpSessionUsageState,
  BridgeAcpRuntime,
} from "../acp/runtime-contract.js";
import type { Config } from "../config/index.js";
import type { FeishuBot, FeishuMessage } from "../feishu/bot.js";
import type { SessionManager } from "../session/manager.js";
import type { WorkspacePresetsStore } from "../session/workspace-presets-store.js";
import type {
  BridgeMaintenanceStateStore,
  BridgeMaintenanceCommandKind,
  CompletedBridgeMaintenanceTask,
} from "./maintenance-state.js";
import type {
  UpgradeAttemptRecord,
  UpgradeResultStore,
} from "./upgrade-result-store.js";
import type { SlotMessageLogStore } from "./slot-message-log.js";
import type { ConversationService } from "./conversation-service.js";

export type ThreadReplyOpts = { replyInThread: true } | undefined;

export type ActiveMaintenanceInfo = {
  kind: BridgeMaintenanceCommandKind;
  requestedAt: number;
} | null;

export interface BridgeMessageHandlerDeps {
  config: Config;
  feishuBot: FeishuBot;
  sessionManager: SessionManager;
  presetsStore: WorkspacePresetsStore;
  slotMessageLog: SlotMessageLogStore | null;
  maintenanceStateStore: BridgeMaintenanceStateStore;
  upgradeResultStore: UpgradeResultStore;
  activePrompts: Set<string>;
  ensureMaintenanceStateLoaded(): Promise<void>;
  handleUpgradeCommand(
    msg: FeishuMessage,
    command: { force: boolean; invalidUsage?: boolean },
  ): Promise<void>;
  handleMaintenanceCommand(
    msg: FeishuMessage,
    command: {
      kind: "restart" | "update" | "upgrade";
      force: boolean;
      invalidUsage?: boolean;
    },
  ): Promise<void>;
  flushPendingSessionNotices(msg: FeishuMessage): Promise<void>;
  threadReplyOpts(msg: FeishuMessage): ThreadReplyOpts;
  threadScope(msg: FeishuMessage): string | undefined;
  runtimeForBackend(backend: AcpBackend): BridgeAcpRuntime;
  runtimeForSession(session: { backend: AcpBackend }): BridgeAcpRuntime;
  conversationForBackend(backend: AcpBackend): ConversationService;
  feishuSessionKey(msg: FeishuMessage): string;
  isManagedByService(): Promise<boolean>;
  getActiveMaintenance(): ActiveMaintenanceInfo;
  formatWhoAmIMessage(senderId: string): string;
  formatDurationMs(ms: number): string;
  formatSessionUsage(
    usage: AcpSessionUsageState | undefined,
  ): string | undefined;
  formatSessionModel(
    modelState: AcpSessionModelState | undefined,
  ): string | undefined;
  formatIsoTimestamp(ms: number): string;
  formatMaintenanceTaskSummary(
    task: CompletedBridgeMaintenanceTask,
  ): string;
  formatUpgradeAttemptSummary(attempt: UpgradeAttemptRecord): string;
}
