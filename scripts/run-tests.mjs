import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const srcRoot = path.join(repoRoot, "src");

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
  child.on("error", reject);
  child.on("exit", (code, signal) => {
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
