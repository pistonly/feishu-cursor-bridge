import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AcpRuntimeResolver, BridgeAcpRuntime } from "./acp/runtime-contract.js";
import { SessionManager } from "./session/manager.js";
import { SessionStore, type PersistedSessionGroup } from "./session/store.js";

const USER_ID = "user-1";
const CHAT_ID = "chat-1";
const SESSION_KEY = `dm:${USER_ID}`;
const WORKSPACE_ROOT = "/tmp/bridge-session-test";

type FakeAcpRuntime = Pick<
  BridgeAcpRuntime,
  | "supportsLoadSession"
  | "shouldProbeSessionAvailability"
  | "supportsSetSessionMode"
  | "supportsSetSessionModel"
  | "newSession"
  | "loadSession"
  | "cancelSession"
  | "closeSession"
>;

function createPersistedGroup(cursorCliChatId = "cli-old"): PersistedSessionGroup {
  return {
    chatId: CHAT_ID,
    userId: USER_ID,
    chatType: "p2p",
    activeSlotIndex: 1,
    nextSlotIndex: 2,
    slots: [
      {
        slotIndex: 1,
        backend: "cursor-official",
        sessionId: "acp-old",
        cursorCliChatId,
        workspaceRoot: WORKSPACE_ROOT,
        lastActiveAt: Date.now(),
      },
    ],
  };
}

function createPersistedCodexGroup(
  preferredModelId = "gpt-5.3-codex/low",
): PersistedSessionGroup {
  return {
    chatId: CHAT_ID,
    userId: USER_ID,
    chatType: "p2p",
    activeSlotIndex: 1,
    nextSlotIndex: 2,
    slots: [
      {
        slotIndex: 1,
        backend: "codex",
        sessionId: "codex-old",
        preferredModelId,
        workspaceRoot: WORKSPACE_ROOT,
        lastActiveAt: Date.now(),
      },
    ],
  };
}

async function createStoreFile(group: PersistedSessionGroup): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-session-manager-"));
  const filePath = path.join(dir, "sessions.json");
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        version: 3,
        sessions: {
          [SESSION_KEY]: group,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return filePath;
}

async function createEmptyStoreFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-session-manager-"));
  const filePath = path.join(dir, "sessions.json");
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        version: 3,
        sessions: {},
      },
      null,
      2,
    ),
    "utf8",
  );
  return filePath;
}

function trackPendingFlushes(store: SessionStore): () => Promise<void> {
  const originalFlush = store.flush.bind(store);
  const pending: Array<Promise<void>> = [];
  store.flush = async () => {
    const task = originalFlush();
    pending.push(task);
    return task;
  };
  return async () => {
    await Promise.allSettled(pending);
  };
}

test("loadSession 失败后会优先复用已持久化的 CLI resume ID", async () => {
  const storeFile = await createStoreFile(createPersistedGroup("cli-old"));

  const newSessionCalls: Array<{ cwd: string; cursorCliChatId?: string }> = [];
  const acp: FakeAcpRuntime = {
    supportsLoadSession: true,
    supportsSetSessionMode: false,
    supportsSetSessionModel: false,
    async newSession(
      cwd?: string,
      options?: { recovery?: { kind: "cursor-cli"; cursorCliChatId: string } },
    ): Promise<{ sessionId: string; recovery?: { kind: "cursor-cli"; cursorCliChatId: string } }> {
      const resolvedCwd = path.resolve(cwd ?? WORKSPACE_ROOT);
      newSessionCalls.push({
        cwd: resolvedCwd,
        cursorCliChatId: options?.recovery?.cursorCliChatId,
      });
      return options?.recovery?.cursorCliChatId
        ? {
            sessionId: "acp-restored",
            recovery: { kind: "cursor-cli", cursorCliChatId: options.recovery.cursorCliChatId },
          }
        : { sessionId: "acp-restored" };
    },
    async loadSession(): Promise<void> {
      throw new Error("Session not found: acp-old");
    },
    async cancelSession(): Promise<void> {},
    async closeSession(): Promise<void> {},
  };

  const store = new SessionStore(storeFile);
  const waitForFlushes = trackPendingFlushes(store);
  const manager = new SessionManager(
    acp as BridgeAcpRuntime,
    store,
    60_000,
    { defaultWorkspaceRoot: WORKSPACE_ROOT, defaultBackend: "cursor-official" },
  );

  await manager.init();
  const session = await manager.getActiveSession(CHAT_ID, USER_ID, "p2p");
  assert.ok(session);

  assert.equal(session.sessionId, "acp-restored");
  assert.deepEqual(session.recovery, { kind: "cursor-cli", cursorCliChatId: "cli-old" });
  assert.deepEqual(newSessionCalls, [
    { cwd: WORKSPACE_ROOT, cursorCliChatId: "cli-old" },
  ]);
  assert.deepEqual(manager.consumePendingNotices(CHAT_ID, USER_ID, "p2p"), []);
  await waitForFlushes();
});

