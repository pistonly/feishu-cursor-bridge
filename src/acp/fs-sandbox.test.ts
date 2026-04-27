import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertPathInWorkspace,
  readTextFileSafe,
  writeTextFileSafe,
} from "./fs-sandbox.js";

async function makeSymlink(
  target: string,
  linkPath: string,
): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") return false;
    throw e;
  }
}

test("fs sandbox 会拒绝通过 symlink 逃逸工作区", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-fs-sandbox-"));
  const root = path.join(tmp, "root");
  const outside = path.join(tmp, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.txt"), "secret", "utf8");

  const linked = await makeSymlink(outside, path.join(root, "link"));
  if (!linked) return;

  const escapedExisting = path.join(root, "link", "secret.txt");
  assert.throws(
    () => assertPathInWorkspace(root, escapedExisting),
    /拒绝访问工作区外路径/,
  );
  await assert.rejects(
    readTextFileSafe(root, escapedExisting),
    /拒绝访问工作区外路径/,
  );
  await assert.rejects(
    writeTextFileSafe(root, path.join(root, "link", "created.txt"), "x"),
    /拒绝访问工作区外路径/,
  );
});
