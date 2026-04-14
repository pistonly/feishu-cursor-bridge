import type { ToolKind } from "@agentclientprotocol/sdk";

const TOOL_KIND_EMOJI: Record<ToolKind, string> = {
  read: "📖",
  edit: "✏️",
  delete: "🗑️",
  move: "📦",
  search: "🔍",
  execute: "⚡",
  think: "💭",
  fetch: "🌐",
  switch_mode: "🎛️",
  other: "🔧",
};

/** ACP `ToolKind` → 飞书工具行前缀；无 kind 时用 🔧。 */
export function emojiForToolKind(kind: ToolKind | undefined): string {
  return kind ? TOOL_KIND_EMOJI[kind] : "🔧";
}
