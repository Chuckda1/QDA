import type { Play } from "../types.js";

export type GovernorPersistedState = {
  // ET date string YYYY-MM-DD for which plan was last sent
  lastPlanDate?: string;
  // Dedupe keys -> timestamp (ms) when we sent it
  dedupe?: Record<string, number>;
};

export type PersistedBotStateV1 = {
  version: 1;
  instanceId: string;
  savedAt: number;
  activePlay: Play | null;
  governor: GovernorPersistedState;
};
