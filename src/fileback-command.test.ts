import test from "node:test";
import assert from "node:assert/strict";
import {
  parseFilebackUserMessage,
  wrapFilebackPromptForAgent,
} from "./fileback-command.js";

test("parseFilebackUserMessage 非命令", () => {
  assert.equal(parseFilebackUserMessage("hello").kind, "not-fileback");
  assert.equal(parseFilebackUserMessage("/new 1").kind, "not-fileback");
});

test("parseFilebackUserMessage 全角斜杠与大小写", () => {
  const a = parseFilebackUserMessage("／fileback 生成 report.txt");
  assert.equal(a.kind, "prompt");
  if (a.kind === "prompt") {
    assert.equal(a.inner, "生成 report.txt");
  }
  const b = parseFilebackUserMessage("/FILEBACK x");
  assert.equal(b.kind, "prompt");
  if (b.kind === "prompt") assert.equal(b.inner, "x");
});

test("parseFilebackUserMessage 无正文则 usage", () => {
  assert.equal(parseFilebackUserMessage("/fileback").kind, "usage");
  assert.equal(parseFilebackUserMessage("/fileback  ").kind, "usage");
  assert.equal(parseFilebackUserMessage("  /fileback\t").kind, "usage");
});

test("parseFilebackUserMessage 保留多行正文", () => {
  const p = parseFilebackUserMessage("/fileback line1\nline2");
  assert.equal(p.kind, "prompt");
  if (p.kind === "prompt") {
    assert.equal(p.inner, "line1\nline2");
  }
});

test("wrapFilebackPromptForAgent 含 FEISHU_SEND_FILE 说明与分隔", () => {
  const w = wrapFilebackPromptForAgent("请创建 a.txt");
  assert.match(w, /FEISHU_SEND_FILE:/);
  assert.match(w, /请创建 a\.txt$/);
});
