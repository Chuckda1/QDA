export type BotMode = "QUIET" | "ACTIVE";

export type RawBar = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type Forming5mBar = {
  startTs: number;
  endTs: number;
  progressMinutes: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type DailyContextLite = {
  prevClose?: number; // Previous day's close
  prevHigh?: number; // Previous day's high
  prevLow?: number; // Previous day's low
  overnightHigh?: number; // Overnight/pre-market high
  overnightLow?: number; // Overnight/pre-market low
  vwapPrevSession?: number; // Previous session VWAP (or yesterday VWAP)
  biasAnchor?: {
    bias: MarketBias;
    sinceTs: number;
    invalidationLevel?: number;
  };
};

export type MinimalLLMSnapshot = {
  symbol: string;
  nowTs: number;
  closed5mBars: RawBar[];
  forming5mBar?: Forming5mBar | null;
  dailyContextLite?: DailyContextLite;
};

export type ArmDecisionRaw5mResponse = {
  mindId: string;
  action: "ARM_LONG" | "ARM_SHORT" | "WAIT" | "A+";
  confidence: number; // 0-100
  bias: "bullish" | "bearish" | "neutral";
  maturity: "early" | "developing" | "mature" | "extended" | "unclear";
  because: string;
  waiting_for: string; // Required field
};

export type PostTradeIntrospection = {
  assessment: "aligned" | "early" | "late" | "unclear";
  keySignal: string;
  misread: "none" | "structure" | "momentum" | "participation" | "context" | "timing";
};

export type ArmDecisionRaw5mResult = {
  decision: ArmDecisionRaw5mResponse;
  valid: boolean;
};

export type MinimalSetupCandidate = {
  id: string;
  direction: "LONG" | "SHORT";
  entryTrigger: string;
  invalidationLevel: number;
  pullbackRule: string;
  referenceLevels: {
    lastSwingHigh?: number;
    lastSwingLow?: number;
    pullbackHigh?: number;
    pullbackLow?: number;
  };
  rationale: string;
};

export type MinimalSetupSelectionResponse = {
  selected: "LONG" | "SHORT" | "PASS";
  confidence: number;
  reason: string;
};

export type MinimalSetupSelectionResult = {
  selection: MinimalSetupSelectionResponse;
  valid: boolean;
};

export interface MinimalMindStateResponse {
  // Target zones (when in trade)
  targetZones?: {
    rTargets?: { t1: number; t2: number; t3: number };
    atrTargets?: { t1: number; t2: number };
    magnetLevels?: {
      microLow?: number;
      majorLow?: number;
      microHigh?: number;
      majorHigh?: number;
      vwap?: number;
    };
    measuredMove?: number;
    expectedZone?: { lower: number; upper: number };
    expectedEnd?: number;
  };
  entryPrice?: number;
  stopPrice?: number;
  mindId?: string;
  direction: "long" | "short" | "none"; // Legacy - maps to bias
  confidence: number;
  reason: string;
  bias?: MarketBias; // New: explicit bias
  phase?: MinimalExecutionPhase; // New: explicit phase
  entryStatus?: "active" | "inactive" | "blocked"; // New: entry status
  entryType?: EntryType; // New: entry type
  expectedResolution?: ExpectedResolution; // New: what should happen next in pullback
  setup?: SetupType; // New: explicit setup type (REJECTION, BREAKDOWN, etc.)
  setupTriggerPrice?: number; // Price level that triggers entry for this setup
  setupStopPrice?: number; // Stop price for this setup
  setupDetectedAt?: number; // Timestamp when setup was detected
  lastBiasFlipTs?: number; // Timestamp of last bias flip (for IGNITION window)
  price?: number; // Current price (first-class)
  refPrice?: number; // Reference price anchor (bias price, pullback level, etc.)
  refLabel?: string; // Label for reference price (e.g., "bias established", "pullback low")
  noTradeDiagnostic?: NoTradeDiagnostic; // Why no trade fired (when applicable)
  // Opportunity latch timestamps (for debugging Telegram timing)
  oppLatchedAt?: number; // Timestamp when opportunity was latched
  oppExpiresAt?: number; // Timestamp when opportunity expires
  last5mCloseTs?: number; // Timestamp of last 5m bar close
  source?: "1m" | "5m"; // Source of this state update (1m tick or 5m close)
}

export type MinimalMindStateResult = {
  mindState: MinimalMindStateResponse;
  valid: boolean;
};

// Market Bias (sticky, changes slowly, only on structural invalidation)
export type MarketBias = "BEARISH" | "BULLISH" | "NEUTRAL";

// Bias Engine State (deterministic, 1m-based)
export type BiasEngineState = 
  | "BEARISH"
  | "REPAIR_BULL"  // Neutralizing from bearish, moving toward bullish
  | "NEUTRAL"
  | "REPAIR_BEAR"  // Neutralizing from bullish, moving toward bearish
  | "BULLISH";

export type BiasEngine = {
  state: BiasEngineState;
  score: number;  // Signed regime score (positive = bullish, negative = bearish)
  lastFlipTs?: number;  // Timestamp of last full flip (for cooldown)
  repairStartTs?: number;  // When REPAIR state started
  acceptBullCount: number;  // Consecutive minutes of bull acceptance
  acceptBearCount: number;  // Consecutive minutes of bear acceptance
};

// Trade Phase (fast, changes quickly)
export type MinimalExecutionPhase =
  | "NEUTRAL_PHASE"
  | "BIAS_ESTABLISHED"
  | "PULLBACK_IN_PROGRESS"
  | "PULLBACK_REJECTION"
  | "PULLBACK_BREAKDOWN"
  | "CONTINUATION_IN_PROGRESS"
  | "REENTRY_WINDOW"
  | "IN_TRADE"
  | "CONSOLIDATION_AFTER_REJECTION";

// Entry Types (explicit, not implied)
export type EntryType = "REJECTION_ENTRY" | "BREAKDOWN_ENTRY" | "REENTRY_AFTER_CONTINUATION" | "BIAS_FLIP_ENTRY" | "PULLBACK_ENTRY" | "IGNITION_ENTRY";

// Expected Resolution (what should happen next in a pullback)
export type ExpectedResolution = "CONTINUATION" | "FAILURE" | "UNDECIDED";

// Setup Type - explicit, mutually-exclusive tradable patterns
// Only one setup may be active at a time
// No setup = no trade (even if bias is strong)
export type SetupType = 
  | "PULLBACK_CONTINUATION"  // Trend pullback then continuation (primary setup)
  | "RIP_REVERSION"          // Extended rip then fade / extended dump then bounce (optional, phase 2)
  | "IGNITION"               // Immediate entry after bias flip when momentum is strong
  | "NONE";                  // Explicitly no setup

// Resolution Gate - permission system for entries
export type ResolutionGateStatus = "INACTIVE" | "ARMED" | "TRIGGERED" | "EXPIRED" | "INVALIDATED";

export type ResolutionGate = {
  status: ResolutionGateStatus;
  direction: "long" | "short";
  triggerPrice: number;
  stopPrice: number;
  expiryTs: number;
  armedTs: number;
  reason: string;
};

// ============================================================================
// OpportunityLatch: Single execution intent state that composes all gates
// ============================================================================
// This replaces the "separated gate mess" by becoming the single execution gate.
// Phase = story, Setup = pattern label, OpportunityLatch = "I'm ready to shoot" state
// ============================================================================
export type OpportunitySide = "LONG" | "SHORT";
export type OpportunityStatus = "INACTIVE" | "LATCHED" | "TRIGGERED" | "INVALIDATED" | "EXPIRED" | "CONSUMED";
export type OpportunityTriggerType = "ROLLOVER" | "BREAK" | "RECLAIM_FAIL";

export type OpportunityLatch = {
  status: OpportunityStatus;
  
  side: OpportunitySide;                 // derived from exec.bias
  biasAtLatch: MarketBias;               // BEARISH/BULLISH (snapshot at latch time)
  phaseAtLatch: MinimalExecutionPhase;   // PULLBACK_IN_PROGRESS etc. (snapshot)
  setupAtLatch?: SetupType;              // REJECTION / PULLBACK_GENERIC / etc. (snapshot)
  
  latchedAtTs: number;
  expiresAtTs: number;                   // hard TTL (2 closed 5m bars = 10 minutes)
  
  zone: { low: number; high: number };  // where we allow entries (pullback window)
  trigger: { 
    type: OpportunityTriggerType; 
    price: number;
    description?: string;                 // e.g., "rollover candle", "break of prior low"
  };
  stop: { 
    price: number; 
    reason: string;                       // e.g., "pullback high + buffer", "rejection candle high"
  };
  
  // Optional but useful
  attempts?: number;                     // how many times we "almost triggered"
  bestPriceSeen?: number;                // for no-chase logic / to avoid late entries
  armedAtPrice?: number;                 // price when latched (for cross-based trigger validation)
  notes?: string;                        // human-readable: "pullback into resistance"
  
  // Invalidation rules (structural checks)
  invalidateIf?: {
    biasInvalidated?: boolean;           // shouldFlipBias() triggers
    stopBroken?: boolean;                 // price breaks stop level
    zoneExited?: boolean;                // price closes outside zone + buffer
    timeExpired?: boolean;                // nowTs >= expiresAtTs
  };
};

// No Trade Diagnostic - explains why no trade fired
export type NoTradeReasonCode = 
  | "NO_GATE_ARMED"
  | "GATE_EXPIRED"
  | "GATE_INVALIDATED"
  | "VOL_TOO_HIGH"
  | "AWAITING_PULLBACK_COMPLETION"
  | "SESSION_CONSTRAINT"
  | "NO_REJECTION_CANDLE"
  | "EMA_NOT_REJECTED"
  | "STRUCTURE_INTACT"
  | "RR_UNFAVORABLE"
  | "PRICE_DRIFT_TOO_SMALL";

export type NoTradeDiagnostic = {
  price: number;
  bias: MarketBias;
  phase: MinimalExecutionPhase;
  expectedResolution?: ExpectedResolution;
  gateStatus?: ResolutionGateStatus;
  reasonCode: NoTradeReasonCode;
  details: string;
};

export type MinimalExecutionState = {
  // Market Bias (sticky)
  bias: MarketBias;
  baseBiasConfidence?: number; // LLM-provided initial confidence (base weight only)
  biasConfidence?: number; // Derived confidence (computed from base + structure + momentum - decay - penalty)
  biasPrice?: number;
  biasTs?: number;
  biasInvalidationLevel?: number; // Bias flips only if price crosses this
  
  // Trade Phase (fast)
  phase: MinimalExecutionPhase;
  
  // Expected Resolution (what should happen next in pullback)
  expectedResolution?: ExpectedResolution;
  
  // Setup Type (explicit, mutually-exclusive tradable pattern)
  // Only one setup may be active at a time
  // No setup = no trade (even if bias is strong)
  setup?: SetupType;
  setupVariant?: "LONG" | "SHORT"; // Direction for IGNITION setup (optional, can infer from bias)
  setupDetectedAt?: number; // Timestamp when setup was detected
  setupTriggerPrice?: number; // Price level that triggers entry for this setup
  setupStopPrice?: number; // Stop price for this setup
  // REJECTION setup persistence tracking
  rejectionCandleLow?: number; // Low of the rejection candle (for REJECTION setups)
  rejectionCandleHigh?: number; // High of the rejection candle (for REJECTION setups)
  rejectionBarsElapsed?: number; // Number of 1m bars since rejection detected (for persistence)
  
  // Entry tracking
  entryType?: EntryType;
  entryTrigger?: string; // What triggered the entry (e.g., "Bearish rejection at VWAP")
  
  // Legacy fields (for backward compatibility during transition)
  thesisDirection?: "long" | "short" | "none"; // Maps to bias
  thesisConfidence?: number;
  thesisPrice?: number;
  thesisTs?: number;
  
  activeCandidate?: MinimalSetupCandidate;
  canEnter?: boolean;
  pullbackHigh?: number;
  pullbackLow?: number;
  pullbackTs?: number;
  entryPrice?: number;
  entryTs?: number;
  stopPrice?: number;
  targets?: number[]; // Legacy: [T1, T2] - kept for backward compatibility
  targetZones?: {
    rTargets: { t1: number; t2: number; t3: number }; // Risk-unit targets
    atrTargets: { t1: number; t2: number }; // ATR projection targets
    magnetLevels: {
      microLow?: number; // Lowest low (last 6-12 bars)
      majorLow?: number; // Lowest low (last 24-36 bars)
      vwap?: number; // Session VWAP
      vwapMinus1Sigma?: number; // VWAP - 1σ (optional)
      vwapMinus2Sigma?: number; // VWAP - 2σ (optional)
    };
    measuredMove?: number; // Measured move projection
    expectedZone: { lower: number; upper: number }; // Weighted expected zone
    expectedEnd: number; // Single weighted target (median)
  };
  waitReason?: string;
  reason?: string; // Entry-aligned narrative (set on entry, cleared on exit)
  continuationExtension?: number; // Distance from pullback level when continuation detected
  entryBlocked?: boolean; // True when no-chase rules prevent entry
  entryBlockReason?: string; // Reason for entry blocking
  // Deployment pause (micro countertrend throttle)
  deploymentPauseUntilTs?: number; // Timestamp when deployment pause expires
  deploymentPauseReason?: string; // Reason for deployment pause
  // Micro indicators (1m timeframe for countertrend detection)
  micro?: {
    vwap1m?: number; // Session VWAP on 1m bars
    emaFast1m?: number; // Fast EMA on 1m bars
    atr1m?: number; // ATR(14) on 1m bars
    lastSwingHigh1m?: number; // Max high of last 10 1m bars
    lastSwingLow1m?: number; // Min low of last 10 1m bars
    aboveVwapCount?: number; // Consecutive closes above VWAP
    belowVwapCount?: number; // Consecutive closes below VWAP
    aboveEmaCount?: number; // Consecutive closes above EMA
    belowEmaCount?: number; // Consecutive closes below EMA
  };
  // Rolling window for 1m micro indicators
  microBars1m?: Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }>;
  microVwapPv?: number; // Running sum of price * volume for VWAP
  microVwapVol?: number; // Running sum of volume for VWAP
  microLastETDate?: string; // Last ET date for session VWAP reset
  // Re-entry tracking
  impulseRange?: number; // Range of the continuation impulse move
  continuationHigh?: number; // Highest point during continuation (bearish bias)
  continuationLow?: number; // Lowest point during continuation (bullish bias)
  continuationStartTs?: number; // When continuation was detected
  barsSinceContinuation?: number; // Counter for time decay check
  // Resolution Gate (permission system for entries) - DEMOTED: now supporting role for OpportunityLatch
  resolutionGate?: ResolutionGate;
  // OpportunityLatch: Single execution intent state that composes all gates
  // This is the "glue" that persists tradable moments and prevents flicker
  opportunity?: OpportunityLatch;
  // BiasFlipEntry: Independent entry path for bias flips (regime-break trades)
  biasFlipGate?: BiasFlipGate;
  lastBiasFlipArmTs?: number; // Cooldown tracking to prevent flip-flop spam
  // Bias Engine (deterministic, 1m-based)
  biasEngine?: BiasEngine;
  // Bias flip cooldown (prevent setup arming immediately after flip)
  lastBiasFlipTs?: number;  // Timestamp of last bias flip (for setup cooldown)
  // 5m structure anchors (engine-owned, used for finalizing bias flips)
  swingHigh5m?: number; // Recent structure high (last 12 bars = 60 minutes)
  swingLow5m?: number;  // Recent structure low (last 12 bars = 60 minutes)
  // LLM advisory hints (bias engine owns exec.bias now)
  llmBiasHint?: "bullish" | "bearish" | "neutral";
  llmActionHint?: "WAIT" | "ARM_LONG" | "ARM_SHORT" | "A+";
  llmMaturityHint?: string;  // "early" | "developing" | "mature" | "extended" | "exhausting" | "unclear" (flexible)
  llmWaitingForHint?: string;
  llmConfidenceHint?: number;
};

