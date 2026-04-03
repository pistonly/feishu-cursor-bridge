import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import {
  CursorAgentTurnDetector,
  decodeControlModeText,
  delay,
  extractSemanticSignals,
  isCursorAgentBusy,
  looksLikeCursorAgentUi,
  normalizeSnapshot,
  summarizeSemanticSignals,
  waitForCursorAgentReady,
  type SemanticSignal,
} from "./cursor-agent-detector.js";

export interface TmuxCursorSessionOptions {
  cwd: string;
  sessionName?: string;
  paneId?: string;
  startCommand?: string;
  cursorCliChatId?: string;
  verbose?: boolean;
  pollMs?: number;
  historyLines?: number;
  stablePolls?: number;
  readyTimeoutMs?: number;
  eventQuietMs?: number;
}

export interface RunPromptResult {
  sessionName: string;
  paneId: string;
  prompt: string;
  finalSnapshot: string;
  replyText: string;
  semanticSignals: SemanticSignal[];
}

export interface RunPromptHooks {
  onSemanticSignals?: (signals: SemanticSignal[]) => void;
  onReplyTextProgress?: (replyText: string) => void;
}

export interface TmuxSessionBinding {
  paneId: string;
  tmuxSessionName: string;
  workspaceRoot: string;
  startCommand: string;
  cursorCliChatId?: string;
}

export interface TmuxBindingProbeResult {
  exists: boolean;
  hasCursorAgentUi: boolean;
  snapshot?: string;
  reason?: string;
}

interface OutputEvent {
  paneId: string;
  text: string;
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

export async function probeTmuxBinding(
  binding: TmuxSessionBinding,
  historyLines = 80,
): Promise<TmuxBindingProbeResult> {
  try {
    const descriptor = await runTmux([
      "display-message",
      "-p",
      "-t",
      binding.paneId,
      "#{pane_id} #{session_name}",
    ]);
    const [paneId, sessionName] = descriptor.trim().split(/\s+/, 2);
    if (paneId !== binding.paneId || sessionName !== binding.tmuxSessionName) {
      return {
        exists: false,
        hasCursorAgentUi: false,
        reason: `pane identity mismatch: expected ${binding.paneId}/${binding.tmuxSessionName}, got ${paneId || "-"} / ${sessionName || "-"}`,
      };
    }
  } catch (error) {
    return {
      exists: false,
      hasCursorAgentUi: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const snapshot = await capturePane(binding.paneId, historyLines);
    const normalized = normalizeSnapshot(snapshot);
    return {
      exists: true,
      hasCursorAgentUi: looksLikeCursorAgentUi(normalized),
      snapshot,
    };
  } catch (error) {
    return {
      exists: true,
      hasCursorAgentUi: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
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

async function createCursorCliChat(cwd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const proc = spawn("cursor", ["agent", "create-chat"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        const id = stdout.trim();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
          const summary = id.replace(/\s+/g, " ").slice(0, 200);
          reject(
            new Error(
              summary
                ? `cursor agent create-chat returned unexpected output: ${summary}`
                : "cursor agent create-chat returned empty output",
            ),
          );
          return;
        }
        resolve(id);
        return;
      }
      reject(
        new Error(
          `cursor agent create-chat failed with code ${code}: ${stderr.trim() || stdout.trim()}`,
        ),
      );
    });
  });
}

function shellEscapeArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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

function isUiNoiseLine(line: string, prompt: string): boolean {
  const trimmed = line.trim();
  const unboxed = trimmed.replace(/^[│\s]+|[│\s]+$/g, "").trim();
  if (!unboxed) return true;
  if (unboxed === prompt.trim()) return true;
  if (unboxed === `→ ${prompt.trim()}`) return true;
  if (/^[│┌┐└┘─\s]+$/.test(trimmed)) return true;
  if (/^Cursor Agent v/i.test(unboxed)) return true;
  if (/^Composer\b/.test(unboxed)) return true;
  if (/^\/ commands\b/.test(unboxed)) return true;
  if (/^Plan, search, build anything$/.test(unboxed)) return true;
  if (/^→\s*Add a follow-up/.test(unboxed)) return true;
  if (/^(Generating|Reading|Thinking|Searching|Globbing|Running|Executing|Applying|Indexing)\b/.test(unboxed)) {
    return true;
  }
  if (/^(Read|Globbed|Searching|Running|Executing|Applying)\b/.test(unboxed)) {
    return true;
  }
  if (/^[⬡⬢]\s/.test(unboxed)) {
    return true;
  }
  return false;
}

function dedupeConsecutive(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (out[out.length - 1] !== line) {
      out.push(line);
    }
  }
  return out;
}

