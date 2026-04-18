import test from "node:test";
import assert from "node:assert/strict";
import { formatBridgeCommandsHelp } from "./bridge/bridge-commands-help.js";

test("formatBridgeCommandsHelp 含核心命令且随后端区分说明", () => {
  const official = formatBridgeCommandsHelp("cursor-official");
  assert.match(official, /\/commands/);
  assert.ok(official.includes("单独 `/`"));
  assert.match(official, /\/new list/);
  assert.match(official, /\/restart/);
  assert.match(official, /\/update/);
  assert.match(official, /\/whoami/);
  assert.match(official, /-b cur/);
  assert.match(official, /-b cc/);
  assert.match(official, /codex/);
  assert.match(official, /桥接调用 ACP/);
  assert.match(official, /排队消息/);
  assert.doesNotMatch(official, /cursor-tmux/);
});
