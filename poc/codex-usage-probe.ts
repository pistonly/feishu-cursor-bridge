import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type SessionNotification,
} from "@agentclientprotocol/sdk";

interface Options {
  cwd: string;
  prompt: string;
}

interface UsageSnapshot {
  sessionId: string;
  used?: number;
  size?: number;
  cost?: unknown;
  raw: unknown;
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
    cwd: path.resolve(values.get("--cwd") || process.cwd()),
    prompt:
      values.get("--prompt") ||
      "Reply with exactly CODEX_USAGE_PROBE_OK and nothing else.",
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

class ProbeClient {
  readonly usageSnapshots: UsageSnapshot[] = [];

  async sessionUpdate(n: SessionNotification): Promise<void> {
    const kind = n.update.sessionUpdate;
    if (kind === "usage_update") {
      const used = typeof (n.update as { used?: unknown }).used === "number"
        ? (n.update as { used: number }).used
        : undefined;
      const size = typeof (n.update as { size?: unknown }).size === "number"
        ? (n.update as { size: number }).size
        : undefined;
      const cost = (n.update as { cost?: unknown }).cost;
      this.usageSnapshots.push({
        sessionId: n.sessionId,
        used,
        size,
        cost,
        raw: n.update,
      });
      const percentage =
        typeof used === "number" && typeof size === "number" && size > 0
          ? `${((used / size) * 100).toFixed(2)}%`
          : "n/a";
      console.log(
        `[client update] usage_update used=${used ?? "?"} size=${size ?? "?"} percentage=${percentage}`,
      );
      return;
    }

    if (
      kind === "agent_message_chunk" ||
      kind === "user_message_chunk" ||
      kind === "agent_thought_chunk"
    ) {
      const text = n.update.content?.type === "text" ? n.update.content.text : "";
      console.log(`[client update] ${kind}: ${text}`);
      return;
    }

    if (kind === "tool_call") {
      console.log(
        `[client update] tool_call: ${n.update.title} [${String(n.update.status ?? "pending")}]`,
      );
      return;
    }

    if (kind === "tool_call_update") {
      console.log(
        `[client update] tool_call_update: ${n.update.toolCallId} [${String(n.update.status ?? "?")}]`,
      );
      return;
    }

    console.log(`[client update] ${kind}`);
  }
}

async function createConnection(options: Options): Promise<{
  child: ChildProcessWithoutNullStreams;
  conn: ClientSideConnection;
  client: ProbeClient;
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

  const toAgent = Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>;
  const fromAgent = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(toAgent, fromAgent);
  const client = new ProbeClient();
  const conn = new ClientSideConnection(() => client, stream);

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
      name: "codex-usage-probe",
      version: "0.1.0",
    },
  });

  console.log(`[probe] initialize ok authMethods=${(init.authMethods ?? []).join(",")}`);
  return { child, conn, client };
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

    const result = await setup.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: options.prompt }],
      stream: true,
      _meta: { stream: true },
    } as Parameters<ClientSideConnection["prompt"]>[0]);
    console.log(`stopReason: ${result.stopReason}`);

    const snapshots = setup.client.usageSnapshots.filter(
      (item) => item.sessionId === created.sessionId,
    );
    console.log(`[probe] usage_update count: ${snapshots.length}`);
    if (snapshots.length > 0) {
      const last = snapshots[snapshots.length - 1]!;
      const percentage =
        typeof last.used === "number" &&
        typeof last.size === "number" &&
        last.size > 0
          ? (last.used / last.size) * 100
          : undefined;
      console.log(
        `[probe] final usage: ${JSON.stringify({
          used: last.used,
          size: last.size,
          percentage,
          cost: last.cost,
        })}`,
      );
      console.log(`[probe] raw usage_update: ${JSON.stringify(last.raw)}`);
    }

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
