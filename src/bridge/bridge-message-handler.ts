import {
  FILEBACK_USAGE_TEXT,
  parseFilebackUserMessage,
  wrapFilebackPromptForAgent,
} from "../commands/fileback-command.js";
import type { FeishuMessage } from "../feishu/bot.js";
import type { MessageHandlerContext } from "./bridge-context.js";
import { handleBangCommand } from "./bang-command.js";
import { handleBridgeCommand } from "./bridge-command-router.js";
import { handleStatusCommand } from "./bridge-status.js";
import type { BridgeMessageHandlerDeps } from "./bridge-message-handler-types.js";

export type { BridgeMessageHandlerDeps } from "./bridge-message-handler-types.js";

export async function handleBridgeMessage(
  ctx: BridgeMessageHandlerDeps,
  msg: FeishuMessage,
  preprocessed: Pick<
    MessageHandlerContext,
    "content" | "contentMultiline" | "hasPostEmbeddedImages"
  >,
): Promise<void> {
  let {
    content,
    contentMultiline,
    hasPostEmbeddedImages,
  } = preprocessed;
  await ctx.ensureMaintenanceStateLoaded();

  if (await handleBangCommand(ctx, msg, contentMultiline)) {
    return;
  }

  const filebackParsed = parseFilebackUserMessage(content);
  if (filebackParsed.kind === "usage") {
    await ctx.feishuBot.sendText(
      msg.chatId,
      FILEBACK_USAGE_TEXT,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return;
  }
  if (filebackParsed.kind === "prompt") {
    content = wrapFilebackPromptForAgent(filebackParsed.inner);
    contentMultiline = content;
  }

  if (await handleBridgeCommand(ctx, msg, content, contentMultiline)) {
    return;
  }

  if (await handleStatusCommand(ctx, msg, content)) {
    return;
  }

  await ctx.promptCoordinator.handlePromptMessage(
    msg,
    content,
    hasPostEmbeddedImages,
  );
}
