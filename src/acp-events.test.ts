import assert from "node:assert/strict";
import test from "node:test";
import { mapSessionUpdateToBridgeEvents } from "./acp/events.js";

test("mapSessionUpdateToBridgeEvents 复用共享百分比格式化生成 usage_update summary", () => {
  assert.deepEqual(
    mapSessionUpdateToBridgeEvents("session-1", {
      sessionUpdate: "usage_update",
      used: 25,
      size: 100,
    }),
    [
      {
        type: "usage_update",
        sessionId: "session-1",
        summary: "用量统计已更新（25%）",
        usage: {
          usedTokens: 25,
          maxTokens: 100,
          percent: 25,
        },
      },
    ],
  );

  assert.deepEqual(
    mapSessionUpdateToBridgeEvents("session-1", {
      sessionUpdate: "usage_update",
      used: 10633,
      size: 950000,
    }),
    [
      {
        type: "usage_update",
        sessionId: "session-1",
        summary: "用量统计已更新（1.1%）",
        usage: {
          usedTokens: 10633,
          maxTokens: 950000,
          percent: (10633 / 950000) * 100,
        },
      },
    ],
  );
});
