import test from "node:test";
import assert from "node:assert/strict";
import {
  ACP_BACKENDS,
  BACKEND_METADATA,
  COMMAND_BACKEND_ALIAS_MAP,
  CONFIG_BACKEND_ALIAS_MAP,
  formatCompatibleBackendAliases,
  formatPreferredBackendShortcuts,
  formatSupportedBackendValuePattern,
  formatSupportedBackendValues,
  getBackendShortcut,
} from "./backend-metadata.js";

test("backend metadata keeps canonical backend ids ordered", () => {
  assert.deepEqual(ACP_BACKENDS, ["cursor-official", "cursor-legacy", "claude", "codex", "gemini"]);
});

test("backend metadata aliases do not collide across backends", () => {
  const commandAliases = new Set<string>();
  const configAliases = new Set<string>();
  const shortcuts = new Set<string>();

  for (const metadata of BACKEND_METADATA) {
    assert.ok(Array.from(metadata.commandAliases).includes(metadata.id));
    assert.ok(Array.from(metadata.configAliases).includes(metadata.id));
    assert.equal(shortcuts.has(metadata.preferredShortcut), false);
    shortcuts.add(metadata.preferredShortcut);

    for (const alias of metadata.commandAliases) {
      assert.equal(commandAliases.has(alias), false, `duplicate command alias: ${alias}`);
      commandAliases.add(alias);
      assert.equal(COMMAND_BACKEND_ALIAS_MAP[alias], metadata.id);
    }

    for (const alias of metadata.configAliases) {
      assert.equal(configAliases.has(alias), false, `duplicate config alias: ${alias}`);
      configAliases.add(alias);
      assert.equal(CONFIG_BACKEND_ALIAS_MAP[alias], metadata.id);
    }
  }
});

test("backend metadata formatters expose current supported backend text", () => {
  assert.equal(formatSupportedBackendValues(), "`cursor-official` / `cursor-legacy` / `claude` / `codex` / `gemini`");
  assert.equal(formatSupportedBackendValuePattern(), "cursor-official|cursor-legacy|claude|codex|gemini");
  assert.equal(formatPreferredBackendShortcuts(), "`cur` / `legacy` / `cc` / `cx` / `gm`");
  assert.equal(formatCompatibleBackendAliases(), "`official`");
  assert.equal(getBackendShortcut("cursor-official"), "cur");
  assert.equal(getBackendShortcut("gemini"), "gm");
});
