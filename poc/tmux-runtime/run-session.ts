import * as path from "node:path";
import { TmuxCursorSession } from "./tmux-cursor-session.js";

interface Options {
  cwd: string;
  prompt: string;
  sessionName?: string;
  paneId?: string;
  maxSeconds: number;
  keepSession: boolean;
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

  const prompt = values.get("--prompt")?.trim();
  if (!prompt) {
    throw new Error("Missing required --prompt");
  }

  return {
    cwd: path.resolve(values.get("--cwd") || process.cwd()),
    prompt,
    sessionName: values.get("--session-name") || undefined,
    paneId: values.get("--pane") || undefined,
    maxSeconds: parsePositiveInt(values.get("--max-seconds"), 90),
    keepSession: values.get("--keep-session") === "true",
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const session = new TmuxCursorSession({
    cwd: options.cwd,
    sessionName: options.sessionName,
    paneId: options.paneId,
  });

  try {
    await session.startAgent();
    console.log(`tmux session: ${session.getSessionName()}`);
    console.log(`tmux pane: ${session.getPaneId()}`);
    console.log(`cursor chat id: ${session.getCursorCliChatId() ?? "-"}`);

    const result = await session.runPrompt(options.prompt, options.maxSeconds);
    console.log("===== replyText =====");
    console.log(result.replyText || "[empty]");
    console.log("===== end =====");
  } finally {
    if (options.keepSession) {
      await session.stop();
    } else {
      await session.destroy();
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
