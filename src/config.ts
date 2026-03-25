export interface Config {
  feishu: {
    appId: string;
    appSecret: string;
    domain: string;
  };
  cursor: {
    agentPath: string;
    apiKey?: string;
    authToken?: string;
    workDir: string;
  };
  autoApprovePermissions: boolean;
  /** 为 true 时：控制台输出 ACP/会话调试信息，/status 显示 sessionId 等 */
  bridgeDebug: boolean;
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

export function loadConfig(): Config {
  const logLevel = process.env["LOG_LEVEL"] ?? "info";
  if (!LOG_LEVELS.has(logLevel)) {
    throw new Error(
      `Invalid LOG_LEVEL "${logLevel}". Must be one of: debug, info, warn, error`,
    );
  }

  return {
    feishu: {
      appId: requireEnv("FEISHU_APP_ID"),
      appSecret: requireEnv("FEISHU_APP_SECRET"),
      domain: process.env["FEISHU_DOMAIN"] ?? "feishu",
    },
    cursor: {
      agentPath: process.env["CURSOR_AGENT_PATH"] ?? "agent",
      apiKey: process.env["CURSOR_API_KEY"] || undefined,
      authToken: process.env["CURSOR_AUTH_TOKEN"] || undefined,
      workDir: process.env["CURSOR_WORK_DIR"] ?? process.cwd(),
    },
    autoApprovePermissions:
      (process.env["AUTO_APPROVE_PERMISSIONS"] ?? "true").toLowerCase() ===
      "true",
    bridgeDebug:
      (process.env["BRIDGE_DEBUG"] ?? "false").toLowerCase() === "true",
    logLevel: logLevel as Config["logLevel"],
  };
}
