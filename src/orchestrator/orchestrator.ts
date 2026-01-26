import type { Bias, BotState, DataFreshness, Direction, DomainEvent, EntryPermission, GateStatus, ModeState, Play, PotdBias, PotdMode, RangeBand, ReclaimState, SnapshotContract, TacticalSnapshot, TimingPhase, TimingStateContext, TradeAction } from "../types.js";
import type { LLMService } from "../llm/llmService.js";
import { StopProfitRules } from "../rules/stopProfitRules.js";
import { EntryFilters, type EntryFilterContext, type EntryFilterResult } from "../rules/entryFilters.js";
import { etToUtcTimestamp, getETClock, getETDateString, getMarketSessionLabel } from "../utils/timeUtils.js";
import { inferTacticalBiasFromRecentBars } from "../rules/directionRules.js";
import { computeTimingSignal } from "../rules/timingRules.js";
import type { TimingSignal } from "../rules/timingRules.js";
import { computeMacroBias, computeRegime, type RegimeOptions } from "../rules/regimeRules.js";
import { computeATR, computeBollingerBands, computeEMA, computeRSI, computeSessionVWAP, computeVWAP, type OHLCVBar } from "../utils/indicators.js";
import { SetupEngine, type SetupEngineResult } from "../legacy_disabled/rules/setupEngine.js";
import type { SetupCandidate } from "../types.js";
import type { DirectionInference } from "../rules/directionRules.js";
import type { RegimeResult } from "../rules/regimeRules.js";
import { requiresDecisionState } from "../utils/decisionState.js";
import { volumePolicy } from "../utils/volumePolicy.js";
import {
  buildDecision,
  buildNoEntryDecision,
  type AuthoritativeDecision,
  type DecisionBlocker,
  type DecisionLlmSummary,
  type DecisionRulesSnapshot
} from "../legacy_disabled/orchestrator/decisionGate.js";

type SetupDiagnosticsSnapshot = {
  ts: number;
  symbol: string;
  close: number;
  regime: RegimeResult;
  macroBias?: Bias;
  directionInference: DirectionInference;
  tacticalSnapshot?: TacticalSnapshot;
  tacticalBias?: ReturnType<typeof inferTacticalBiasFromRecentBars>;
  candidate?: SetupCandidate;
  setupReason?: string;
  setupDebug?: any;
  entryFilterWarnings?: string[];
  entryPermission?: EntryPermission;
  candidateStats?: {
    candidateCount: number;
    stageCounts?: Record<string, number>;
    patternCounts?: Record<string, number>;
    directionCounts?: Record<string, number>;
    llmInvoked?: boolean;
    lowContext?: boolean;
  };
  potd?: {
    bias: PotdBias;
    confidence: number;
    mode: PotdMode;
    alignment?: "ALIGNED" | "COUNTERTREND" | "UNCONFIRMED" | "OFF";
  };
  guardrailBlock?: string; // Reason if blocked by guardrails
  regimeEvidence?: {
    bullScore: number;
    bearScore: number;
  };
  datafeedIssue?: string; // Reason if blocked by datafeed issues
};

type TickInput = {
  ts: number;
  symbol: string;
  close: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
};

type TickSnapshot = TickInput & {
  timeframe: "1m" | "5m" | "15m";
};

type ScorecardSnapshot = {
  topPlayKey: string;
  entryPermission?: EntryPermission;
  timingPhase?: string;
  directionBand: "LOW" | "MID" | "HIGH" | "UNKNOWN";
  direction?: Direction | "NONE";
  llmAction?: TradeAction;
  decisionStatus?: string;
};

type ConfirmBar = {
  ts: number;
  close: number;
  ema9?: number;
  ema20?: number;
};

type DirectionGate =
  | { allow: false; tier: "NONE"; reason: string; direction?: undefined }
  | { allow: true; tier: "LOCKED" | "LEANING"; direction: Direction; reason: string };

function computeEmaSlopePct(closes: number[], period: number, lookbackBars: number): number | undefined {
  if (closes.length < period + lookbackBars) return undefined;
  const emaNow = computeEMA(closes, period);
  const pastCloses = closes.slice(0, Math.max(0, closes.length - lookbackBars));
  const emaPast = computeEMA(pastCloses, period);
  if (emaNow === undefined || emaPast === undefined || emaPast === 0) return undefined;
  return ((emaNow - emaPast) / emaPast) * 100;
}

function buildIndicatorSet(bars: OHLCVBar[], tf: "1m" | "5m"): {
  tf: "1m" | "5m";
  vwap?: number;
  ema9?: number;
  ema20?: number;
  atr?: number;
  rsi14?: number;
} {
  const closes = bars.map((b) => b.close);
  return {
    tf,
    vwap: bars.length >= 30 ? computeSessionVWAP(bars) : undefined,
    ema9: closes.length >= 9 ? computeEMA(closes.slice(-60), 9) : undefined,
    ema20: closes.length >= 20 ? computeEMA(closes.slice(-80), 20) : undefined,
    atr: bars.length >= 15 ? computeATR(bars, 14) : undefined,
    rsi14: closes.length >= 15 ? computeRSI(closes, 14) : undefined,
  };
}

function buildTacticalSnapshot(params: {
  bars: OHLCVBar[];
  indicators: ReturnType<typeof buildIndicatorSet>;
  tf: "1m" | "5m";
  confirmBars?: OHLCVBar[];
  confirmIndicators?: ReturnType<typeof buildIndicatorSet>;
}): TacticalSnapshot {
  const lookback = params.tf === "1m" ? 5 : 3;
  const primary = inferTacticalBiasFromRecentBars(params.bars, {
    lookback,
    indicators: { ...params.indicators, tf: params.tf },
  });
  const confirm =
    params.confirmBars && params.confirmIndicators
      ? inferTacticalBiasFromRecentBars(params.confirmBars, {
          lookback: 3,
          indicators: { ...params.confirmIndicators, tf: "5m" },
        })
      : undefined;

  return {
    activeDirection: primary.bias === "NONE" ? "NEUTRAL" : primary.bias,
    confidence: primary.confidence,
    reasons: primary.reasons,
    tier: primary.tier,
    score: primary.score,
    shock: primary.shock,
    shockReason: primary.shockReason,
    indicatorTf: params.tf,
    confirm: confirm
      ? {
          tf: "5m",
          bias: confirm.bias,
          confidence: confirm.confidence,
          reasons: confirm.reasons,
        }
      : undefined,
  };
}

function getDirectionConfidenceBand(confidence?: number): "LOW" | "MID" | "HIGH" | "UNKNOWN" {
  if (!Number.isFinite(confidence)) return "UNKNOWN";
  if ((confidence ?? 0) >= 70) return "HIGH";
  if ((confidence ?? 0) >= 55) return "MID";
  return "LOW";
}

