import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBackendDescriptionLines,
  getBackendShortcut,
} from "../acp/backend-metadata.js";
import {
  buildWelcomeCardMarkdown,
  buildWorkspaceWithBackendSelectCardMarkdown,
} from "./interactive-cards.js";

test("buildWorkspaceWithBackendSelectCardMarkdown uses metadata-driven shortcuts", () => {
  const markdown = buildWorkspaceWithBackendSelectCardMarkdown({
    presets: ["/tmp/demo"],
    showBackendSelector: true,
    enabledBackends: ["cursor-official", "claude"],
    defaultBackend: "claude",
  });

  assert.match(markdown, new RegExp(`--backend cursor-official.*-b ${getBackendShortcut("cursor-official")}`));
  assert.match(markdown, new RegExp(`--backend claude.*-b ${getBackendShortcut("claude")}`));
  assert.doesNotMatch(markdown, /--backend codex/);
  assert.match(markdown, /claude` \/ `-b cc` \(默认\)/);
});

test("buildWelcomeCardMarkdown includes backend descriptions from shared metadata", () => {
  const markdown = buildWelcomeCardMarkdown();
  for (const line of buildBackendDescriptionLines("   • ")) {
    assert.match(markdown, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.match(markdown, new RegExp(`-b ${getBackendShortcut("cursor-official")}`));
  assert.match(markdown, new RegExp(`-b ${getBackendShortcut("claude")}`));
  assert.match(markdown, new RegExp(`-b ${getBackendShortcut("codex")}`));
  assert.doesNotMatch(markdown, /-b legacy/);
});
