import type { Config } from "../config/index.js";
import type { AcpBackend } from "../acp/runtime-contract.js";

export interface TestConfigOverrides {
  /** 覆盖 acp.backend，默认 "cursor-official" */
  backend?: AcpBackend;
  /** 覆盖 acp.enabledBackends，默认 [backend] */
  enabledBackends?: AcpBackend[];
  /** 深度覆盖 acp 块 */
  acp?: Partial<Config["acp"]>;
  /** 深度覆盖 bridge 块 */
  bridge?: Partial<Config["bridge"]>;
}

/**
 * 创建测试用 Config 对象。
 *
 * 所有 8 个测试文件共享此工厂，消除重复的 Config 构造代码。
 * 通过 overrides 参数按需覆盖任意字段。
 */
export function createTestConfig(overrides?: TestConfigOverrides): Config {
  const backend = overrides?.backend ?? "cursor-official";
  const enabledBackends = overrides?.enabledBackends ?? [backend];

  return {
    feishu: {
      appId: "app-id",
      appSecret: "app-secret",
      domain: "feishu",
    },
    acp: {
      backend,
      enabledBackends,
      nodePath: process.execPath,
      adapterEntry: "",
      extraArgs: [],
      officialAgentPath: "agent",
      claudeSpawnCommand: "npx",
      claudeSpawnArgs: ["-y", "@agentclientprotocol/claude-agent-acp"],
      codexSpawnCommand: "npx",
      codexSpawnArgs: ["-y", "@zed-industries/codex-acp"],
      workspaceRoot: "/tmp",
      allowedWorkspaceRoots: ["/tmp"],
      adapterSessionDir: "/tmp/acp-sessions",
      ...overrides?.acp,
    },
    bridge: {
      adminUserIds: [],
      groupSessionScope: "per-user",
      maxSessionsPerUser: 10,
      sessionIdleTimeoutMs: 60_000,
      sessionStorePath: "/tmp/sessions.json",
      cardUpdateThrottleMs: 0,
      cardSplitMarkdownThreshold: 3_500,
      cardSplitToolThreshold: 8,
      workspacePresetsPath: "/tmp/workspace-presets.json",
      workspacePresetsSeed: [],
      maintenanceStatePath: "/tmp/maintenance-state.json",
      singleInstanceLockPath: "/tmp/bridge.lock",
      allowMultipleInstances: false,
      managedByService: false,
      experimentalLogToFile: false,
      experimentalLogFilePath: "/tmp/bridge.log",
      slotMessageLogEnabled: false,
      sessionHistoryEnabled: true,
      showAcpAvailableCommands: false,
      enableBangCommand: false,
      enableUpgradeCommand: false,
      upgradeAdmins: {
        openIds: new Set<string>(),
        userIds: new Set<string>(),
        unionIds: new Set<string>(),
      },
      serviceScriptPath: "/tmp/service.sh",
      upgradeResultPath: "/tmp/upgrade-result.json",
      ...overrides?.bridge,
    },
    autoApprovePermissions: false,
    bridgeDebug: false,
    acpReloadTraceLog: false,
    logLevel: "info",
  };
}
