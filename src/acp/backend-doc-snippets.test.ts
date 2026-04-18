import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildBackendAliasGuideSnippet,
  buildBackendCommandSyntaxDocSnippet,
  buildReadmeBackendSwitchSnippet,
} from "./backend-metadata.js";

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function extractMarkedBlock(content: string, marker: string): string {
  const start = `<!-- ${marker}:start -->`;
  const end = `<!-- ${marker}:end -->`;
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  assert.notEqual(startIndex, -1, `missing start marker: ${marker}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${marker}`);
  assert.ok(endIndex > startIndex, `invalid marker order: ${marker}`);
  return content.slice(startIndex + start.length, endIndex).trim();
}

test("README backend switch snippets stay aligned with shared metadata", () => {
  const readme = readRepoFile("README.md");
  assert.equal(
    extractMarkedBlock(readme, "backend-readme-switch-en"),
    buildReadmeBackendSwitchSnippet("en"),
  );
  assert.equal(
    extractMarkedBlock(readme, "backend-readme-switch-zh"),
    buildReadmeBackendSwitchSnippet("zh"),
  );
});

test("feishu command backend doc snippets stay aligned with shared metadata", () => {
  const doc = readRepoFile("docs/feishu-commands.md");
  assert.equal(
    extractMarkedBlock(doc, "backend-command-syntax"),
    buildBackendCommandSyntaxDocSnippet(),
  );
  assert.equal(
    extractMarkedBlock(doc, "backend-alias-guide"),
    buildBackendAliasGuideSnippet(),
  );
});
