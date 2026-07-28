/**
 * 进程工具函数：检测 PID 是否存活。
 *
 * 若 PID 仍存活则返回 true；ESRCH 视为已退出。
 * EPERM 等权限问题保守视为「仍在运行」，避免误删他人进程的锁。
 */
export function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ESRCH") return false;
    return true;
  }
}
