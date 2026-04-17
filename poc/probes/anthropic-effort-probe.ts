import Anthropic from "@anthropic-ai/sdk";
import { pathToFileURL } from "node:url";

export type EffortLevel = "low" | "medium" | "high" | "max";

export interface EffortProbeRequest {
  model: string;
  effort: EffortLevel;
  maxTokens?: number;
  prompt?: string;
}

export interface EffortProbeContentBlockSummary {
  type: string;
  text?: string;
  textLength?: number;
  thinkingPreview?: string;
  thinkingLength?: number;
}

export interface EffortProbeResult {
  model: string;
  effort: EffortLevel;
  ok: boolean;
  stopReason?: string | null;
  text?: string;
  textLength?: number;
  contentTypes?: string[];
  contentBlocks?: EffortProbeContentBlockSummary[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
  error?: {
    name?: string;
    status?: number;
    message: string;
  };
}

export interface AnthropicEffortProbeSummary {
  model: string;
  prompt: string;
  testedEfforts: EffortLevel[];
  results: EffortProbeResult[];
}

function summarizeContentBlock(
  block: (Awaited<ReturnType<Anthropic["messages"]["create"]>>)["content"][number],
): EffortProbeContentBlockSummary {
  switch (block.type) {
    case "text": {
      const text = typeof block.text === "string" ? block.text : "";
      return {
        type: block.type,
        text,
        textLength: text.length,
      };
    }
    case "thinking": {
      const thinking = typeof block.thinking === "string" ? block.thinking : "";
      return {
        type: block.type,
        thinkingPreview: thinking.slice(0, 160),
        thinkingLength: thinking.length,
      };
    }
    default:
      return { type: block.type };
  }
}

export async function runAnthropicEffortProbe(
  requests: EffortProbeRequest[],
): Promise<AnthropicEffortProbeSummary> {
  if (requests.length === 0) {
    throw new Error("At least one effort probe request is required.");
  }

  const client = new Anthropic();
  const prompt = requests[0]?.prompt ?? "Reply with exactly: OK";
  const model = requests[0]!.model;

  const results: EffortProbeResult[] = [];

  for (const request of requests) {
    try {
      const response = await client.messages.create({
        model: request.model,
        max_tokens: request.maxTokens ?? 256,
        thinking: { type: "adaptive" },
        output_config: { effort: request.effort },
        messages: [{ role: "user", content: request.prompt ?? prompt }],
      });

      const text = response.content
        .filter(
          (
            block,
          ): block is Extract<(typeof response.content)[number], { type: "text" }> =>
            block.type === "text",
        )
        .map((block) => block.text)
        .join(" ");

      results.push({
        model: request.model,
        effort: request.effort,
        ok: true,
        stopReason: response.stop_reason,
        text,
        textLength: text.length,
        contentTypes: response.content.map((block) => block.type),
        contentBlocks: response.content.map(summarizeContentBlock),
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadInputTokens: response.usage.cache_read_input_tokens,
          cacheCreationInputTokens: response.usage.cache_creation_input_tokens,
        },
      });
    } catch (error) {
      const err = error as {
        name?: string;
        status?: number;
        message?: string;
      };
      results.push({
        model: request.model,
        effort: request.effort,
        ok: false,
        error: {
          name: err.name,
          status: err.status,
          message: err.message ?? String(error),
        },
      });
    }
  }

  return {
    model,
    prompt,
    testedEfforts: requests.map((request) => request.effort),
    results,
  };
}

async function main() {
  const model = process.argv[2] ?? "claude-opus-4-6";
  const prompt = process.argv[3] ?? "Reply with exactly: OK";
  const efforts: EffortLevel[] = ["low", "medium", "high", "max"];

  const summary = await runAnthropicEffortProbe(
    efforts.map((effort) => ({ model, effort, prompt })),
  );

  console.log(JSON.stringify(summary, null, 2));
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
