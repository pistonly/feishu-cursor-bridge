import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * 读取 JSON 文件并解析；若文件不存在（ENOENT）则返回 `defaultValue`。
 * 其他错误向上抛出。
 */
export async function readJsonFileWithDefault<T>(
  filePath: string,
  defaultValue: T,
): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultValue;
    }
    throw e;
  }
}

/**
 * 以原子方式写入 JSON 文件：先写入临时文件，再 rename 覆盖目标文件。
 * 自动创建父目录。使用 PID + 序列号保证临时文件唯一性。
 */
export async function atomicWriteJson(
  filePath: string,
  data: unknown,
  seq: number = 0,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const suffix = seq > 0 ? `.${process.pid}.${seq}` : `.${process.pid}`;
  const tmp = `${filePath}${suffix}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}
