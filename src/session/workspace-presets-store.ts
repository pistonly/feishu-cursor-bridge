import * as fs from "node:fs/promises";
import * as path from "node:path";

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
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PresetsFileV1;
      if (
        parsed?.version === 1 &&
        Array.isArray(parsed.presets) &&
        parsed.presets.every((p) => typeof p === "string")
      ) {
        this.data = parsed;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.data = { version: 1, presets: [] };
      } else {
        throw e;
      }
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
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(
      tmp,
      JSON.stringify(this.data, null, 2),
      "utf8",
    );
    await fs.rename(tmp, this.filePath);
  }
}
