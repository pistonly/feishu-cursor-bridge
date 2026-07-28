import assert from "node:assert/strict";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { installFileLogger } from "./file-logger.js";

function createTempLogFile(): string {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "file-logger-"));
  return path.join(dir, "test.log");
}

async function readLogFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

/** 等待 WriteStream 异步写入完成 */
function waitForWrite(ms = 150): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("installFileLogger 会创建日志文件并写入 console.log 内容", async () => {
  const logPath = createTempLogFile();
  try {
    const handle = installFileLogger(logPath);
    console.log("hello world");
    handle.close();
    await waitForWrite();

    const content = await readLogFile(logPath);
    assert.match(content, /hello world/);
    assert.match(content, /\[LOG\]/);
    assert.match(content, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  } finally {
    await fs.rm(path.dirname(logPath), { recursive: true, force: true });
  }
});

test("installFileLogger 会为不同级别添加正确前缀", async () => {
  const logPath = createTempLogFile();
  try {
    const handle = installFileLogger(logPath);
    console.info("info msg");
    console.warn("warn msg");
    console.error("error msg");
    console.debug("debug msg");
    handle.close();
    await waitForWrite();

    const content = await readLogFile(logPath);
    assert.match(content, /\[INFO\].*info msg/);
    assert.match(content, /\[WARN\].*warn msg/);
    assert.match(content, /\[ERROR\].*error msg/);
    assert.match(content, /\[DEBUG\].*debug msg/);
  } finally {
    await fs.rm(path.dirname(logPath), { recursive: true, force: true });
  }
});

test("installFileLogger ERROR 级别会立即刷写", async () => {
  const logPath = createTempLogFile();
  try {
    const handle = installFileLogger(logPath);
    console.log("buffered log"); // 普通级别进入缓冲
    console.error("urgent error"); // ERROR 立即刷写，同时刷出缓冲中的内容
    // 不需要等待定时器
    await waitForWrite(50);

    const content = await readLogFile(logPath);
    assert.match(content, /buffered log/);
    assert.match(content, /urgent error/);
    handle.close();
  } finally {
    await fs.rm(path.dirname(logPath), { recursive: true, force: true });
  }
});

test("installFileLogger close 后恢复原始 console 方法", async () => {
  const logPath = createTempLogFile();
  const originalLog = console.log;
  const originalError = console.error;

  try {
    const handle = installFileLogger(logPath);
    assert.notEqual(console.log, originalLog);
    assert.notEqual(console.error, originalError);

    handle.close();

    assert.equal(console.log, originalLog);
    assert.equal(console.error, originalError);
  } finally {
    // 确保无论如何都恢复
    console.log = originalLog;
    console.error = originalError;
    await fs.rm(path.dirname(logPath), { recursive: true, force: true });
  }
});

test("installFileLogger close 后刷写剩余缓冲", async () => {
  const logPath = createTempLogFile();
  try {
    const handle = installFileLogger(logPath);
    console.log("message before close");
    // 不等待定时器，直接 close
    handle.close();
    await waitForWrite();

    const content = await readLogFile(logPath);
    assert.match(content, /message before close/);
  } finally {
    await fs.rm(path.dirname(logPath), { recursive: true, force: true });
  }
});

test("installFileLogger 多行消息每行都带前缀", async () => {
  const logPath = createTempLogFile();
  try {
    const handle = installFileLogger(logPath);
    console.log("line1\nline2\nline3");
    handle.close();
    await waitForWrite();

    const content = await readLogFile(logPath);
    const lines = content.trim().split("\n");
    assert.ok(lines.length >= 3);
    for (const line of lines) {
      assert.match(line, /\d{4}-\d{2}-\d{2}T.*\[LOG\]/);
    }
  } finally {
    await fs.rm(path.dirname(logPath), { recursive: true, force: true });
  }
});

test("installFileLogger 支持格式化对象参数", async () => {
  const logPath = createTempLogFile();
  try {
    const handle = installFileLogger(logPath);
    console.log("data:", { key: "value", n: 42 });
    handle.close();
    await waitForWrite();

    const content = await readLogFile(logPath);
    assert.match(content, /key: 'value'/);
    assert.match(content, /n: 42/);
  } finally {
    await fs.rm(path.dirname(logPath), { recursive: true, force: true });
  }
});

test("installFileLogger 会自动创建不存在的日志目录", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-logger-"));
  const logPath = path.join(tmpDir, "nested", "deep", "test.log");
  try {
    const handle = installFileLogger(logPath);
    console.log("deep dir test");
    handle.close();
    await waitForWrite();

    const content = await readLogFile(logPath);
    assert.match(content, /deep dir test/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("installFileLogger 以追加模式写入", async () => {
  const logPath = createTempLogFile();
  try {
    // 第一次写入
    const handle1 = installFileLogger(logPath);
    console.log("first message");
    handle1.close();
    await waitForWrite();

    // 第二次写入
    const handle2 = installFileLogger(logPath);
    console.log("second message");
    handle2.close();
    await waitForWrite();

    const content = await readLogFile(logPath);
    assert.match(content, /first message/);
    assert.match(content, /second message/);
  } finally {
    await fs.rm(path.dirname(logPath), { recursive: true, force: true });
  }
});
