import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const srcRoot = path.join(repoRoot, "src");

/** 测试执行超时（毫秒），防止无响应测试导致 CI 挂起 */
const TEST_TIMEOUT_MS = 120_000;

async function collectTestFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTestFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

const testFiles = (await collectTestFiles(srcRoot)).sort();
if (testFiles.length === 0) {
  console.error("No test files found under src/");
  process.exit(1);
}

await new Promise((resolve, reject) => {
  const child = spawn(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["tsx", "--test", ...testFiles],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
    },
  );

  // 超时保护：超时后先 SIGTERM，3 秒后仍存活则 SIGKILL
  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 3_000);
    killTimer.unref?.();
    reject(new Error(`Test runner timed out after ${TEST_TIMEOUT_MS}ms`));
  }, TEST_TIMEOUT_MS);
  timeout.unref?.();

  child.on("error", (err) => {
    clearTimeout(timeout);
    reject(err);
  });

  child.on("exit", (code, signal) => {
    clearTimeout(timeout);
    if (signal) {
      reject(new Error(`Test runner exited with signal ${signal}`));
      return;
    }
    if (code === 0) {
      resolve(undefined);
      return;
    }
    reject(new Error(`Test runner exited with code ${code ?? -1}`));
  });
});
