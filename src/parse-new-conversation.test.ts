import test from "node:test";
import assert from "node:assert/strict";
import { parseNewConversationCommand } from "./parse-new-conversation.js";

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
