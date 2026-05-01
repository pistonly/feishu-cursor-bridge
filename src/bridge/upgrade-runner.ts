import "dotenv/config";
import { spawn } from "node:child_process";
import { loadConfig } from "../config/index.js";
import {
  appendOutputTail,
  UpgradeResultStore,
  truncateOutputTail,
} from "./upgrade-result-store.js";

async function main() {
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

  let outputTail = "";
  child.stdout.on("data", (chunk) => {
    outputTail = appendOutputTail(outputTail, String(chunk)) ?? "";
  });
  child.stderr.on("data", (chunk) => {
    outputTail = appendOutputTail(outputTail, String(chunk)) ?? "";
  });

  const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });

  const latest = store.getAttempt();
  if (!latest || latest.id !== attemptId) {
    return;
  }

  if (result.exitCode === 0) {
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

main().catch(async (error) => {
  try {
    const attemptId = process.argv[2]?.trim();
    if (attemptId) {
      const config = loadConfig();
      const store = new UpgradeResultStore(config.bridge.upgradeResultPath);
      await store.load();
      const latest = store.getAttempt();
      if (latest?.id === attemptId) {
        store.setAttempt({
          ...latest,
          state: "failed",
          finishedAt: Date.now(),
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        await store.flush();
      }
    }
  } catch {
    // ignore secondary persistence failure
  }
  process.exit(1);
});
