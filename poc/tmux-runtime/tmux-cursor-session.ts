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
  windowId?: string;
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
  paneId?: string;
  tmuxSessionName: string;
  tmuxWindowId?: string;
  workspaceRoot: string;
  startCommand: string;
  cursorCliChatId?: string;
}

export interface TmuxBindingProbeResult {
  exists: boolean;
  hasCursorAgentUi: boolean;
  snapshot?: string;
  reason?: string;
  resolvedBinding?: {
    paneId: string;
    tmuxSessionName: string;
    tmuxWindowId: string;
  };
}

interface OutputEvent {
  paneId: string;
  text: string;
}

interface ResolvedTmuxTarget {
  paneId: string;
  tmuxSessionName: string;
  tmuxWindowId: string;
}

const DEFAULT_SHARED_TMUX_SESSION_NAME = "feishu-cursor";

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
  const targets = [binding.paneId, binding.tmuxWindowId].filter(
    (value, index, all): value is string => !!value && all.indexOf(value) === index,
  );
  let lastReason = "no pane/window target provided";
  let resolved: ResolvedTmuxTarget | undefined;

  for (const target of targets) {
    try {
      const candidate = await resolveTmuxTarget(target);
      if (candidate.tmuxSessionName !== binding.tmuxSessionName) {
        lastReason =
          `target ${target} session mismatch: expected ${binding.tmuxSessionName}, ` +
          `got ${candidate.tmuxSessionName}`;
        continue;
      }
      if (binding.tmuxWindowId && candidate.tmuxWindowId !== binding.tmuxWindowId) {
        lastReason =
          `target ${target} window mismatch: expected ${binding.tmuxWindowId}, ` +
          `got ${candidate.tmuxWindowId}`;
        continue;
      }
      resolved = candidate;
      break;
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
  }

  if (!resolved) {
    return {
      exists: false,
      hasCursorAgentUi: false,
      reason: lastReason,
    };
  }

  try {
    const snapshot = await capturePane(resolved.paneId, historyLines);
    const normalized = normalizeSnapshot(snapshot);
    return {
      exists: true,
      hasCursorAgentUi: looksLikeCursorAgentUi(normalized),
      snapshot,
      resolvedBinding: resolved,
    };
  } catch (error) {
    return {
      exists: true,
      hasCursorAgentUi: false,
      reason: error instanceof Error ? error.message : String(error),
      resolvedBinding: resolved,
    };
  }
}

async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  try {
    await runTmux(["has-session", "-t", sessionName]);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/can't find session/i.test(message) || /no server running/i.test(message)) {
      return false;
    }
    throw error;
  }
}

