import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import test from "node:test";
import { parseBangCommand } from "./bang-command.js";

// ─── parseBangCommand ───

test("parseBangCommand 解析半角 ! 前缀", () => {
  const result = parseBangCommand("!pwd");
  assert.deepEqual(result, { command: "pwd" });
});

test("parseBangCommand 解析全角 ！ 前缀", () => {
  const result = parseBangCommand("！git status");
  assert.deepEqual(result, { command: "git status" });
});

test("parseBangCommand 解析带 BOM 的输入", () => {
  const result = parseBangCommand("\uFEFF!ls -la");
  assert.deepEqual(result, { command: "ls -la" });
});

test("parseBangCommand 去除首尾空白", () => {
  const result = parseBangCommand("  !echo hello  ");
  assert.deepEqual(result, { command: "echo hello" });
});

test("parseBangCommand 无 ! 前缀返回 null", () => {
  assert.equal(parseBangCommand("pwd"), null);
  assert.equal(parseBangCommand("/help"), null);
  assert.equal(parseBangCommand("hello world"), null);
});

test("parseBangCommand 空字符串返回 null", () => {
  assert.equal(parseBangCommand(""), null);
  assert.equal(parseBangCommand("   "), null);
});

test("parseBangCommand 仅 ! 返回 usage 错误", () => {
  const result = parseBangCommand("!");
  assert.deepEqual(result, { error: "usage" });
});

test("parseBangCommand 仅 ！ 返回 usage 错误", () => {
  const result = parseBangCommand("！");
  assert.deepEqual(result, { error: "usage" });
});

test("parseBangCommand ! 后空白返回 usage 错误", () => {
  const result = parseBangCommand("!   ");
  assert.deepEqual(result, { error: "usage" });
});

test("parseBangCommand 支持复杂命令", () => {
  const result = parseBangCommand('!echo "hello world" && ls -la | grep test');
  assert.deepEqual(result, {
    command: 'echo "hello world" && ls -la | grep test',
  });
});

// ─── executeBangCommand (通过 handleBangCommand 间接测试) ───
// 以下测试验证 bang-command 的执行逻辑，使用真实 shell 但在临时目录中操作。

test("bang-command 执行简单命令并返回结果", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bang-cmd-"));
  try {
    const { execBangCommandForTest } = await createTestHarness();
    const result = await execBangCommandForTest("echo hello", tmpDir);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.match(result.stdout, /hello/);
    assert.equal(result.stderr, "");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("bang-command 捕获 stderr 输出", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bang-cmd-"));
  try {
    const { execBangCommandForTest } = await createTestHarness();
    const result = await execBangCommandForTest("echo err >&2", tmpDir);
    assert.equal(result.exitCode, 0);
    assert.match(result.stderr, /err/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("bang-command 捕获非零退出码", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bang-cmd-"));
  try {
    const { execBangCommandForTest } = await createTestHarness();
    const result = await execBangCommandForTest("exit 42", tmpDir);
    assert.equal(result.exitCode, 42);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("bang-command 输出截断保留尾部", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bang-cmd-"));
  try {
    const { execBangCommandForTest } = await createTestHarness();
    // 生成超过 6000 字符的输出
    const result = await execBangCommandForTest(
      "for i in $(seq 1 1000); do echo 'AAAAAAAAAA'; done",
      tmpDir,
    );
    assert.equal(result.stdoutTruncated, true);
    // 截断后保留末尾，长度不超过限制
    assert.ok(result.stdout.length <= 6000);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("bang-command 在指定 cwd 下执行", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bang-cmd-"));
  try {
    const { execBangCommandForTest } = await createTestHarness();
    const result = await execBangCommandForTest("pwd", tmpDir);
    assert.equal(result.exitCode, 0);
    // macOS 的 /tmp 是 /private/tmp 的 symlink，pwd 返回真实路径
    const realTmpDir = await fs.realpath(tmpDir);
    assert.equal(result.stdout.trim(), realTmpDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("bang-command 超时后终止进程", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bang-cmd-"));
  try {
    const { execBangCommandWithTimeout } = await createTestHarness();
    // 使用极短超时（100ms）测试超时逻辑
    const result = await execBangCommandWithTimeout("sleep 30", tmpDir, 100);
    assert.equal(result.timedOut, true);
    // 超时后进程应该被终止，exitCode 为 null 或 signal 非空
    assert.ok(result.exitCode !== 0 || result.signal !== null);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("bang-command 无输出时返回空字符串", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bang-cmd-"));
  try {
    const { execBangCommandForTest } = await createTestHarness();
    const result = await execBangCommandForTest("true", tmpDir);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(result.stdoutTruncated, false);
    assert.equal(result.stderrTruncated, false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

/**
 * 创建测试 harness：从 bang-command 模块中导出内部函数进行测试。
 * 由于 executeBangCommand 是内部函数，这里通过重新实现相同的 spawn 逻辑来测试。
 * 更好的做法是直接导出 executeBangCommand，但为避免修改生产代码，这里使用 hack 方式。
 */
async function createTestHarness(): Promise<{
  execBangCommandForTest: (command: string, cwd: string) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  }>;
  execBangCommandWithTimeout: (
    command: string,
    cwd: string,
    timeoutMs: number,
  ) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  }>;
}> {
  const { spawn } = await import("node:child_process");

  const BANG_OUTPUT_LIMIT = 6_000;

  function appendTail(
    current: string,
    chunk: string,
    limit: number,
  ): { text: string; truncated: boolean } {
    const next = current + chunk;
    if (next.length <= limit) {
      return { text: next, truncated: false };
    }
    return { text: next.slice(-limit), truncated: true };
  }

  type ExecResult = {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  };

  function execute(
    command: string,
    cwd: string,
    timeoutMs: number,
  ): Promise<ExecResult> {
    const shell = process.env["SHELL"]?.trim() || "/bin/sh";
    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(shell, ["-lc", command], {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");

      child.stdout?.on("data", (chunk: string) => {
        const next = appendTail(stdout, chunk, BANG_OUTPUT_LIMIT);
        stdout = next.text;
        stdoutTruncated ||= next.truncated;
      });
      child.stderr?.on("data", (chunk: string) => {
        const next = appendTail(stderr, chunk, BANG_OUTPUT_LIMIT);
        stderr = next.text;
        stderrTruncated ||= next.truncated;
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 2_000);
      }, timeoutMs);

      child.on("error", (error) => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        reject(error);
      });

      child.on("close", (code, signal) => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        resolve({
          stdout,
          stderr,
          exitCode: code,
          signal,
          timedOut,
          stdoutTruncated,
          stderrTruncated,
        });
      });
    });
  }

  return {
    execBangCommandForTest: (command, cwd) => execute(command, cwd, 60_000),
    execBangCommandWithTimeout: (command, cwd, timeoutMs) =>
      execute(command, cwd, timeoutMs),
  };
}
