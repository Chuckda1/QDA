import type { Play } from "../types.js";

/**
 * Persisted state schema (versioned)
 */
export interface PersistedBotStateV1 {
  version: 1;
  instanceId: string;
  savedAt: number;
  activePlay: Play | null;
  governor: {
    lastPlanDate: string; // ET date string "YYYY-MM-DD"
    dedupeKeys: Record<string, number>; // key -> timestamp when sent
  };
}

export type PersistedBotState = PersistedBotStateV1;