function buildEtDate(ts: number, offsetDays = 0): Date {
  const etDateStr = getETDateString(new Date(ts));
  const base = new Date(`${etDateStr}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + offsetDays);
  return base;
}

function computeContextRange(params: { ts: number; bars1m: OHLCVBar[]; bars5m: OHLCVBar[] }): RangeBand | undefined {
  const session = getMarketSessionLabel(new Date(params.ts));
  const { hour, minute } = getETClock(new Date(params.ts));
  const isBeforeOpen = hour < 9 || (hour === 9 && minute < 30);
  const startDate = session === "RTH"
    ? buildEtDate(params.ts)
    : isBeforeOpen
    ? buildEtDate(params.ts, -1)
    : buildEtDate(params.ts);
  const startTs = session === "RTH"
    ? etToUtcTimestamp(9, 30, startDate)
    : etToUtcTimestamp(16, 0, startDate);
  const bars = params.bars1m.length ? params.bars1m : params.bars5m;
  const window = bars.filter((bar) => bar.ts >= startTs && bar.ts <= params.ts);
  if (!window.length) return undefined;
  const high = Math.max(...window.map((bar) => bar.high));
  const low = Math.min(...window.map((bar) => bar.low));
  if (!Number.isFinite(high) || !Number.isFinite(low)) return undefined;
  return {
    low,
    high,
    source: session === "RTH" ? "RTH" : "OVERNIGHT",
    ts: params.ts,
  };
}

function findMicroBox(params: {
  bars: OHLCVBar[];
  atr?: number;
  maxBars: number;
  minWindow: number;
  source: "1m" | "5m";
  ts: number;
}): RangeBand | undefined {
  const { atr } = params;
  if (!Number.isFinite(atr) || (atr as number) <= 0) return undefined;
  const threshold = 0.6 * (atr as number);
  const recent = params.bars.slice(-params.maxBars);
  if (recent.length < params.minWindow) return undefined;
  let bestLow: number | undefined;
  let bestHigh: number | undefined;
  let bestRange = Number.POSITIVE_INFINITY;
  for (let windowSize = params.minWindow; windowSize <= recent.length; windowSize += 1) {
    for (let i = 0; i <= recent.length - windowSize; i += 1) {
      const window = recent.slice(i, i + windowSize);
      const high = Math.max(...window.map((bar) => bar.high));
      const low = Math.min(...window.map((bar) => bar.low));
      const width = high - low;
      if (width <= threshold && width < bestRange) {
        bestRange = width;
        bestLow = low;
        bestHigh = high;
      }
    }
  }
  if (bestLow === undefined || bestHigh === undefined) return undefined;
  return { low: bestLow, high: bestHigh, source: params.source, ts: params.ts };
}

function computeGateStatus(params: {
  entryPermission: EntryPermission;
  blockerReasons: string[];
  hardStopReasons: string[];
  hardWaitReasons: string[];
  softBlockerReasons: string[];
  indicators: { atr?: number; vwap?: number };
  price: number;
  relVol?: number;
  rearmVwapAtr: number;
}): GateStatus {
  const metrics: GateStatus["metrics"] = {
    atr: params.indicators.atr,
    vwap: params.indicators.vwap,
    relVol: params.relVol,
  };
  if (Number.isFinite(params.indicators.vwap) && Number.isFinite(params.indicators.atr) && params.indicators.atr) {
    const dist = Math.abs(params.price - (params.indicators.vwap as number));
    metrics.distToVwap = dist;
    metrics.distToVwapAtr = dist / (params.indicators.atr as number);
  }
  const blockedReasons = Array.from(
    new Set([
      ...params.hardStopReasons,
      ...params.hardWaitReasons,
      ...params.softBlockerReasons,
      ...params.blockerReasons,
    ])
  ).filter((reason) => typeof reason === "string" && reason.length > 0);
  let pendingGate: string | undefined;
  if (params.entryPermission === "WAIT_FOR_PULLBACK") {
    const pullbackMatch = blockedReasons
      .map((reason) => reason.match(/Pullback depth\s+([\d.]+)\s+is less than minimum\s+([\d.]+)/i))
      .find(Boolean);
    if (pullbackMatch) {
      const current = pullbackMatch[1];
      const min = pullbackMatch[2];
      pendingGate = `pullback depth >= ${min} ATR (now ${current})`;
    } else if (blockedReasons.some((reason) => /No reclaim signal/i.test(reason))) {
      pendingGate = "waiting on reclaim signal";
    } else if (Number.isFinite(metrics?.distToVwapAtr)) {
      pendingGate = `distance_to_VWAP <= ${params.rearmVwapAtr} ATR (now ${(metrics.distToVwapAtr as number).toFixed(2)})`;
    }
  }
  return {
    pendingGate,
    blockedReasons: blockedReasons.length ? blockedReasons : undefined,
    metrics,
  };
}

function computeRangeBias(params: {
  price: number;
  vwap?: number;
  microBox?: RangeBand;
  bars1m: OHLCVBar[];
  bars5m: OHLCVBar[];
  atr?: number;
}): { bias: Bias; confidence: number; note: string } {
  const bars = params.bars1m.length >= 5 ? params.bars1m.slice(-5) : params.bars5m.slice(-3);
  const slope = bars.length >= 2 ? bars[bars.length - 1]!.close - bars[0]!.close : 0;
  const atr = params.atr && params.atr > 0 ? params.atr : undefined;
  const slopeAtr = atr ? slope / atr : 0;
  const slopeDir = slopeAtr > 0.1 ? "UP" : slopeAtr < -0.1 ? "DOWN" : "FLAT";
  const micro = params.microBox;
  const width = micro ? micro.high - micro.low : undefined;
  const position = micro && width && width > 0 ? (params.price - micro.low) / width : 0.5;
  const aboveVwap = Number.isFinite(params.vwap) ? params.price > (params.vwap as number) : undefined;

  if (!micro) {
    const impulseUp = slopeAtr >= 0.2;
    const impulseDown = slopeAtr <= -0.2;
    if (impulseDown && aboveVwap === false) {
      return { bias: "SHORT", confidence: 55, note: "down momentum below VWAP" };
    }
    if (impulseUp && aboveVwap === true) {
      return { bias: "LONG", confidence: 55, note: "trend strength above VWAP" };
    }
    return { bias: "NEUTRAL", confidence: 50, note: "no micro box; neutral bias" };
  }

  if (slopeDir === "DOWN" && aboveVwap === false) {
    return { bias: "SHORT", confidence: 60, note: "down momentum below VWAP" };
  }
  if (slopeDir === "UP" && aboveVwap === true) {
    return { bias: "LONG", confidence: 60, note: "up momentum above VWAP" };
  }
  if (position <= 0.25 && slopeDir !== "UP") {
    return { bias: "SHORT", confidence: 55, note: "near lower rail" };
  }
  if (position >= 0.75 && slopeDir !== "DOWN") {
    return { bias: "LONG", confidence: 55, note: "near upper rail" };
  }
  return { bias: "NEUTRAL", confidence: 50, note: "mid-box / mixed momentum" };
}

function computeRangeRails(params: {
  ts: number;
  rangeCandidates: SetupCandidate[];
  recentBars1m: OHLCVBar[];
  recentBars5m: OHLCVBar[];
  atr1m?: number;
  atr5m?: number;
}): {
  rangeLow: number;
  rangeHigh: number;
  contextRange?: RangeBand;
  microBox?: RangeBand;
  buffer: number;
  minWidth: number;
  rangeWidth: number;
  planSource: { low: number; high: number };
  rangeTooTight: boolean;
} {
  const rangeLow = Math.min(...params.rangeCandidates.map((candidate) => candidate.entryZone.low));
  const rangeHigh = Math.max(...params.rangeCandidates.map((candidate) => candidate.entryZone.high));
  const rangeWidth = rangeHigh - rangeLow;
  const atr1m = params.atr1m ?? computeATR(params.recentBars1m, 14);
  const atr5m = params.atr5m ?? computeATR(params.recentBars5m, 14);
  const minWidth = Math.max(0.2, 0.25 * (atr1m ?? 0));
  const baseBuffer = Math.max(0.03, 0.1 * (atr1m ?? 0));
  const contextRange = computeContextRange({
    ts: params.ts,
    bars1m: params.recentBars1m,
    bars5m: params.recentBars5m,
  });
  const microBox =
    params.recentBars1m.length >= 20
      ? findMicroBox({
          bars: params.recentBars1m,
          atr: atr1m ?? atr5m,
          maxBars: 20,
          minWindow: 5,
          source: "1m",
          ts: params.ts,
        })
      : findMicroBox({
          bars: params.recentBars5m,
          atr: atr5m ?? atr1m,
          maxBars: 6,
          minWindow: 3,
          source: "5m",
          ts: params.ts,
        });
  const buffer = microBox ? baseBuffer : Math.max(baseBuffer, 0.05);
  const planSource = microBox ?? contextRange ?? { low: rangeLow, high: rangeHigh };
  const rangeTooTight = rangeWidth < minWidth;
  return {
    rangeLow,
    rangeHigh,
    contextRange,
    microBox,
    buffer,
    minWidth,
    rangeWidth,
    planSource,
    rangeTooTight,
  };
}

function assertNotMinimalModeLegacy(entry: string): void {
  if (process.env.BOT_MODE === "minimal") {
    throw new Error(`[MINIMAL MODE GUARD] ${entry} executed in minimal mode`);
  }
}

export function buildChopPlan(params: {
  ts: number;
  close: number;
  indicatorSnapshot: { vwap?: number };
  atr1m?: number;
  atr5m?: number;
  rangeCandidates: SetupCandidate[];
  recentBars1m: OHLCVBar[];
  recentBars5m: OHLCVBar[];
}): {
  range: { low: number; high: number };
  contextRange?: RangeBand;
  microBox?: RangeBand;
  longArm: string;
  longEntry: string;
  shortArm: string;
  shortEntry: string;
  stopAnchor: string;
  mode: string;
  note?: string;
  buffer: number;
  atr1m?: number;
  minWidth: number;
  rangeWidth: number;
  bias: { bias: Bias; confidence: number; note: string };
  activeSide: "LONG_ONLY" | "SHORT_ONLY" | "NONE";
  location: { zone: "LOW" | "MID" | "HIGH"; pos: number };
} {
  assertNotMinimalModeLegacy("buildChopPlan");
  const rails = computeRangeRails({
    ts: params.ts,
    rangeCandidates: params.rangeCandidates,
    recentBars1m: params.recentBars1m,
    recentBars5m: params.recentBars5m,
    atr1m: params.atr1m,
    atr5m: params.atr5m,
  });
  const atr1m = params.atr1m ?? computeATR(params.recentBars1m, 14);
  let mode = "NORMAL";
  let note: string | undefined;
  if (rails.rangeTooTight) {
    mode = "TIGHT";
    note = "range too tight — waiting for expansion";
  }
  const displayLow = rails.planSource.low;
  const displayHigh = rails.planSource.high;
  const width = displayHigh - displayLow;
  const pos = width > 0 ? (params.close - displayLow) / width : 0.5;
  let zone: "LOW" | "MID" | "HIGH" = "MID";
  if (pos <= 0.35) zone = "LOW";
  else if (pos >= 0.65) zone = "HIGH";
  const activeSide = zone === "LOW" ? "LONG_ONLY" : zone === "HIGH" ? "SHORT_ONLY" : "NONE";
  const longArm = `retest ${displayLow.toFixed(2)}-${displayHigh.toFixed(2)}`;
  const shortArm = longArm;
  const longEntry = `break&hold above ${(displayHigh + rails.buffer).toFixed(2)}`;
  const shortEntry = `break&hold below ${(displayLow - rails.buffer).toFixed(2)}`;
  const stopAnchor = `long < ${(displayLow - rails.buffer).toFixed(2)} | short > ${(displayHigh + rails.buffer).toFixed(2)} (armed)`;
  const bias = computeRangeBias({
    price: params.close,
    vwap: params.indicatorSnapshot.vwap,
    microBox: rails.microBox,
    bars1m: params.recentBars1m,
    bars5m: params.recentBars5m,
    atr: atr1m ?? params.atr5m,
  });
  return {
    range: { low: displayLow, high: displayHigh },
    contextRange: rails.contextRange,
    microBox: rails.microBox,
    longArm,
    longEntry,
    shortArm,
    shortEntry,
    stopAnchor,
    mode,
    note,
    buffer: rails.buffer,
    atr1m,
    minWidth: rails.minWidth,
    rangeWidth: rails.rangeWidth,
    bias,
    activeSide,
    location: { zone, pos: Number(pos.toFixed(2)) },
  };
}

const REGIME_15M_FAST_OPTIONS: Partial<RegimeOptions> = {
  minBars: 16,
  vwapPeriod: 12,
  vwapLookbackBars: 4,
  atrPeriod: 10,
  atrLookbackBars: 4,
  structureLookback: 16,
};

const REGIME_5M_PROVISIONAL_OPTIONS: Partial<RegimeOptions> = {
  ...REGIME_15M_FAST_OPTIONS,
  minBars: 12,
};

const REGIME_15M_MIN_BARS = REGIME_15M_FAST_OPTIONS.minBars ?? 30;

export class Orchestrator {
  private state: BotState;
  private instanceId: string;
  private llmService?: LLMService;
  private stopProfitRules: StopProfitRules;
  private entryFilters: EntryFilters;
  private setupEngine: SetupEngine;
  private llmCoachCache: Map<string, number> = new Map(); // playId_barTs -> timestamp (for entered plays)
  private llmArmedCoachCache: Map<string, number> = new Map(); // playId_barTs -> timestamp (for armed plays)
  private recentBars1m: OHLCVBar[] = []; // For entry tracking and stop checks
  private recentBars5m: OHLCVBar[] = []; // For setup detection (entries)
  private recentBars15m: OHLCVBar[] = []; // For regime + macro bias anchor
  private lastDiagnostics: SetupDiagnosticsSnapshot | null = null;
  private lastSetupSummary5mTs: number | null = null;
  private lastDecision: AuthoritativeDecision | null = null;
  private lastMarketState: Record<string, any> | null = null;
  private lastTimingSnapshot: Record<string, any> | null = null;
  private lastScorecardSnapshot: ScorecardSnapshot | null = null;
  private lastRangeWatchKey: string | null = null;
  private lastRangeWatchTs: number | null = null;
  private lastRangeWatchMetrics: {
    low: number;
    high: number;
    vwap?: number;
    contextLow?: number;
    contextHigh?: number;
    microLow?: number;
    microHigh?: number;
    warnKey: string;
    longEntry: string;
    shortEntry: string;
    mode?: string;
  } | null = null;
  private rangeFrozen: {
    range: { low: number; high: number };
    vwap?: number;
    price: number;
    contextRange?: RangeBand;
    microBox?: RangeBand;
    bias?: { bias: Bias; confidence: number; note: string };
    activeSide?: "LONG_ONLY" | "SHORT_ONLY" | "NONE";
    location?: { zone: "LOW" | "MID" | "HIGH"; pos: number };
    longArm: string;
    longEntry: string;
    shortArm: string;
    shortEntry: string;
    stopAnchor: string;
    mode: string;
    note?: string;
    buffer: number;
    atr1m?: number;
    minWidth: number;
    rangeWidth: number;
    ts: number;
  } | null = null;
  private lastSetupCandidates: SetupCandidate[] = [];
  private rangeTrendState: {
    state: "RANGE_ACTIVE" | "TREND_CANDIDATE" | "TREND_CONFIRMED";
    direction?: Direction;
    sinceTs?: number;
    confirmedBars?: number;
  } = { state: "RANGE_ACTIVE" };
  private lastVolumeRegime: string | null = null;
  private lastVolumeRegimeTs: number | null = null;
  private rangeModeActive: boolean = false;
  private rangeModeConsecutiveTrue: number = 0;
  private rangeModeConsecutiveFalse: number = 0;
  private lastRegime15m: RegimeResult | null = null;
  private lastMacroBias: Bias = "NEUTRAL";
  private lastRegime15mTs: number | null = null;
  private lastRegime15mReady: boolean = false;
  private last15mClose?: number;
  private last15mVwap?: number;
  private last15mEma9?: number;
  private last15mEma20?: number;
  private last15mVwapSlopePct?: number;
  private last15mEma20Slope?: number;
  private last15mStructure?: "BULLISH" | "BEARISH" | "MIXED" | "CHOP";
  private lastRegimeLabel?: RegimeResult["regime"];
  private transitionLockRemaining: number = 0;
  private readonly transitionLockBars: number = 3;

  private lastTacticalDirection?: Direction | "NEUTRAL";
  private pendingTacticalDirection?: Direction | "NEUTRAL";
  private pendingTacticalCount: number = 0;
  private lastTacticalFlipTs: number | null = null;
  private readonly tacticalFlipConfirmBars: number = 2;
  private readonly tacticalFlipCooldownMs: number;

  // Guardrail tracking
  private playsToday: number = 0;
  private currentETDay: string = "";
  private cooldownAfterStop: number | null = null;
  private cooldownAfterLLMPass: number | null = null;
  private cooldownAfterPlayClosed: number | null = null;

  // Datafeed resilience tracking
  private lastBarTs: number | null = null;
  private dataGapCooldown: number = 0; // Number of bars to skip after a gap
  private readonly maxGapMs: number; // Maximum allowed gap in ms (default 3 minutes)
  private readonly dataGapCooldownBars: number; // Bars to skip after gap (default 3)
  private readonly allowSyntheticBars: boolean; // Allow synthetic bars from close-only data

  // LLM reliability config
  private readonly llmTimeoutMs: number; // LLM timeout in ms (default 10s)
  private readonly allowRulesOnlyWhenLLMDown: boolean; // Allow A-grade setups without LLM when LLM is down
  private readonly rulesOnlyMinScore: number = 75; // Minimum score for rules-only mode
  private readonly enforceHighProbabilitySetups: boolean;
  private readonly minLlmProbability: number;
  private readonly minLlmAgreement: number;
  private readonly minRulesProbability: number;
  private readonly autoAllInOnHighProb: boolean;

  // POTD config (soft prior by default)
  private potdBias: PotdBias;
  private potdConfidence: number;
  private potdMode: PotdMode;
  private readonly potdPriorWeight: number;

  // Guardrail config (from env vars with defaults)
  private readonly maxPlaysPerETDay: number;
  private readonly cooldownAfterStopMin: number;
  private readonly cooldownAfterLLMPassMin: number;
  private readonly cooldownAfterPlayClosedMin: number;

  constructor(
    instanceId: string,
    llmService?: LLMService,
    initialState?: {
      activePlay?: Play | null;
      pendingPlay?: Play | null;
      pendingCandidate?: SetupCandidate | null;
      pendingCandidateExpiresAt?: number;
      potd?: { bias: PotdBias; confidence: number; mode: PotdMode; updatedAt?: number; source?: string };
      timingState?: TimingStateContext;
    }
  ) {
    this.instanceId = instanceId;
    this.llmService = llmService;
    this.stopProfitRules = new StopProfitRules();
    this.entryFilters = new EntryFilters();
    this.setupEngine = new SetupEngine();

    // Load guardrail config from env vars
    this.maxPlaysPerETDay = parseInt(process.env.MAX_PLAYS_PER_ET_DAY || "3", 10);
    this.cooldownAfterStopMin = parseInt(process.env.COOLDOWN_AFTER_STOP_MIN || "20", 10);
    this.cooldownAfterLLMPassMin = parseInt(process.env.COOLDOWN_AFTER_LLM_PASS_MIN || "5", 10);
    this.cooldownAfterPlayClosedMin = parseInt(process.env.COOLDOWN_AFTER_PLAY_CLOSED_MIN || "3", 10);

    // Load datafeed resilience config from env vars
    this.maxGapMs = parseInt(process.env.MAX_DATA_GAP_MS || "180000", 10); // Default 3 minutes
    this.dataGapCooldownBars = parseInt(process.env.DATA_GAP_COOLDOWN_BARS || "3", 10);
    this.allowSyntheticBars = process.env.ALLOW_SYNTHETIC_BARS === "true";
    this.tacticalFlipCooldownMs = parseInt(process.env.TACTICAL_FLIP_COOLDOWN_MS || "240000", 10);

    // Load LLM reliability config from env vars
    this.llmTimeoutMs = parseInt(process.env.LLM_TIMEOUT_MS || "10000", 10); // Default 10 seconds
    this.allowRulesOnlyWhenLLMDown = process.env.ALLOW_RULES_ONLY_WHEN_LLM_DOWN === "true";
    this.enforceHighProbabilitySetups = process.env.ENFORCE_HIGH_PROBABILITY_SETUPS !== "false";
    this.minLlmProbability = parseInt(process.env.MIN_LLM_PROBABILITY || "70", 10);
    this.minLlmAgreement = parseInt(process.env.MIN_LLM_AGREEMENT || "70", 10);
    this.minRulesProbability = parseInt(process.env.MIN_RULES_PROBABILITY || "70", 10);
    this.autoAllInOnHighProb = process.env.AUTO_ALL_IN_ON_HIGH_PROB !== "false";

    // Load POTD config from env vars
    const potdBiasRaw = (process.env.POTD_BIAS || "NONE").toUpperCase();
    this.potdBias = potdBiasRaw === "LONG" || potdBiasRaw === "SHORT" ? potdBiasRaw : "NONE";
    const potdModeRaw = (process.env.POTD_MODE || "PRIOR").toUpperCase();
    this.potdMode = potdModeRaw === "HARD" || potdModeRaw === "OFF" ? potdModeRaw : "PRIOR";
    const conf = parseFloat(process.env.POTD_CONFIDENCE || "0.6");
    this.potdConfidence = Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.6;
    const weight = parseInt(process.env.POTD_PRIOR_WEIGHT || "8", 10);
    this.potdPriorWeight = Number.isFinite(weight) ? Math.max(0, Math.min(20, weight)) : 8;

    // Initialize ET day tracking
    this.currentETDay = getETDateString();

    const activePlay = initialState?.activePlay ?? null;
    if (activePlay && !activePlay.status) {
      if (activePlay.stopHit) {
        activePlay.status = "CLOSED";
      } else if (activePlay.entered) {
        activePlay.status = "ENTERED";
      } else {
        activePlay.status = "ARMED";
      }
    }
    const pendingPlay = initialState?.pendingPlay ?? null;
    if (pendingPlay && !pendingPlay.status) {
      pendingPlay.status = "PENDING";
    }

    const initialPotd = initialState?.potd;
    if (initialPotd) {
      this.potdBias = initialPotd.bias;
      this.potdConfidence = initialPotd.confidence;
      this.potdMode = initialPotd.mode;
    }

    this.state = {
      startedAt: Date.now(),
      session: getMarketSessionLabel(),
      activePlay,
      pendingPlay,
      pendingCandidate: initialState?.pendingCandidate ?? null,
      pendingCandidateExpiresAt: initialState?.pendingCandidateExpiresAt,
      mode: "QUIET",
      potd: initialPotd,
      timingState: initialState?.timingState
    };
  }

  getPotdState(): { bias: PotdBias; confidence: number; mode: PotdMode; updatedAt?: number; source?: string } {
    return {
      bias: this.potdBias,
      confidence: this.potdConfidence,
      mode: this.potdMode,
      updatedAt: this.state.potd?.updatedAt,
      source: this.state.potd?.source,
    };
  }

  setPotdState(params: { bias: PotdBias; confidence?: number; mode?: PotdMode; source?: string }): void {
    this.potdBias = params.bias;
    if (params.confidence !== undefined) {
      this.potdConfidence = Math.max(0, Math.min(1, params.confidence));
    }
    if (params.mode) {
      this.potdMode = params.mode;
    }
    this.state.potd = {
      bias: this.potdBias,
      confidence: this.potdConfidence,
      mode: this.potdMode,
      updatedAt: Date.now(),
      source: params.source,
    };
  }

  private clampScore(value: number): number {
    return Math.max(0, Math.min(100, value));
  }

  private updateTimingState(params: {
    ts: number;
    direction: Direction | "NONE";
    timingSignal: TimingSignal;
    bar: OHLCVBar;
    inTrade: boolean;
  }): TimingStateContext {
    const { ts, direction, timingSignal, bar, inTrade } = params;
    const current =
      this.state.timingState ??
      ({
        phase: "IDLE",
        dir: "NONE",
        phaseSinceTs: ts,
        anchor: {},
        evidence: {},
        locks: {},
        lastUpdatedTs: ts,
      } as TimingStateContext);

    const next: TimingStateContext = { ...current, anchor: { ...current.anchor }, evidence: { ...current.evidence }, locks: { ...current.locks } };
    const directionChanged = direction !== "NONE" && current.dir !== "NONE" && direction !== current.dir;

    const setPhase = (phase: TimingStateContext["phase"]) => {
      if (next.phase !== phase) {
        next.phase = phase;
        next.phaseSinceTs = ts;
      }
    };

    if (inTrade) {
      next.dir = direction !== "NONE" ? direction : next.dir;
      setPhase("IN_TRADE");
      next.lastUpdatedTs = ts;
      this.state.timingState = next;
      return next;
    }

    if (direction !== "NONE") {
      next.dir = direction;
    }

    if (directionChanged && timingSignal.state === "IMPULSE_DETECTED") {
      setPhase("IMPULSE");
      next.anchor = { ...next.anchor, impulseStartPx: bar.close, impulseEndPx: bar.close };
      next.lastUpdatedTs = ts;
      this.state.timingState = next;
      return next;
    }

    switch (next.phase) {
      case "IDLE":
      case "DONE":
        if (timingSignal.state === "IMPULSE_DETECTED") {
          setPhase("IMPULSE");
          next.anchor = { ...next.anchor, impulseStartPx: bar.close, impulseEndPx: bar.close };
        } else if (timingSignal.state === "PULLBACK_IN_PROGRESS") {
          setPhase("PULLBACK");
        } else if (timingSignal.state === "ENTRY_WINDOW_OPEN") {
          setPhase("ENTRY_WINDOW");
        }
        break;
      case "IMPULSE":
        if (timingSignal.state === "PULLBACK_IN_PROGRESS") {
          setPhase("PULLBACK");
          next.anchor = {
            ...next.anchor,
            pullbackHighPx: bar.high ?? bar.close,
            pullbackLowPx: bar.low ?? bar.close,
          };
        } else if (timingSignal.state === "ENTRY_WINDOW_OPEN") {
          setPhase("ENTRY_WINDOW");
        }
        break;
      case "PULLBACK":
        if (timingSignal.state === "ENTRY_WINDOW_OPEN") {
          setPhase("ENTRY_WINDOW");
        } else if (timingSignal.state === "IMPULSE_DETECTED" && directionChanged) {
          setPhase("IMPULSE");
          next.anchor = { ...next.anchor, impulseStartPx: bar.close, impulseEndPx: bar.close };
        }
        break;
      case "ENTRY_WINDOW": {
        const maxHoldMs = 20 * 60_000;
        if (timingSignal.state === "IMPULSE_DETECTED" && directionChanged) {
          setPhase("IMPULSE");
          next.anchor = { ...next.anchor, impulseStartPx: bar.close, impulseEndPx: bar.close };
        } else if (ts - next.phaseSinceTs > maxHoldMs) {
          setPhase("DONE");
        }
        break;
      }
      case "IN_TRADE":
        break;
    }

    next.lastUpdatedTs = ts;
    this.state.timingState = next;
    return next;
  }

  getState(): BotState {
    // Keep session "truthful" even if no market data has arrived yet.
    this.state.session = getMarketSessionLabel();
    return this.state;
  }

  getLastDiagnostics(): SetupDiagnosticsSnapshot | null {
    return this.lastDiagnostics;
  }

  getLastDecision(): AuthoritativeDecision | null {
    return this.lastDecision;
  }

  getLastMarketState(): Record<string, any> | null {
    return this.lastMarketState;
  }

  getLastTimingSnapshot(): Record<string, any> | null {
    return this.lastTimingSnapshot;
  }

  /**
   * Get guardrail status for diagnostics
   */
  getGuardrailStatus(): {
    playsToday: number;
    maxPlaysPerETDay: number;
    currentETDay: string;
    cooldownAfterStop: { active: boolean; remainingMin?: number };
    cooldownAfterLLMPass: { active: boolean; remainingMin?: number };
    cooldownAfterPlayClosed: { active: boolean; remainingMin?: number };
  } {
    const now = Date.now();
    
    const getCooldownStatus = (cooldownTs: number | null, cooldownMin: number) => {
      if (cooldownTs === null) return { active: false };
      const cooldownMs = cooldownMin * 60 * 1000;
      const remaining = Math.ceil((cooldownTs + cooldownMs - now) / 1000 / 60);
      if (now < cooldownTs + cooldownMs) {
        return { active: true, remainingMin: remaining };
      }
      return { active: false };
    };

    return {
      playsToday: this.playsToday,
      maxPlaysPerETDay: this.maxPlaysPerETDay,
      currentETDay: this.currentETDay,
      cooldownAfterStop: getCooldownStatus(this.cooldownAfterStop, this.cooldownAfterStopMin),
      cooldownAfterLLMPass: getCooldownStatus(this.cooldownAfterLLMPass, this.cooldownAfterLLMPassMin),
      cooldownAfterPlayClosed: getCooldownStatus(this.cooldownAfterPlayClosed, this.cooldownAfterPlayClosedMin),
    };
  }

  /**
   * Check guardrails before arming a new play
   */
  private checkGuardrails(ts: number): { allowed: boolean; reason?: string } {
    const now = Date.now();
    const currentETDay = getETDateString(new Date(ts));

    // Reset counters on ET day rollover
    if (currentETDay !== this.currentETDay) {
      this.playsToday = 0;
      this.currentETDay = currentETDay;
      console.log(`[Guardrails] ET day rollover: ${currentETDay}, reset play counter`);
    }

    // Check max plays per day
    if (this.playsToday >= this.maxPlaysPerETDay) {
      return {
        allowed: false,
        reason: `max plays per day reached (${this.playsToday}/${this.maxPlaysPerETDay})`
      };
    }

    // Check cooldown after stop
    if (this.cooldownAfterStop !== null) {
      const cooldownMs = this.cooldownAfterStopMin * 60 * 1000;
      const remaining = Math.ceil((this.cooldownAfterStop + cooldownMs - now) / 1000 / 60);
      if (now < this.cooldownAfterStop + cooldownMs) {
        return {
          allowed: false,
          reason: `cooldown after stop active (${remaining} min remaining)`
        };
      }
      // Cooldown expired, clear it
      this.cooldownAfterStop = null;
    }

    // Check cooldown after LLM pass
    if (this.cooldownAfterLLMPass !== null) {
      const cooldownMs = this.cooldownAfterLLMPassMin * 60 * 1000;
      const remaining = Math.ceil((this.cooldownAfterLLMPass + cooldownMs - now) / 1000 / 60);
      if (now < this.cooldownAfterLLMPass + cooldownMs) {
        return {
          allowed: false,
          reason: `cooldown after LLM pass active (${remaining} min remaining)`
        };
      }
      // Cooldown expired, clear it
      this.cooldownAfterLLMPass = null;
    }

    // Check cooldown after play closed
    if (this.cooldownAfterPlayClosed !== null) {
      const cooldownMs = this.cooldownAfterPlayClosedMin * 60 * 1000;
      const remaining = Math.ceil((this.cooldownAfterPlayClosed + cooldownMs - now) / 1000 / 60);
      if (now < this.cooldownAfterPlayClosed + cooldownMs) {
        return {
          allowed: false,
          reason: `cooldown after play closed active (${remaining} min remaining)`
        };
      }
      // Cooldown expired, clear it
      this.cooldownAfterPlayClosed = null;
    }

    return { allowed: true };
  }

  private applyTacticalDebounce(snapshot: TacticalSnapshot, ts: number): TacticalSnapshot {
    if (snapshot.indicatorTf !== "1m") return snapshot;
    const candidateDir = snapshot.activeDirection;
    if (!this.lastTacticalDirection) {
      this.lastTacticalDirection = candidateDir;
      return snapshot;
    }
    if (candidateDir === this.lastTacticalDirection) {
      this.pendingTacticalDirection = undefined;
      this.pendingTacticalCount = 0;
      return snapshot;
    }

    if (this.lastTacticalFlipTs && ts - this.lastTacticalFlipTs < this.tacticalFlipCooldownMs) {
      return {
        ...snapshot,
        activeDirection: this.lastTacticalDirection,
        reasons: [...snapshot.reasons, "flip cooldown active"],
      };
    }

    if (this.pendingTacticalDirection === candidateDir) {
      this.pendingTacticalCount += 1;
    } else {
      this.pendingTacticalDirection = candidateDir;
      this.pendingTacticalCount = 1;
    }

    if (this.pendingTacticalCount >= this.tacticalFlipConfirmBars) {
      this.lastTacticalDirection = candidateDir;
      this.lastTacticalFlipTs = ts;
      this.pendingTacticalDirection = undefined;
      this.pendingTacticalCount = 0;
      return snapshot;
    }

    return {
      ...snapshot,
      activeDirection: this.lastTacticalDirection,
      reasons: [...snapshot.reasons, `await ${this.tacticalFlipConfirmBars - this.pendingTacticalCount} bar confirm`],
    };
  }

  setMode(mode: BotState["mode"]): void {
    this.state.mode = mode;
  }

  /**
   * Process tick and return ordered events
   * 
   * 1m: Entry + close-based stop checks
   * 5m: Arming + LLM coaching (only if active play + entered)
   */
  async processTick(
    input: TickInput,
    timeframe: "1m" | "5m" | "15m" = "1m"
  ): Promise<DomainEvent[]> {
    const snapshot = this.buildSnapshot(input, timeframe);
    const events: DomainEvent[] = [];
    const botMode = (process.env.BOT_MODE || "").toLowerCase();

    // Update state
    this.state.session = getMarketSessionLabel(new Date(input.ts));
    this.state.lastTickAt = input.ts;
    this.state.price = input.close;
    if (timeframe === "1m") {
      this.state.last1mTs = input.ts;
    } else if (timeframe === "5m") {
      this.state.last5mTs = input.ts;
    } else {
      this.state.last15mTs = input.ts;
    }

    if (botMode === "minimal") {
      if (timeframe === "5m") {
        console.log(`[TICK] branch=MINIMAL tf=5m ts=${input.ts}`);
        return await this.handleMinimal5m(snapshot);
      }
      if (timeframe !== "1m") {
        console.log(`[TICK] branch=MINIMAL tf=${timeframe} ts=${input.ts}`);
        return events;
      }
      console.log(`[TICK] branch=MINIMAL tf=1m ts=${input.ts}`);
      return await this.handleMinimal1m(snapshot);
    }

    if (process.env.BOT_MODE === "minimal") {
      throw new Error("LEGACY PATH EXECUTED IN MINIMAL MODE");
    }

    console.log(`[TICK] branch=LEGACY tf=${timeframe} ts=${input.ts}`);

    // Branch by timeframe
    if (timeframe === "1m") {
      events.push(...await this.handle1m(snapshot));
    } else if (timeframe === "5m") {
      events.push(...await this.handle5m(snapshot));
    } else {
      events.push(...await this.handle15m(snapshot));
    }

    return events;
  }

  private trackMinimalBar(snapshot: TickSnapshot, tf: "1m" | "5m"): void {
    const { ts, close, open, high, low, volume } = snapshot;
    if (high === undefined || low === undefined) {
      console.warn(`[MINIMAL] missing OHLC high/low for ${tf} bar ts=${ts}`);
      return;
    }
    const safeOpen = open ?? close;
    const safeVol = volume ?? 0;
    const bar = { ts, open: safeOpen, high, low, close, volume: safeVol };
    if (tf === "1m") {
      this.recentBars1m.push(bar);
      if (this.recentBars1m.length > 80) this.recentBars1m.shift();
    } else {
      this.recentBars5m.push(bar);
      if (this.recentBars5m.length > 120) this.recentBars5m.shift();
    }
  }

  private computeRelVol(bars: OHLCVBar[], window = 20): number | undefined {
    if (bars.length < 5) return undefined;
    const slice = bars.slice(-window);
    const volumes = slice.map((bar) => bar.volume).filter((v) => Number.isFinite(v)) as number[];
    if (volumes.length < 5) return undefined;
    const avg = volumes.reduce((sum, v) => sum + v, 0) / volumes.length;
    if (!Number.isFinite(avg) || avg <= 0) return undefined;
    const latest = volumes[volumes.length - 1];
    return latest / avg;
  }

  private buildForming5mBar(ts: number): {
    startTs: number;
    endTs: number;
    progressMinutes: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  } | null {
    const bucketMs = 5 * 60 * 1000;
    const startTs = Math.floor(ts / bucketMs) * bucketMs;
    const endTs = startTs + bucketMs;
    const bars = this.recentBars1m.filter((bar) => bar.ts >= startTs && bar.ts <= ts);
    if (bars.length === 0) return null;
    const highs = bars.map((bar) => bar.high);
    const lows = bars.map((bar) => bar.low);
    const volumes = bars.map((bar) => bar.volume ?? 0);
    const open = bars[0]?.open ?? bars[0]?.close;
    const close = bars[bars.length - 1]?.close;
    if (!Number.isFinite(open) || !Number.isFinite(close)) return null;
    const high = Math.max(...highs);
    const low = Math.min(...lows);
    const volume = volumes.reduce((sum, v) => sum + v, 0);
    const progressMinutes = Math.min(5, Math.max(1, Math.floor((ts - startTs) / 60000) + 1));
    return { startTs, endTs, progressMinutes, open, high, low, close, volume };
  }

  private buildImpulseContext(bars: OHLCVBar[]): {
    direction: "UP" | "DOWN" | "FLAT";
    move: number;
    range: number;
    bars: number;
  } | undefined {
    if (bars.length < 4) return undefined;
    const tail = bars.slice(-8);
    const opens = tail.map((bar) => bar.open);
    const closes = tail.map((bar) => bar.close);
    const highs = tail.map((bar) => bar.high);
    const lows = tail.map((bar) => bar.low);
    const firstOpen = opens[0] ?? closes[0];
    const lastClose = closes[closes.length - 1];
    if (!Number.isFinite(firstOpen) || !Number.isFinite(lastClose)) return undefined;
    const move = lastClose - firstOpen;
    const range = Math.max(...highs) - Math.min(...lows);
    const direction = move > 0.02 ? "UP" : move < -0.02 ? "DOWN" : "FLAT";
    return { direction, move, range, bars: tail.length };
  }

  private buildRangeContext(params: {
    ts: number;
    price: number;
    bars1m: OHLCVBar[];
    bars5m: OHLCVBar[];
    atr?: number;
  }): {
    contextRange?: RangeBand;
    microBox?: RangeBand;
    location?: { zone: "LOW" | "MID" | "HIGH"; pos: number };
  } {
    const contextRange = computeContextRange({
      ts: params.ts,
      bars1m: params.bars1m,
      bars5m: params.bars5m,
    });
    const microBox = params.atr
      ? findMicroBox({
          bars: params.bars1m.length ? params.bars1m : params.bars5m,
          atr: params.atr,
          maxBars: params.bars1m.length ? 20 : 6,
          minWindow: params.bars1m.length ? 5 : 3,
          source: params.bars1m.length ? "1m" : "5m",
          ts: params.ts,
        })
      : undefined;
    const range = microBox ?? contextRange;
    let location: { zone: "LOW" | "MID" | "HIGH"; pos: number } | undefined;
    if (range) {
      const width = range.high - range.low;
      if (width > 0) {
        const pos = Math.max(0, Math.min(1, (params.price - range.low) / width));
        const zone = pos <= 0.33 ? "LOW" : pos >= 0.67 ? "HIGH" : "MID";
        location = { zone, pos: Number(pos.toFixed(2)) };
      }
    }
    return { contextRange, microBox, location };
  }

  private computeSwingPoints(bars: OHLCVBar[], lookback: number): { high: number; low: number } | undefined {
    if (bars.length < Math.max(3, lookback)) return undefined;
    const window = bars.slice(-lookback);
    const highs = window.map((bar) => bar.high);
    const lows = window.map((bar) => bar.low);
    const high = Math.max(...highs);
    const low = Math.min(...lows);
    if (!Number.isFinite(high) || !Number.isFinite(low)) return undefined;
    return { high, low };
  }

  private extractActiveMind(mindState?: Record<string, any>): BotState["activeMind"] | undefined {
    if (!mindState || typeof mindState !== "object") return undefined;
    if (mindState.activeMind && typeof mindState.activeMind === "object") {
      const { mindId, bias, thesisState, invalidation_conditions } = mindState.activeMind as Record<string, any>;
      return {
        mindId: typeof mindId === "string" ? mindId : undefined,
        bias: bias === "LONG" || bias === "SHORT" || bias === "NEUTRAL" ? bias : undefined,
        thesisState: typeof thesisState === "string" ? thesisState : undefined,
        invalidation_conditions: Array.isArray(invalidation_conditions) ? invalidation_conditions : undefined,
      };
    }
    const mindId = typeof mindState.mindId === "string" ? mindState.mindId : undefined;
    const bias = mindState.bias === "LONG" || mindState.bias === "SHORT" || mindState.bias === "NEUTRAL" ? mindState.bias : undefined;
    const thesisState = typeof mindState.thesisState === "string" ? mindState.thesisState : undefined;
    const invalidation_conditions = Array.isArray(mindState.invalidation_conditions)
      ? mindState.invalidation_conditions
      : undefined;
    if (!mindId && !bias && !thesisState && !invalidation_conditions) return undefined;
    return { mindId, bias, thesisState, invalidation_conditions };
  }

  private validateInvalidation(mindState: Record<string, any>, activeMind?: BotState["activeMind"]): boolean {
    const reason = typeof mindState?.invalidation_reason === "string" ? mindState.invalidation_reason : "";
    const conditions = activeMind?.invalidation_conditions;
    if (!reason || !Array.isArray(conditions) || conditions.length === 0) return false;
    const needle = reason.toLowerCase();
    return conditions.some((condition) => typeof condition === "string" && needle.includes(condition.toLowerCase()));
  }

  private async handleMinimal5m(snapshot: TickSnapshot): Promise<DomainEvent[]> {
    const { ts, symbol, close } = snapshot;
    this.trackMinimalBar(snapshot, "5m");
    console.log(`[MINIMAL] handler=handleMinimal5m symbol=${symbol} ts=${ts}`);

    const indicators5m = buildIndicatorSet(this.recentBars5m, "5m");
    const relVol = this.computeRelVol(this.recentBars1m);
    const closed5mBars = this.recentBars5m.slice(-12).map((bar) => ({
      ts: bar.ts,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    }));
    const rangeContext = this.buildRangeContext({
      ts,
      price: close,
      bars1m: this.recentBars1m,
      bars5m: this.recentBars5m,
      atr: indicators5m.atr,
    });
    const swingPoints =
      this.computeSwingPoints(this.recentBars5m, 12) ??
      this.computeSwingPoints(this.recentBars1m, 20);
    const previousMindState = this.state.mindState;
    const mindState = this.llmService
      ? await this.llmService.getMindState({
          mode: "MIND_5M_CLOSE",
          symbol,
          price: close,
          indicators: indicators5m,
          indicators5m,
          relVol,
          freshness: this.buildFreshness(ts),
          closed5mBars,
          rangeContext,
          swingPoints,
          previousMindState,
          activeMind: this.state.activeMind,
        })
      : { summary: "LLM unavailable", bias: "NEUTRAL", conviction: 0, notes: [] };
    const nextActiveMind = this.extractActiveMind(mindState) ?? this.state.activeMind;

    this.state.mindState = mindState;
    this.state.activeMind = nextActiveMind;
    this.state.lastLLMCallAt = ts;
    this.state.lastLLMDecision = mindState.summary;

    const direction = mindState.bias;
    console.log(`[MINIMAL] MIND_STATE_UPDATED symbol=${symbol} ts=${ts} mode=MIND_5M_CLOSE`);

    return [
      {
        type: "MIND_STATE_UPDATED",
        timestamp: ts,
        instanceId: this.instanceId,
        data: {
          timestamp: ts,
          symbol,
          price: close,
          direction,
          indicators: indicators5m,
          mindState,
          activeMind: nextActiveMind,
          mode: "MIND_5M_CLOSE",
        },
      },
    ];
  }

  private async handleMinimal1m(snapshot: TickSnapshot): Promise<DomainEvent[]> {
    const { ts, symbol, close } = snapshot;
    this.trackMinimalBar(snapshot, "1m");
    console.log(`[MINIMAL] handler=handleMinimal1m symbol=${symbol} ts=${ts}`);

    const indicators1m = buildIndicatorSet(this.recentBars1m, "1m");
    const indicators5m = this.recentBars5m.length >= 6 ? buildIndicatorSet(this.recentBars5m, "5m") : undefined;
    const relVol = this.computeRelVol(this.recentBars1m);
    const volumePolicySnapshot = relVol !== undefined ? volumePolicy(relVol) : undefined;
    const volumeLine =
      relVol !== undefined && volumePolicySnapshot
        ? `${volumePolicySnapshot.label} (${relVol.toFixed(2)}x)`
        : undefined;
    const indicators = {
      vwap1m: indicators1m.vwap,
      atr1m: indicators1m.atr,
      rsi14_1m: indicators1m.rsi14,
      vwap5m: indicators5m?.vwap,
      atr5m: indicators5m?.atr,
      rsi14_5m: indicators5m?.rsi14,
      relVol,
    };
    const closed5mBars = this.recentBars5m.slice(-12).map((bar) => ({
      ts: bar.ts,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    }));
    const forming5mBar = this.buildForming5mBar(ts);
    if (forming5mBar) {
      console.log(`[MINIMAL] forming5mBar progress=${forming5mBar.progressMinutes} start=${forming5mBar.startTs}`);
    }
    const impulseContext = this.buildImpulseContext(this.recentBars1m);
    const rangeContext = this.buildRangeContext({
      ts,
      price: close,
      bars1m: this.recentBars1m,
      bars5m: this.recentBars5m,
      atr: indicators1m.atr ?? indicators5m?.atr,
    });
    const swingPoints =
      this.computeSwingPoints(this.recentBars5m, 12) ??
      this.computeSwingPoints(this.recentBars1m, 20);
    const recent1mBars = this.recentBars1m.slice(-12).map((bar) => ({
      ts: bar.ts,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    }));
    const previousMindState = this.state.mindState;
    const mindState = this.llmService
      ? await this.llmService.getMindState({
          mode: "EXEC_1M",
          symbol,
          price: close,
          indicators,
          indicators1m,
          indicators5m: indicators5m ?? {},
          relVol,
          freshness: this.buildFreshness(ts),
          closed5mBars,
          forming5mBar,
          recent1mBars,
          impulseContext,
          rangeContext,
          swingPoints,
          previousMindState,
          activeMind: this.state.activeMind,
        })
      : { summary: "LLM unavailable", bias: "NEUTRAL", conviction: 0, notes: [] };
    const rawAction = typeof mindState.action === "string" ? mindState.action.toUpperCase() : "HOLD";
    const action = ["HOLD", "ARM", "ENTER", "RESET", "INVALID", "SUSPEND"].includes(rawAction) ? rawAction : "HOLD";
    const activeMind = this.state.activeMind;
    let normalizedMindState: Record<string, any> = { ...mindState, action };
    if (activeMind?.bias && mindState.bias && mindState.bias !== activeMind.bias && !["RESET", "INVALID"].includes(action)) {
      console.log(`[MINIMAL] ignored_bias_flip_1m from=${mindState.bias} to=${activeMind.bias}`);
      normalizedMindState = { ...normalizedMindState, bias: activeMind.bias };
    }
    if (action === "INVALID" && !this.validateInvalidation(mindState, activeMind)) {
      console.log("[MINIMAL] invalid_invalid: invalidation_reason does not match activeMind.invalidation_conditions");
      normalizedMindState = {
        ...normalizedMindState,
        action: "RESET",
        reset_reason: normalizedMindState.reset_reason ?? "invalid_invalid",
      };
    }
    const nextActiveMind = this.extractActiveMind(normalizedMindState) ?? this.state.activeMind;

    this.state.mindState = normalizedMindState;
    this.state.activeMind = nextActiveMind;
    this.state.lastLLMCallAt = ts;
    this.state.lastLLMDecision = normalizedMindState.summary;

    const direction = normalizedMindState.bias;
    console.log(`[MINIMAL] MIND_STATE_UPDATED symbol=${symbol} ts=${ts} mode=EXEC_1M`);

    return [
      {
        type: "MIND_STATE_UPDATED",
        timestamp: ts,
        instanceId: this.instanceId,
        data: {
          timestamp: ts,
          symbol,
          price: close,
          direction,
          indicators,
          mindState: normalizedMindState,
          activeMind: nextActiveMind,
          mode: "EXEC_1M",
          volume: {
            relVol,
            line: volumeLine,
          },
        },
      },
    ];
  }

  private buildSnapshot(input: TickInput, timeframe: "1m" | "5m" | "15m"): TickSnapshot {
    return { ...input, timeframe };
  }

  private buildFreshness(nowTs: number): DataFreshness {
    const age1mSec = this.state.last1mTs ? Math.round((nowTs - this.state.last1mTs) / 1000) : undefined;
    const age5mSec = this.state.last5mTs ? Math.round((nowTs - this.state.last5mTs) / 1000) : undefined;
    return {
      nowTs,
      last1mTs: this.state.last1mTs,
      last5mTs: this.state.last5mTs,
      age1mSec,
      age5mSec,
      barCount1m: this.recentBars1m.length,
      barCount5m: this.recentBars5m.length,
      session: this.state.session,
      lastTradePx: this.state.price,
    };
  }

  /**
   * Handle 1m bars: Entry detection + close-based stop checks
   */
  private async handle1m(snapshot: TickSnapshot): Promise<DomainEvent[]> {
    assertNotMinimalModeLegacy("handle1m");
    const events: DomainEvent[] = [];
    const { ts, symbol, close, high, low, open, volume } = snapshot;
    const buildTacticalInference = () => {
      const indicators1m = buildIndicatorSet(this.recentBars1m, "1m");
      const confirmIndicators = this.recentBars5m.length >= 6 ? buildIndicatorSet(this.recentBars5m, "5m") : undefined;
      const tacticalSnapshot = buildTacticalSnapshot({
        bars: this.recentBars1m,
        indicators: indicators1m,
        tf: "1m",
        confirmBars: this.recentBars5m.length >= 6 ? this.recentBars5m : undefined,
        confirmIndicators,
      });
      return {
        tacticalSnapshot,
        directionInference: {
          direction: tacticalSnapshot.activeDirection === "NEUTRAL" ? undefined : tacticalSnapshot.activeDirection,
          confidence: tacticalSnapshot.confidence,
          reasons: tacticalSnapshot.reasons,
          indicatorTf: tacticalSnapshot.indicatorTf,
        },
      };
    };

    // Datafeed resilience: Check for time gaps
    if (this.lastBarTs !== null) {
      const gapMs = ts - this.lastBarTs;
      if (gapMs > this.maxGapMs) {
        const gapMinutes = Math.round(gapMs / 60000);
        console.log(`[Datafeed] Time gap detected: ${gapMinutes} minutes (${gapMs}ms). Resetting recentBars and starting cooldown.`);
        this.recentBars1m = []; // Reset 1m history after gap
        this.dataGapCooldown = this.dataGapCooldownBars;
        this.lastBarTs = ts;
        
        // Set diagnostics for gap
        if (!this.state.activePlay) {
          const tactical = buildTacticalInference();
          this.lastDiagnostics = {
            ts,
            symbol,
            close,
            regime: this.lastRegime15m ?? computeRegime(this.recentBars1m, close),
            macroBias: this.lastMacroBias,
            directionInference: tactical.directionInference,
            tacticalSnapshot: tactical.tacticalSnapshot,
            setupReason: `data gap: ${gapMinutes} min gap detected, resetting history`,
            datafeedIssue: `time gap: ${gapMinutes} minutes (${gapMs}ms)`,
          };
          this.lastDecision = buildNoEntryDecision({
            ts,
            symbol,
            reason: "datafeed",
            reasonDetail: `time gap: ${gapMinutes} minutes`
          });
        }
        return events; // Skip this bar
      }
    }

    // Datafeed resilience: Check for missing high/low (required for OHLC)
    if (high === undefined || low === undefined) {
      if (this.allowSyntheticBars && close !== undefined) {
        // Create synthetic bar from close-only data
        const syntheticHigh = close;
        const syntheticLow = close;
        const safeOpen = open ?? close;
        const safeVol = volume ?? 0;
        console.log(`[Datafeed] Missing high/low, creating synthetic bar from close=${close} (ALLOW_SYNTHETIC_BARS=true)`);
        this.recentBars1m.push({ ts, open: safeOpen, high: syntheticHigh, low: syntheticLow, close, volume: safeVol });
        this.lastBarTs = ts;
        if (this.dataGapCooldown > 0) this.dataGapCooldown--;
        // Keep enough history for ATR/RSI/EMA (direction + filters)
        if (this.recentBars1m.length > 80) this.recentBars1m.shift();
      } else {
        // Missing required OHLC data - log and set diagnostics
        const missing = [];
        if (high === undefined) missing.push("high");
        if (low === undefined) missing.push("low");
        console.log(`[Datafeed] Insufficient OHLC data: missing ${missing.join(", ")}. Skipping bar.`);
        
        if (!this.state.activePlay) {
          const tactical = buildTacticalInference();
          this.lastDiagnostics = {
            ts,
            symbol,
            close,
            regime: this.lastRegime15m ?? computeRegime(this.recentBars1m, close),
            macroBias: this.lastMacroBias,
            directionInference: tactical.directionInference,
            tacticalSnapshot: tactical.tacticalSnapshot,
            setupReason: `insufficient OHLC: missing ${missing.join(", ")}`,
            datafeedIssue: `missing OHLC fields: ${missing.join(", ")}`,
          };
          this.lastDecision = buildNoEntryDecision({
            ts,
            symbol,
            reason: "datafeed",
            reasonDetail: `missing OHLC: ${missing.join(", ")}`
          });
        }
        return events; // Skip this bar
      }
    } else {
      // Valid bar with high/low - process normally
      const safeOpen = open ?? close;
      const safeVol = volume ?? 0;
      this.recentBars1m.push({ ts, open: safeOpen, high, low, close, volume: safeVol });
      this.lastBarTs = ts;
      if (this.dataGapCooldown > 0) this.dataGapCooldown--;
      // Keep enough history for ATR/RSI/EMA (direction + filters)
      if (this.recentBars1m.length > 80) this.recentBars1m.shift();
    }

    // Skip processing during data gap cooldown
    if (this.dataGapCooldown > 0) {
      console.log(`[Datafeed] Data gap cooldown active: ${this.dataGapCooldown} bars remaining`);
      if (!this.state.activePlay) {
        const tactical = buildTacticalInference();
        this.lastDiagnostics = {
          ts,
          symbol,
          close,
          regime: this.lastRegime15m ?? computeRegime(this.recentBars1m, close),
          macroBias: this.lastMacroBias,
          directionInference: tactical.directionInference,
          tacticalSnapshot: tactical.tacticalSnapshot,
          setupReason: `data gap cooldown: ${this.dataGapCooldown} bars remaining`,
          datafeedIssue: `cooldown after gap: ${this.dataGapCooldown} bars`,
        };
        this.lastDecision = buildNoEntryDecision({
          ts,
          symbol,
          reason: "datafeed",
          reasonDetail: `data gap cooldown: ${this.dataGapCooldown} bars`
        });
      }
      return events; // Skip processing during cooldown
    }

    // Entries are evaluated on 5m bars; 1m bars only manage entry + stops.
    if (!this.state.activePlay) {
      return events;
    }

    const play = this.state.activePlay!;
    const softManagementActive =
      this.lastMarketState?.permission?.mode === "REDUCE_SIZE" ||
      this.lastMarketState?.permission?.mode === "SCALP_ONLY" ||
      this.lastMarketState?.tacticalBias?.shock === true ||
      this.transitionLockRemaining > 0;
    if (softManagementActive) {
      if (play.mode === "FULL") {
        play.mode = "SCOUT"; // reduce adds while soft blockers are active
      }
      play.coachingState = {
        ...(play.coachingState ?? {}),
        intent: "PROTECT",
      };
    }
    const buildDecisionPayload = (params: {
      kind: "GATE" | "EXECUTION" | "MANAGEMENT";
      status: string;
      allowed?: boolean;
      direction?: "LONG" | "SHORT" | "NONE";
      gateTier?: "LEANING" | "STRICT" | "OPEN";
      blockers?: string[];
      blockerReasons?: string[];
      rationale?: string[];
      permissionMode?: "SCALP_ONLY" | "NORMAL" | "REDUCE_SIZE" | "WATCH_ONLY";
      decisionState?: "SIGNAL" | "WATCH" | "UPDATE" | "MANAGE";
    }) => {
      const permission = {
        long: play.direction === "LONG",
        short: play.direction === "SHORT",
        mode: params.permissionMode ?? (play.tier === "LEANING" ? "SCALP_ONLY" : "NORMAL")
      };
      return {
        decisionId: `${play.symbol}_${ts}_${play.id}`,
        status: params.status,
        kind: params.kind,
        ...(params.allowed !== undefined ? { allowed: params.allowed } : {}),
        permission,
        direction: params.direction ?? play.direction,
        ...(params.kind === "GATE" ? { gateTier: params.gateTier ?? (play.tier === "LEANING" ? "LEANING" : "OPEN") } : {}),
        blockers: params.blockers,
        blockerReasons: params.blockerReasons,
        rationale: params.rationale,
        decisionState: params.decisionState ?? "MANAGE"
      };
    };

    if (play.status === "ARMED" && play.expiresAt && ts >= play.expiresAt) {
      const decision = buildNoEntryDecision({
        ts,
        symbol: play.symbol,
        reason: "expired",
        reasonDetail: `expired at ${new Date(play.expiresAt).toISOString()}`
      });
      this.lastDecision = decision;
      events.push(this.ev("NO_ENTRY", ts, {
        playId: decision.decisionId,
        symbol: play.symbol,
        direction: play.direction,
        decisionState: "UPDATE",
        decision: {
          decisionId: decision.decisionId,
          status: decision.status,
          blockers: decision.blockers,
          blockerReasons: decision.blockerReasons,
          kind: "GATE",
          allowed: false,
          permission: {
            long: play.direction === "LONG",
            short: play.direction === "SHORT",
            mode: play.tier === "LEANING" ? "SCALP_ONLY" : "NORMAL"
          },
          direction: play.direction,
          gateTier: "STRICT",
          rationale: decision.blockerReasons,
          decisionState: "UPDATE"
        },
        blockerTags: decision.blockers,
        blockerReasons: decision.blockerReasons,
        playState: "CANDIDATE",
        notArmedReason: decision.blockerReasons?.join(" | ")
      }));
      play.status = "CLOSED";
      this.state.activePlay = null;
      return events;
    }

    const inZone = close >= play.entryZone.low && close <= play.entryZone.high;
    const vwap1m = computeSessionVWAP(this.recentBars1m);
    const atr1m = computeATR(this.recentBars1m, 14);
    const timingSignal = computeTimingSignal({
      bars: this.recentBars1m.length ? this.recentBars1m : this.recentBars5m,
      direction: play.direction,
      entryZone: play.entryZone,
      vwap: vwap1m,
      atr: atr1m
    });
    const barRef: OHLCVBar = {
      ts,
      open: open ?? close,
      high: high ?? close,
      low: low ?? close,
      close,
      volume: volume ?? 0
    };
    const timingState = this.updateTimingState({
      ts,
      direction: play.direction,
      timingSignal,
      bar: barRef,
      inTrade: play.status === "ENTERED"
    });
    const timingSnapshot = {
      ...timingSignal,
      phase: timingState.phase,
      dir: timingState.dir,
      phaseSinceTs: timingState.phaseSinceTs,
      rawState: timingSignal.state
    };

    // 1) Zone touch + timing score arms an ENTRY_WINDOW (does NOT enter)
    if (inZone && play.status === "ARMED" && !play.inEntryZone) {
      if (timingSignal.score < 70) {
        // Keep waiting for timing to confirm
        return events;
      }
      play.inEntryZone = true;
      play.status = "ENTRY_WINDOW";
      play.entryWindowOpenedTs = ts;
      play.reclaim = { step: "WAIT_RECLAIM" };

      events.push(this.ev("ENTRY_WINDOW_OPENED", ts, {
        playId: play.id,
        symbol: play.symbol,
        direction: play.direction,
        price: close,
        entryZone: play.entryZone,
        timing: timingSnapshot,
        decision: buildDecisionPayload({
          kind: "EXECUTION",
          status: "ARMED",
          allowed: true,
          rationale: ["price entered zone", `timing score=${timingSignal.score}`]
        }),
        playState: "ARMED",
        armReason: "armed; waiting for depth trigger"
      }));
    }

    // 2) While in ENTRY_WINDOW, wait for depth trigger inside zone
    if (play.status === "ENTRY_WINDOW") {
      const maxWindowMs = play.tier === "LEANING" ? 12 * 60_000 : 20 * 60_000;
      if (play.entryWindowOpenedTs && ts - play.entryWindowOpenedTs > maxWindowMs) {
        play.status = "CANCELLED";
        events.push(this.ev("PLAY_CANCELLED", ts, {
          playId: play.id,
          symbol: play.symbol,
          direction: play.direction,
          price: close,
          reason: "Entry window expired",
          timing: timingSnapshot,
          decision: buildDecisionPayload({
            kind: "EXECUTION",
            status: "CANCELLED",
            allowed: false,
            rationale: ["Entry window expired"]
          }),
          playState: "CANDIDATE",
          notArmedReason: "Entry window expired"
        }));
        this.state.activePlay = null;
        return events;
      }

      if (play.direction === "LONG" && close <= play.stop) {
        play.status = "CANCELLED";
        events.push(this.ev("PLAY_CANCELLED", ts, {
          playId: play.id,
          symbol: play.symbol,
          direction: play.direction,
          price: close,
          reason: "Pre-entry stop break",
          timing: timingSnapshot,
          decision: buildDecisionPayload({
            kind: "EXECUTION",
            status: "CANCELLED",
            allowed: false,
            rationale: ["Pre-entry stop break"]
          }),
          playState: "CANDIDATE",
          notArmedReason: "Pre-entry stop break"
        }));
        this.state.activePlay = null;
        return events;
      }
      if (play.direction === "SHORT" && close >= play.stop) {
        play.status = "CANCELLED";
        events.push(this.ev("PLAY_CANCELLED", ts, {
          playId: play.id,
          symbol: play.symbol,
          direction: play.direction,
          price: close,
          reason: "Pre-entry stop break",
          timing: timingSnapshot,
          decision: buildDecisionPayload({
            kind: "EXECUTION",
            status: "CANCELLED",
            allowed: false,
            rationale: ["Pre-entry stop break"]
          }),
          playState: "CANDIDATE",
          notArmedReason: "Pre-entry stop break"
        }));
        this.state.activePlay = null;
        return events;
      }

      const zoneWidth = play.entryZone.high - play.entryZone.low;
      const entryTrigger = play.direction === "LONG"
        ? play.entryZone.low + 0.35 * zoneWidth
        : play.entryZone.high - 0.35 * zoneWidth;
      const depthHit = play.direction === "LONG"
        ? (low ?? close) <= entryTrigger
        : (high ?? close) >= entryTrigger;

      const timingEnterScore = play.tier === "LEANING" ? 65 : 80;
      if (depthHit && timingSignal.score >= timingEnterScore) {
        play.status = "ENTERED";
        play.entryPrice = close;
        play.entryTimestamp = ts;
        play.mode = "SCOUT";
        play.reclaim = { step: "WAIT_RECLAIM", confirmations: 0 };
        const enteredTimingState = this.updateTimingState({
          ts,
          direction: play.direction,
          timingSignal,
          bar: barRef,
          inTrade: true
        });
        const enteredTimingSnapshot = {
          ...timingSnapshot,
          phase: enteredTimingState.phase,
          dir: enteredTimingState.dir,
          phaseSinceTs: enteredTimingState.phaseSinceTs
        };
        const baseSnapshot = play.armedSnapshot ?? {
          timestamp: ts,
          symbol: play.symbol,
          timeframe: "1m",
          candidates: [],
          lowContext: { active: false, reasons: [] }
        };
        play.entrySnapshot = {
          ...baseSnapshot,
          timestamp: ts,
          timeframe: "1m",
          timing: enteredTimingSnapshot
        };

        events.push(this.ev("PLAY_ENTERED", ts, {
          playId: play.id,
          symbol: play.symbol,
          direction: play.direction,
          price: close,
          entryPrice: play.entryPrice,
          entryTrigger,
          reason: "Pullback depth hit",
          timing: enteredTimingSnapshot,
          decisionState: "UPDATE",
          decision: buildDecisionPayload({
            kind: "EXECUTION",
            status: "ENTERED",
            allowed: true,
            rationale: ["pullback depth hit", `timing score=${timingSignal.score}`],
            decisionState: "UPDATE"
          }),
          playState: "ENTERED",
          armReason: "depth trigger hit"
        }));
      }
    }
    if (!inZone) {
      play.inEntryZone = false;
    }

    // Hard stop check on CLOSE (only exit trigger - no override)
    // Use actual entry price if available, otherwise use entryZone midpoint
    const entryPrice = play.entryPrice ?? (play.entryZone.low + (play.entryZone.high - play.entryZone.low) / 2);
    const rulesContext = this.stopProfitRules.getContext(play, close, entryPrice);
    
    // Check hard stop on CLOSE (only close price triggers stop, not wicks)
    if (rulesContext.stopHitOnClose && !play.stopHit) {
      play.stopHit = true;
      play.status = "CLOSED";
      // Set cooldown after stop
      this.cooldownAfterStop = Date.now();
      console.log(`[Guardrails] Stop hit, cooldown set for ${this.cooldownAfterStopMin} minutes`);
      // Set cooldown after play closed
      this.cooldownAfterPlayClosed = Date.now();
      // INVARIANT: PLAY_CLOSED must have matching active play (verified - we have play)
      const playPermissionMode = play.mode === "SCOUT" ? "SCALP_ONLY" : "NORMAL";
      events.push(this.ev("PLAY_CLOSED", ts, {
        playId: play.id,
        symbol: play.symbol,
        direction: play.direction,
        close,
        stop: play.stop,
        reason: "Stop loss hit on close (hard rule)",
        result: "LOSS",
        exitType: "STOP_HIT",
        llmAction: "N/A", // Hard stop, LLM not consulted
        decision: buildDecisionPayload({
          kind: "MANAGEMENT",
          status: "CLOSED",
          allowed: true,
          permissionMode: playPermissionMode,
          rationale: ["stop loss hit on close"]
        }),
        playState: "ENTERED"
      }));
      this.state.activePlay = null;
      return events;
    }

    if (play.status === "ENTERED" && play.mode === "SCOUT" && !play.stopHit) {
      const closes1m = this.recentBars1m.map((b) => b.close);
      const ema9_1m = computeEMA(closes1m.slice(-60), 9);
      const ema20_1m = computeEMA(closes1m.slice(-80), 20);

      const confirm = this.confirmEntryOnPullbackReclaim(play, {
        ts,
        close,
        ema9: ema9_1m,
        ema20: ema20_1m
      });

      if (confirm.ok) {
        play.mode = "FULL";
        const sizedPermissionMode = "NORMAL";
        events.push(this.ev("PLAY_SIZED_UP", ts, {
          playId: play.id,
          symbol: play.symbol,
          direction: play.direction,
          mode: play.mode,
          reason: confirm.reason,
          decision: buildDecisionPayload({
            kind: "MANAGEMENT",
            status: "ENTERED",
            allowed: true,
            permissionMode: sizedPermissionMode,
            rationale: [confirm.reason]
          }),
          playState: "ENTERED"
        }));
      } else if (confirm.shouldCancel) {
        play.status = "CLOSED";
        const playPermissionMode = play.mode === "SCOUT" ? "SCALP_ONLY" : "NORMAL";
        events.push(this.ev("PLAY_CLOSED", ts, {
          playId: play.id,
          symbol: play.symbol,
          direction: play.direction,
          close,
          stop: play.stop,
          reason: confirm.reason,
          result: "LOSS",
          exitType: "TIME_STOP",
          llmAction: "RULES_EXIT",
          decision: buildDecisionPayload({
            kind: "MANAGEMENT",
            status: "CLOSED",
            allowed: true,
            permissionMode: playPermissionMode,
            rationale: [confirm.reason]
          }),
          playState: "ENTERED"
        }));
        this.cooldownAfterPlayClosed = Date.now();
        this.state.activePlay = null;
        return events;
      }
    }

    return events;
  }

  private evaluateHighProbabilityGate(params: {
    candidate: SetupCandidate;
    directionInference: DirectionInference;
    llm?: DecisionLlmSummary;
  }): {
    allowed: boolean;
    reason?: string;
    metrics: {
      llmProbability?: number;
      llmAgreement?: number;
      rulesScore: number;
      rulesConfidence: number;
      rulesProbability: number;
    };
  } {
    const { candidate, directionInference, llm } = params;
    const llmProbability = Number.isFinite(llm?.probability) ? (llm?.probability as number) : undefined;
    const llmAgreement = Number.isFinite(llm?.agreement) ? (llm?.agreement as number) : undefined;
    const rulesScore = Number.isFinite(candidate?.score?.total) ? candidate.score.total : 0;
    const rulesConfidence = Number.isFinite(directionInference?.confidence) ? directionInference.confidence : 0;
    const rulesProbability = Math.max(rulesScore, rulesConfidence);

    const failures: string[] = [];
    if (!llm || llmProbability === undefined || llmAgreement === undefined) {
      failures.push("LLM scorecard required");
    } else {
      if (llmProbability < this.minLlmProbability) {
        failures.push(`LLM probability ${Math.round(llmProbability)} < ${this.minLlmProbability}`);
      }
      if (llmAgreement < this.minLlmAgreement) {
        failures.push(`LLM agreement ${Math.round(llmAgreement)} < ${this.minLlmAgreement}`);
      }
      if (llm.action === "WAIT") {
        failures.push("LLM action WAIT");
      }
    }

    if (rulesProbability < this.minRulesProbability) {
      failures.push(`Rules confidence ${Math.round(rulesProbability)} < ${this.minRulesProbability} (score=${Math.round(rulesScore)}, dir=${Math.round(rulesConfidence)})`);
    }

    return {
      allowed: failures.length === 0,
      reason: failures.length ? `high-prob filter: ${failures.join("; ")}` : undefined,
      metrics: {
        llmProbability,
        llmAgreement,
        rulesScore,
        rulesConfidence,
        rulesProbability
      }
    };
  }

  /**
   * Handle 15m bars: update regime + macro bias anchor (with hysteresis)
   */
  private async handle15m(snapshot: TickSnapshot): Promise<DomainEvent[]> {
    assertNotMinimalModeLegacy("handle15m");
    const { ts, close, open, high, low, volume } = snapshot;

    if (high !== undefined && low !== undefined) {
      const safeOpen = open ?? close;
      const safeVol = volume ?? 0;
      this.recentBars15m.push({ ts, open: safeOpen, high, low, close, volume: safeVol });
      if (this.recentBars15m.length > 120) this.recentBars15m.shift();
    }

    if (this.recentBars15m.length < 6) {
      return [];
    }

    const rawRegime = computeRegime(this.recentBars15m, close, REGIME_15M_FAST_OPTIONS);
    const rawBias = computeMacroBias(this.recentBars15m, close, REGIME_15M_FAST_OPTIONS);

    const closes = this.recentBars15m.map((b) => b.close);
    const ema9 = computeEMA(closes.slice(-40), 9);
    const ema20 = computeEMA(closes.slice(-80), 20);
    const vwap = computeVWAP(this.recentBars15m, 30);
    const ema20Slope = computeEmaSlopePct(closes, 20, 3);

    const lastTwo = this.recentBars15m.slice(-2);
    const hasTwo = lastTwo.length === 2;
    const belowMean = hasTwo && vwap !== undefined && ema20 !== undefined
      ? lastTwo.every((b) => b.close < vwap && b.close < ema20)
      : false;
    const aboveMean = hasTwo && vwap !== undefined && ema20 !== undefined
      ? lastTwo.every((b) => b.close > vwap && b.close > ema20)
      : false;
    const structure = rawRegime.structure;

    const confirmDown = belowMean && structure === "BEARISH";
    const confirmUp = aboveMean && structure === "BULLISH";

    const hysteresisNotes: string[] = [];

    let finalRegime = rawRegime.regime;
    if (this.lastRegime15m?.regime === "TREND_UP" && rawRegime.regime === "TREND_DOWN" && !confirmDown) {
      finalRegime = "TRANSITION";
      hysteresisNotes.push("hysteresis: TREND_UP->TREND_DOWN needs 2 closes below VWAP+EMA20 + BEARISH structure");
    } else if (this.lastRegime15m?.regime === "TREND_DOWN" && rawRegime.regime === "TREND_UP" && !confirmUp) {
      finalRegime = "TRANSITION";
      hysteresisNotes.push("hysteresis: TREND_DOWN->TREND_UP needs 2 closes above VWAP+EMA20 + BULLISH structure");
    }

    let finalBias = rawBias.bias;
    if (this.lastMacroBias === "LONG" && rawBias.bias === "SHORT" && !confirmDown) {
      finalBias = "LONG";
      hysteresisNotes.push("bias hold: LONG bias until confirmed downshift");
    } else if (this.lastMacroBias === "SHORT" && rawBias.bias === "LONG" && !confirmUp) {
      finalBias = "SHORT";
      hysteresisNotes.push("bias hold: SHORT bias until confirmed upshift");
    }

    const anchorReady = this.recentBars15m.length >= REGIME_15M_MIN_BARS;
    const readinessNote = anchorReady
      ? []
      : [`15m anchor warming: ${this.recentBars15m.length}/${REGIME_15M_MIN_BARS} bars`];
    const mergedRegime: RegimeResult = {
      ...rawRegime,
      regime: finalRegime,
      reasons: [...rawRegime.reasons, ...hysteresisNotes, ...readinessNote]
    };

    if (this.lastRegimeLabel && mergedRegime.regime !== this.lastRegimeLabel) {
      this.transitionLockRemaining = this.transitionLockBars;
    } else if (this.transitionLockRemaining > 0) {
      this.transitionLockRemaining -= 1;
    }
    this.lastRegimeLabel = mergedRegime.regime;

    this.lastRegime15m = mergedRegime;
    this.lastMacroBias = finalBias;
    this.lastRegime15mTs = ts;
    this.lastRegime15mReady = anchorReady;
    this.last15mClose = close;
    this.last15mVwap = vwap;
    this.last15mEma9 = ema9;
    this.last15mEma20 = ema20;
    this.last15mVwapSlopePct = mergedRegime.vwapSlopePct;
    this.last15mEma20Slope = ema20Slope;
    this.last15mStructure = mergedRegime.structure;

    return [];
  }

  /**
   * Handle 5m bars: Two separate LLM coaching loops
   * 1. ARMED_COACH: If play is ARMED but not entered (pre-entry commentary)
   * 2. LLM_COACH_UPDATE: If play is entered (position management)
   */
  private async handle5m(snapshot: TickSnapshot): Promise<DomainEvent[]> {
    assertNotMinimalModeLegacy("handle5m");
    const events: DomainEvent[] = [];
    const { ts, symbol, close, open, high, low, volume } = snapshot;

    // Explicit log for 5m bar close with full bar data
    const playId = this.state.activePlay?.id || "none";
    const entered = this.state.activePlay?.status === "ENTERED";
    console.log(`[5m] barClose ts=${ts} o=${open?.toFixed(2) || "N/A"} h=${high?.toFixed(2) || "N/A"} l=${low?.toFixed(2) || "N/A"} c=${close.toFixed(2)} v=${volume || "N/A"} play=${playId} entered=${entered}`);

    // Track 5m history for setup detection
    if (high !== undefined && low !== undefined) {
      const safeOpen = open ?? close;
      const safeVol = volume ?? 0;
      this.recentBars5m.push({ ts, open: safeOpen, high, low, close, volume: safeVol });
      if (this.recentBars5m.length > 120) this.recentBars5m.shift();
    }

    // Gate 1 - If no active play → evaluate new setups on 5m bars
    if (!this.state.activePlay) {
      const watchOnly = this.state.mode !== "ACTIVE";

      if (this.recentBars5m.length < 6) {
        const fallbackRegime = this.lastRegime15mReady && this.lastRegime15m
          ? this.lastRegime15m
          : computeRegime(this.recentBars5m, close, REGIME_5M_PROVISIONAL_OPTIONS);
        const fallbackIndicators = buildIndicatorSet(this.recentBars1m, "1m");
        const fallbackRaw = buildTacticalSnapshot({
          bars: this.recentBars1m,
          indicators: fallbackIndicators,
          tf: "1m",
          confirmBars: this.recentBars5m.length >= 6 ? this.recentBars5m : undefined,
          confirmIndicators: this.recentBars5m.length >= 6 ? buildIndicatorSet(this.recentBars5m, "5m") : undefined,
        });
        const fallbackTactical = this.applyTacticalDebounce(fallbackRaw, ts);
        this.lastDiagnostics = {
          ts,
          symbol,
          close,
          regime: fallbackRegime,
          macroBias: this.lastRegime15mReady ? this.lastMacroBias : "NEUTRAL",
          directionInference: {
            direction: fallbackTactical.activeDirection === "NEUTRAL" ? undefined : fallbackTactical.activeDirection,
            confidence: fallbackTactical.confidence,
            reasons: fallbackTactical.reasons,
            indicatorTf: fallbackTactical.indicatorTf,
          },
          tacticalSnapshot: fallbackTactical,
          setupReason: "insufficient 5m history (< 6 bars)",
        };
        this.lastDecision = buildDecision({
          ts,
          symbol,
          blockers: ["no_active_play"],
          blockerReasons: ["insufficient 5m history (< 6 bars)"],
          expiryMs: 30 * 60 * 1000
        });
        return events;
      }

      const rawRegime5m = computeRegime(this.recentBars5m, close, REGIME_5M_PROVISIONAL_OPTIONS);
      const anchorReady = this.lastRegime15mReady && !!this.lastRegime15m;
      const anchorRegime = anchorReady
        ? this.lastRegime15m!
        : {
            ...rawRegime5m,
            reasons: [...rawRegime5m.reasons, "anchor=5m provisional until 15m mature"]
          };
      const anchorLabel = anchorReady ? "15m" : "5m provisional";
      const macroBiasInfo = anchorReady
        ? { bias: this.lastMacroBias, reasons: ["anchor=15m"] }
        : { bias: "NEUTRAL" as Bias, reasons: ["anchor=5m provisional: bias neutral"] };

      const indicators1m = buildIndicatorSet(this.recentBars1m, "1m");
      const indicators5m = buildIndicatorSet(this.recentBars5m, "5m");

      const tacticalPrimaryBars = this.recentBars1m.length >= 6 ? this.recentBars1m : this.recentBars5m;
      const tacticalPrimaryIndicators = tacticalPrimaryBars === this.recentBars1m ? indicators1m : indicators5m;
      const tacticalPrimaryTf = tacticalPrimaryBars === this.recentBars1m ? "1m" : "5m";
      const tacticalRaw = buildTacticalSnapshot({
        bars: tacticalPrimaryBars,
        indicators: tacticalPrimaryIndicators,
        tf: tacticalPrimaryTf,
        confirmBars: tacticalPrimaryTf === "1m" && this.recentBars5m.length >= 6 ? this.recentBars5m : undefined,
        confirmIndicators: tacticalPrimaryTf === "1m" ? indicators5m : undefined,
      });
      let tacticalSnapshot =
        tacticalPrimaryTf === "1m" ? this.applyTacticalDebounce(tacticalRaw, ts) : tacticalRaw;
      const dirInf = {
        direction: tacticalSnapshot.activeDirection === "NEUTRAL" ? undefined : tacticalSnapshot.activeDirection,
        confidence: tacticalSnapshot.confidence,
        reasons: tacticalSnapshot.reasons,
        indicatorTf: tacticalSnapshot.indicatorTf,
      };
      if (!dirInf.direction) {
        console.log(`[5m] Tactical direction unclear (continuing): ${dirInf.reasons.join(" | ")}`);
      }
      const tacticalBiasInfo: ReturnType<typeof inferTacticalBiasFromRecentBars> = {
        bias: tacticalSnapshot.activeDirection === "NEUTRAL" ? "NONE" : tacticalSnapshot.activeDirection,
        tier: tacticalSnapshot.tier,
        score: tacticalSnapshot.score,
        confidence: tacticalSnapshot.confidence,
        reasons: tacticalSnapshot.reasons,
        shock: tacticalSnapshot.shock,
        shockReason: tacticalSnapshot.shockReason,
        indicatorTf: tacticalSnapshot.indicatorTf,
      };

      const atr = indicators5m.atr;
      const ema9 = indicators5m.ema9;
      const ema20 = indicators5m.ema20;
      const vwap = indicators5m.vwap;
      const rsi14 = indicators5m.rsi14;
      const closes = this.recentBars5m.map((b) => b.close);
      const ema20Slope5m = computeEmaSlopePct(closes, 20, 3);
      const indicatorReadiness = {
        hasBars: this.recentBars5m.length >= 30,
        hasATR: !!atr && atr > 0,
        hasEMA9: ema9 !== undefined,
        hasEMA20: ema20 !== undefined,
        hasVWAP: vwap !== undefined,
        hasTimingInputs: (this.recentBars1m.length >= 6) || (this.recentBars5m.length >= 6),
      };
      const readinessMissing = Object.entries(indicatorReadiness)
        .filter(([_, ok]) => !ok)
        .map(([key]) => key.replace(/^has/, ""));
      const readinessOk = readinessMissing.length === 0;

      const tacticalBias: Direction | "NONE" = tacticalBiasInfo.bias;
      const directionGate: DirectionGate = (() => {
        if (tacticalBias === "NONE" || tacticalBiasInfo.tier === "NONE") {
          return {
            allow: false,
            tier: "NONE" as const,
            reason: `tactical direction NEUTRAL (${tacticalBiasInfo.tier})`
          };
        }
        const tier = tacticalBiasInfo.tier === "CLEAR" ? "LOCKED" : "LEANING";
        return {
          allow: true,
          tier,
          direction: tacticalBias as Direction,
          reason: `tactical direction ${tacticalBias} (${tacticalBiasInfo.tier}, ${tacticalBiasInfo.confidence}%)${tacticalBiasInfo.shock ? " | shock mode" : ""}`
        };
      })();

      const transitionLockActive = this.transitionLockRemaining > 0;
      const shockMode = tacticalBiasInfo.shock;
      const regimeConfidence = anchorRegime.bullScore !== undefined && anchorRegime.bearScore !== undefined
        ? Math.round(Math.max(anchorRegime.bullScore, anchorRegime.bearScore) / 3 * 100)
        : undefined;
      const anchorProvisional = !anchorReady;
      const permissionMode: "SCALP_ONLY" | "NORMAL" | "REDUCE_SIZE" | "WATCH_ONLY" = (() => {
        if (anchorRegime.regime === "CHOP" || anchorRegime.regime === "TRANSITION") return "SCALP_ONLY";
        if (shockMode || transitionLockActive || anchorProvisional) return "REDUCE_SIZE";
        return "NORMAL";
      })();
      const permission = {
        long: true,
        short: true,
        mode: permissionMode,
      };

      const setupResult = this.setupEngine.findSetup({
        ts,
        symbol,
        currentPrice: close,
        bars: this.recentBars5m,
        volumeBars: this.recentBars1m,
        regime: anchorRegime,
        macroBias: macroBiasInfo.bias,
        directionInference: dirInf,
        tacticalBias: { bias: tacticalBiasInfo.bias, tier: tacticalBiasInfo.tier },
        indicators: { tf: "5m", vwap, ema9, ema20, atr, rsi14 }
      });

      const setupCandidates = setupResult.candidates ?? (setupResult.candidate ? [setupResult.candidate] : []);
      const pending = this.state.pendingCandidate;
      if (pending) {
        const expired = this.state.pendingCandidateExpiresAt !== undefined && ts >= this.state.pendingCandidateExpiresAt;
        const directionMismatch = directionGate.allow && pending.direction !== directionGate.direction;
        const stopInvalid =
          pending.direction === "LONG" ? close <= pending.stop : close >= pending.stop;
        if (expired || directionMismatch || stopInvalid) {
          this.state.pendingCandidate = null;
          this.state.pendingCandidateExpiresAt = undefined;
        } else {
          const existing = setupCandidates.find((candidate) => candidate.id === pending.id);
          if (!existing) {
            setupCandidates.push({
              ...pending,
              stage: pending.stage ?? "EARLY",
              holdReason: pending.holdReason ?? "WAIT_FOR_PULLBACK",
              warningFlags: pending.warningFlags ?? pending.flags,
            });
          }
        }
      }
      this.lastSetupCandidates = setupCandidates;
      const potdActivePre = this.potdMode !== "OFF" && this.potdBias !== "NONE" && this.potdConfidence > 0;
      const potdConfirmedPre = potdActivePre && macroBiasInfo.bias === this.potdBias;
      const potdAlignmentNoCandidate: "ALIGNED" | "COUNTERTREND" | "UNCONFIRMED" | "OFF" = !potdActivePre
        ? "OFF"
        : "UNCONFIRMED";
      if (!readinessOk) {
        const missingList = readinessMissing.join(", ");
        for (const candidate of setupCandidates) {
          candidate.stage = "EARLY";
          candidate.qualityTag = "LOW";
          candidate.holdReason = `WARMUP: missing ${missingList}`;
          candidate.flags = [...(candidate.flags ?? []), "MISSING_INDICATORS"];
        }
      }
      const indicatorBundle = {
        ema9_1m: indicators1m.ema9,
        ema20_1m: indicators1m.ema20,
        vwap_1m: indicators1m.vwap,
        ema9_5m: indicators5m.ema9,
        ema20_5m: indicators5m.ema20,
        vwap_5m: indicators5m.vwap,
      };
      for (const candidate of setupCandidates) {
        const emaStack5m = indicators5m.ema9 !== undefined && indicators5m.ema20 !== undefined
          ? (indicators5m.ema9 > indicators5m.ema20 ? "BULL" : "BEAR")
          : undefined;
        if (
          (emaStack5m === "BULL" && candidate.direction === "SHORT") ||
          (emaStack5m === "BEAR" && candidate.direction === "LONG")
        ) {
          candidate.flags = Array.from(new Set([...(candidate.flags ?? []), "COUNTER_5M_STACK"]));
        }
        candidate.featureBundle = {
          ...(candidate.featureBundle ?? {}),
          indicators: indicatorBundle,
        };
      }
      const stageCounts = setupCandidates.reduce<Record<string, number>>((acc, candidate) => {
        const stage = candidate.stage ?? "READY";
        acc[stage] = (acc[stage] ?? 0) + 1;
        return acc;
      }, {});
      const patternCounts = setupCandidates.reduce<Record<string, number>>((acc, candidate) => {
        acc[candidate.pattern] = (acc[candidate.pattern] ?? 0) + 1;
        return acc;
      }, {});
      const directionCounts = setupCandidates.reduce<Record<string, number>>((acc, candidate) => {
        acc[candidate.direction] = (acc[candidate.direction] ?? 0) + 1;
        return acc;
      }, {});
      const candidatePatterns = new Set(setupCandidates.map((candidate) => candidate.pattern));
      const candidateDirections = new Set(setupCandidates.map((candidate) => candidate.direction));
      const lowContextReasons: string[] = [];
      if (setupCandidates.length < 3) lowContextReasons.push(`candidateCount=${setupCandidates.length}`);
      if (candidatePatterns.size < 2) lowContextReasons.push(`patternDiversity=${candidatePatterns.size}`);
      if (candidateDirections.size < 2) lowContextReasons.push(`directionDiversity=${candidateDirections.size}`);
      const lowContext = lowContextReasons.length > 0;
      if (setupCandidates.length === 0) {
        this.lastDiagnostics = {
          ts,
          symbol,
          close,
          regime: anchorRegime,
          macroBias: macroBiasInfo.bias,
          directionInference: dirInf,
          tacticalSnapshot,
          tacticalBias: tacticalBiasInfo,
          setupReason: setupResult.reason || "no setup pattern found",
          setupDebug: setupResult.debug,
          candidateStats: {
            candidateCount: 0,
            stageCounts,
            patternCounts,
            directionCounts,
            llmInvoked: false,
            lowContext: lowContext,
          },
          regimeEvidence: anchorRegime.bullScore !== undefined && anchorRegime.bearScore !== undefined ? {
            bullScore: anchorRegime.bullScore,
            bearScore: anchorRegime.bearScore,
          } : undefined,
        };
        console.log(`[5m] No setup candidates: ${setupResult.reason || "unknown"}`);
        const topPlay = {
          setup: "N/A",
          direction: tacticalSnapshot.activeDirection,
          score: 0,
          quality: "D",
          qualityTag: "No candidates",
          armStatus: "NOT ARMED",
          entryZone: undefined,
          stop: undefined,
          probability: undefined,
          action: undefined
        };
        const marketStateForNoCandidates = {
          regime: anchorRegime.regime,
          confidence: regimeConfidence,
          permission,
          tacticalSnapshot,
          tacticalBias: {
            bias: tacticalBias,
            tier: tacticalBiasInfo.tier,
            score: tacticalBiasInfo.score,
            confidence: tacticalBiasInfo.confidence,
            shock: shockMode,
            shockReason: tacticalBiasInfo.shockReason,
            reasons: tacticalBiasInfo.reasons,
          },
          dataReadiness: {
            ready: readinessOk,
            missing: readinessMissing,
            bars: this.recentBars5m.length,
          },
          reason: [
            anchorRegime.reasons?.[0],
            `tactical=${tacticalBias}${tacticalBias !== "NONE" ? `(${tacticalBiasInfo.confidence}%, score=${tacticalBiasInfo.score})` : ""}`,
            shockMode ? `shock mode: ${tacticalBiasInfo.shockReason ?? "range expansion"}` : undefined,
            transitionLockActive ? `transition lock (${this.transitionLockRemaining}/${this.transitionLockBars})` : undefined,
            directionGate.reason
          ]
            .filter(Boolean)
            .join(" | "),
          potd: {
            bias: this.potdBias,
            mode: this.potdMode,
            alignment: potdAlignmentNoCandidate,
            overridden: false,
          }
        };
        this.lastMarketState = marketStateForNoCandidates;
        this.lastTimingSnapshot = null;
        events.push(this.ev("SETUP_CANDIDATES", ts, {
          symbol,
          price: close,
          topPlay,
          candidates: [],
          marketState: marketStateForNoCandidates,
          timing: undefined,
          decision: {
            kind: "GATE",
            status: "NO_SETUP",
            allowed: false,
            rationale: [setupResult.reason || "no setup pattern found"]
          },
          playState: "CANDIDATE",
          notArmedReason: setupResult.reason || "no setup pattern found"
        }));
        this.lastDecision = buildDecision({
          ts,
          symbol,
          blockers: ["no_active_play"],
          blockerReasons: [setupResult.reason || "no setup pattern found"],
          expiryMs: 30 * 60 * 1000
        });
        return events;
      }

      let setupCandidate = setupResult.candidate ?? setupCandidates[0]!;
      const pendingCandidate = this.state.pendingCandidate;
      if (pendingCandidate) {
        const pendingMatch = setupCandidates.find((candidate) => candidate.id === pendingCandidate.id);
        if (pendingMatch) {
          setupCandidate = pendingMatch;
        }
      }
      let timingSnapshot: TimingSignal & { phase: TimingPhase; dir: Direction | "NONE"; phaseSinceTs: number; rawState: TimingSignal["state"] } | undefined;
      let blockers: DecisionBlocker[] = [];
      let blockerReasons: string[] = [];
      let guardrailBlockReason: string | undefined;
      let guardrailBlockTag: DecisionBlocker | undefined;
      const potdActive = this.potdMode !== "OFF" && this.potdBias !== "NONE" && this.potdConfidence > 0;
      const potdConfirmed = potdActive && macroBiasInfo.bias === this.potdBias;
      if (potdActive && this.potdMode === "PRIOR") {
        for (const candidate of setupCandidates) {
          const delta = Math.round(this.potdPriorWeight * this.potdConfidence * (candidate.direction === this.potdBias ? 1 : -1));
          candidate.score.total = this.clampScore(candidate.score.total + delta);
          candidate.rationale.push(`potdPrior=${delta} (bias=${this.potdBias} conf=${this.potdConfidence})`);
        }
      }
      let potdAlignment: "ALIGNED" | "COUNTERTREND" | "UNCONFIRMED" | "OFF" = !potdActive
        ? "OFF"
        : !potdConfirmed
        ? "UNCONFIRMED"
        : setupCandidate.direction === this.potdBias
        ? "ALIGNED"
        : "COUNTERTREND";
      let potdCountertrend = potdConfirmed && setupCandidate.direction !== this.potdBias;

      if (potdCountertrend) {
        const nextFlags = new Set([...(setupCandidate.flags ?? [])]);
        nextFlags.add("POTD_COUNTERTREND");
        setupCandidate.flags = Array.from(nextFlags);
        setupCandidate.warningFlags = setupCandidate.warningFlags ?? setupCandidate.flags;
      }

      // Direction gating is handled by tactical bias; regime/macro is risk-mode only.

      const marketState = {
        regime: anchorRegime.regime,
        confidence: regimeConfidence,
        permission,
        tacticalSnapshot,
        tacticalBias: {
          bias: tacticalBias,
          tier: tacticalBiasInfo.tier,
          score: tacticalBiasInfo.score,
          confidence: tacticalBiasInfo.confidence,
          shock: shockMode,
          shockReason: tacticalBiasInfo.shockReason,
          reasons: tacticalBiasInfo.reasons,
        },
        dataReadiness: {
          ready: readinessOk,
          missing: readinessMissing,
          bars: this.recentBars5m.length,
        },
        reason: [
          anchorRegime.reasons?.[0],
          `tactical=${tacticalBias}${tacticalBias !== "NONE" ? `(${tacticalBiasInfo.confidence}%, score=${tacticalBiasInfo.score})` : ""}`,
          shockMode ? `shock mode: ${tacticalBiasInfo.shockReason ?? "range expansion"}` : undefined,
          transitionLockActive ? `transition lock (${this.transitionLockRemaining}/${this.transitionLockBars})` : undefined,
          directionGate.reason
        ]
          .filter(Boolean)
          .join(" | "),
        potd: {
          bias: this.potdBias,
          mode: this.potdMode,
          alignment: potdAlignment,
          overridden: potdCountertrend
        }
      };

      let filterResult: EntryFilterResult = {
        allowed: true,
        warnings: [],
        permission: "ALLOWED",
      };

      this.lastDiagnostics = {
        ts,
        symbol,
        close,
        regime: anchorRegime,
        macroBias: macroBiasInfo.bias,
        directionInference: dirInf,
        tacticalSnapshot,
        tacticalBias: tacticalBiasInfo,
        candidate: setupCandidate,
        entryFilterWarnings: filterResult.warnings,
        entryPermission: filterResult.permission,
        candidateStats: {
          candidateCount: setupCandidates.length,
          stageCounts,
          patternCounts,
          directionCounts,
          llmInvoked: false,
          lowContext: lowContext,
        },
        potd: {
          bias: this.potdBias,
          confidence: this.potdConfidence,
          mode: this.potdMode,
          alignment: potdAlignment,
        },
        setupDebug: setupResult.debug,
        regimeEvidence: anchorRegime.bullScore !== undefined && anchorRegime.bearScore !== undefined ? {
          bullScore: anchorRegime.bullScore,
          bearScore: anchorRegime.bearScore,
        } : undefined,
      };

      const guardrailCheck = this.checkGuardrails(ts);
      if (!guardrailCheck.allowed) {
        const isCooldown = guardrailCheck.reason?.includes("cooldown");
        guardrailBlockTag = isCooldown ? "cooldown" : "guardrail";
        guardrailBlockReason = guardrailCheck.reason;
        if (this.lastDiagnostics) {
          this.lastDiagnostics = {
            ...this.lastDiagnostics,
            guardrailBlock: guardrailCheck.reason,
            setupReason: `guardrail: ${guardrailCheck.reason}`
          };
        }
      }

      const candidateVolume = setupCandidate.featureBundle?.volume;
      const relVol = candidateVolume?.relVolume;
      const volumeFlags = new Set([
        ...(setupCandidate.warningFlags ?? []),
        ...(setupCandidate.flags ?? [])
      ]);
      const isThinTape = volumeFlags.has("THIN_TAPE") || (relVol !== undefined && relVol < 0.7);
      const isLowVol = false;
      const isVolSpike = volumeFlags.has("VOL_SPIKE") || (relVol !== undefined && relVol >= 1.5);
      const isClimaxVol = volumeFlags.has("CLIMAX_VOL") || (relVol !== undefined && relVol >= 2.5);
      const volumeNote = relVol !== undefined ? `relVol=${relVol.toFixed(2)}` : "relVol=n/a";
      const volumeWarnings: string[] = [];
      if (isThinTape) volumeWarnings.push(`THIN_TAPE: ${volumeNote}`);
      else if (isLowVol) volumeWarnings.push(`LOW_VOL: ${volumeNote}`);
      if (isVolSpike) volumeWarnings.push(`VOL_SPIKE: ${volumeNote}`);
      if (isClimaxVol) volumeWarnings.push(`CLIMAX_VOL: ${volumeNote}`);
      const volumeRegime =
        relVol === undefined ? "UNKNOWN" : relVol < 0.7 ? "THIN_TAPE" : relVol > 1.5 ? "HEAVY" : "NORMAL";
      const confirmBarsRequired = volumeRegime === "HEAVY" ? 1 : 2;
      const requiresRetest = volumeRegime === "THIN_TAPE";
      const volumeRelText = relVol !== undefined ? relVol.toFixed(2) : "n/a";
      const volumeRule = relVol === undefined
        ? "missing relVol"
        : `${confirmBarsRequired} closes${requiresRetest ? " + retest" : ""}`;
      const volumeLine =
        relVol === undefined
          ? "UNKNOWN (missing relVol) -> downgrade to WATCH"
          : `relVol=${volumeRelText} (${volumeRegime}) | rule=${volumeRule}`;
      const volumePayload = {
        regime: volumeRegime,
        label: volumeRegime,
        relVol,
        confirmBarsRequired,
        requiresRetest,
        closesMet: 0,
        retestOk: !requiresRetest,
        line: volumeLine,
      };
      const volumeCap = isThinTape ? 70 : isLowVol ? 85 : isClimaxVol ? 90 : undefined;
      const structureAligned =
        (tacticalSnapshot.activeDirection === "LONG" && anchorRegime.structure === "BULLISH") ||
        (tacticalSnapshot.activeDirection === "SHORT" && anchorRegime.structure === "BEARISH");
      if (volumeCap !== undefined && tacticalSnapshot.confidence > volumeCap && (!structureAligned || volumeCap < 90)) {
        tacticalSnapshot = {
          ...tacticalSnapshot,
          confidence: volumeCap,
          reasons: [...(tacticalSnapshot.reasons ?? []), `volume cap=${volumeCap}`]
        };
      }

      const dirWarning = `Tactical direction: ${tacticalSnapshot.activeDirection} (confidence=${tacticalSnapshot.confidence}%, tf=${tacticalSnapshot.indicatorTf}) | ${tacticalSnapshot.reasons.join(" | ")}`;
      const confirmWarning = tacticalSnapshot.confirm
        ? `Tactical confirm (5m): ${tacticalSnapshot.confirm.bias} (${tacticalSnapshot.confirm.confidence}%) | ${tacticalSnapshot.confirm.reasons.join(" | ")}`
        : undefined;
      const regimeWarning = `Context (regime ${anchorLabel}): ${anchorRegime.regime} | ${anchorRegime.reasons.join(" | ")}`;
      const biasWarning = `Context (macro ${anchorLabel}): ${macroBiasInfo.bias}`;
      const entryPermission = filterResult.permission ?? "ALLOWED";
      const permissionWarning = `Entry permission: ${entryPermission}${filterResult.reason ? ` (${filterResult.reason})` : ""}`;
      const potdWarning = potdActive
        ? `POTD: ${this.potdBias} (conf=${this.potdConfidence.toFixed(2)} mode=${this.potdMode}) alignment=${potdAlignment}`
        : "POTD: OFF";
      const indicatorMeta = {
        entryTF: "5m",
        directionTF: tacticalSnapshot.indicatorTf,
        tacticalTF: tacticalSnapshot.indicatorTf,
        atrLen: 14,
        vwapLen: 30,
        vwapType: "RTH",
        emaLens: [9, 20],
        regimeTF: anchorLabel
      };
      const indicatorMetaLine = `TF: entry=5m tactical=${tacticalSnapshot.indicatorTf} atr=14 vwap=RTH ema=9/20 regime=${anchorLabel}`;
      const last1mClose = this.recentBars1m.length ? this.recentBars1m[this.recentBars1m.length - 1]!.close : close;
      const emaStack1m = indicators1m.ema9 !== undefined && indicators1m.ema20 !== undefined
        ? (indicators1m.ema9 > indicators1m.ema20 ? "BULL" : "BEAR")
        : "N/A";
      const emaStack5m = indicators5m.ema9 !== undefined && indicators5m.ema20 !== undefined
        ? (indicators5m.ema9 > indicators5m.ema20 ? "BULL" : "BEAR")
        : "N/A";
      const vwapSide1m = indicators1m.vwap !== undefined ? (last1mClose > indicators1m.vwap ? "ABOVE" : "BELOW") : "N/A";
      const vwapSide5m = indicators5m.vwap !== undefined ? (close > indicators5m.vwap ? "ABOVE" : "BELOW") : "N/A";
      const indicatorTfSummary = `INDICATORS: emaStack(1m=${emaStack1m},5m=${emaStack5m}) vwapSide(1m=${vwapSide1m},5m=${vwapSide5m})`;
      console.log(`[5m] ${indicatorTfSummary}`);

      const llmWarnings = [
        ...(filterResult.warnings ?? []),
        ...volumeWarnings,
        dirWarning,
        confirmWarning,
        regimeWarning,
        biasWarning,
        permissionWarning,
        potdWarning,
        indicatorMetaLine,
        indicatorTfSummary,
        ...(lowContext ? [`LOW_CONTEXT: ${lowContextReasons.join(" | ")}`] : [])
      ].filter((warning): warning is string => Boolean(warning));

      const recentBarsForLLM = this.recentBars5m.slice(-20).map((b) => ({
        ts: b.ts,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume
      }));

      const indicatorSnapshot = {
        vwap: indicators5m.vwap,
        ema9: indicators5m.ema9,
        ema20: indicators5m.ema20,
        atr: indicators5m.atr,
        rsi14: indicators5m.rsi14,
        vwap1m: indicators1m.vwap,
        ema9_1m: indicators1m.ema9,
        ema20_1m: indicators1m.ema20,
        vwapSlope: anchorRegime.vwapSlope,
        structure: anchorRegime.structure,
        volume: candidateVolume
      };

      if (this.state.mode === "ACTIVE" && this.lastVolumeRegime !== volumeRegime && this.lastVolumeRegimeTs !== ts) {
        events.push(this.ev("VOLUME_UPDATE", ts, {
          symbol,
          direction: setupCandidate.direction,
          price: close,
          decisionState: "UPDATE",
          modeState: anchorRegime.regime === "CHOP" ? "CHOP" : "TREND_ACTIVE",
          volume: volumePayload,
          update: {
            cause: `volume ${volumeRegime} (${volumeRelText}x)`,
            next: `confirm ${confirmBarsRequired} closes${requiresRetest ? " + retest" : ""}`,
          },
        }));
        this.lastVolumeRegime = volumeRegime;
        this.lastVolumeRegimeTs = ts;
      }

      const ruleScores = {
        tacticalSnapshot,
        regime: anchorRegime.regime,
        macroBias: macroBiasInfo.bias,
        entryPermission,
        potd: {
          bias: this.potdBias,
          confidence: this.potdConfidence,
          mode: this.potdMode,
          alignment: potdAlignment,
          confirmed: potdConfirmed,
        },
        indicatorMeta,
        directionInference: {
          direction: dirInf.direction,
          confidence: dirInf.confidence,
          reasons: dirInf.reasons
        },
        entryFilters: {
          warnings: filterResult.warnings ?? []
        },
        warnings: llmWarnings
      };

      type LLMVerifyType = Awaited<ReturnType<NonNullable<typeof this.llmService>["verifyPlaySetup"]>>;
      let llmVerify: LLMVerifyType | undefined;
      let llmTimedOut = false;
      let llmRulesOnly = false;
      let llmSummary: DecisionLlmSummary | undefined;
      let llmErrorReason: string | undefined;

      const shouldRunLlm =
        !!this.llmService && !watchOnly && setupCandidates.length > 0 && readinessOk;

      if (shouldRunLlm) {
        try {
          console.log(`[5m] Calling LLM for setup validation: ${setupCandidate.id}`);
          this.state.lastLLMCallAt = Date.now();
          if (this.lastDiagnostics?.candidateStats) {
            this.lastDiagnostics.candidateStats.llmInvoked = true;
          }

          const sortedCandidates = setupCandidates
            .slice()
            .sort((a, b) => b.score.total - a.score.total);
          const llmTopN = 8;
          const llmTailN = anchorRegime.regime === "CHOP" ? 20 : 12;
          const llmTop = sortedCandidates.slice(0, llmTopN);
          const llmTail = sortedCandidates.slice(llmTopN, llmTopN + llmTailN);
          const llmCandidates = [...llmTop, ...llmTail];
          const llmVerifyPromise = this.llmService!.verifyPlaySetup({
            symbol: setupCandidate.symbol,
            direction: setupCandidate.direction,
            entryZone: setupCandidate.entryZone,
            stop: setupCandidate.stop,
            targets: setupCandidate.targets,
            score: setupCandidate.score.total,
            grade: setupCandidate.score.total >= 70 ? "A" : setupCandidate.score.total >= 60 ? "B" : setupCandidate.score.total >= 50 ? "C" : "D",
            confidence: setupCandidate.score.total,
            currentPrice: close,
            warnings: llmWarnings,
            indicatorSnapshot,
            recentBars: recentBarsForLLM,
            ruleScores,
            setupCandidate,
            candidates: llmCandidates
          });

          const timeoutPromise = new Promise<Awaited<typeof llmVerifyPromise>>((_, reject) => {
            setTimeout(() => reject(new Error(`LLM timeout after ${this.llmTimeoutMs}ms`)), this.llmTimeoutMs);
          });

          try {
            llmVerify = await Promise.race([llmVerifyPromise, timeoutPromise]);
          } catch (error: any) {
            if (error.message?.includes("timeout")) {
              llmTimedOut = true;
              console.log(`[5m] LLM timeout after ${this.llmTimeoutMs}ms - treating as PASS (safe)`);

              if (this.allowRulesOnlyWhenLLMDown && setupCandidate.score.total >= this.rulesOnlyMinScore) {
                console.log(`[5m] LLM down but setup is A-grade (score=${setupCandidate.score.total} >= ${this.rulesOnlyMinScore}) - allowing rules-only`);
                llmRulesOnly = true;
                llmVerify = {
                  biasDirection: setupCandidate.direction as "LONG" | "SHORT",
                  agreement: 75,
                  legitimacy: 70,
                  probability: 60,
                  action: "SCALP" as const,
                  reasoning: `LLM timeout - rules-only mode: A-grade setup (score=${setupCandidate.score.total})`,
                  plan: "Rules-only trade due to LLM timeout",
                  flags: ["LLM_TIMEOUT", "RULES_ONLY"],
                  followThroughProb: 60,
                };
              } else {
                llmErrorReason = `LLM timeout: ${this.llmTimeoutMs}ms`;
              }
            } else {
              throw error;
            }
          }
        } catch (error: any) {
          this.lastDiagnostics = {
            ts,
            symbol,
            close,
            regime: anchorRegime,
            macroBias: macroBiasInfo.bias,
            directionInference: dirInf,
            candidate: setupCandidate,
            setupReason: `LLM error: ${error.message}`,
            entryFilterWarnings: filterResult.warnings,
            entryPermission: filterResult.permission,
            setupDebug: setupResult.debug,
            regimeEvidence: anchorRegime.bullScore !== undefined && anchorRegime.bearScore !== undefined ? {
              bullScore: anchorRegime.bullScore,
              bearScore: anchorRegime.bearScore,
            } : undefined,
          };
          console.error(`[5m] LLM verification failed:`, error.message);
          llmErrorReason = `LLM error: ${error.message}`;
        }
      } else if (!this.llmService && this.allowRulesOnlyWhenLLMDown && setupCandidate.score.total >= this.rulesOnlyMinScore && !watchOnly) {
        console.log(`[5m] No LLM service but setup is A-grade (score=${setupCandidate.score.total} >= ${this.rulesOnlyMinScore}) - allowing rules-only`);
        llmRulesOnly = true;
        llmVerify = {
          biasDirection: setupCandidate.direction as "LONG" | "SHORT",
          agreement: 75,
          legitimacy: 70,
          probability: 60,
          action: "SCALP" as const,
          reasoning: `No LLM service - rules-only mode: A-grade setup (score=${setupCandidate.score.total})`,
          plan: "Rules-only trade due to LLM service unavailable",
          flags: ["NO_LLM_SERVICE", "RULES_ONLY"],
          followThroughProb: 60,
        };
      } else if (!this.llmService && !watchOnly) {
        llmErrorReason = `no LLM service - setup requires LLM approval${this.allowRulesOnlyWhenLLMDown ? ` (or A-grade score >= ${this.rulesOnlyMinScore})` : ""}`;
        console.log(`[5m] No LLM service - setup found but requires LLM approval`);
      }

      if (llmVerify?.selectedCandidateId) {
        const picked = setupCandidates.find((candidate) => candidate.id === llmVerify!.selectedCandidateId);
        if (picked) {
          setupCandidate = picked;
        } else {
          llmErrorReason = llmErrorReason ?? `LLM selected unknown candidate id: ${llmVerify.selectedCandidateId}`;
        }
      }

      if (llmVerify) {
        llmSummary = {
          biasDirection: llmVerify.biasDirection,
          agreement: llmVerify.agreement,
          legitimacy: llmVerify.legitimacy,
          probability: llmVerify.probability,
          followThroughProb: llmVerify.followThroughProb,
          action: llmVerify.action,
          reasoning: llmVerify.reasoning,
          plan: llmVerify.plan,
          flags: llmVerify.flags ?? [],
          selectedCandidateId: llmVerify.selectedCandidateId,
          rankedCandidateIds: llmVerify.rankedCandidateIds,
          note: llmRulesOnly ? "rules-only" : llmTimedOut ? "timeout" : undefined
        };
        if (llmSummary) {
          const volFlags = new Set(llmSummary.flags ?? []);
          if (isThinTape) volFlags.add("THIN_TAPE");
          if (isLowVol) volFlags.add("LOW_VOL");
          if (isVolSpike) volFlags.add("VOL_SPIKE");
          if (isClimaxVol) volFlags.add("CLIMAX_VOL");
          llmSummary.flags = Array.from(volFlags);

          const cap = isThinTape ? 70 : isLowVol ? 85 : isClimaxVol && !structureAligned ? 90 : undefined;
          if (cap !== undefined) {
            llmSummary.probability = Math.min(llmSummary.probability ?? cap, cap);
            llmSummary.followThroughProb = Math.min(llmSummary.followThroughProb ?? cap, cap);
            llmSummary.note = [llmSummary.note, `volume cap=${cap}`].filter(Boolean).join(" | ");
          } else if (relVol !== undefined && relVol < 0.9) {
            if (llmSummary.probability !== undefined && llmSummary.probability >= 100) llmSummary.probability = 95;
            if (llmSummary.followThroughProb !== undefined && llmSummary.followThroughProb >= 100) {
              llmSummary.followThroughProb = 95;
            }
          }
        }
        this.state.lastLLMDecision = `VERIFY:${llmVerify.action}${llmTimedOut ? " (timeout)" : ""}${llmRulesOnly ? " (rules-only)" : ""}`;

        if (llmVerify.action === "PASS") {
          this.cooldownAfterLLMPass = Date.now();
        }
      }

      const snapshotContract: SnapshotContract = {
        timestamp: ts,
        symbol,
        timeframe: "5m",
        tacticalSnapshot,
        marketState,
        timing: timingSnapshot,
        candidates: setupCandidates,
        llmSelection: llmSummary
          ? {
              selectedCandidateId: llmSummary.selectedCandidateId,
              rankedCandidateIds: llmSummary.rankedCandidateIds,
              action: llmSummary.action,
              agreement: llmSummary.agreement,
              legitimacy: llmSummary.legitimacy,
              probability: llmSummary.probability,
              note: llmSummary.note,
            }
          : undefined,
        lowContext: {
          active: lowContext,
          reasons: lowContextReasons,
        },
      };

      const timingSignal = computeTimingSignal({
        bars: this.recentBars1m.length ? this.recentBars1m : this.recentBars5m,
        direction: setupCandidate.direction,
        entryZone: setupCandidate.entryZone,
        vwap: computeSessionVWAP(this.recentBars1m),
        atr: computeATR(this.recentBars1m, 14)
      });
      const timingBarRef = this.recentBars1m[this.recentBars1m.length - 1] ?? this.recentBars5m[this.recentBars5m.length - 1]!;
      const timingState = this.updateTimingState({
        ts,
        direction: setupCandidate.direction,
        timingSignal,
        bar: timingBarRef,
        inTrade: false
      });
      timingSnapshot = {
        ...timingSignal,
        phase: timingState.phase,
        dir: timingState.dir,
        phaseSinceTs: timingState.phaseSinceTs,
        rawState: timingSignal.state
      };
      this.lastMarketState = marketState;
      this.lastTimingSnapshot = timingSnapshot;
      if (lowContext) {
        const minTimingScore = 75;
        if (timingSignal.score < minTimingScore) {
          blockers.push("guardrail");
          blockerReasons.push(`LOW_CONTEXT: timing score >= ${minTimingScore} required (${Math.round(timingSignal.score)})`);
        }
      }
      if (setupCandidate.stage === "EARLY" && timingSnapshot.phase === "ENTRY_WINDOW" && readinessOk) {
        setupCandidate.stage = "READY";
        setupCandidate.holdReason = undefined;
        setupCandidate.qualityTag = setupCandidate.qualityTag ?? "OK";
      }

      potdAlignment = !potdActive
        ? "OFF"
        : !potdConfirmed
        ? "UNCONFIRMED"
        : setupCandidate.direction === this.potdBias
        ? "ALIGNED"
        : "COUNTERTREND";
      potdCountertrend = potdConfirmed && setupCandidate.direction !== this.potdBias;
      marketState.potd.alignment = potdAlignment;
      marketState.potd.overridden = potdCountertrend;
      ruleScores.potd.alignment = potdAlignment;

      const buildBlockers = (candidate: SetupCandidate) => {
        const hardStopBlockers: DecisionBlocker[] = [];
        const hardWaitBlockers: DecisionBlocker[] = [];
        const softBlockers: DecisionBlocker[] = [];
        const hardStopReasons: string[] = [];
        const hardWaitReasons: string[] = [];
        const softReasons: string[] = [];

        const pushHardStop = (blocker: DecisionBlocker, reason: string) => {
          hardStopBlockers.push(blocker);
          hardStopReasons.push(reason);
        };
        const pushHardWait = (blocker: DecisionBlocker, reason: string) => {
          hardWaitBlockers.push(blocker);
          hardWaitReasons.push(reason);
        };
        const pushSoft = (blocker: DecisionBlocker, reason: string) => {
          softBlockers.push(blocker);
          softReasons.push(reason);
        };

        if (candidate.stage === "EARLY") {
          pushSoft("guardrail", `EARLY idea: ${candidate.holdReason ?? "waiting for timing"}`);
        }
        if (!readinessOk) {
          pushHardWait("guardrail", `DATA_READY: missing ${readinessMissing.join(", ")}`);
        }

        if (!directionGate.allow) {
          pushSoft("guardrail", directionGate.reason);
        } else if (candidate.direction !== directionGate.direction) {
          pushSoft("guardrail", `Direction gate: ${directionGate.tier} ${directionGate.direction} only`);
        }

        if (!Number.isFinite(candidate.stop)) {
          pushHardStop("guardrail", "STOP_INVALID: stop missing");
        } else {
          const stopInvalid =
            candidate.direction === "LONG"
              ? candidate.stop >= candidate.entryZone.low
              : candidate.stop <= candidate.entryZone.high;
          if (stopInvalid) {
            pushHardStop("guardrail", "STOP_INVALID: stop not beyond entry zone");
          }
        }

        if (!atr || atr <= 0) {
          pushHardWait("guardrail", "ATR_INVALID: missing or non-positive ATR");
        } else {
          const entryMid = (candidate.entryZone.low + candidate.entryZone.high) / 2;
          const riskAtr = Math.abs(entryMid - candidate.stop) / atr;
          if (riskAtr > 1.5) {
            pushSoft("guardrail", `RISK_CAP: risk/ATR ${riskAtr.toFixed(2)} > 1.50`);
          }
        }

        const timingReady =
          timingSnapshot?.phase === "ENTRY_WINDOW" ||
          timingSnapshot?.state === "ENTRY_WINDOW_OPEN";
        if (llmSummary?.action && ["GO_ALL_IN", "SCALP"].includes(llmSummary.action) && !timingReady) {
          pushSoft("time_window", `TIMING_THRESHOLD: ${timingSnapshot?.phase ?? timingSnapshot?.state ?? "N/A"}`);
        }

        if (llmErrorReason) {
          pushHardStop("arming_failed", llmErrorReason);
        }

        return {
          hardStopBlockers,
          hardWaitBlockers,
          softBlockers,
          hardStopReasons,
          hardWaitReasons,
          softReasons,
        };
      };

      const baseBlockers = buildBlockers(setupCandidate);
      const freshness = this.buildFreshness(Date.now());
      if (freshness.age1mSec !== undefined && freshness.age1mSec > 90) {
        baseBlockers.hardStopBlockers.push("data_stale");
        baseBlockers.hardStopReasons.push(`DATA_STALE: last1m age ${freshness.age1mSec}s`);
      }
      if (freshness.age5mSec !== undefined && freshness.age5mSec > 6 * 60) {
        baseBlockers.hardStopBlockers.push("data_stale");
        baseBlockers.hardStopReasons.push(`DATA_STALE: last5m age ${freshness.age5mSec}s`);
      }

      const filterContext: EntryFilterContext = {
        timestamp: ts,
        symbol,
        direction: setupCandidate.direction,
        close,
        high,
        low,
        open,
        volume,
        indicators: { tf: "5m", vwap, ema20, ema9, atr, rsi14 },
        recentBars: this.recentBars5m.length >= 5
          ? this.recentBars5m.slice(-20).map((b) => ({
              ts: b.ts,
              open: b.open ?? b.close,
              high: b.high,
              low: b.low,
              close: b.close,
              volume: b.volume ?? 0
            }))
          : undefined,
        setupPattern: setupCandidate.pattern,
        setupFlags: setupCandidate.flags
      };

      filterResult = this.entryFilters.canCreateNewPlay(filterContext);
      if (filterResult.warnings?.length) {
        console.log(`[5m] Entry filter warnings: ${filterResult.warnings.join(" | ")}`);
      }
      if (!filterResult.allowed) {
        const reason = filterResult.reason ?? "entry filter";
        if (reason.toLowerCase().includes("time-of-day cutoff")) {
          baseBlockers.hardStopBlockers.push("time_window");
          baseBlockers.hardStopReasons.push(reason);
        } else if (reason.toLowerCase().includes("extended-from-mean")) {
          baseBlockers.softBlockers.push("entry_filter");
          baseBlockers.softReasons.push(reason);
        } else if (reason.toLowerCase().includes("no reclaim signal")) {
          baseBlockers.softBlockers.push("entry_filter");
          baseBlockers.softReasons.push(reason);
        } else {
          baseBlockers.softBlockers.push("entry_filter");
          baseBlockers.softReasons.push(reason);
        }
        console.log(`[5m] Entry blocked by filter: ${filterResult.reason}`);
      }
      ruleScores.entryPermission = filterResult.permission ?? "ALLOWED";
      ruleScores.entryFilters = { warnings: filterResult.warnings ?? [] };

      if (filterResult.permission === "WAIT_FOR_PULLBACK") {
        setupCandidate.stage = "EARLY";
        setupCandidate.holdReason = filterResult.reason ?? "WAIT_FOR_PULLBACK";
        setupCandidate.warningFlags = setupCandidate.warningFlags ?? setupCandidate.flags;
        this.state.pendingCandidate = { ...setupCandidate };
        this.state.pendingCandidateExpiresAt = ts + 30 * 60 * 1000;
      } else if (this.state.pendingCandidate?.id === setupCandidate.id) {
        this.state.pendingCandidate = null;
        this.state.pendingCandidateExpiresAt = undefined;
      }

      if (guardrailBlockReason) {
        baseBlockers.hardStopBlockers.push(guardrailBlockTag ?? "guardrail");
        baseBlockers.hardStopReasons.push(guardrailBlockReason);
      }
      if (watchOnly) {
        baseBlockers.hardStopBlockers.push("arming_failed");
        baseBlockers.hardStopReasons.push("mode QUIET");
      }
      if (this.lastDiagnostics) {
        this.lastDiagnostics = {
          ...this.lastDiagnostics,
          candidate: setupCandidate,
          entryFilterWarnings: filterResult.warnings,
          entryPermission: filterResult.permission,
          potd: {
            bias: this.potdBias,
            confidence: this.potdConfidence,
            mode: this.potdMode,
            alignment: potdAlignment,
          }
        };
      }

      if (potdCountertrend && llmSummary) {
        if (llmSummary.action === "GO_ALL_IN") {
          llmSummary.action = "SCALP";
          llmSummary.note = [llmSummary.note, "POTD countertrend: scalp-only"].filter(Boolean).join(" | ");
        }
        const flags = new Set([...(llmSummary.flags ?? [])]);
        flags.add("POTD_COUNTERTREND");
        llmSummary.flags = Array.from(flags);
      }
      if (lowContext && llmSummary?.action === "GO_ALL_IN") {
        llmSummary.action = "SCALP";
        llmSummary.note = [llmSummary.note, "low_context: scalp-only"].filter(Boolean).join(" | ");
        const flags = new Set([...(llmSummary.flags ?? [])]);
        flags.add("LOW_CONTEXT");
        llmSummary.flags = Array.from(flags);
      }

      const highProbGate = (this.enforceHighProbabilitySetups || this.autoAllInOnHighProb)
        ? this.evaluateHighProbabilityGate({
            candidate: setupCandidate,
            directionInference: dirInf,
            llm: llmSummary
          })
        : null;

      if (this.enforceHighProbabilitySetups && highProbGate && !highProbGate.allowed && llmSummary) {
        const flags = new Set([...(llmSummary.flags ?? [])]);
        flags.add("LOW_PROBABILITY");
        llmSummary.flags = Array.from(flags);
        llmSummary.note = [llmSummary.note, highProbGate.reason ?? "low probability"].filter(Boolean).join(" | ");
        console.log(`[5m] High-probability gate warning: ${highProbGate.reason}`);
      }

      if (this.autoAllInOnHighProb && highProbGate?.allowed && llmSummary?.action === "SCALP") {
        llmSummary.action = "GO_ALL_IN";
        const flags = new Set([...(llmSummary.flags ?? [])]);
        flags.add("AUTO_ALL_IN");
        llmSummary.flags = Array.from(flags);
        llmSummary.note = [llmSummary.note, "auto-all-in"].filter(Boolean).join(" | ");
      }

      if (directionGate.allow && directionGate.tier === "LEANING" && llmSummary?.action === "GO_ALL_IN") {
        llmSummary.action = "SCALP";
        llmSummary.note = [llmSummary.note, "leaning: scout-only"].filter(Boolean).join(" | ");
      }

      const distanceToVwap = vwap !== undefined && atr ? Math.abs(close - vwap) : undefined;
      const atrSlopeRising = anchorRegime.atrSlope !== undefined && anchorRegime.atrSlope > 0;
      const patternAllowsAllIn = ["FOLLOW", "RECLAIM"].includes(setupCandidate.pattern);
      const chaseRisk = setupCandidate.flags?.includes("CHASE_RISK") ?? false;
      const goAllInAllowed = distanceToVwap !== undefined && atr
        ? distanceToVwap <= 0.8 * atr && !atrSlopeRising && patternAllowsAllIn && !chaseRisk && !potdCountertrend
        : false;
      if (llmSummary?.action === "GO_ALL_IN" && !goAllInAllowed) {
        llmSummary.action = "SCALP";
        const flags = new Set([...(llmSummary.flags ?? [])]);
        flags.add("GO_ALL_IN_BLOCKED");
        llmSummary.flags = Array.from(flags);
        llmSummary.note = [llmSummary.note, "go-all-in blocked by vwap/ATR slope/pattern/chase risk"].filter(Boolean).join(" | ");
      }

      const softContextReasons: string[] = [];
      if (shockMode) {
        softContextReasons.push(`SHOCK: ${tacticalBiasInfo.shockReason ?? "range expansion"}`);
      }
      if (transitionLockActive) {
        softContextReasons.push("TRANSITION_LOCK: active");
      }
      if (tacticalSnapshot.confirm && tacticalSnapshot.confirm.bias !== "NONE") {
        if (tacticalSnapshot.confirm.bias !== tacticalSnapshot.activeDirection) {
          softContextReasons.push(
            `TIMEFRAME_CONFLICT: 1m=${tacticalSnapshot.activeDirection} 5m=${tacticalSnapshot.confirm.bias}`
          );
        }
      }
      if (lowContext && lowContextReasons.length) {
        softContextReasons.push(`LOW_CANDIDATE_DENSITY: ${lowContextReasons.join(" | ")}`);
      }
      for (const reason of softContextReasons) {
        baseBlockers.softBlockers.push("guardrail");
        baseBlockers.softReasons.push(reason);
      }
      const volumeGateReasons: string[] = [];
      const volumeConfirmOk = (() => {
        const bars1m = this.recentBars1m;
        const entryZone = setupCandidate.entryZone;
        if (!entryZone || !bars1m.length) return false;
        if (relVol === undefined) {
          volumeGateReasons.push("VOLUME_UNKNOWN: relVol missing");
          return false;
        }
        if (bars1m.length < confirmBarsRequired) {
          volumeGateReasons.push(`NEED_${confirmBarsRequired}_CLOSES: bars=${bars1m.length}`);
          return false;
        }
        const threshold = setupCandidate.direction === "LONG" ? entryZone.high : entryZone.low;
        let closesMet = 0;
        for (let i = bars1m.length - 1; i >= 0; i -= 1) {
          const closeNow = bars1m[i]!.close;
          const ok = setupCandidate.direction === "LONG" ? closeNow > threshold : closeNow < threshold;
          if (!ok) break;
          closesMet += 1;
        }
        volumePayload.closesMet = closesMet;
        if (closesMet < confirmBarsRequired) {
          volumeGateReasons.push(`NEED_${confirmBarsRequired}_CLOSES: ${closesMet}/${confirmBarsRequired}`);
          return false;
        }
        if (!requiresRetest) {
          return true;
        }
        let lastRetestIdx = -1;
        for (let i = 0; i < bars1m.length; i += 1) {
          const closeNow = bars1m[i]!.close;
          if (closeNow >= entryZone.low && closeNow <= entryZone.high) {
            lastRetestIdx = i;
          }
        }
        const retestOk = lastRetestIdx !== -1 && lastRetestIdx < bars1m.length - confirmBarsRequired;
        volumePayload.retestOk = retestOk;
        if (!retestOk) {
          volumeGateReasons.push("NEED_RETEST");
          return false;
        }
        return true;
      })();
      if (relVol !== undefined && volumeRegime === "THIN_TAPE") {
        volumeGateReasons.push(`LOW_VOLUME: relVol=${relVol.toFixed(2)} < 0.70`);
      }
      if (!volumeConfirmOk && volumeGateReasons.length) {
        baseBlockers.softBlockers.push("guardrail");
        baseBlockers.softReasons.push(...volumeGateReasons);
      }
      const chopSignals = new Set<string>();
      if (anchorRegime.regime === "CHOP") chopSignals.add("CHOP");
      if (shockMode) chopSignals.add("SHOCK");
      if (transitionLockActive) chopSignals.add("TRANSITION");
      if (tacticalSnapshot.confirm && tacticalSnapshot.confirm.bias !== "NONE") {
        if (tacticalSnapshot.confirm.bias !== tacticalSnapshot.activeDirection) {
          chopSignals.add("TF_CONFLICT");
        }
      }
      if (lowContext && lowContextReasons.length) {
        chopSignals.add("LOW_DENSITY");
      }

      const hardStopBlockers = baseBlockers.hardStopBlockers;
      const hardWaitBlockers = baseBlockers.hardWaitBlockers;
      const softBlockers = baseBlockers.softBlockers;
      const hardStopReasons = baseBlockers.hardStopReasons;
      const hardWaitReasons = baseBlockers.hardWaitReasons;
      const softBlockerReasons = baseBlockers.softReasons;
      const hardBlockers = [...hardStopBlockers, ...hardWaitBlockers];
      const hardBlockerReasons = [...hardStopReasons, ...hardWaitReasons];
      blockers = [...hardBlockers, ...softBlockers];
      blockerReasons = [...hardBlockerReasons, ...softBlockerReasons];

      const rulesSnapshot: DecisionRulesSnapshot = {
        regime: {
          regime: anchorRegime.regime,
          structure: anchorRegime.structure,
          vwapSlope: anchorRegime.vwapSlope,
          reasons: anchorRegime.reasons
        },
        macroBias: {
          bias: macroBiasInfo.bias,
          reasons: macroBiasInfo.reasons
        },
        tacticalSnapshot,
        potd: {
          bias: this.potdBias,
          confidence: this.potdConfidence,
          mode: this.potdMode,
          alignment: potdAlignment,
          confirmed: potdConfirmed,
        },
        entryPermission,
        indicatorMeta,
        directionInference: {
          direction: dirInf.direction,
          confidence: dirInf.confidence,
          reasons: dirInf.reasons
        },
        indicators: indicatorSnapshot,
        ruleScores
      };

      const hasHardBlockers = hardStopBlockers.length || hardWaitBlockers.length;
      const hasTimeCutoff = hardStopBlockers.includes("time_window");
      let decisionState = hasTimeCutoff
        ? "UPDATE"
        : hasHardBlockers || softBlockers.length
        ? "WATCH"
        : "SIGNAL";
      if (decisionState === "SIGNAL" && !volumeConfirmOk) {
        baseBlockers.softBlockers.push("guardrail");
        baseBlockers.softReasons.push(`VOLUME_CONFIRM: ${volumeLine}`);
        decisionState = "WATCH";
      }
      const rangeCondition =
        decisionState === "WATCH" &&
        readinessOk &&
        hardStopBlockers.length === 0 &&
        hardStopReasons.length === 0 &&
        hardWaitBlockers.length === 0 &&
        hardWaitReasons.length === 0 &&
        chopSignals.size >= 2;
      const wasRangeModeActive = this.rangeModeActive;
      const rangeModeActive = this.updateRangeMode(rangeCondition, decisionState === "SIGNAL");
      if (!rangeModeActive) {
        this.lastRangeWatchKey = null;
        this.lastRangeWatchTs = null;
        this.lastRangeWatchMetrics = null;
        this.rangeFrozen = null;
      }

      const decision = buildDecision({
        ts,
        symbol,
        candidate: setupCandidate,
        rules: rulesSnapshot,
        llm: llmSummary,
        blockers,
        blockerReasons,
        expiryMs: 30 * 60 * 1000
      });
      this.lastDecision = decision;

      const qualityLabel = (score: number): { grade: string; tag: string } => {
        if (score >= 90) return { grade: "A+", tag: "High conviction" };
        if (score >= 82) return { grade: "A", tag: "Tradeable" };
        if (score >= 75) return { grade: "B", tag: "OK / needs help" };
        if (score >= 70) return { grade: "C", tag: "Low quality (watchlist)" };
        return { grade: "D", tag: "Ignore" };
      };
      const quality = qualityLabel(setupCandidate.score.total);
      const topPlay = {
        setup: setupCandidate.pattern,
        direction: setupCandidate.direction,
        score: setupCandidate.score.total,
        quality: quality.grade,
        qualityTag: quality.tag,
        armStatus: decision.status === "ARMED" ? "ARMED" : "NOT ARMED",
        entryZone: setupCandidate.entryZone,
        stop: setupCandidate.stop,
        probability: decision.llm?.probability ?? llmSummary?.probability,
        action: decision.llm?.action ?? llmSummary?.action
      };

      const riskAtr = atr
        ? Math.abs(((setupCandidate.entryZone.low + setupCandidate.entryZone.high) / 2) - setupCandidate.stop) / atr
        : undefined;
      const gateStatus = computeGateStatus({
        entryPermission,
        blockerReasons,
        hardStopReasons,
        hardWaitReasons,
        softBlockerReasons,
        indicators: { atr: indicatorSnapshot.atr, vwap: indicatorSnapshot.vwap },
        price: close,
        relVol,
        rearmVwapAtr: this.entryFilters.getRearmVwapDistanceAtr(),
      });
      const decisionSummary = {
        decisionId: decision.decisionId,
        status: decision.status,
        kind: "GATE" as const,
        allowed: decision.status === "ARMED",
        permission,
        direction: tacticalSnapshot.activeDirection === "NEUTRAL" ? "NONE" : tacticalSnapshot.activeDirection,
        gateTier: directionGate.allow ? (directionGate.tier === "LEANING" ? "LEANING" : "OPEN") : "STRICT",
        blockers: decision.blockers,
        blockerReasons: decision.blockerReasons,
        hardBlockers,
        softBlockers,
        hardBlockerReasons,
        softBlockerReasons,
        hardStopBlockers,
        hardWaitBlockers,
        hardStopReasons,
        hardWaitReasons,
        decisionState,
        rationale: [
          directionGate.reason,
          ...(lowContext ? [`LOW_CONTEXT: ${lowContextReasons.join(" | ")}`] : [])
        ].filter(Boolean),
        metrics: {
          score: setupCandidate.score.total,
          legitimacy: decision.llm?.legitimacy,
          followThrough: decision.llm?.followThroughProb,
          riskAtr
        }
      };
      if (decisionState === "WATCH") {
        this.state.pendingPlay = this.buildPendingPlay(setupCandidate, llmSummary, ts);
      } else if (decision.status === "ARMED" || decisionState === "SIGNAL") {
        this.state.pendingPlay = null;
      }
      const rankedCandidates = setupCandidates
        .slice()
        .sort((a, b) => b.score.total - a.score.total)
        .slice(0, 5)
        .map((candidate) => {
          const candidateQuality = qualityLabel(candidate.score.total);
          return {
            id: candidate.id,
            setup: candidate.pattern,
            intentBucket: candidate.intentBucket ?? candidate.pattern,
            direction: candidate.direction,
            score: candidate.score.total,
            quality: candidateQuality.grade,
            qualityTag: candidate.qualityTag ?? candidateQuality.tag,
            stage: candidate.stage,
            holdReason: candidate.holdReason,
            entryZone: candidate.entryZone,
            stop: candidate.stop,
            extendedFromMeanAtr: candidate.featureBundle?.location?.extendedFromMean?.atR,
            flags: candidate.flags ?? [],
            warningFlags: candidate.warningFlags ?? candidate.flags ?? [],
          };
        });
      const formatZone = (zone?: { low: number; high: number }): string =>
        zone ? `${zone.low.toFixed(2)}-${zone.high.toFixed(2)}` : "n/a";
      const rangeWarnKey = (() => {
        const tags = Array.from(chopSignals).sort();
        const capped = tags.slice(0, 2);
        const extra = tags.length - capped.length;
        const suffix = extra > 0 ? ` (+${extra})` : "";
        return `${capped.join(",")}${suffix}`;
      })();
      const rangeWatchPayload = rangeModeActive
        ? (() => {
            const rangeCandidates = setupCandidates;
            const plan = buildChopPlan({
              ts,
              close,
              indicatorSnapshot,
              atr1m: indicators1m.atr,
              atr5m: indicators5m.atr,
              rangeCandidates,
              recentBars1m: this.recentBars1m,
              recentBars5m: this.recentBars5m,
            });
            const computedRange = {
              range: plan.range,
              vwap: indicatorSnapshot.vwap,
              price: close,
              contextRange: plan.contextRange,
              microBox: plan.microBox,
              bias: plan.bias,
              activeSide: plan.activeSide,
              location: plan.location,
              longArm: plan.longArm,
              longEntry: plan.longEntry,
              shortArm: plan.shortArm,
              shortEntry: plan.shortEntry,
              stopAnchor: plan.stopAnchor,
              mode: plan.mode,
              note: plan.note,
              buffer: plan.buffer,
              atr1m: plan.atr1m,
              minWidth: plan.minWidth,
              rangeWidth: plan.rangeWidth,
              ts,
            };
            if (rangeModeActive && !wasRangeModeActive && plan.mode !== "TIGHT") {
              this.rangeFrozen = computedRange;
            }
            const isChop = plan.mode === "TIGHT" || anchorRegime.regime === "CHOP";
            return isChop ? computedRange : this.rangeFrozen ?? computedRange;
          })()
        : null;
      const modeState: ModeState = (() => {
        if (rangeModeActive) {
          if (decision.status === "ARMED") return "RANGE_ARMED";
          if (rangeWatchPayload?.mode === "TIGHT" || anchorRegime.regime === "CHOP") return "CHOP";
          return "RANGE";
        }
        if (wasRangeModeActive) return "RANGE_EXIT_WATCH";
        if (anchorRegime.regime === "CHOP") return "CHOP";
        return "TREND_ACTIVE";
      })();
      if (decisionState === "WATCH") {
        console.log("[WATCH_VETO]", {
          symbol,
          ts,
          price: close,
          vwap: indicatorSnapshot.vwap,
          atr: indicatorSnapshot.atr,
          relVol,
          modeState,
          reasons: gateStatus.blockedReasons?.slice(0, 3) ?? [],
        });
      }
      const isDev = process.env.NODE_ENV !== "production";
      if (isDev && rangeModeActive && decisionState === "WATCH" && !rangeWatchPayload) {
        console.warn("[ONE_ENGINE_VIOLATION] range mode active without range payload", {
          symbol,
          ts,
          decisionState,
          hardStopBlockers,
          hardWaitBlockers,
          softBlockers,
          softBlockerReasons,
        });
      }
      if (isDev && entryPermission === "BLOCKED" && hardStopBlockers.length === 0 && hardWaitBlockers.length === 0) {
        console.warn("[ONE_ENGINE_VIOLATION] soft blockers set entryPermission=BLOCKED", {
          symbol,
          ts,
          decisionState,
          entryPermission,
          softBlockerReasons,
          directionGate: directionGate.reason,
        });
      }
      if (isDev && decisionState === "WATCH" && hardStopBlockers.length === 0 && hardWaitBlockers.length === 0) {
        const softContextTokens = ["TIMEFRAME_CONFLICT", "LOW_CANDIDATE_DENSITY", "TRANSITION_LOCK", "SHOCK"];
        const softVetoReasons = softBlockerReasons.filter((reason) =>
          softContextTokens.some((token) => reason.includes(token))
        );
        if (softVetoReasons.length > 0 && entryPermission === "ALLOWED") {
          console.warn("[ONE_ENGINE_VIOLATION] contextual veto outside hard stops", {
            symbol,
            ts,
            decisionState,
            entryPermission,
            softVetoReasons,
            directionGate: directionGate.reason,
          });
        }
      }
      const rangeWatchKey = rangeWatchPayload
        ? [
            rangeWatchPayload.range.low.toFixed(2),
            rangeWatchPayload.range.high.toFixed(2),
            Number.isFinite(rangeWatchPayload.vwap) ? rangeWatchPayload.vwap!.toFixed(2) : "na",
            rangeWatchPayload.contextRange
              ? `${rangeWatchPayload.contextRange.low.toFixed(2)}-${rangeWatchPayload.contextRange.high.toFixed(2)}`
              : "no-context",
            rangeWatchPayload.microBox
              ? `${rangeWatchPayload.microBox.low.toFixed(2)}-${rangeWatchPayload.microBox.high.toFixed(2)}`
              : "no-micro",
            rangeWatchPayload.longEntry,
            rangeWatchPayload.shortEntry,
            rangeWatchPayload.mode ?? "",
            rangeWarnKey
          ].join("|")
        : null;
      events.push(this.ev("SETUP_CANDIDATES", ts, {
        symbol,
        price: close,
        topPlay,
        candidates: rankedCandidates,
        candidatesTitle: "IDEAS / CANDIDATES",
        marketState,
        timing: timingSnapshot,
        decision: decisionSummary,
      }));
      if (llmSummary?.selectedCandidateId || llmSummary?.rankedCandidateIds?.length) {
        events.push(this.ev("LLM_PICK", ts, {
          symbol,
          price: close,
          selectedCandidateId: llmSummary?.selectedCandidateId,
          rankedCandidateIds: llmSummary?.rankedCandidateIds,
          candidates: rankedCandidates,
          candidatesTitle: "IDEAS / CANDIDATES",
          marketState,
          timing: timingSnapshot,
          decision: decisionSummary,
        }));
      }

      if (decision.llm) {
        events.push(this.ev("LLM_VERIFY", ts, {
          playId: setupCandidate.id,
          symbol: setupCandidate.symbol,
          direction: setupCandidate.direction,
          price: close,
          legitimacy: decision.llm.legitimacy,
          followThroughProb: decision.llm.followThroughProb,
          action: decision.llm.action,
          reasoning: decision.llm.reasoning,
          decision: decisionSummary,
          blockerTags: blockers,
          blockerReasons,
          hardBlockers,
          softBlockers,
          hardBlockerReasons,
          softBlockerReasons,
          marketState,
          timing: timingSnapshot,
          playState: "CANDIDATE",
          notArmedReason: blockerReasons.length ? blockerReasons.join(" | ") : undefined
        }));
      }

      const scorecardSnapshot: ScorecardSnapshot = {
        topPlayKey: `${topPlay.setup ?? "N/A"}|${topPlay.direction ?? "N/A"}|${Math.round(topPlay.score ?? 0)}`,
        entryPermission: ruleScores.entryPermission,
        timingPhase: timingSnapshot?.phase ?? timingSnapshot?.state,
        directionBand: getDirectionConfidenceBand(dirInf.confidence),
        direction: tacticalSnapshot.activeDirection === "NEUTRAL" ? "NONE" : tacticalSnapshot.activeDirection,
        llmAction: decision.llm?.action,
        decisionStatus: decision.status
      };
      if (this.shouldPublishScorecard(scorecardSnapshot)) {
        events.push(this.ev("SCORECARD", ts, {
          playId: setupCandidate.id,
          symbol: setupCandidate.symbol,
          proposedDirection: setupCandidate.direction,
          price: close,
          setup: {
            pattern: setupCandidate.pattern,
            triggerPrice: setupCandidate.triggerPrice,
            stop: setupCandidate.stop
          },
          rules: rulesSnapshot,
          llm: decision.llm,
          decision: decisionSummary,
          marketState,
          timing: timingSnapshot,
          topPlay,
          blockerTags: blockers,
          blockerReasons,
          hardBlockers,
          softBlockers,
          hardBlockerReasons,
          softBlockerReasons,
          playState: "CANDIDATE",
          notArmedReason: blockerReasons.length ? blockerReasons.join(" | ") : undefined
        }));
      }

      if (rangeModeActive && rangeWatchPayload) {
        const atr = indicatorSnapshot.atr;
        const rangeThreshold = Number.isFinite(atr) ? (atr as number) * 0.15 : 0.15;
        const vwapThreshold = Number.isFinite(atr) ? (atr as number) * 0.1 : 0.1;
        const prior = this.lastRangeWatchMetrics;
        const rangeMoved =
          !prior ||
          Math.abs(rangeWatchPayload.range.low - prior.low) >= rangeThreshold ||
          Math.abs(rangeWatchPayload.range.high - prior.high) >= rangeThreshold;
        const contextMoved = (() => {
          if (!prior) return true;
          const current = rangeWatchPayload.contextRange;
          if (!current && prior.contextLow === undefined && prior.contextHigh === undefined) return false;
          if (!current || prior.contextLow === undefined || prior.contextHigh === undefined) return true;
          return (
            Math.abs(current.low - prior.contextLow) >= rangeThreshold ||
            Math.abs(current.high - prior.contextHigh) >= rangeThreshold
          );
        })();
        const microMoved = (() => {
          if (!prior) return true;
          const current = rangeWatchPayload.microBox;
          if (!current && prior.microLow === undefined && prior.microHigh === undefined) return false;
          if (!current || prior.microLow === undefined || prior.microHigh === undefined) return true;
          return (
            Math.abs(current.low - prior.microLow) >= rangeThreshold ||
            Math.abs(current.high - prior.microHigh) >= rangeThreshold
          );
        })();
        const vwapMoved = (() => {
          const currentVwap = rangeWatchPayload.vwap;
          if (!prior) return true;
          if (currentVwap === undefined && prior.vwap === undefined) return false;
          if (currentVwap === undefined || prior.vwap === undefined) return true;
          return Math.abs(currentVwap - prior.vwap) >= vwapThreshold;
        })();
        const triggersChanged =
          !prior ||
          prior.longEntry !== rangeWatchPayload.longEntry ||
          prior.shortEntry !== rangeWatchPayload.shortEntry ||
          prior.warnKey !== rangeWarnKey ||
          prior.mode !== rangeWatchPayload.mode;
        const shouldEmitRange =
          (rangeMoved || contextMoved || microMoved || vwapMoved || triggersChanged) &&
          this.lastRangeWatchTs !== ts;
        if (shouldEmitRange) {
          const barTs = this.state.last1mTs ?? ts;
          const barTf = this.state.last1mTs ? "1m" : "5m";
          events.push(this.ev("NO_ENTRY", ts, {
            playId: decision.decisionId,
            symbol: setupCandidate.symbol,
            direction: setupCandidate.direction,
            price: close,
            decisionState: "WATCH",
            modeState,
            gateStatus,
            barTs,
            barTf,
            candidate: setupCandidate,
            decision: decisionSummary,
            volume: volumePayload,
            marketState,
            timing: timingSnapshot,
            topPlay,
            blockerTags: blockers,
            blockerReasons,
            hardBlockers,
            softBlockers,
            hardBlockerReasons,
            softBlockerReasons,
            playState: "CANDIDATE",
            notArmedReason: blockerReasons.length ? blockerReasons.join(" | ") : undefined,
            range: {
              ...rangeWatchPayload.range,
              vwap: rangeWatchPayload.vwap,
              price: rangeWatchPayload.price,
              contextRange: rangeWatchPayload.contextRange,
              microBox: rangeWatchPayload.microBox,
              bias: rangeWatchPayload.bias,
              activeSide: rangeWatchPayload.activeSide,
              location: rangeWatchPayload.location,
              buffer: rangeWatchPayload.buffer,
              atr1m: rangeWatchPayload.atr1m,
              longArm: rangeWatchPayload.longArm,
              longEntry: rangeWatchPayload.longEntry,
              shortArm: rangeWatchPayload.shortArm,
              shortEntry: rangeWatchPayload.shortEntry,
              stopAnchor: rangeWatchPayload.stopAnchor,
              mode: rangeWatchPayload.mode,
              note: rangeWatchPayload.note,
              ts,
            },
            rangeWarnTags: Array.from(chopSignals)
          }));
          this.lastRangeWatchKey = rangeWatchKey;
          this.lastRangeWatchTs = ts;
          this.lastRangeWatchMetrics = {
            low: rangeWatchPayload.range.low,
            high: rangeWatchPayload.range.high,
            vwap: rangeWatchPayload.vwap,
            contextLow: rangeWatchPayload.contextRange?.low,
            contextHigh: rangeWatchPayload.contextRange?.high,
            microLow: rangeWatchPayload.microBox?.low,
            microHigh: rangeWatchPayload.microBox?.high,
            warnKey: rangeWarnKey,
            longEntry: rangeWatchPayload.longEntry,
            shortEntry: rangeWatchPayload.shortEntry,
            mode: rangeWatchPayload.mode,
          };
        }
      } else if (decisionState === "WATCH" || decision.status !== "ARMED") {
        events.push(this.ev("NO_ENTRY", ts, {
          playId: decision.decisionId,
          symbol: setupCandidate.symbol,
          direction: setupCandidate.direction,
          price: close,
          candidate: setupCandidate,
          decisionState,
          modeState,
          gateStatus,
          decision: decisionSummary,
          volume: volumePayload,
          marketState,
          timing: timingSnapshot,
          topPlay,
          blockerTags: blockers,
          blockerReasons,
          hardBlockers,
          softBlockers,
          hardBlockerReasons,
          softBlockerReasons,
          playState: "CANDIDATE",
          notArmedReason: blockerReasons.length ? blockerReasons.join(" | ") : undefined
        }));
      }

      if (decision.status === "ARMED" && decision.play) {
        this.state.pendingCandidate = null;
        this.state.pendingCandidateExpiresAt = undefined;
        this.state.pendingPlay = null;
        if (directionGate.allow) {
          decision.play.tier = directionGate.tier;
          if (directionGate.tier === "LEANING") {
            decision.play.mode = "SCOUT";
          }
        }
        decision.play.armedSnapshot = snapshotContract;
        this.state.activePlay = decision.play;
        this.playsToday += 1;
        events.push(this.ev("PLAY_ARMED", ts, {
          play: decision.play,
          decision: decisionSummary,
          price: close,
          decisionState: "SIGNAL",
          modeState,
          gateStatus,
          volume: volumePayload,
          marketState,
          timing: timingSnapshot,
          topPlay,
          blockerTags: blockers,
          blockerReasons,
          hardBlockers,
          softBlockers,
          hardBlockerReasons,
          softBlockerReasons,
          playState: "ARMED",
          armReason: "regime + score + LLM approved"
        }));
        events.push(this.ev("TRADE_PLAN", ts, {
          playId: decision.play.id,
          symbol: decision.play.symbol,
          direction: decision.play.direction,
          price: close,
          action: decision.llm?.action,
          size: decision.play.mode,
          probability: decision.llm?.probability,
          plan: decision.llm?.plan,
          decision: decisionSummary,
          marketState,
          timing: timingSnapshot,
          topPlay,
          blockerTags: blockers,
          blockerReasons,
          hardBlockers,
          softBlockers,
          hardBlockerReasons,
          softBlockerReasons,
          playState: "ARMED",
          armReason: "regime + score + LLM approved"
        }));
      }

      // Emit SETUP_SUMMARY on 5m close when there's no play (and candidate is strong)
      if (this.state.mode === "ACTIVE" && this.lastDecision?.candidate && this.lastSetupSummary5mTs !== ts) {
        const c = this.lastDecision.candidate;
        if ((c.score?.total ?? 0) >= 65) {
          events.push(this.ev("SETUP_SUMMARY", ts, {
            symbol: c.symbol,
            candidate: c,
            price: close,
            notes: this.lastDecision.rules
              ? `regime=${this.lastDecision.rules.regime.regime} bias=${this.lastDecision.rules.macroBias?.bias ?? "N/A"}`
              : undefined,
            decision: decisionSummary,
            marketState,
            timing: timingSnapshot,
            topPlay,
            blockerTags: blockers,
            blockerReasons,
            hardBlockers,
            softBlockers,
            hardBlockerReasons,
            softBlockerReasons,
            playState: decision.status === "ARMED" ? "ARMED" : "CANDIDATE"
          }));
          this.lastSetupSummary5mTs = ts;
        }
      }

      return events;
    }

    const play = this.state.activePlay;

    // Coaching only after ENTERED
    if (play.status !== "ENTERED") {
      return events;
    }

    // Path: LLM_COACH_UPDATE - Position management
    return await this.handleManageCoaching(snapshot, play, events);
  }

  /**
   * Handle ARMED coaching (play exists but not entered)
   * Provides pre-entry commentary without pretending we're in a position
   */
  private async handleArmedCoaching(snapshot: TickSnapshot, play: Play, events: DomainEvent[]): Promise<DomainEvent[]> {
    assertNotMinimalModeLegacy("handleArmedCoaching");
    const { ts, symbol, close } = snapshot;

    // Check cache: armedCoachCacheKey = playId + "_armed_" + snapshot.ts
    const cacheKey = `${play.id}_armed_${ts}`;
    
    // Call LLM once per 5m bar (cache by barTs)
    if (this.llmArmedCoachCache.has(cacheKey)) {
      return events; // Already processed this 5m bar
    }

    if (this.llmService && !play.stopHit) {
      const coachingStartTime = Date.now();
      try {
        this.state.lastLLMCallAt = Date.now();
        
        // Calculate time since armed
        const armedTimestamp = play.armedTimestamp || ts;
        const timeSinceArmed = Math.floor((ts - armedTimestamp) / 60000);

        const armedResponse = await this.llmService.getArmedCoaching({
          symbol: play.symbol,
          direction: play.direction,
          entryZone: play.entryZone,
          currentPrice: close,
          stop: play.stop,
          targets: play.targets,
          score: play.score,
          grade: play.grade,
          confidence: play.confidence,
          legitimacy: play.legitimacy,
          followThroughProb: play.followThroughProb,
          action: play.action,
          timeSinceArmed
        });

        this.state.lastLLMDecision = `ARMED_COACH:${armedResponse.entryReadiness}`;

        // Cache this call
        this.llmArmedCoachCache.set(cacheKey, Date.now());
        
        // Clean old cache entries (keep last 10)
        if (this.llmArmedCoachCache.size > 10) {
          const firstKey = this.llmArmedCoachCache.keys().next().value;
          if (firstKey) this.llmArmedCoachCache.delete(firstKey);
        }

        const coachingLatency = Date.now() - coachingStartTime;
        console.log(`[5m] ARMED coaching run playId=${play.id} latencyMs=${coachingLatency}`);

        // Emit ARMED_COACH event
        events.push(this.ev("ARMED_COACH", ts, {
          playId: play.id,
          symbol: play.symbol,
          direction: play.direction,
          price: close,
          commentary: armedResponse.commentary,
          entryReadiness: armedResponse.entryReadiness,
          reasoning: armedResponse.reasoning,
          urgency: armedResponse.urgency,
          decision: {
            decisionId: `${play.symbol}_${ts}_${play.id}`,
            status: play.status,
            kind: "EXECUTION",
            permission: {
              long: play.direction === "LONG",
              short: play.direction === "SHORT",
              mode: play.tier === "LEANING" ? "SCALP_ONLY" : "NORMAL"
            },
            direction: play.direction,
            rationale: ["armed coaching update"]
          },
          playState: play.status
        }));
        
      } catch (error: any) {
        const coachingLatency = Date.now() - coachingStartTime;
        console.error(`[5m] ARMED coaching error playId=${play.id} latencyMs=${coachingLatency} error=${error.message}`);
      }
    } else {
      if (!this.llmService) {
        console.log(`[5m] ARMED coaching skipped (LLM service not available)`);
      } else if (play.stopHit) {
        console.log(`[5m] ARMED coaching skipped (stop hit)`);
      }
    }

    return events;
  }

  /**
   * Handle MANAGE coaching (play is entered - position management)
   * This is the existing LLM_COACH_UPDATE logic
   */
  private async handleManageCoaching(snapshot: TickSnapshot, play: Play, events: DomainEvent[]): Promise<DomainEvent[]> {
    assertNotMinimalModeLegacy("handleManageCoaching");
    const { ts, symbol, close } = snapshot;

    // Build telemetry packet (rules math)
    const entryPrice = play.entryPrice ?? (play.entryZone.low + (play.entryZone.high - play.entryZone.low) / 2);
    const rulesContext = this.stopProfitRules.getContext(play, close, entryPrice);

    const bars5m = this.recentBars5m;
    const closes5m = bars5m.map((b) => b.close);
    const ema9_5m = computeEMA(closes5m.slice(-60), 9);
    const rsiNow = computeRSI(closes5m, 14);
    const rsiPrev = closes5m.length > 15 ? computeRSI(closes5m.slice(0, -1), 14) : undefined;
    const bb = computeBollingerBands(closes5m, 20, 2);

    const regimeForStops = this.lastRegime15mReady && this.lastRegime15m
      ? this.lastRegime15m
      : computeRegime(bars5m, close);

    const t1HitNow = rulesContext.targetHit === "T1" || rulesContext.targetHit === "T2" || rulesContext.targetHit === "T3";
    if (t1HitNow && !play.t1Hit) {
      play.t1Hit = true;
    }

    if (t1HitNow && !play.stopAdjusted) {
      const preferEmaStop = regimeForStops.regime === "TREND_UP" || regimeForStops.regime === "TREND_DOWN";
      const desiredStop = preferEmaStop && ema9_5m !== undefined
        ? (play.direction === "LONG" ? Math.max(entryPrice, ema9_5m) : Math.min(entryPrice, ema9_5m))
        : entryPrice;

      const adjustedStop = play.direction === "LONG"
        ? Math.min(desiredStop, close - 0.01)
        : Math.max(desiredStop, close + 0.01);

      play.stop = adjustedStop;
      play.stopAdjusted = true;
      console.log(`[5m] Stop adjusted after T1: ${adjustedStop.toFixed(2)} (${preferEmaStop ? "EMA9" : "breakeven"})`);
    }

    const prevClose = closes5m.length >= 2 ? closes5m[closes5m.length - 2]! : undefined;
    const prev2Close = closes5m.length >= 3 ? closes5m[closes5m.length - 3]! : undefined;
    const consecutiveAgainst = prevClose !== undefined && prev2Close !== undefined
      ? (play.direction === "LONG"
          ? close < prevClose && prevClose < prev2Close
          : close > prevClose && prevClose > prev2Close)
      : false;

    const vwapSlope5m = bars5m.length >= 40 ? computeRegime(bars5m, close).vwapSlopePct : undefined;
    const vwapFlattening = vwapSlope5m !== undefined ? Math.abs(vwapSlope5m) <= 0.02 : false;
    const momentumDrop = rsiPrev !== undefined && rsiNow !== undefined
      ? (play.direction === "LONG" ? rsiNow < rsiPrev - 2 || rsiNow < 50 : rsiNow > rsiPrev + 2 || rsiNow > 50)
      : false;

    const bandReentry = bb && prevClose !== undefined
      ? (play.direction === "LONG"
          ? prevClose > bb.upper && close < bb.upper
          : prevClose < bb.lower && close > bb.lower)
      : false;

    const recentHigh = bars5m.length >= 6 ? Math.max(...bars5m.slice(-6, -1).map((b) => b.high)) : undefined;
    const recentLow = bars5m.length >= 6 ? Math.min(...bars5m.slice(-6, -1).map((b) => b.low)) : undefined;
    const divergence = recentHigh !== undefined && recentLow !== undefined && rsiPrev !== undefined && rsiNow !== undefined
      ? (play.direction === "LONG"
          ? bars5m[bars5m.length - 1]!.high > recentHigh && rsiNow < rsiPrev && ema9_5m !== undefined && close < ema9_5m
          : bars5m[bars5m.length - 1]!.low < recentLow && rsiNow > rsiPrev && ema9_5m !== undefined && close > ema9_5m)
      : false;

    const exhaustionSignals: string[] = [];
    if (bandReentry) exhaustionSignals.push("bb_reentry");
    if (consecutiveAgainst && vwapFlattening && momentumDrop) exhaustionSignals.push("stall_reversal");
    if (divergence) exhaustionSignals.push("rsi_divergence");

    if (play.t1Hit && exhaustionSignals.length > 0) {
      play.stopHit = true;
      play.status = "CLOSED";
      const reason = `Exhaustion exit: ${exhaustionSignals.join(", ")}`;
      const playPermissionMode = play.mode === "SCOUT" ? "SCALP_ONLY" : "NORMAL";
      events.push(this.ev("PLAY_CLOSED", ts, {
        playId: play.id,
        symbol: play.symbol,
        direction: play.direction,
        close,
        stop: play.stop,
        reason,
        result: "WIN",
        exitType: "EXHAUSTION",
        llmAction: "RULES_EXIT",
        decision: {
          decisionId: `${play.symbol}_${ts}_${play.id}`,
          status: "CLOSED",
          kind: "MANAGEMENT",
          permission: {
            long: play.direction === "LONG",
            short: play.direction === "SHORT",
            mode: playPermissionMode
          },
          direction: play.direction,
          rationale: [reason]
        },
        playState: "ENTERED"
      }));
      this.cooldownAfterPlayClosed = Date.now();
      this.state.activePlay = null;
      return events;
    }

    const risk = rulesContext.risk;
    const unrealizedR = risk > 0
      ? (play.direction === "LONG" ? (close - entryPrice) / risk : (entryPrice - close) / risk)
      : 0;
    play.coachingState = play.coachingState ?? {};
    play.coachingState.lastTriggerTs = play.coachingState.lastTriggerTs ?? {};
    play.coachingState.maxFavorableR = play.coachingState.maxFavorableR !== undefined
      ? Math.max(play.coachingState.maxFavorableR, unrealizedR)
      : unrealizedR;
    play.coachingState.maxAdverseR = play.coachingState.maxAdverseR !== undefined
      ? Math.min(play.coachingState.maxAdverseR, unrealizedR)
      : unrealizedR;

    const triggers: string[] = [];
    const nextTargetDistanceR = risk > 0
      ? rulesContext.targetHit === "T1"
        ? rulesContext.distanceToT2Dollars / risk
        : rulesContext.targetHit === "T2"
        ? rulesContext.distanceToT3Dollars / risk
        : rulesContext.distanceToT1Dollars / risk
      : undefined;
    if (rulesContext.targetHit) triggers.push("TARGET_HIT");
    if (nextTargetDistanceR !== undefined && Math.abs(nextTargetDistanceR) <= 0.15) triggers.push("NEAR_TARGET");
    if ((rulesContext.distanceToStopDollars / (risk || 1)) <= 0.2 || unrealizedR <= -0.7) triggers.push("STOP_THREATENED");
    if (unrealizedR >= 0.8) triggers.push("BREAKEVEN_THRESHOLD");
    if (play.coachingState.maxAdverseR !== undefined && play.coachingState.maxAdverseR <= -0.6) triggers.push("ADVERSE_EXCURSION");
    if (play.coachingState.maxFavorableR !== undefined && unrealizedR <= play.coachingState.maxFavorableR - 0.5) {
      triggers.push("ADVERSE_EXCURSION");
    }
    const vwapNow = computeSessionVWAP(bars5m);
    const entrySnapshot = play.entrySnapshot ?? play.armedSnapshot;
    const selectedCandidate = entrySnapshot?.candidates?.find((candidate) => candidate.id === entrySnapshot?.llmSelection?.selectedCandidateId)
      ?? entrySnapshot?.candidates?.[0];
    const usesVwap = !!selectedCandidate?.featureBundle?.location?.priceVsVWAP;
    if (vwapNow !== undefined && usesVwap) {
      const vwapLoss = play.direction === "LONG" ? close < vwapNow : close > vwapNow;
      if (vwapLoss) triggers.push("VWAP_LOSS");
    }
    const regimeNow = computeRegime(bars5m, close);

    const triggerCooldownMs = 10 * 60_000;
    const tierA = new Set(["STOP_THREATENED", "TARGET_HIT", "PLAY_SIZED_UP", "PERMISSION_FLIP_AGAINST_TRADE"]);
    const eligibleTriggers: string[] = [];
    const blockedTriggers: string[] = [];
    for (const trigger of triggers) {
      if (tierA.has(trigger)) {
        eligibleTriggers.push(trigger);
        continue;
      }
      const lastTs = play.coachingState?.lastTriggerTs?.[trigger];
      if (!lastTs || ts - lastTs >= triggerCooldownMs) {
        eligibleTriggers.push(trigger);
      } else {
        blockedTriggers.push(trigger);
      }
    }
    const fallbackCadenceMs = 15 * 60_000;
    const shouldCoach = eligibleTriggers.length > 0 || !play.coachingState.lastCoachTs || (ts - play.coachingState.lastCoachTs) >= fallbackCadenceMs;
    if (!shouldCoach) {
      return events;
    }

    // Hard-boundary checks (cooldowns etc.)
    // Check cache: llmCoachCacheKey = playId + "_" + snapshot.ts (5m close ts)
    const cacheKey = `${play.id}_${ts}`;
    
    // Call LLM once per 5m bar (cache by barTs)
    // Skip if already called for this exact 5m bar
    if (this.llmCoachCache.has(cacheKey)) {
      return events; // Already processed this 5m bar
    }

    // STAGE 3: Coaching runs here (we've passed both gates: play exists AND entered)
    // Call LLM with rules context for pattern analysis
    if (this.llmService && !play.stopHit) {
      const coachingStartTime = Date.now();
      try {
        // STAGE 3: Track LLM call
        this.state.lastLLMCallAt = Date.now();
        const timeInTrade = play.entryTimestamp
          ? Math.floor((ts - play.entryTimestamp) / 60000)
          : 0;
        
        // Build enhanced context with rules information for LLM pattern analysis
        const priceAction = rulesContext.stopThreatened 
          ? "Price approaching stop loss"
          : rulesContext.nearTarget
          ? `Price near ${rulesContext.nearTarget} target`
          : rulesContext.targetHit
          ? `${rulesContext.targetHit} target hit`
          : "Monitoring price action";
        
        const entrySnapshot = play.entrySnapshot ?? play.armedSnapshot;
        const llmResponse = await this.llmService.getCoachingUpdate({
          symbol: play.symbol,
          direction: play.direction,
          entryPrice,
          currentPrice: close,
          stop: play.stop,
          targets: play.targets,
          timeInTrade,
          priceAction,
          snapshot: entrySnapshot,
          entrySnapshot,
          playContext: {
            playId: play.id,
            entryTime: play.entryTimestamp,
            lastAction: play.action
          },
          // Add rules context for LLM probability calculations (exact formulas)
          rulesContext: {
            distanceToStop: rulesContext.distanceToStop,
            distanceToStopDollars: rulesContext.distanceToStopDollars,
            distanceToT1: rulesContext.distanceToT1,
            distanceToT1Dollars: rulesContext.distanceToT1Dollars,
            distanceToT2: rulesContext.distanceToT2,
            distanceToT2Dollars: rulesContext.distanceToT2Dollars,
            distanceToT3: rulesContext.distanceToT3,
            distanceToT3Dollars: rulesContext.distanceToT3Dollars,
            stopThreatened: rulesContext.stopThreatened,
            nearTarget: rulesContext.nearTarget,
            targetHit: rulesContext.targetHit,
            risk: rulesContext.risk,
            rewardT1: rulesContext.rewardT1,
            rewardT2: rulesContext.rewardT2,
            rewardT3: rulesContext.rewardT3,
            rMultipleT1: rulesContext.rMultipleT1,
            rMultipleT2: rulesContext.rMultipleT2,
            rMultipleT3: rulesContext.rMultipleT3,
            profitPercent: rulesContext.profitPercent,
            unrealizedR,
            maxFavorableR: play.coachingState.maxFavorableR,
            maxAdverseR: play.coachingState.maxAdverseR,
            t1Hit: play.t1Hit ?? false,
            stopAdjusted: play.stopAdjusted ?? false,
            exhaustionSignals
          }
        });

        let llmAction = llmResponse.action;
        const stopTightenAllowed = llmResponse.proposedStop !== undefined
          ? (play.direction === "LONG" ? llmResponse.proposedStop >= play.stop : llmResponse.proposedStop <= play.stop)
          : true;
        if (!stopTightenAllowed) {
          llmAction = "HOLD";
        }
        if (llmResponse.proposedPartialPct !== undefined && llmResponse.proposedPartialPct > 0.5) {
          llmResponse.proposedPartialPct = 0.5;
        }
        if (llmAction === "ADD") {
          const timingScore = entrySnapshot?.timing?.score;
          if (!(timingScore !== undefined && timingScore >= 80 && unrealizedR > 0.5)) {
            llmAction = "HOLD";
          }
        }
        const llmReasoning = llmResponse.reasoning;
        const llmUrgency = llmResponse.urgency;
        play.coachingState.lastCoachTs = ts;
        play.coachingState.lastRecommendation = llmAction;
        for (const trigger of eligibleTriggers) {
          play.coachingState.lastTriggerTs[trigger] = ts;
        }
        
        // STAGE 3: Track LLM decision
        this.state.lastLLMDecision = `COACH:${llmAction}`;

        // Cache this call (mark as processed for this 5m bar)
        // Cache key: playId + "_" + bar5m.ts (stable 5m close timestamp)
        this.llmCoachCache.set(cacheKey, Date.now());
        
        // Clean old cache entries (keep last 10)
        if (this.llmCoachCache.size > 10) {
          const firstKey = this.llmCoachCache.keys().next().value;
          if (firstKey) this.llmCoachCache.delete(firstKey);
        }

        // STAGE 3: Log coaching run with latency
        const coachingLatency = Date.now() - coachingStartTime;
        console.log(`[5m] coaching run playId=${play.id} latencyMs=${coachingLatency}`);

        // Emit LLM_COACH_UPDATE only if materially changed OR cooldown expired
        // (For now, emit every 5m bar - you can add material change detection later)
        const playPermissionMode = play.mode === "SCOUT" ? "SCALP_ONLY" : "NORMAL";
        events.push(this.ev("LLM_COACH_UPDATE", ts, {
          playId: play.id,
          symbol: play.symbol,
          direction: play.direction,
          price: close,
          decisionState: "MANAGE",
          action: llmAction,
          reasoning: llmReasoning,
          urgency: llmUrgency,
          confidence: llmResponse.confidence,
          reasonCodes: llmResponse.reasonCodes,
          proposedStop: llmResponse.proposedStop,
          proposedPartialPct: llmResponse.proposedPartialPct,
          nextCheck: llmResponse.nextCheck,
          triggers: eligibleTriggers,
          blockedTriggers,
          update: llmReasoning,
          rulesContext, // Include rules context in event
          decision: {
            decisionId: `${play.symbol}_${ts}_${play.id}`,
            status: play.status,
            kind: "MANAGEMENT",
            permission: {
              long: play.direction === "LONG",
              short: play.direction === "SHORT",
              mode: playPermissionMode
            },
            direction: play.direction,
            rationale: [llmReasoning || llmAction]
          },
          playState: "ENTERED"
        }));
        
        // LLM decision is FINAL - if LLM says exit, we exit
        if (llmAction === "STOP_OUT" || llmAction === "TAKE_PROFIT") {
          play.stopHit = true;
          play.status = "CLOSED";
          
          const result = llmAction === "TAKE_PROFIT" ? "WIN" : "LOSS";
          const exitType = llmAction === "TAKE_PROFIT" ? "TAKE_PROFIT" : "STOP_HIT";
          
          // INVARIANT: PLAY_CLOSED must have matching active play (verified - we have play)
          events.push(this.ev("PLAY_CLOSED", ts, {
            playId: play.id,
            symbol: play.symbol,
            direction: play.direction,
            close,
            stop: play.stop,
            reason: `LLM decision: ${llmReasoning}`,
            result,
            exitType,
            targetHit: rulesContext.targetHit,
            llmAction,
            llmReasoning,
            decision: {
              decisionId: `${play.symbol}_${ts}_${play.id}`,
              status: "CLOSED",
              kind: "MANAGEMENT",
              permission: {
                long: play.direction === "LONG",
                short: play.direction === "SHORT",
                mode: playPermissionMode
              },
              direction: play.direction,
              rationale: [llmReasoning || llmAction]
            },
            playState: "ENTERED"
          }));
          
          // Set cooldown after play closed
          this.cooldownAfterPlayClosed = Date.now();
          console.log(`[Guardrails] Play closed, cooldown set for ${this.cooldownAfterPlayClosedMin} minutes`);
          
          this.state.activePlay = null;
          return events;
        }
        
        // If LLM says HOLD, SCALE_OUT, or TIGHTEN_STOP, we continue
        // (TIGHTEN_STOP would update stop level, SCALE_OUT is partial)
        
      } catch (error: any) {
        const coachingLatency = Date.now() - coachingStartTime;
        console.error(`[5m] coaching error playId=${play.id} latencyMs=${coachingLatency} error=${error.message}`);
        // If LLM fails, continue holding (don't exit on error)
      }
    } else {
      // STAGE 3: Log when coaching is skipped due to missing LLM service or stop hit
      if (!this.llmService) {
        console.log(`[5m] coaching skipped (LLM service not available)`);
      } else if (play.stopHit) {
        console.log(`[5m] coaching skipped (stop hit)`);
      }
    }

    return events;
  }

  private shouldPublishScorecard(next: ScorecardSnapshot): boolean {
    if (!this.lastScorecardSnapshot) {
      this.lastScorecardSnapshot = next;
      return true;
    }
    const prev = this.lastScorecardSnapshot;
    const changed =
      prev.topPlayKey !== next.topPlayKey ||
      prev.entryPermission !== next.entryPermission ||
      prev.timingPhase !== next.timingPhase ||
      prev.directionBand !== next.directionBand ||
      prev.direction !== next.direction ||
      prev.llmAction !== next.llmAction ||
      prev.decisionStatus !== next.decisionStatus;
    if (changed) {
      this.lastScorecardSnapshot = next;
    }
    return changed;
  }

  private buildPendingPlay(candidate: SetupCandidate, llmSummary: DecisionLlmSummary | undefined, ts: number): Play {
    const playMode: Play["mode"] = llmSummary?.action === "GO_ALL_IN" ? "FULL" : "SCOUT";
    const grade =
      candidate.score.total >= 70 ? "A" : candidate.score.total >= 60 ? "B" : candidate.score.total >= 50 ? "C" : "D";
    return {
      id: candidate.id,
      symbol: candidate.symbol,
      direction: candidate.direction,
      score: candidate.score.total,
      grade,
      entryZone: candidate.entryZone,
      stop: candidate.stop,
      targets: candidate.targets,
      valueBand: candidate.meta?.valueBand,
      vwapRef: candidate.meta?.vwapRef ?? null,
      mode: playMode,
      confidence: llmSummary?.probability ?? candidate.score.total,
      legitimacy: llmSummary?.legitimacy,
      followThroughProb: llmSummary?.followThroughProb,
      action: llmSummary?.action,
      armedTimestamp: undefined,
      expiresAt: ts + 30 * 60 * 1000,
      triggerPrice: candidate.triggerPrice,
      status: "PENDING",
      inEntryZone: false,
      stopHit: false,
    };
  }

  private updateRangeMode(rangeCondition: boolean, hasSignal: boolean): boolean {
    if (hasSignal) {
      this.rangeModeActive = false;
      this.rangeModeConsecutiveTrue = 0;
      this.rangeModeConsecutiveFalse = 0;
      return false;
    }
    if (rangeCondition) {
      this.rangeModeConsecutiveTrue += 1;
      this.rangeModeConsecutiveFalse = 0;
    } else {
      this.rangeModeConsecutiveFalse += 1;
      this.rangeModeConsecutiveTrue = 0;
    }
    if (this.rangeModeActive) {
      if (this.rangeModeConsecutiveFalse >= 3) {
        this.rangeModeActive = false;
      }
    } else if (this.rangeModeConsecutiveTrue >= 2) {
      this.rangeModeActive = true;
    }
    return this.rangeModeActive;
  }

  private ev(type: DomainEvent["type"], timestamp: number, data: Record<string, any>): DomainEvent {
    if (requiresDecisionState(type) && !data.decisionState) {
      throw new Error(`[DecisionState] missing decisionState for ${type}`);
    }
    return { type, timestamp, instanceId: this.instanceId, data };
  }

  private confirmEntryOnPullbackReclaim(
    play: Play,
    bar: ConfirmBar
  ): { ok: boolean; shouldCancel?: boolean; reason: string } {
    const dir = play.direction;
    const reclaimLine = play.tier === "LEANING" ? bar.ema20 : bar.ema9;

    if (reclaimLine === undefined || !Number.isFinite(reclaimLine)) {
      return { ok: false, shouldCancel: false, reason: "Missing reclaim line" };
    }

    const timeInTradeMin = play.entryTimestamp ? (bar.ts - play.entryTimestamp) / 60000 : 0;
    const maxWaitMin = play.tier === "LEANING" ? 12 : 10;
    if (timeInTradeMin >= maxWaitMin) {
      return { ok: false, shouldCancel: true, reason: "Reclaim timeout" };
    }

    if (!play.reclaim) play.reclaim = { step: "WAIT_RECLAIM" } as ReclaimState;

    const reclaimed =
      dir === "LONG" ? bar.close > reclaimLine : bar.close < reclaimLine;
    const held =
      dir === "LONG" ? bar.close >= reclaimLine : bar.close <= reclaimLine;
    const requiredHolds = play.tier === "LEANING" ? 2 : 1;

    if (play.reclaim.step === "WAIT_RECLAIM") {
      if (!reclaimed) {
        return { ok: false, shouldCancel: false, reason: "Waiting for reclaim close" };
      }
      play.reclaim.step = "WAIT_CONFIRM";
      play.reclaim.reclaimTs = bar.ts;
      play.reclaim.reclaimClose = bar.close;
      play.reclaim.confirmations = 0;
      return { ok: false, shouldCancel: false, reason: "Reclaim detected; waiting confirm bar" };
    }

    if (play.reclaim.step === "WAIT_CONFIRM") {
      if (held) {
        const confirmations = (play.reclaim.confirmations ?? 0) + 1;
        play.reclaim.confirmations = confirmations;
        if (confirmations >= requiredHolds) {
          return { ok: true, shouldCancel: false, reason: "Reclaim confirmed; size-up ok" };
        }
        return { ok: false, shouldCancel: false, reason: `Reclaim holding (${confirmations}/${requiredHolds})` };
      }
      play.reclaim.step = "WAIT_RECLAIM";
      play.reclaim.reclaimTs = undefined;
      play.reclaim.reclaimClose = undefined;
      play.reclaim.confirmations = undefined;
      return { ok: false, shouldCancel: false, reason: "Reclaim failed; reset" };
    }

    return { ok: false, shouldCancel: false, reason: "Unknown reclaim state" };
  }
}
