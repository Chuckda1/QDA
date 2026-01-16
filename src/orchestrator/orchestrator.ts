import type { Bias, BotState, Direction, DomainEvent, EntryPermission, Play, PotdBias, PotdMode, ReclaimState, TimingStateContext, TradeAction } from "../types.js";
import type { LLMService } from "../llm/llmService.js";
import { StopProfitRules } from "../rules/stopProfitRules.js";
import { EntryFilters, type EntryFilterContext } from "../rules/entryFilters.js";
import { getMarketSessionLabel, getETDateString } from "../utils/timeUtils.js";
import { inferDirectionFromRecentBars, inferTacticalBiasFromRecentBars } from "../rules/directionRules.js";
import { computeTimingSignal } from "../rules/timingRules.js";
import type { TimingSignal } from "../rules/timingRules.js";
import { computeMacroBias, computeRegime, regimeAllowsDirection } from "../rules/regimeRules.js";
import { computeATR, computeBollingerBands, computeEMA, computeVWAP, computeRSI, type OHLCVBar } from "../utils/indicators.js";
import { SetupEngine, type SetupEngineResult } from "../rules/setupEngine.js";
import type { SetupCandidate } from "../types.js";
import type { DirectionInference } from "../rules/directionRules.js";
import type { RegimeResult } from "../rules/regimeRules.js";
import {
  buildDecision,
  buildNoEntryDecision,
  type AuthoritativeDecision,
  type DecisionBlocker,
  type DecisionLlmSummary,
  type DecisionRulesSnapshot
} from "./decisionGate.js";