test("无法保留旧 CLI resume ID 时会生成绑定变更提醒", async () => {
  const storeFile = await createStoreFile(createPersistedGroup("cli-old"));

  const acp: FakeAcpRuntime = {
    supportsLoadSession: true,
    supportsSetSessionMode: false,
    supportsSetSessionModel: false,
    async newSession(): Promise<{ sessionId: string; recovery?: { kind: "cursor-cli"; cursorCliChatId: string } }> {
      return {
        sessionId: "acp-rebound",
        recovery: { kind: "cursor-cli", cursorCliChatId: "cli-new" },
      };
    },
    async loadSession(): Promise<void> {
      throw new Error("Session not found: acp-old");
    },
    async cancelSession(): Promise<void> {},
    async closeSession(): Promise<void> {},
  };

  const store = new SessionStore(storeFile);
  const waitForFlushes = trackPendingFlushes(store);
  const manager = new SessionManager(
    acp as BridgeAcpRuntime,
    store,
    60_000,
    { defaultWorkspaceRoot: WORKSPACE_ROOT, defaultBackend: "cursor-official" },
  );

  await manager.init();
  const session = await manager.getActiveSession(CHAT_ID, USER_ID, "p2p");
  assert.ok(session);
  const notices = manager.consumePendingNotices(CHAT_ID, USER_ID, "p2p");

  assert.equal(session.sessionId, "acp-rebound");
  assert.deepEqual(session.recovery, { kind: "cursor-cli", cursorCliChatId: "cli-new" });
  assert.equal(notices.length, 1);
  assert.match(notices[0] ?? "", /旧 CLI resume ID：`cli-old`/);
  assert.match(notices[0] ?? "", /新 CLI resume ID：`cli-new`/);
  await waitForFlushes();
});

