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
  assert.match(official, /codex/);
  assert.match(official, /桥接调用 ACP/);

  const tmux = formatBridgeCommandsHelp("cursor-tmux");
  assert.match(tmux, /Cursor CLI/);
});
