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
  action: "ARM_LONG" | "ARM_SHORT" | "WAIT";
  confidence: number; // 0-100
  because: string;
  waiting_for: string; // Required field
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
  direction: "long" | "short" | "none";
  confidence: number;
  reason: string;
}

export type MinimalMindStateResult = {
  mindState: MinimalMindStateResponse;
  valid: boolean;
};

export type MinimalExecutionPhase =
  | "WAITING_FOR_THESIS"
  | "WAITING_FOR_PULLBACK"
  | "WAITING_FOR_ENTRY"
  | "IN_TRADE";

export type MinimalExecutionState = {
  phase: MinimalExecutionPhase;
  thesisDirection?: "long" | "short" | "none";
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
