import type { ToolKind } from "@agentclientprotocol/sdk";

export interface TmuxSemanticSignal {
  kind: "title" | "status" | "content";
  text: string;
}

export interface TmuxRunPromptHooks {
  onSemanticSignals?: (signals: TmuxSemanticSignal[]) => void;
  onReplyTextProgress?: (replyText: string) => void;
}

export interface TmuxStreamingUpdate {
  sessionUpdate:
    | "agent_message_chunk"
    | "agent_thought_chunk"
    | "tool_call"
    | "tool_call_update";
  content?: { type: "text"; text: string };
  toolCallId?: string;
  title?: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  kind?: ToolKind;
  rawOutput?: unknown;
}

export interface ParsedToolStatus {
  kind: ToolKind;
  title: string;
  state: "progress" | "completed";
  identity: string;
}

function isIgnorableContentSignal(text: string, promptText: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed === promptText.trim()) return true;
  if (trimmed === `→ ${promptText.trim()}`) return true;
  if (/^→\s*/.test(trimmed)) return true;
  if (/^Add a follow-up\b/.test(trimmed)) return true;
  if (/^Plan, search, build anything$/.test(trimmed)) return true;
  if (/^Press Ctrl\+C again to exit$/i.test(trimmed)) return true;
  if (/^To resume this session: (?:cursor agent|agent) --resume=/i.test(trimmed)) return true;
  if (/^(?:\(base\)\s+)?\S+@\S+:.*[$#]$/.test(trimmed)) return true;
  return false;
}

function isLowValueToolSummaryStatus(text: string): boolean {
  return (
    /^Globbing,\s*reading\b/i.test(text) ||
    /^Globbed,\s*reading\b/i.test(text) ||
    /^Reading\s+\d+\s+files?\b/i.test(text) ||
    /^Read\s+\d+\s+files?\b/i.test(text)
  );
}

function normalizeThoughtSignal(signal: TmuxSemanticSignal): string | undefined {
  if (signal.kind === "status") {
    if (isLowValueToolSummaryStatus(signal.text)) {
      return undefined;
    }
    const normalized = signal.text
      .replace(/\.+(?=(\s+\d+.*)?$)/, "")
      .trim();
    return normalized ? `[status] ${normalized}` : undefined;
  }
  if (signal.kind === "title") {
    const normalized = signal.text.trim();
    return normalized ? `[title] ${normalized}` : undefined;
  }
  return undefined;
}

function buildToolIdentity(kind: ToolKind, title: string): string {
  const normalizedTitle = title.replace(/\s+/g, " ").trim();
  const target = normalizedTitle
    .replace(
      /^(Reading|Read|Globbing|Globbed|Searching|Indexing|Running|Executing|Applying)\b[:,\s-]*/i,
      "",
    )
    .trim();
  return `${kind}:${(target || normalizedTitle).toLowerCase()}`;
}

export function parseToolStatus(text: string): ParsedToolStatus | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;
  const cleaned = normalized.replace(/\.+(?=\s+\d+\s+tokens?$)/i, "").trim();
  const tokenCounter = /^[A-Za-z]+\.*\s+[\d.]+[kKmM]?\s+tokens?$/i;

  if (/^(Generating|Thinking)\b/i.test(cleaned)) {
    return undefined;
  }
  if (/^Reading\b/i.test(cleaned) && tokenCounter.test(cleaned)) {
    return undefined;
  }
  if (/^Globbing\b/i.test(cleaned) && tokenCounter.test(cleaned)) {
    return undefined;
  }
  if (isLowValueToolSummaryStatus(cleaned)) {
    return undefined;
  }

  const mapping: Array<{
    regex: RegExp;
    kind: ToolKind;
    state: "progress" | "completed";
  }> = [
    { regex: /^Reading\b/i, kind: "read", state: "progress" },
    { regex: /^Read\b/i, kind: "read", state: "completed" },
    { regex: /^Globbing\b/i, kind: "search", state: "progress" },
    { regex: /^Globbed\b/i, kind: "search", state: "completed" },
    { regex: /^Searching\b/i, kind: "search", state: "progress" },
    { regex: /^Indexing\b/i, kind: "search", state: "progress" },
    { regex: /^Running\b/i, kind: "execute", state: "progress" },
    { regex: /^Executing\b/i, kind: "execute", state: "progress" },
    { regex: /^Applying\b/i, kind: "edit", state: "progress" },
  ];

  for (const item of mapping) {
    if (item.regex.test(cleaned)) {
      return {
        kind: item.kind,
        title: cleaned,
        state: item.state,
        identity: buildToolIdentity(item.kind, cleaned),
      };
    }
  }
  return undefined;
}

