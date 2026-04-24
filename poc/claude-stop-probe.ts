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
  cancelAfterMs: number;
  quiet: boolean;
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

  const cancelAfterMsRaw = Number(values.get("--cancel-after-ms") || "1200");
  const cancelAfterMs = Number.isFinite(cancelAfterMsRaw) && cancelAfterMsRaw >= 0
    ? Math.floor(cancelAfterMsRaw)
    : 1200;

  return {
    cwd: path.resolve(values.get("--cwd") || process.cwd()),
    prompt:
      values.get("--prompt") ||
      [
        "Count from 1 to 2000, one number per line, and do not add any extra commentary.",
        "Start immediately from 1.",
      ].join(" "),
    cancelAfterMs,
    quiet: values.get("--quiet") === "true",
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

function resolveClaudeSpawn(): { command: string; args: string[] } {
  const commandRaw = process.env["CLAUDE_AGENT_ACP_COMMAND"]?.trim();
  const extraRaw = process.env["CLAUDE_AGENT_ACP_EXTRA_ARGS"]?.trim();
  const extraArgs = extraRaw ? parseShellLikeArgs(extraRaw) : [];

  if (commandRaw) {
    const tokens = parseShellLikeArgs(commandRaw);
    if (tokens.length === 0) {
      throw new Error("CLAUDE_AGENT_ACP_COMMAND 解析为空");
    }
    return {
      command: tokens[0]!,
      args: [...tokens.slice(1), ...extraArgs],
    };
  }

  return {
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp", ...extraArgs],
  };
}

class ProbeClient {
  private readonly quiet: boolean;

  constructor(quiet: boolean) {
    this.quiet = quiet;
  }

  async sessionUpdate(n: SessionNotification): Promise<void> {
    const kind = n.update.sessionUpdate;
    if (this.quiet) {
      if (kind === "usage_update") {
        const used = typeof (n.update as { used?: unknown }).used === "number"
          ? (n.update as { used: number }).used
          : undefined;
        const size = typeof (n.update as { size?: unknown }).size === "number"
          ? (n.update as { size: number }).size
          : undefined;
        console.log(`[client update] usage_update used=${used ?? "?"} size=${size ?? "?"}`);
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
      if (kind === "available_commands_update") {
        console.log(`[client update] ${kind}`);
      }
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

    if (kind === "usage_update") {
      const used = typeof (n.update as { used?: unknown }).used === "number"
        ? (n.update as { used: number }).used
        : undefined;
      const size = typeof (n.update as { size?: unknown }).size === "number"
        ? (n.update as { size: number }).size
        : undefined;
      console.log(`[client update] usage_update used=${used ?? "?"} size=${size ?? "?"}`);
      return;
    }

    console.log(`[client update] ${kind}`);
  }
}

async function createConnection(options: Options): Promise<{
  child: ChildProcessWithoutNullStreams;
  conn: ClientSideConnection;
}> {
  const spawnSpec = resolveClaudeSpawn();
  console.log(
    `[probe] spawn: ${spawnSpec.command} ${spawnSpec.args.map((part) => JSON.stringify(part)).join(" ")}`,
  );

  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      FEISHU_BRIDGE_EXT_TOOL: "1",
    },
  });

  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) {
      console.error(`[claude stderr] ${text}`);
    }
  });

  const toAgent = Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>;
  const fromAgent = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(toAgent, fromAgent);
  const conn = new ClientSideConnection(() => new ProbeClient(options.quiet), stream);

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
      name: "claude-stop-probe",
      version: "0.1.0",
    },
  });

  console.log(`[probe] initialize ok authMethods=${(init.authMethods ?? []).join(",")}`);
  return { child, conn };
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

    const cancelTimer = setTimeout(() => {
      console.log(`[probe] sending session/cancel after ${options.cancelAfterMs}ms`);
      void setup.conn.cancel({ sessionId: created.sessionId }).catch((error) => {
        console.error(
          `[probe] session/cancel failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
        );
      });
    }, options.cancelAfterMs);

    const result = await promptPromise.finally(() => clearTimeout(cancelTimer));
    console.log(`stopReason: ${result.stopReason}`);

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
