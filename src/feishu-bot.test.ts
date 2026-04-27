import test from "node:test";
import assert from "node:assert/strict";
import {
  FeishuBot,
  parseIncomingResourceFromMessage,
  parsePostEmbeddedImageKeys,
} from "./feishu/bot.js";

test("parseIncomingResourceFromMessage 识别 image 与 file", () => {
  assert.deepEqual(
    parseIncomingResourceFromMessage(JSON.stringify({ image_key: "img_123" }), "image"),
    { apiType: "image", fileKey: "img_123", messageKind: "image" },
  );

  assert.deepEqual(
    parseIncomingResourceFromMessage(
      JSON.stringify({ file_key: "file_123", file_name: "report.pdf" }),
      "file",
    ),
    {
      apiType: "file",
      fileKey: "file_123",
      displayName: "report.pdf",
      messageKind: "file",
    },
  );
});

test("parseIncomingResourceFromMessage 对不支持类型返回 undefined", () => {
  assert.equal(
    parseIncomingResourceFromMessage(JSON.stringify({ file_key: "x" }), "text"),
    undefined,
  );
  assert.equal(parseIncomingResourceFromMessage("not-json", "file"), undefined);
});

test("parsePostEmbeddedImageKeys 提取并去重内嵌图片", () => {
  const raw = JSON.stringify({
    zh_cn: {
      title: "标题",
      content: [
        [
          { tag: "text", text: "hello" },
          { tag: "img", image_key: "img_a" },
        ],
        [
          { tag: "img", image_key: "img_b" },
          { tag: "img", image_key: "img_a" },
        ],
      ],
    },
  });
  assert.deepEqual(parsePostEmbeddedImageKeys(raw), ["img_a", "img_b"]);
});

test("stripBotMentionKeepLines 只移除机器人 @，保留其它用户 @", () => {
  const bot = new FeishuBot({
    appId: "app-id",
    appSecret: "app-secret",
    domain: "feishu",
  });
  (bot as any).botOpenId = "ou_bot";

  assert.equal(
    bot.stripBotMentionKeepLines("@Bot 请通知 @Alice", [
      { key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } },
      { key: "@_user_2", name: "Alice", id: { open_id: "ou_alice" } },
    ]),
    "请通知 @Alice",
  );

  const stripped = bot.stripBotMentionKeepLines(
    '<at user_id="ou_bot">Bot</at> 请通知 <at user_id="ou_alice">Alice</at>',
  );
  assert.equal(
    stripped,
    '请通知 <at user_id="ou_alice">Alice</at>',
  );
});

test("sendText 在线程回复分片时所有分片都走 reply_in_thread", async () => {
  const bot = new FeishuBot({
    appId: "app-id",
    appSecret: "app-secret",
    domain: "feishu",
  });
  const calls: Array<{ kind: "reply" | "create"; data: Record<string, unknown> }> = [];
  let seq = 0;
  (bot as any).client = {
    im: {
      message: {
        reply: async (payload: any) => {
          calls.push({ kind: "reply", data: payload?.data ?? {} });
          seq += 1;
          return { data: { message_id: `r${seq}` } };
        },
        create: async (payload: any) => {
          calls.push({ kind: "create", data: payload?.data ?? {} });
          seq += 1;
          return { data: { message_id: `c${seq}` } };
        },
      },
    },
  };

  const longText = "a".repeat(4500);
  const messageId = await bot.sendText("chat_1", longText, "msg_1", {
    replyInThread: true,
  });

  assert.equal(messageId, "r2");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.kind), ["reply", "reply"]);
  for (const call of calls) {
    assert.equal(call.data.reply_in_thread, true);
    assert.equal(call.data.msg_type, "text");
  }
});

test("sendText 非线程回复分片时仅首片 reply 后续走 create", async () => {
  const bot = new FeishuBot({
    appId: "app-id",
    appSecret: "app-secret",
    domain: "feishu",
  });
  const calls: Array<{ kind: "reply" | "create"; data: Record<string, unknown> }> = [];
  let seq = 0;
  (bot as any).client = {
    im: {
      message: {
        reply: async (payload: any) => {
          calls.push({ kind: "reply", data: payload?.data ?? {} });
          seq += 1;
          return { data: { message_id: `r${seq}` } };
        },
        create: async (payload: any) => {
          calls.push({ kind: "create", data: payload?.data ?? {} });
          seq += 1;
          return { data: { message_id: `c${seq}` } };
        },
      },
    },
  };

  const longText = "b".repeat(4500);
  const messageId = await bot.sendText("chat_2", longText, "msg_2");

  assert.equal(messageId, "c2");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.kind), ["reply", "create"]);
  assert.equal(calls[0]?.data.reply_in_thread, undefined);
});
