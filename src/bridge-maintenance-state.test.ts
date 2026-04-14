import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { BridgeMaintenanceStateStore } from "./bridge/maintenance-state.js";

test("BridgeMaintenanceStateStore 会把 pending restart 在下次启动时转为成功记录", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-maint-"));
  const filePath = path.join(dir, "maintenance.json");
  const store = new BridgeMaintenanceStateStore(filePath);

  await store.load();
  await store.setPendingRestart({
    kind: "restart",
    requestedBy: "user-1",
    requestedAt: 1_710_000_000_000,
    forced: false,
  });

  const reloaded = new BridgeMaintenanceStateStore(filePath);
  await reloaded.load();
  const completed = await reloaded.finalizePendingRestart("服务已重新拉起。");

  assert.equal(completed?.kind, "restart");
  assert.equal(completed?.status, "succeeded");
  assert.equal(reloaded.getPendingRestart(), undefined);
  assert.match(reloaded.getLastTask()?.detail ?? "", /重新拉起/);
});
