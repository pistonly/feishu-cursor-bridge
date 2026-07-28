import * as fs from "node:fs";
import * as path from "node:path";
import { formatWithOptions } from "node:util";

type ConsoleMethodName = "log" | "info" | "warn" | "error" | "debug";
type ConsoleMethod = (...data: unknown[]) => void;

export interface FileLoggerHandle {
  close(): void;
}

function prefixLines(message: string, prefix: string): string {
  return (
    message
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => `${prefix}${line}`)
      .join("\n") + "\n"
  );
}

/**
 * 安装异步文件日志器：将 console.* 输出镜像写入文件。
 *
 * 使用 WriteStream + 缓冲队列替代 fs.writeSync，避免阻塞事件循环。
 * - 普通级别日志缓冲后定时刷写（每秒）。
 * - ERROR 级别立即刷写，确保崩溃前日志落盘。
 * - close() 同步关闭流并恢复原始 console 方法。
 */
export function installFileLogger(filePath: string): FileLoggerHandle {
  const absPath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const writeStream = fs.createWriteStream(absPath, { flags: "a" });

  const buffer: string[] = [];
  const FLUSH_INTERVAL_MS = 1_000;
  let flushTimer: NodeJS.Timeout | null = setInterval(() => {
    flushBuffer();
  }, FLUSH_INTERVAL_MS);

  if (flushTimer) {
    flushTimer.unref?.();
  }

  // 直接保存引用而非 .bind(console)：Node.js 的 console 方法已是 bound function，
  // 再次 bind 会创建新引用，导致多次 install/close 后引用不一致。
  const original: Record<ConsoleMethodName, ConsoleMethod> = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };

  function flushBuffer(): void {
    if (buffer.length === 0) return;
    const data = buffer.join("");
    buffer.length = 0;
    if (!writeStream.destroyed && writeStream.writable) {
      writeStream.write(data, "utf8", (err) => {
        if (err) {
          original.error("[file-logger] write failed:", err.message);
        }
      });
    }
  }

  const write = (level: string, args: unknown[]): void => {
    const msg = formatWithOptions(
      { colors: false, depth: 8, maxArrayLength: 100, breakLength: 120 },
      ...args,
    );
    const prefix = `${new Date().toISOString()} [${level}] `;
    buffer.push(prefixLines(msg, prefix));

    // ERROR 立即刷写，防止崩溃前丢失关键日志
    if (level === "ERROR") {
      flushBuffer();
    }
  };

  const patch = (name: ConsoleMethodName): void => {
    const level = name.toUpperCase();
    console[name] = ((...args: unknown[]) => {
      original[name](...args);
      try {
        write(level, args);
      } catch (err) {
        original.error(
          "[file-logger] write failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }) as ConsoleMethod;
  };

  patch("log");
  patch("info");
  patch("warn");
  patch("error");
  patch("debug");

  return {
    close(): void {
      // 恢复原始 console 方法
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
      console.debug = original.debug;

      // 停止定时器并同步刷写剩余缓冲
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
      }
      flushBuffer();

      // 同步关闭流
      try {
        writeStream.end();
      } catch {
        // ignore
      }
    },
  };
}
