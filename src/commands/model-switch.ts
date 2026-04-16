import type { AcpSessionModelState } from "../acp/runtime-contract.js";
import { formatJsonRpcLikeError } from "../utils/format-json-rpc-error.js";

const CLAUDE_MODEL_SELECTOR_HINT =
  "Claude backend 也支持类似 `claude-opus-4-6/high` 的 selector。";

export interface ModelSwitchFormatOptions {
  /** 列表带【序号】并提示可用 `/model <n>` */
  numbered?: boolean;
}

function formatModelLine(
  model: AcpSessionModelState["availableModels"][number],
  index1Based?: number,
): string {
  const exact = `\`${model.modelId}\``;
  const badge =
    index1Based != null && index1Based >= 1 ? `【${index1Based}】` : "";
  if (model.name && model.name !== model.modelId) {
    return `• ${badge}${model.name} -> ${exact}`;
  }
  return `• ${badge}${exact}`;
}

function formatCurrentModel(
  modelState: AcpSessionModelState,
): string | undefined {
  if (!modelState.currentModelId) return undefined;
  const current = modelState.availableModels.find(
    (model) => model.modelId === modelState.currentModelId,
  );
  if (current?.name && current.name !== current.modelId) {
    return `当前模型：${current.name}（精确值：\`${current.modelId}\`）`;
  }
  return `当前模型：\`${modelState.currentModelId}\``;
}

function formatAvailableModels(
  modelState: AcpSessionModelState,
  options?: ModelSwitchFormatOptions,
): string {
  const numbered = options?.numbered === true;
  const header = numbered
    ? "可用模型（`【n】` 为序号，可直接 `/model n`；亦可完整复制反引号内精确值）："
    : "可用模型 ID（请完整复制反引号中的值；若带 `[]` 或参数后缀也要一并带上）：";
  const lines = modelState.availableModels.map((model, i) =>
    formatModelLine(model, numbered ? i + 1 : undefined),
  );
  return [header, ...lines].join("\n");
}

/**
 * 将用户输入的 `/model` 参数解析为可提交给 `session/set_model` 的精确模型值。
 * 纯数字参数按 1-based 序号映射到当前会话缓存的 `availableModels`；非数字原样返回。
 */
export function resolveModelSelectorInput(
  raw: string,
  modelState: AcpSessionModelState | undefined,
): { modelId: string; pickedByIndex?: number } {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { modelId: trimmed };
  }
  const n = Number.parseInt(trimmed, 10);
  const list = modelState?.availableModels ?? [];
  if (list.length === 0) {
    throw new Error(
      "当前会话尚无可用模型列表。请先在本 slot 完成一轮对话（或确保 session 已建立），再使用序号；也可直接使用完整模型 ID / selector。",
    );
  }
  if (n < 1 || n > list.length) {
    throw new Error(`序号 ${n} 无效；当前可用范围为 1–${list.length}。`);
  }
  const modelId = list[n - 1]!.modelId;
  return { modelId, pickedByIndex: n };
}

export function formatModelUsage(
  modelState?: AcpSessionModelState,
  options?: ModelSwitchFormatOptions,
): string {
  const body = [options?.numbered ? "用法：`/model <模型ID或序号>`" : "用法：`/model <模型ID>`"];
  if (!modelState || modelState.availableModels.length === 0) {
    body.push(
      "",
      "可先在当前会话完成一轮对话，或在本机查看对应 ACP 后端支持的模型列表。",
      CLAUDE_MODEL_SELECTOR_HINT,
    );
    return body.join("\n");
  }
  body.push("", formatAvailableModels(modelState, options));
  const current = formatCurrentModel(modelState);
  if (current) {
    body.push(current);
  }
  body.push(CLAUDE_MODEL_SELECTOR_HINT);
  return body.join("\n");
}

export function formatModelSwitchFailure(
  err: unknown,
  modelState?: AcpSessionModelState,
  options?: ModelSwitchFormatOptions,
): string {
  const body = [`❌ 切换模型失败:\n${formatJsonRpcLikeError(err)}`];
  if (!modelState || modelState.availableModels.length === 0) {
    return body.join("");
  }
  body.push(`\n\n${formatAvailableModels(modelState, options)}`);
  const current = formatCurrentModel(modelState);
  if (current) {
    body.push(`\n${current}`);
  }
  return body.join("");
}
