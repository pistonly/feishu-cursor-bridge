import { pathToFileURL } from "node:url";
import {
  query,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeContextCategory {
  name: string;
  tokens: number;
  isDeferred?: boolean;
}

export interface ClaudeMemoryFileUsage {
  path: string;
  type: string;
  tokens: number;
}

export interface ClaudeContextSnapshot {
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens: number;
  percentage: number;
  model: string;
  categories: ClaudeContextCategory[];
  memoryFiles: ClaudeMemoryFileUsage[];
}

export interface ClaudeModelUsageSummary {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
}

export interface ClaudeResultUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalCostUsd: number;
}

export interface ClaudeAssistantUsageSample {
  uuid: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface ClaudeContextProbeOptions {
  prompt: string;
  cwd?: string;
  model?: string;
  resume?: string;
  maxTurns?: number;
  permissionMode?:
    | "default"
    | "acceptEdits"
    | "bypassPermissions"
    | "plan"
    | "dontAsk";
  allowDangerouslySkipPermissions?: boolean;
}

export interface ClaudeContextProbeResult {
  sessionId?: string;
  prompt: string;
  resume?: string;
  contextBeforeTurn:
    | {
        ok: true;
        snapshot: ClaudeContextSnapshot;
      }
    | {
        ok: false;
        error: string;
      };
  assistantUsageSamples: ClaudeAssistantUsageSample[];
  result?:
    | {
        ok: true;
        subtype: SDKResultMessage["subtype"];
        stopReason: string | null;
        usage: ClaudeResultUsageSummary;
        modelUsages: ClaudeModelUsageSummary[];
        raw: SDKResultMessage;
      }
    | {
        ok: false;
        error: string;
      };
}

export async function getClaudeContextSnapshot(
  activeQuery: Query,
): Promise<ClaudeContextProbeResult["contextBeforeTurn"]> {
  try {
    const usage = await activeQuery.getContextUsage();
    return {
      ok: true,
      snapshot: {
        totalTokens: usage.totalTokens,
        maxTokens: usage.maxTokens,
        rawMaxTokens: usage.rawMaxTokens,
        percentage: usage.percentage,
        model: usage.model,
        categories: usage.categories.map((category) => ({
          name: category.name,
          tokens: category.tokens,
          isDeferred: category.isDeferred,
        })),
        memoryFiles: usage.memoryFiles.map((file) => ({
          path: file.path,
          type: file.type,
          tokens: file.tokens,
        })),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

export async function runClaudeContextProbe(
  options: ClaudeContextProbeOptions,
): Promise<ClaudeContextProbeResult> {
  const activeQuery = query({
    prompt: options.prompt,
    options: {
      cwd: options.cwd ?? process.cwd(),
      model: options.model ?? "claude-sonnet-4-6",
      resume: options.resume,
      maxTurns: options.maxTurns ?? 1,
      permissionMode: options.permissionMode ?? "bypassPermissions",
      allowDangerouslySkipPermissions:
        options.allowDangerouslySkipPermissions ??
        (options.permissionMode ?? "bypassPermissions") === "bypassPermissions",
      persistSession: true,
      env: {
        ...process.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: "feishu-cursor-bridge/claude-context-probe",
      },
    },
  });

  const result: ClaudeContextProbeResult = {
    prompt: options.prompt,
    resume: options.resume,
    contextBeforeTurn: await getClaudeContextSnapshot(activeQuery),
    assistantUsageSamples: [],
  };

  for await (const message of activeQuery) {
    if (message.type === "assistant") {
      result.sessionId ??= message.session_id;
      result.assistantUsageSamples.push(toAssistantUsageSample(message));
      continue;
    }

    if (message.type === "result") {
      result.sessionId ??= message.session_id;
      result.result = {
        ok: true,
        subtype: message.subtype,
        stopReason: message.stop_reason,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheReadInputTokens: message.usage.cache_read_input_tokens,
          cacheCreationInputTokens: message.usage.cache_creation_input_tokens,
          totalCostUsd: message.total_cost_usd,
        },
        modelUsages: Object.entries(message.modelUsage).map(([model, usage]) => ({
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          webSearchRequests: usage.webSearchRequests,
          costUSD: usage.costUSD,
          contextWindow: usage.contextWindow,
          maxOutputTokens: usage.maxOutputTokens,
        })),
        raw: message,
      };
    }
  }

  if (!result.result) {
    result.result = {
      ok: false,
      error: "No result message received from claude-agent-sdk query() stream.",
    };
  }

  return result;
}

function toAssistantUsageSample(message: Extract<SDKMessage, { type: "assistant" }>) {
  return {
    uuid: message.uuid,
    inputTokens: message.message.usage.input_tokens,
    outputTokens: message.message.usage.output_tokens,
    cacheReadInputTokens: message.message.usage.cache_read_input_tokens,
    cacheCreationInputTokens: message.message.usage.cache_creation_input_tokens,
  };
}

async function main() {
  const prompt = process.argv[2] ?? "Reply with exactly OK.";
  const resume = process.argv[3];
  const probe = await runClaudeContextProbe({ prompt, resume });
  console.log(JSON.stringify(probe, null, 2));
}

const isCli =
  process.argv[1] != null &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isCli) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
