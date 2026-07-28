import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  isPathUnderAllowedRoots,
  resolveAllowedWorkspaceDir,
} from "./workspace-policy.js";
import type { Config } from "../config/index.js";

function createTestConfig(roots: string[]): Config {
  return {
    feishu: { appId: "app", appSecret: "secret", domain: "feishu" },
    acp: {
      backend: "cursor-official",
      enabledBackends: ["cursor-official"],
      nodePath: process.execPath,
      adapterEntry: "",
      extraArgs: [],
      officialAgentPath: "agent",
      claudeSpawnCommand: "npx",
      claudeSpawnArgs: [],
      codexSpawnCommand: "npx",
      codexSpawnArgs: [],
      workspaceRoot: roots[0] ?? "/tmp",
      allowedWorkspaceRoots: roots,
      adapterSessionDir: "/tmp/sessions",
    },
    bridge: {
      adminUserIds: [],
      groupSessionScope: "per-user",
      maxSessionsPerUser: 10,
      sessionIdleTimeoutMs: 60_000,
      sessionStorePath: "/tmp/s.json",
      cardUpdateThrottleMs: 0,
      cardSplitMarkdownThreshold: 3500,
      cardSplitToolThreshold: 8,
      workspacePresetsPath: "/tmp/p.json",
      workspacePresetsSeed: [],
      maintenanceStatePath: "/tmp/m.json",
      singleInstanceLockPath: "/tmp/bridge.lock",
      allowMultipleInstances: false,
      managedByService: false,
      experimentalLogToFile: false,
      experimentalLogFilePath: "/tmp/bridge.log",
      slotMessageLogEnabled: false,
      sessionHistoryEnabled: false,
      showAcpAvailableCommands: false,
      enableBangCommand: false,
      enableUpgradeCommand: false,
      upgradeAdmins: {
        openIds: new Set(),
        userIds: new Set(),
        unionIds: new Set(),
      },
      serviceScriptPath: "/tmp/service.sh",
      upgradeResultPath: "/tmp/u.json",
    },
    autoApprovePermissions: false,
    bridgeDebug: false,
    acpReloadTraceLog: false,
    logLevel: "info",
  };
}

// ─── isPathUnderAllowedRoots ───

test("isPathUnderAllowedRoots 路径等于 root 时返回 true", () => {
  assert.equal(isPathUnderAllowedRoots(["/home/user/project"], "/home/user/project"), true);
});

test("isPathUnderAllowedRoots 路径在 root 下时返回 true", () => {
  assert.equal(
    isPathUnderAllowedRoots(["/home/user/project"], "/home/user/project/subdir"),
    true,
  );
});

test("isPathUnderAllowedRoots 路径在 root 外时返回 false", () => {
  assert.equal(
    isPathUnderAllowedRoots(["/home/user/project"], "/home/user/other"),
    false,
  );
});

test("isPathUnderAllowedRoots 路径完全不同时返回 false", () => {
  assert.equal(
    isPathUnderAllowedRoots(["/home/user/project"], "/etc/passwd"),
    false,
  );
});

test("isPathUnderAllowedRoots 防止路径遍历攻击", () => {
  assert.equal(
    isPathUnderAllowedRoots(["/home/user/project"], "/home/user/project/../../../etc"),
    false,
  );
});

test("isPathUnderAllowedRoots 前缀匹配不误判", () => {
  // /home/user/project-evil 不应在 /home/user/project 下
  assert.equal(
    isPathUnderAllowedRoots(["/home/user/project"], "/home/user/project-evil"),
    false,
  );
});

test("isPathUnderAllowedRoots 多个 root 时任一匹配即 true", () => {
  assert.equal(
    isPathUnderAllowedRoots(
      ["/home/user/a", "/home/user/b"],
      "/home/user/b/subdir",
    ),
    true,
  );
});

test("isPathUnderAllowedRoots 多个 root 都不匹配时 false", () => {
  assert.equal(
    isPathUnderAllowedRoots(
      ["/home/user/a", "/home/user/b"],
      "/home/user/c/subdir",
    ),
    false,
  );
});

