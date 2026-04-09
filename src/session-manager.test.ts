import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BridgeAcpRuntime } from "./acp/runtime-contract.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type PersistedSessionGroup } from "./session-store.js";

const USER_ID = "user-1";
const CHAT_ID = "chat-1";
const SESSION_KEY = `dm:${USER_ID}`;
const WORKSPACE_ROOT = "/tmp/bridge-session-test";

type FakeAcpRuntime = Pick<
  BridgeAcpRuntime,
  "supportsLoadSession" | "newSession" | "loadSession" | "cancelSession" | "closeSession"
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

test("getSlot 可读取当前活跃 slot 或按名称读取指定 slot", async () => {
  const storeFile = await createEmptyStoreFile();

  let createCount = 0;
  const acp: FakeAcpRuntime = {
    supportsLoadSession: false,
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
