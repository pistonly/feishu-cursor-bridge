import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseDotenv } from "dotenv";
import {
  expandHomeWith,
  normalizeBridgeInstanceName,
} from "./config/index.js";

export interface ScriptConfigOptions {
  env?: NodeJS.ProcessEnv;
  dotenvPath?: string;
  repoRoot?: string;
  homeDir?: string;
}

export interface ScriptConfigView {
  repoRoot: string;
  dotenvPath: string;
  instanceName?: string;
  launchdLabel: string;
  systemdUnitName: string;
  serviceLogPath: string;
  singleInstanceLockPath: string;
  bridgeDevLogPath: string;
  experimentalLogToFile: boolean;
  experimentalLogFilePath: string;
  condaRoot?: string;
  condaEnvName: string;
  condaBinPath?: string;
  upgradeRemote: string;
  upgradeBranch?: string;
}

function resolveRepoRoot(repoRoot?: string): string {
  if (repoRoot?.trim()) {
    return path.resolve(repoRoot);
  }
  return path.resolve(process.cwd());
}

function resolveHomeDir(homeDir?: string): string {
  return homeDir?.trim() ? path.resolve(homeDir) : os.homedir();
}

function readDotenvMap(dotenvPath: string): Record<string, string> {
  if (!fs.existsSync(dotenvPath)) return {};
  return parseDotenv(fs.readFileSync(dotenvPath, "utf8"));
}

function readEnvValue(
  key: string,
  env: NodeJS.ProcessEnv,
  dotenvMap: Record<string, string>,
): string | undefined {
  const fromEnv = env[key]?.trim();
  if (fromEnv) return fromEnv;
  const fromDotenv = dotenvMap[key]?.trim();
  return fromDotenv ? fromDotenv : undefined;
}

function resolvePathLikeApp(
  raw: string,
  repoRoot: string,
  homeDir: string,
): string {
  return path.resolve(repoRoot, expandHomeWith(raw.trim(), homeDir));
}

function resolveOptionalPathLikeApp(
  raw: string | undefined,
  repoRoot: string,
  homeDir: string,
): string | undefined {
  if (!raw?.trim()) return undefined;
  return resolvePathLikeApp(raw, repoRoot, homeDir);
}

function bridgeStateDir(homeDir: string, instanceName: string | undefined): string {
  return instanceName
    ? path.join(homeDir, ".feishu-cursor-bridge", instanceName)
    : path.join(homeDir, ".feishu-cursor-bridge");
}

function parseBooleanLike(raw: string | undefined, fallback = false): boolean {
  if (!raw?.trim()) return fallback;
  return raw.trim().toLowerCase() === "true";
}

function resolveCondaRoot(
  env: NodeJS.ProcessEnv,
  dotenvMap: Record<string, string>,
  repoRoot: string,
  homeDir: string,
): string | undefined {
  const configured = resolveOptionalPathLikeApp(
    readEnvValue("CONDA_ROOT", env, dotenvMap),
    repoRoot,
    homeDir,
  );
  if (configured) return configured;

  const miniconda = path.join(homeDir, "miniconda3");
  if (fs.existsSync(miniconda) && fs.statSync(miniconda).isDirectory()) {
    return miniconda;
  }
  const anaconda = path.join(homeDir, "anaconda3");
  if (fs.existsSync(anaconda) && fs.statSync(anaconda).isDirectory()) {
    return anaconda;
  }
  return undefined;
}

function resolveCondaBinPath(
  condaRoot: string | undefined,
  condaEnvName: string,
): string | undefined {
  if (!condaRoot) return undefined;
  const condaBin =
    condaEnvName === "base"
      ? path.join(condaRoot, "bin")
      : path.join(condaRoot, "envs", condaEnvName, "bin");
  if (!fs.existsSync(condaBin)) return undefined;
  if (!fs.statSync(condaBin).isDirectory()) return undefined;
  return condaBin;
}

export function loadScriptConfig(
  options: ScriptConfigOptions = {},
): ScriptConfigView {
  const repoRoot = resolveRepoRoot(options.repoRoot);
  const homeDir = resolveHomeDir(options.homeDir);
  const dotenvPath = path.resolve(options.dotenvPath ?? path.join(repoRoot, ".env"));
  const env = options.env ?? process.env;
  const dotenvMap = readDotenvMap(dotenvPath);
  const instanceName = normalizeBridgeInstanceName(
    readEnvValue("BRIDGE_INSTANCE_NAME", env, dotenvMap),
  );
  const defaultStateDir = bridgeStateDir(homeDir, instanceName);
  const launchdLabel = instanceName
    ? `com.feishu-cursor-bridge.${instanceName}`
    : "com.feishu-cursor-bridge";
  const systemdUnitName = instanceName
    ? `feishu-cursor-bridge.${instanceName}.service`
    : "feishu-cursor-bridge.service";
  const serviceLogPath = instanceName
    ? `/tmp/feishu-cursor-bridge.${instanceName}.log`
    : "/tmp/feishu-cursor-bridge.log";

  const singleInstanceLockPath = resolveOptionalPathLikeApp(
    readEnvValue("BRIDGE_SINGLE_INSTANCE_LOCK", env, dotenvMap),
    repoRoot,
    homeDir,
  ) ?? path.join(defaultStateDir, "bridge.lock");

  const bridgeDevLogPath = resolveOptionalPathLikeApp(
    env["BRIDGE_DEV_LOG_FILE"]?.trim(),
    repoRoot,
    homeDir,
  ) ?? path.join(defaultStateDir, "logs", "bridge-dev.log");

  const experimentalLogToFile = parseBooleanLike(
    readEnvValue("EXPERIMENT_LOG_TO_FILE", env, dotenvMap),
    false,
  );
  const experimentalLogFilePath = resolveOptionalPathLikeApp(
    readEnvValue("EXPERIMENT_LOG_FILE", env, dotenvMap),
    repoRoot,
    homeDir,
  ) ?? path.join(defaultStateDir, "logs", "bridge.log");

  const condaEnvName =
    readEnvValue("CONDA_ENV_NAME", env, dotenvMap)?.trim() || "base";
  const condaRoot = resolveCondaRoot(env, dotenvMap, repoRoot, homeDir);
  const condaBinPath = resolveCondaBinPath(condaRoot, condaEnvName);

  const upgradeRemote =
    readEnvValue("BRIDGE_UPGRADE_REMOTE", env, dotenvMap)?.trim() || "origin";
  const upgradeBranch =
    readEnvValue("BRIDGE_UPGRADE_BRANCH", env, dotenvMap)?.trim() || undefined;

  return {
    repoRoot,
    dotenvPath,
    ...(instanceName ? { instanceName } : {}),
    launchdLabel,
    systemdUnitName,
    serviceLogPath,
    singleInstanceLockPath,
    bridgeDevLogPath,
    experimentalLogToFile,
    experimentalLogFilePath,
    ...(condaRoot ? { condaRoot } : {}),
    condaEnvName,
    ...(condaBinPath ? { condaBinPath } : {}),
    upgradeRemote,
    ...(upgradeBranch ? { upgradeBranch } : {}),
  };
}