test("isPathUnderAllowedRoots 空 roots 列表时总是 false", () => {
  assert.equal(isPathUnderAllowedRoots([], "/home/user"), false);
});

test("isPathUnderAllowedRoots 嵌套子目录深层匹配", () => {
  assert.equal(
    isPathUnderAllowedRoots(
      ["/home/user/project"],
      "/home/user/project/a/b/c/d/e",
    ),
    true,
  );
});

// ─── resolveAllowedWorkspaceDir ───

test("resolveAllowedWorkspaceDir 在允许范围内的目录成功", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ws-policy-"));
  const subDir = path.join(tmpRoot, "subdir");
  await fs.mkdir(subDir);
  try {
    const config = createTestConfig([tmpRoot]);
    const result = await resolveAllowedWorkspaceDir(subDir, config);
    assert.equal(result, path.resolve(subDir));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("resolveAllowedWorkspaceDir 允许 root 本身", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ws-policy-"));
  try {
    const config = createTestConfig([tmpRoot]);
    const result = await resolveAllowedWorkspaceDir(tmpRoot, config);
    assert.equal(result, path.resolve(tmpRoot));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("resolveAllowedWorkspaceDir 拒绝不存在路径", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ws-policy-"));
  try {
    const config = createTestConfig([tmpRoot]);
    await assert.rejects(
      resolveAllowedWorkspaceDir(path.join(tmpRoot, "nonexistent"), config),
      /路径无效或不可访问/,
    );
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("resolveAllowedWorkspaceDir 拒绝文件而非目录", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ws-policy-"));
  const filePath = path.join(tmpRoot, "file.txt");
  await fs.writeFile(filePath, "hello");
  try {
    const config = createTestConfig([tmpRoot]);
    await assert.rejects(
      resolveAllowedWorkspaceDir(filePath, config),
      /不是目录/,
    );
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("resolveAllowedWorkspaceDir 拒绝允许范围外的路径", async () => {
  const tmpRootA = await fs.mkdtemp(path.join(os.tmpdir(), "ws-policy-a-"));
  const tmpRootB = await fs.mkdtemp(path.join(os.tmpdir(), "ws-policy-b-"));
  try {
    const config = createTestConfig([tmpRootA]);
    await assert.rejects(
      resolveAllowedWorkspaceDir(tmpRootB, config),
      /工作区不在允许范围内/,
    );
  } finally {
    await fs.rm(tmpRootA, { recursive: true, force: true });
    await fs.rm(tmpRootB, { recursive: true, force: true });
  }
});

test("resolveAllowedWorkspaceDir 支持 ~ 路径展开", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ws-policy-"));
  const subDir = path.join(tmpRoot, "subdir");
  await fs.mkdir(subDir);
  try {
    const config = createTestConfig([tmpRoot]);
    // 使用绝对路径（~ 展开由 expandHome 处理）
    const result = await resolveAllowedWorkspaceDir(subDir, config);
    assert.equal(result, path.resolve(subDir));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("resolveAllowedWorkspaceDir 会 trim 路径首尾空白", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ws-policy-"));
  try {
    const config = createTestConfig([tmpRoot]);
    const result = await resolveAllowedWorkspaceDir(`  ${tmpRoot}  `, config);
    assert.equal(result, path.resolve(tmpRoot));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("resolveAllowedWorkspaceDir 防止路径遍历逃逸", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ws-policy-"));
  const siblingDir = path.join(path.dirname(tmpRoot), "ws-sibling");
  await fs.mkdir(siblingDir, { recursive: true });
  try {
    const config = createTestConfig([tmpRoot]);
    const escapePath = path.join(tmpRoot, "..", path.basename(siblingDir));
    await assert.rejects(
      resolveAllowedWorkspaceDir(escapePath, config),
      /工作区不在允许范围内/,
    );
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.rm(siblingDir, { recursive: true, force: true });
  }
});
