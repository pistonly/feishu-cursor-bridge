import assert from "node:assert/strict";
import test from "node:test";
import {
  emitAccurateClaudeContextUsageUpdate,
} from "./acp/patched-claude-agent-acp.js";

test("emitAccurateClaudeContextUsageUpdate emits corrected usage_update from result usage", async () => {
  const calls: Array<unknown> = [];
  const ok = await emitAccurateClaudeContextUsageUpdate(
    {
      client: {
        async sessionUpdate(params: unknown) {
          calls.push(params);
        },
        async extNotification() {},
      },
      logger: {
        error() {},
      },
    },
    "session-1",
    19_783,
    200_000,
  );

  assert.equal(ok, true);
  assert.deepEqual(calls, [
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "usage_update",
        used: 19_783,
        size: 200_000,
      },
    },
  ]);
});

test("emitAccurateClaudeContextUsageUpdate skips invalid usage values", async () => {
  const calls: Array<unknown> = [];
  const ok = await emitAccurateClaudeContextUsageUpdate(
    {
      client: {
        async sessionUpdate(params: unknown) {
          calls.push(params);
        },
        async extNotification() {},
      },
      logger: {
        error() {},
      },
    },
    "session-1",
    0,
    200_000,
  );

  assert.equal(ok, false);
  assert.deepEqual(calls, []);
});
