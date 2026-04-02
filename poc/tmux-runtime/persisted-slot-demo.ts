import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TmuxCursorSession } from "./tmux-cursor-session.js";
import { TmuxSlotRegistry } from "./tmux-slot-registry.js";
import { TmuxSlotStore } from "./tmux-slot-store.js";

interface Options {
  cwd: string;
  storePath: string;
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      values.set(arg, "true");
      continue;
    }
    values.set(arg, next);
    i += 1;
  }

  return {
    cwd: path.resolve(values.get("--cwd") || process.cwd()),
    storePath: path.resolve(
      values.get("--store-path") ||
        path.join(process.cwd(), "poc/tmux-runtime/.tmp-slot-store.json"),
    ),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const identity = {
    chatId: "demo-chat",
    userId: "demo-user",
    chatType: "p2p" as const,
  };

  const store = new TmuxSlotStore(options.storePath);
  const registry = new TmuxSlotRegistry(store);
  await registry.load();

  const first = new TmuxCursorSession({
    cwd: options.cwd,
    sessionName: "tmux-persisted-slot-demo",
  });

  try {
    await first.startAgent();
    const firstResult = await first.runPrompt("只回复PERSIST-ONE", 90);
    console.log(`first reply: ${firstResult.replyText}`);

    await registry.bindActiveSlot(identity, first.describeBinding());
    console.log(`persisted active binding to ${options.storePath}`);

    const reloadedStore = new TmuxSlotStore(options.storePath);
    const reloadedRegistry = new TmuxSlotRegistry(reloadedStore);
    await reloadedRegistry.load();
    const active = reloadedRegistry.getActiveSlot(identity);
    if (!active) {
      throw new Error("Failed to reload persisted active slot.");
    }
    console.log(
      `reloaded binding: pane=${active.paneId} session=${active.tmuxSessionName}`,
    );

    const second = new TmuxCursorSession({
      cwd: active.workspaceRoot,
      paneId: active.paneId,
      sessionName: active.tmuxSessionName,
      startCommand: active.startCommand,
      cursorCliChatId: active.cursorCliChatId,
    });
    try {
      const secondResult = await second.runPrompt("只回复PERSIST-TWO", 90);
      console.log(`second reply: ${secondResult.replyText}`);
      await reloadedRegistry.touchActiveSlot(identity);
    } finally {
      await second.stop();
    }
  } finally {
    await first.destroy();
    await fs.rm(options.storePath, { force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
