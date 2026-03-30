import assert from "node:assert/strict";
import test from "node:test";
import { formatModelSwitchFailure, formatModelUsage } from "./model-switch.js";

test("formatModelUsage 在缺少模型状态时回退到基础用法提示", () => {
  assert.equal(
    formatModelUsage(),
    "用法：`/model <模型ID>`\n\n可在本机终端执行 `cursor-agent models` 查看可用 ID。",
  );
});

test("formatModelUsage 会列出可用模型与当前模型", () => {
  assert.equal(
    formatModelUsage({
      currentModelId: "auto",
      availableModels: [
        { modelId: "auto", name: "Auto" },
        { modelId: "gpt-5", name: "GPT-5" },
      ],
    }),
    [
      "用法：`/model <模型ID>`",
      "",
      "可用模型 ID（请完整复制反引号中的值；若带 `[]` 或参数后缀也要一并带上）：",
      "• Auto -> `auto`",
      "• GPT-5 -> `gpt-5`",
      "当前模型：Auto（精确值：`auto`）",
    ].join("\n"),
  );
});

test("formatModelSwitchFailure 在缺少模型状态时只保留原始错误", () => {
  const message = formatModelSwitchFailure({
    message: "Internal error",
    code: -32603,
  });

  assert.equal(message, "❌ 切换模型失败:\nInternal error\nJSON-RPC code: -32603");
});

test("formatModelSwitchFailure 会追加可用模型列表与当前模型", () => {
  const message = formatModelSwitchFailure(
    {
      message: "Unknown model",
      data: {
        requestedModelId: "oops",
      },
    },
    {
      currentModelId: "auto",
      availableModels: [
        { modelId: "auto", name: "Auto" },
        { modelId: "gpt-5", name: "GPT-5" },
        { modelId: "claude-3.7-sonnet" },
      ],
    },
  );

  assert.equal(
    message,
    [
      "❌ 切换模型失败:",
      "Unknown model",
      '{\n  "requestedModelId": "oops"\n}',
      "",
      "可用模型 ID（请完整复制反引号中的值；若带 `[]` 或参数后缀也要一并带上）：",
      "• Auto -> `auto`",
      "• GPT-5 -> `gpt-5`",
      "• `claude-3.7-sonnet`",
      "当前模型：Auto（精确值：`auto`）",
    ].join("\n"),
  );
});
