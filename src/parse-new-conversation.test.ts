import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKEND_METADATA,
  COMMAND_BACKEND_ALIAS_MAP,
} from "./acp/backend-metadata.js";
import {
  matchesBridgeHelpCommand,
  matchesBridgeStartCommand,
  matchesInterruptUserCommand,
  parseNewConversationCommand,
} from "./commands/parse-new-conversation.js";

test("parseNewConversationCommand 支持 /reply 默认当前活跃 session", () => {
  assert.deepEqual(parseNewConversationCommand("/reply"), {
    kind: "reply",
    target: null,
  });
});

test("parseNewConversationCommand 支持 /reply 指定编号或名称", () => {
  assert.deepEqual(parseNewConversationCommand("/reply 2"), {
    kind: "reply",
    target: 2,
  });
  assert.deepEqual(parseNewConversationCommand('/reply "backend api"'), {
    kind: "reply",
    target: "backend api",
  });
});

test("parseNewConversationCommand 仅把纯数字目标解析为槽位编号", () => {
  assert.deepEqual(parseNewConversationCommand("/rename 1abc new-name"), {
    kind: "rename",
    target: "1abc",
    name: "new-name",
  });
  assert.deepEqual(parseNewConversationCommand("/close 1abc"), {
    kind: "close",
    target: "1abc",
  });
});

test("parseNewConversationCommand 支持 /history", () => {
  assert.deepEqual(parseNewConversationCommand("/history"), {
    kind: "history",
  });
  assert.deepEqual(parseNewConversationCommand("/history 10"), {
    kind: "history",
    count: 10,
  });
  assert.deepEqual(parseNewConversationCommand("/history x"), {
    kind: "history",
    invalidUsage: true,
  });
});

test("parseNewConversationCommand 支持 /mode 查询或切换模式", () => {
  assert.deepEqual(parseNewConversationCommand("/mode"), {
    kind: "mode",
  });
  assert.deepEqual(parseNewConversationCommand("/mode plan"), {
    kind: "mode",
    modeId: "plan",
  });
});

test("parseNewConversationCommand 将裸 /new 解析为 list", () => {
  assert.deepEqual(parseNewConversationCommand("/new"), {
    kind: "new",
    variant: "list",
  });
});

test("parseNewConversationCommand 支持 /new --backend codex", () => {
  assert.deepEqual(parseNewConversationCommand("/new 1 --backend codex"), {
    kind: "new",
    variant: "preset",
    index: 1,
    backend: "codex",
    name: undefined,
  });
});

test("parseNewConversationCommand 支持 /new -b 简写与 backend 别名", () => {
  for (const [alias, backend] of Object.entries(COMMAND_BACKEND_ALIAS_MAP)) {
    assert.deepEqual(parseNewConversationCommand(`/new 1 -b ${alias}`), {
      kind: "new",
      variant: "preset",
      index: 1,
      backend,
      name: undefined,
    });
  }

  for (const metadata of BACKEND_METADATA) {
    assert.equal(Array.from(metadata.commandAliases).includes(metadata.id), true);
  }

  assert.deepEqual(parseNewConversationCommand("/new /tmp/demo -b=cx"), {
    kind: "new",
    variant: "workspace",
    path: "/tmp/demo",
    backend: "codex",
    name: undefined,
  });
  assert.deepEqual(parseNewConversationCommand("/new /tmp/demo -b=cxs"), {
    kind: "new",
    variant: "workspace",
    path: "/tmp/demo",
    backend: "codex-app-server",
    name: undefined,
  });
});

test("parseNewConversationCommand 会把已移除的 tmux backend 标记为非法用法", () => {
  assert.deepEqual(parseNewConversationCommand("/new 1 -b tmux"), {
    kind: "new",
    variant: "preset",
    index: 1,
    backend: undefined,
    name: undefined,
    invalidUsage: true,
    invalidBackend: "tmux",
  });
});

test("parseNewConversationCommand 支持维护命令与 --force", () => {
  assert.deepEqual(parseNewConversationCommand("/restart"), {
    kind: "restart",
    force: false,
  });
  assert.deepEqual(parseNewConversationCommand("/update --force"), {
    kind: "update",
    force: true,
  });
  assert.deepEqual(parseNewConversationCommand("/restart now"), {
    kind: "restart",
    force: false,
    invalidUsage: true,
  });
});

