import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
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
  storePath: string;
  cancelAfterMs: number;
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
    storePath: path.resolve(
      values.get("--store-path") ||
        path.join(process.cwd(), "poc/tmux-runtime/.tmp-tmux-acp-cancel-store.json"),
    ),
    cancelAfterMs: Number.parseInt(values.get("--cancel-after-ms") || "5000", 10),
  };
}

class NullClient {
  async sessionUpdate(n: SessionNotification): Promise<void> {
    const kind = n.update.sessionUpdate;
    if (kind === "tool_call") {
      console.log(
        `[client update] tool_call: ${n.update.title} [${String(n.update.status ?? "pending")}]`,
      );
      return;
    }
    if (kind === "tool_call_update") {
      console.log(
        `[client update] tool_call_update: ${n.update.toolCallId} [${String(n.update.status ?? "?")}]${n.update.title ? ` ${n.update.title}` : ""}`,
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
    console.log(`[client update] ${kind}`);
  }
}

async function createConnection(
  options: Options,
): Promise<{
  child: ChildProcessWithoutNullStreams;
  conn: ClientSideConnection;
}> {
  const child = spawn(
    "npx",
    ["tsx", "poc/tmux-runtime/tmux-acp-server.ts", "--store-path", options.storePath],
    {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    },
  );

  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) {
      console.error(`[server stderr] ${text}`);
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
      name: "tmux-acp-cancel-smoke",
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
  await fs.rm(options.storePath, { force: true });

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
      prompt: [
        {
          type: "text",
          text: "请详细分析这个仓库，至少给出30条观察，先阅读多个文件再回答。",
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, options.cancelAfterMs));
    await setup.conn.cancel({ sessionId: created.sessionId });
    console.log(`cancel sent after ms: ${options.cancelAfterMs}`);

    const result = await promptPromise;
    console.log(`stopReason: ${result.stopReason}`);

    await setup.conn.unstable_closeSession({
      sessionId: created.sessionId,
    });
    console.log("closeSession: ok");
  } finally {
    if (child) {
      await stopConnection(child);
    }
    await fs.rm(options.storePath, { force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
