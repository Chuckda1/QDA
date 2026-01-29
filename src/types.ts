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

export type MinimalLLMSnapshot = {
  symbol: string;
  nowTs: number;
  closed5mBars: RawBar[];
  forming5mBar?: Forming5mBar | null;
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
  entryStatus?: "active" | "inactive"; // New: entry status
  entryType?: EntryType; // New: entry type
  expectedResolution?: ExpectedResolution; // New: what should happen next in pullback
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
  | "IN_TRADE"
  | "CONSOLIDATION_AFTER_REJECTION";

// Entry Types (explicit, not implied)
export type EntryType = "REJECTION_ENTRY" | "BREAKDOWN_ENTRY" | null;

// Expected Resolution (what should happen next in a pullback)
export type ExpectedResolution = "CONTINUATION" | "FAILURE" | "UNDECIDED";

export type MinimalExecutionState = {
  // Market Bias (sticky)
  bias: MarketBias;
  biasConfidence?: number;
  biasPrice?: number;
  biasTs?: number;
  biasInvalidationLevel?: number; // Bias flips only if price crosses this
  
  // Trade Phase (fast)
  phase: MinimalExecutionPhase;
  
  // Expected Resolution (what should happen next in pullback)
  expectedResolution?: ExpectedResolution;
  
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
