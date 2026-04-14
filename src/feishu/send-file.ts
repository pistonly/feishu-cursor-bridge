import * as path from "node:path";

/** 与飞书 im/v1/files 上传接口的 file_type 一致 */
export type FeishuImFileType =
  | "opus"
  | "mp4"
  | "pdf"
  | "doc"
  | "xls"
  | "ppt"
  | "stream";

export const FEISHU_IM_FILE_MAX_BYTES = 30 * 1024 * 1024;

/**
 * Agent 在助手正文中单独一行输出，回合结束后由桥接解析并发飞书文件消息（该行会从卡片中移除）。
 *
 * 示例：`FEISHU_SEND_FILE: ./dist/report.pdf`
 *
 * 路径可为工作区内相对路径，或已落在工作区内的绝对路径。
 */
export const FEISHU_SEND_FILE_LINE = /^\s*FEISHU_SEND_FILE:\s*(.+?)\s*$/;

export function stripFeishuSendFileDirectives(text: string): {
  cleaned: string;
  rawPaths: string[];
} {
  const rawPaths: string[] = [];
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const m = FEISHU_SEND_FILE_LINE.exec(line);
    if (m) {
      rawPaths.push(m[1]!.trim());
      continue;
    }
    kept.push(line);
  }
  return { cleaned: kept.join("\n"), rawPaths };
}

export function feishuImFileTypeForPath(filePath: string): FeishuImFileType {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".opus":
      return "opus";
    case ".mp4":
    case ".m4v":
      return "mp4";
    case ".pdf":
      return "pdf";
    case ".doc":
    case ".docx":
    case ".wps":
      return "doc";
    case ".xls":
    case ".xlsx":
    case ".csv":
      return "xls";
    case ".ppt":
    case ".pptx":
      return "ppt";
    default:
      return "stream";
  }
}
