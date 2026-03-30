import type { AcpSessionModelState } from "./acp/runtime-contract.js";
import { formatJsonRpcLikeError } from "./format-json-rpc-error.js";

function formatModelLine(model: AcpSessionModelState["availableModels"][number]): string {
  const exact = `\`${model.modelId}\``;
  if (model.name && model.name !== model.modelId) {
    return `• ${model.name} -> ${exact}`;
  }
  return `• ${exact}`;
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

function formatAvailableModels(modelState: AcpSessionModelState): string {
  return [
    "可用模型 ID（请完整复制反引号中的值；若带 `[]` 或参数后缀也要一并带上）：",
    ...modelState.availableModels.map((model) => formatModelLine(model)),
  ].join("\n");
}

export function formatModelUsage(modelState?: AcpSessionModelState): string {
  const body = ["用法：`/model <模型ID>`"];
  if (!modelState || modelState.availableModels.length === 0) {
    body.push("", "可在本机终端执行 `cursor-agent models` 查看可用 ID。");
    return body.join("\n");
  }
  body.push("", formatAvailableModels(modelState));
  const current = formatCurrentModel(modelState);
  if (current) {
    body.push(current);
  }
  return body.join("\n");
}

export function formatModelSwitchFailure(
  err: unknown,
  modelState?: AcpSessionModelState,
): string {
  const body = [`❌ 切换模型失败:\n${formatJsonRpcLikeError(err)}`];
  if (!modelState || modelState.availableModels.length === 0) {
    return body.join("");
  }
  body.push(`\n\n${formatAvailableModels(modelState)}`);
  const current = formatCurrentModel(modelState);
  if (current) {
    body.push(`\n${current}`);
  }
  return body.join("");
}
