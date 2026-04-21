import test from "node:test";
import assert from "node:assert/strict";
import {
  formatSupportedBackendValuePattern,
  getBackendShortcut,
} from "./acp/backend-metadata.js";
import { formatBridgeCommandsHelp } from "./bridge/bridge-commands-help.js";

test("formatBridgeCommandsHelp 含核心命令且随后端区分说明", () => {
  const official = formatBridgeCommandsHelp("cursor-official");
  assert.match(official, /\/commands/);
  assert.ok(official.includes("单独 `/`"));
  assert.match(official, /\/new list/);
  assert.match(official, /\/restart/);
  assert.match(official, /\/update/);
  assert.match(official, /\/whoami/);
  assert.match(official, /\/resume 0/);
  assert.match(official, /\/resume <序号或sessionId>/);
  assert.match(official, /!<shell 命令>/);
  assert.match(official, new RegExp(`--backend <${formatSupportedBackendValuePattern()}>`));
  assert.match(official, new RegExp(`-b ${getBackendShortcut("cursor-official")}`));
  assert.match(official, new RegExp(`-b ${getBackendShortcut("claude")}`));
  assert.match(official, /codex/);
  assert.match(official, /桥接调用 ACP/);
  assert.match(official, /排队消息/);
  assert.doesNotMatch(official, /cursor-tmux/);
});
