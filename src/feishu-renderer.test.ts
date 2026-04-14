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

test("FeishuCardState 会保留工具与正文的时间顺序，同时更新工具最终状态", () => {
  const state = new FeishuCardState();

  state.apply({
    type: "tool_call",
    sessionId: "session-1",
    toolCallId: "tool-1",
    title: "Run npm run typecheck",
    status: "in_progress",
    kind: "execute",
  });
  state.apply({
    type: "agent_message_chunk",
    sessionId: "session-1",
    text: "先看类型错误。",
  });
  state.apply({
    type: "tool_call_update",
    sessionId: "session-1",
    toolCallId: "tool-1",
    status: "completed",
  });

  assert.equal(
    state.toMarkdown(),
    "⚡ Run npm run typecheck — completed\n\n先看类型错误。",
  );
});
