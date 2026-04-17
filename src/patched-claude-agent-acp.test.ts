import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAccurateClaudeContextUsageUpdate,
  buildClaudeEffortConfigOptions,
  buildClaudeEffortEnhancedModelState,
  parseClaudeModelSelector,
  patchClaudeAcpAgentEffortSupport,
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

test("parseClaudeModelSelector extracts optional Claude effort suffix", () => {
  assert.deepEqual(parseClaudeModelSelector("claude-opus-4-6/high"), {
    modelId: "claude-opus-4-6",
    effort: "high",
  });
  assert.deepEqual(parseClaudeModelSelector("claude-sonnet-4-6"), {
    modelId: "claude-sonnet-4-6",
  });
});

test("Claude effort model state and config options include effort variants", () => {
  const state: Parameters<typeof buildClaudeEffortEnhancedModelState>[0] = {
    baseModels: [
      {
        modelId: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        supportedEffortLevels: ["low", "medium", "high", "max"],
      },
    ],
    currentBaseModelId: "claude-opus-4-6",
    currentEffort: "high" as const,
  };

  assert.deepEqual(buildClaudeEffortEnhancedModelState(state), {
    currentModelId: "claude-opus-4-6/high",
    availableModels: [
      { modelId: "claude-opus-4-6", name: "Claude Opus 4.6" },
      { modelId: "claude-opus-4-6/low", name: "Claude Opus 4.6 / low" },
      { modelId: "claude-opus-4-6/medium", name: "Claude Opus 4.6 / medium" },
      { modelId: "claude-opus-4-6/high", name: "Claude Opus 4.6 / high" },
      { modelId: "claude-opus-4-6/max", name: "Claude Opus 4.6 / max" },
    ],
  });

  const configOptions = buildClaudeEffortConfigOptions(
    [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "claude-opus-4-6",
        options: [{ value: "claude-opus-4-6", name: "Claude Opus 4.6" }],
      },
    ],
    state,
  );
  assert.equal(configOptions.length, 2);
  assert.deepEqual(configOptions[1], {
    id: "reasoning_effort",
    name: "Reasoning Effort",
    description: "Claude reasoning effort level",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [
      {
        value: "low",
        name: "Low",
        description: "Claude low reasoning effort",
      },
      {
        value: "medium",
        name: "Medium",
        description: "Claude medium reasoning effort",
      },
      {
        value: "high",
        name: "High",
        description: "Claude high reasoning effort",
      },
      {
        value: "max",
        name: "Max",
        description: "Claude max reasoning effort",
      },
    ],
  });
});

function createClaudeEffortAgentFixture(initial?: {
  modelId?: string;
  effort?: "low" | "medium" | "high" | "max";
}) {
  let currentModelId = initial?.modelId ?? "claude-opus-4-6";
  let currentEffort = initial?.effort;
  const queryCalls: Array<{
    method: "setModel" | "applyFlagSettings";
    value: unknown;
  }> = [];
  const sent: Array<unknown> = [];
  const createSessionCalls: Array<unknown> = [];
  const sendAvailableCommandsCalls: string[] = [];
  const supportedModels = [
    {
      value: "claude-opus-4-6",
      displayName: "Claude Opus 4.6",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "max"],
    },
    {
      value: "claude-sonnet-4-6",
      displayName: "Claude Sonnet 4.6",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high"],
    },
  ];
  function buildSession() {
    return {
      cwd: "/tmp/workspace",
      promptRunning: false,
      pendingMessages: new Map(),
      cancelled: false,
      settingsManager: {
        dispose() {},
      },
      abortController: {
        abort() {},
      },
      query: {
        async setModel(model?: string) {
          queryCalls.push({ method: "setModel", value: model });
          if (typeof model === "string" && model.trim()) {
            currentModelId = model.trim();
          }
        },
        async applyFlagSettings(settings: Record<string, unknown>) {
          queryCalls.push({ method: "applyFlagSettings", value: settings });
          if (typeof settings.model === "string" && settings.model.trim()) {
            currentModelId = settings.model.trim();
          }
          if ("effortLevel" in settings) {
            currentEffort =
              typeof settings.effortLevel === "string"
                ? (settings.effortLevel as typeof currentEffort)
                : undefined;
          }
        },
        async supportedModels() {
          return supportedModels;
        },
        async getSettings() {
          return {
            applied: {
              model: currentModelId,
              effort: currentEffort ?? null,
            },
          };
        },
        close() {},
      },
      models: {
        currentModelId: currentEffort
          ? `${currentModelId}/${currentEffort}`
          : currentModelId,
        availableModels: [
          { modelId: "claude-opus-4-6", name: "Claude Opus 4.6" },
          { modelId: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
        ],
      },
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: currentModelId,
          options: [
            { value: "claude-opus-4-6", name: "Claude Opus 4.6" },
            { value: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
          ],
        },
      ],
    };
  }

  let session = buildSession();
  const agent = {
    sessions: {
      "session-1": session,
    },
    client: {
      async sessionUpdate(params: unknown) {
        sent.push(params);
      },
      async extNotification(_method: string, _params: Record<string, unknown>) {},
    },
    logger: {
      error() {},
    },
    async newSession(_params?: unknown) {
      return {
        sessionId: "session-1",
        models: session.models,
        configOptions: session.configOptions,
      };
    },
    async unstable_setSessionModel(
      _params?: { sessionId: string; modelId: string },
    ) {
      throw new Error("original unstable_setSessionModel should be replaced");
    },
    async setSessionConfigOption(
      _params?: { sessionId: string; configId: string; value: unknown },
    ) {
      throw new Error("original setSessionConfigOption should be replaced");
    },
    async createSession(
      _params: { cwd: string; mcpServers?: unknown[]; _meta?: Record<string, unknown> },
      creationOpts?: Record<string, unknown>,
    ) {
      createSessionCalls.push(creationOpts ?? null);
      currentEffort =
        typeof creationOpts?.["effort"] === "string"
          ? (creationOpts["effort"] as typeof currentEffort)
          : undefined;
      session = buildSession();
      agent.sessions["session-1"] = session;
      return {
        sessionId: "session-1",
        models: session.models,
        configOptions: session.configOptions,
      };
    },
    async sendAvailableCommandsUpdate(sessionId: string) {
      sendAvailableCommandsCalls.push(sessionId);
    },
  };

  return {
    agent,
    queryCalls,
    sent,
    createSessionCalls,
    sendAvailableCommandsCalls,
    get session() {
      return session;
    },
    getCurrentState() {
      return {
        modelId: currentModelId,
        effort: currentEffort,
      };
    },
  };
}

