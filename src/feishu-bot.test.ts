import test from "node:test";
import assert from "node:assert/strict";
import {
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
