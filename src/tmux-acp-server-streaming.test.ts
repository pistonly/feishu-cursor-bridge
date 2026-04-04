import assert from "node:assert/strict";
import test from "node:test";
import {
  createStreamingHooks,
  parseToolStatus,
} from "./acp/tmux-streaming.js";

type StreamingUpdate = Parameters<typeof createStreamingHooks>[1] extends (
  update: infer Update,
) => void
  ? Update
  : never;

test("parseToolStatus 会过滤低价值的汇总状态", () => {
  assert.equal(parseToolStatus("Globbing, reading 1 glob, 1 file"), undefined);
  assert.equal(parseToolStatus("Reading 3 files"), undefined);
  assert.deepEqual(parseToolStatus("Read README.md"), {
    kind: "read",
    title: "Read README.md",
    state: "completed",
    identity: "read:readme.md",
  });
});

test("createStreamingHooks 会合并同一目标的重复 tool_call 生命周期", () => {
  const updates: StreamingUpdate[] = [];
  const streaming = createStreamingHooks("prompt", (update) => {
    updates.push(update);
  });

  streaming.hooks.onSemanticSignals?.([
    { kind: "status", text: "Globbing, reading 1 glob, 1 file" },
    { kind: "status", text: 'Globbing "**/*" in .' },
    { kind: "status", text: 'Globbed "**/*" in .' },
    { kind: "status", text: "Reading README.md" },
    { kind: "status", text: "Read README.md" },
    { kind: "status", text: "Reading README.md" },
    { kind: "status", text: "Read README.md" },
    { kind: "status", text: "Reading package.json" },
  ]);
  streaming.finalize("completed");

  assert.deepEqual(updates, [
    {
      sessionUpdate: "tool_call",
      toolCallId: "tmux-tool-1",
      title: 'Globbing "**/*" in .',
      status: "in_progress",
      kind: "search",
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "tmux-tool-1",
      status: "completed",
      rawOutput: { status: 'Globbed "**/*" in .' },
    },
    {
      sessionUpdate: "tool_call",
      toolCallId: "tmux-tool-2",
      title: "Reading README.md",
      status: "in_progress",
      kind: "read",
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "tmux-tool-2",
      status: "completed",
      rawOutput: { status: "Read README.md" },
    },
    {
      sessionUpdate: "tool_call",
      toolCallId: "tmux-tool-3",
      title: "Reading package.json",
      status: "in_progress",
      kind: "read",
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "tmux-tool-3",
      status: "completed",
      rawOutput: undefined,
    },
  ]);
});

test("createStreamingHooks 会忽略取消后 shell resume 提示", () => {
  const updates: StreamingUpdate[] = [];
  const streaming = createStreamingHooks("prompt", (update) => {
    updates.push(update);
  });

  streaming.hooks.onReplyTextProgress?.(
    "To resume this session: agent --resume=12345678-1234-1234-1234-123456789abc",
  );

  assert.deepEqual(updates, []);
});

test("createStreamingHooks 会忽略取消后的 shell prompt", () => {
  const updates: StreamingUpdate[] = [];
  const streaming = createStreamingHooks("prompt", (update) => {
    updates.push(update);
  });

  streaming.hooks.onReplyTextProgress?.("root@container:~/Documents/feishu-cursor-bridge#");

  assert.deepEqual(updates, []);
});

test("createStreamingHooks 会保留回复中的空行", () => {
  const updates: StreamingUpdate[] = [];
  const streaming = createStreamingHooks("prompt", (update) => {
    updates.push(update);
  });

  streaming.hooks.onReplyTextProgress?.("第一段\n\n第二段");

  assert.deepEqual(updates, [
    {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "第一段\n\n第二段",
      },
    },
  ]);
});
