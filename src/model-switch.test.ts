import assert from "node:assert/strict";
import test from "node:test";
import {
  formatModelSwitchFailure,
  formatModelUsage,
  resolveOfficialModelSelectorInput,
} from "./model-switch.js";

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

test("formatModelUsage 在 officialNumbered 下列出带【序号】的模型", () => {
  assert.equal(
    formatModelUsage(
      {
        currentModelId: "b",
        availableModels: [
          { modelId: "a", name: "A" },
          { modelId: "b", name: "B" },
        ],
      },
      { officialNumbered: true },
    ),
    [
      "用法：`/model <模型ID>`",
      "",
      "可用模型（`【n】` 为序号，可直接 `/model n`；亦可完整复制反引号内精确值）：",
      "• 【1】A -> `a`",
      "• 【2】B -> `b`",
      "当前模型：B（精确值：`b`）",
    ].join("\n"),
  );
});

test("resolveOfficialModelSelectorInput 非数字原样返回", () => {
  assert.deepEqual(
    resolveOfficialModelSelectorInput("composer-2[fast=true]", {
      availableModels: [{ modelId: "x" }],
    }),
    { modelId: "composer-2[fast=true]" },
  );
});

test("resolveOfficialModelSelectorInput 按 1-based 序号解析", () => {
  assert.deepEqual(
    resolveOfficialModelSelectorInput("2", {
      availableModels: [
        { modelId: "first", name: "One" },
        { modelId: "composer-2[fast=true]", name: "Composer 2" },
      ],
    }),
    { modelId: "composer-2[fast=true]", pickedByIndex: 2 },
  );
});

test("resolveOfficialModelSelectorInput 序号无效时抛错", () => {
  assert.throws(
    () =>
      resolveOfficialModelSelectorInput("0", {
        availableModels: [{ modelId: "a" }],
      }),
    /序号 0 无效/,
  );
  assert.throws(
    () =>
      resolveOfficialModelSelectorInput("3", {
        availableModels: [{ modelId: "a" }, { modelId: "b" }],
      }),
    /序号 3 无效/,
  );
});

test("resolveOfficialModelSelectorInput 无列表时纯数字抛错", () => {
  assert.throws(
    () => resolveOfficialModelSelectorInput("1", undefined),
    /尚无可用模型列表/,
  );
  assert.throws(
    () => resolveOfficialModelSelectorInput("1", { availableModels: [] }),
    /尚无可用模型列表/,
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

test("formatModelSwitchFailure 在 officialNumbered 下列出带序号", () => {
  const message = formatModelSwitchFailure(
    new Error("bad"),
    {
      currentModelId: "auto",
      availableModels: [{ modelId: "auto", name: "Auto" }],
    },
    { officialNumbered: true },
  );
  assert.ok(message.includes("【1】"));
  assert.ok(message.includes("可直接 `/model n`"));
});
