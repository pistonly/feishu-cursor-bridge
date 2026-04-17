import type { Config } from "../config/index.js";
import type { FeishuBot, FeishuMessage } from "../feishu/bot.js";

export const NO_SESSION_HINT =
  "当前没有可用的 session。请先发送 `/new list` 查看工作区列表，再用 `/new <序号>` 或 `/new <目录绝对路径>` 创建 session。\n\n发送 `/commands`、`/help` 或只发 `/`（全角 `／` 亦可）可查看本桥接支持的全部命令，**无需先建 session**。";

type BridgeDebugConfig = Pick<Config, "bridgeDebug">;

type BridgeMessagePreprocessBot = Pick<
  FeishuBot,
  | "getGroupMentionIgnoredDebug"
  | "isBotMentioned"
  | "isPairUserBotGroup"
  | "stripBotMention"
  | "stripBotMentionKeepLines"
>;

type BridgeResourcePromptBot = Pick<
  FeishuBot,
  "downloadIncomingResourceToWorkspace"
>;

export interface BridgeMessagePreprocessDeps {
  config: BridgeDebugConfig;
  feishuBot: BridgeMessagePreprocessBot;
}

export interface BridgeResourcePromptDeps {
  feishuBot: BridgeResourcePromptBot;
}

export interface MessageHandlerContext {
  msg: FeishuMessage;
  content: string;
  contentMultiline: string;
  hasIncomingResource: boolean;
  hasPostEmbeddedImages: boolean;
}
