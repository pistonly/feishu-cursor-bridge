import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type SessionNotification,
} from "@agentclientprotocol/sdk";

interface Options {
  cwd: string;
  prompt: string;
  cancelAfterMs?: number;
}

type RawDirection = "outbound" | "inbound";

type RawRecord = {
  direction: RawDirection;
  raw: string;
  parsed?: unknown;
  at: number;
};

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
    prompt:
      values.get("--prompt") ||
      [
        "Count from 1 to 80, one number per line, and do not add any extra commentary.",
        "Start immediately from 1.",
      ].join(" "),
    ...(values.has("--cancel-after-ms")
      ? {
          cancelAfterMs: Math.max(
            0,
            Number.parseInt(values.get("--cancel-after-ms") || "0", 10) || 0,
          ),
        }
      : {}),
  };
}

function parseShellLikeArgs(value: string): string[] {
  const matches = value.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  return matches.map((part) => {
    if (
      (part.startsWith('"') && part.endsWith('"')) ||
      (part.startsWith("'") && part.endsWith("'"))
    ) {
      return part.slice(1, -1);
    }
    return part;
  });
}

function hasCodexConfigOverride(args: string[], key: string): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (!current) continue;
    if (current === "-c" || current === "--config") {
      const next = args[i + 1];
      if (typeof next === "string" && next.startsWith(`${key}=`)) return true;
      continue;
    }
    if (current.startsWith("--config=")) {
      const value = current.slice("--config=".length);
      if (value.startsWith(`${key}=`)) return true;
    }
  }
  return false;
}

function resolveCodexSpawn(): { command: string; args: string[] } {
  const envRaw = process.env["CODEX_AGENT_ACP_COMMAND"]?.trim();
  const extraRaw = process.env["CODEX_AGENT_ACP_EXTRA_ARGS"]?.trim();
  const extraArgs = extraRaw ? parseShellLikeArgs(extraRaw) : [];
  const autoApprove =
    (process.env["AUTO_APPROVE_PERMISSIONS"] ?? "true").toLowerCase() === "true";

  if (envRaw) {
    const tokens = parseShellLikeArgs(envRaw);
    if (tokens.length === 0) {
      throw new Error("CODEX_AGENT_ACP_COMMAND 解析为空");
    }
    const args = [...tokens.slice(1), ...extraArgs];
    if (autoApprove) {
      if (!hasCodexConfigOverride(args, "sandbox_mode")) {
        args.push("-c", 'sandbox_mode="danger-full-access"');
      }
      if (!hasCodexConfigOverride(args, "approval_policy")) {
        args.push("-c", 'approval_policy="never"');
      }
    }
    return { command: tokens[0]!, args };
  }

  const args = ["-y", "@zed-industries/codex-acp", ...extraArgs];
  if (autoApprove) {
    if (!hasCodexConfigOverride(args, "sandbox_mode")) {
      args.push("-c", 'sandbox_mode="danger-full-access"');
    }
    if (!hasCodexConfigOverride(args, "approval_policy")) {
      args.push("-c", 'approval_policy="never"');
    }
  }
  return { command: "npx", args };
}

function jsonPretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getMethod(value: unknown): string | undefined {
  return isObject(value) && typeof value.method === "string" ? value.method : undefined;
}

function getId(value: unknown): string | number | undefined {
  if (!isObject(value)) return undefined;
  const id = value.id;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

function getSessionIdFromUpdate(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  const params = value.params;
  if (!isObject(params)) return undefined;
  return typeof params.sessionId === "string" ? params.sessionId : undefined;
}

function getUpdatePayload(value: unknown): Record<string, unknown> | undefined {
  if (!isObject(value)) return undefined;
  const params = value.params;
  if (!isObject(params)) return undefined;
  const update = params.update;
  return isObject(update) ? update : undefined;
}

function hasStopReasonInUpdate(value: unknown): boolean {
  const update = getUpdatePayload(value);
  return update != null && "stopReason" in update;
}

function getMessageIdFromUpdate(value: unknown): string | undefined {
  const update = getUpdatePayload(value);
  return update && typeof update.messageId === "string" ? update.messageId : undefined;
}

function section(title: string, body: string): string {
  return `\n=== ${title} ===\n${body}\n`;
}

class ProbeClient {
  async sessionUpdate(_n: SessionNotification): Promise<void> {
    // Raw NDJSON is captured separately below; no additional transformation needed here.
  }
}

function captureLines(
  stream: PassThrough,
  direction: RawDirection,
  sink: RawRecord[],
): void {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    sink.push({
      direction,
      raw: trimmed,
      parsed: tryParseJson(trimmed),
      at: Date.now(),
    });
  });
}

