import type { FeishuMessage } from "../feishu/bot.js";
import type { SessionSlot, UserSession } from "../session/manager.js";
import type { SlotMessageLogStore } from "./slot-message-log.js";

type SlotLogBase = {
  slotMessageLog: SlotMessageLogStore | null;
  sessionKey: string;
  slot: SessionSlot;
  session: UserSession;
  msg: FeishuMessage;
};

type SlotLogEntry = {
  sessionKey: string;
  slot: SessionSlot;
  session: UserSession;
  msg: FeishuMessage;
};

function warnAppendFailure(
  kind: string,
  slot: SessionSlot,
  sessionKey: string,
  error: unknown,
): void {
  console.warn(
    `[bridge] failed to append slot ${kind} log slot=#${slot.slotIndex} sessionKey=${sessionKey}:`,
    error instanceof Error ? error.message : error,
  );
}

function buildSlotLogEntry(args: SlotLogBase): SlotLogEntry {
  return {
    sessionKey: args.sessionKey,
    slot: args.slot,
    session: args.session,
    msg: args.msg,
  };
}

async function appendSlotLog<T extends unknown[]>(
  kind: string,
  args: SlotLogBase,
  append: (store: SlotMessageLogStore, entry: SlotLogEntry, ...payload: T) => Promise<void>,
  ...payload: T
): Promise<void> {
  if (!args.slotMessageLog) return;
  try {
    await append(args.slotMessageLog, buildSlotLogEntry(args), ...payload);
  } catch (error) {
    warnAppendFailure(kind, args.slot, args.sessionKey, error);
  }
}

export async function appendSlotPromptLog(
  args: SlotLogBase,
  rawFeishuContent: string,
  agentPrompt: string,
): Promise<void> {
  await appendSlotLog(
    "prompt",
    args,
    (store, entry, rawContent, prompt) =>
      store.appendPrompt(entry, rawContent, prompt),
    rawFeishuContent,
    agentPrompt,
  );
}

export async function appendSlotReplyLog(
  args: SlotLogBase,
  reply: string,
): Promise<void> {
  await appendSlotLog(
    "reply",
    args,
    (store, entry, replyText) => store.appendReply(entry, replyText),
    reply,
  );
}

export async function appendSlotAcpChunkLog(
  args: SlotLogBase,
  chunkText: string,
): Promise<void> {
  await appendSlotLog(
    "ACP chunk",
    args,
    (store, entry, text) => store.appendAcpAgentMessageChunk(entry, text),
    chunkText,
  );
}

export async function appendSlotErrorLog(
  args: SlotLogBase,
  errorText: string,
): Promise<void> {
  await appendSlotLog(
    "error",
    args,
    (store, entry, text) => store.appendError(entry, text),
    errorText,
  );
}