function sanitizeReplyDelta(text: string, promptText: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => !isIgnorableContentSignal(line, promptText))
    .join("\n")
    .trim();
}

export function createStreamingHooks(
  promptText: string,
  enqueue: (update: TmuxStreamingUpdate) => void,
): {
  hooks: TmuxRunPromptHooks;
  hasStreamedContent: () => boolean;
  finalize: (status: "completed" | "failed") => void;
} {
  const seenThought = new Set<string>();
  const completedToolIdentities = new Set<string>();
  let streamedContent = false;
  let lastReplyText = "";
  let nextToolSeq = 1;
  let activeTool:
    | {
        toolCallId: string;
        title: string;
        kind: ToolKind;
        identity: string;
      }
    | undefined;

  const completeActiveTool = (
    rawOutput?: unknown,
    status: "completed" | "failed" = "completed",
  ) => {
    if (!activeTool) return;
    if (status === "completed") {
      completedToolIdentities.add(activeTool.identity);
    }
    enqueue({
      sessionUpdate: "tool_call_update",
      toolCallId: activeTool.toolCallId,
      status,
      rawOutput,
    });
    activeTool = undefined;
  };

  return {
    hooks: {
      onSemanticSignals: (signals) => {
        for (const signal of signals) {
          if (signal.kind === "status") {
            const parsed = parseToolStatus(signal.text);
            if (parsed) {
              if (activeTool && activeTool.identity === parsed.identity) {
                if (parsed.state === "completed") {
                  completeActiveTool({ status: signal.text });
                }
                continue;
              }
              if (completedToolIdentities.has(parsed.identity)) {
                continue;
              }

              if (activeTool) {
                completeActiveTool({ supersededBy: parsed.title });
              }

              const toolCallId = `tmux-tool-${nextToolSeq++}`;
              enqueue({
                sessionUpdate: "tool_call",
                toolCallId,
                title: parsed.title,
                status: "in_progress",
                kind: parsed.kind,
              });
              activeTool = {
                toolCallId,
                title: parsed.title,
                kind: parsed.kind,
                identity: parsed.identity,
              };

              if (parsed.state === "completed") {
                completeActiveTool({ status: signal.text });
              }
              continue;
            }
          }

          const thought = normalizeThoughtSignal(signal);
          if (!thought || seenThought.has(thought)) {
            continue;
          }
          seenThought.add(thought);
          enqueue({
            sessionUpdate: "agent_thought_chunk",
            content: {
              type: "text",
              text: thought,
            },
          });
        }
      },
      onReplyTextProgress: (replyText) => {
        const normalized = replyText.trim();
        if (!normalized || isIgnorableContentSignal(normalized, promptText)) {
          return;
        }
        if (normalized === lastReplyText) {
          return;
        }
        if (lastReplyText && lastReplyText.startsWith(normalized)) {
          return;
        }

        let delta = normalized;
        if (lastReplyText && normalized.startsWith(lastReplyText)) {
          delta = normalized.slice(lastReplyText.length);
        } else if (lastReplyText && normalized.includes(lastReplyText)) {
          delta = normalized.slice(normalized.indexOf(lastReplyText) + lastReplyText.length);
        }

        delta = sanitizeReplyDelta(delta.replace(/^\n+/, ""), promptText);
        if (!delta.trim()) {
          lastReplyText = normalized;
          return;
        }

        streamedContent = true;
        lastReplyText = normalized;
        enqueue({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: delta,
          },
        });
      },
    },
    hasStreamedContent: () => streamedContent,
    finalize: (status) => {
      completeActiveTool(undefined, status);
    },
  };
}
