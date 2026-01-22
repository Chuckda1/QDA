import type { Play, SetupCandidate, TimingStateContext } from "../types.js";

/**
 * Persisted state schema (versioned)
 */
export interface PersistedBotStateV1 {
  version: 1;
  instanceId: string;
  savedAt: number;
  activePlay: Play | null;
  pendingPlay?: Play | null;
  pendingCandidate?: SetupCandidate | null;
  pendingCandidateExpiresAt?: number;
  timingState?: TimingStateContext;
  potd?: {
    bias: "LONG" | "SHORT" | "NONE";
    confidence: number;
    mode: "OFF" | "PRIOR" | "HARD";
    updatedAt?: number;
    source?: string;
  };
  governor: {
    lastPlanDate: string; // ET date string "YYYY-MM-DD"
    dedupeKeys: Record<string, number>; // key -> timestamp when sent
  };
}

export type PersistedBotState = PersistedBotStateV1;
