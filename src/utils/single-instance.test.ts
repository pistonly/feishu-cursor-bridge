import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { acquireSingleInstanceLock } from "./single-instance.js";
import { createTestConfig } from "../test-utils/create-test-config.js";

test("acquireSingleInstanceLock 在无锁时成功获取", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "single-inst-"));
  const lockPath = path.join(tmpDir, "test.lock");
  try {
    const config = createTestConfig({ bridge: { singleInstanceLockPath: lockPath } });
    const release = acquireSingleInstanceLock(config);

    assert.ok(fs.existsSync(lockPath));
    const content = fs.readFileSync(lockPath, "utf8").trim();
    assert.equal(parseInt(content, 10), process.pid);

    release();
    assert.ok(!fs.existsSync(lockPath));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("acquireSingleInstanceLock 在 allowMultipleInstances 时跳过", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "single-inst-"));
  const lockPath = path.join(tmpDir, "test.lock");
  try {
    const config = createTestConfig({
      bridge: { singleInstanceLockPath: lockPath, allowMultipleInstances: true },
    });
    const release = acquireSingleInstanceLock(config);
    // 不应创建锁文件
    assert.ok(!fs.existsSync(lockPath));
    release();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("acquireSingleInstanceLock 在已有活跃进程锁时抛错", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "single-inst-"));
  const lockPath = path.join(tmpDir, "test.lock");
  try {
    // 先写入当前 PID 模拟已有进程占用
    fs.writeFileSync(lockPath, `${process.pid}\n`);

    const config = createTestConfig({ bridge: { singleInstanceLockPath: lockPath } });
    assert.throws(
      () => acquireSingleInstanceLock(config),
      /已有飞书桥接进程在运行/,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("acquireSingleInstanceLock 会回收陈旧锁（PID 已退出）", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "single-inst-"));
  const lockPath = path.join(tmpDir, "test.lock");
  try {
    // 写入一个几乎不可能存在的 PID（PID 1 通常是 init，我们用一个超大值）
    // 使用一个已退出进程的 PID：找一个不存在的 PID
    // 在大多数系统上，PID_MAX 附近且非当前 PID 的值很可能不存在
    const fakePid = 999_999;
    fs.writeFileSync(lockPath, `${fakePid}\n`);

    const config = createTestConfig({ bridge: { singleInstanceLockPath: lockPath } });
    // 应回收陈旧锁并成功获取
    const release = acquireSingleInstanceLock(config);

    const content = fs.readFileSync(lockPath, "utf8").trim();
    assert.equal(parseInt(content, 10), process.pid);

    release();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("acquireSingleInstanceLock 会回收无效锁文件（非数字内容）", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "single-inst-"));
  const lockPath = path.join(tmpDir, "test.lock");
  try {
    fs.writeFileSync(lockPath, "not-a-pid\n");

    const config = createTestConfig({ bridge: { singleInstanceLockPath: lockPath } });
    const release = acquireSingleInstanceLock(config);

    const content = fs.readFileSync(lockPath, "utf8").trim();
    assert.equal(parseInt(content, 10), process.pid);

    release();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("acquireSingleInstanceLock 会回收空锁文件", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "single-inst-"));
  const lockPath = path.join(tmpDir, "test.lock");
  try {
    fs.writeFileSync(lockPath, "\n");

    const config = createTestConfig({ bridge: { singleInstanceLockPath: lockPath } });
    const release = acquireSingleInstanceLock(config);

    assert.ok(fs.existsSync(lockPath));
    release();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("acquireSingleInstanceLock 会回收负数 PID 锁", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "single-inst-"));
  const lockPath = path.join(tmpDir, "test.lock");
  try {
    fs.writeFileSync(lockPath, "-1\n");

    const config = createTestConfig({ bridge: { singleInstanceLockPath: lockPath } });
    const release = acquireSingleInstanceLock(config);

    assert.ok(fs.existsSync(lockPath));
    release();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("acquireSingleInstanceLock 会自动创建不存在的锁目录", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "single-inst-"));
  const lockPath = path.join(tmpDir, "nested", "deep", "test.lock");
  try {
    const config = createTestConfig({ bridge: { singleInstanceLockPath: lockPath } });
    const release = acquireSingleInstanceLock(config);

    assert.ok(fs.existsSync(lockPath));
    release();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("acquireSingleInstanceLock release 后再次 acquire 可成功", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "single-inst-"));
  const lockPath = path.join(tmpDir, "test.lock");
  try {
    const config = createTestConfig({ bridge: { singleInstanceLockPath: lockPath } });

    const release1 = acquireSingleInstanceLock(config);
    release1();

    const release2 = acquireSingleInstanceLock(config);
    assert.ok(fs.existsSync(lockPath));
    release2();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
