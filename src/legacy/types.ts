export type DecisionBlocker =
  | "no_active_play"
  | "arming_failed"
  | "expired"
  | "cooldown"
  | "guardrail"
  | "chop"
  | "low_probability"
  | "datafeed"
  | "data_stale"
  | "time_window"
  | "entry_filter";

export type DomainEventType =
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
