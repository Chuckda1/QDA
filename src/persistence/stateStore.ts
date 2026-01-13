import { promises as fs } from "node:fs";
import path from "node:path";
import type { PersistedBotStateV1 } from "./persistedState.js";

function defaultStateFile(instanceId: string): string {
  return `/tmp/qda-state-${instanceId}.json`;
}

export class StateStore {
  private filePath: string;

  constructor(instanceId: string, filePath?: string) {
    const p = (filePath || process.env.PERSISTENCE_STATE_FILE || defaultStateFile(instanceId)).trim();
    this.filePath = p;
  }

  getPath(): string {
    return this.filePath;
  }

  async load(): Promise<PersistedBotStateV1 | null> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedBotStateV1;
      if (!parsed || parsed.version !== 1) return null;
      return parsed;
    } catch (err: any) {
      if (err?.code === "ENOENT") return null;
      console.warn(`[persist] failed to load ${this.filePath}: ${err?.message || String(err)}`);
      return null;
    }
  }

  async save(state: PersistedBotStateV1): Promise<void> {
    const dir = path.dirname(this.filePath);
    const tmp = `${this.filePath}.tmp`;
    const body = JSON.stringify(state) + "\n";

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmp, body, "utf8");
    await fs.rename(tmp, this.filePath);
  }
}

