import assert from "node:assert/strict";
import test from "node:test";
import { formatJsonRpcLikeError } from "./utils/format-json-rpc-error.js";

test("formatJsonRpcLikeError formats circular plain objects without [object Object]", () => {
  const err: Record<string, unknown> = {
    detail: "boom",
  };
  err["self"] = err;

  const text = formatJsonRpcLikeError(err);

  assert.doesNotMatch(text, /\[object Object\]/);
  assert.match(text, /detail/);
});
