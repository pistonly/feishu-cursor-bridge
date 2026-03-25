# 飞书-Cursor 桥接服务

独立服务，通过飞书机器人控制 Cursor AI Agent。基于 Cursor ACP (Agent Client Protocol) 协议。

## 功能特性

- 飞书消息自动转发到 Cursor Agent
- Cursor Agent 回复实时流式推送到飞书（通过卡片消息）
- 多用户会话隔离（每个用户独立的 Cursor 会话）
- 群聊支持（@机器人 触发）
- 私聊直接对话
- 内置命令：`/reset` 重置会话，`/status` 查看状态

## 架构

```
飞书用户 ──(WebSocket)──> 飞书 Bot ──> Bridge ──(stdio/JSON-RPC)──> Cursor Agent ACP
                                         ↑                              |
                                         └──── 流式响应(卡片更新) <─────┘
```

## 前置条件

1. 安装 Cursor CLI（`agent` 命令可用）
2. 已通过 `agent login` 完成认证（或配置 API Key）
3. 创建飞书企业自建应用，开通机器人能力
4. 飞书应用权限：`im:message`、`im:message:send_as_bot`、`im:chat`

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env 填入你的配置

# 3. 开发模式运行
npm run dev

# 4. 编译并运行
npm run build
npm start
```

## 环境变量说明

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `FEISHU_APP_ID` | 飞书应用的 App ID（必填） | - |
| `FEISHU_APP_SECRET` | 飞书应用的 App Secret（必填） | - |
| `FEISHU_DOMAIN` | 飞书域名：`feishu` / `lark` / 自定义 URL | `feishu` |
| `CURSOR_AGENT_PATH` | Cursor Agent 二进制路径 | `agent`（使用 PATH 查找） |
| `CURSOR_API_KEY` | Cursor API Key（可选） | - |
| `CURSOR_AUTH_TOKEN` | Cursor Auth Token（可选） | - |
| `CURSOR_WORK_DIR` | Cursor 工作目录 | 当前目录 |
| `AUTO_APPROVE_PERMISSIONS` | 自动批准所有权限请求 | `true` |
| `LOG_LEVEL` | 日志级别：`debug` / `info` / `warn` / `error` | `info` |

## 使用方式

- **私聊机器人**：直接发送消息
- **群聊中**：@机器人 + 消息内容
- 发送 `/reset` 重置会话
- 发送 `/status` 查看服务状态

## 技术栈

- **Cursor ACP** (Agent Client Protocol) - JSON-RPC 2.0 over stdio
- **飞书开放平台 SDK** (@larksuiteoapi/node-sdk)
- **TypeScript + Node.js**
