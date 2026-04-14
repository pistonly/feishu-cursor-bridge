import test from "node:test";
import assert from "node:assert/strict";
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