test("parseNewConversationCommand 支持 /whoami", () => {
  assert.deepEqual(parseNewConversationCommand("/whoami"), {
    kind: "whoami",
  });
  assert.deepEqual(parseNewConversationCommand("/WHOAMI"), {
    kind: "whoami",
  });
});

test("parseNewConversationCommand 支持 /resume", () => {
  assert.deepEqual(parseNewConversationCommand("/resume"), {
    kind: "resume",
    target: null,
  });
  assert.deepEqual(parseNewConversationCommand("/RESUME"), {
    kind: "resume",
    target: null,
  });
  assert.deepEqual(parseNewConversationCommand("/resume 0"), {
    kind: "resume",
    target: 0,
  });
  assert.deepEqual(parseNewConversationCommand("/resume 2"), {
    kind: "resume",
    target: 2,
  });
  assert.deepEqual(parseNewConversationCommand("/resume session-abc"), {
    kind: "resume",
    target: "session-abc",
  });
  assert.deepEqual(parseNewConversationCommand("/resume -b codex session-abc"), {
    kind: "resume",
    target: "session-abc",
    backend: "codex",
  });
  assert.deepEqual(parseNewConversationCommand("/resume session-abc --backend cc"), {
    kind: "resume",
    target: "session-abc",
    backend: "claude",
  });
  assert.deepEqual(parseNewConversationCommand("/resume -b codex"), {
    kind: "resume",
    target: null,
    backend: "codex",
    invalidUsage: true,
  });
  assert.deepEqual(parseNewConversationCommand("/resume -b tmux session-abc"), {
    kind: "resume",
    target: "session-abc",
    invalidUsage: true,
    invalidBackend: "tmux",
  });
});

test("matchesInterruptUserCommand 识别纯文本 /stop、/cancel", () => {
  assert.equal(matchesInterruptUserCommand("/stop"), true);
  assert.equal(matchesInterruptUserCommand("/cancel"), true);
  assert.equal(matchesInterruptUserCommand(" /STOP \n"), true);
  assert.equal(matchesInterruptUserCommand("／stop"), true);
  assert.equal(matchesInterruptUserCommand("not /stop"), false);
});

test("matchesInterruptUserCommand 识别 post 常见的标题换行后再 /stop", () => {
  assert.equal(matchesInterruptUserCommand("无标题\n/stop"), true);
  assert.equal(matchesInterruptUserCommand("讨论\n/stop"), true);
  assert.equal(matchesInterruptUserCommand("说明文字\n/st\nop"), false);
});

test("matchesInterruptUserCommand 不以 / 开头的行前不得含其它斜杠命令", () => {
  assert.equal(matchesInterruptUserCommand("/new list\n/stop"), false);
  assert.equal(matchesInterruptUserCommand("hello\n/stop"), true);
});

test("matchesBridgeHelpCommand 仅匹配整段帮助命令", () => {
  assert.equal(matchesBridgeHelpCommand("/help"), true);
  assert.equal(matchesBridgeHelpCommand("/HELP"), true);
  assert.equal(matchesBridgeHelpCommand("／help"), true);
  assert.equal(matchesBridgeHelpCommand("/commands"), true);
  assert.equal(matchesBridgeHelpCommand("/"), true);
  assert.equal(matchesBridgeHelpCommand("/帮助"), true);
  assert.equal(matchesBridgeHelpCommand("请讲\n/help"), false);
  assert.equal(matchesBridgeHelpCommand("讨论 /help"), false);
  assert.equal(matchesBridgeHelpCommand("/new list\n/help"), false);
});

test("matchesBridgeStartCommand 仅匹配显式 /start", () => {
  assert.equal(matchesBridgeStartCommand("/start"), true);
  assert.equal(matchesBridgeStartCommand(" /START \
"), true);
  assert.equal(matchesBridgeStartCommand("／start"), true);
  assert.equal(matchesBridgeStartCommand("请发 /start"), false);
  assert.equal(matchesBridgeStartCommand("/start now"), false);
});
