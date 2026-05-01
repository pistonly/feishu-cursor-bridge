import type { Readable, Writable } from "node:stream";

export type JsonRpcId = number | string;

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type JsonRpcRequestMessage = {
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcNotificationMessage = {
  method: string;
  params?: unknown;
};

type JsonRpcSuccessResponseMessage = {
  id: JsonRpcId;
  result: unknown;
};

type JsonRpcErrorResponseMessage = {
  id: JsonRpcId;
  error: JsonRpcError;
};

type JsonRpcIncomingMessage =
  | JsonRpcRequestMessage
  | JsonRpcNotificationMessage
  | JsonRpcSuccessResponseMessage
  | JsonRpcErrorResponseMessage;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

export class ContentLengthJsonRpcPeer {
  private readonly stdin: Writable;
  private readonly stdout: Readable;
  private readonly pendingRequests = new Map<JsonRpcId, PendingRequest>();
  private readonly requestHandler: (
    method: string,
    params: unknown,
  ) => Promise<unknown>;
  private readonly notificationHandler: (
    method: string,
    params: unknown,
  ) => Promise<void>;

  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private disposed = false;

  constructor(options: {
    stdin: Writable;
    stdout: Readable;
    requestHandler: (method: string, params: unknown) => Promise<unknown>;
    notificationHandler: (method: string, params: unknown) => Promise<void>;
  }) {
    this.stdin = options.stdin;
    this.stdout = options.stdout;
    this.requestHandler = options.requestHandler;
    this.notificationHandler = options.notificationHandler;

    this.stdout.on("data", (chunk: Buffer | string) => {
      this.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    this.stdout.on("error", (error) => {
      this.dispose(error);
    });
    this.stdout.on("close", () => {
      this.dispose(new Error("Codex app-server stdout closed"));
    });
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.disposed) {
      throw new Error("Codex app-server transport is not available");
    }
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });
    this.writeMessage({ id, method, params });
    return await result;
  }

  notify(method: string, params?: unknown): void {
    if (this.disposed) return;
    this.writeMessage({ method, params });
  }

  dispose(error?: unknown): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error ?? new Error("Codex app-server transport closed"));
    }
    this.pendingRequests.clear();
  }

  private writeMessage(message: Record<string, unknown>): void {
    const payload = JSON.stringify(message);
    const contentLength = Buffer.byteLength(payload, "utf8");
    const frame = `Content-Length: ${contentLength}\r\n\r\n${payload}`;
    this.stdin.write(frame);
  }

  private onData(chunk: Buffer): void {
    if (this.disposed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const headerText = this.buffer.subarray(0, headerEnd).toString("utf8");
      const contentLength = this.parseContentLength(headerText);
      if (contentLength == null) {
        this.dispose(
          new Error(`Codex app-server frame missing Content-Length header`),
        );
        return;
      }
      const frameEnd = headerEnd + 4 + contentLength;
      if (this.buffer.length < frameEnd) {
        return;
      }
      const payload = this.buffer
        .subarray(headerEnd + 4, frameEnd)
        .toString("utf8");
      this.buffer = this.buffer.subarray(frameEnd);
      let message: JsonRpcIncomingMessage;
      try {
        message = JSON.parse(payload) as JsonRpcIncomingMessage;
      } catch (error) {
        this.dispose(error);
        return;
      }
      void this.handleMessage(message);
    }
  }

  private parseContentLength(headerText: string): number | null {
    for (const line of headerText.split(/\r\n/)) {
      const match = /^content-length:\s*(\d+)\s*$/i.exec(line.trim());
      if (!match) continue;
      const value = Number.parseInt(match[1]!, 10);
      return Number.isFinite(value) && value >= 0 ? value : null;
    }
    return null;
  }

  private async handleMessage(message: JsonRpcIncomingMessage): Promise<void> {
    if (this.isIncomingRequest(message)) {
      await this.handleIncomingRequest(message);
      return;
    }
    if (this.isIncomingNotification(message)) {
      await this.notificationHandler(message.method, message.params);
      return;
    }
    if (this.isIncomingErrorResponse(message)) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return;
      this.pendingRequests.delete(message.id);
      pending.reject(message.error);
      return;
    }
    if (this.isIncomingSuccessResponse(message)) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return;
      this.pendingRequests.delete(message.id);
      pending.resolve(message.result);
    }
  }

  private async handleIncomingRequest(
    message: JsonRpcRequestMessage,
  ): Promise<void> {
    try {
      const result = await this.requestHandler(message.method, message.params);
      this.writeMessage({ id: message.id, result });
    } catch (error) {
      const rpcError = normalizeJsonRpcError(error);
      this.writeMessage({ id: message.id, error: rpcError });
    }
  }

  private isIncomingNotification(
    message: JsonRpcIncomingMessage,
  ): message is JsonRpcNotificationMessage {
    return (
      typeof (message as { method?: unknown }).method === "string" &&
      !Object.prototype.hasOwnProperty.call(message, "id")
    );
  }

  private isIncomingRequest(
    message: JsonRpcIncomingMessage,
  ): message is JsonRpcRequestMessage {
    return (
      typeof (message as { method?: unknown }).method === "string" &&
      Object.prototype.hasOwnProperty.call(message, "id")
    );
  }

  private isIncomingSuccessResponse(
    message: JsonRpcIncomingMessage,
  ): message is JsonRpcSuccessResponseMessage {
    return (
      Object.prototype.hasOwnProperty.call(message, "id") &&
      Object.prototype.hasOwnProperty.call(message, "result")
    );
  }

  private isIncomingErrorResponse(
    message: JsonRpcIncomingMessage,
  ): message is JsonRpcErrorResponseMessage {
    return (
      Object.prototype.hasOwnProperty.call(message, "id") &&
      Object.prototype.hasOwnProperty.call(message, "error")
    );
  }
}

function normalizeJsonRpcError(error: unknown): JsonRpcError {
  if (error && typeof error === "object") {
    const maybeRpc = error as {
      code?: unknown;
      message?: unknown;
      data?: unknown;
    };
    if (
      typeof maybeRpc.code === "number" &&
      typeof maybeRpc.message === "string"
    ) {
      return {
        code: maybeRpc.code,
        message: maybeRpc.message,
        ...(Object.prototype.hasOwnProperty.call(maybeRpc, "data")
          ? { data: maybeRpc.data }
          : {}),
      };
    }
  }
  if (error instanceof Error) {
    return { code: -32000, message: error.message };
  }
  return {
    code: -32000,
    message: typeof error === "string" ? error : String(error),
  };
}
