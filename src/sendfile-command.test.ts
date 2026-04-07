import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSendfileUserMessage,
  wrapSendfilePromptForAgent,
} from "./sendfile-command.js";

test("parseSendfileUserMessage 非命令", () => {
  assert.equal(parseSendfileUserMessage("hello").kind, "not-sendfile");
  assert.equal(parseSendfileUserMessage("/new 1").kind, "not-sendfile");
});

test("parseSendfileUserMessage 全角斜杠与大小写", () => {
  const a = parseSendfileUserMessage("／sendfile 生成 report.txt");
  assert.equal(a.kind, "prompt");
  if (a.kind === "prompt") {
    assert.equal(a.inner, "生成 report.txt");
  }
  const b = parseSendfileUserMessage("/SENDFILE x");
  assert.equal(b.kind, "prompt");
  if (b.kind === "prompt") assert.equal(b.inner, "x");
});

test("parseSendfileUserMessage 无正文则 usage", () => {
  assert.equal(parseSendfileUserMessage("/sendfile").kind, "usage");
  assert.equal(parseSendfileUserMessage("/sendfile  ").kind, "usage");
  assert.equal(parseSendfileUserMessage("  /sendfile\t").kind, "usage");
});

test("parseSendfileUserMessage 保留多行正文", () => {
  const p = parseSendfileUserMessage("/sendfile line1\nline2");
  assert.equal(p.kind, "prompt");
  if (p.kind === "prompt") {
    assert.equal(p.inner, "line1\nline2");
  }
});

test("wrapSendfilePromptForAgent 含 FEISHU_SEND_FILE 说明与分隔", () => {
  const w = wrapSendfilePromptForAgent("请创建 a.txt");
  assert.match(w, /FEISHU_SEND_FILE:/);
  assert.match(w, /请创建 a\.txt$/);
});
