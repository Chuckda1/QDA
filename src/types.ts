export type Direction = "LONG" | "SHORT";
export type Bias = "LONG" | "SHORT" | "NEUTRAL";
export type Regime = "TREND_UP" | "TREND_DOWN" | "CHOP" | "TRANSITION";
export type EntryPermission = "ALLOWED" | "WAIT_FOR_PULLBACK" | "BLOCKED";
export type PotdBias = "LONG" | "SHORT" | "NONE";
export type PotdMode = "OFF" | "PRIOR" | "HARD";
export type BotMode = "QUIET" | "ACTIVE";
export type TradeAction = "GO_ALL_IN" | "SCALP" | "WAIT" | "PASS";
export type SetupPattern =
  | "PULLBACK_CONTINUATION"
  | "BREAK_RETEST"
  | "REVERSAL_ATTEMPT"
  | "VALUE_RECLAIM";

export interface SetupCandidate {
  id: string;
  ts: number;
  symbol: string;
  direction: Direction;
  pattern: SetupPattern;
  triggerPrice: number;
  entryZone: { low: number; high: number };
  stop: number;
  targets: { t1: number; t2: number; t3: number };
  rationale: string[];
  score: {
    alignment: number;
    structure: number;
    quality: number;
    total: number;
  };
  flags?: string[]; // e.g. ["CHOP_OVERRIDE"]
}

export type DomainEventType =
  | "PLAY_ARMED"
  | "TIMING_COACH"
  | "LLM_VERIFY"
  | "SCORECARD"
  | "SETUP_SUMMARY"
  | "NO_ENTRY"
  | "TRADE_PLAN"
  | "ARMED_COACH"
  | "LLM_COACH_UPDATE"
  | "PLAY_ENTERED"
  | "PLAY_CLOSED"
  | "PLAN_OF_DAY";

export interface DomainEvent {
  type: DomainEventType;
  timestamp: number;
  instanceId: string;
  data: Record<string, any>;
}

export interface Play {
  id: string;
  symbol: string;
  direction: Direction;
  score: number;
  grade: string;
  entryZone: { low: number; high: number };
  stop: number;
  targets: { t1: number; t2: number; t3: number };
  mode: "FULL" | "SCOUT";
  confidence: number;

  // idempotency
  inEntryZone?: boolean;
  stopThreatened?: boolean;
  stopHit?: boolean;
  
  // LLM fields
  legitimacy?: number;
  followThroughProb?: number;
  action?: TradeAction;
  
  // tracking
  status: "ARMED" | "ENTERED" | "CLOSED";
  lastCoachUpdate?: number;
  armedTimestamp?: number; // timestamp when play was armed
  entered?: boolean;  // legacy flag (use status instead)
  entryPrice?: number; // actual entry price when entered
  entryTimestamp?: number; // timestamp when entered
  expiresAt?: number; // timestamp when arming expires
  triggerPrice?: number; // candidate trigger price
  t1Hit?: boolean;
  stopAdjusted?: boolean;
}

export interface BotState {
  startedAt: number;
  lastTickAt?: number;
  last1mTs?: number;  // last 1m bar processed timestamp
  last5mTs?: number;   // last 5m bar processed timestamp
  last15mTs?: number;  // last 15m bar processed timestamp
  session: string;
  price?: number;
  activePlay?: Play | null;
  mode: BotMode;
  lastPlanSent?: number;
  // STAGE 3: LLM tracking
  lastLLMCallAt?: number;
  lastLLMDecision?: string;
}
