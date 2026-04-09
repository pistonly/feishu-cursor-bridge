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
  };
}

class NullClient {
  async sessionUpdate(n: SessionNotification): Promise<void> {
    const kind = n.update.sessionUpdate;
    if (
      kind === "agent_message_chunk" ||
      kind === "user_message_chunk" ||
      kind === "agent_thought_chunk"
    ) {
      const text = n.update.content?.type === "text" ? n.update.content.text : "";
      console.log(`[client update] ${kind}: ${text}`);
      return;
    }
    console.log(`[client update] ${kind}`);
  }
}

async function createConnection(options: Options): Promise<{
  child: ChildProcessWithoutNullStreams;
  conn: ClientSideConnection;
}> {
  const commandRaw = process.env["CLAUDE_AGENT_ACP_COMMAND"]?.trim();
  const extraRaw = process.env["CLAUDE_AGENT_ACP_EXTRA_ARGS"]?.trim();
  const commandParts = commandRaw ? commandRaw.split(/\s+/) : ["npx", "-y", "@agentclientprotocol/claude-agent-acp"];
  const extraArgs = extraRaw ? extraRaw.split(/\s+/).filter(Boolean) : [];
  const command = commandParts[0]!;
  const args = [...commandParts.slice(1), ...extraArgs];
  const child = spawn(command, args, {
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
  const conn = new ClientSideConnection(() => new NullClient(), stream);

  await conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: {
        readTextFile: false,
        writeTextFile: false,
      },
      terminal: false,
    },
    clientInfo: {
      name: "claude-acp-smoke",
      version: "0.1.0",
    },
  });

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

    const result = await setup.conn.prompt({
      sessionId: created.sessionId,
      prompt: [
        {
          type: "text",
          text: "Reply with exactly CLAUDE_SMOKE_OK and nothing else.",
        },
      ],
      stream: true,
      _meta: { stream: true },
    } as Parameters<ClientSideConnection["prompt"]>[0]);
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
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
