import * as fs from "node:fs";
import * as path from "node:path";
import type { Config } from "./config.js";

/**
 * 若 PID 仍存活则返回 true；ESRCH 视为已退出。
 * EPERM 等权限问题保守视为「仍在运行」，避免误删他人进程的锁。
 */
function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ESRCH") return false;
    return true;
  }
}

function readLockPid(lockPath: string): number | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf8").trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * 在本机只运行一个桥接进程：独占创建锁文件；若已存在则检查 PID，陈旧则回收后重试。
 * @returns 退出时调用以删除锁文件
 */
export function acquireSingleInstanceLock(config: Config): () => void {
  if (config.bridge.allowMultipleInstances) {
    return () => {};
  }

  const lockPath = config.bridge.singleInstanceLockPath;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(fd, `${process.pid}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // ignore
        }
      };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw new Error(
          `无法创建单实例锁文件 ${lockPath}: ${err.message}`,
        );
      }

      const pid = readLockPid(lockPath);
      const stale = pid === null || !isPidRunning(pid);
      if (stale) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // 并发下可能被对方删掉，下一轮 openSync 再试
        }
        continue;
      }

      throw new Error(
        `本机已有飞书桥接进程在运行（锁: ${lockPath}，占用 PID ${pid}）。请先结束该进程后再启动，或设置 BRIDGE_ALLOW_MULTIPLE_INSTANCES=true 跳过检查（不推荐）。`,
      );
    }
  }

  throw new Error(
    `单实例锁多次重试仍失败（可能与其他进程并发启动）: ${lockPath}`,
  );
}
