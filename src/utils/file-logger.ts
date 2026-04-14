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

export function installFileLogger(filePath: string): FileLoggerHandle {
  const absPath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const fd = fs.openSync(absPath, "a");

  const original: Record<ConsoleMethodName, ConsoleMethod> = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };

  const write = (level: string, args: unknown[]): void => {
    const msg = formatWithOptions(
      { colors: false, depth: 8, maxArrayLength: 100, breakLength: 120 },
      ...args,
    );
    const prefix = `${new Date().toISOString()} [${level}] `;
    fs.writeSync(fd, prefixLines(msg, prefix), undefined, "utf8");
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
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
      console.debug = original.debug;
      fs.closeSync(fd);
    },
  };
}
