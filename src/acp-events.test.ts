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

test("mapSessionUpdateToBridgeEvents 保留 config select 选项", () => {
  assert.deepEqual(
    mapSessionUpdateToBridgeEvents("session-1", {
      sessionUpdate: "config_option_update",
      configOptions: [
        {
          type: "select",
          id: "model",
          name: "Model",
          category: "model",
          currentValue: "gpt-5.5",
          options: [
            { value: "gpt-5.5", name: "gpt-5.5" },
            {
              group: "older",
              name: "Older models",
              options: [
                { value: "gpt-5.4/low", name: "gpt-5.4 (low)" },
                { value: "gpt-5.5", name: "duplicate" },
              ],
            },
          ],
        },
        {
          type: "boolean",
          id: "web_search",
          name: "Web search",
          currentValue: true,
        },
      ],
    } as any),
    [
      {
        type: "config_option_update",
        sessionId: "session-1",
        summary: "配置项已更新",
        configOptions: [
          {
            id: "model",
            currentValue: "gpt-5.5",
            category: "model",
            options: [
              { value: "gpt-5.5", name: "gpt-5.5" },
              { value: "gpt-5.4/low", name: "gpt-5.4 (low)" },
            ],
          },
        ],
      },
    ],
  );
});
