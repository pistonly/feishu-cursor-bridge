import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCurrentModeLine,
  formatCurrentModelLine,
  formatNumber,
  formatPercent,
  formatSessionModelLabel,
  formatSessionUsage,
} from "./session-display-format.js";

test("formatPercent 与 formatNumber 返回稳定展示格式", () => {
  assert.equal(formatPercent(1.119263157894737), "1.1%");
  assert.equal(formatPercent(25), "25%");
  assert.equal(formatNumber(10633), "10,633");
});

test("formatSessionUsage 返回 context 百分比与 token 占用", () => {
  assert.equal(
    formatSessionUsage({
      usedTokens: 10633,
      maxTokens: 950000,
      percent: 1.119263157894737,
    }),
    "1.1% (10,633 / 950,000)",
  );
  assert.equal(formatSessionUsage(undefined), undefined);
});

test("formatSessionModelLabel 在有展示名时优先返回展示名", () => {
  assert.equal(
    formatSessionModelLabel({
      currentModelId: "gpt-5.4",
      availableModels: [{ modelId: "gpt-5.4", name: "GPT-5.4" }],
    }),
    "GPT-5.4",
  );
  assert.equal(
    formatSessionModelLabel({
      currentModelId: "claude-opus-4-6/high",
      availableModels: [{ modelId: "claude-opus-4-6/high" }],
    }),
    "`claude-opus-4-6/high`",
  );
  assert.equal(
    formatSessionModelLabel({ currentModelId: undefined, availableModels: [] }),
    undefined,
  );
});

test("formatCurrentModelLine 与 formatCurrentModeLine 保持原有当前值文案", () => {
  assert.equal(
    formatCurrentModelLine({
      currentModelId: "auto",
      availableModels: [{ modelId: "auto", name: "Auto" }],
    }),
    "当前模型：Auto（精确值：`auto`）",
  );
  assert.equal(
    formatCurrentModeLine({
      currentModeId: "plan",
      availableModes: [{ modeId: "plan", name: "Plan" }],
    }),
    "当前模式：Plan（精确值：`plan`）",
  );
  assert.equal(
    formatCurrentModeLine({ currentModeId: undefined, availableModes: [] }),
    undefined,
  );
});