test("patchClaudeAcpAgentEffortSupport enriches newSession response with effort selectors", async () => {
  const fixture = createClaudeEffortAgentFixture({ effort: "high" });
  patchClaudeAcpAgentEffortSupport(fixture.agent as never);

  const response = await fixture.agent.newSession();
  const result = response as {
    models: { currentModelId?: string; availableModels: Array<{ modelId: string }> };
    configOptions: Array<{ id?: string; currentValue?: string }>;
  };

  assert.equal(result.models.currentModelId, "claude-opus-4-6/high");
  assert.ok(
    result.models.availableModels.some(
      (model) => model.modelId === "claude-opus-4-6/high",
    ),
  );
  assert.ok(
    result.configOptions.some(
      (option) =>
        option.id === "reasoning_effort" && option.currentValue === "high",
    ),
  );
});

test("patchClaudeAcpAgentEffortSupport maps model/effort selector to Claude SDK model plus effort settings", async () => {
  const fixture = createClaudeEffortAgentFixture();
  patchClaudeAcpAgentEffortSupport(fixture.agent as never);

  await fixture.agent.unstable_setSessionModel({
    sessionId: "session-1",
    modelId: "claude-opus-4-6/medium",
  });

  assert.deepEqual(fixture.queryCalls, [
    { method: "setModel", value: "claude-opus-4-6" },
    {
      method: "applyFlagSettings",
      value: {
        model: "claude-opus-4-6",
        effortLevel: "medium",
      },
    },
  ]);
  assert.deepEqual(fixture.getCurrentState(), {
    modelId: "claude-opus-4-6",
    effort: "medium",
  });
  assert.equal(fixture.session.models.currentModelId, "claude-opus-4-6/medium");
  assert.deepEqual(fixture.sent, [
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: fixture.session.configOptions,
      },
    },
  ]);
});

test("patchClaudeAcpAgentEffortSupport preserves prior effort when selector omits it", async () => {
  const fixture = createClaudeEffortAgentFixture({ effort: "low" });
  patchClaudeAcpAgentEffortSupport(fixture.agent as never);

  await fixture.agent.unstable_setSessionModel({
    sessionId: "session-1",
    modelId: "claude-opus-4-6",
  });

  assert.deepEqual(fixture.queryCalls, [
    { method: "setModel", value: "claude-opus-4-6" },
    {
      method: "applyFlagSettings",
      value: {
        model: "claude-opus-4-6",
        effortLevel: "low",
      },
    },
  ]);
  assert.deepEqual(fixture.getCurrentState(), {
    modelId: "claude-opus-4-6",
    effort: "low",
  });
  assert.equal(fixture.session.models.currentModelId, "claude-opus-4-6/low");
});

test("patchClaudeAcpAgentEffortSupport recreates Claude session for max effort on supported Opus model", async () => {
  const fixture = createClaudeEffortAgentFixture();
  patchClaudeAcpAgentEffortSupport(fixture.agent as never);

  await fixture.agent.unstable_setSessionModel({
    sessionId: "session-1",
    modelId: "claude-opus-4-6/max",
  });

  assert.deepEqual(fixture.createSessionCalls, [
    {
      resume: "session-1",
      effort: "max",
    },
  ]);
  assert.deepEqual(fixture.queryCalls, [
    { method: "setModel", value: "claude-opus-4-6" },
  ]);
  assert.deepEqual(fixture.getCurrentState(), {
    modelId: "claude-opus-4-6",
    effort: "max",
  });
  assert.equal(fixture.session.models.currentModelId, "claude-opus-4-6/max");
  assert.deepEqual(fixture.sendAvailableCommandsCalls, ["session-1"]);
});
