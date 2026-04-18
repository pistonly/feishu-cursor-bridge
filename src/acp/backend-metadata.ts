import type { AcpBackend } from "./runtime-contract.js";

export interface BackendMetadata {
  id: AcpBackend;
  label: string;
  description: string;
  preferredShortcut: string;
  commandAliases: readonly string[];
  configAliases: readonly string[];
  documentedFlagValues: readonly string[];
}

export const BACKEND_METADATA = [
  {
    id: "cursor-official",
    label: "Cursor 官方 ACP",
    description: "Cursor 官方 ACP 后端",
    preferredShortcut: "cur",
    commandAliases: ["cursor-official", "official", "cur"],
    configAliases: ["cursor-official", "official"],
    documentedFlagValues: ["official", "cur"],
  },
  {
    id: "cursor-legacy",
    label: "第三方 Cursor ACP 适配器",
    description: "内嵌适配器后端",
    preferredShortcut: "legacy",
    commandAliases: ["cursor-legacy", "legacy"],
    configAliases: ["cursor-legacy", "legacy"],
    documentedFlagValues: ["legacy"],
  },
  {
    id: "claude",
    label: "Claude Code（claude-agent-acp）",
    description: "Claude AI 后端",
    preferredShortcut: "cc",
    commandAliases: ["claude", "cc"],
    configAliases: ["claude"],
    documentedFlagValues: ["claude", "cc"],
  },
  {
    id: "codex",
    label: "Codex（@zed-industries/codex-acp）",
    description: "Codex ACP 后端",
    preferredShortcut: "cx",
    commandAliases: ["codex", "cx"],
    configAliases: ["codex"],
    documentedFlagValues: ["codex", "cx"],
  },
] as const satisfies readonly BackendMetadata[];

export const ACP_BACKENDS = BACKEND_METADATA.map((metadata) => metadata.id) as readonly AcpBackend[];

const BACKEND_METADATA_BY_ID = new Map<AcpBackend, BackendMetadata>(
  BACKEND_METADATA.map((metadata) => [metadata.id, metadata]),
);

function buildAliasMap(
  key: "commandAliases" | "configAliases",
): Readonly<Record<string, AcpBackend>> {
  return Object.freeze(
    Object.fromEntries(
      BACKEND_METADATA.flatMap((metadata) =>
        metadata[key].map((alias) => [alias.toLowerCase(), metadata.id] as const),
      ),
    ) as Record<string, AcpBackend>,
  );
}

function formatCodeList(values: readonly string[], separator = " / "): string {
  return values.map((value) => `\`${value}\``).join(separator);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

const DOCUMENTED_BACKEND_FLAG_VALUES = [
  "official",
  "cur",
  "legacy",
  "claude",
  "codex",
  "cc",
  "cx",
] as const;

export const COMMAND_BACKEND_ALIAS_MAP = buildAliasMap("commandAliases");
export const CONFIG_BACKEND_ALIAS_MAP = buildAliasMap("configAliases");

export function getBackendMetadata(backend: AcpBackend): BackendMetadata {
  const metadata = BACKEND_METADATA_BY_ID.get(backend);
  if (!metadata) {
    throw new Error(`Unknown ACP backend: ${backend}`);
  }
  return metadata;
}

export function getBackendShortcut(backend: AcpBackend): string {
  return getBackendMetadata(backend).preferredShortcut;
}

export function parseBackendAlias(
  raw: string | undefined,
  aliasMap: Readonly<Record<string, AcpBackend>>,
): AcpBackend | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return undefined;
  return aliasMap[normalized];
}

export function formatSupportedBackendValues(separator = " / "): string {
  return formatCodeList(ACP_BACKENDS, separator);
}

export function formatSupportedBackendValuePattern(): string {
  return ACP_BACKENDS.join("|");
}

export function formatSupportedBackendFlagValuePattern(): string {
  return DOCUMENTED_BACKEND_FLAG_VALUES.join("|");
}

export function formatPreferredBackendShortcuts(separator = " / "): string {
  return formatCodeList(
    BACKEND_METADATA.map((metadata) => metadata.preferredShortcut),
    separator,
  );
}

export function formatCompatibleBackendAliases(separator = " / "): string {
  return formatCodeList(["official"], separator);
}

export function buildBackendDescriptionLines(prefix = "• "): string[] {
  return BACKEND_METADATA.map(
    (metadata) => `${prefix}\`${metadata.id}\` - ${metadata.description}`,
  );
}

export function buildBackendCommandSyntaxDocSnippet(): string {
  const backendPattern = formatSupportedBackendValuePattern();
  const backendFlagPattern = formatSupportedBackendFlagValuePattern();
  return [
    "```text",
    `/new <路径> --backend <${backendPattern}>`,
    `/new <序号> --backend <${backendPattern}>`,
    `/new <路径> -b <${backendFlagPattern}>`,
    `/new <序号> -b <${backendFlagPattern}>`,
    "```",
  ].join("\n");
}

export function buildBackendAliasGuideSnippet(): string {
  return `- backend 值支持完整名称，也支持常用简写：\`${getBackendShortcut("cursor-official")}\` = \`cursor-official\`、\`${getBackendShortcut("claude")}\` = \`claude\`、\`${getBackendShortcut("codex")}\` = \`codex\`；\`${getBackendShortcut("cursor-legacy")}\` 继续使用全写，${formatCompatibleBackendAliases()} 仍兼容。`;
}

export function buildReadmeBackendSwitchSnippet(language: "en" | "zh"): string {
  const backendPattern = formatSupportedBackendValuePattern();
  const backendFlagPattern = formatSupportedBackendFlagValuePattern();
  if (language === "en") {
    return `- **Switch backend**: use \`/new <index or path> --backend <${backendPattern}>\` to select the backend for a new session; \`-b <${backendFlagPattern}>\` is also supported. The backend must be included in \`ACP_ENABLED_BACKENDS\`, or it will not be available.`;
  }
  return `- **切换 backend**：可用 \`/new <序号或路径> --backend <${backendPattern}>\` 为新 session 指定 backend；也支持 \`-b <${backendFlagPattern}>\`；但该 backend 必须已包含在 \`ACP_ENABLED_BACKENDS\` 中，否则不会被启动`;
}
