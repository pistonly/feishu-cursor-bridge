/**
 * 从 unknown 错误中安全提取消息字符串。
 *
 * 统一替换各处 `error instanceof Error ? error.message : String(error)` 模式。
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