async function createDetachedWindow(
  sessionName: string,
  cwd: string,
): Promise<ResolvedTmuxTarget> {
  const output = (await tmuxSessionExists(sessionName))
    ? await runTmux([
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{session_name} #{window_id} #{pane_id}",
        "-t",
        sessionName,
        "-c",
        cwd,
      ])
    : await runTmux([
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{session_name} #{window_id} #{pane_id}",
        "-s",
        sessionName,
        "-c",
        cwd,
      ]);
  const [createdSessionName, windowId, paneId] = output.trim().split(/\s+/, 3);
  if (!createdSessionName || !windowId || !paneId) {
    throw new Error(`Unexpected tmux new-session output: ${JSON.stringify(output)}`);
  }
  return {
    paneId,
    tmuxSessionName: createdSessionName,
    tmuxWindowId: windowId,
  };
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

async function resolveTmuxTarget(target: string): Promise<ResolvedTmuxTarget> {
  const descriptor = await runTmux([
    "display-message",
    "-p",
    "-t",
    target,
    "#{session_name} #{window_id} #{pane_id}",
  ]);
  const [tmuxSessionName, tmuxWindowId, paneId] = descriptor.trim().split(/\s+/, 3);
  if (!tmuxSessionName || !tmuxWindowId || !paneId) {
    throw new Error(`Failed to resolve tmux binding for target ${target}`);
  }
  return { paneId, tmuxSessionName, tmuxWindowId };
}

async function sendLiteral(paneId: string, text: string, pressEnter = false): Promise<void> {
  await runTmux(["send-keys", "-t", paneId, "-l", text]);
  if (pressEnter) {
    await runTmux(["send-keys", "-t", paneId, "Enter"]);
  }
}

async function capturePane(paneId: string, historyLines: number): Promise<string> {
  // 不用 -J：保留 tmux 屏幕上实际可见的换行，而不是把软换行内容拼回一行。
  const baseArgs = ["capture-pane", "-p", "-t", paneId, "-S", `-${historyLines}`];
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

function unwrapUiLine(line: string): string {
  return line.replace(/\s+$/g, "").replace(/^│ ?/, "").replace(/ ?│$/, "");
}

function isUiNoiseLine(line: string, prompt: string): boolean {
  const trimmed = line.trim();
  const unboxed = unwrapUiLine(line).trim();
  if (!unboxed && /^[│┌┐└┘─\s]*$/.test(trimmed)) return true;
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

function compactReplyLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const isBlank = line.trim().length === 0;
    if (isBlank) {
      if (out.length === 0 || out[out.length - 1] === "") {
        continue;
      }
      out.push("");
      continue;
    }
    out.push(line);
  }
  while (out[0] === "") {
    out.shift();
  }
  while (out[out.length - 1] === "") {
    out.pop();
  }
  return out;
}

function findPromptEndIndex(lines: string[], prompt: string): number {
  const normalizedPrompt = prompt.replace(/\s+/g, " ").trim();
  if (!normalizedPrompt) {
    return -1;
  }
  for (let start = 0; start < lines.length; start += 1) {
    let merged = "";
    for (let end = start; end < Math.min(lines.length, start + 12); end += 1) {
      const segment = lines[end].trim();
      if (segment) {
        merged = `${merged} ${segment}`.trim().replace(/\s+/g, " ");
      }
      if (merged.includes(normalizedPrompt)) {
        return end;
      }
      if (merged.length > normalizedPrompt.length + 200) {
        break;
      }
    }
  }
  return -1;
}

function extractReplyFromSnapshot(snapshot: string, prompt: string): string {
  const lines = snapshot.split("\n").map((line) => unwrapUiLine(line));
  const followUpIdx = lines.findIndex((line) => line.includes("Add a follow-up"));
  const cutoff = followUpIdx >= 0 ? followUpIdx : lines.length;
  const promptEndIdx = findPromptEndIndex(lines, prompt);
  const start = promptEndIdx >= 0 ? promptEndIdx + 1 : 0;
  const candidates = compactReplyLines(
    dedupeConsecutive(
      lines
        .slice(start, cutoff)
        .filter((line) => {
          if (!line.trim()) return true;
          return !isUiNoiseLine(line, prompt);
        }),
    ),
  );
  return candidates.join("\n");
}

function extractReplyProgressFromSnapshot(snapshot: string, prompt: string): string {
  const lines = snapshot
    .split("\n")
    .map((line) => unwrapUiLine(line));
  if (findPromptEndIndex(lines, prompt) < 0) {
    return "";
  }
  return extractReplyFromSnapshot(snapshot, prompt);
}

function buildReplyText(
  prompt: string,
  semanticSignals: SemanticSignal[],
  finalSnapshot: string,
): string {
  const snapshotReply = extractReplyFromSnapshot(finalSnapshot, prompt);
  if (snapshotReply) {
    return snapshotReply;
  }
  const fallbackLines = compactReplyLines(
    dedupeConsecutive(
      semanticSignals
        .filter((signal) => signal.kind === "content")
        .map((signal) => signal.text.trimEnd())
        .filter((line) => !isUiNoiseLine(line, prompt)),
    ),
  );
  if (fallbackLines.length > 0) {
    return fallbackLines.join("\n");
  }
  return "";
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
  private windowId?: string;
  private paneId?: string;
  private cursorCliChatId?: string;
  private started = false;
  private observer: TmuxControlModeObserver | null = null;
  private turnInFlight = false;
  private cancelRequested = false;

  constructor(options: TmuxCursorSessionOptions) {
    this.cwd = path.resolve(options.cwd);
    this.sessionName = options.sessionName || DEFAULT_SHARED_TMUX_SESSION_NAME;
    this.windowId = options.windowId;
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

  getWindowId(): string {
    if (!this.windowId) {
      throw new Error("tmux window is not initialized");
    }
    return this.windowId;
  }

  getCursorCliChatId(): string | undefined {
    return this.cursorCliChatId;
  }

  describeBinding(): TmuxSessionBinding {
    return {
      paneId: this.getPaneId(),
      tmuxSessionName: this.sessionName,
      tmuxWindowId: this.getWindowId(),
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
    if (!this.windowId && !this.paneId) return;
    try {
      if (this.windowId) {
        await runTmux(["kill-window", "-t", this.windowId]);
      } else if (this.paneId) {
        await runTmux(["kill-pane", "-t", this.paneId]);
      }
    } catch {
      // ignore
    } finally {
      this.started = false;
      this.turnInFlight = false;
      this.cancelRequested = false;
      this.windowId = undefined;
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
    if (this.paneId || this.windowId) {
      const probe = await probeTmuxBinding(
        {
          paneId: this.paneId,
          tmuxSessionName: this.sessionName,
          ...(this.windowId ? { tmuxWindowId: this.windowId } : {}),
          workspaceRoot: this.cwd,
          startCommand: this.startCommand,
          ...(this.cursorCliChatId ? { cursorCliChatId: this.cursorCliChatId } : {}),
        },
        20,
      );
      if (probe.exists && probe.resolvedBinding) {
        this.sessionName = probe.resolvedBinding.tmuxSessionName;
        this.windowId = probe.resolvedBinding.tmuxWindowId;
        this.paneId = probe.resolvedBinding.paneId;
        return;
      }
      this.windowId = undefined;
      this.paneId = undefined;
    }
    const created = await createDetachedWindow(this.sessionName, this.cwd);
    this.sessionName = created.tmuxSessionName;
    this.windowId = created.tmuxWindowId;
    this.paneId = created.paneId;
  }

  private async ensureObserver(): Promise<void> {
    if (this.observer) return;
    const observer = new TmuxControlModeObserver(this.sessionName);
    await observer.start();
    this.observer = observer;
  }

  private async ensureCursorCliChatId(): Promise<void> {
    if (!this.usesCursorAgentCommand()) {
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

  private usesCursorAgentCommand(): boolean {
    return /^cursor agent(?:\s|$)/.test(this.startCommand.trim());
  }

  private composeLaunchCommand(): string {
    if (!this.usesCursorAgentCommand()) {
      return this.startCommand;
    }
    if (!this.cursorCliChatId) {
      return this.startCommand;
    }
    return `${this.startCommand} --resume ${shellEscapeArg(this.cursorCliChatId)}`;
  }
}
