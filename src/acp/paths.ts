import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** 桥接仓库根目录（paths.ts 位于 src/acp 或 dist/acp） */
function resolveBridgeRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
}

/** `vendor/cursor-agent-acp` 源码入口（桥接以 `tsx src/index.ts` 启动时由桥接侧注入 tsx） */
export function resolveLegacyAdapterSourceEntry(): string {
  return path.join(
    resolveBridgeRepoRoot(),
    "vendor",
    "cursor-agent-acp",
    "src",
    "bin",
    "cursor-agent-acp.ts",
  );
}

/** `vendor/cursor-agent-acp` 构建产物（桥接以 `node dist/index.js` 启动时） */
export function resolveLegacyAdapterDistEntry(): string {
  return path.join(
    resolveBridgeRepoRoot(),
    "vendor",
    "cursor-agent-acp",
    "dist",
    "bin",
    "cursor-agent-acp.js",
  );
}

/** 解析已安装的 tsx CLI 入口，用于直接以 `node <tsx-cli> <script.ts>` 方式启动 TypeScript 脚本 */
export function resolveBundledTsxCliEntry(): string {
  const pkgJson = require.resolve("tsx/package.json");
  return path.join(path.dirname(pkgJson), "dist", "cli.mjs");
}
