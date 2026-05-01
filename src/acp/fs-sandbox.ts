import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * 确保 filePath 落在 root 目录内（基于真实路径比较，避免 symlink 逃逸），返回规范化绝对路径。
 */
export function assertPathInWorkspace(root: string, filePath: string): string {
  const rootAbs = path.resolve(root);
  const target = path.resolve(filePath);
  const rootReal = fsSync.realpathSync.native(rootAbs);

  let targetReal: string | undefined;
  try {
    targetReal = fsSync.realpathSync.native(target);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      throw e;
    }
  }

  if (targetReal) {
    if (isPathUnderRealRoot(rootReal, targetReal)) return target;
    throw new Error(`拒绝访问工作区外路径: ${filePath}`);
  }

  const parentReal = fsSync.realpathSync.native(findExistingParent(target));
  if (!isPathUnderRealRoot(rootReal, parentReal)) {
    throw new Error(`拒绝访问工作区外路径: ${filePath}`);
  }
  return target;
}

function findExistingParent(target: string): string {
  let current = path.dirname(target);
  for (;;) {
    if (fsSync.existsSync(current)) return current;
    const next = path.dirname(current);
    if (next === current) return current;
    current = next;
  }
}

function isPathUnderRealRoot(rootReal: string, targetReal: string): boolean {
  if (rootReal === targetReal) return true;
  const rel = path.relative(rootReal, targetReal);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
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
  await fs.mkdir(path.resolve(root), { recursive: true });
  const full = assertPathInWorkspace(root, requestPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
}
