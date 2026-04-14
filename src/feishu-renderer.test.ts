import assert from "node:assert/strict";
import test from "node:test";
import { FeishuCardState } from "./feishu/renderer.js";

test("FeishuCardState 会用 tool_call_update 覆盖同一工具的中间状态", () => {
  const state = new FeishuCardState();

  state.apply({
    type: "tool_call",
    sessionId: "session-1",
    toolCallId: "tool-1",
    title: "Run npx tsx --test src/bridge.test.ts",
    status: "in_progress",
    kind: "execute",
  });
  state.apply({
    type: "tool_call_update",
    sessionId: "session-1",
    toolCallId: "tool-1",
    status: "?",
  });
  state.apply({
    type: "tool_call_update",
    sessionId: "session-1",
    toolCallId: "tool-1",
    status: "?",
  });
  state.apply({
    type: "tool_call_update",
    sessionId: "session-1",
    toolCallId: "tool-1",
    status: "completed",
  });

  assert.equal(state.toolCount(), 1);
  assert.equal(
    state.toMarkdown(),
    "⚡ Run npx tsx --test src/bridge.test.ts — completed",
  );
});

test("FeishuCardState 会在长时间执行时显示分档耗时，并把问号状态视为仍在进行", () => {
  const realNow = Date.now;
  let nowMs = 0;
  Date.now = () => nowMs;

  try {
    const state = new FeishuCardState(false, {
      activeToolElapsedHintDelayMs: 10_000,
      activeToolElapsedHintIntervalMs: 10_000,
    });

    state.apply({
      type: "tool_call",
      sessionId: "session-1",
      toolCallId: "tool-1",
      title: "Run npm run typecheck",
      status: "in_progress",
      kind: "execute",
    });
    state.apply({
      type: "tool_call_update",
      sessionId: "session-1",
      toolCallId: "tool-1",
      status: "?",
    });

    assert.equal(state.toMarkdown(nowMs), "⚡ Run npm run typecheck — in_progress");
    assert.equal(state.nextToolRefreshDelayMs(nowMs), 10_000);

    nowMs = 12_000;
    assert.equal(
      state.toMarkdown(nowMs),
      "⚡ Run npm run typecheck — in_progress (10s)",
    );
    assert.equal(state.nextToolRefreshDelayMs(nowMs), 8_000);

    nowMs = 20_000;
    assert.equal(
      state.toMarkdown(nowMs),
      "⚡ Run npm run typecheck — in_progress (20s)",
    );
  } finally {
    Date.now = realNow;
  }
});

test("FeishuCardState 会把状态摘要追加到最后一张卡片末尾", () => {
  const state = new FeishuCardState();
  state.setStatusSummary("`codex` | GPT-5 | 38.4% (83,000 / 216,000)");
  state.apply({
    type: "agent_message_chunk",
    sessionId: "session-1",
    text: "正文内容",
  });

  assert.equal(
    state.toMarkdown(),
    "正文内容\n\n`codex` | GPT-5 | 38.4% (83,000 / 216,000)",
  );
});

test("FeishuCardState 在多张卡片时只把状态摘要放到最后一张", () => {
  const state = new FeishuCardState();
  state.setStatusSummary("`cursor-official` | Auto | —");
  state.apply({
    type: "agent_message_chunk",
    sessionId: "session-1",
    text: "这是一段很长的正文。".repeat(30),
  });

  const chunks = state.toCardMarkdownChunks({
    maxMarkdownLength: 120,
    maxTools: 8,
  });

  assert.ok(chunks.length > 1);
  assert.equal(chunks.slice(0, -1).some((chunk) => chunk.includes("`cursor-official` | Auto | —")), false);
  assert.equal(chunks.at(-1)?.includes("`cursor-official` | Auto | —"), true);
});