test("活跃 slot 的 ACP session 被上游清理后会自动重建并保留 CLI resume ID", async () => {
  const storeFile = await createEmptyStoreFile();

  const newSessionCalls: Array<{ cwd: string; cursorCliChatId?: string }> = [];
  const loadSessionCalls: string[] = [];
  let createCount = 0;
  const acp: FakeAcpRuntime = {
    supportsLoadSession: true,
    supportsSetSessionMode: false,
    supportsSetSessionModel: false,
    async newSession(
      cwd?: string,
      options?: { recovery?: { kind: "cursor-cli"; cursorCliChatId: string } },
    ): Promise<{ sessionId: string; recovery?: { kind: "cursor-cli"; cursorCliChatId: string } }> {
      const resolvedCwd = path.resolve(cwd ?? WORKSPACE_ROOT);
      newSessionCalls.push({
        cwd: resolvedCwd,
        cursorCliChatId: options?.recovery?.cursorCliChatId,
      });
      createCount++;
      return createCount === 1
        ? {
            sessionId: "acp-live",
            recovery: { kind: "cursor-cli", cursorCliChatId: "cli-old" },
          }
        : options?.recovery?.cursorCliChatId
          ? {
              sessionId: "acp-rebound",
              recovery: { kind: "cursor-cli", cursorCliChatId: options.recovery.cursorCliChatId },
            }
          : { sessionId: "acp-rebound" };
    },
    async loadSession(sessionId: string): Promise<void> {
      loadSessionCalls.push(sessionId);
      // 第一次 getActiveSession 会 probe load；第二次模拟上游已丢弃 session
      if (loadSessionCalls.length >= 2) {
        throw new Error(`Session not found: ${sessionId}`);
      }
    },
    async cancelSession(): Promise<void> {},
    async closeSession(): Promise<void> {},
  };

  const store = new SessionStore(storeFile);
  const waitForFlushes = trackPendingFlushes(store);
  const manager = new SessionManager(
    acp as BridgeAcpRuntime,
    store,
    7 * 24 * 60 * 60_000,
    { defaultWorkspaceRoot: WORKSPACE_ROOT, defaultBackend: "cursor-official" },
  );

  await manager.init();
  await manager.createNewSlot(CHAT_ID, USER_ID, "p2p", WORKSPACE_ROOT, "cursor-official");
  const first = await manager.getActiveSession(CHAT_ID, USER_ID, "p2p");
  assert.ok(first);
  const second = await manager.getActiveSession(CHAT_ID, USER_ID, "p2p");
  assert.ok(second);

  assert.equal(first.sessionId, "acp-live");
  assert.deepEqual(first.recovery, { kind: "cursor-cli", cursorCliChatId: "cli-old" });
  assert.equal(second.sessionId, "acp-rebound");
  assert.deepEqual(second.recovery, { kind: "cursor-cli", cursorCliChatId: "cli-old" });
  assert.deepEqual(loadSessionCalls, ["acp-live", "acp-live"]);
  assert.deepEqual(newSessionCalls, [
    { cwd: WORKSPACE_ROOT, cursorCliChatId: undefined },
    { cwd: WORKSPACE_ROOT, cursorCliChatId: "cli-old" },
  ]);
  assert.deepEqual(manager.consumePendingNotices(CHAT_ID, USER_ID, "p2p"), []);
  await waitForFlushes();
});


test("getActiveSession 支持显式跳过 availability probe 以避免额外 loadSession", async () => {
  const storeFile = await createEmptyStoreFile();

  const loadSessionCalls: string[] = [];
  const acp: FakeAcpRuntime = {
    supportsLoadSession: true,
    supportsSetSessionMode: false,
    supportsSetSessionModel: false,
    async newSession(): Promise<{ sessionId: string }> {
      return { sessionId: "acp-live" };
    },
    async loadSession(sessionId: string): Promise<void> {
      loadSessionCalls.push(sessionId);
    },
    async cancelSession(): Promise<void> {},
    async closeSession(): Promise<void> {},
  };

  const store = new SessionStore(storeFile);
  const waitForFlushes = trackPendingFlushes(store);
  const manager = new SessionManager(
    acp as BridgeAcpRuntime,
    store,
    60_000,
    { defaultWorkspaceRoot: WORKSPACE_ROOT, defaultBackend: "cursor-official" },
  );

  await manager.init();
  await manager.createNewSlot(CHAT_ID, USER_ID, "p2p", WORKSPACE_ROOT, "cursor-official");

  const session = await manager.getActiveSession(CHAT_ID, USER_ID, "p2p", undefined, {
    skipAvailabilityProbe: true,
  });

  assert.ok(session);
  assert.equal(session.sessionId, "acp-live");
  assert.deepEqual(loadSessionCalls, []);
  await waitForFlushes();
});

