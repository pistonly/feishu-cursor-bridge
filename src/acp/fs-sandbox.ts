import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * 确保 filePath 落在 root 目录内（基于已解析路径比较），返回规范化绝对路径。
 */
export function assertPathInWorkspace(root: string, filePath: string): string {
  const rootReal = path.resolve(root);
  const target = path.resolve(filePath);

  if (rootReal === target) return target;

  const rel = path.relative(rootReal, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`拒绝访问工作区外路径: ${filePath}`);
  }
  return target;
}

export async function readTextFileSafe(
  root: string,
  requestPath: string,
  line?: number | null,
  limit?: number | null,
): Promise<{ content: string }> {
  const full = assertPathInWorkspace(root, requestPath);
  let content = await fs.readFile(full, "utf8");
  if (line != null && line > 0) {
    const lines = content.split(/\r?\n/);
    const start = line - 1;
    const end =
      limit != null && limit > 0 ? start + limit : lines.length;
    content = lines.slice(start, end).join("\n");
  } else if (limit != null && limit > 0) {
    const lines = content.split(/\r?\n/);
    content = lines.slice(0, limit).join("\n");
  }
  return { content };
}

export async function writeTextFileSafe(
  root: string,
  requestPath: string,
  content: string,
): Promise<void> {
  const full = assertPathInWorkspace(root, requestPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
}