// BiasFlipEntry Gate State
export type BiasFlipGateState = "NONE" | "ARMED" | "TRIGGERED" | "EXPIRED" | "CANCELLED";

export type BiasFlipGate = {
  state: BiasFlipGateState;
  direction: "long" | "short";     // maps to exec.thesisDirection
  armedAtTs: number;               // 5m close ts
  expiresAtTs: number;             // TTL
  trigger: number;                 // breakout level
  stop: number;                    // protective stop
  basis5m: { o: number; h: number; l: number; c: number; ts: number };
  conf: number;
  reason: "bias_flip";
};

export interface BotState {
  startedAt: number;
  lastTickTs?: number;
  last5mCloseTs?: number;
  session: string;
  price?: number;
  mode: BotMode;
  minimalExecution: MinimalExecutionState;
  lastLLMCallAt?: number;
  lastLLMDecision?: string;
}

export type DomainEventType = "MIND_STATE_UPDATED";

export type MinimalDebugInfo = {
  barsClosed5m: number;
  hasForming5m: boolean;
  formingProgressMin: number | null;
  formingStartTs: number | null;
  formingEndTs: number | null;
  formingRange: number | null;
  lastClosedRange: number | null;
  candidateBarsUsed: number;
  candidateCount: number | null;
  botPhase: MinimalExecutionPhase;
  botWaitReason: string | null;
};

export interface DomainEvent {
  type: DomainEventType;
  timestamp: number;
  instanceId: string;
  data: {
    timestamp: number;
    symbol: string;
    price: number;
    mindState: MinimalMindStateResponse;
    thesis?: {
      direction?: string | null;
      confidence?: number | null;
      price?: number | null;
      ts?: number | null;
    };
    candidate?: MinimalSetupCandidate | null;
    botState: MinimalExecutionPhase;
    waitFor?: string | null;
    debug?: MinimalDebugInfo;
  };
}