test("runtime 关闭主动探活时不会因 loadSession 探针误判而重建活跃 session", async () => {
  const storeFile = await createEmptyStoreFile();

  const loadSessionCalls: string[] = [];
  const newSessionCalls: string[] = [];
  const acp: FakeAcpRuntime = {
    supportsLoadSession: true,
    shouldProbeSessionAvailability: false,
    supportsSetSessionMode: false,
    supportsSetSessionModel: false,
    async newSession(cwd?: string): Promise<{ sessionId: string }> {
      newSessionCalls.push(path.resolve(cwd ?? WORKSPACE_ROOT));
      return { sessionId: "codex-live" };
    },
    async loadSession(sessionId: string): Promise<void> {
      loadSessionCalls.push(sessionId);
      throw new Error(`Resource not found: ${sessionId}`);
    },
    async cancelSession(): Promise<void> {},
    async closeSession(): Promise<void> {},
  };

  const store = new SessionStore(storeFile);
  const waitForFlushes = trackPendingFlushes(store);
  const manager = new SessionManager(
    acp as BridgeAcpRuntime,
    store,
    7 * 24 * 60 * 60_000,
    { defaultWorkspaceRoot: WORKSPACE_ROOT, defaultBackend: "codex" },
  );

  await manager.init();
  await manager.createNewSlot(CHAT_ID, USER_ID, "p2p", WORKSPACE_ROOT, "codex");

  const first = await manager.getActiveSession(CHAT_ID, USER_ID, "p2p");
  const second = await manager.getActiveSession(CHAT_ID, USER_ID, "p2p");

  assert.ok(first);
  assert.ok(second);
  assert.equal(first.sessionId, "codex-live");
  assert.equal(second.sessionId, "codex-live");
  assert.deepEqual(loadSessionCalls, []);
  assert.deepEqual(newSessionCalls, [WORKSPACE_ROOT]);
  await waitForFlushes();
});

test("getSlot 可读取当前活跃 slot 或按名称读取指定 slot", async () => {
  const storeFile = await createEmptyStoreFile();

  let createCount = 0;
  const acp: FakeAcpRuntime = {
    supportsLoadSession: false,
    supportsSetSessionMode: false,
    supportsSetSessionModel: false,
    async newSession(
      cwd?: string,
    ): Promise<{ sessionId: string; recovery?: { kind: "cursor-cli"; cursorCliChatId: string } }> {
      createCount++;
      return {
        sessionId: `acp-${createCount}`,
        recovery: { kind: "cursor-cli", cursorCliChatId: `cli-${createCount}` },
      };
    },
    async loadSession(): Promise<void> {},
    async cancelSession(): Promise<void> {},
    async closeSession(): Promise<void> {},
  };

  const store = new SessionStore(storeFile);
  const waitForFlushes = trackPendingFlushes(store);
  const manager = new SessionManager(
    acp as BridgeAcpRuntime,
    store,
    60_000,
    { defaultWorkspaceRoot: WORKSPACE_ROOT, defaultBackend: "cursor-official" },
  );

  await manager.init();
  await manager.createNewSlot(CHAT_ID, USER_ID, "p2p", WORKSPACE_ROOT, "cursor-official");
  const first = await manager.getActiveSession(CHAT_ID, USER_ID, "p2p");
  assert.ok(first);
  manager.setSlotLastTurn(
    CHAT_ID,
    USER_ID,
    "p2p",
    1,
    "first prompt",
    "first reply",
  );
  await manager.createNewSlot(
    CHAT_ID,
    USER_ID,
    "p2p",
    WORKSPACE_ROOT,
    "cursor-official",
    "backend",
  );

  const active = await manager.getSlot(CHAT_ID, USER_ID, "p2p", null);
  const named = await manager.getSlot(CHAT_ID, USER_ID, "p2p", "backend");

  assert.equal(active.slotIndex, 2);
  assert.equal(active.name, "backend");
  assert.equal(named.slotIndex, 2);
  assert.equal(named.session.sessionId, active.session.sessionId);
  assert.equal(named.lastReply, undefined);

  const firstSlot = await manager.getSlot(CHAT_ID, USER_ID, "p2p", 1);
  assert.equal(firstSlot.lastPrompt, "first prompt");
  assert.equal(firstSlot.lastReply, "first reply");
  await waitForFlushes();
});

