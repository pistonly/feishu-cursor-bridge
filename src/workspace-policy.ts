import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expandHome } from "./config.js";
import type { Config } from "./config.js";

/**
 * 判断 target 是否落在任一 root 之下（含与 root 相同）。
 */
export function isPathUnderAllowedRoots(
  roots: string[],
  targetAbs: string,
): boolean {
  const t = path.resolve(targetAbs);
  for (const r of roots) {
    const root = path.resolve(r);
    const rel = path.relative(root, t);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      return true;
    }
  }
  return false;
}

/**
 * 解析并校验用户输入的工作区路径：须为已存在目录，且在 `allowedWorkspaceRoots` 允许范围内。
 */
export async function resolveAllowedWorkspaceDir(
  rawPath: string,
  config: Config,
): Promise<string> {
  const abs = path.resolve(expandHome(rawPath.trim()));
  let st;
  try {
    st = await fs.stat(abs);
  } catch (e) {
    throw new Error(
      `路径无效或不可访问: ${abs}（${e instanceof Error ? e.message : String(e)}）`,
    );
  }
  if (!st.isDirectory()) {
    throw new Error(`不是目录: ${abs}`);
  }
  if (!isPathUnderAllowedRoots(config.acp.allowedWorkspaceRoots, abs)) {
    throw new Error(
      `工作区不在允许范围内。允许的根:\n${config.acp.allowedWorkspaceRoots.map((r) => `• ${r}`).join("\n")}\n\n可通过环境变量 CURSOR_WORK_ALLOWLIST 配置多个根（逗号分隔）。`,
    );
  }
  return abs;
}
