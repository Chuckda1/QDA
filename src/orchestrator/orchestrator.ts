import type { BotState, DomainEvent, Play, TradeAction } from "../types.js";
import type { LLMService } from "../llm/llmService.js";
import { StopProfitRules } from "../rules/stopProfitRules.js";
import { EntryFilters, type EntryFilterContext } from "../rules/entryFilters.js";
import { getMarketSessionLabel, getETDateString } from "../utils/timeUtils.js";
import { inferDirectionFromRecentBars } from "../rules/directionRules.js";
import { computeRegime, regimeAllowsDirection } from "../rules/regimeRules.js";
import { computeATR, computeEMA, computeVWAP, computeRSI, type OHLCVBar } from "../utils/indicators.js";
import { SetupEngine, type SetupEngineResult } from "../rules/setupEngine.js";
import { detectStructureLLLH } from "../utils/structure.js";
import type { SetupCandidate } from "../types.js";
import type { DirectionInference } from "../rules/directionRules.js";
import type { RegimeResult } from "../rules/regimeRules.js";

type SetupDiagnosticsSnapshot = {
  ts: number;
  symbol: string;
  close: number;
  regime: RegimeResult;
  directionInference: DirectionInference;
  candidate?: SetupCandidate;
  setupReason?: string;
  setupDebug?: any;
  entryFilterWarnings?: string[];
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
  timeframe: "1m" | "5m";
};

export class Orchestrator {
  private state: BotState;
  private instanceId: string;
  private llmService?: LLMService;
  private stopProfitRules: StopProfitRules;
  private entryFilters: EntryFilters;
  private setupEngine: SetupEngine;
  private llmCoachCache: Map<string, number> = new Map(); // playId_barTs -> timestamp (for entered plays)
  private llmArmedCoachCache: Map<string, number> = new Map(); // playId_barTs -> timestamp (for armed plays)
  private recentBars: OHLCVBar[] = []; // For pullback detection and direction inference
  private lastDiagnostics: SetupDiagnosticsSnapshot | null = null;
  private lastSetupSummary5mTs: number | null = null;

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

  // Guardrail config (from env vars with defaults)
  private readonly maxPlaysPerETDay: number;
  private readonly cooldownAfterStopMin: number;
  private readonly cooldownAfterLLMPassMin: number;
  private readonly cooldownAfterPlayClosedMin: number;

  constructor(instanceId: string, llmService?: LLMService, initialState?: { activePlay?: Play | null }) {
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

    // Initialize ET day tracking
    this.currentETDay = getETDateString();

    this.state = {
      startedAt: Date.now(),
      session: getMarketSessionLabel(),
      activePlay: initialState?.activePlay ?? null,
      mode: "QUIET"
    };
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
    timeframe: "1m" | "5m" = "1m"
  ): Promise<DomainEvent[]> {
    const snapshot = this.buildSnapshot(input, timeframe);
    const events: DomainEvent[] = [];

    // Update state
    this.state.session = getMarketSessionLabel(new Date(input.ts));
    this.state.lastTickAt = input.ts;
    this.state.price = input.close;
    if (timeframe === "1m") {
      this.state.last1mTs = input.ts;
    } else {
      this.state.last5mTs = input.ts;
    }

    // Branch by timeframe
    if (timeframe === "1m") {
      events.push(...await this.handle1m(snapshot));
    } else {
      events.push(...await this.handle5m(snapshot));
    }

    return events;
  }

