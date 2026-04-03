import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** 解析已安装的 @blowmage/cursor-agent-acp CLI 脚本路径 */
export function resolveBundledAdapterEntry(): string {
  const pkgJson = require.resolve("@blowmage/cursor-agent-acp/package.json");
  return path.join(path.dirname(pkgJson), "dist", "bin", "cursor-agent-acp.js");
}

/** 解析已安装的 tsx CLI 入口，用于直接以 `node <tsx-cli> <script.ts>` 方式启动 TypeScript 脚本 */
export function resolveBundledTsxCliEntry(): string {
  const pkgJson = require.resolve("tsx/package.json");
  return path.join(path.dirname(pkgJson), "dist", "cli.mjs");
}

/** 解析仓库内置的 tmux ACP server 原型入口 */
export function resolveBundledTmuxAcpServerEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "poc", "tmux-runtime", "tmux-acp-server.ts");
}