function extractReplyFromSnapshot(snapshot: string, prompt: string): string {
  const lines = snapshot
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""));
  const followUpIdx = lines.findIndex((line) => line.includes("Add a follow-up"));
  const cutoff = followUpIdx >= 0 ? followUpIdx : lines.length;
  const promptIdx = lines.findIndex((line) => line.includes(prompt.trim()));
  const start = promptIdx >= 0 ? promptIdx + 1 : 0;
  const candidates = dedupeConsecutive(
    lines
      .slice(start, cutoff)
      .map((line) => line.trim())
      .filter((line) => !isUiNoiseLine(line, prompt)),
  );
  return candidates.join("\n").trim();
}

function extractReplyProgressFromSnapshot(snapshot: string, prompt: string): string {
  const lines = snapshot
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""));
  const promptIdx = lines.findIndex((line) => line.includes(prompt.trim()));
  if (promptIdx < 0) {
    return "";
  }
  return extractReplyFromSnapshot(snapshot, prompt);
}

function buildReplyText(
  prompt: string,
  semanticSignals: SemanticSignal[],
  finalSnapshot: string,
): string {
  const contentLines = dedupeConsecutive(
    semanticSignals
      .filter((signal) => signal.kind === "content")
      .map((signal) => signal.text.trim())
      .filter((line) => !isUiNoiseLine(line, prompt)),
  );
  if (contentLines.length > 0) {
    return contentLines.join("\n");
  }
  return extractReplyFromSnapshot(finalSnapshot, prompt);
}

