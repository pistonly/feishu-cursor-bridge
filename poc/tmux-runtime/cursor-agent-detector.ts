export interface SemanticSignal {
  kind: "title" | "status" | "content";
  text: string;
}

export interface WaitForReadyOptions {
  pollMs: number;
  readyTimeoutMs: number;
}

export interface TurnDetectorOptions {
  stablePolls: number;
  eventQuietMs: number;
}

export interface TurnEvaluation {
  uiState: "unknown" | "busy" | "idle" | "ui-ready-but-not-idle";
  idleStablePolls: number;
  quietForMs: number;
  semanticQuietForMs: number;
  busyQuietForMs: number;
  shouldComplete: boolean;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeSnapshot(snapshot: string): string {
  return snapshot.replace(/\s+\n/g, "\n").trim();
}

export function looksLikeCursorAgentUi(snapshot: string): boolean {
  return (
    snapshot.includes("Cursor Agent v") &&
    (snapshot.includes("Composer") || snapshot.includes("/ commands"))
  );
}

export function isCursorAgentBusy(snapshot: string): boolean {
  return [
    "ctrl+c to stop",
    "Generating",
    "Reading",
    "Thinking",
    "Running",
    "Executing",
    "Applying",
    "Searching",
    "Indexing",
    "Globbing",
  ].some((token) => snapshot.includes(token));
}

export function isCursorAgentIdle(snapshot: string): boolean {
  if (!looksLikeCursorAgentUi(snapshot)) return false;
  if (isCursorAgentBusy(snapshot)) return false;
  return snapshot.includes("Add a follow-up");
}

export async function waitForCursorAgentReady(
  captureSnapshot: () => Promise<string>,
  options: WaitForReadyOptions,
): Promise<string> {
  const deadline = Date.now() + options.readyTimeoutMs;
  let previous = "";
  while (Date.now() < deadline) {
    const snapshot = await captureSnapshot();
    if (snapshot !== previous) {
      previous = snapshot;
      const normalized = normalizeSnapshot(snapshot);
      if (looksLikeCursorAgentUi(normalized)) {
        return snapshot;
      }
    }
    await delay(options.pollMs);
  }
  throw new Error("Timed out waiting for Cursor Agent UI to become ready.");
}

export function decodeControlModeText(text: string): string {
  return text.replace(/\\([0-7]{3}|\\)/g, (_match, group: string) => {
    if (group === "\\") {
      return "\\";
    }
    return String.fromCharCode(Number.parseInt(group, 8));
  });
}

export function extractOscTitles(text: string): string[] {
  const titles: string[] = [];
  const regex = /\x1b]0;([^\x07]*)\x07/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) != null) {
    const title = match[1]?.trim();
    if (title) {
      titles.push(title);
    }
  }
  return titles;
}

export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\u0007]*\u0007/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "");
}

function normalizeSemanticLine(line: string): string {
  return line
    .replace(/[│┌┐└┘─]/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classifySemanticLine(line: string): SemanticSignal | null {
  if (!line) return null;
  if (
    /^Cursor Agent v/i.test(line) ||
    /^~\/|^\/home\//.test(line) ||
    /^Composer\b/.test(line) ||
    /^\/ commands\b/.test(line) ||
    /^\(base\)\s/.test(line) ||
    /^\$ cursor agent\b/.test(line) ||
    /^cursor agent$/i.test(line)
  ) {
    return null;
  }
  if (/^→?\s*Add a follow-up( ctrl\+c to stop)?$/.test(line)) {
    return null;
  }
  if (/^Plan, search, build anything$/.test(line)) {
    return null;
  }
  if (
    /^[⬡⬢]?\s*(Generating|Reading|Thinking|Searching|Globbing|Running|Executing|Applying|Indexing)\.*(?:\s+\d+.*)?$/i.test(
      line,
    )
  ) {
    return {
      kind: "status",
      text: line.replace(/^[⬡⬢]\s*/, ""),
    };
  }
  if (
    /^[⬡⬢]?\s*(Read|Reading|Globbed|Globbing|Searching|Running|Executing|Applying)\b/.test(
      line,
    )
  ) {
    return {
      kind: "status",
      text: line.replace(/^[⬡⬢]\s*/, ""),
    };
  }
  return { kind: "content", text: line };
}

export function extractSemanticSignals(text: string): SemanticSignal[] {
  const signals: SemanticSignal[] = [];
  for (const title of extractOscTitles(text)) {
    signals.push({ kind: "title", text: title });
  }
  const plain = stripAnsi(text).replace(/\r/g, "\n");
  for (const rawLine of plain.split("\n")) {
    const normalized = normalizeSemanticLine(rawLine);
    const signal = classifySemanticLine(normalized);
    if (signal) {
      signals.push(signal);
    }
  }
  return signals;
}

export function summarizeSemanticSignals(signals: SemanticSignal[]): string {
  return signals
    .map((signal) => `[${signal.kind}] ${signal.text}`)
    .join(" | ")
    .slice(0, 200);
}

export class CursorAgentTurnDetector {
  private readonly stablePolls: number;
  private readonly eventQuietMs: number;
  private lastOutputAt = 0;
  private lastSemanticAt = 0;
  private lastBusySemanticAt = 0;
  private seenBusyAfterPrompt = false;
  private seenSemanticAfterPrompt = false;
  private idleStablePolls = 0;

  constructor(options: TurnDetectorOptions) {
    this.stablePolls = options.stablePolls;
    this.eventQuietMs = options.eventQuietMs;
  }

  noteSemanticSignals(signals: SemanticSignal[], now = Date.now()): void {
    if (signals.length === 0) return;
    this.lastOutputAt = now;
    this.lastSemanticAt = now;
    this.seenSemanticAfterPrompt = true;
    if (signals.some((signal) => signal.kind === "status")) {
      this.lastBusySemanticAt = now;
      this.seenBusyAfterPrompt = true;
    }
  }

  noteRawOutput(now = Date.now()): void {
    this.lastOutputAt = now;
  }

  evaluateSnapshot(snapshot: string, now = Date.now()): TurnEvaluation {
    const normalized = normalizeSnapshot(snapshot);
    const busy = isCursorAgentBusy(normalized);
    const idle = isCursorAgentIdle(normalized);
    const quietForMs =
      this.lastOutputAt === 0 ? Number.POSITIVE_INFINITY : now - this.lastOutputAt;
    const semanticQuietForMs =
      this.lastSemanticAt === 0 ? Number.POSITIVE_INFINITY : now - this.lastSemanticAt;
    const busyQuietForMs =
      this.lastBusySemanticAt === 0
        ? Number.POSITIVE_INFINITY
        : now - this.lastBusySemanticAt;

    let uiState: TurnEvaluation["uiState"] = "unknown";
    if (idle) {
      this.idleStablePolls += 1;
      uiState = "idle";
    } else if (busy) {
      this.idleStablePolls = 0;
      uiState = "busy";
    } else if (looksLikeCursorAgentUi(normalized)) {
      this.idleStablePolls = 0;
      uiState = "ui-ready-but-not-idle";
    } else {
      this.idleStablePolls = 0;
    }

    const shouldComplete =
      uiState === "idle" &&
      this.idleStablePolls >= this.stablePolls &&
      quietForMs >= this.eventQuietMs &&
      busyQuietForMs >= this.eventQuietMs &&
      (this.seenBusyAfterPrompt || this.seenSemanticAfterPrompt);

    return {
      uiState,
      idleStablePolls: this.idleStablePolls,
      quietForMs,
      semanticQuietForMs,
      busyQuietForMs,
      shouldComplete,
    };
  }
}