async function createConnection(options: Options): Promise<{
  child: ChildProcessWithoutNullStreams;
  conn: ClientSideConnection;
  rawRecords: RawRecord[];
}> {
  const spawnSpec = resolveCodexSpawn();
  console.log(
    `[probe] spawn: ${spawnSpec.command} ${spawnSpec.args.map((part) => JSON.stringify(part)).join(" ")}`,
  );

  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) {
      console.error(`[codex stderr] ${text}`);
    }
  });

  const rawRecords: RawRecord[] = [];

  const outboundSdkFeed = new PassThrough();
  const outboundRawTap = new PassThrough();
  outboundSdkFeed.pipe(child.stdin);
  outboundSdkFeed.pipe(outboundRawTap);
  captureLines(outboundRawTap, "outbound", rawRecords);

  const inboundSdkFeed = new PassThrough();
  const inboundRawTap = new PassThrough();
  child.stdout.pipe(inboundSdkFeed);
  child.stdout.pipe(inboundRawTap);
  captureLines(inboundRawTap, "inbound", rawRecords);

  const toAgent =
    Writable.toWeb(outboundSdkFeed) as unknown as WritableStream<Uint8Array>;
  const fromAgent =
    Readable.toWeb(inboundSdkFeed) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(toAgent, fromAgent);
  const conn = new ClientSideConnection(() => new ProbeClient(), stream);

  const init = await conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: {
        readTextFile: false,
        writeTextFile: false,
      },
      terminal: false,
    },
    clientInfo: {
      name: "codex-raw-stream-probe",
      version: "0.1.0",
    },
  });

  console.log(`[probe] initialize ok authMethods=${(init.authMethods ?? []).join(",")}`);
  return { child, conn, rawRecords };
}

async function stopConnection(child: ChildProcessWithoutNullStreams): Promise<void> {
  child.stdin.end();
  child.kill();
  await new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    setTimeout(resolve, 1500);
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  let child: ChildProcessWithoutNullStreams | null = null;

  try {
    const setup = await createConnection(options);
    child = setup.child;

    const created = await setup.conn.newSession({
      cwd: options.cwd,
      mcpServers: [],
    });
    console.log(`session id: ${created.sessionId}`);

    const promptPromise = setup.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: options.prompt }],
      stream: true,
      _meta: { stream: true },
    } as Parameters<ClientSideConnection["prompt"]>[0]);
    const cancelTimer =
      options.cancelAfterMs == null
        ? undefined
        : setTimeout(() => {
            console.log(
              `[probe] sending session/cancel after ${options.cancelAfterMs}ms`,
            );
            void setup.conn.cancel({ sessionId: created.sessionId }).catch((error) => {
              console.error(
                `[probe] session/cancel failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
              );
            });
          }, options.cancelAfterMs);
    const result = await promptPromise.finally(() => {
      if (cancelTimer) clearTimeout(cancelTimer);
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const promptRequest = [...setup.rawRecords]
      .reverse()
      .find((record) => getMethod(record.parsed) === "session/prompt");
    const promptRequestId = promptRequest ? getId(promptRequest.parsed) : undefined;
    const promptResponse = setup.rawRecords.find(
      (record) =>
        record.direction === "inbound" &&
        promptRequestId !== undefined &&
        getId(record.parsed) === promptRequestId,
    );
    const promptUpdates = setup.rawRecords.filter(
      (record) =>
        record.direction === "inbound" &&
        getMethod(record.parsed) === "session/update" &&
        getSessionIdFromUpdate(record.parsed) === created.sessionId,
    );

    const updateKinds = promptUpdates
      .map((record) => getUpdatePayload(record.parsed)?.sessionUpdate)
      .filter((value): value is string => typeof value === "string");
    const updateMessageIds = promptUpdates
      .map((record) => getMessageIdFromUpdate(record.parsed))
      .filter((value): value is string => typeof value === "string");
    const uniqueUpdateMessageIds = [...new Set(updateMessageIds)];
    const updateHasStopReason = promptUpdates.some((record) =>
      hasStopReasonInUpdate(record.parsed),
    );

    console.log(section("Prompt Request Envelope", jsonPretty(promptRequest?.parsed ?? null)));
    console.log(
      section(
        `Prompt Session Updates (${promptUpdates.length})`,
        promptUpdates.length > 0
          ? promptUpdates
              .map(
                (record, index) =>
                  `#${index + 1}\n${jsonPretty(record.parsed ?? record.raw)}`,
              )
              .join("\n\n")
          : "No session/update notifications captured for this prompt.",
      ),
    );
    console.log(section("Prompt Response Envelope", jsonPretty(promptResponse?.parsed ?? null)));
    console.log(section("Prompt Response Result (SDK)", jsonPretty(result)));
    console.log(
      section(
        "Derived Observations",
        [
          `session/update kinds: ${updateKinds.join(", ") || "(none)"}`,
          `session/update count: ${promptUpdates.length}`,
          `any session/update contains stopReason: ${updateHasStopReason}`,
          `session/update messageId count: ${updateMessageIds.length}`,
          `unique session/update messageIds: ${uniqueUpdateMessageIds.join(", ") || "(none)"}`,
          `cancelAfterMs: ${options.cancelAfterMs ?? "(none)"}`,
          `prompt response stopReason: ${String(result.stopReason)}`,
        ].join("\n"),
      ),
    );

    if (setup.conn.unstable_closeSession) {
      await setup.conn.unstable_closeSession({ sessionId: created.sessionId });
      console.log("closeSession: ok");
    }
  } finally {
    if (child) {
      await stopConnection(child);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
