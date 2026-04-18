import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function extractMarkedBlock(content: string, marker: string): string {
  const start = `<!-- ${marker}:start -->`;
  const end = `<!-- ${marker}:end -->`;
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  assert.notEqual(startIndex, -1, `missing start marker: ${marker}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${marker}`);
  assert.ok(endIndex > startIndex, `invalid marker order: ${marker}`);
  return content.slice(startIndex + start.length, endIndex).trim();
}

function readRootPackageScripts(): Record<string, string> {
  const pkg = JSON.parse(readRepoFile("package.json")) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

function buildReadmeDevHelperSnippet(language: "en" | "zh"): string {
  if (language === "en") {
    return [
      "# Debug: stop other instances before dev (single-instance lock)",
      "# ./scripts/bridge-dev.sh",
      "# npm run dev:restart",
      "# scripts/bridge-dev.sh and service.sh now share the same TS-side env/path resolution rules for lock/log defaults.",
    ].join("\n");
  }
  return [
    "# 调试：先结束已有实例再起 dev（与单实例锁配合，避免多进程）",
    "# ./scripts/bridge-dev.sh",
    "# npm run dev:restart",
    "# scripts/bridge-dev.sh 和 service.sh 现在共用同一套 TS 侧 env/path 解析语义来确定 lock/log 默认值。",
  ].join("\n");
}

function buildReadmeServiceCommandsSnippet(language: "en" | "zh"): string {
  if (language === "en") {
    return [
      "bash service.sh install    # npm install + build + install + start",
      "bash service.sh update     # after git pull / code edits: rebuild dist + restart",
      "bash service.sh status",
      "bash service.sh logs       # macOS: follow log file; Linux: journalctl -f",
    ].join("\n");
  }
  return [
    "bash service.sh install    # npm install + build + 安装并启动",
    "bash service.sh update     # pull / 改代码后：install + build + 重启，使 dist 生效",
    "bash service.sh status",
    "bash service.sh logs       # macOS：跟日志文件；Linux：journalctl -f",
  ].join("\n");
}

function buildReadmeTestDiscoveryNote(language: "en" | "zh"): string {
  const scripts = readRootPackageScripts();
  const testEntry = scripts["test"];
  assert.equal(testEntry, "node scripts/run-tests.mjs");
  if (language === "en") {
    return `\`npm test\` now runs through the repo-local Node entry \`${testEntry.replace(/^node\s+/, "")}\` instead of shell \`find | xargs\`, so test discovery stays in-repo and cross-shell behavior is more stable.`;
  }
  return `\`npm test\` 现在通过仓库内的 Node 入口 \`${testEntry.replace(/^node\s+/, "")}\` 做测试发现，不再依赖 shell 的 \`find | xargs\`，便于后续维护并减少跨 shell 差异。`;
}

test("README anti-drift snippets stay aligned for dev helper usage", () => {
  const readme = readRepoFile("README.md");
  assert.equal(
    extractMarkedBlock(readme, "readme-dev-helper-en"),
    buildReadmeDevHelperSnippet("en"),
  );
  assert.equal(
    extractMarkedBlock(readme, "readme-dev-helper-zh"),
    buildReadmeDevHelperSnippet("zh"),
  );
});

test("README anti-drift snippets stay aligned for service command examples", () => {
  const readme = readRepoFile("README.md");
  assert.equal(
    extractMarkedBlock(readme, "readme-service-commands-en"),
    buildReadmeServiceCommandsSnippet("en"),
  );
  assert.equal(
    extractMarkedBlock(readme, "readme-service-commands-zh"),
    buildReadmeServiceCommandsSnippet("zh"),
  );
});

test("README anti-drift snippets stay aligned for test discovery notes", () => {
  const readme = readRepoFile("README.md");
  assert.equal(
    extractMarkedBlock(readme, "readme-test-discovery-note-en"),
    buildReadmeTestDiscoveryNote("en"),
  );
  assert.equal(
    extractMarkedBlock(readme, "readme-test-discovery-note-zh"),
    buildReadmeTestDiscoveryNote("zh"),
  );
});
