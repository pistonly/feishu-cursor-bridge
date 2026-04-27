import type { FeishuMessage } from "../feishu/bot.js";
import type {
  BridgeMessagePreprocessDeps,
  MessageHandlerContext,
} from "./bridge-context.js";

function shouldIgnoreTopicMessage(
  deps: BridgeMessagePreprocessDeps,
  msg: FeishuMessage,
): boolean {
  const raw = msg.content.replace(/\r\n/g, "\n").trim();
  const mentions = msg.mentions;
  for (const lineRaw of raw.split("\n")) {
    const line = deps.feishuBot
      .stripBotMentionKeepLines(lineRaw.trim(), mentions)
      .trim();
    if (!line) continue;

    let head = line
      .replace(/^[\uFEFF\u200b-\u200d\u3000\s]+/, "")
      .replace(/^／/, "/")
      .trimStart();
    for (let i = 0; i < 24; i += 1) {
      const next = head.replace(/^((\*{1,2})|(`{1,3})|(_{1,2})|(~{1,2})|>+|\s)+/, "");
      if (next === head) break;
      head = next.trimStart();
    }
    head = head.replace(/^／/, "/").trimStart();
    if (/^\/topic\b/i.test(head)) {
      console.log("[bridge] /topic ignored — no session, no ACP prompt");
      return true;
    }

    const match = line.match(/\/topic\b/i);
    if (match?.index !== undefined) {
      const before = line.slice(0, match.index);
      if (
        !/[\u4e00-\u9fff]/.test(before) &&
        /^[\s`*_~>"'（）【】\[\]\\\-+/=|.,:;!?]*$/.test(before)
      ) {
        console.log(
          "[bridge] /topic ignored (wrapped in markdown, no text before /topic) — no session, no ACP prompt",
        );
        return true;
      }
    }
  }

  return false;
}

export async function preprocessBridgeMessage(
  deps: BridgeMessagePreprocessDeps,
  msg: FeishuMessage,
): Promise<MessageHandlerContext | null> {
  const hasIncomingResource = msg.incomingResource != null;
  const hasPostEmbeddedImages = (msg.postEmbeddedImageKeys?.length ?? 0) > 0;
  if (
    msg.contentType !== "text" &&
    msg.contentType !== "post" &&
    !hasIncomingResource
  ) {
    return null;
  }

  if (shouldIgnoreTopicMessage(deps, msg)) {
    return null;
  }

  let content = msg.content.trim();
  let contentMultiline = content;

  if (msg.chatType === "group") {
    const mentioned = deps.feishuBot.isBotMentioned(msg);
    const pairUserBot =
      !mentioned && (await deps.feishuBot.isPairUserBotGroup(msg.chatId));
    if (!mentioned && !pairUserBot) {
      if (deps.config.bridgeDebug) {
        console.log(
          "[bridge:debug] 群消息已收到但未判定为 @ 机器人，已忽略",
          deps.feishuBot.getGroupMentionIgnoredDebug(msg),
        );
      }
      return null;
    }
    if (deps.config.bridgeDebug && pairUserBot) {
      console.log("[bridge:debug] 群为 1 用户 + 1 机器人，免 @ 处理", msg.messageId);
    }
    contentMultiline = deps.feishuBot
      .stripBotMentionKeepLines(content, msg.mentions)
      .trim();
    content = deps.feishuBot.stripBotMention(content, msg.mentions).trim();
  }

  if (!content) return null;

  return {
    msg,
    content,
    contentMultiline,
    hasIncomingResource,
    hasPostEmbeddedImages,
  };
}
