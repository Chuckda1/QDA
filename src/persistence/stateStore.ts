import { promises as fs } from "node:fs";
import path from "node:path";
import type { PersistedBotState } from "./persistedState.js";

function getDefaultStateFile(instanceId: string): string {
  return `/tmp/qda-state-${instanceId}.json`;
}

export class StateStore {
  private stateFile: string;

  constructor(instanceId: string, stateFile?: string) {
    this.stateFile = stateFile || process.env.STATE_FILE || getDefaultStateFile(instanceId);
  }

  async load(): Promise<PersistedBotState | null> {
    try {
      const raw = await fs.readFile(this.stateFile, "utf8");
      const parsed = JSON.parse(raw) as PersistedBotState;
      
      // Validate version
      if (parsed.version !== 1) {
        console.warn(`[persist] Unsupported state version: ${parsed.version}, ignoring`);
        return null;
      }
      
      return parsed;
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        // File doesn't exist yet - that's fine
        return null;
      }
      console.warn(`[persist] Failed to load state: ${err?.message || String(err)}`);
      return null;
    }
  }

  async save(state: PersistedBotState): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
      await fs.writeFile(this.stateFile, JSON.stringify(state, null, 2) + "\n", "utf8");
    } catch (err: any) {
      console.warn(`[persist] Failed to save state: ${err?.message || String(err)}`);
      throw err;
    }
  }
}
