import {
  FEISHU_INCOMING_DIR_NAME,
  type FeishuIncomingResource,
  type FeishuMessage,
} from "../feishu/bot.js";
import type { UserSession } from "../session/manager.js";
import { formatJsonRpcLikeError } from "../utils/format-json-rpc-error.js";
import type { BridgeResourcePromptDeps } from "./bridge-context.js";

function formatIncomingAttachmentPrompt(
  relativePath: string,
  res: FeishuIncomingResource,
): string {
  const kindLabel =
    res.messageKind === "image"
      ? "图片"
      : res.messageKind === "audio"
        ? "音频"
        : res.messageKind === "video"
          ? "视频"
          : "文件";
  const lines: string[] = [
    `用户通过飞书发送了${kindLabel}，已保存到工作区子目录 \`${FEISHU_INCOMING_DIR_NAME}/\`。`,
    "",
    `相对路径（相对工作区根目录）：\`${relativePath}\``,
  ];
  if (res.displayName) {
    lines.push(`原始文件名：\`${res.displayName}\``);
  }
  lines.push(`（飞书消息类型：${res.messageKind}；资源接口 type=\`${res.apiType}\`）`);
  return lines.join("\n");
}

function formatPostEmbeddedImagesPrompt(
  textBody: string,
  relativePaths: string[],
): string {
  const lines: string[] = [
    `用户发送了飞书富文本（post）消息，其中包含 ${relativePaths.length} 张内嵌图片，已保存到工作区子目录 \`${FEISHU_INCOMING_DIR_NAME}/\`。`,
    "",
  ];
  for (let i = 0; i < relativePaths.length; i += 1) {
    lines.push(`${i + 1}. 相对路径（相对工作区根目录）：\`${relativePaths[i]}\``);
  }
  lines.push("", "（飞书消息类型：post；资源接口 type=\`image\`）");
  const trimmed = textBody.trim();
  if (trimmed) {
    lines.push("", "富文本中的文字内容如下：", "", trimmed);
  }
  return lines.join("\n");
}

export async function resolvePromptContentFromResource(
  deps: BridgeResourcePromptDeps,
  msg: FeishuMessage,
  session: UserSession,
  content: string,
  hasPostEmbeddedImages: boolean,
): Promise<{ ok: true; promptContent: string } | { ok: false; errorText: string }> {
  if (msg.incomingResource) {
    try {
      const { relativePath } = await deps.feishuBot.downloadIncomingResourceToWorkspace(
        msg.messageId,
        msg.incomingResource,
        session.workspaceRoot,
      );
      return {
        ok: true,
        promptContent: formatIncomingAttachmentPrompt(relativePath, msg.incomingResource),
      };
    } catch (error) {
      return {
        ok: false,
        errorText: `❌ 无法下载飞书附件:\n${formatJsonRpcLikeError(error)}`,
      };
    }
  }

  if (hasPostEmbeddedImages && msg.postEmbeddedImageKeys) {
    try {
      const relativePaths: string[] = [];
      for (const imageKey of msg.postEmbeddedImageKeys) {
        const { relativePath } = await deps.feishuBot.downloadIncomingResourceToWorkspace(
          msg.messageId,
          { apiType: "image", fileKey: imageKey, messageKind: "image" },
          session.workspaceRoot,
        );
        relativePaths.push(relativePath);
      }
      return {
        ok: true,
        promptContent: formatPostEmbeddedImagesPrompt(content, relativePaths),
      };
    } catch (error) {
      return {
        ok: false,
        errorText: `❌ 无法下载飞书富文本内嵌图片:\n${formatJsonRpcLikeError(error)}`,
      };
    }
  }

  return { ok: true, promptContent: content };
}
