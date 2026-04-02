import { spawn } from "node:child_process";
import * as path from "node:path";
import {
  delay,
  isCursorAgentBusy,
  isCursorAgentIdle,
  looksLikeCursorAgentUi,
  normalizeSnapshot,
  waitForCursorAgentReady,
} from "./cursor-agent-detector.js";

interface Options {
  paneId?: string;
  sessionName: string;
  cwd: string;
  command?: string;
  prompt?: string;
  pollMs: number;
  historyLines: number;
  stablePolls: number;
  startupWaitMs: number;
  readyTimeoutMs: number;
  maxSeconds: number;
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
    paneId: values.get("--pane") || undefined,
    sessionName: values.get("--session-name") || `cursor-tmux-poc-${Date.now()}`,
    cwd: path.resolve(values.get("--cwd") || process.cwd()),
    command: values.get("--command") || undefined,
    prompt: values.get("--prompt") || undefined,
    pollMs: parsePositiveInt(values.get("--poll-ms"), 800),
    historyLines: parsePositiveInt(values.get("--history-lines"), 200),
    stablePolls: parsePositiveInt(values.get("--stable-polls"), 4),
    startupWaitMs: parsePositiveInt(values.get("--startup-wait-ms"), 2000),
    readyTimeoutMs: parsePositiveInt(values.get("--ready-timeout-ms"), 30000),
    maxSeconds: parsePositiveInt(values.get("--max-seconds"), 120),
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatCommand(args: string[]): string {
  return ["tmux", ...args].join(" ");
}

function runTmux(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("tmux", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trimEnd());
        return;
      }
      reject(
        new Error(
          `${formatCommand(args)} failed with code ${code}: ${stderr.trim() || stdout.trim()}`,
        ),
      );
    });
  });
}

async function createDetachedSession(
  sessionName: string,
  cwd: string,
): Promise<{ sessionName: string; paneId: string }> {
  const output = await runTmux([
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{session_name} #{pane_id}",
    "-s",
    sessionName,
    "-c",
    cwd,
  ]);
  const [createdSessionName, paneId] = output.trim().split(/\s+/, 2);
  if (!createdSessionName || !paneId) {
    throw new Error(`Unexpected tmux new-session output: ${JSON.stringify(output)}`);
  }
  return { sessionName: createdSessionName, paneId };
}

async function sendLiteral(paneId: string, text: string, pressEnter = false): Promise<void> {
  await runTmux(["send-keys", "-t", paneId, "-l", text]);
  if (pressEnter) {
    await runTmux(["send-keys", "-t", paneId, "Enter"]);
  }
}

async function capturePane(paneId: string, historyLines: number): Promise<string> {
  const baseArgs = ["capture-pane", "-p", "-J", "-t", paneId, "-S", `-${historyLines}`];
  try {
    return await runTmux([...baseArgs.slice(0, 2), "-a", ...baseArgs.slice(2)]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("no alternate screen")) {
      throw error;
    }
    return runTmux(baseArgs);
  }
}

function printSnapshot(title: string, content: string): void {
  const banner = "=".repeat(20);
  console.log(`${banner} ${title} ${banner}`);
  console.log(content || "[pane is empty]");
  console.log(`${"=".repeat(20)} end ${"=".repeat(20)}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  let paneId = options.paneId;
  if (!paneId) {
    const created = await createDetachedSession(options.sessionName, options.cwd);
    paneId = created.paneId;
    console.log(`Created tmux session: ${created.sessionName}`);
    console.log(`Created pane: ${paneId}`);
  } else {
    console.log(`Using existing pane: ${paneId}`);
  }

  if (options.command) {
    console.log(`Starting command in pane ${paneId}: ${options.command}`);
    await sendLiteral(paneId, options.command, true);
  }

  if (options.prompt) {
    console.log(`Waiting ${options.startupWaitMs}ms before probing UI readiness`);
    await delay(options.startupWaitMs);
    if (options.command?.includes("cursor agent")) {
      await waitForCursorAgentReady(
        () => capturePane(paneId, options.historyLines),
        {
          pollMs: options.pollMs,
          readyTimeoutMs: options.readyTimeoutMs,
        },
      );
      console.log("Detected Cursor Agent UI is ready.");
    }
    console.log(`Sending prompt to pane ${paneId}`);
    await sendLiteral(paneId, options.prompt, true);
  }

  let previous = "";
  let unchangedPolls = 0;
  let idleStablePolls = 0;
  const deadline = Date.now() + options.maxSeconds * 1000;

  while (Date.now() < deadline) {
    const snapshot = await capturePane(paneId, options.historyLines);
    const normalized = normalizeSnapshot(snapshot);
    const snapshotChanged = snapshot !== previous;
    const busy = isCursorAgentBusy(normalized);
    const idle = isCursorAgentIdle(normalized);

    if (snapshotChanged) {
      const timestamp = new Date().toISOString();
      printSnapshot(`snapshot changed at ${timestamp}`, snapshot);
      previous = snapshot;
      unchangedPolls = 0;
    } else {
      unchangedPolls += 1;
      console.log(
        `No pane change detected (${unchangedPolls}/${options.stablePolls})`,
      );
      if (unchangedPolls >= options.stablePolls) {
        console.log(
          `Pane content stayed unchanged for ${unchangedPolls} polls; treating as tentatively stable.`,
        );
        return;
      }
    }

    if (idle) {
      idleStablePolls += 1;
      console.log(
        `Cursor Agent looks idle (${idleStablePolls}/${options.stablePolls})`,
      );
      if (idleStablePolls >= options.stablePolls) {
        console.log(
          `Cursor Agent UI stayed idle for ${idleStablePolls} polls; treating current turn as completed.`,
        );
        return;
      }
    } else if (busy || looksLikeCursorAgentUi(normalized)) {
      idleStablePolls = 0;
      console.log(
        `Cursor Agent state: ${busy ? "busy" : "ui-ready-but-not-idle"}`,
      );
    }

    await delay(options.pollMs);
  }

  console.log("Reached max observation time without stable pane output.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
