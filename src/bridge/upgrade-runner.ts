import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { loadConfig } from "../config/index.js";
import {
  appendOutputTail,
  UpgradeResultStore,
  truncateOutputTail,
} from "./upgrade-result-store.js";

/** Upgrade execution timeout (10 minutes). Prevents permanent hangs on network issues. */
const UPGRADE_TIMEOUT_MS = 10 * 60 * 1000;

/** Grace period after SIGTERM before escalating to SIGKILL (5 seconds). */
const KILL_GRACE_PERIOD_MS = 5_000;

// --- Module-level state for signal handlers ---

let activeChild: ChildProcess | null = null;
let activeStore: UpgradeResultStore | null = null;
let activeAttemptId: string | null = null;
let upgradeTimedOut = false;

async function markFailed(
  store: UpgradeResultStore,
  attemptId: string,
  errorMessage: string,
): Promise<void> {
  const latest = store.getAttempt();
  if (!latest || latest.id !== attemptId) return;
  store.setAttempt({
    ...latest,
    state: "failed",
    finishedAt: Date.now(),
    errorMessage,
  });
  await store.flush();
}

async function main(): Promise<void> {
  const attemptId = process.argv[2]?.trim();
  if (!attemptId) {
    throw new Error("Missing upgrade attempt id");
  }

  const config = loadConfig();
  const store = new UpgradeResultStore(config.bridge.upgradeResultPath);
  await store.load();

  const existing = store.getAttempt();
  if (!existing || existing.id !== attemptId) {
    return;
  }

  // Expose to module-level signal handlers
  activeStore = store;
  activeAttemptId = attemptId;

  store.setAttempt({
    ...existing,
    state: "running",
    startedAt: Date.now(),
    runnerPid: process.pid,
    finishedAt: undefined,
    exitCode: undefined,
    signal: undefined,
    errorMessage: undefined,
    outputTail: undefined,
  });
  await store.flush();

  const child = spawn(
    "bash",
    [config.bridge.serviceScriptPath, "upgrade"],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  activeChild = child;

  let outputTail = "";
  child.stdout.on("data", (chunk) => {
    outputTail = appendOutputTail(outputTail, String(chunk)) ?? "";
  });
  child.stderr.on("data", (chunk) => {
    outputTail = appendOutputTail(outputTail, String(chunk)) ?? "";
  });

  // Timeout: kill the child process if it runs too long
  const timeoutHandle = setTimeout(() => {
    upgradeTimedOut = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // child may have already exited
    }
    // Escalate to SIGKILL after grace period
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
    }, KILL_GRACE_PERIOD_MS);
  }, UPGRADE_TIMEOUT_MS);

  const result = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.on("error", (err) => {
      clearTimeout(timeoutHandle);
      reject(err);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeoutHandle);
      resolve({ exitCode, signal });
    });
  });

  const latest = store.getAttempt();
  if (!latest || latest.id !== attemptId) {
    return;
  }

  if (upgradeTimedOut) {
    store.setAttempt({
      ...latest,
      state: "failed",
      finishedAt: Date.now(),
      exitCode: result.exitCode ?? undefined,
      signal: result.signal ?? undefined,
      errorMessage: `Upgrade timed out after ${UPGRADE_TIMEOUT_MS / 60_000} minutes`,
      outputTail: truncateOutputTail(outputTail),
    });
  } else if (result.exitCode === 0) {
    store.setAttempt({
      ...latest,
      state: "succeeded",
      finishedAt: Date.now(),
      exitCode: 0,
      signal: result.signal ?? undefined,
      outputTail: truncateOutputTail(outputTail),
    });
  } else {
    store.setAttempt({
      ...latest,
      state: "failed",
      finishedAt: Date.now(),
      exitCode: result.exitCode ?? undefined,
      signal: result.signal ?? undefined,
      errorMessage:
        result.signal != null
          ? `Upgrade runner terminated by signal ${result.signal}`
          : `Upgrade exited with code ${result.exitCode ?? "unknown"}`,
      outputTail: truncateOutputTail(outputTail),
    });
  }
  await store.flush();
}

// --- Signal handlers: clean up child + persist failure state ---

async function handleSignal(signal: NodeJS.Signals): Promise<void> {
  // Kill the child process first
  if (activeChild) {
    try {
      activeChild.kill("SIGTERM");
    } catch {
      // already dead
    }
    // Give it a brief grace period, then SIGKILL
    setTimeout(() => {
      try {
        activeChild?.kill("SIGKILL");
      } catch {
        // already dead
      }
    }, KILL_GRACE_PERIOD_MS);
  }

  // Persist failure state if we have enough context
  if (activeStore && activeAttemptId) {
    try {
      await markFailed(
        activeStore,
        activeAttemptId,
        `Upgrade runner terminated by signal ${signal}`,
      );
    } catch {
      // best-effort
    }
  }
  process.exit(1);
}

process.on("SIGTERM", () => void handleSignal("SIGTERM"));
process.on("SIGINT", () => void handleSignal("SIGINT"));

main().catch(async (error) => {
  console.error(
    "[upgrade-runner] Fatal error:",
    error instanceof Error ? error.message : String(error),
  );
  try {
    // Reuse already-loaded store when available; avoids re-loading config
    // which may have been the original cause of failure.
    if (activeStore && activeAttemptId) {
      await markFailed(
        activeStore,
        activeAttemptId,
        error instanceof Error ? error.message : String(error),
      );
    }
    // If activeStore is null, config loading failed before store was created.
    // The attempt remains in "queued" state on disk, and bridge's
    // reconcileUpgradeAttempt() on next startup will mark it as failed
    // with "Upgrade launcher did not start".
  } catch {
    // ignore secondary persistence failure
  }
  process.exit(1);
});
