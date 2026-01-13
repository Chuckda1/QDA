export type Direction = "LONG" | "SHORT";
export type BotMode = "QUIET" | "ACTIVE";
export type TradeAction = "GO_ALL_IN" | "SCALP" | "WAIT" | "PASS";

export type DomainEventType =
  | "PLAY_ARMED"
  | "TIMING_COACH"
  | "LLM_VERIFY"
  | "TRADE_PLAN"
  | "LLM_COACH_UPDATE"
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
  lastCoachUpdate?: number;
  entered?: boolean;  // true when position is actually entered
  entryPrice?: number; // actual entry price when entered
  entryTimestamp?: number; // timestamp when entered
}

export interface BotState {
  startedAt: number;
  lastTickAt?: number;
  last1mTs?: number;  // last 1m bar processed timestamp
  last5mTs?: number;   // last 5m bar processed timestamp
  session: string;
  price?: number;
  activePlay?: Play | null;
  mode: BotMode;
  lastPlanSent?: number;
  // STAGE 3: LLM tracking
  lastLLMCallAt?: number;
  lastLLMDecision?: string;
}
