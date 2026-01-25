export type DecisionBlocker =
  | "datafeed"
  | "expired"
  | "cooldown"
  | "guardrail"
  | "time_window"
  | "entry_filter"
  | "chop"
  | "range"
  | "news"
  | "risk_lock"
  | "unknown"
  // legacy compatibility (DO NOT REMOVE YET)
  | "arming_failed"
  | "data_stale"
  | "no_active_play";

export type LegacyDecisionState = "SIGNAL" | "WATCH" | "UPDATE" | "MANAGE";

export type LegacyDomainEventType =
  | "PLAY_ARMED"
  | "ENTRY_WINDOW_OPENED"
  | "TIMING_COACH"
  | "LLM_VERIFY"
  | "LLM_PICK"
  | "SCORECARD"
  | "SETUP_CANDIDATES"
  | "SETUP_SUMMARY"
  | "NO_ENTRY"
  | "TRADE_PLAN"
  | "ARMED_COACH"
  | "LLM_COACH_UPDATE"
  | "PLAY_ENTERED"
  | "PLAY_SIZED_UP"
  | "PLAY_CANCELLED"
  | "PLAY_CLOSED"
  | "PREMARKET_UPDATE"
  | "VOLUME_UPDATE"
  | "PLAN_OF_DAY"
  | "MIND_STATE_UPDATED";

export type RangeBand = {
  low: number;
  high: number;
  source?: "RTH" | "OVERNIGHT" | "SESSION" | "1m" | "5m";
  ts?: number;
};
