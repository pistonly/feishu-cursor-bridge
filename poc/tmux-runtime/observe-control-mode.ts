import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import {
  CursorAgentTurnDetector,
  decodeControlModeText,
  delay,
  extractSemanticSignals,
  isCursorAgentBusy,
  isCursorAgentIdle,
  looksLikeCursorAgentUi,
  normalizeSnapshot,
  summarizeSemanticSignals,
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
  eventQuietMs: number;
  maxSeconds: number;
}

interface OutputEvent {
  paneId: string;
  text: string;
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
    sessionName: values.get("--session-name") || `cursor-tmux-control-${Date.now()}`,
    cwd: path.resolve(values.get("--cwd") || process.cwd()),
    command: values.get("--command") || undefined,
    prompt: values.get("--prompt") || undefined,
    pollMs: parsePositiveInt(values.get("--poll-ms"), 800),
    historyLines: parsePositiveInt(values.get("--history-lines"), 200),
    stablePolls: parsePositiveInt(values.get("--stable-polls"), 3),
    startupWaitMs: parsePositiveInt(values.get("--startup-wait-ms"), 1500),
    readyTimeoutMs: parsePositiveInt(values.get("--ready-timeout-ms"), 30000),
    eventQuietMs: parsePositiveInt(values.get("--event-quiet-ms"), 2000),
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

async function resolveSessionNameForPane(paneId: string): Promise<string> {
  const sessionName = await runTmux(["display-message", "-p", "-t", paneId, "#{session_name}"]);
  const normalized = sessionName.trim();
  if (!normalized) {
    throw new Error(`Failed to resolve session name for pane ${paneId}`);
  }
  return normalized;
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

function summarizeRawEventText(text: string): string {
  return text
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\x1b/g, "\\x1b")
    .slice(0, 160);
}

class TmuxControlModeObserver {
  private readonly sessionName: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly listeners = new Set<(event: OutputEvent) => void>();
  private lineBuffer = "";

  constructor(sessionName: string) {
    this.sessionName = sessionName;
  }

  onOutput(listener: (event: OutputEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    if (this.child) {
      throw new Error("Control mode observer already started");
    }
    const child = spawn("tmux", ["-C", "attach-session", "-t", this.sessionName], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.child = child;

    child.stdout.on("data", (chunk) => {
      this.consumeStdout(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) {
        console.warn(`[control-mode stderr] ${text}`);
      }
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        reject(error);
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        reject(new Error(`tmux control mode exited early code=${code} signal=${signal}`));
      };
      child.once("error", onError);
      child.once("close", onClose);
      const timeout = setTimeout(() => {
        child.off("error", onError);
        child.off("close", onClose);
        resolve();
      }, 300);
      child.once("spawn", () => {
        clearTimeout(timeout);
        child.off("error", onError);
        child.off("close", onClose);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.stdin.end();
    child.kill();
    await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      setTimeout(resolve, 500);
    });
  }

  private consumeStdout(chunk: string): void {
    this.lineBuffer += chunk;
    const parts = this.lineBuffer.split(/\r?\n/);
    this.lineBuffer = parts.pop() ?? "";
    for (const line of parts) {
      this.consumeLine(line);
    }
  }

  private consumeLine(line: string): void {
    if (line.startsWith("%output ")) {
      const match = /^%output\s+(\S+)\s?(.*)$/.exec(line);
      if (!match) return;
      const paneId = match[1];
      const text = decodeControlModeText(match[2] ?? "");
      for (const listener of this.listeners) {
        listener({ paneId, text });
      }
      return;
    }
    if (line.startsWith("%exit")) {
      console.log(`[control-mode] ${line}`);
      return;
    }
    if (line.startsWith("%")) {
      console.log(`[control-mode] ${line}`);
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  let paneId = options.paneId;
  let sessionName = options.sessionName;
  if (!paneId) {
    const created = await createDetachedSession(sessionName, options.cwd);
    paneId = created.paneId;
    sessionName = created.sessionName;
    console.log(`Created tmux session: ${sessionName}`);
    console.log(`Created pane: ${paneId}`);
  } else {
    sessionName = await resolveSessionNameForPane(paneId);
    console.log(`Using existing pane: ${paneId}`);
    console.log(`Resolved tmux session: ${sessionName}`);
  }

  const observer = new TmuxControlModeObserver(sessionName);
  const turnDetector = new CursorAgentTurnDetector({
    stablePolls: options.stablePolls,
    eventQuietMs: options.eventQuietMs,
  });
  let outputEvents = 0;
  let lastMeaningfulSummary = "";
  const unsubscribe = observer.onOutput((event) => {
    if (event.paneId !== paneId) {
      return;
    }
    outputEvents += 1;
    const signals = extractSemanticSignals(event.text);
    if (signals.length > 0) {
      turnDetector.noteSemanticSignals(signals);
    } else {
      turnDetector.noteRawOutput();
    }
    const summary = summarizeSemanticSignals(signals);
    if (summary) {
      if (summary !== lastMeaningfulSummary) {
        lastMeaningfulSummary = summary;
        console.log(`[pane-output ${outputEvents}] ${summary}`);
      }
      return;
    }
    if (outputEvents <= 12) {
      const rawSummary = summarizeRawEventText(event.text);
      if (rawSummary) {
        console.log(`[pane-output-raw ${outputEvents}] ${rawSummary}`);
      }
    }
  });

  await observer.start();
  console.log(`Attached control mode to session: ${sessionName}`);

  try {
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
      const evaluation = turnDetector.evaluateSnapshot(snapshot);

      if (snapshotChanged) {
        const timestamp = new Date().toISOString();
        printSnapshot(`snapshot changed at ${timestamp}`, snapshot);
        previous = snapshot;
        unchangedPolls = 0;
      } else {
        unchangedPolls += 1;
        console.log(`No pane change detected (${unchangedPolls}/${options.stablePolls})`);
      }

      if (evaluation.uiState === "idle") {
        idleStablePolls = evaluation.idleStablePolls;
        console.log(
          `Cursor Agent looks idle (${idleStablePolls}/${options.stablePolls}), quietForMs=${evaluation.quietForMs}, semanticQuietForMs=${evaluation.semanticQuietForMs}, busyQuietForMs=${evaluation.busyQuietForMs}`,
        );
        if (evaluation.shouldComplete) {
          console.log(
            `Cursor Agent UI stayed idle and control-mode output stayed quiet for ${evaluation.quietForMs}ms; semanticQuietForMs=${evaluation.semanticQuietForMs}; treating current turn as completed.`,
          );
          return;
        }
      } else if (
        evaluation.uiState === "busy" ||
        evaluation.uiState === "ui-ready-but-not-idle"
      ) {
        idleStablePolls = 0;
        console.log(
          `Cursor Agent state: ${evaluation.uiState === "busy" ? "busy" : "ui-ready-but-not-idle"}, quietForMs=${evaluation.quietForMs}, semanticQuietForMs=${evaluation.semanticQuietForMs}, busyQuietForMs=${evaluation.busyQuietForMs}`,
        );
      } else if (isCursorAgentBusy(normalized) || looksLikeCursorAgentUi(normalized)) {
        console.log("Cursor Agent state changed but detector returned unknown.");
      }

      await delay(options.pollMs);
    }

    console.log("Reached max observation time without stable completion signal.");
  } finally {
    unsubscribe();
    await observer.stop();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
