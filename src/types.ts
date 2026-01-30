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
  price?: number; // Current price (first-class)
  refPrice?: number; // Reference price anchor (bias price, pullback level, etc.)
  refLabel?: string; // Label for reference price (e.g., "bias established", "pullback low")
  noTradeDiagnostic?: NoTradeDiagnostic; // Why no trade fired (when applicable)
}

export type MinimalMindStateResult = {
  mindState: MinimalMindStateResponse;
  valid: boolean;
};

// Market Bias (sticky, changes slowly, only on structural invalidation)
export type MarketBias = "BEARISH" | "BULLISH" | "NEUTRAL";

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
export type EntryType = "REJECTION_ENTRY" | "BREAKDOWN_ENTRY" | "REENTRY_AFTER_CONTINUATION" | null;

// Expected Resolution (what should happen next in a pullback)
export type ExpectedResolution = "CONTINUATION" | "FAILURE" | "UNDECIDED";

// Setup Type - explicit, mutually-exclusive tradable patterns
// Only one setup may be active at a time
// No setup = no trade (even if bias is strong)
export type SetupType = 
  | "EARLY_REJECTION"    // Early rejection at resistance (failed reclaim of EMA/VWAP)
  | "REJECTION"          // Trend continuation via pullback rejection
  | "BREAKDOWN"          // Structural level break
  | "COMPRESSION_BREAK"  // Volatility contraction → expansion
  | "FAILED_BOUNCE"      // Counter-trend failure → reversal
  | "TREND_REENTRY"      // Post-expansion continuation entry
  | "NONE";              // Explicitly no setup

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
  targets?: number[];
  waitReason?: string;
  continuationExtension?: number; // Distance from pullback level when continuation detected
  entryBlocked?: boolean; // True when no-chase rules prevent entry
  entryBlockReason?: string; // Reason for entry blocking
  // Re-entry tracking
  impulseRange?: number; // Range of the continuation impulse move
  continuationHigh?: number; // Highest point during continuation (bearish bias)
  continuationLow?: number; // Lowest point during continuation (bullish bias)
  continuationStartTs?: number; // When continuation was detected
  barsSinceContinuation?: number; // Counter for time decay check
  // Resolution Gate (permission system for entries)
  resolutionGate?: ResolutionGate;
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
