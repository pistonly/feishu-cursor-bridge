import * as path from "node:path";
import { atomicWriteJson, readJsonFileWithDefault } from "../utils/json-store.js";

interface PresetsFileV1 {
  version: 1;
  presets: string[];
}

/**
 * 工作区快捷列表（顺序即 `/new 1`、`/new 2` 的编号），持久化为 JSON。
 */
export class WorkspacePresetsStore {
  private readonly filePath: string;
  private data: PresetsFileV1;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    this.data = { version: 1, presets: [] };
  }

  async load(seedFromEnv?: string[]): Promise<void> {
    const parsed = await readJsonFileWithDefault<PresetsFileV1 | null>(
      this.filePath,
      null,
    );
    if (
      parsed?.version === 1 &&
      Array.isArray(parsed.presets) &&
      parsed.presets.every((p) => typeof p === "string")
    ) {
      this.data = parsed;
    }
    if (this.data.presets.length === 0 && seedFromEnv?.length) {
      this.data.presets = [...seedFromEnv];
      await this.flush();
    }
  }

  getPresets(): readonly string[] {
    return this.data.presets;
  }

  /** 追加绝对路径（与已有重复则忽略） */
  async addPreset(absPath: string): Promise<boolean> {
    const norm = path.resolve(absPath);
    if (this.data.presets.some((p) => path.resolve(p) === norm)) {
      return false;
    }
    this.data.presets.push(norm);
    await this.flush();
    return true;
  }

  getByIndex(oneBased: number): string | undefined {
    if (oneBased < 1) return undefined;
    return this.data.presets[oneBased - 1];
  }

  /** 按序号删除（从 1 起）；越界则返回 false */
  async removePresetAt(oneBased: number): Promise<boolean> {
    if (oneBased < 1 || oneBased > this.data.presets.length) {
      return false;
    }
    this.data.presets.splice(oneBased - 1, 1);
    await this.flush();
    return true;
  }

  private async flush(): Promise<void> {
    await atomicWriteJson(this.filePath, this.data);
  }
}
