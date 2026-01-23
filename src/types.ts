export type Direction = "LONG" | "SHORT";
export type Bias = "LONG" | "SHORT" | "NEUTRAL";
export type Regime = "TREND_UP" | "TREND_DOWN" | "CHOP" | "TRANSITION";
export type EntryPermission = "ALLOWED" | "WAIT_FOR_PULLBACK" | "BLOCKED";
export type PotdBias = "LONG" | "SHORT" | "NONE";
export type PotdMode = "OFF" | "PRIOR" | "HARD";
export type BotMode = "QUIET" | "ACTIVE";
export type TradeAction = "GO_ALL_IN" | "SCALP" | "WAIT" | "PASS";
export type SetupPattern =
  | "FOLLOW"
  | "RECLAIM"
  | "FADE";

export interface TacticalSnapshot {
  activeDirection: Direction | "NEUTRAL";
  confidence: number; // 0-100
  reasons: string[];
  tier: "CLEAR" | "LEAN" | "NONE";
  score: number;
  shock: boolean;
  shockReason?: string;
  indicatorTf: "1m" | "5m";
  confirm?: {
    tf: "5m";
    bias: Direction | "NONE";
    confidence: number;
    reasons: string[];
  };
}

export interface SetupCandidate {
  id: string;
  ts: number;
  symbol: string;
  direction: Direction;
  pattern: SetupPattern;
  intentBucket?: SetupPattern;
  stage?: "EARLY" | "READY" | "LATE";
  holdReason?: string;
  qualityTag?: "LOW" | "OK" | "HIGH";
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
  scoreComponents?: {
    structure?: number;
    momentum?: number;
    location?: number;
    volatility?: number;
    pattern?: number;
    risk?: number;
  };
  featureBundle?: {
    indicators?: {
      ema9_1m?: number;
      ema20_1m?: number;
      vwap_1m?: number;
      ema9_5m?: number;
      ema20_5m?: number;
      vwap_5m?: number;
    };
    location?: {
      priceVsVWAP?: { atR?: number };
      priceVsEMA20?: { atR?: number };
      inValueZone?: boolean;
      extendedFromMean?: { atR?: number; extended?: boolean };
    };
    trend?: {
      structure?: "BULLISH" | "BEARISH" | "MIXED";
      vwapSlopeAtr?: number;
      ema9SlopeAtr?: number;
      ema20SlopeAtr?: number;
      emaAlignment?: "BULL" | "BEAR" | "NEUTRAL";
    };
    timing?: {
      impulseAtr?: number;
      pullbackDepthAtr?: number;
      reclaimSignal?: "NONE" | "EMA_RECLAIM" | "VWAP_RECLAIM" | "BOTH";
      barsSinceImpulse?: number;
      barsInPullback?: number;
    };
    volatility?: {
      atr?: number;
      atrSlope?: number;
      regime15m?: Regime;
      regime5mProvisional?: Regime;
      confidence?: number;
      tacticalBias?: "LONG" | "SHORT" | "NONE";
    };
    volume?: {
      volNow?: number;
      volSma20?: number;
      relVolume?: number;
      impulseVolVsPullbackVol?: number;
      volTrend?: number;
      dollarVol?: number;
    };
  };
  flags?: string[]; // e.g. ["CHOP_OVERRIDE"]
  warningFlags?: string[];
  meta?: {
    valueBand?: { low: number; high: number };
    vwapRef?: number | null;
  };
}

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
  | "PLAN_OF_DAY";

export interface DomainEvent {
  type: DomainEventType;
  timestamp: number;
  instanceId: string;
  data: Record<string, any>;
}

export interface SnapshotContract {
  timestamp: number;
  symbol: string;
  timeframe: "1m" | "5m" | "15m";
  tacticalSnapshot?: TacticalSnapshot;
  marketState?: Record<string, any>;
  timing?: Record<string, any>;
  candidates?: SetupCandidate[];
  llmSelection?: {
    selectedCandidateId?: string;
    rankedCandidateIds?: string[];
    action?: TradeAction;
    agreement?: number;
    legitimacy?: number;
    probability?: number;
    note?: string;
  };
  lowContext?: {
    active: boolean;
    reasons: string[];
  };
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
  entryWindowOpenedTs?: number;
  reclaim?: ReclaimState;
  valueBand?: { low: number; high: number };
  vwapRef?: number | null;
  
  // LLM fields
  legitimacy?: number;
  followThroughProb?: number;
  action?: TradeAction;
  
  // tracking
  status: "PENDING" | "ARMED" | "ENTRY_WINDOW" | "ENTERED" | "CANCELLED" | "CLOSED";
  tier?: "LOCKED" | "LEANING";
  lastCoachUpdate?: number;
  armedTimestamp?: number; // timestamp when play was armed
  entered?: boolean;  // legacy flag (use status instead)
  entryPrice?: number; // actual entry price when entered
  entryTimestamp?: number; // timestamp when entered
  expiresAt?: number; // timestamp when arming expires
  triggerPrice?: number; // candidate trigger price
  t1Hit?: boolean;
  stopAdjusted?: boolean;
  armedSnapshot?: SnapshotContract;
  entrySnapshot?: SnapshotContract;
  coachingState?: {
    lastCoachTs?: number;
    lastRecommendation?: string;
    intent?: "PROTECT" | "HARVEST" | "PRESS";
    lockUntilTs?: number;
    lastTriggerTs?: Record<string, number>;
    maxFavorableR?: number;
    maxAdverseR?: number;
  };
}

export type TimingPhase =
  | "IDLE"
  | "IMPULSE"
  | "PULLBACK"
  | "ENTRY_WINDOW"
  | "IN_TRADE"
  | "DONE";

export interface TimingStateContext {
  phase: TimingPhase;
  dir: Direction | "NONE";
  phaseSinceTs: number;
  anchor?: {
    impulseStartPx?: number;
    impulseEndPx?: number;
    pullbackHighPx?: number;
    pullbackLowPx?: number;
    vwapCrossTs?: number;
  };
  evidence?: {
    impulseAtr?: number;
    retracePct?: number;
    slopeAtr?: number;
  };
  locks?: {
    minBarsInPhase?: number;
    cooldownUntilTs?: number;
  };
  lastUpdatedTs?: number;
}

export type ReclaimStep = "WAIT_RECLAIM" | "WAIT_CONFIRM";

export type ReclaimState = {
  step: ReclaimStep;
  reclaimTs?: number;
  reclaimClose?: number;
  confirmations?: number;
};

export interface BotState {
  startedAt: number;
  lastTickAt?: number;
  last1mTs?: number;  // last 1m bar processed timestamp
  last5mTs?: number;   // last 5m bar processed timestamp
  last15mTs?: number;  // last 15m bar processed timestamp
  session: string;
  price?: number;
  activePlay?: Play | null;
  pendingPlay?: Play | null;
  pendingCandidate?: SetupCandidate | null;
  pendingCandidateExpiresAt?: number;
  mode: BotMode;
  lastPlanSent?: number;
  potd?: {
    bias: PotdBias;
    confidence: number;
    mode: PotdMode;
    updatedAt?: number;
    source?: string;
  };
  // STAGE 3: LLM tracking
  lastLLMCallAt?: number;
  lastLLMDecision?: string;
  timingState?: TimingStateContext;
}
