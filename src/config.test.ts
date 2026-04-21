import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import test from "node:test";
import { loadConfig } from "./config/index.js";

test("loadConfig 默认开启 bridge bang command", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-config-"));
  const originalAppId = process.env["FEISHU_APP_ID"];
  const originalAppSecret = process.env["FEISHU_APP_SECRET"];
  const originalAllowlist = process.env["BRIDGE_WORK_ALLOWLIST"];
  const originalBang = process.env["BRIDGE_ENABLE_BANG_COMMAND"];

  process.env["FEISHU_APP_ID"] = "app-id";
  process.env["FEISHU_APP_SECRET"] = "app-secret";
  process.env["BRIDGE_WORK_ALLOWLIST"] = tmpRoot;
  delete process.env["BRIDGE_ENABLE_BANG_COMMAND"];

  try {
    const config = loadConfig();
    assert.equal(config.bridge.enableBangCommand, true);
  } finally {
    if (originalAppId === undefined) delete process.env["FEISHU_APP_ID"];
    else process.env["FEISHU_APP_ID"] = originalAppId;
    if (originalAppSecret === undefined) delete process.env["FEISHU_APP_SECRET"];
    else process.env["FEISHU_APP_SECRET"] = originalAppSecret;
    if (originalAllowlist === undefined) delete process.env["BRIDGE_WORK_ALLOWLIST"];
    else process.env["BRIDGE_WORK_ALLOWLIST"] = originalAllowlist;
    if (originalBang === undefined) delete process.env["BRIDGE_ENABLE_BANG_COMMAND"];
    else process.env["BRIDGE_ENABLE_BANG_COMMAND"] = originalBang;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
