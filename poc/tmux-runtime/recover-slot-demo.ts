import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  TmuxCursorSession,
  probeTmuxBinding,
  type TmuxSessionBinding,
} from "./tmux-cursor-session.js";
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
        path.join(process.cwd(), "poc/tmux-runtime/.tmp-recover-slot-store.json"),
    ),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const identity = {
    chatId: "recover-chat",
    userId: "recover-user",
    chatType: "p2p" as const,
  };

  const store = new TmuxSlotStore(options.storePath);
  const registry = new TmuxSlotRegistry(store);
  await registry.load();

  const first = new TmuxCursorSession({
    cwd: options.cwd,
    sessionName: "tmux-recover-slot-demo",
  });

  try {
    await first.startAgent();
    const firstResult = await first.runPrompt("只回复RECOVER-ONE", 90);
    console.log(`first reply: ${firstResult.replyText}`);

    await registry.bindActiveSlot(identity, first.describeBinding());
    const staleBinding = first.describeBinding();
    console.log(
      `persisted binding: pane=${staleBinding.paneId} session=${staleBinding.tmuxSessionName}`,
    );

    await first.destroy();
    console.log("destroyed original tmux session to simulate stale pane");

    const restored = await registry.restoreActiveSlot(identity, {
      probeBinding: async (binding) => {
        return probeTmuxBinding(binding as TmuxSessionBinding);
      },
      rebuildBinding: async (stale) => {
        const rebuilt = new TmuxCursorSession({
          cwd: stale.workspaceRoot,
          startCommand: stale.startCommand,
          cursorCliChatId: stale.cursorCliChatId,
        });
        await rebuilt.startAgent();
        const binding = rebuilt.describeBinding();
        await rebuilt.stop();
        return binding;
      },
    });

    console.log(
      `restore result: rebuilt=${restored.rebuilt} previousPane=${restored.previousPaneId ?? "-"} nextPane=${restored.slot.paneId}`,
    );

    const second = new TmuxCursorSession({
      cwd: restored.slot.workspaceRoot,
      paneId: restored.slot.paneId,
      sessionName: restored.slot.tmuxSessionName,
      startCommand: restored.slot.startCommand,
      cursorCliChatId: restored.slot.cursorCliChatId,
    });
    try {
      const secondResult = await second.runPrompt("只回复RECOVER-TWO", 90);
      console.log(`second reply: ${secondResult.replyText}`);
    } finally {
      await second.destroy();
    }
  } finally {
    await fs.rm(options.storePath, { force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
