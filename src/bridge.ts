import type { Config } from "./config.js";
import { AcpRuntime } from "./acp/runtime.js";
import { FeishuBridgeClient } from "./acp/feishu-bridge-client.js";
import { formatJsonRpcLikeError } from "./format-json-rpc-error.js";
import { FeishuBot, type FeishuMessage } from "./feishu-bot.js";
import { parseNewConversationCommand } from "./parse-new-conversation.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";
import { ConversationService } from "./conversation-service.js";
import { resolveAllowedWorkspaceDir } from "./workspace-policy.js";
import { WorkspacePresetsStore } from "./workspace-presets-store.js";

export class Bridge {
  private config: Config;
  private bridgeClient: FeishuBridgeClient;
  private acpRuntime: AcpRuntime;
  private feishuBot: FeishuBot;
  private sessionStore: SessionStore;
  private sessionManager: SessionManager;
  private presetsStore: WorkspacePresetsStore;
  private conversation: ConversationService;
  /** key: `<sessionKey>:<slotIndex>` — 同一 slot 同一时刻只能有一个 prompt 在跑 */
  private activePrompts = new Set<string>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: Config) {
    this.config = config;
    this.bridgeClient = new FeishuBridgeClient(config);
    this.acpRuntime = new AcpRuntime(config, this.bridgeClient);
    this.sessionStore = new SessionStore(config.bridge.sessionStorePath);
    this.presetsStore = new WorkspacePresetsStore(
      config.bridge.workspacePresetsPath,
    );
    this.sessionManager = new SessionManager(
      this.acpRuntime,
      this.sessionStore,
      config.bridge.sessionIdleTimeoutMs,
      {
        debug: config.bridgeDebug,
        defaultWorkspaceRoot: config.acp.workspaceRoot,
        maxSessionsPerUser: config.bridge.maxSessionsPerUser,
        onSessionWorkspace: (sessionId, root) => {
          this.bridgeClient.setSessionWorkspace(sessionId, root);
        },
        onSessionWorkspaceRemove: (sessionId) => {
          this.bridgeClient.removeSessionWorkspace(sessionId);
        },
      },
    );
    this.feishuBot = new FeishuBot({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      domain: config.feishu.domain,
      bridgeDebug: config.bridgeDebug,
    });
    this.conversation = new ConversationService(
      config,
      this.acpRuntime,
      this.feishuBot,
    );
  }

  async start(): Promise<void> {
    if (this.config.bridgeDebug) {
      console.log(
        "[bridge] BRIDGE_DEBUG=true — 控制台输出 ACP/会话信息；/status 含 session 与路径",
      );
    }

    await this.sessionManager.init();
    await this.presetsStore.load(this.config.bridge.workspacePresetsSeed);

    await this.acpRuntime.start();
    await this.acpRuntime.initializeAndAuth();
    console.log(
      `[bridge] cursor-agent-acp 已连接 protocolVersion=${this.acpRuntime.initializeResult?.protocolVersion} loadSession=${this.acpRuntime.supportsLoadSession}`,
    );

    if (this.config.bridgeDebug) {
      this.bridgeClient.on("acp", (ev) => {
        console.log(`[bridge:debug] acp ${ev.type}`, ev);
      });
    }

    this.feishuBot.on("ready", () => {
      console.log("[bridge] Feishu bot connected and ready");
    });

    this.feishuBot.on("message", (msg: FeishuMessage) => {
      this.handleFeishuMessage(msg).catch((err) => {
        console.error("[bridge] Error handling message:", err);
      });
    });

    await this.feishuBot.start();

    this.cleanupInterval = setInterval(() => {
      void this.sessionManager
        .cleanupExpired()
        .then((cleaned) => {
          if (cleaned > 0) {
            console.log(`[bridge] Cleaned up ${cleaned} expired sessions`);
          }
        })
        .catch((err) => {
          console.error("[bridge] cleanupExpired failed:", err);
        });
    }, 5 * 60 * 1000);

    console.log("[bridge] Service started successfully");
  }

  /** 话题群 / 话题线程内回复需传 `reply_in_thread` */
  private threadReplyOpts(
    msg: FeishuMessage,
  ): { replyInThread: true } | undefined {
    return msg.replyInThread ? { replyInThread: true } : undefined;
  }

  /** 与 SessionManager.makeKey 一致：群聊有 threadId 时按话题隔离会话 */
  private threadScope(msg: FeishuMessage): string | undefined {
    if (msg.chatType !== "group") return undefined;
    const t = msg.threadId?.trim();
    return t || undefined;
  }

  private feishuSessionKey(msg: FeishuMessage): string {
    if (msg.chatType === "p2p") return `dm:${msg.senderId}`;
    const t = this.threadScope(msg);
    if (t) return `${msg.chatId}:t:${t}:${msg.senderId}`;
    return `${msg.chatId}:${msg.senderId}`;
  }

  /**
   * `/topic …` 普通命令：整条消息直接丢弃，不调 SessionManager、不连 ACP、不建 session。
   * 飞书富文本常把 `/topic` 包在 **、`` ` `` 里，行首不是 `/`，需额外判断。
   */
  private shouldIgnoreTopicMessage(msg: FeishuMessage): boolean {
    const raw = msg.content.replace(/\r\n/g, "\n").trim();
    const mentions = msg.mentions;
    for (const lineRaw of raw.split("\n")) {
      const line = this.feishuBot
        .stripBotMentionKeepLines(lineRaw.trim(), mentions)
        .trim();
      if (!line) continue;

      let head = line
        .replace(/^[\uFEFF\u200b-\u200d\u3000\s]+/, "")
        .replace(/^／/, "/")
        .trimStart();
      for (let i = 0; i < 24; i++) {
        const n = head.replace(/^(\*{1,2}|`{1,3}|_{1,2}|~{1,2}|>+|\s)+/, "");
        if (n === head) break;
        head = n.trimStart();
      }
      head = head.replace(/^／/, "/").trimStart();
      if (/^\/topic\b/i.test(head)) {
        console.log("[bridge] /topic ignored — no session, no ACP prompt");
        return true;
      }

      const m = line.match(/\/topic\b/i);
      if (m && m.index !== undefined) {
        const before = line.slice(0, m.index);
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
    // 极短消息：飞书可能把整段包成一句说明 + `` `/topic` ``，上面规则仍够不着
    if (raw.length <= 120 && /\/topic\b/i.test(raw)) {
      console.log(
        "[bridge] /topic ignored (short message, contains /topic) — no session, no ACP prompt",
      );
      return true;
    }
    return false;
  }

  private async handleFeishuMessage(msg: FeishuMessage): Promise<void> {
    if (msg.contentType !== "text" && msg.contentType !== "post") {
      return;
    }

    // 在任何 await、群成员校验、SessionManager、ACP 之前丢弃（整条消息当没看见）
    if (this.shouldIgnoreTopicMessage(msg)) {
      return;
    }

    let content = msg.content.trim();

    if (msg.chatType === "group") {
      const mentioned = this.feishuBot.isBotMentioned(msg);
      const pairUserBot =
        !mentioned && (await this.feishuBot.isPairUserBotGroup(msg.chatId));
      if (!mentioned && !pairUserBot) {
        if (this.config.bridgeDebug) {
          console.log(
            "[bridge:debug] 群消息已收到但未判定为 @ 机器人，已忽略",
            this.feishuBot.getGroupMentionIgnoredDebug(msg),
          );
        }
        return;
      }
      if (this.config.bridgeDebug && pairUserBot) {
        console.log(
          "[bridge:debug] 群为 1 用户 + 1 机器人，免 @ 处理",
          msg.messageId,
        );
      }
      content = this.feishuBot.stripBotMention(content, msg.mentions).trim();
    }

    if (!content) return;

    const newConv = parseNewConversationCommand(content);
    if (newConv) {
      try {
        // ----------------------------------------------------------------
        // /sessions — list all slots
        // ----------------------------------------------------------------
        if (newConv.kind === "sessions") {
          await this.handleSessionsList(msg);
          return;
        }

        // ----------------------------------------------------------------
        // /switch [target]
        // ----------------------------------------------------------------
        if (newConv.kind === "switch") {
          if (newConv.target === null) {
            const slot = await this.sessionManager.switchToPreviousSlot(
              msg.chatId,
              msg.senderId,
              msg.chatType,
              this.threadScope(msg),
            );
            const label = slot.name ? ` (${slot.name})` : "";
            await this.feishuBot.sendText(
              msg.chatId,
              `✅ 已切换到上一个 session #${slot.slotIndex}${label}\n工作区：\`${slot.session.workspaceRoot}\``,
              msg.messageId,
              this.threadReplyOpts(msg),
            );
            if (slot.lastReply) {
              const MAX_CARD_LEN = 28_000;
              let preview = slot.lastReply;
              let truncated = false;
              if (preview.length > MAX_CARD_LEN) {
                preview = preview.slice(0, MAX_CARD_LEN);
                truncated = true;
              }
              const cardContent = `**↩️ Session #${slot.slotIndex}${label} 上一轮回复：**\n\n${preview}${truncated ? "\n\n_（内容过长，已截断）_" : ""}`;
              await this.feishuBot.sendCard(msg.chatId, cardContent);
            }
            return;
          }
          const slot = await this.sessionManager.switchSlot(
            msg.chatId,
            msg.senderId,
            msg.chatType,
            newConv.target,
            this.threadScope(msg),
          );
          const label = slot.name ? ` (${slot.name})` : "";
          await this.feishuBot.sendText(
            msg.chatId,
            `✅ 已切换到 session #${slot.slotIndex}${label}\n工作区：\`${slot.session.workspaceRoot}\``,
            msg.messageId,
            this.threadReplyOpts(msg),
          );
          if (slot.lastReply) {
            const MAX_CARD_LEN = 28_000;
            let preview = slot.lastReply;
            let truncated = false;
            if (preview.length > MAX_CARD_LEN) {
              preview = preview.slice(0, MAX_CARD_LEN);
              truncated = true;
            }
            const cardContent = `**↩️ Session #${slot.slotIndex}${label} 上一轮回复：**\n\n${preview}${truncated ? "\n\n_（内容过长，已截断）_" : ""}`;
            await this.feishuBot.sendCard(msg.chatId, cardContent);
          }
          return;
        }

        // ----------------------------------------------------------------
        // /rename <name>
        // /rename <target> <name>
        // ----------------------------------------------------------------
        if (newConv.kind === "rename") {
          if (
            (typeof newConv.target === "number" && isNaN(newConv.target as number)) ||
            !newConv.name.trim()
          ) {
            await this.feishuBot.sendText(
              msg.chatId,
              "用法：`/rename <新名字>` 或 `/rename <编号或名称> <新名字>`\n\n示例：`/rename backend`、`/rename 2 backend`",
              msg.messageId,
              this.threadReplyOpts(msg),
            );
            return;
          }
          const renamed = await this.sessionManager.renameSlot(
            msg.chatId,
            msg.senderId,
            msg.chatType,
            newConv.target,
            newConv.name,
            this.threadScope(msg),
          );
          await this.feishuBot.sendText(
            msg.chatId,
            `✅ 已将 session #${renamed.slotIndex} 重命名为 \`${renamed.name}\``,
            msg.messageId,
            this.threadReplyOpts(msg),
          );
          return;
        }

        // ----------------------------------------------------------------
        // /close <target>
        // ----------------------------------------------------------------
        if (newConv.kind === "close") {
          if (typeof newConv.target === "number" && isNaN(newConv.target as number)) {
            await this.feishuBot.sendText(
              msg.chatId,
              "用法：`/close <编号或名称>` 或 `/close all`\n\n发送 `/sessions` 查看当前所有 session。",
              msg.messageId,
              this.threadReplyOpts(msg),
            );
            return;
          }
          if (newConv.target === "all") {
            const { closed } = await this.sessionManager.closeAllSlots(
              msg.chatId,
              msg.senderId,
              msg.chatType,
              this.threadScope(msg),
            );
            const summary = closed
              .map((s) => {
                const lab = s.name ? ` (${s.name})` : "";
                return `#${s.slotIndex}${lab}`;
              })
              .join("、");
            await this.feishuBot.sendText(
              msg.chatId,
              `✅ 已关闭本组全部 ${closed.length} 个 session：${summary}\n\n已释放全局配额；下次发消息会新建 session。`,
              msg.messageId,
              this.threadReplyOpts(msg),
            );
            return;
          }
          const { closed, removedEntireGroup } = await this.sessionManager.closeSlot(
            msg.chatId,
            msg.senderId,
            msg.chatType,
            newConv.target,
            this.threadScope(msg),
          );
          const label = closed.name ? ` (${closed.name})` : "";
          const tail = removedEntireGroup
            ? "\n\n该聊天/话题下已无 session，已释放全局配额；下次发消息会新建 session。"
            : "";
          await this.feishuBot.sendText(
            msg.chatId,
            `✅ 已关闭 session #${closed.slotIndex}${label}${tail}`,
            msg.messageId,
            this.threadReplyOpts(msg),
          );
          return;
        }

        // ----------------------------------------------------------------
        // /new — workspace presets list management (no session creation)
        // ----------------------------------------------------------------
        if (newConv.kind === "new") {
          if (newConv.variant === "list") {
            const presets = this.presetsStore.getPresets();
            const lines =
              presets.length > 0
                ? presets.map((p, i) => `${i + 1}. \`${p}\``).join("\n")
                : "（尚为空）";
            await this.feishuBot.sendText(
              msg.chatId,
              `📋 工作区快捷列表（使用 \`/new <序号>\` 新建并切换）。\n\n${lines}\n\n添加：\`/new add-list <路径>\`\n删除：\`/new remove-list <序号>\``,
              msg.messageId,
              this.threadReplyOpts(msg),
            );
            return;
          }
          if (newConv.variant === "remove-list") {
            if (newConv.index < 1) {
              await this.feishuBot.sendText(
                msg.chatId,
                "用法：`/new remove-list <序号>`（序号见 `/new list`）",
                msg.messageId,
                this.threadReplyOpts(msg),
              );
              return;
            }
            const removed = await this.presetsStore.removePresetAt(
              newConv.index,
            );
            const list = this.presetsStore.getPresets();
            const lines = list.map((p, i) => `${i + 1}. \`${p}\``).join("\n");
            await this.feishuBot.sendText(
              msg.chatId,
              removed
                ? `✅ 已删除序号 ${newConv.index}。\n\n${list.length ? lines : "（列表已空）"}`
                : `❌ 无序号 ${newConv.index}。请先 \`/new list\` 查看当前列表。`,
              msg.messageId,
              this.threadReplyOpts(msg),
            );
            return;
          }
          if (newConv.variant === "add-list") {
            if (!newConv.path.trim()) {
              await this.feishuBot.sendText(
                msg.chatId,
                "用法：`/new add-list <目录路径>`",
                msg.messageId,
                this.threadReplyOpts(msg),
              );
              return;
            }
            const abs = await resolveAllowedWorkspaceDir(
              newConv.path,
              this.config,
            );
            const added = await this.presetsStore.addPreset(abs);
            const list = this.presetsStore.getPresets();
            const lines = list.map((p, i) => `${i + 1}. \`${p}\``).join("\n");
            await this.feishuBot.sendText(
              msg.chatId,
              added
                ? `✅ 已加入列表。\n\n${lines}`
                : `ℹ️ 该路径已在列表中，未重复添加。\n\n${lines}`,
              msg.messageId,
              this.threadReplyOpts(msg),
            );
            return;
          }
        }

        // ----------------------------------------------------------------
        // /new (default / workspace / preset) — create new slot
        // /reset — reset active slot
        // ----------------------------------------------------------------
        let workspaceAbs: string | undefined;
        let slotName: string | undefined;

        if (newConv.kind === "reset") {
          if (newConv.path) {
            workspaceAbs = await resolveAllowedWorkspaceDir(
              newConv.path,
              this.config,
            );
          }
        } else if (newConv.kind === "new") {
          slotName = newConv.name;
          switch (newConv.variant) {
            case "default":
              break;
            case "workspace":
              workspaceAbs = await resolveAllowedWorkspaceDir(
                newConv.path,
                this.config,
              );
              break;
            case "preset": {
              const idx = newConv.index;
              if (idx < 1) {
                await this.feishuBot.sendText(
                  msg.chatId,
                  "❌ 序号须为 ≥1 的整数。",
                  msg.messageId,
                  this.threadReplyOpts(msg),
                );
                return;
              }
              const p = this.presetsStore.getByIndex(idx);
              if (!p) {
                await this.feishuBot.sendText(
                  msg.chatId,
                  `❌ 列表中无序号 ${idx}。请先发送 \`/new list\` 查看。`,
                  msg.messageId,
                  this.threadReplyOpts(msg),
                );
                return;
              }
              workspaceAbs = await resolveAllowedWorkspaceDir(p, this.config);
              break;
            }
            default:
              return;
          }
        }

        if (newConv.kind === "reset") {
          await this.sessionManager.resetSession(
            msg.chatId,
            msg.senderId,
            msg.chatType,
            workspaceAbs,
            this.threadScope(msg),
          );
          const cwdLine = workspaceAbs ?? this.config.acp.workspaceRoot;
          await this.feishuBot.sendText(
            msg.chatId,
            `✅ 当前 session 已重置，工作区：\n\`${cwdLine}\``,
            msg.messageId,
            this.threadReplyOpts(msg),
          );
        } else {
          // /new — create a new slot and auto-switch
          const result = await this.sessionManager.createNewSlot(
            msg.chatId,
            msg.senderId,
            msg.chatType,
            workspaceAbs,
            slotName,
            this.threadScope(msg),
          );
          const nameLabel = result.name ? ` (${result.name})` : "";
          await this.feishuBot.sendText(
            msg.chatId,
            `✅ 已新建并切换到 session #${result.slotIndex}${nameLabel}\n工作区：\`${result.workspaceRoot}\`\n\n发送 \`/sessions\` 查看所有 session。`,
            msg.messageId,
            this.threadReplyOpts(msg),
          );
        }
      } catch (e) {
        await this.feishuBot.sendText(
          msg.chatId,
          `❌ ${e instanceof Error ? e.message : String(e)}`,
          msg.messageId,
          this.threadReplyOpts(msg),
        );
      }
      return;
    }

    const statusTrim = content.trim();
    if (
      statusTrim === "/状态" ||
      statusTrim.toLowerCase() === "/status"
    ) {
      const stats = this.sessionManager.getStats();
      const snap = this.sessionManager.getSessionSnapshot(
        msg.chatId,
        msg.senderId,
        msg.chatType,
        this.threadScope(msg),
      );
      const cliResume = snap?.activeSlot.session.cursorCliChatId;
      let body = `📊 活跃/内存 slot: ${stats.active}/${stats.total}`;
      body += cliResume
        ? `\n• CLI resume ID：\`${cliResume}\`\n  （与本机 \`cursor-agent\` 的 \`--resume\` 参数一致，便于 PC 接手同一对话）`
        : `\n• CLI resume ID：暂无（尚无活跃会话、或适配器未返回 / create-chat 失败）`;
      if (this.config.bridgeDebug) {
        const idleLabel = snap
          ? snap.idleExpiresInMs === null
            ? "永不过期"
            : `${Math.round(snap.idleExpiresInMs / 60_000)} 分钟`
          : "—";
        const slot = snap?.activeSlot;
        body += `\n\n[调试 BRIDGE_DEBUG]\n• sessionKey: ${snap?.sessionKey ?? "(尚无)"}\n• threadId: ${this.threadScope(msg) ?? "（主会话区）"}\n• 活跃 slot: #${slot?.slotIndex ?? "—"}${slot?.name ? ` (${slot.name})` : ""}\n• ACP sessionId: ${slot?.session.sessionId ?? "—"}\n• 会话 cwd: ${slot?.session.workspaceRoot ?? "—"}\n• 空闲过期约: ${idleLabel}\n• 默认工作区 (CURSOR_WORK_DIR): ${this.config.acp.workspaceRoot}\n• 允许根 (CURSOR_WORK_ALLOWLIST): ${this.config.acp.allowedWorkspaceRoots.join(", ")}\n• 适配器会话目录: ${this.config.acp.adapterSessionDir}\n• 映射文件: ${this.config.bridge.sessionStorePath}\n• loadSession: ${this.acpRuntime.supportsLoadSession}\n• LOG_LEVEL: ${this.config.logLevel}`;
      }
      await this.feishuBot.sendText(msg.chatId, body, msg.messageId, this.threadReplyOpts(msg));
      return;
    }

    // cursor-agent-acp 在 prompt 里识别 /model 后仍会把整句发给 CLI，导致大模型「解释命令」。
    // 这里直接走 session/set_model，不触发 prompt。
    const modelMatch = content.trim().match(/^\/model(?:\s+(\S+))?$/i);
    if (modelMatch) {
      const modelId = modelMatch[1]?.trim();
      if (!modelId) {
        await this.feishuBot.sendText(
          msg.chatId,
          "用法：`/model <模型ID>`\n\n可在本机终端执行 `cursor-agent models` 查看可用 ID。",
          msg.messageId,
          this.threadReplyOpts(msg),
        );
        return;
      }
      try {
        const session = await this.sessionManager.getOrCreateSession(
          msg.chatId,
          msg.senderId,
          msg.chatType,
          this.threadScope(msg),
        );
        await this.acpRuntime.setSessionModel(session.sessionId, modelId);
        await this.feishuBot.sendText(
          msg.chatId,
          `✅ 已切换模型为 \`${modelId}\`（后续对话将使用该模型）。`,
          msg.messageId,
          this.threadReplyOpts(msg),
        );
      } catch (err) {
        await this.feishuBot.sendText(
          msg.chatId,
          `❌ 切换模型失败:\n${formatJsonRpcLikeError(err)}`,
          msg.messageId,
          this.threadReplyOpts(msg),
        );
      }
      return;
    }

    // Prompt key is scoped to the active slot so different slots can run in parallel,
    // but the same slot is still serialized.
    const sessionKey = this.feishuSessionKey(msg);

    // Peek at current active slot index for the prompt key
    const snap = this.sessionManager.getSessionSnapshot(
      msg.chatId,
      msg.senderId,
      msg.chatType,
      this.threadScope(msg),
    );
    const promptKey = snap
      ? `${sessionKey}:${snap.activeSlot.slotIndex}`
      : sessionKey;

    if (this.activePrompts.has(promptKey)) {
      await this.feishuBot.sendText(
        msg.chatId,
        "⏳ 上一个请求还在处理中，请稍候...",
        msg.messageId,
        this.threadReplyOpts(msg),
      );
      return;
    }

    try {
      this.activePrompts.add(promptKey);

      const session = await this.sessionManager.getOrCreateSession(
        msg.chatId,
        msg.senderId,
        msg.chatType,
        this.threadScope(msg),
      );

      const msgForPrompt: FeishuMessage = {
        ...msg,
        content,
      };

      const lastReply = await this.conversation.handleUserPrompt(msgForPrompt, session);
      if (lastReply) {
        this.sessionManager.setSlotLastReply(
          msg.chatId,
          msg.senderId,
          msg.chatType,
          session.sessionId,
          lastReply,
          this.threadScope(msg),
        );
      }
    } catch (err) {
      console.error(
        `[bridge] Error processing message from ${msg.senderId}:`,
        err,
      );
      await this.feishuBot
        .sendText(
          msg.chatId,
          `❌ 处理出错: ${err instanceof Error ? err.message : String(err)}`,
          msg.messageId,
          this.threadReplyOpts(msg),
        )
        .catch(() => {});
    } finally {
      this.activePrompts.delete(promptKey);
    }
  }

  private async handleSessionsList(msg: FeishuMessage): Promise<void> {
    const slots = await this.sessionManager.listSlots(
      msg.chatId,
      msg.senderId,
      msg.chatType,
      this.threadScope(msg),
    );
    if (slots.length === 0) {
      await this.feishuBot.sendText(
        msg.chatId,
        "当前没有任何 session。发送任意消息自动创建。",
        msg.messageId,
        this.threadReplyOpts(msg),
      );
      return;
    }
    const lines = slots.map((s) => {
      const active = s.isActive ? " ◀ 当前" : "";
      const name = s.name ? ` (${s.name})` : "";
      return `#${s.slotIndex}${name}${active}\n  工作区：\`${s.workspaceRoot}\``;
    });
    await this.feishuBot.sendText(
      msg.chatId,
      `📋 当前所有 session（共 ${slots.length} 个；# 为槽位编号，关闭后不会复用，故可能与数量连续不一致）：\n\n${lines.join("\n\n")}\n\n• \`/new\` — 新建 session\n• \`/switch <编号或名称>\` — 切换\n• \`/rename <新名字>\` — 重命名当前 session\n• \`/rename <编号或名称> <新名字>\` — 重命名指定 session\n• \`/close <编号或名称>\` — 关闭\n• \`/close all\` — 关闭本组全部\n• \`/reset\` — 重置当前 session\n• \`/topic …\` — 仅发飞书、不发给 Agent（便于话题内写标题）`,
      msg.messageId,
      this.threadReplyOpts(msg),
    );
  }

  async stop(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    await this.feishuBot.stop();
    await this.acpRuntime.stop();
    console.log("[bridge] Service stopped");
  }
}
