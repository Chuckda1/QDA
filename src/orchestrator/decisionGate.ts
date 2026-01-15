import type { Play, SetupCandidate, TradeAction } from "../types.js";

export type DecisionStatus = "NO_SETUP" | "BLOCKED" | "LLM_PASS" | "ARMED";
export type DecisionBlocker =
  | "no_active_play"
  | "arming_failed"
  | "expired"
  | "cooldown"
  | "guardrail"
  | "chop"
  | "low_probability"
  | "datafeed"
  | "time_window"
  | "entry_filter";

export type DecisionLlmSummary = {
  biasDirection?: "LONG" | "SHORT" | "NEUTRAL";
  agreement?: number;
  legitimacy?: number;
  probability?: number;
  followThroughProb?: number;
  action?: TradeAction;
  reasoning?: string;
  plan?: string;
  flags?: string[];
  note?: string;
};

export type DecisionRulesSnapshot = {
  regime: Record<string, any>;
  macroBias?: Record<string, any>;
  potd?: Record<string, any>;
  entryPermission?: string;
  indicatorMeta?: Record<string, any>;
  directionInference: Record<string, any>;
  indicators: Record<string, any>;
  ruleScores: Record<string, any>;
};

export type DecisionSummary = {
  decisionId: string;
  status: DecisionStatus;
  blockers: DecisionBlocker[];
  blockerReasons?: string[];
};

export type AuthoritativeDecision = DecisionSummary & {
  timestamp: number;
  symbol: string;
  candidate?: SetupCandidate;
  llm?: DecisionLlmSummary;
  rules?: DecisionRulesSnapshot;
  play?: Play;
};

export type DecisionGateInputs = {
  ts: number;
  symbol: string;
  candidate?: SetupCandidate;
  rules?: DecisionRulesSnapshot;
  llm?: DecisionLlmSummary;
  blockers?: DecisionBlocker[];
  blockerReasons?: string[];
  expiryMs: number;
};

export function buildDecision(inputs: DecisionGateInputs): AuthoritativeDecision {
  const {
    ts,
    symbol,
    candidate,
    rules,
    llm,
    expiryMs
  } = inputs;
  const blockers: DecisionBlocker[] = inputs.blockers ?? [];
  const blockerReasons: string[] = inputs.blockerReasons ?? [];

  const decisionId = `${symbol}_${ts}_${candidate?.id ?? "none"}`;
  const decisionBase: Omit<AuthoritativeDecision, "status" | "blockers"> = {
    decisionId,
    timestamp: ts,
    symbol,
    candidate,
    llm,
    rules,
    blockerReasons
  };

  if (!candidate) {
    const safeBlockers: DecisionBlocker[] = blockers.length ? blockers : ["no_active_play"];
    return {
      ...decisionBase,
      status: "NO_SETUP",
      blockers: safeBlockers
    };
  }

  const llmApproved = !!llm && llm.action !== "PASS" && llm.action !== "WAIT";
  const baseBlockers = [...blockers];

  if (!llm) {
    if (baseBlockers.length === 0 && !baseBlockers.includes("arming_failed")) {
      baseBlockers.push("arming_failed");
    }
  } else if (!llmApproved) {
    if (!baseBlockers.includes("arming_failed")) {
      baseBlockers.push("arming_failed");
    }
  }

  if (llmApproved && baseBlockers.length === 0) {
    const playMode: Play["mode"] = llm?.action === "GO_ALL_IN" ? "FULL" : "SCOUT";
    const play: Play = {
      id: candidate.id,
      symbol: candidate.symbol,
      direction: candidate.direction,
      score: candidate.score.total,
      grade: candidate.score.total >= 70 ? "A" : candidate.score.total >= 60 ? "B" : candidate.score.total >= 50 ? "C" : "D",
      entryZone: candidate.entryZone,
      stop: candidate.stop,
      targets: candidate.targets,
      mode: playMode,
      confidence: llm?.probability ?? candidate.score.total,
      legitimacy: llm?.legitimacy,
      followThroughProb: llm?.followThroughProb,
      action: llm?.action,
      armedTimestamp: ts,
      expiresAt: ts + expiryMs,
      triggerPrice: candidate.triggerPrice,
      status: "ARMED",
      inEntryZone: false,
      stopHit: false
    };

    return {
      ...decisionBase,
      status: "ARMED",
      blockers: [],
      play
    };
  }

  const status: DecisionStatus = llmApproved ? "LLM_PASS" : "BLOCKED";
  return {
    ...decisionBase,
    status,
    blockers: baseBlockers
  };
}

export function buildNoEntryDecision(params: {
  ts: number;
  symbol: string;
  reason: DecisionBlocker;
  reasonDetail?: string;
  candidate?: SetupCandidate;
  llm?: DecisionLlmSummary;
}): AuthoritativeDecision {
  const decisionId = `${params.symbol}_${params.ts}_${params.candidate?.id ?? "none"}`;
  const blockers: DecisionBlocker[] = [params.reason];
  const blockerReasons = params.reasonDetail ? [params.reasonDetail] : [];

  return {
    decisionId,
    timestamp: params.ts,
    symbol: params.symbol,
    status: "BLOCKED",
    blockers,
    blockerReasons,
    candidate: params.candidate,
    llm: params.llm
  };
}
