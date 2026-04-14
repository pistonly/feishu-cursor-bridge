import assert from "node:assert/strict";
import test from "node:test";
import {
  formatModeSwitchFailure,
  formatModeUsage,
  resolveSessionModeInput,
} from "./commands/mode-switch.js";

test("formatModeUsage 在缺少模式状态时回退到基础用法提示", () => {
  assert.equal(
    formatModeUsage(),
    "用法：`/mode <模式ID>`\n\n常见模式：`agent`、`plan`、`ask`（以当前 ACP session 返回的列表为准）。",
  );
});

test("formatModeUsage 会列出可用模式与当前模式", () => {
  assert.equal(
    formatModeUsage({
      currentModeId: "plan",
      availableModes: [
        {
          modeId: "agent",
          name: "Agent",
          description: "Full agent capabilities with tool access",
        },
        {
          modeId: "plan",
          name: "Plan",
          description: "Read-only mode for planning",
        },
      ],
    }),
    [
      "用法：`/mode <模式ID>`",
      "",
      "可用模式 ID：",
      "• Agent -> `agent` — Full agent capabilities with tool access",
      "• Plan -> `plan` — Read-only mode for planning",
      "当前模式：Plan（精确值：`plan`）",
    ].join("\n"),
  );
});

test("resolveSessionModeInput 会按当前列表做大小写归一化", () => {
  assert.deepEqual(
    resolveSessionModeInput("PLAN", {
      availableModes: [
        { modeId: "agent", name: "Agent" },
        { modeId: "plan", name: "Plan" },
      ],
    }),
    { modeId: "plan" },
  );
});

test("formatModeSwitchFailure 在缺少模式状态时只保留原始错误", () => {
  assert.equal(
    formatModeSwitchFailure({
      message: "Internal error",
      code: -32603,
    }),
    "❌ 切换模式失败:\nInternal error\nJSON-RPC code: -32603",
  );
});

test("formatModeSwitchFailure 会追加可用模式列表与当前模式", () => {
  assert.equal(
    formatModeSwitchFailure(
      {
        message: "Invalid mode",
        data: { requestedModeId: "oops" },
      },
      {
        currentModeId: "ask",
        availableModes: [
          { modeId: "agent", name: "Agent" },
          { modeId: "plan", name: "Plan" },
          { modeId: "ask", name: "Ask" },
        ],
      },
    ),
    [
      "❌ 切换模式失败:",
      "Invalid mode",
      '{\n  "requestedModeId": "oops"\n}',
      "",
      "可用模式 ID：",
      "• Agent -> `agent`",
      "• Plan -> `plan`",
      "• Ask -> `ask`",
      "当前模式：Ask（精确值：`ask`）",
    ].join("\n"),
  );
});