  private buildSnapshot(input: TickInput, timeframe: "1m" | "5m"): TickSnapshot {
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
        this.recentBars = []; // Reset history after gap
        this.dataGapCooldown = this.dataGapCooldownBars;
        this.lastBarTs = ts;
        
        // Set diagnostics for gap
        if (!this.state.activePlay) {
          this.lastDiagnostics = {
            ts,
            symbol,
            close,
            regime: computeRegime(this.recentBars, close),
            directionInference: inferDirectionFromRecentBars(this.recentBars),
            setupReason: `data gap: ${gapMinutes} min gap detected, resetting history`,
            datafeedIssue: `time gap: ${gapMinutes} minutes (${gapMs}ms)`,
          };
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
        this.recentBars.push({ ts, open: safeOpen, high: syntheticHigh, low: syntheticLow, close, volume: safeVol });
        this.lastBarTs = ts;
        if (this.dataGapCooldown > 0) this.dataGapCooldown--;
        // Keep enough history for ATR/RSI/EMA (direction + filters)
        if (this.recentBars.length > 80) this.recentBars.shift();
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
            regime: computeRegime(this.recentBars, close),
            directionInference: inferDirectionFromRecentBars(this.recentBars),
            setupReason: `insufficient OHLC: missing ${missing.join(", ")}`,
            datafeedIssue: `missing OHLC fields: ${missing.join(", ")}`,
          };
        }
        return events; // Skip this bar
      }
    } else {
      // Valid bar with high/low - process normally
      const safeOpen = open ?? close;
      const safeVol = volume ?? 0;
      this.recentBars.push({ ts, open: safeOpen, high, low, close, volume: safeVol });
      this.lastBarTs = ts;
      if (this.dataGapCooldown > 0) this.dataGapCooldown--;
      // Keep enough history for ATR/RSI/EMA (direction + filters)
      if (this.recentBars.length > 80) this.recentBars.shift();
    }

    // Skip processing during data gap cooldown
    if (this.dataGapCooldown > 0) {
      console.log(`[Datafeed] Data gap cooldown active: ${this.dataGapCooldown} bars remaining`);
      if (!this.state.activePlay) {
        this.lastDiagnostics = {
          ts,
          symbol,
          close,
          regime: computeRegime(this.recentBars, close),
          directionInference: inferDirectionFromRecentBars(this.recentBars),
          setupReason: `data gap cooldown: ${this.dataGapCooldown} bars remaining`,
          datafeedIssue: `cooldown after gap: ${this.dataGapCooldown} bars`,
        };
      }
      return events; // Skip processing during cooldown
    }

    // If no active play, use SetupEngine to find a pattern
    if (!this.state.activePlay) {
      const watchOnly = this.state.mode !== "ACTIVE";

      // Need at least some bar history
      if (this.recentBars.length < 6) {
        const regime = computeRegime(this.recentBars, close);
        this.lastDiagnostics = {
          ts,
          symbol,
          close,
          regime,
          directionInference: inferDirectionFromRecentBars(this.recentBars),
          setupReason: "insufficient bar history (< 6 bars)",
        };
        return events;
      }

      // Check guardrails before proceeding
      const guardrailCheck = this.checkGuardrails(ts);
      if (!guardrailCheck.allowed) {
        const regime = computeRegime(this.recentBars, close);
        this.lastDiagnostics = {
          ts,
          symbol,
          close,
          regime,
          directionInference: inferDirectionFromRecentBars(this.recentBars),
          guardrailBlock: guardrailCheck.reason,
          setupReason: `guardrail: ${guardrailCheck.reason}`,
          regimeEvidence: regime.bullScore !== undefined && regime.bearScore !== undefined ? {
            bullScore: regime.bullScore,
            bearScore: regime.bearScore,
          } : undefined,
        };
        console.log(`[1m] Guardrail block: ${guardrailCheck.reason}`);
        return events;
      }

      // Compute regime and structure
      const regime = computeRegime(this.recentBars, close);
      const structure = detectStructureLLLH(this.recentBars, { lookback: 22, pivotWidth: 2 });

      // Infer direction from recent 1m bars
      const dirInf = inferDirectionFromRecentBars(this.recentBars);
      if (!dirInf.direction) {
        // Don't hard-block setup detection; SetupEngine can still use regime/structure patterns.
        console.log(`[1m] Direction inference unclear (continuing): ${dirInf.reasons.join(" | ")}`);
      }

      // Compute indicators
      const atr = computeATR(this.recentBars, 14);
      const closes = this.recentBars.map((b) => b.close);
      const ema9 = computeEMA(closes.slice(-60), 9);
      const ema20 = computeEMA(closes.slice(-80), 20);
      const vwap = computeVWAP(this.recentBars, 30);
      const rsi14 = computeRSI(closes, 14);

      // Find setup using SetupEngine
      const setupResult = this.setupEngine.findSetup({
        ts,
        symbol,
        currentPrice: close,
        bars: this.recentBars,
        regime,
        directionInference: dirInf,
        indicators: { vwap, ema9, ema20, atr, rsi14 }
      });

      if (!setupResult.candidate) {
        this.lastDiagnostics = {
          ts,
          symbol,
          close,
          regime,
          directionInference: dirInf,
          setupReason: setupResult.reason || "no setup pattern found",
          setupDebug: setupResult.debug,
          regimeEvidence: regime.bullScore !== undefined && regime.bearScore !== undefined ? {
            bullScore: regime.bullScore,
            bearScore: regime.bearScore,
          } : undefined,
        };
        console.log(`[1m] No setup candidate: ${setupResult.reason || "unknown"}`);
        return events;
      }

      const setupCandidate = setupResult.candidate;

      // Regime-direction enforcement happens AFTER setup selection.
      // Trend setups must align with regime; reversal attempts are explicitly countertrend.
      if (setupCandidate.pattern !== "REVERSAL_ATTEMPT") {
        const regimeCheck = regimeAllowsDirection(regime.regime, setupCandidate.direction);

        const hasChopOverride = setupCandidate.flags?.includes("CHOP_OVERRIDE") ?? false;

        // Allow CHOP setups only when explicitly marked as override
        if (!regimeCheck.allowed && !(regime.regime === "CHOP" && hasChopOverride)) {
          this.lastDiagnostics = {
            ts,
            symbol,
            close,
            regime,
            directionInference: dirInf,
            candidate: setupCandidate,
            setupReason: `regime gate: ${regimeCheck.reason}`,
            regimeEvidence: regime.bullScore !== undefined && regime.bearScore !== undefined ? {
              bullScore: regime.bullScore,
              bearScore: regime.bearScore,
            } : undefined,
          };
          console.log(`[1m] No setup: ${regimeCheck.reason} | ${regime.reasons.join(" | ")}`);
          return events;
        }
      }

      // Run entry filters on the candidate
      const filterContext: EntryFilterContext = {
        timestamp: ts,
        symbol,
        direction: setupCandidate.direction,
        close,
        high,
        low,
        open,
        volume,
        indicators: {
          vwap,
          ema20,
          ema9,
          atr,
          rsi14
        },
        recentBars: this.recentBars.length >= 5
          ? this.recentBars.slice(-20).map((b) => ({ 
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
        console.log(`[1m] Entry filter warnings: ${filterResult.warnings.join(" | ")}`);
      }
      if (!filterResult.allowed) {
        this.lastDiagnostics = {
          ts,
          symbol,
          close,
          regime,
          directionInference: dirInf,
          candidate: setupCandidate,
          setupReason: `entry filter: ${filterResult.reason}`,
          entryFilterWarnings: filterResult.warnings,
          setupDebug: setupResult.debug,
          regimeEvidence: regime.bullScore !== undefined && regime.bearScore !== undefined ? {
            bullScore: regime.bullScore,
            bearScore: regime.bearScore,
          } : undefined,
        };
        console.log(`[1m] Entry blocked by filter: ${filterResult.reason}`);
        return events;
      }

      // Update diagnostics with successful candidate
      this.lastDiagnostics = {
        ts,
        symbol,
        close,
        regime,
        directionInference: dirInf,
        candidate: setupCandidate,
        entryFilterWarnings: filterResult.warnings,
        setupDebug: setupResult.debug,
        regimeEvidence: regime.bullScore !== undefined && regime.bearScore !== undefined ? {
          bullScore: regime.bullScore,
          bearScore: regime.bearScore,
        } : undefined,
      };

      // WATCH-ONLY mode: track setups/diagnostics but never arm a play or call the LLM.
      if (watchOnly) {
        return events;
      }

      // Prepare warnings for LLM
      const dirWarning = `Direction inference: ${dirInf.direction ?? "N/A"} (confidence=${dirInf.confidence}) | ${dirInf.reasons.join(" | ")}`;
      const regimeWarning = `Regime gate: ${regime.regime} | ${regime.reasons.join(" | ")}`;
      const llmWarnings = [
        ...(filterResult.warnings ?? []),
        dirWarning,
        regimeWarning
      ];

      // Prepare data for LLM scorecard
      const recentBarsForLLM = this.recentBars.slice(-20).map((b) => ({
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
        vwapSlope: regime.vwapSlope,
        structure: regime.structure
      };

      const ruleScores = {
        regime: regime.regime,
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

      // Call LLM BEFORE arming a play
      if (this.llmService) {
        try {
          console.log(`[1m] Calling LLM for setup validation: ${setupCandidate.id}`);
          this.state.lastLLMCallAt = Date.now();

          // Add timeout wrapper
          const llmVerifyPromise = this.llmService.verifyPlaySetup({
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

          // Create timeout promise
          const timeoutPromise = new Promise<Awaited<typeof llmVerifyPromise>>((_, reject) => {
            setTimeout(() => reject(new Error(`LLM timeout after ${this.llmTimeoutMs}ms`)), this.llmTimeoutMs);
          });

          let llmVerify: Awaited<typeof llmVerifyPromise>;
          let llmTimedOut = false;
          try {
            llmVerify = await Promise.race([llmVerifyPromise, timeoutPromise]);
          } catch (error: any) {
            if (error.message?.includes("timeout")) {
              llmTimedOut = true;
              console.log(`[1m] LLM timeout after ${this.llmTimeoutMs}ms - treating as PASS (safe)`);
              
              // Check if we should allow rules-only mode for A-grade setups
              if (this.allowRulesOnlyWhenLLMDown && setupCandidate.score.total >= this.rulesOnlyMinScore) {
                console.log(`[1m] LLM down but setup is A-grade (score=${setupCandidate.score.total} >= ${this.rulesOnlyMinScore}) - allowing rules-only`);
                // Create a synthetic LLM response that allows the trade
                llmVerify = {
                  biasDirection: setupCandidate.direction as "LONG" | "SHORT",
                  agreement: 75,
                  legitimacy: 70,
                  probability: 60,
                  action: "SCALP" as const, // Conservative action for rules-only
                  reasoning: `LLM timeout - rules-only mode: A-grade setup (score=${setupCandidate.score.total})`,
                  plan: "Rules-only trade due to LLM timeout",
                  flags: ["LLM_TIMEOUT", "RULES_ONLY"],
                  followThroughProb: 60,
                };
              } else {
                // Timeout = PASS (safe default)
                this.lastDiagnostics = {
                  ts,
                  symbol,
                  close,
                  regime,
                  directionInference: dirInf,
                  candidate: setupCandidate,
                  setupReason: `LLM timeout: ${this.llmTimeoutMs}ms exceeded (treated as PASS)`,
                  entryFilterWarnings: filterResult.warnings,
                  setupDebug: setupResult.debug,
                  regimeEvidence: regime.bullScore !== undefined && regime.bearScore !== undefined ? {
                    bullScore: regime.bullScore,
                    bearScore: regime.bearScore,
                  } : undefined,
                };
                this.cooldownAfterLLMPass = Date.now();
                return events;
              }
            } else {
              // Other error - rethrow
              throw error;
            }
          }

          this.state.lastLLMDecision = `VERIFY:${llmVerify.action}${llmTimedOut ? " (timeout)" : ""}`;

          // Always emit LLM_VERIFY + SCORECARD
          events.push(this.ev("LLM_VERIFY", ts, {
            playId: setupCandidate.id,
            symbol: setupCandidate.symbol,
            direction: setupCandidate.direction,
            legitimacy: llmVerify.legitimacy,
            followThroughProb: llmVerify.followThroughProb,
            action: llmVerify.action,
            reasoning: llmVerify.reasoning
          }));

          events.push(this.ev("SCORECARD", ts, {
            playId: setupCandidate.id,
            symbol: setupCandidate.symbol,
            proposedDirection: setupCandidate.direction,
            setup: {
              pattern: setupCandidate.pattern,
              triggerPrice: setupCandidate.triggerPrice,
              stop: setupCandidate.stop
            },
            rules: {
              regime: {
                regime: regime.regime,
                structure: regime.structure,
                vwapSlope: regime.vwapSlope,
                reasons: regime.reasons
              },
              directionInference: {
                direction: dirInf.direction,
                confidence: dirInf.confidence,
                reasons: dirInf.reasons
              },
              indicators: indicatorSnapshot,
              ruleScores
            },
            llm: {
              biasDirection: llmVerify.biasDirection,
              agreement: llmVerify.agreement,
              legitimacy: llmVerify.legitimacy,
              probability: llmVerify.probability,
            action: llmVerify.action,
              reasoning: llmVerify.reasoning,
              flags: llmVerify.flags ?? []
            }
          }));

          // If LLM says PASS, don't arm the play and set cooldown
          if (llmVerify.action === "PASS") {
            this.lastDiagnostics = {
              ts,
              symbol,
              close,
              regime,
              directionInference: dirInf,
              candidate: setupCandidate,
              setupReason: `LLM PASS: ${llmVerify.reasoning}`,
              entryFilterWarnings: filterResult.warnings,
              setupDebug: setupResult.debug,
              regimeEvidence: regime.bullScore !== undefined && regime.bearScore !== undefined ? {
                bullScore: regime.bullScore,
                bearScore: regime.bearScore,
              } : undefined,
            };
            console.log(`[1m] LLM rejected setup: ${llmVerify.reasoning}`);
            this.cooldownAfterLLMPass = Date.now();
            return events;
          }

          // Continue to play creation (below)
        } catch (error: any) {
          this.lastDiagnostics = {
            ts,
            symbol,
            close,
            regime,
            directionInference: dirInf,
            candidate: setupCandidate,
            setupReason: `LLM error: ${error.message}`,
            entryFilterWarnings: filterResult.warnings,
            setupDebug: setupResult.debug,
            regimeEvidence: regime.bullScore !== undefined && regime.bearScore !== undefined ? {
              bullScore: regime.bullScore,
              bearScore: regime.bearScore,
            } : undefined,
          };
          console.error(`[1m] LLM verification failed:`, error.message);
          // On error, don't arm the play (safety first)
          return events;
        }
      } else {
        // No LLM service - check if rules-only mode is allowed
        if (this.allowRulesOnlyWhenLLMDown && setupCandidate.score.total >= this.rulesOnlyMinScore) {
          console.log(`[1m] No LLM service but setup is A-grade (score=${setupCandidate.score.total} >= ${this.rulesOnlyMinScore}) - allowing rules-only`);
          
          // Create synthetic LLM response for rules-only mode
          const llmVerify = {
            biasDirection: setupCandidate.direction as "LONG" | "SHORT",
            agreement: 75,
            legitimacy: 70,
            probability: 60,
            action: "SCALP" as const, // Conservative action for rules-only
            reasoning: `No LLM service - rules-only mode: A-grade setup (score=${setupCandidate.score.total})`,
            plan: "Rules-only trade due to LLM service unavailable",
            flags: ["NO_LLM_SERVICE", "RULES_ONLY"],
            followThroughProb: 60,
          };

          this.state.lastLLMDecision = `VERIFY:${llmVerify.action} (rules-only)`;

          // Emit events
          events.push(this.ev("LLM_VERIFY", ts, {
            playId: setupCandidate.id,
            symbol: setupCandidate.symbol,
            direction: setupCandidate.direction,
            legitimacy: llmVerify.legitimacy,
            followThroughProb: llmVerify.followThroughProb,
            action: llmVerify.action,
            reasoning: llmVerify.reasoning
          }));

          events.push(this.ev("SCORECARD", ts, {
            playId: setupCandidate.id,
            symbol: setupCandidate.symbol,
            proposedDirection: setupCandidate.direction,
            setup: {
              pattern: setupCandidate.pattern,
              triggerPrice: setupCandidate.triggerPrice,
              stop: setupCandidate.stop
            },
            rules: {
              regime: {
                regime: regime.regime,
                structure: regime.structure,
                vwapSlope: regime.vwapSlope,
                reasons: regime.reasons
              },
              directionInference: {
                direction: dirInf.direction,
                confidence: dirInf.confidence,
                reasons: dirInf.reasons
              },
              indicators: indicatorSnapshot,
              ruleScores
            },
            llm: {
              biasDirection: llmVerify.biasDirection,
              agreement: llmVerify.agreement,
              legitimacy: llmVerify.legitimacy,
              probability: llmVerify.probability,
              action: llmVerify.action,
              reasoning: llmVerify.reasoning,
              flags: llmVerify.flags ?? []
            }
          }));
        } else {
          // No LLM service and rules-only not allowed or setup not A-grade
          this.lastDiagnostics = {
            ts,
            symbol,
            close,
            regime,
            directionInference: dirInf,
            candidate: setupCandidate,
            setupReason: `no LLM service - setup requires LLM approval${this.allowRulesOnlyWhenLLMDown ? ` (or A-grade score >= ${this.rulesOnlyMinScore})` : ""}`,
            entryFilterWarnings: filterResult.warnings,
            setupDebug: setupResult.debug,
            regimeEvidence: regime.bullScore !== undefined && regime.bearScore !== undefined ? {
              bullScore: regime.bullScore,
              bearScore: regime.bearScore,
            } : undefined,
          };
          console.log(`[1m] No LLM service - setup found but requires LLM approval`);
          return events;
        }
      }

      // Declare llmVerify outside the if/else so it's accessible for play creation
      type LLMVerifyType = Awaited<ReturnType<NonNullable<typeof this.llmService>["verifyPlaySetup"]>>;
      let llmVerify: LLMVerifyType | undefined;

      // Call LLM BEFORE arming a play
      if (this.llmService) {
        try {
          console.log(`[1m] Calling LLM for setup validation: ${setupCandidate.id}`);
          this.state.lastLLMCallAt = Date.now();

          // Add timeout wrapper
          const llmVerifyPromise = this.llmService.verifyPlaySetup({
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

          // Create timeout promise
          const timeoutPromise = new Promise<Awaited<typeof llmVerifyPromise>>((_, reject) => {
            setTimeout(() => reject(new Error(`LLM timeout after ${this.llmTimeoutMs}ms`)), this.llmTimeoutMs);
          });

          let llmTimedOut = false;
          try {
            llmVerify = await Promise.race([llmVerifyPromise, timeoutPromise]);
          } catch (error: any) {
            if (error.message?.includes("timeout")) {
              llmTimedOut = true;
              console.log(`[1m] LLM timeout after ${this.llmTimeoutMs}ms - treating as PASS (safe)`);
              
              // Check if we should allow rules-only mode for A-grade setups
              if (this.allowRulesOnlyWhenLLMDown && setupCandidate.score.total >= this.rulesOnlyMinScore) {
                console.log(`[1m] LLM down but setup is A-grade (score=${setupCandidate.score.total} >= ${this.rulesOnlyMinScore}) - allowing rules-only`);
                // Create a synthetic LLM response that allows the trade
                llmVerify = {
                  biasDirection: setupCandidate.direction as "LONG" | "SHORT",
                  agreement: 75,
                  legitimacy: 70,
                  probability: 60,
                  action: "SCALP" as const, // Conservative action for rules-only
                  reasoning: `LLM timeout - rules-only mode: A-grade setup (score=${setupCandidate.score.total})`,
                  plan: "Rules-only trade due to LLM timeout",
                  flags: ["LLM_TIMEOUT", "RULES_ONLY"],
                  followThroughProb: 60,
                };
      } else {
                // Timeout = PASS (safe default)
                this.lastDiagnostics = {
                  ts,
                  symbol,
                  close,
                  regime,
                  directionInference: dirInf,
                  candidate: setupCandidate,
                  setupReason: `LLM timeout: ${this.llmTimeoutMs}ms exceeded (treated as PASS)`,
                  entryFilterWarnings: filterResult.warnings,
                  setupDebug: setupResult.debug,
                  regimeEvidence: regime.bullScore !== undefined && regime.bearScore !== undefined ? {
                    bullScore: regime.bullScore,
                    bearScore: regime.bearScore,
                  } : undefined,
                };
                this.cooldownAfterLLMPass = Date.now();
                return events;
              }
            } else {
              // Other error - rethrow
              throw error;
            }
          }

          this.state.lastLLMDecision = `VERIFY:${llmVerify.action}${llmTimedOut ? " (timeout)" : ""}`;

          // Always emit LLM_VERIFY + SCORECARD
        events.push(this.ev("LLM_VERIFY", ts, {
            playId: setupCandidate.id,
            symbol: setupCandidate.symbol,
            direction: setupCandidate.direction,
            legitimacy: llmVerify.legitimacy,
            followThroughProb: llmVerify.followThroughProb,
            action: llmVerify.action,
            reasoning: llmVerify.reasoning
          }));

          events.push(this.ev("SCORECARD", ts, {
            playId: setupCandidate.id,
            symbol: setupCandidate.symbol,
            proposedDirection: setupCandidate.direction,
            setup: {
              pattern: setupCandidate.pattern,
              triggerPrice: setupCandidate.triggerPrice,
              stop: setupCandidate.stop
            },
            rules: {
              regime: {
                regime: regime.regime,
                structure: regime.structure,
                vwapSlope: regime.vwapSlope,
                reasons: regime.reasons
              },
              directionInference: {
                direction: dirInf.direction,
                confidence: dirInf.confidence,
                reasons: dirInf.reasons
              },
              indicators: indicatorSnapshot,
              ruleScores
            },
            llm: {
              biasDirection: llmVerify.biasDirection,
              agreement: llmVerify.agreement,
              legitimacy: llmVerify.legitimacy,
              probability: llmVerify.probability,
              action: llmVerify.action,
              reasoning: llmVerify.reasoning,
              flags: llmVerify.flags ?? []
            }
          }));

          // If LLM says PASS, don't arm the play and set cooldown
          if (llmVerify.action === "PASS") {
            this.lastDiagnostics = {
              ts,
              symbol,
              close,
              regime,
              directionInference: dirInf,
              candidate: setupCandidate,
              setupReason: `LLM PASS: ${llmVerify.reasoning}`,
              entryFilterWarnings: filterResult.warnings,
              setupDebug: setupResult.debug,
              regimeEvidence: regime.bullScore !== undefined && regime.bearScore !== undefined ? {
                bullScore: regime.bullScore,
                bearScore: regime.bearScore,
              } : undefined,
            };
            console.log(`[1m] LLM rejected setup: ${llmVerify.reasoning}`);
            this.cooldownAfterLLMPass = Date.now();
            return events;
          }
        } catch (error: any) {
          this.lastDiagnostics = {
            ts,
            symbol,
            close,
            regime,
            directionInference: dirInf,
            candidate: setupCandidate,
            setupReason: `LLM error: ${error.message}`,
            entryFilterWarnings: filterResult.warnings,
            setupDebug: setupResult.debug,
            regimeEvidence: regime.bullScore !== undefined && regime.bearScore !== undefined ? {
              bullScore: regime.bullScore,
              bearScore: regime.bearScore,
            } : undefined,
          };
          console.error(`[1m] LLM verification failed:`, error.message);
          // On error, don't arm the play (safety first)
          return events;
        }
      } else {
        // No LLM service - check if rules-only mode is allowed
        if (this.allowRulesOnlyWhenLLMDown && setupCandidate.score.total >= this.rulesOnlyMinScore) {
          console.log(`[1m] No LLM service but setup is A-grade (score=${setupCandidate.score.total} >= ${this.rulesOnlyMinScore}) - allowing rules-only`);
          
          // Create synthetic LLM response for rules-only mode
          llmVerify = {
              biasDirection: setupCandidate.direction as "LONG" | "SHORT",
              agreement: 75,
              legitimacy: 70,
              probability: 60,
              action: "SCALP" as const, // Conservative action for rules-only
              reasoning: `No LLM service - rules-only mode: A-grade setup (score=${setupCandidate.score.total})`,
              plan: "Rules-only trade due to LLM service unavailable",
              flags: ["NO_LLM_SERVICE", "RULES_ONLY"],
              followThroughProb: 60,
            };

            this.state.lastLLMDecision = `VERIFY:${llmVerify.action} (rules-only)`;

            // Emit events and continue with play creation (same flow as normal LLM response)
            events.push(this.ev("LLM_VERIFY", ts, {
              playId: setupCandidate.id,
              symbol: setupCandidate.symbol,
              direction: setupCandidate.direction,
              legitimacy: llmVerify.legitimacy,
              followThroughProb: llmVerify.followThroughProb,
              action: llmVerify.action,
              reasoning: llmVerify.reasoning
            }));

          events.push(this.ev("SCORECARD", ts, {
            playId: setupCandidate.id,
            symbol: setupCandidate.symbol,
            proposedDirection: setupCandidate.direction,
            setup: {
              pattern: setupCandidate.pattern,
              triggerPrice: setupCandidate.triggerPrice,
              stop: setupCandidate.stop
            },
            rules: {
              regime: {
                regime: regime.regime,
                structure: regime.structure,
                vwapSlope: regime.vwapSlope,
                reasons: regime.reasons
              },
              directionInference: {
                direction: dirInf.direction,
                confidence: dirInf.confidence,
                reasons: dirInf.reasons
              },
              indicators: indicatorSnapshot,
              ruleScores
            },
            llm: {
              biasDirection: llmVerify.biasDirection,
              agreement: llmVerify.agreement,
              legitimacy: llmVerify.legitimacy,
              probability: llmVerify.probability,
              action: llmVerify.action,
              reasoning: llmVerify.reasoning,
              flags: llmVerify.flags ?? []
            }
          }));
        } else {
            // No LLM service and rules-only not allowed or setup not A-grade
            this.lastDiagnostics = {
              ts,
              symbol,
              close,
              regime,
              directionInference: dirInf,
              candidate: setupCandidate,
              setupReason: `no LLM service - setup requires LLM approval${this.allowRulesOnlyWhenLLMDown ? ` (or A-grade score >= ${this.rulesOnlyMinScore})` : ""}`,
              entryFilterWarnings: filterResult.warnings,
              setupDebug: setupResult.debug,
              regimeEvidence: regime.bullScore !== undefined && regime.bearScore !== undefined ? {
                bullScore: regime.bullScore,
                bearScore: regime.bearScore,
              } : undefined,
            };
            console.log(`[1m] No LLM service - setup found but requires LLM approval`);
            return events;
          }
        }

      return events;
    }

    const play = this.state.activePlay!;

    // Entry eligible tracking (assume entry when price touches zone)
    const inZone = close >= play.entryZone.low && close <= play.entryZone.high;
    if (inZone && !play.entered && !play.inEntryZone) {
      play.inEntryZone = true;
      // Assume entry when price is in zone (or you can require manual confirmation)
      play.entered = true;
      play.entryPrice = close;
      play.entryTimestamp = ts;
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
      // Set cooldown after stop
      this.cooldownAfterStop = Date.now();
      console.log(`[Guardrails] Stop hit, cooldown set for ${this.cooldownAfterStopMin} minutes`);
      // Set cooldown after play closed
      this.cooldownAfterPlayClosed = Date.now();
      // INVARIANT: PLAY_CLOSED must have matching active play (verified - we have play)
      events.push(this.ev("PLAY_CLOSED", ts, {
        playId: play.id,
        symbol: play.symbol,
        direction: play.direction,
        close,
        stop: play.stop,
        reason: "Stop loss hit on close (hard rule)",
        result: "LOSS",
        exitType: "STOP_HIT",
        llmAction: "N/A" // Hard stop, LLM not consulted
      }));
      this.state.activePlay = null;
      return events;
    }

    return events;
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
    const entered = this.state.activePlay?.entered || false;
    console.log(`[5m] barClose ts=${ts} o=${open?.toFixed(2) || "N/A"} h=${high?.toFixed(2) || "N/A"} l=${low?.toFixed(2) || "N/A"} c=${close.toFixed(2)} v=${volume || "N/A"} play=${playId} entered=${entered}`);

    // Gate 1 - If no active play → check for SETUP_SUMMARY
    if (!this.state.activePlay) {
      // Emit SETUP_SUMMARY on 5m close when there's no play (and candidate is strong)
      if (this.state.mode === "ACTIVE" && this.lastDiagnostics?.candidate && this.lastSetupSummary5mTs !== ts) {
        const c = this.lastDiagnostics.candidate;
        if ((c.score?.total ?? 0) >= 65) {
          events.push(this.ev("SETUP_SUMMARY", ts, {
            symbol: c.symbol,
            candidate: c,
            notes: `regime=${this.lastDiagnostics.regime.regime} dir=${this.lastDiagnostics.directionInference.direction ?? "N/A"}`,
          }));
          this.lastSetupSummary5mTs = ts;
        }
      }
      console.log(`[5m] coaching skipped (no play)`);
      return events;
    }

    const play = this.state.activePlay;

    // Branch: ARMED (not entered) vs ENTERED
    if (!play.entered) {
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
          urgency: armedResponse.urgency
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
            profitPercent: rulesContext.profitPercent
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
        events.push(this.ev("LLM_COACH_UPDATE", ts, {
          playId: play.id,
          symbol: play.symbol,
          direction: play.direction,
          price: close,
          action: llmAction,
          reasoning: llmReasoning,
          urgency: llmUrgency,
          update: llmReasoning,
          rulesContext // Include rules context in event
        }));
        
        // LLM decision is FINAL - if LLM says exit, we exit
        if (llmAction === "STOP_OUT" || llmAction === "TAKE_PROFIT") {
          play.stopHit = true;
          
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
            llmReasoning
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
}
