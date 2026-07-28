import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  AcpRuntimeRegistry,
  createAcpRuntime,
  formatAcpBackendLabel,
} from "./runtime.js";
import { createTestConfig } from "../test-utils/create-test-config.js";

test("Gemini backend is exposed by the runtime factory", () => {
  const runtime = createAcpRuntime(
    createTestConfig({
      backend: "gemini",
      enabledBackends: ["gemini"],
      acp: { geminiSpawnCommand: "gemini", geminiSpawnArgs: ["--acp"] },
      bridge: { cardUpdateThrottleMs: 200 },
    }),
    new EventEmitter() as any,
  );
  assert.equal(runtime.backend, "gemini");
  assert.equal(formatAcpBackendLabel("gemini"), "Gemini CLI（gemini --acp）");
});

test("runtime status reflects successful on-demand recovery", () => {
  const registry = new AcpRuntimeRegistry(
    createTestConfig({
      backend: "gemini",
      enabledBackends: ["gemini"],
      acp: { geminiSpawnCommand: "gemini", geminiSpawnArgs: ["--acp"] },
      bridge: { cardUpdateThrottleMs: 200 },
    }),
  );
  (registry as any).runtimes.set("gemini", {
    runtime: {
      backend: "gemini",
      initializeResult: { protocolVersion: "test" },
    },
    state: "error",
    errorAt: 1,
    errorMessage: "previous startup failure",
  });

  const status = registry.getRuntimeStatus("gemini");
  assert.equal(status.state, "ready");
  assert.equal(status.errorAt, undefined);
  assert.equal(status.errorMessage, undefined);
});