function looksLikeCursorAgentExited(snapshot: string): boolean {
  const normalized = normalizeSnapshot(snapshot);
  return (
    /To resume this session: (?:cursor agent|agent) --resume=/i.test(normalized) ||
    /[#$]\s*$/.test(normalized)
  );
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
    child.stderr.on("data", () => {
      // PoC session class keeps stderr quiet; callers can add logging later.
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      const onClose = (code: number | null, signal: NodeJS.Signals | null) =>
        reject(new Error(`tmux control mode exited early code=${code} signal=${signal}`));
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
      if (!line.startsWith("%output ")) continue;
      const match = /^%output\s+(\S+)\s?(.*)$/.exec(line);
      if (!match) continue;
      const paneId = match[1];
      const text = decodeControlModeText(match[2] ?? "");
      for (const listener of this.listeners) {
        listener({ paneId, text });
      }
    }
  }
}

export class TmuxCursorSession {
  private readonly cwd: string;
  private readonly startCommand: string;
  private readonly pollMs: number;
  private readonly historyLines: number;
  private readonly stablePolls: number;
  private readonly readyTimeoutMs: number;
  private readonly eventQuietMs: number;
  private readonly verbose: boolean;

  private sessionName: string;
  private paneId?: string;
  private cursorCliChatId?: string;
  private ownsSession = false;
  private started = false;
  private observer: TmuxControlModeObserver | null = null;
  private turnInFlight = false;
  private cancelRequested = false;

  constructor(options: TmuxCursorSessionOptions) {
    this.cwd = path.resolve(options.cwd);
    this.sessionName = options.sessionName || `cursor-tmux-session-${Date.now()}`;
    this.paneId = options.paneId;
    this.cursorCliChatId = options.cursorCliChatId?.trim() || undefined;
    this.startCommand = options.startCommand || "cursor agent";
    this.verbose = options.verbose ?? true;
    this.pollMs = options.pollMs ?? 1000;
    this.historyLines = options.historyLines ?? 160;
    this.stablePolls = options.stablePolls ?? 2;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 30000;
    this.eventQuietMs = options.eventQuietMs ?? 2000;
  }

  getPaneId(): string {
    if (!this.paneId) {
      throw new Error("tmux pane is not initialized");
    }
    return this.paneId;
  }

  getSessionName(): string {
    return this.sessionName;
  }

  getCursorCliChatId(): string | undefined {
    return this.cursorCliChatId;
  }

  describeBinding(): TmuxSessionBinding {
    return {
      paneId: this.getPaneId(),
      tmuxSessionName: this.sessionName,
      workspaceRoot: this.cwd,
      startCommand: this.startCommand,
      ...(this.cursorCliChatId ? { cursorCliChatId: this.cursorCliChatId } : {}),
    };
  }

  async startAgent(): Promise<void> {
    await this.attach();
  }

  async runPrompt(
    prompt: string,
    maxSeconds = 90,
    hooks?: RunPromptHooks,
  ): Promise<RunPromptResult> {
    await this.startAgent();
    if (this.turnInFlight) {
      throw new Error("A prompt is already running in this tmux session.");
    }
    this.turnInFlight = true;
    this.cancelRequested = false;

    const semanticSignals: SemanticSignal[] = [];
    const turnDetector = new CursorAgentTurnDetector({
      stablePolls: this.stablePolls,
      eventQuietMs: this.eventQuietMs,
    });

    let lastSummary = "";
    const unsubscribe = this.observer!.onOutput((event) => {
      if (event.paneId !== this.getPaneId()) return;
      const signals = extractSemanticSignals(event.text);
      if (signals.length > 0) {
        semanticSignals.push(...signals);
        turnDetector.noteSemanticSignals(signals);
        hooks?.onSemanticSignals?.(signals);
        const summary = summarizeSemanticSignals(signals);
        if (summary && summary !== lastSummary) {
          lastSummary = summary;
          if (this.verbose) {
            console.log(`[session semantic] ${summary}`);
          }
        }
      } else {
        turnDetector.noteRawOutput();
      }
    });

    try {
      await sendLiteral(this.getPaneId(), prompt, true);
      const deadline = Date.now() + maxSeconds * 1000;
      let finalSnapshot = "";
      let lastReplyProgress = "";
      while (Date.now() < deadline) {
        finalSnapshot = await capturePane(this.getPaneId(), this.historyLines);
        const replyProgress = extractReplyProgressFromSnapshot(finalSnapshot, prompt);
        if (replyProgress && replyProgress !== lastReplyProgress) {
          lastReplyProgress = replyProgress;
          turnDetector.noteReplyProgress();
          hooks?.onReplyTextProgress?.(replyProgress);
        }
        const evaluation = turnDetector.evaluateSnapshot(finalSnapshot);
        if (
          this.cancelRequested &&
          ((looksLikeCursorAgentUi(normalizeSnapshot(finalSnapshot)) &&
            !isCursorAgentBusy(normalizeSnapshot(finalSnapshot))) ||
            looksLikeCursorAgentExited(finalSnapshot))
        ) {
          throw new Error("Cursor Agent turn was cancelled.");
        }
        if (this.verbose) {
          console.log(
            `[session turn] uiState=${evaluation.uiState} idleStable=${evaluation.idleStablePolls} quietForMs=${evaluation.quietForMs} semanticQuietForMs=${evaluation.semanticQuietForMs} busyQuietForMs=${evaluation.busyQuietForMs}`,
          );
        }
        if (evaluation.shouldComplete) {
          return {
            sessionName: this.sessionName,
            paneId: this.getPaneId(),
            prompt,
            finalSnapshot,
            replyText: buildReplyText(prompt, semanticSignals, finalSnapshot),
            semanticSignals,
          };
        }
        await delay(this.pollMs);
      }
      throw new Error("Timed out waiting for Cursor Agent turn completion.");
    } finally {
      this.turnInFlight = false;
      unsubscribe();
    }
  }

  async attach(): Promise<void> {
    await this.ensurePane();
    await this.ensureObserver();
    const currentSnapshot = await capturePane(this.getPaneId(), this.historyLines);
    if (looksLikeCursorAgentUi(normalizeSnapshot(currentSnapshot))) {
      this.started = true;
      return;
    }
    await this.ensureCursorCliChatId();
    await sendLiteral(this.getPaneId(), this.composeLaunchCommand(), true);
    await waitForCursorAgentReady(
      () => capturePane(this.getPaneId(), this.historyLines),
      {
        pollMs: this.pollMs,
        readyTimeoutMs: this.readyTimeoutMs,
      },
    );
    this.started = true;
  }

  async captureCurrentSnapshot(): Promise<string> {
    await this.ensurePane();
    return capturePane(this.getPaneId(), this.historyLines);
  }

  async cancelCurrentTurn(timeoutMs = 15000): Promise<string> {
    await this.startAgent();
    if (!this.turnInFlight) {
      return this.captureCurrentSnapshot();
    }
    this.cancelRequested = true;
    await runTmux(["send-keys", "-t", this.getPaneId(), "C-c"]);
    const deadline = Date.now() + timeoutMs;
    let lastSnapshot = "";
    let resentCtrlC = false;
    while (Date.now() < deadline) {
      lastSnapshot = await capturePane(this.getPaneId(), this.historyLines);
      const normalized = normalizeSnapshot(lastSnapshot);
      if (
        (looksLikeCursorAgentUi(normalized) && !isCursorAgentBusy(normalized)) ||
        looksLikeCursorAgentExited(lastSnapshot)
      ) {
        this.turnInFlight = false;
        return lastSnapshot;
      }
      if (
        !resentCtrlC &&
        /Press Ctrl\+C again to exit/i.test(normalized)
      ) {
        await runTmux(["send-keys", "-t", this.getPaneId(), "C-c"]);
        resentCtrlC = true;
      }
      await delay(this.pollMs);
    }
    throw new Error("Timed out waiting for Cursor Agent turn cancellation.");
  }

  async close(): Promise<void> {
    await this.stop();
    if (!this.paneId) return;
    try {
      if (this.ownsSession) {
        await runTmux(["kill-session", "-t", this.sessionName]);
      } else {
        await runTmux(["kill-pane", "-t", this.paneId]);
      }
    } catch {
      // ignore
    } finally {
      this.ownsSession = false;
      this.started = false;
      this.turnInFlight = false;
      this.cancelRequested = false;
      this.paneId = undefined;
    }
  }

  async stop(): Promise<void> {
    if (this.observer) {
      await this.observer.stop();
      this.observer = null;
    }
  }

  async destroy(): Promise<void> {
    await this.close();
  }

  private async ensurePane(): Promise<void> {
    if (this.paneId) {
      this.sessionName = await resolveSessionNameForPane(this.paneId);
      return;
    }
    const created = await createDetachedSession(this.sessionName, this.cwd);
    this.sessionName = created.sessionName;
    this.paneId = created.paneId;
    this.ownsSession = true;
  }

  private async ensureObserver(): Promise<void> {
    if (this.observer) return;
    const observer = new TmuxControlModeObserver(this.sessionName);
    await observer.start();
    this.observer = observer;
  }

  private async ensureCursorCliChatId(): Promise<void> {
    if (!this.usesDefaultCursorAgentCommand()) {
      return;
    }
    if (!this.cursorCliChatId) {
      try {
        this.cursorCliChatId = await createCursorCliChat(this.cwd);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[tmux-session] create-chat unavailable, falling back to plain cursor agent startup: ${message}`,
        );
      }
    }
  }

  private usesDefaultCursorAgentCommand(): boolean {
    return this.startCommand.trim() === "cursor agent";
  }

  private composeLaunchCommand(): string {
    if (!this.usesDefaultCursorAgentCommand()) {
      return this.startCommand;
    }
    if (!this.cursorCliChatId) {
      return this.startCommand;
    }
    return `${this.startCommand} --resume ${shellEscapeArg(this.cursorCliChatId)}`;
  }
}
