import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAccurateClaudeContextUsageUpdate,
  patchClaudeAcpAgentContextUsage,
} from "./acp/patched-claude-agent-acp.js";

test("buildAccurateClaudeContextUsageUpdate builds corrected usage_update payload", () => {
  const update = buildAccurateClaudeContextUsageUpdate(
    "session-1",
    19_783,
    200_000,
  );

  assert.deepEqual(update, {
    sessionId: "session-1",
    update: {
      sessionUpdate: "usage_update",
      used: 19_783,
      size: 200_000,
    },
  });
});

test("buildAccurateClaudeContextUsageUpdate skips invalid usage values", () => {
  const update = buildAccurateClaudeContextUsageUpdate(
    "session-1",
    0,
    200_000,
  );

  assert.equal(update, undefined);
});

test("patchClaudeAcpAgentContextUsage preserves last known maxTokens across compact boundary", async () => {
  const sent: Array<unknown> = [];
  const client = {
    async sessionUpdate(params: unknown) {
      sent.push(params);
    },
    async extNotification(_method: string, _params: Record<string, unknown>) {},
  };
  const agent = {
    client,
    logger: {
      error() {},
    },
  };

  patchClaudeAcpAgentContextUsage(agent as never);

  await client.extNotification("_claude/sdkMessage", {
    sessionId: "session-1",
    message: {
      type: "result",
      usage: {
        input_tokens: 19_783,
        output_tokens: 20,
      },
    },
  });
  await client.sessionUpdate({
    sessionId: "session-1",
    update: {
      sessionUpdate: "usage_update",
      used: 0,
      size: 1_000_000,
      cost: { amount: 1, currency: "USD" },
    },
  });

  await client.extNotification("_claude/sdkMessage", {
    sessionId: "session-1",
    message: {
      type: "system",
      subtype: "compact_boundary",
    },
  });
  await client.sessionUpdate({
    sessionId: "session-1",
    update: {
      sessionUpdate: "usage_update",
      used: 0,
      size: 200_000,
    },
  });
  await client.extNotification("_claude/sdkMessage", {
    sessionId: "session-1",
    message: {
      type: "result",
      usage: {
        input_tokens: 100,
        output_tokens: 10,
      },
    },
  });
  await client.sessionUpdate({
    sessionId: "session-1",
    update: {
      sessionUpdate: "usage_update",
      used: 0,
      size: 200_000,
      cost: { amount: 2, currency: "USD" },
    },
  });

  assert.deepEqual(sent, [
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "usage_update",
        used: 19_803,
        size: 1_000_000,
      },
    },
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "usage_update",
        used: 0,
        size: 1_000_000,
      },
    },
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "usage_update",
        used: 0,
        size: 1_000_000,
        cost: { amount: 2, currency: "USD" },
      },
    },
  ]);
});
