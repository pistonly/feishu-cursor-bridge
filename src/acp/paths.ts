import { createRequire } from "node:module";
import * as path from "node:path";

const require = createRequire(import.meta.url);

/** 解析已安装的 @blowmage/cursor-agent-acp CLI 脚本路径 */
export function resolveBundledAdapterEntry(): string {
  const pkgJson = require.resolve("@blowmage/cursor-agent-acp/package.json");
  return path.join(path.dirname(pkgJson), "dist", "bin", "cursor-agent-acp.js");
}
