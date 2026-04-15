import assert from "node:assert/strict";
import test from "node:test";
import {
  emitAccurateClaudeContextUsageUpdate,
} from "./acp/patched-claude-agent-acp.js";

test("emitAccurateClaudeContextUsageUpdate emits corrected usage_update from getContextUsage", async () => {
  const calls: Array<unknown> = [];
  const ok = await emitAccurateClaudeContextUsageUpdate(
    {
      sessions: {
        "session-1": {
          query: {
            async getContextUsage() {
              return {
                totalTokens: 19_783,
                maxTokens: 200_000,
              };
            },
          },
        },
      },
      client: {
        async sessionUpdate(params: unknown) {
          calls.push(params);
        },
      },
      logger: {
        error() {},
      },
    },
    "session-1",
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

test("emitAccurateClaudeContextUsageUpdate skips invalid context snapshots", async () => {
  const calls: Array<unknown> = [];
  const ok = await emitAccurateClaudeContextUsageUpdate(
    {
      sessions: {
        "session-1": {
          query: {
            async getContextUsage() {
              return {
                totalTokens: 0,
                maxTokens: 200_000,
              };
            },
          },
        },
      },
      client: {
        async sessionUpdate(params: unknown) {
          calls.push(params);
        },
      },
      logger: {
        error() {},
      },
    },
    "session-1",
  );

  assert.equal(ok, false);
  assert.deepEqual(calls, []);
});