test("getSessionSnapshotLoaded 会在内存为空时从 store 恢复当前快照", async () => {
  const storeFile = await createStoreFile(createPersistedGroup("cli-old"));

  const loadSessionCalls: string[] = [];
  const acp: FakeAcpRuntime = {
    supportsLoadSession: true,
    supportsSetSessionMode: false,
    supportsSetSessionModel: false,
    async newSession(): Promise<{ sessionId: string }> {
      throw new Error("should not create new session");
    },
    async loadSession(sessionId: string): Promise<void> {
      loadSessionCalls.push(sessionId);
    },
    async cancelSession(): Promise<void> {},
    async closeSession(): Promise<void> {},
  };

  const store = new SessionStore(storeFile);
  const waitForFlushes = trackPendingFlushes(store);
  const manager = new SessionManager(
    acp as BridgeAcpRuntime,
    store,
    60_000,
    { defaultWorkspaceRoot: WORKSPACE_ROOT, defaultBackend: "cursor-official" },
  );

  await manager.init();
  const snapshot = await manager.getSessionSnapshotLoaded(
    CHAT_ID,
    USER_ID,
    "p2p",
  );

  assert.ok(snapshot);
  assert.equal(snapshot.activeSlot.session.sessionId, "acp-old");
  assert.equal(snapshot.activeSlot.session.workspaceRoot, WORKSPACE_ROOT);
  assert.deepEqual(loadSessionCalls, ["acp-old"]);
  assert.deepEqual(manager.getStats(), { active: 1, total: 1 });
  await waitForFlushes();
});

test("setActiveSessionPreferredModel 会把 codex 模型选择持久化到 store", async () => {
  const storeFile = await createEmptyStoreFile();

  const acp: FakeAcpRuntime = {
    supportsLoadSession: false,
    supportsSetSessionMode: false,
    supportsSetSessionModel: true,
    async newSession(): Promise<{ sessionId: string }> {
      return { sessionId: "codex-live" };
    },
    async loadSession(): Promise<void> {},
    async cancelSession(): Promise<void> {},
    async closeSession(): Promise<void> {},
  };

  const store = new SessionStore(storeFile);
  const waitForFlushes = trackPendingFlushes(store);
  const manager = new SessionManager(
    acp as BridgeAcpRuntime,
    store,
    60_000,
    { defaultWorkspaceRoot: WORKSPACE_ROOT, defaultBackend: "codex" },
  );

  await manager.init();
  await manager.createNewSlot(CHAT_ID, USER_ID, "p2p", WORKSPACE_ROOT, "codex");
  manager.setActiveSessionPreferredModel(
    CHAT_ID,
    USER_ID,
    "p2p",
    "gpt-5.3-codex/low",
  );
  await waitForFlushes();

  const persisted = JSON.parse(await fs.readFile(storeFile, "utf8")) as {
    sessions: Record<string, PersistedSessionGroup>;
  };
  assert.equal(
    persisted.sessions[SESSION_KEY]?.slots[0]?.preferredModelId,
    "gpt-5.3-codex/low",
  );
});



test("setActiveSessionResumeLabel 会把最后一个问题写入当前 project 的 resume history", async () => {
  const storeFile = await createEmptyStoreFile();

  const acp: FakeAcpRuntime = {
    supportsLoadSession: false,
    supportsSetSessionMode: false,
    supportsSetSessionModel: false,
    async newSession(): Promise<{ sessionId: string }> {
      return { sessionId: "acp-live" };
    },
    async loadSession(): Promise<void> {},
    async cancelSession(): Promise<void> {},
    async closeSession(): Promise<void> {},
  };

  const store = new SessionStore(storeFile);
  const waitForFlushes = trackPendingFlushes(store);
  const manager = new SessionManager(
    acp as BridgeAcpRuntime,
    store,
    60_000,
    { defaultWorkspaceRoot: WORKSPACE_ROOT, defaultBackend: "cursor-official" },
  );

  await manager.init();
  await manager.createNewSlot(CHAT_ID, USER_ID, "p2p", WORKSPACE_ROOT, "cursor-official");
  manager.setActiveSessionResumeLabel(
    CHAT_ID,
    USER_ID,
    "p2p",
    "   这是   最后一个问题，带有\n换行和   多余空白   ",
  );
  await waitForFlushes();

  const persisted = JSON.parse(await fs.readFile(storeFile, "utf8")) as {
    version: number;
    resumeHistory: Record<string, Array<{ sessionId: string; label?: string }>>;
  };
  assert.equal(persisted.version, 4);
  assert.equal(
    persisted.resumeHistory[WORKSPACE_ROOT]?.[0]?.sessionId,
    "acp-live",
  );
  assert.equal(
    persisted.resumeHistory[WORKSPACE_ROOT]?.[0]?.label,
    "这是 最后一个问题，带有 换行和 多余空白",
  );
});

