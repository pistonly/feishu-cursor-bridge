/**
 * 飞书 `/fileback`：在发往 Agent 之前把用户正文包上一层 `FEISHU_SEND_FILE` 机制说明，
 * 减少用户每次都手动教模型的成本。
 */

export const FILEBACK_USAGE_TEXT =
  "用法：`/fileback <你的任务说明>`\n\n桥接会把你的说明发给 Agent，并在前面附带如何通过 `FEISHU_SEND_FILE:` 单行指令把**工作区内文件**发到飞书的说明。\n\n支持多行：命令后可换行继续写需求。";

const FEISHU_FILEBACK_AGENT_WRAP_PREFIX =
  "[飞书桥接 /fileback] 用户希望通过飞书收到工作区内的文件。请完成下列任务；若需把生成的或已有的文件发给用户，在回复正文中**单独一行**写出（多个文件则多行）：\n" +
  "FEISHU_SEND_FILE: <相对当前工作区根的路径，或工作区内的绝对路径>\n" +
  "该行会在飞书卡片展示前被移除，并由桥接调用飞书上传接口实际发送；单文件<=30MB、不得为空；路径必须落在当前会话工作区内。\n" +
  "---\n";

export function parseFilebackUserMessage(content: string):
  | { kind: "not-fileback" }
  | { kind: "usage" }
  | { kind: "prompt"; inner: string } {
  const raw = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  if (!raw) return { kind: "not-fileback" };

  const head = raw
    .replace(/^[\uFEFF\u200b-\u200d\u3000\s]+/, "")
    .replace(/^／/, "/")
    .trimStart();

  if (!/^\/fileback\b/i.test(head)) {
    return { kind: "not-fileback" };
  }

  const afterCmd = head.replace(/^\/fileback\b\s*/i, "");
  if (!afterCmd.trim()) {
    return { kind: "usage" };
  }
  return { kind: "prompt", inner: afterCmd };
}

export function wrapFilebackPromptForAgent(inner: string): string {
  return `${FEISHU_FILEBACK_AGENT_WRAP_PREFIX}\n${inner}`;
}
