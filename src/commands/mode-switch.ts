import type { AcpSessionModeState } from "../acp/runtime-contract.js";
import { formatJsonRpcLikeError } from "../utils/format-json-rpc-error.js";

function formatModeLine(
  mode: AcpSessionModeState["availableModes"][number],
): string {
  const exact = `\`${mode.modeId}\``;
  const title =
    mode.name && mode.name !== mode.modeId ? `${mode.name} -> ${exact}` : exact;
  return mode.description ? `• ${title} — ${mode.description}` : `• ${title}`;
}

function formatCurrentMode(
  modeState: AcpSessionModeState,
): string | undefined {
  if (!modeState.currentModeId) return undefined;
  const current = modeState.availableModes.find(
    (mode) => mode.modeId === modeState.currentModeId,
  );
  if (current?.name && current.name !== current.modeId) {
    return `当前模式：${current.name}（精确值：\`${current.modeId}\`）`;
  }
  return `当前模式：\`${modeState.currentModeId}\``;
}

function formatAvailableModes(modeState: AcpSessionModeState): string {
  const lines = modeState.availableModes.map((mode) => formatModeLine(mode));
  return ["可用模式 ID：", ...lines].join("\n");
}

export function resolveSessionModeInput(
  raw: string,
  modeState: AcpSessionModeState | undefined,
): { modeId: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("模式 ID 不能为空。");
  }
  const availableModes = modeState?.availableModes ?? [];
  if (availableModes.length === 0) {
    return { modeId: trimmed };
  }
  const exact = availableModes.find((mode) => mode.modeId === trimmed);
  if (exact) {
    return { modeId: exact.modeId };
  }
  const folded = availableModes.filter(
    (mode) => mode.modeId.toLowerCase() === trimmed.toLowerCase(),
  );
  if (folded.length === 1) {
    return { modeId: folded[0]!.modeId };
  }
  return { modeId: trimmed };
}

export function formatModeUsage(
  modeState?: AcpSessionModeState,
): string {
  const body = ["用法：`/mode <模式ID>`"];
  if (!modeState || modeState.availableModes.length === 0) {
    body.push("", "常见模式：`agent`、`plan`、`ask`（以当前 ACP session 返回的列表为准）。");
    return body.join("\n");
  }
  body.push("", formatAvailableModes(modeState));
  const current = formatCurrentMode(modeState);
  if (current) {
    body.push(current);
  }
  return body.join("\n");
}

export function formatModeSwitchFailure(
  err: unknown,
  modeState?: AcpSessionModeState,
): string {
  const body = [`❌ 切换模式失败:\n${formatJsonRpcLikeError(err)}`];
  if (!modeState || modeState.availableModes.length === 0) {
    return body.join("");
  }
  body.push(`\n\n${formatAvailableModes(modeState)}`);
  const current = formatCurrentMode(modeState);
  if (current) {
    body.push(`\n${current}`);
  }
  return body.join("");
}
