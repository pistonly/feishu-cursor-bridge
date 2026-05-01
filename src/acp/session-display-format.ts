import type {
  AcpBackend,
  AcpSessionModeState,
  AcpSessionModelState,
  AcpSessionUsageState,
} from "./runtime-contract.js";

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1).replace(/\.0$/, "")}%`;
}

export function formatSessionUsage(
  usage: AcpSessionUsageState | undefined,
): string | undefined {
  if (!usage) return undefined;
  return `${formatPercent(usage.percent)} (${formatNumber(usage.usedTokens)} / ${formatNumber(usage.maxTokens)})`;
}

export function formatSessionUsageLabel(backend: AcpBackend | undefined): string {
  return backend === "codex-app-server" ? "Context 近似用量" : "Context 用量";
}

export function formatSessionUsageStatusSegment(
  backend: AcpBackend | undefined,
  usage: AcpSessionUsageState | undefined,
): string | undefined {
  const formatted = formatSessionUsage(usage);
  if (!formatted) return undefined;
  return backend === "codex-app-server" ? `约 ${formatted}` : formatted;
}

export function formatSessionModelLabel(
  modelState: AcpSessionModelState | undefined,
): string | undefined {
  if (!modelState?.currentModelId) return undefined;
  const current = modelState.availableModels.find(
    (model) => model.modelId === modelState.currentModelId,
  );
  if (current?.name && current.name !== current.modelId) {
    return current.name;
  }
  return `\`${modelState.currentModelId}\``;
}

export function formatCurrentModelLine(
  modelState: AcpSessionModelState | undefined,
): string | undefined {
  if (!modelState?.currentModelId) return undefined;
  const current = modelState.availableModels.find(
    (model) => model.modelId === modelState.currentModelId,
  );
  if (current?.name && current.name !== current.modelId) {
    return `当前模型：${current.name}（精确值：\`${current.modelId}\`）`;
  }
  return `当前模型：\`${modelState.currentModelId}\``;
}

export function formatCurrentModeLine(
  modeState: AcpSessionModeState | undefined,
): string | undefined {
  if (!modeState?.currentModeId) return undefined;
  const current = modeState.availableModes.find(
    (mode) => mode.modeId === modeState.currentModeId,
  );
  if (current?.name && current.name !== current.modeId) {
    return `当前模式：${current.name}（精确值：\`${current.modeId}\`）`;
  }
  return `当前模式：\`${modeState.currentModeId}\``;
}