test("rebindActiveSlotToResumeHistory 会切换 backend/session 并清空上一轮缓存", async () => {
  const storeFile = await createEmptyStoreFile();

  const acp: FakeAcpRuntime = {
    supportsLoadSession: false,
    supportsSetSessionMode: false,
    supportsSetSessionModel: false,
    async newSession(): Promise<{ sessionId: string }> {
      return { sessionId: "acp-live" };
    },
    async loadSession(): Promise<void> {},
    async cancelSession(): Promise<void> {},
    async closeSession(): Promise<void> {},
  };

  const store = new SessionStore(storeFile);
  const waitForFlushes = trackPendingFlushes(store);
  const manager = new SessionManager(
    {
      getRuntime() {
        return acp as BridgeAcpRuntime;
      },
    } as AcpRuntimeResolver,
    store,
    60_000,
    { defaultWorkspaceRoot: WORKSPACE_ROOT, defaultBackend: "cursor-official" },
  );

  await manager.init();
  await manager.createNewSlot(CHAT_ID, USER_ID, "p2p", WORKSPACE_ROOT, "cursor-official", "main");
  manager.setSlotLastTurn(CHAT_ID, USER_ID, "p2p", 1, "old prompt", "old reply");

  const rebound = await manager.rebindActiveSlotToResumeHistory(
    CHAT_ID,
    USER_ID,
    "p2p",
    {
      backend: "claude",
      sessionId: "claude-old",
      workspaceRoot: WORKSPACE_ROOT,
      lastActiveAt: Date.now() - 10_000,
      label: "历史问题",
    },
  );
  await waitForFlushes();

  assert.equal(rebound.slotIndex, 1);
  assert.equal(rebound.name, "main");
  assert.equal(rebound.session.backend, "claude");
  assert.equal(rebound.session.sessionId, "claude-old");
  assert.equal(rebound.lastPrompt, undefined);
  assert.equal(rebound.lastReply, undefined);
});

test("群聊共享 session 模式下不同用户会复用同一组 session", async () => {
  const storeFile = await createEmptyStoreFile();

  let createCount = 0;
  const acp: FakeAcpRuntime = {
    supportsLoadSession: false,
    supportsSetSessionMode: false,
    supportsSetSessionModel: false,
    async newSession(): Promise<{ sessionId: string }> {
      createCount += 1;
      return { sessionId: `group-session-${createCount}` };
    },
    async loadSession(): Promise<void> {},
    async cancelSession(): Promise<void> {},
    async closeSession(): Promise<void> {},
  };

  const store = new SessionStore(storeFile);
  const waitForFlushes = trackPendingFlushes(store);
  const manager = new SessionManager(
    acp as BridgeAcpRuntime,
    store,
    60_000,
    {
      defaultWorkspaceRoot: WORKSPACE_ROOT,
      defaultBackend: "cursor-official",
      groupSessionScope: "shared",
    },
  );

  await manager.init();
  const created = await manager.createNewSlot(
    CHAT_ID,
    "admin-1",
    "group",
    WORKSPACE_ROOT,
    "cursor-official",
    "shared-main",
  );
  const reused = await manager.getActiveSession(CHAT_ID, "user-2", "group");
  const listed = await manager.listSlots(CHAT_ID, "user-3", "group");
  const snapshot = manager.getSessionSnapshot(CHAT_ID, "user-4", "group");
  await waitForFlushes();

  assert.equal(created.sessionId, "group-session-1");
  assert.equal(reused?.sessionId, "group-session-1");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.slotIndex, 1);
  assert.equal(listed[0]?.name, "shared-main");
  assert.equal(snapshot?.sessionKey, CHAT_ID);
  assert.equal(createCount, 1);

  const persisted = JSON.parse(await fs.readFile(storeFile, "utf8")) as {
    sessions: Record<string, PersistedSessionGroup>;
  };
  assert.deepEqual(Object.keys(persisted.sessions), [CHAT_ID]);
});