type SetupDiagnosticsSnapshot = {
  ts: number;
  symbol: string;
  close: number;
  regime: RegimeResult;
  macroBias?: Bias;
  directionInference: DirectionInference;
  candidate?: SetupCandidate;
  setupReason?: string;
  setupDebug?: any;
  entryFilterWarnings?: string[];
  entryPermission?: EntryPermission;
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

function directionGate15mMoreLeaning(input: {
  close15m: number;
  vwap15m?: number;
  ema9_15m?: number;
  ema20_15m?: number;
  structure15m?: "BULLISH" | "BEARISH" | "MIXED" | "CHOP";
  vwapSlope15m?: number;
  ema20Slope15m?: number;
}): DirectionGate {
  const { close15m, vwap15m, ema9_15m, ema20_15m, structure15m, vwapSlope15m, ema20Slope15m } = input;

  if (vwap15m === undefined || ema9_15m === undefined || ema20_15m === undefined) {
    return { allow: false, tier: "NONE", reason: "Direction gate: missing VWAP/EMA inputs" };
  }

  const onVwapLong = close15m > vwap15m;
  const onVwapShort = close15m < vwap15m;

  const emaLong = ema9_15m > ema20_15m;
  const emaShort = ema9_15m < ema20_15m;

  const structureBull = structure15m === "BULLISH";
  const structureBear = structure15m === "BEARISH";

  const slopeBull =
    (vwapSlope15m !== undefined && vwapSlope15m > 0) ||
    (ema20Slope15m !== undefined && ema20Slope15m > 0);

  const slopeBear =
    (vwapSlope15m !== undefined && vwapSlope15m < 0) ||
    (ema20Slope15m !== undefined && ema20Slope15m < 0);

  const longCore2 = onVwapLong && emaLong;
  const shortCore2 = onVwapShort && emaShort;

  if (longCore2 && (structureBull || slopeBull)) {
    return {
      allow: true,
      tier: "LOCKED",
      direction: "LONG",
      reason: `LOCKED LONG: VWAP side + EMA stack + ${(structureBull ? "structure" : "slope")} confirm`
    };
  }

  if (shortCore2 && (structureBear || slopeBear)) {
    return {
      allow: true,
      tier: "LOCKED",
      direction: "SHORT",
      reason: `LOCKED SHORT: VWAP side + EMA stack + ${(structureBear ? "structure" : "slope")} confirm`
    };
  }

  const longOpposed = structureBear;
  const shortOpposed = structureBull;

  if (onVwapLong && !longOpposed && (emaLong || slopeBull || structureBull)) {
    return {
      allow: true,
      tier: "LEANING",
      direction: "LONG",
      reason: "LEANING LONG: on correct VWAP side; not opposed; EMA/slope/structure supportive"
    };
  }

  if (onVwapShort && !shortOpposed && (emaShort || slopeBear || structureBear)) {
    return {
      allow: true,
      tier: "LEANING",
      direction: "SHORT",
      reason: "LEANING SHORT: on correct VWAP side; not opposed; EMA/slope/structure supportive"
    };
  }

  return {
    allow: false,
    tier: "NONE",
    reason: `Direction unclear/contested: close=${close15m.toFixed(2)} vwap=${vwap15m.toFixed(2)} ema9=${ema9_15m.toFixed(2)} ema20=${ema20_15m.toFixed(2)} structure=${structure15m ?? "?"}`
  };
}

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
  private lastRegime15m: RegimeResult | null = null;
  private lastMacroBias: Bias = "NEUTRAL";
  private lastRegime15mTs: number | null = null;
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

  private buildSnapshot(input: TickInput, timeframe: "1m" | "5m" | "15m"): TickSnapshot {
    return { ...input, timeframe };
  }

  /**
   * Handle 1m bars: Entry detection + close-based stop checks
   */
  private async handle1m(snapshot: TickSnapshot): Promise<DomainEvent[]> {
    const events: DomainEvent[] = [];
    const { ts, symbol, close, high, low, open, volume } = snapshot;

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
          this.lastDiagnostics = {
            ts,
            symbol,
            close,
            regime: this.lastRegime15m ?? computeRegime(this.recentBars1m, close),
            macroBias: this.lastMacroBias,
            directionInference: inferDirectionFromRecentBars(this.recentBars1m),
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
          this.lastDiagnostics = {
            ts,
            symbol,
            close,
            regime: this.lastRegime15m ?? computeRegime(this.recentBars1m, close),
            macroBias: this.lastMacroBias,
            directionInference: inferDirectionFromRecentBars(this.recentBars1m),
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
        this.lastDiagnostics = {
          ts,
          symbol,
          close,
          regime: this.lastRegime15m ?? computeRegime(this.recentBars1m, close),
          macroBias: this.lastMacroBias,
          directionInference: inferDirectionFromRecentBars(this.recentBars1m),
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
    const buildDecisionPayload = (params: {
      kind: "GATE" | "EXECUTION" | "MANAGEMENT";
      status: string;
      allowed?: boolean;
      direction?: "LONG" | "SHORT" | "NONE";
      gateTier?: "LEANING" | "STRICT" | "OPEN";
      blockers?: string[];
      blockerReasons?: string[];
      rationale?: string[];
      permissionMode?: "SCALP_ONLY" | "SWING_ALLOWED" | "BLOCKED";
    }) => {
      const permission = {
        long: play.direction === "LONG",
        short: play.direction === "SHORT",
        mode: params.permissionMode ?? (play.tier === "LEANING" ? "SCALP_ONLY" : "SWING_ALLOWED")
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
        rationale: params.rationale
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
            mode: play.tier === "LEANING" ? "SCALP_ONLY" : "SWING_ALLOWED"
          },
          direction: play.direction,
          gateTier: "STRICT",
          rationale: decision.blockerReasons
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
    const vwap1m = computeVWAP(this.recentBars1m, 30);
    const atr1m = computeATR(this.recentBars1m, 14);
    const timingSignal = computeTimingSignal({
      bars: this.recentBars1m.length ? this.recentBars1m : this.recentBars5m,
      direction: play.direction,
      entryZone: play.entryZone,
      vwap: vwap1m,
      atr: atr1m
    });
    const barRef: OHLCVBar = snapshot.bar1m ?? {
      ts,
      open,
      high,
      low,
      close,
      volume
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

        events.push(this.ev("PLAY_ENTERED", ts, {
          playId: play.id,
          symbol: play.symbol,
          direction: play.direction,
          price: close,
          entryPrice: play.entryPrice,
          entryTrigger,
          reason: "Pullback depth hit",
          timing: enteredTimingSnapshot,
          decision: buildDecisionPayload({
            kind: "EXECUTION",
            status: "ENTERED",
            allowed: true,
            rationale: ["pullback depth hit", `timing score=${timingSignal.score}`]
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
      const playPermissionMode = play.mode === "SCOUT" ? "SCALP_ONLY" : "SWING_ALLOWED";
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
        const sizedPermissionMode = play.mode === "SCOUT" ? "SCALP_ONLY" : "SWING_ALLOWED";
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

    const rawRegime = computeRegime(this.recentBars15m, close);
    const rawBias = computeMacroBias(this.recentBars15m, close);

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

    const mergedRegime: RegimeResult = {
      ...rawRegime,
      regime: finalRegime,
      reasons: hysteresisNotes.length ? [...rawRegime.reasons, ...hysteresisNotes] : rawRegime.reasons
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
        const fallbackRegime = this.lastRegime15m ?? computeRegime(this.recentBars5m, close);
        this.lastDiagnostics = {
          ts,
          symbol,
          close,
          regime: fallbackRegime,
          macroBias: this.lastMacroBias,
          directionInference: inferDirectionFromRecentBars(this.recentBars5m),
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

      const rawRegime5m = computeRegime(this.recentBars5m, close);
      const anchorRegime = this.lastRegime15m ?? {
        ...rawRegime5m,
        regime: "TRANSITION",
        reasons: [...rawRegime5m.reasons, "anchor pending: default TRANSITION until 15m confirms"]
      };
      const macroBiasInfo = this.lastRegime15m
        ? { bias: this.lastMacroBias, reasons: ["anchor=15m"] }
        : { bias: "NEUTRAL" as Bias, reasons: ["anchor pending: bias neutral until 15m confirms"] };

      const dirInf = inferDirectionFromRecentBars(this.recentBars5m);
      if (!dirInf.direction) {
        console.log(`[5m] Direction inference unclear (continuing): ${dirInf.reasons.join(" | ")}`);
      }

      const tacticalBars = this.recentBars1m.length >= 6 ? this.recentBars1m : this.recentBars5m;
      const tacticalLookback = tacticalBars === this.recentBars1m ? 5 : 3;
      const tacticalBiasInfo = inferTacticalBiasFromRecentBars(tacticalBars, { lookback: tacticalLookback });

      const atr = computeATR(this.recentBars5m, 14);
      const closes = this.recentBars5m.map((b) => b.close);
      const ema9 = computeEMA(closes.slice(-60), 9);
      const ema20 = computeEMA(closes.slice(-80), 20);
      const vwap = computeVWAP(this.recentBars5m, 30);
      const rsi14 = computeRSI(closes, 14);

      let directionGate = directionGate15mMoreLeaning({
        close15m: this.last15mClose ?? close,
        vwap15m: this.last15mVwap ?? anchorRegime.vwap,
        ema9_15m: this.last15mEma9,
        ema20_15m: this.last15mEma20,
        structure15m: this.last15mStructure ?? anchorRegime.structure,
        vwapSlope15m: this.last15mVwapSlopePct ?? anchorRegime.vwapSlopePct,
        ema20Slope15m: this.last15mEma20Slope,
      });

      const tacticalBias = tacticalBiasInfo.bias;
      const potdActiveForGate = this.potdMode !== "OFF" && this.potdBias !== "NONE" && this.potdConfidence > 0;
      if (anchorRegime.regime === "CHOP" || anchorRegime.regime === "TRANSITION") {
        if (tacticalBias === "NONE" || tacticalBiasInfo.tier !== "CLEAR") {
          if (potdActiveForGate) {
            directionGate = {
              allow: true,
              tier: "LEANING",
              direction: this.potdBias,
              reason: `POTD bias ${this.potdBias} (tactical unclear; scalp-only)`,
            };
          } else {
            directionGate = {
              allow: false,
              tier: "NONE",
              reason: `tactical bias not clear (tier=${tacticalBiasInfo.tier})`,
            };
          }
        } else {
          directionGate = {
            allow: true,
            tier: "LEANING",
            direction: tacticalBias,
            reason: `tactical bias ${tacticalBias} (${tacticalBiasInfo.confidence}%)${tacticalBiasInfo.shock ? " | shock mode" : ""}`,
          };
        }
      }

      const setupResult = this.setupEngine.findSetup({
        ts,
        symbol,
        currentPrice: close,
        bars: this.recentBars5m,
        regime: anchorRegime,
        macroBias: macroBiasInfo.bias,
        directionInference: dirInf,
        indicators: { vwap, ema9, ema20, atr, rsi14 }
      });

      if (!setupResult.candidate) {
        this.lastDiagnostics = {
          ts,
          symbol,
          close,
          regime: anchorRegime,
          macroBias: macroBiasInfo.bias,
          directionInference: dirInf,
          setupReason: setupResult.reason || "no setup pattern found",
          setupDebug: setupResult.debug,
          regimeEvidence: anchorRegime.bullScore !== undefined && anchorRegime.bearScore !== undefined ? {
            bullScore: anchorRegime.bullScore,
            bearScore: anchorRegime.bearScore,
          } : undefined,
        };
        console.log(`[5m] No setup candidate: ${setupResult.reason || "unknown"}`);
        this.lastDecision = buildDecision({
          ts,
          symbol,
          blockers: ["no_active_play"],
          blockerReasons: [setupResult.reason || "no setup pattern found"],
          expiryMs: 30 * 60 * 1000
        });
        return events;
      }

      const setupCandidate = setupResult.candidate;
      const timingSignal = computeTimingSignal({
        bars: this.recentBars1m.length ? this.recentBars1m : this.recentBars5m,
        direction: setupCandidate.direction,
        entryZone: setupCandidate.entryZone,
        vwap: computeVWAP(this.recentBars1m, 30),
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
      const timingSnapshot = {
        ...timingSignal,
        phase: timingState.phase,
        dir: timingState.dir,
        phaseSinceTs: timingState.phaseSinceTs,
        rawState: timingSignal.state
      };
      const blockers: DecisionBlocker[] = [];
      const blockerReasons: string[] = [];
      const transitionLockActive = this.transitionLockRemaining > 0;

      if (!directionGate.allow) {
        blockers.push("guardrail");
        blockerReasons.push(directionGate.reason);
      } else if (setupCandidate.direction !== directionGate.direction) {
        blockers.push("guardrail");
        blockerReasons.push(`Direction gate: ${directionGate.tier} ${directionGate.direction} only`);
      }

      if (directionGate.allow) {
        const scoreFloor = directionGate.tier === "LEANING" ? 78 : 70;
        if (setupCandidate.score.total < scoreFloor) {
          blockers.push("guardrail");
          blockerReasons.push(`score floor ${scoreFloor} (${setupCandidate.score.total})`);
        }
        if (transitionLockActive) {
          blockerReasons.push(`transition lock (${this.transitionLockRemaining}/${this.transitionLockBars})`);
        }
        if (directionGate.tier === "LEANING" && setupCandidate.flags?.includes("CHASE_RISK")) {
          blockers.push("guardrail");
          blockerReasons.push("leaning: chase risk blocked");
        }
        if (directionGate.tier === "LEANING" && atr) {
          const entryMid = (setupCandidate.entryZone.low + setupCandidate.entryZone.high) / 2;
          const riskAtr = Math.abs(entryMid - setupCandidate.stop) / atr;
          if (riskAtr > 1.0) {
            blockers.push("guardrail");
            blockerReasons.push(`leaning risk/ATR too large (${riskAtr.toFixed(2)})`);
          }
        }
        if ((anchorRegime.regime === "CHOP" || anchorRegime.regime === "TRANSITION") && atr) {
          const entryMid = (setupCandidate.entryZone.low + setupCandidate.entryZone.high) / 2;
          const riskAtr = Math.abs(entryMid - setupCandidate.stop) / atr;
          if (riskAtr > 0.9) {
            blockers.push("guardrail");
            blockerReasons.push(`chop/transition risk/ATR too large (${riskAtr.toFixed(2)})`);
          }
        }
      }

      const potdActive = this.potdMode !== "OFF" && this.potdBias !== "NONE" && this.potdConfidence > 0;
      const potdConfirmed = potdActive && macroBiasInfo.bias === this.potdBias;
      const potdAlignment: "ALIGNED" | "COUNTERTREND" | "UNCONFIRMED" | "OFF" = !potdActive
        ? "OFF"
        : !potdConfirmed
        ? "UNCONFIRMED"
        : setupCandidate.direction === this.potdBias
        ? "ALIGNED"
        : "COUNTERTREND";
      const potdCountertrend = potdConfirmed && setupCandidate.direction !== this.potdBias;

      if (potdCountertrend) {
        setupCandidate.flags = [...(setupCandidate.flags ?? []), "POTD_COUNTERTREND"];
        blockers.push("guardrail");
        blockerReasons.push(`POTD confirmed: countertrend ${setupCandidate.direction} disabled`);
      }

      if (potdActive && this.potdMode === "PRIOR") {
        const delta = Math.round(this.potdPriorWeight * this.potdConfidence * (setupCandidate.direction === this.potdBias ? 1 : -1));
        setupCandidate.score.total = this.clampScore(setupCandidate.score.total + delta);
        setupCandidate.rationale.push(`potdPrior=${delta} (bias=${this.potdBias} conf=${this.potdConfidence})`);
      }

      if (potdActive && this.potdMode === "HARD" && setupCandidate.direction !== this.potdBias) {
        blockers.push("guardrail");
        blockerReasons.push(`POTD hard mode: ${this.potdBias} only (manual override required)`);
      }

      if (setupCandidate.pattern !== "REVERSAL_ATTEMPT") {
        if (anchorRegime.regime === "CHOP" || anchorRegime.regime === "TRANSITION") {
          if (tacticalBias === "NONE" || tacticalBiasInfo.tier !== "CLEAR") {
            if (!(potdActive && setupCandidate.direction === this.potdBias)) {
              blockers.push("chop");
              blockerReasons.push(`blocked: CHOP/TRANSITION requires CLEAR tactical bias (tier=${tacticalBiasInfo.tier})`);
            }
          } else if (setupCandidate.direction !== tacticalBias) {
            blockers.push("guardrail");
            blockerReasons.push(`blocked: tactical bias ${tacticalBias} only`);
          }
        } else {
          const regimeCheck = regimeAllowsDirection(anchorRegime.regime, setupCandidate.direction);
          const hasChopOverride = setupCandidate.flags?.includes("CHOP_OVERRIDE") ?? false;
          if (!regimeCheck.allowed && !(anchorRegime.regime === "CHOP" && hasChopOverride)) {
            blockers.push(anchorRegime.regime === "CHOP" ? "chop" : "guardrail");
            blockerReasons.push(regimeCheck.reason);
          }
        }
      }

      if (macroBiasInfo.bias === "LONG" && setupCandidate.direction === "SHORT" && anchorRegime.regime !== "TREND_DOWN") {
        blockers.push("guardrail");
        blockerReasons.push("bias gate: 15m bias LONG blocks SHORT setups until 15m turns");
      }
      if (macroBiasInfo.bias === "SHORT" && setupCandidate.direction === "LONG" && anchorRegime.regime !== "TREND_UP") {
        blockers.push("guardrail");
        blockerReasons.push("bias gate: 15m bias SHORT blocks LONG setups until 15m turns");
      }

      const regimeConfidence = anchorRegime.bullScore !== undefined && anchorRegime.bearScore !== undefined
        ? Math.round(Math.max(anchorRegime.bullScore, anchorRegime.bearScore) / 3 * 100)
        : undefined;
      const shockMode = tacticalBiasInfo.shock;
      const permissionMode =
        anchorRegime.regime === "CHOP" || anchorRegime.regime === "TRANSITION" || transitionLockActive || shockMode
          ? "SCALP_ONLY"
          : "SWING_ALLOWED";
      const chopTransition = anchorRegime.regime === "CHOP" || anchorRegime.regime === "TRANSITION";
      const permission = chopTransition
        ? { long: true, short: true, mode: "SCALP_ONLY" }
        : directionGate.allow
        ? {
            long: directionGate.direction === "LONG",
            short: directionGate.direction === "SHORT",
            mode: permissionMode,
          }
        : { long: false, short: false, mode: "BLOCKED" };
      const marketState = {
        regime: anchorRegime.regime,
        confidence: regimeConfidence,
        permission,
        tacticalBias: {
          bias: tacticalBias,
          tier: tacticalBiasInfo.tier,
          score: tacticalBiasInfo.score,
          confidence: tacticalBiasInfo.confidence,
          shock: shockMode,
          shockReason: tacticalBiasInfo.shockReason,
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

      const filterContext: EntryFilterContext = {
        timestamp: ts,
        symbol,
        direction: setupCandidate.direction,
        close,
        high,
        low,
        open,
        volume,
        indicators: { vwap, ema20, ema9, atr, rsi14 },
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

      const filterResult = this.entryFilters.canCreateNewPlay(filterContext);
      if (filterResult.warnings?.length) {
        console.log(`[5m] Entry filter warnings: ${filterResult.warnings.join(" | ")}`);
      }
      if (!filterResult.allowed) {
        blockers.push("entry_filter");
        if (filterResult.reason) {
          blockerReasons.push(filterResult.reason);
        }
        console.log(`[5m] Entry blocked by filter: ${filterResult.reason}`);
      }

      this.lastDiagnostics = {
        ts,
        symbol,
        close,
        regime: anchorRegime,
        macroBias: macroBiasInfo.bias,
        directionInference: dirInf,
        tacticalBias: tacticalBiasInfo,
        candidate: setupCandidate,
        entryFilterWarnings: filterResult.warnings,
        entryPermission: filterResult.permission,
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
        blockers.push(isCooldown ? "cooldown" : "guardrail");
        if (guardrailCheck.reason) blockerReasons.push(guardrailCheck.reason);
        this.lastDiagnostics = {
          ...this.lastDiagnostics,
          guardrailBlock: guardrailCheck.reason,
          setupReason: `guardrail: ${guardrailCheck.reason}`
        };
      }

      if (watchOnly) {
        if (!blockers.includes("arming_failed")) {
          blockers.push("arming_failed");
        }
        blockerReasons.push("mode QUIET");
      }

      const dirWarning = `Direction inference: ${dirInf.direction ?? "N/A"} (confidence=${dirInf.confidence}) | ${dirInf.reasons.join(" | ")}`;
      const regimeWarning = `Regime gate (15m): ${anchorRegime.regime} | ${anchorRegime.reasons.join(" | ")}`;
      const biasWarning = `Macro bias (15m): ${macroBiasInfo.bias}`;
      const entryPermission = filterResult.permission ?? "ALLOWED";
      const permissionWarning = `Entry permission: ${entryPermission}${filterResult.reason ? ` (${filterResult.reason})` : ""}`;
      const potdWarning = potdActive
        ? `POTD: ${this.potdBias} (conf=${this.potdConfidence.toFixed(2)} mode=${this.potdMode}) alignment=${potdAlignment}`
        : "POTD: OFF";
      const indicatorMeta = {
        entryTF: "5m",
        atrLen: 14,
        vwapLen: 30,
        emaLens: [9, 20],
        regimeTF: "15m"
      };
      const indicatorMetaLine = `TF: entry=5m atr=14 vwap=30 ema=9/20 regime=15m`;

      const llmWarnings = [
        ...(filterResult.warnings ?? []),
        dirWarning,
        regimeWarning,
        biasWarning,
        permissionWarning,
        potdWarning,
        indicatorMetaLine
      ];

      const recentBarsForLLM = this.recentBars5m.slice(-20).map((b) => ({
        ts: b.ts,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume
      }));

      const indicatorSnapshot = {
        vwap,
        ema9,
        ema20,
        atr,
        rsi14,
        vwapSlope: anchorRegime.vwapSlope,
        structure: anchorRegime.structure
      };

      const ruleScores = {
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

      const shouldRunLlm = !!this.llmService && !watchOnly && blockers.length === 0;

      if (shouldRunLlm) {
        try {
          console.log(`[5m] Calling LLM for setup validation: ${setupCandidate.id}`);
          this.state.lastLLMCallAt = Date.now();

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
            setupCandidate
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
                blockers.push("arming_failed");
                blockerReasons.push(`LLM timeout: ${this.llmTimeoutMs}ms`);
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
          blockers.push("arming_failed");
          blockerReasons.push(`LLM error: ${error.message}`);
        }
      } else if (!this.llmService && this.allowRulesOnlyWhenLLMDown && setupCandidate.score.total >= this.rulesOnlyMinScore && !watchOnly && blockers.length === 0) {
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
      } else if (!this.llmService && !watchOnly && blockers.length === 0) {
        blockers.push("arming_failed");
        blockerReasons.push(`no LLM service - setup requires LLM approval${this.allowRulesOnlyWhenLLMDown ? ` (or A-grade score >= ${this.rulesOnlyMinScore})` : ""}`);
        console.log(`[5m] No LLM service - setup found but requires LLM approval`);
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
          note: llmRulesOnly ? "rules-only" : llmTimedOut ? "timeout" : undefined
        };
        this.state.lastLLMDecision = `VERIFY:${llmVerify.action}${llmTimedOut ? " (timeout)" : ""}${llmRulesOnly ? " (rules-only)" : ""}`;

        if (llmVerify.action === "PASS") {
          this.cooldownAfterLLMPass = Date.now();
        }
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

      const highProbGate = (this.enforceHighProbabilitySetups || this.autoAllInOnHighProb)
        ? this.evaluateHighProbabilityGate({
            candidate: setupCandidate,
            directionInference: dirInf,
            llm: llmSummary
          })
        : null;

      if (this.enforceHighProbabilitySetups && highProbGate && !highProbGate.allowed) {
        if (!blockers.includes("low_probability")) {
          blockers.push("low_probability");
        }
        if (highProbGate.reason) {
          blockerReasons.push(highProbGate.reason);
          console.log(`[5m] High-probability gate blocked: ${highProbGate.reason}`);
        }
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
      const patternAllowsAllIn = ["PULLBACK_CONTINUATION", "BREAK_RETEST", "VALUE_RECLAIM"].includes(setupCandidate.pattern);
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

      const topPlay = {
        setup: setupCandidate.pattern,
        direction: setupCandidate.direction,
        entryZone: setupCandidate.entryZone,
        stop: setupCandidate.stop,
        probability: decision.llm?.probability ?? llmSummary?.probability,
        action: decision.llm?.action ?? llmSummary?.action
      };

      const riskAtr = atr
        ? Math.abs(((setupCandidate.entryZone.low + setupCandidate.entryZone.high) / 2) - setupCandidate.stop) / atr
        : undefined;
      const decisionSummary = {
        decisionId: decision.decisionId,
        status: decision.status,
        kind: "GATE" as const,
        allowed: decision.status === "ARMED",
        permission,
        direction: directionGate.allow ? directionGate.direction : "NONE",
        gateTier: directionGate.allow ? (directionGate.tier === "LEANING" ? "LEANING" : "OPEN") : "STRICT",
        blockers: decision.blockers,
        blockerReasons: decision.blockerReasons,
        rationale: [directionGate.reason].filter(Boolean),
        metrics: {
          score: setupCandidate.score.total,
          legitimacy: decision.llm?.legitimacy,
          followThrough: decision.llm?.followThroughProb,
          riskAtr
        }
      };

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
          marketState,
          timing: timingSnapshot,
          playState: "CANDIDATE",
          notArmedReason: blockerReasons.length ? blockerReasons.join(" | ") : undefined
        }));
      }

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
        playState: "CANDIDATE",
        notArmedReason: blockerReasons.length ? blockerReasons.join(" | ") : undefined
      }));

      if (decision.status !== "ARMED") {
        events.push(this.ev("NO_ENTRY", ts, {
          playId: decision.decisionId,
          symbol: setupCandidate.symbol,
          direction: setupCandidate.direction,
          price: close,
          decision: decisionSummary,
          marketState,
          timing: timingSnapshot,
          topPlay,
          blockerTags: blockers,
          blockerReasons,
          playState: "CANDIDATE",
          notArmedReason: blockerReasons.length ? blockerReasons.join(" | ") : undefined
        }));
      }

      if (decision.status === "ARMED" && decision.play) {
        if (directionGate.allow) {
          decision.play.tier = directionGate.tier;
          if (directionGate.tier === "LEANING") {
            decision.play.mode = "SCOUT";
          }
        }
        this.state.activePlay = decision.play;
        this.playsToday += 1;
        events.push(this.ev("PLAY_ARMED", ts, {
          play: decision.play,
          decision: decisionSummary,
          price: close,
          marketState,
          timing: timingSnapshot,
          topPlay,
          blockerTags: blockers,
          blockerReasons,
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
            playState: decision.status === "ARMED" ? "ARMED" : "CANDIDATE"
          }));
          this.lastSetupSummary5mTs = ts;
        }
      }

      return events;
    }

    const play = this.state.activePlay;

    // Branch: ARMED (not entered) vs ENTERED
    if (play.status !== "ENTERED") {
      // Path 1: ARMED_COACH - Pre-entry commentary
      return await this.handleArmedCoaching(snapshot, play, events);
    } else {
      // Path 2: LLM_COACH_UPDATE - Position management
      return await this.handleManageCoaching(snapshot, play, events);
    }
  }

  /**
   * Handle ARMED coaching (play exists but not entered)
   * Provides pre-entry commentary without pretending we're in a position
   */
  private async handleArmedCoaching(snapshot: TickSnapshot, play: Play, events: DomainEvent[]): Promise<DomainEvent[]> {
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
              mode: play.tier === "LEANING" ? "SCALP_ONLY" : "SWING_ALLOWED"
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

    const regimeForStops = this.lastRegime15m ?? computeRegime(bars5m, close);

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
      const playPermissionMode = play.mode === "SCOUT" ? "SCALP_ONLY" : "SWING_ALLOWED";
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
        
        const llmResponse = await this.llmService.getCoachingUpdate({
          symbol: play.symbol,
          direction: play.direction,
          entryPrice,
          currentPrice: close,
          stop: play.stop,
          targets: play.targets,
          timeInTrade,
          priceAction,
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
            t1Hit: play.t1Hit ?? false,
            stopAdjusted: play.stopAdjusted ?? false,
            exhaustionSignals
          }
        });

        const llmAction = llmResponse.action;
        const llmReasoning = llmResponse.reasoning;
        const llmUrgency = llmResponse.urgency;
        
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
        const playPermissionMode = play.mode === "SCOUT" ? "SCALP_ONLY" : "SWING_ALLOWED";
        events.push(this.ev("LLM_COACH_UPDATE", ts, {
          playId: play.id,
          symbol: play.symbol,
          direction: play.direction,
          price: close,
          action: llmAction,
          reasoning: llmReasoning,
          urgency: llmUrgency,
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

  private ev(type: DomainEvent["type"], timestamp: number, data: Record<string, any>): DomainEvent {
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
