import { randomUUID } from "crypto";
import { getMarketRegime, getMarketSessionLabel, getETDateString } from "../utils/timeUtils.js";
import { extractSwings, lastSwings } from "../utils/swing.js";
import type {
  BotMode,
  BotState,
  DailyContextLite,
  DomainEvent,
  EntryType,
  ExpectedResolution,
  Forming5mBar,
  MarketBias,
  MinimalDebugInfo,
  MinimalExecutionPhase,
  MinimalExecutionState,
  MinimalLLMSnapshot,
  MinimalSetupCandidate,
  NoTradeDiagnostic,
  NoTradeReasonCode,
  OpportunityLatch,
  OpportunitySide,
  OpportunityStatus,
  OpportunityTriggerType,
  RawBar,
  ResolutionGate,
  SetupType,
} from "../types.js";
import type { LLMService } from "../llm/llmService.js";

type TickInput = {
  ts: number;
  symbol: string;
  close: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
};

type TickSnapshot = TickInput & { timeframe: "5m" | "1m" };

export class Orchestrator {
  private instanceId: string;
  private orchId: string;
  private llmService?: LLMService;
  private state: BotState;
  private recentBars5m: Array<{
    ts: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }> = [];
  private forming5mBar: Forming5mBar | null = null;
  private formingBucketStart: number | null = null;
  private readonly minimalLlmBars: number;
  private lastDiagnosticPrice: number | null = null; // Track price for diagnostic emission
  private lastProcessedTs: number | null = null; // Track last processed timestamp for out-of-order detection
  private lastHeartbeatTs: number | null = null; // Track last heartbeat emission timestamp
  private lastMessageTs: number | null = null; // Track last message emission timestamp (for silent mode detection)
  private llmCircuitBreaker: {
    failures: number;
    lastFailureTs: number | null;
    isOpen: boolean;
  } = { failures: 0, lastFailureTs: null, isOpen: false };
  // Daily context tracking
  private currentETDate: string = ""; // Track current ET date string (YYYY-MM-DD)
  private prevDayClose?: number; // Previous day's close
  private prevDayHigh?: number; // Previous day's high
  private prevDayLow?: number; // Previous day's low
  private overnightHigh?: number; // Overnight/pre-market high
  private overnightLow?: number; // Overnight/pre-market low
  private prevSessionVWAP?: number; // Previous session VWAP

  // BiasFlipEntry constants
  private readonly BIAS_FLIP_MIN_CONF = 60;
  private readonly BIAS_FLIP_TTL_MS = 12 * 60 * 1000;       // 12 minutes
  private readonly BIAS_FLIP_COOLDOWN_MS = 10 * 60 * 1000;  // 10 minutes
  private readonly BIAS_FLIP_MIN_RANGE_ATR = 0.20;          // avoid micro candles

  constructor(instanceId: string, llmService?: LLMService) {
    this.instanceId = instanceId;
    this.orchId = randomUUID();
    this.llmService = llmService;
    this.minimalLlmBars = parseInt(process.env.MINIMAL_LLM_BARS || "5", 10);
    this.state = {
      startedAt: Date.now(),
      session: getMarketSessionLabel(),
      mode: "QUIET",
      minimalExecution: {
        bias: "NEUTRAL",
        phase: "NEUTRAL_PHASE",
        waitReason: "waiting_for_bias",
        thesisDirection: "none", // Legacy compatibility
      },
    };
    console.log(
      `[MINIMAL] orchestrator_init id=${this.orchId} instance=${this.instanceId} minimalLlmBars=${this.minimalLlmBars}`
    );
  }

  setMode(mode: BotMode): void {
    this.state.mode = mode;
  }

  getState(): BotState {
    return this.state;
  }

  async processTick(input: TickInput, timeframe: "5m" | "1m" = "5m"): Promise<DomainEvent[]> {
    const snapshot: TickSnapshot = { ...input, timeframe };
    this.state.session = getMarketSessionLabel(new Date(input.ts));
    this.state.lastTickTs = input.ts;
    this.state.price = input.close;

    if (timeframe === "1m") {
      return await this.handleMinimal1m(snapshot);
    }

    return this.handleMinimal5m(snapshot);
  }

  private updateForming5mBar(snapshot: TickSnapshot): Forming5mBar | null {
    const bucketMs = 5 * 60 * 1000;
    const startTs = Math.floor(snapshot.ts / bucketMs) * bucketMs;
    const endTs = startTs + bucketMs;
    const progressMinutes = Math.min(5, Math.max(1, Math.floor((snapshot.ts - startTs) / 60000) + 1));
    const closeVal = snapshot.close;
    if (!Number.isFinite(closeVal)) return null;

    // Debug: log bucket math and timestamp progression
    const prevTs = this.forming5mBar?.endTs ?? null;
    console.log(
      `[BUCKET_DEBUG] ts=${snapshot.ts} startTs=${startTs} endTs=${endTs} formingBucketStart=${this.formingBucketStart ?? "null"} prevTs=${prevTs ?? "null"} tsDelta=${prevTs !== null ? snapshot.ts - prevTs : "n/a"}`
    );

    // Handle bucket rollover: start new bucket (BarAggregator handles closed bar push)
    if (this.formingBucketStart !== null && startTs !== this.formingBucketStart) {
      if (this.forming5mBar) {
        // Log rollover but don't push - BarAggregator handles that
        console.log(
          `[MINIMAL][ROLLOVER] oldStart=${this.formingBucketStart} newStart=${startTs} formingBar o=${this.forming5mBar.open} h=${this.forming5mBar.high} l=${this.forming5mBar.low} c=${this.forming5mBar.close} v=${this.forming5mBar.volume}`
        );
      }
      // Start new bucket with first tick's open
      this.formingBucketStart = startTs;
      this.forming5mBar = {
        startTs,
        endTs,
        progressMinutes,
        open: snapshot.open ?? closeVal,
        high: snapshot.high ?? closeVal,
        low: snapshot.low ?? closeVal,
        close: closeVal,
        volume: snapshot.volume ?? 0,
      };
      return this.forming5mBar;
    }

    // Same bucket: accumulate high/low/close/volume, keep first open
    if (this.forming5mBar && this.formingBucketStart === startTs) {
      this.forming5mBar.high = Math.max(this.forming5mBar.high, snapshot.high ?? closeVal);
      this.forming5mBar.low = Math.min(this.forming5mBar.low, snapshot.low ?? closeVal);
      this.forming5mBar.close = closeVal;
      this.forming5mBar.volume += snapshot.volume ?? 0;
      this.forming5mBar.progressMinutes = progressMinutes;
      return this.forming5mBar;
    }

    // First bucket initialization
    this.formingBucketStart = startTs;
    this.forming5mBar = {
      startTs,
      endTs,
      progressMinutes,
      open: snapshot.open ?? closeVal,
      high: snapshot.high ?? closeVal,
      low: snapshot.low ?? closeVal,
      close: closeVal,
      volume: snapshot.volume ?? 0,
    };
    return this.forming5mBar;
  }

  private buildMinimalSetupCandidates(params: {
    closed5mBars: RawBar[];
    activeDirection?: "long" | "short" | "none";
  }): MinimalSetupCandidate[] {
    const { closed5mBars, activeDirection } = params;
    console.log(
      `[CANDIDATE_BUILD] barsCount=${closed5mBars.length} activeDir=${activeDirection ?? "none"}`
    );
    const lastClosed = closed5mBars[closed5mBars.length - 1];
    if (!lastClosed) {
      console.log(`[CANDIDATE_BUILD] FAIL: no lastClosed bar`);
      return [];
    }

    const priceRef = lastClosed.close;
    const buffer = Math.max(0.2, priceRef * 0.0003);
    
    // Initialize with FALLBACK defaults (will be overwritten if SWING mode succeeds)
    const rollingHigh = Math.max(...closed5mBars.map((b) => b.high));
    const rollingLow = Math.min(...closed5mBars.map((b) => b.low));
    let longInvalidation: number = rollingLow - buffer;
    let shortInvalidation: number = rollingHigh + buffer;
    let referenceLevels: { lastSwingHigh?: number; lastSwingLow?: number } = {
      lastSwingHigh: rollingHigh,
      lastSwingLow: rollingLow,
    };
    let mode: "SWING" | "FALLBACK" = "FALLBACK";

    // MODE 1: SWING mode (preferred) - requires 5+ bars and valid swings
    const minBarsForSwings = 2 * 2 + 1; // 5 bars minimum for lookback=2
    if (closed5mBars.length >= minBarsForSwings) {
      const swings = extractSwings(closed5mBars, 2, false);
      console.log(
        `[CANDIDATE_BUILD] swingsCount=${swings.length} barsChecked=${closed5mBars.length - 4} (bars ${2} to ${closed5mBars.length - 3})`
      );
      
      const { lastHigh, lastLow } = lastSwings(swings);
      const lastSwingHigh = lastHigh?.price;
      const lastSwingLow = lastLow?.price;

      if (Number.isFinite(lastSwingLow) && Number.isFinite(lastSwingHigh)) {
        // SWING mode: use swing-based invalidation
        mode = "SWING";
        longInvalidation = (lastSwingLow as number) - buffer;
        shortInvalidation = (lastSwingHigh as number) + buffer;
        referenceLevels = {
          lastSwingHigh: lastSwingHigh as number,
          lastSwingLow: lastSwingLow as number,
        };
        console.log(
          `[CANDIDATE_BUILD] Using SWING mode: lastHigh=${lastSwingHigh.toFixed(2)} lastLow=${lastSwingLow.toFixed(2)}`
        );
      } else {
        console.log(
          `[CANDIDATE_BUILD] Swings not detected, using FALLBACK mode. lastHigh=${lastSwingHigh ?? "null"} lastLow=${lastSwingLow ?? "null"}`
        );
      }
    } else {
      console.log(
        `[CANDIDATE_BUILD] Insufficient bars for swings (have ${closed5mBars.length}, need ${minBarsForSwings}), using FALLBACK mode`
      );
    }

    // Log FALLBACK mode if used
    if (mode === "FALLBACK") {
      console.log(
        `[CANDIDATE_BUILD] Using FALLBACK mode: rollingHigh=${rollingHigh.toFixed(2)} rollingLow=${rollingLow.toFixed(2)}`
      );
    }

    // Log invalidation debug for active direction
    if (activeDirection === "long") {
      const longDist = Math.abs(priceRef - longInvalidation);
      const longPct = priceRef ? (longDist / priceRef) * 100 : 0;
      console.log(
        `[INV_DEBUG] dir=LONG inv=${longInvalidation.toFixed(2)} ref=${mode === "SWING" ? "thesisSwingLow" : "rollingLow"} price=${priceRef.toFixed(2)} dist=${longDist.toFixed(2)} (${longPct.toFixed(3)}%) buffer=${buffer.toFixed(2)} mode=${mode}`
      );
    }
    if (activeDirection === "short") {
      const shortDist = Math.abs(priceRef - shortInvalidation);
      const shortPct = priceRef ? (shortDist / priceRef) * 100 : 0;
      console.log(
        `[INV_DEBUG] dir=SHORT inv=${shortInvalidation.toFixed(2)} ref=${mode === "SWING" ? "thesisSwingHigh" : "rollingHigh"} price=${priceRef.toFixed(2)} dist=${shortDist.toFixed(2)} (${shortPct.toFixed(3)}%) buffer=${buffer.toFixed(2)} mode=${mode}`
      );
    }

    const baseId = lastClosed.ts;
    const builtCandidates: MinimalSetupCandidate[] = [
      {
        id: `MIN_LONG_${baseId}`,
        direction: "LONG" as const,
        entryTrigger: "Enter on break above pullback high after a pullback down.",
        invalidationLevel: longInvalidation,
        pullbackRule: "Pullback = last closed 5m bar closes down or makes a lower low.",
        referenceLevels,
        rationale: mode === "SWING" 
          ? "Recent pullback provides a defined trigger and invalidation."
          : "Rolling low provides invalidation anchor until swings form.",
      },
      {
        id: `MIN_SHORT_${baseId}`,
        direction: "SHORT" as const,
        entryTrigger: "Enter on break below pullback low after a pullback up.",
        invalidationLevel: shortInvalidation,
        pullbackRule: "Pullback = last closed 5m bar closes up or makes a higher high.",
        referenceLevels,
        rationale: mode === "SWING"
          ? "Recent pullback provides a defined trigger and invalidation."
          : "Rolling high provides invalidation anchor until swings form.",
      },
    ];
    console.log(
      `[CANDIDATE_BUILD] SUCCESS: built ${builtCandidates.length} candidates mode=${mode} LONG_inv=${longInvalidation.toFixed(2)} SHORT_inv=${shortInvalidation.toFixed(2)}`
    );
    return builtCandidates;
  }

  // Calculate simple ATR approximation from recent bars
  private calculateATR(bars: Array<{ high: number; low: number; close: number }>, period: number = 14): number {
    if (bars.length < 2) return 0;
    const recentBars = bars.slice(-period);
    let sum = 0;
    for (let i = 1; i < recentBars.length; i++) {
      const tr = Math.max(
        recentBars[i].high - recentBars[i].low,
        Math.abs(recentBars[i].high - recentBars[i - 1].close),
        Math.abs(recentBars[i].low - recentBars[i - 1].close)
      );
      sum += tr;
    }
    return sum / (recentBars.length - 1);
  }

  // Calculate VWAP (Volume-Weighted Average Price) from bars
  private calculateVWAP(bars: Array<{ high: number; low: number; close: number; volume: number }>): number {
    if (bars.length === 0) return 0;
    let cumulativeTPV = 0; // Cumulative Typical Price * Volume
    let cumulativeVolume = 0;
    for (const bar of bars) {
      const typicalPrice = (bar.high + bar.low + bar.close) / 3;
      cumulativeTPV += typicalPrice * bar.volume;
      cumulativeVolume += bar.volume;
    }
    return cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : 0;
  }

  // Calculate EMA (Exponential Moving Average)
  private calculateEMA(bars: Array<{ close: number }>, period: number): number {
    if (bars.length === 0) return 0;
    if (bars.length < period) {
      // Not enough data - use SMA as fallback
      const sum = bars.reduce((acc, bar) => acc + bar.close, 0);
      return sum / bars.length;
    }
    
    const recentBars = bars.slice(-period);
    // Start with SMA
    const sma = recentBars.reduce((acc, bar) => acc + bar.close, 0) / period;
    
    // Calculate EMA with smoothing factor
    const multiplier = 2 / (period + 1);
    let ema = sma;
    
    // Apply EMA formula to remaining bars
    for (let i = period; i < bars.length; i++) {
      ema = (bars[i].close - ema) * multiplier + ema;
    }
    
    return ema;
  }

  // Calculate Volume SMA (Simple Moving Average)
  private calculateVolumeSMA(bars: Array<{ volume: number }>, period: number = 20): number {
    if (bars.length === 0) return 0;
    const recentBars = bars.slice(-period);
    const sum = recentBars.reduce((acc, bar) => acc + bar.volume, 0);
    return sum / recentBars.length;
  }

  // Build daily context lite for LLM
  private buildDailyContextLite(
    exec: MinimalExecutionState,
    closed5mBars: Array<{ ts: number; high: number; low: number; close: number; volume: number }>,
    currentETDate: string
  ): DailyContextLite | undefined {
    // Check if we've crossed into a new day
    if (this.currentETDate !== currentETDate) {
      // New day detected - store previous day's data from last bar of previous day
      if (closed5mBars.length > 0) {
        // Find the last bar from the previous day
        const lastBarPrevDay = [...closed5mBars].reverse().find(bar => {
          const barDate = getETDateString(new Date(bar.ts));
          return barDate !== currentETDate;
        });
        
        if (lastBarPrevDay) {
          // Store previous day's data
          this.prevDayClose = lastBarPrevDay.close;
          this.prevDayHigh = lastBarPrevDay.high;
          this.prevDayLow = lastBarPrevDay.low;
        } else if (this.prevDayClose === undefined && closed5mBars.length > 0) {
          // First day - use first bar as prev day data (fallback)
          const firstBar = closed5mBars[0];
          this.prevDayClose = firstBar.close;
          this.prevDayHigh = firstBar.high;
          this.prevDayLow = firstBar.low;
        }
      }
      // Reset overnight tracking for new day
      this.overnightHigh = undefined;
      this.overnightLow = undefined;
      this.currentETDate = currentETDate;
    }

    // Track overnight high/low from first bars of the current day
    if (closed5mBars.length > 0) {
      const barsToday = closed5mBars.filter(bar => {
        const barDate = getETDateString(new Date(bar.ts));
        return barDate === currentETDate;
      });
      
      if (barsToday.length > 0) {
        const todayHigh = Math.max(...barsToday.map(b => b.high));
        const todayLow = Math.min(...barsToday.map(b => b.low));
        
        if (this.overnightHigh === undefined || todayHigh > this.overnightHigh) {
          this.overnightHigh = todayHigh;
        }
        if (this.overnightLow === undefined || todayLow < this.overnightLow) {
          this.overnightLow = todayLow;
        }
      }
    }

    // Calculate previous session VWAP (from all bars up to now)
    if (closed5mBars.length > 0) {
      this.prevSessionVWAP = this.calculateVWAP(closed5mBars);
    }

    // Build context object
    const context: DailyContextLite = {};
    if (this.prevDayClose !== undefined) context.prevClose = this.prevDayClose;
    if (this.prevDayHigh !== undefined) context.prevHigh = this.prevDayHigh;
    if (this.prevDayLow !== undefined) context.prevLow = this.prevDayLow;
    if (this.overnightHigh !== undefined) context.overnightHigh = this.overnightHigh;
    if (this.overnightLow !== undefined) context.overnightLow = this.overnightLow;
    if (this.prevSessionVWAP !== undefined) context.vwapPrevSession = this.prevSessionVWAP;
    
    // Bias anchor
    if (exec.bias !== "NEUTRAL" && exec.biasTs !== undefined) {
      context.biasAnchor = {
        bias: exec.bias,
        sinceTs: exec.biasTs,
        invalidationLevel: exec.biasInvalidationLevel,
      };
    }

    return Object.keys(context).length > 0 ? context : undefined;
  }

  // Arm resolution gate (INACTIVE → ARMED)
  private armResolutionGate(
    exec: MinimalExecutionState,
    bias: MarketBias,
    pullbackHigh: number,
    pullbackLow: number,
    atr: number,
    nowTs: number,
    timeframeMinutes: number = 5
  ): void {
    if (bias === "NEUTRAL") return;

    const direction = bias === "BULLISH" ? "long" : "short";
    let triggerPrice: number;
    let stopPrice: number;
    let reason: string;

    // PULLBACK_CONTINUATION setup: use standard pullback continuation logic
    if (exec.setup === "PULLBACK_CONTINUATION") {
      if (bias === "BEARISH") {
        // Bearish: trigger on break below pullback low
        triggerPrice = pullbackLow - 0.1 * atr;
        stopPrice = pullbackHigh + 0.1 * atr;
        reason = "Bearish pullback continuation trigger armed";
      } else {
        // Bullish: trigger on break above pullback high
        triggerPrice = pullbackHigh + 0.1 * atr;
        stopPrice = pullbackLow - 0.1 * atr;
        reason = "Bullish pullback continuation trigger armed";
      }
    } else {
      // Fallback for any other setup type (shouldn't happen with simplified setup)
      if (bias === "BEARISH") {
        triggerPrice = pullbackLow - 0.1 * atr;
        stopPrice = pullbackHigh + 0.1 * atr;
        reason = "Bearish pullback continuation trigger armed (fallback)";
      } else {
        triggerPrice = pullbackHigh + 0.1 * atr;
        stopPrice = pullbackLow - 0.1 * atr;
        reason = "Bullish pullback continuation trigger armed (fallback)";
      }
    }

    exec.resolutionGate = {
      status: "ARMED",
      direction,
      triggerPrice,
      stopPrice,
      expiryTs: nowTs + 2 * timeframeMinutes * 60 * 1000, // 2 timeframes
      armedTs: nowTs,
      reason,
    };
  }

  // Check if gate should be triggered (ARMED → TRIGGERED)
  // For REJECTION setups, adds tolerance band to account for market noise
  private checkGateTrigger(
    gate: ResolutionGate,
    currentPrice: number,
    nowTs: number,
    setup?: SetupType,
    current5m?: { open: number; high: number; low: number; close: number },
    bias?: MarketBias,
    maxVolThreshold: number = 2.0 // Simplified - would use actual volatility
  ): boolean {
    if (gate.status !== "ARMED") return false;
    if (nowTs > gate.expiryTs) return false;

    // Tolerance band for REJECTION setups (default 0.05-0.10 for SPY)
    const rejectionTolerance = 0.08; // Configurable tolerance for REJECTION setups
    
    // Check price trigger with tolerance for PULLBACK_CONTINUATION setups
    let priceTriggered = false;
    if (setup === "PULLBACK_CONTINUATION") {
      // REJECTION setup: allow tolerance band
      if (gate.direction === "short") {
        priceTriggered = currentPrice <= gate.triggerPrice + rejectionTolerance;
      } else {
        priceTriggered = currentPrice >= gate.triggerPrice - rejectionTolerance;
      }
      
      // Additional momentum confirmation for REJECTION tolerance
      if (priceTriggered && current5m && bias) {
        const open = current5m.open ?? current5m.close;
        const momentumAligned = (bias === "BEARISH" && current5m.close < open) ||
                                (bias === "BULLISH" && current5m.close > open);
        if (!momentumAligned) {
          // Price is within tolerance but momentum not aligned - don't trigger
          return false;
        }
      }
    } else {
      // Non-REJECTION setup: exact trigger only
      if (gate.direction === "short") {
        priceTriggered = currentPrice <= gate.triggerPrice;
      } else {
        priceTriggered = currentPrice >= gate.triggerPrice;
      }
    }

    // Simplified volatility check (would use actual volatility calculation)
    const volatilityOk = true; // Placeholder - implement actual volatility check

    return priceTriggered && volatilityOk;
  }

  // Check if gate should expire (ARMED → EXPIRED)
  private checkGateExpiry(
    gate: ResolutionGate,
    currentPrice: number,
    nowTs: number,
    atr: number
  ): boolean {
    if (gate.status !== "ARMED") return false;

    // Time expiry
    if (nowTs > gate.expiryTs) return true;

    // Continuation without structure (price moved beyond trigger without hitting it)
    if (gate.direction === "short") {
      return currentPrice < gate.triggerPrice - 0.5 * atr;
    } else {
      return currentPrice > gate.triggerPrice + 0.5 * atr;
    }
  }

  // Check if gate should be invalidated (ARMED → INVALIDATED)
  private checkGateInvalidation(
    gate: ResolutionGate,
    bias: MarketBias,
    currentPrice: number,
    pullbackHigh?: number,
    pullbackLow?: number,
    biasInvalidationLevel?: number
  ): boolean {
    if (gate.status !== "ARMED") return false;

    // Structure break against bias
    if (bias === "BEARISH") {
      if (pullbackHigh !== undefined && currentPrice > pullbackHigh) return true;
      if (biasInvalidationLevel !== undefined && currentPrice > biasInvalidationLevel) return true;
    } else if (bias === "BULLISH") {
      if (pullbackLow !== undefined && currentPrice < pullbackLow) return true;
      if (biasInvalidationLevel !== undefined && currentPrice < biasInvalidationLevel) return true;
    }

    return false;
  }

  // Deactivate gate (any → INACTIVE)
  private deactivateGate(exec: MinimalExecutionState): void {
    if (exec.resolutionGate && exec.resolutionGate.status !== "TRIGGERED") {
      exec.resolutionGate.status = "INACTIVE";
    }
  }

  // Handle setup transitions: reset gate cleanly when setup changes
  private onSetupTransition(
    exec: MinimalExecutionState,
    prevSetup: SetupType | undefined,
    nextSetup: SetupType,
    ts: number
  ): void {
    if (prevSetup === nextSetup) return;

    // Always clear any armed/invalidated gate when setup changes
    if (exec.resolutionGate) {
      const prevGateStatus = exec.resolutionGate.status;
      console.log(
        `[GATE_RESET] setup ${prevSetup ?? "NONE"} -> ${nextSetup} | prevGate=${prevGateStatus}`
      );
    }
    
    // Clear gate state (critical: prevents stale INVALIDATED/ARMED states)
    exec.resolutionGate = undefined;
    
    // Clear setup-specific cached fields
    exec.setupTriggerPrice = undefined;
    exec.setupStopPrice = undefined;
    exec.setupDetectedAt = ts; // Track when new setup started
    
    // Clear entry state if not in trade
    if (exec.phase !== "IN_TRADE") {
      exec.entryPrice = undefined;
      exec.entryTs = undefined;
      exec.entryType = undefined;
      exec.entryTrigger = undefined;
      exec.stopPrice = undefined;
    }
    
    // Note: We do NOT clear pullbackHigh/pullbackLow here because they are structure-based,
    // not setup-specific. They should only be cleared when structure actually breaks.
    
    // Update wait reason
    if (nextSetup === "NONE") {
      exec.waitReason = "setup_none";
    }
  }

  // Explicit arming criteria for PULLBACK_CONTINUATION setup
  // Supports both 5m and 1m turn signals for responsive arming
  private tryArmPullbackGate(
    exec: MinimalExecutionState,
    currentPrice: number,
    lastClosed5m: { open: number; high: number; low: number; close: number } | null,
    previous5m: { open: number; high: number; low: number; close: number } | undefined,
    closed5mBars: Array<{ high: number; low: number; close: number; volume: number }>,
    atr: number,
    ts: number,
    // Optional 1m bar data for responsive arming (allows 1m turn signals)
    current1mBar?: { open: number; high: number; low: number; close: number } | null,
    previous1mBar?: { open: number; high: number; low: number; close: number } | undefined
  ): { armed: true; trigger: number; stop: number; reason: string } | { armed: false; reason: string } {
    // Precondition checks
    if (exec.setup !== "PULLBACK_CONTINUATION") {
      return { armed: false, reason: "wrong_setup" };
    }
    
    if (exec.bias === "NEUTRAL") {
      return { armed: false, reason: "missing_bias" };
    }
    
    // Confidence threshold (adjustable)
    const minConfidence = 65;
    if ((exec.biasConfidence ?? 0) < minConfidence) {
      return { armed: false, reason: `confidence_too_low (${exec.biasConfidence ?? 0} < ${minConfidence})` };
    }
    
    // Pullback levels must be defined
    if (exec.pullbackHigh === undefined || exec.pullbackLow === undefined) {
      return { armed: false, reason: "missing_pullback_levels" };
    }
    
    // ATR must be valid
    if (atr <= 0) {
      return { armed: false, reason: "invalid_atr" };
    }
    
    // Phase must allow arming
    if (exec.phase !== "BIAS_ESTABLISHED" && exec.phase !== "PULLBACK_IN_PROGRESS") {
      return { armed: false, reason: `phase_disallows_arming (${exec.phase})` };
    }
    
    // Calculate EMA and VWAP for pullback zone detection
    const closedBarsWithVolume = closed5mBars.filter(bar => 'volume' in bar) as Array<{ high: number; low: number; close: number; volume: number }>;
    const vwap = closedBarsWithVolume.length > 0 ? this.calculateVWAP(closedBarsWithVolume) : undefined;
    
    // Calculate EMA9 (fast EMA)
    let emaFast: number | undefined;
    if (closed5mBars.length >= 9) {
      const closes = closed5mBars.slice(-20).map(b => b.close);
      const alpha = 2 / (9 + 1);
      let ema = closes[0];
      for (let i = 1; i < closes.length; i++) {
        ema = alpha * closes[i] + (1 - alpha) * ema;
      }
      emaFast = ema;
    }
    
    // Pullback zone condition: price must be in pullback zone
    // Bullish: between VWAP and EMA_FAST (or slightly below EMA_FAST but above VWAP)
    // Bearish: between VWAP and EMA_FAST on underside (or slightly above EMA_FAST but below VWAP)
    let inPullbackZone = false;
    if (exec.bias === "BULLISH") {
      if (vwap !== undefined && emaFast !== undefined) {
        // Bullish pullback zone: price between VWAP and EMA_FAST
        inPullbackZone = currentPrice >= vwap && currentPrice <= emaFast + 0.1 * atr;
      } else {
        // Fallback: price must be below pullback high (in pullback range)
        inPullbackZone = currentPrice < exec.pullbackHigh && currentPrice > exec.pullbackLow;
      }
    } else {
      // BEARISH
      if (vwap !== undefined && emaFast !== undefined) {
        // Bearish pullback zone: price between EMA_FAST and VWAP (on underside)
        inPullbackZone = currentPrice <= vwap && currentPrice >= emaFast - 0.1 * atr;
      } else {
        // Fallback: price must be above pullback low (in pullback range)
        inPullbackZone = currentPrice > exec.pullbackLow && currentPrice < exec.pullbackHigh;
      }
    }
    
    if (!inPullbackZone) {
      return { 
        armed: false, 
        reason: `not_in_pullback_zone (price=${currentPrice.toFixed(2)} vwap=${vwap?.toFixed(2) ?? "n/a"} emaFast=${emaFast?.toFixed(2) ?? "n/a"})` 
      };
    }
    
    // Rejection/turn condition: check for turn signal (prefer 1m for responsiveness, fallback to 5m)
    let hasTurnSignal = false;
    let turnSignalSource = "";
    
    // First, try 1m turn signal (more responsive - allows arming before 5m confirms)
    if (current1mBar && previous1mBar) {
      const open1m = current1mBar.open ?? current1mBar.close;
      const isBearish1m = current1mBar.close < open1m;
      const isBullish1m = current1mBar.close > open1m;
      
      if (exec.bias === "BEARISH") {
        // Bearish 1m turn: lower-high + bearish close
        const lowerHigh1m = current1mBar.high < previous1mBar.high;
        if (lowerHigh1m && isBearish1m) {
          hasTurnSignal = true;
          turnSignalSource = "1m_rejection";
        }
        // Alternative: price closes back below EMA_FAST after being above (1m)
        if (!hasTurnSignal && emaFast !== undefined) {
          const wasAboveEma = previous1mBar.close >= emaFast;
          const nowBelowEma = current1mBar.close < emaFast;
          if (wasAboveEma && nowBelowEma && isBearish1m) {
            hasTurnSignal = true;
            turnSignalSource = "1m_ema_reclaim_fail";
          }
        }
      } else {
        // BULLISH 1m turn: higher-low + bullish close
        const higherLow1m = current1mBar.low > previous1mBar.low;
        if (higherLow1m && isBullish1m) {
          hasTurnSignal = true;
          turnSignalSource = "1m_rejection";
        }
        // Alternative: price closes back above EMA_FAST after being below (1m)
        if (!hasTurnSignal && emaFast !== undefined) {
          const wasBelowEma = previous1mBar.close <= emaFast;
          const nowAboveEma = current1mBar.close > emaFast;
          if (wasBelowEma && nowAboveEma && isBullish1m) {
            hasTurnSignal = true;
            turnSignalSource = "1m_ema_reclaim_fail";
          }
        }
      }
    }
    
    // Fallback to 5m turn signal if 1m didn't trigger and we have 5m data
    if (!hasTurnSignal && lastClosed5m && previous5m) {
      const open5m = lastClosed5m.open ?? lastClosed5m.close;
      const isBearish5m = lastClosed5m.close < open5m;
      const isBullish5m = lastClosed5m.close > open5m;
      
      if (exec.bias === "BEARISH") {
        // Bearish: need lower-high + bearish close
        const lowerHigh = lastClosed5m.high < previous5m.high;
        hasTurnSignal = lowerHigh && isBearish5m;
        if (hasTurnSignal) turnSignalSource = "5m_rejection";
        
        // Alternative: price closes back below EMA_FAST after being above
        if (!hasTurnSignal && emaFast !== undefined) {
          const wasAboveEma = previous5m.close >= emaFast;
          const nowBelowEma = lastClosed5m.close < emaFast;
          hasTurnSignal = wasAboveEma && nowBelowEma && isBearish5m;
          if (hasTurnSignal) turnSignalSource = "5m_ema_reclaim_fail";
        }
      } else {
        // BULLISH: need higher-low + bullish close
        const higherLow = lastClosed5m.low > previous5m.low;
        hasTurnSignal = higherLow && isBullish5m;
        if (hasTurnSignal) turnSignalSource = "5m_rejection";
        
        // Alternative: price closes back above EMA_FAST after being below
        if (!hasTurnSignal && emaFast !== undefined) {
          const wasBelowEma = previous5m.close <= emaFast;
          const nowAboveEma = lastClosed5m.close > emaFast;
          hasTurnSignal = wasBelowEma && nowAboveEma && isBullish5m;
          if (hasTurnSignal) turnSignalSource = "5m_ema_reclaim_fail";
        }
      }
    }
    
    if (!hasTurnSignal) {
      return { armed: false, reason: "no_turn_signal" };
    }
    
    // Check for "too extended" condition (refined for trend days)
    // In strong trends, price can stay > 1.5 ATR from VWAP while pullbacks occur around EMA
    // Only block if: distance > 1.5 ATR AND price is making new highs/lows without pullback structure
    if (vwap !== undefined) {
      const distanceFromVwap = Math.abs(currentPrice - vwap);
      const maxDistance = 1.5 * atr;
      
      if (distanceFromVwap > maxDistance) {
        // Check if we're in a pullback structure (not just extended)
        const inPullbackStructure = exec.bias === "BULLISH"
          ? (exec.pullbackLow !== undefined && currentPrice > exec.pullbackLow && currentPrice < exec.pullbackHigh)
          : (exec.pullbackHigh !== undefined && currentPrice < exec.pullbackHigh && currentPrice > exec.pullbackLow);
        
        // Also check if price is making new extremes without pullback
        let makingNewExtremes = false;
        if (closed5mBars.length >= 3) {
          const recentBars = closed5mBars.slice(-5);
          const recentHigh = Math.max(...recentBars.map(b => b.high));
          const recentLow = Math.min(...recentBars.map(b => b.low));
          
          if (exec.bias === "BULLISH") {
            makingNewExtremes = currentPrice >= recentHigh * 0.998; // Near recent high
          } else {
            makingNewExtremes = currentPrice <= recentLow * 1.002; // Near recent low
          }
        }
        
        // Only block if extended AND making new extremes without pullback structure
        if (!inPullbackStructure && makingNewExtremes) {
          return { 
            armed: false, 
            reason: `too_extended_from_vwap (${distanceFromVwap.toFixed(2)} > ${maxDistance.toFixed(2)}) AND making_new_extremes` 
          };
        }
        // If we're in pullback structure, allow arming even if extended (trend day scenario)
      }
    }
    
    // All criteria met - calculate trigger and stop
    let trigger: number;
    let stop: number;
    let reason: string;
    
    if (exec.bias === "BULLISH") {
      // Bullish: trigger on break above pullback high (or rejection candle high)
      trigger = exec.pullbackHigh + 0.1 * atr;
      stop = exec.pullbackLow - 0.1 * atr;
      reason = `bull_pullback_turn_${turnSignalSource}`;
    } else {
      // BEARISH: trigger on break below pullback low (or rejection candle low)
      trigger = exec.pullbackLow - 0.1 * atr;
      stop = exec.pullbackHigh + 0.1 * atr;
      reason = `bear_pullback_turn_${turnSignalSource}`;
    }
    
    return { armed: true, trigger, stop, reason };
  }

  // ============================================================================
  // OPPORTUNITYLATCH: Single execution intent state that composes all gates
  // ============================================================================
  // This replaces the "separated gate mess" by becoming the single execution gate.
  // Phase = story, Setup = pattern label, OpportunityLatch = "I'm ready to shoot" state
  // ============================================================================

  // Create (latch) an opportunity when we're in a tradable pullback window
  // This happens BEFORE the perfect candle prints - we latch during the pull-up
  private latchOpportunity(
    exec: MinimalExecutionState,
    ts: number,
    currentPrice: number,
    pullbackHigh: number | undefined,
    pullbackLow: number | undefined,
    atr: number,
    closed5mBars: Array<{ high: number; low: number; close: number }>,
    forming5mBar: Forming5mBar | null
  ): OpportunityLatch | null {
    // Preconditions: must be in tradable state
    if (exec.bias === "NEUTRAL") return null;
    if (exec.phase !== "BIAS_ESTABLISHED" && exec.phase !== "PULLBACK_IN_PROGRESS") return null;
    // Note: IN_TRADE is already excluded by the above check
    if (atr <= 0) return null;

    const side: OpportunitySide = exec.bias === "BULLISH" ? "LONG" : "SHORT";
    const current5m = forming5mBar ?? (closed5mBars.length > 0 ? closed5mBars[closed5mBars.length - 1] : null);
    if (!current5m) return null;

    // Determine pullback zone based on bias and available levels
    let zoneLow: number;
    let zoneHigh: number;
    let triggerPrice: number;
    let triggerType: OpportunityTriggerType;
    let stopPrice: number;
    let stopReason: string;
    let notes: string;

    if (exec.bias === "BEARISH") {
      // BEARISH: We want to short on pullback into resistance
      // Zone: price should be within 0.15-0.50 ATR below resistance
      const resistance = pullbackHigh ?? current5m.high;
      const zoneBuffer = 0.15 * atr; // Minimum distance from resistance
      const zoneMaxDistance = 0.50 * atr; // Maximum distance from resistance
      
      zoneHigh = resistance;
      zoneLow = resistance - zoneMaxDistance;
      
      // Trigger: rollover candle (bearish close) or break of prior low
      // Use setup trigger if available, otherwise use pullback low
      triggerPrice = exec.setupTriggerPrice ?? (pullbackLow ?? (resistance - 0.3 * atr));
      triggerType = exec.setup === "PULLBACK_CONTINUATION" ? "BREAK" : "BREAK";
      
      // Stop: above pullback high
      stopPrice = exec.setupStopPrice ?? (pullbackHigh ?? resistance) + 0.1 * atr;
      stopReason = "pullback high + buffer";
      
      notes = `Bearish pullback into resistance ${resistance.toFixed(2)}`;
      
      // Check if price is actually in the pullback zone
      if (currentPrice > zoneHigh || currentPrice < zoneLow) {
        return null; // Not in pullback zone yet
      }
    } else {
      // BULLISH: We want to long on pullback into support
      // Zone: price should be within 0.15-0.50 ATR above support
      const support = pullbackLow ?? current5m.low;
      const zoneBuffer = 0.15 * atr;
      const zoneMaxDistance = 0.50 * atr;
      
      zoneLow = support;
      zoneHigh = support + zoneMaxDistance;
      
      // Trigger: rollover candle (bullish close) or break of prior high
      triggerPrice = exec.setupTriggerPrice ?? (pullbackHigh ?? (support + 0.3 * atr));
      triggerType = exec.setup === "PULLBACK_CONTINUATION" ? "BREAK" : "BREAK";
      
      // Stop: below pullback low
      stopPrice = exec.setupStopPrice ?? (pullbackLow ?? support) - 0.1 * atr;
      stopReason = "pullback low + buffer";
      
      notes = `Bullish pullback into support ${support.toFixed(2)}`;
      
      // Check if price is actually in the pullback zone
      if (currentPrice < zoneLow || currentPrice > zoneHigh) {
        return null; // Not in pullback zone yet
      }
    }

    // TTL: 2 closed 5m bars = 10 minutes
    const ttlMs = 2 * 5 * 60 * 1000;
    const expiresAtTs = ts + ttlMs;

    const opportunity: OpportunityLatch = {
      status: "LATCHED",
      side,
      biasAtLatch: exec.bias,
      phaseAtLatch: exec.phase,
      setupAtLatch: exec.setup,
      latchedAtTs: ts,
      expiresAtTs,
      zone: { low: zoneLow, high: zoneHigh },
      trigger: {
        type: triggerType,
        price: triggerPrice,
        description: "break of prior structure",
      },
      stop: {
        price: stopPrice,
        reason: stopReason,
      },
      attempts: 0,
      bestPriceSeen: currentPrice,
      notes,
    };

    console.log(
      `[OPPORTUNITY_LATCHED] ${side} bias=${exec.bias} phase=${exec.phase} setup=${exec.setup ?? "NONE"} zone=[${zoneLow.toFixed(2)}, ${zoneHigh.toFixed(2)}] trigger=${triggerPrice.toFixed(2)} stop=${stopPrice.toFixed(2)} expires=${new Date(expiresAtTs).toISOString()}`
    );

    return opportunity;
  }

  // Check if opportunity should be invalidated (structural checks)
  private shouldInvalidateOpportunity(
    opportunity: OpportunityLatch,
    exec: MinimalExecutionState,
    currentPrice: number,
    ts: number,
    atr: number
  ): { invalidated: boolean; reason?: string } {
    if (opportunity.status !== "LATCHED") {
      return { invalidated: false };
    }

    // 1. Time expiry
    if (ts >= opportunity.expiresAtTs) {
      return { invalidated: true, reason: "time_expired" };
    }

    // 2. Bias invalidated
    if (exec.bias !== opportunity.biasAtLatch) {
      const shouldFlip = this.shouldFlipBias(
        opportunity.biasAtLatch,
        exec.bias,
        exec.biasInvalidationLevel,
        currentPrice
      );
      if (shouldFlip) {
        return { invalidated: true, reason: "bias_invalidated" };
      }
    }

    // 3. Stop level broken
    if (opportunity.side === "SHORT") {
      if (currentPrice >= opportunity.stop.price) {
        return { invalidated: true, reason: "stop_broken" };
      }
    } else {
      if (currentPrice <= opportunity.stop.price) {
        return { invalidated: true, reason: "stop_broken" };
      }
    }

    // 4. Zone exited (price closes outside zone + buffer)
    const zoneBuffer = 0.1 * atr;
    if (currentPrice < opportunity.zone.low - zoneBuffer || currentPrice > opportunity.zone.high + zoneBuffer) {
      return { invalidated: true, reason: "zone_exited" };
    }

    return { invalidated: false };
  }

  // Ensure opportunity latch exists when bias is established (automatic/optional)
  private ensureOpportunityLatch(
    exec: MinimalExecutionState,
    ts: number,
    currentPrice: number,
    atr: number
  ): boolean {
    if (exec.bias === "NEUTRAL") return false;

    // Check if we need to create/refresh opportunity latch
    // Don't relatch if existing opportunity is still valid (LATCHED or TRIGGERED)
    const existingOppValid = exec.opportunity && 
      (exec.opportunity.status === "LATCHED" || exec.opportunity.status === "TRIGGERED") &&
      exec.opportunity.biasAtLatch === exec.bias &&
      exec.opportunity.expiresAtTs >= ts;
    
    const needsLatch = !existingOppValid;

    if (needsLatch && 
        (exec.phase === "BIAS_ESTABLISHED" || exec.phase === "PULLBACK_IN_PROGRESS") &&
        atr > 0) {
      
      // Create simple automatic latch
      const side = exec.bias === "BULLISH" ? "LONG" : "SHORT";
      const expiresInMin = 45; // 45 minutes
      
      // Calculate trigger price
      const triggerPrice = exec.bias === "BULLISH" 
        ? (exec.pullbackHigh ?? currentPrice) + 0.1 * atr
        : (exec.pullbackLow ?? currentPrice) - 0.1 * atr;
      
      // STEP 2 FIX: Only latch if price is on the correct side of trigger at latch time
      // For SHORT (break-of-low): current price must be ABOVE trigger (so break is meaningful)
      // For LONG (break-of-high): current price must be BELOW trigger (so break is meaningful)
      const isValidLatchPosition = exec.bias === "BULLISH" 
        ? currentPrice < triggerPrice  // LONG: must be below trigger to break above
        : currentPrice > triggerPrice; // SHORT: must be above trigger to break below
      
      if (!isValidLatchPosition) {
        // Price is already past trigger - don't latch (would trigger immediately)
        console.log(
          `[OPP_LATCH_SKIPPED] Price already past trigger - bias=${exec.bias} price=${currentPrice.toFixed(2)} trigger=${triggerPrice.toFixed(2)}`
        );
        return false;
      }
      
      exec.opportunity = {
        status: "LATCHED",
        side,
        biasAtLatch: exec.bias,
        phaseAtLatch: exec.phase,
        setupAtLatch: exec.setup ?? "NONE",
        latchedAtTs: ts,
        expiresAtTs: ts + expiresInMin * 60 * 1000,
        zone: {
          low: exec.pullbackLow ?? currentPrice - 0.5 * atr,
          high: exec.pullbackHigh ?? currentPrice + 0.5 * atr,
        },
        trigger: {
          type: "BREAK",
          price: triggerPrice,
          description: "break of prior structure",
        },
        stop: {
          price: exec.bias === "BULLISH"
            ? (exec.pullbackLow ?? currentPrice) - 0.1 * atr
            : (exec.pullbackHigh ?? currentPrice) + 0.1 * atr,
          reason: "pullback_level_buffer",
        },
        attempts: 0,
        bestPriceSeen: currentPrice,
        armedAtPrice: currentPrice,  // Store price at latch time for cross-based trigger validation
        invalidateIf: {},
        notes: "automatic_latch",
      };
      
      // Clear waitReason when opportunity is latched (fix for stale Telegram messages)
      if (exec.waitReason === "no_opportunity_latched") {
        exec.waitReason = exec.setup === "NONE" ? "waiting_for_pullback" : "waiting_for_trigger";
      }
      
      console.log(
        `[OPP_LATCHED] direction=${exec.bias} expiresInMin=${expiresInMin} automatic`
      );
      
      return true; // Latch was created
    }
    
    return false; // No latch created
  }

  // Check if opportunity trigger is met (becomes TRIGGERED)
  private checkOpportunityTrigger(
    opportunity: OpportunityLatch,
    current5m: { open: number; high: number; low: number; close: number },
    previous5m: { high: number; low: number; close: number } | undefined,
    closed5mBars: Array<{ high: number; low: number; close: number }>,
    atr: number
  ): { triggered: boolean; reason?: string } {
    if (opportunity.status !== "LATCHED") {
      return { triggered: false };
    }

    const open = current5m.open ?? current5m.close;
    const isBearish = current5m.close < open;
    const isBullish = current5m.close > open;

    // Update best price seen (for no-chase logic)
    if (opportunity.side === "SHORT") {
      opportunity.bestPriceSeen = Math.max(opportunity.bestPriceSeen ?? current5m.close, current5m.high);
    } else {
      opportunity.bestPriceSeen = Math.min(opportunity.bestPriceSeen ?? current5m.close, current5m.low);
    }

    // Check trigger based on type
    if (opportunity.trigger.type === "ROLLOVER") {
      // ROLLOVER: candle closes against bias (bearish for bullish bias, bullish for bearish bias)
      if (opportunity.side === "SHORT" && isBearish) {
        // Bearish rollover for short entry
        // Additional check: close should be below EMA/VWAP if available (optional)
        return { triggered: true, reason: "rollover_candle" };
      } else if (opportunity.side === "LONG" && isBullish) {
        // Bullish rollover for long entry
        return { triggered: true, reason: "rollover_candle" };
      }
    } else if (opportunity.trigger.type === "BREAK") {
      // BREAK: price breaks prior structure
      if (previous5m) {
        if (opportunity.side === "SHORT") {
          // Break of prior low
          if (current5m.low < previous5m.low) {
            return { triggered: true, reason: "break_of_prior_low" };
          }
        } else {
          // Break of prior high
          if (current5m.high > previous5m.high) {
            return { triggered: true, reason: "break_of_prior_high" };
          }
        }
      }
    } else if (opportunity.trigger.type === "RECLAIM_FAIL") {
      // RECLAIM_FAIL: price tried to reclaim level but failed
      // This is handled by EARLY_REJECTION setup detection
      // For now, treat as ROLLOVER
      if (opportunity.side === "SHORT" && isBearish) {
        return { triggered: true, reason: "reclaim_failed" };
      } else if (opportunity.side === "LONG" && isBullish) {
        return { triggered: true, reason: "reclaim_failed" };
      }
    }

    // Check if price crossed trigger price (CROSS-BASED, not state-based)
    // This prevents "instant triggers" when price is already beyond trigger at latch time
    // Validation: ensure we were on the correct side of trigger when latched
    const tolerance = (opportunity.setupAtLatch === "PULLBACK_CONTINUATION") ? 0.08 : 0.0;
    const armedAtPrice = opportunity.armedAtPrice ?? current5m.close; // Fallback if not set
    
    if (opportunity.side === "SHORT") {
      // For SHORT: require we were above trigger when latched, then cross below
      const triggerLevel = opportunity.trigger.price + tolerance;
      
      // Safety check: if we were already below trigger at latch time, don't trigger
      if (armedAtPrice <= triggerLevel) {
        return { triggered: false }; // Already past trigger at latch - invalid
      }
      
      // For SHORT: require cross from above to below trigger price
      if (previous5m) {
        const prevClose = previous5m.close;
        const currClose = current5m.close;
        
        // Cross occurred: previous close was above trigger, current close is at or below
        const crossed = prevClose > triggerLevel && currClose <= triggerLevel;
        
        if (crossed) {
          // Price crossed trigger - check momentum alignment
          if (isBearish) {
            return { triggered: true, reason: "price_crossed_trigger_below" };
          } else {
            // Price crossed but momentum not aligned - increment attempts
            opportunity.attempts = (opportunity.attempts ?? 0) + 1;
            return { triggered: false };
          }
        }
      } else {
        // No previous bar - check if we cross from armedAtPrice to below trigger
        if (armedAtPrice > triggerLevel && current5m.close <= triggerLevel && isBearish) {
          return { triggered: true, reason: "price_crossed_trigger_below_first_bar" };
        }
      }
    } else {
      // For LONG: require we were below trigger when latched, then cross above
      const triggerLevel = opportunity.trigger.price - tolerance;
      
      // Safety check: if we were already above trigger at latch time, don't trigger
      if (armedAtPrice >= triggerLevel) {
        return { triggered: false }; // Already past trigger at latch - invalid
      }
      
      // For LONG: require cross from below to above trigger price
      if (previous5m) {
        const prevClose = previous5m.close;
        const currClose = current5m.close;
        
        // Cross occurred: previous close was below trigger, current close is at or above
        const crossed = prevClose < triggerLevel && currClose >= triggerLevel;
        
        if (crossed) {
          if (isBullish) {
            return { triggered: true, reason: "price_crossed_trigger_above" };
          } else {
            opportunity.attempts = (opportunity.attempts ?? 0) + 1;
            return { triggered: false };
          }
        }
      } else {
        // No previous bar - check if we cross from armedAtPrice to above trigger
        if (armedAtPrice < triggerLevel && current5m.close >= triggerLevel && isBullish) {
          return { triggered: true, reason: "price_crossed_trigger_above_first_bar" };
        }
      }
    }

    return { triggered: false };
  }

  private clearTradeState(exec: MinimalExecutionState): void {
    // Only clear pullback levels if we're not in PULLBACK_IN_PROGRESS (need them for failure detection)
    if (exec.phase !== "PULLBACK_IN_PROGRESS") {
    exec.pullbackHigh = undefined;
    exec.pullbackLow = undefined;
    exec.pullbackTs = undefined;
    }
    exec.entryPrice = undefined;
    exec.entryTs = undefined;
    exec.stopPrice = undefined;
    exec.targets = undefined;
    exec.entryType = undefined;
    exec.entryTrigger = undefined;
    exec.reason = undefined; // Clear entry-aligned narrative on exit
    // Clear bias flip gate on exit
    exec.biasFlipGate = undefined;
  }

  // ============================================================================
  // BIAS FLIP ENTRY: Independent entry path for bias flips (regime-break trades)
  // ============================================================================
  // This module is independent of "setup" types - it doesn't care if exec.setup=NONE
  // ============================================================================

  private didBiasFlip(prevBias: MarketBias, newBias: MarketBias): boolean {
    // Ignore neutral transitions (optional: can remove these guards if you want neutral->dir flips)
    if (prevBias === "NEUTRAL") return false;
    if (newBias === "NEUTRAL") return false;
    return prevBias !== newBias;
  }

  private maybeArmBiasFlipGate(
    exec: MinimalExecutionState,
    prevBias: MarketBias,
    closed5m: { ts: number; open: number; high: number; low: number; close: number; volume: number },
    atr: number,
    vwap: number | undefined,
    ts: number
  ): void {
    // Don't arm if already in trade
    if (exec.phase === "IN_TRADE") return;

    // Must be a flip
    if (!this.didBiasFlip(prevBias, exec.bias)) return;

    // Confidence gate
    if ((exec.biasConfidence ?? 0) < this.BIAS_FLIP_MIN_CONF) {
      console.log(
        `[BIAS_FLIP_BLOCKED] reason=conf_too_low conf=${exec.biasConfidence ?? 0} prev=${prevBias} next=${exec.bias}`
      );
      return;
    }

    // Cooldown to avoid flip-flop spam
    if (exec.lastBiasFlipArmTs && (ts - exec.lastBiasFlipArmTs) < this.BIAS_FLIP_COOLDOWN_MS) {
      const dtMs = ts - exec.lastBiasFlipArmTs;
      console.log(
        `[BIAS_FLIP_BLOCKED] reason=cooldown dtMs=${dtMs} cooldownMs=${this.BIAS_FLIP_COOLDOWN_MS}`
      );
      return;
    }

    // Basic ATR sanity
    if (!atr || atr <= 0) {
      console.log(`[BIAS_FLIP_BLOCKED] reason=no_atr`);
      return;
    }

    // Candle range check (avoid micro candles)
    const range = closed5m.high - closed5m.low;
    if (range < this.BIAS_FLIP_MIN_RANGE_ATR * atr) {
      console.log(
        `[BIAS_FLIP_BLOCKED] reason=candle_too_small range=${range.toFixed(2)} atr=${atr.toFixed(2)} minRange=${(this.BIAS_FLIP_MIN_RANGE_ATR * atr).toFixed(2)}`
      );
      return;
    }

    // Optional: Don't arm if already too extended from VWAP
    if (vwap !== undefined && Math.abs(closed5m.close - vwap) > 1.5 * atr) {
      console.log(
        `[BIAS_FLIP_BLOCKED] reason=too_extended_from_vwap close=${closed5m.close.toFixed(2)} vwap=${vwap.toFixed(2)} atr=${atr.toFixed(2)} distance=${Math.abs(closed5m.close - vwap).toFixed(2)}`
      );
      return;
    }

    const dir: "long" | "short" = exec.bias === "BULLISH" ? "long" : "short";

    // Trigger is breakout of the FLIP candle in direction of new bias
    const trigger = dir === "long" ? closed5m.high : closed5m.low;

    // Stop is the opposite end of that flip candle (tight + deterministic)
    const stop = dir === "long" ? closed5m.low : closed5m.high;

    exec.biasFlipGate = {
      state: "ARMED",
      direction: dir,
      armedAtTs: closed5m.ts,
      expiresAtTs: closed5m.ts + this.BIAS_FLIP_TTL_MS,
      trigger,
      stop,
      basis5m: {
        o: closed5m.open,
        h: closed5m.high,
        l: closed5m.low,
        c: closed5m.close,
        ts: closed5m.ts,
      },
      conf: exec.biasConfidence ?? 0,
      reason: "bias_flip",
    };

    exec.lastBiasFlipArmTs = ts;

    const expiresInMin = Math.round(this.BIAS_FLIP_TTL_MS / 60000);
    console.log(
      `[BIAS_FLIP_ARMED] dir=${dir} conf=${exec.biasConfidence ?? 0} trigger=${trigger.toFixed(2)} stop=${stop.toFixed(2)} expiresInMin=${expiresInMin} prevBias=${prevBias} newBias=${exec.bias} basis5m={o=${closed5m.open.toFixed(2)} h=${closed5m.high.toFixed(2)} l=${closed5m.low.toFixed(2)} c=${closed5m.close.toFixed(2)}}`
    );
  }

  private maybeExecuteBiasFlipEntry(
    exec: MinimalExecutionState,
    current5m: { open: number; high: number; low: number; close: number },
    last1m: { high: number; low: number; close: number } | undefined,
    closed5mBars: Array<{ high: number; low: number; close: number; volume: number }>,
    ts: number
  ): boolean {
    const gate = exec.biasFlipGate;
    if (!gate || gate.state !== "ARMED") return false;

    // Expire
    if (ts >= gate.expiresAtTs) {
      console.log(
        `[BIAS_FLIP_EXPIRED] dir=${gate.direction} armedAt=${gate.armedAtTs} nowTs=${ts}`
      );
      if (exec.biasFlipGate) {
        exec.biasFlipGate.state = "EXPIRED";
      }
      return false;
    }

    // Cancel if bias no longer matches gate direction
    const desiredDir = exec.bias === "BULLISH" ? "long" : exec.bias === "BEARISH" ? "short" : "none";
    if (desiredDir !== gate.direction) {
      console.log(
        `[BIAS_FLIP_CANCELLED] reason=bias_changed_after_arm gateDir=${gate.direction} execBias=${exec.bias}`
      );
      if (exec.biasFlipGate) {
        exec.biasFlipGate.state = "CANCELLED";
      }
      return false;
    }

    // Don't double-enter
    if (exec.phase === "IN_TRADE") {
      if (exec.biasFlipGate) {
        exec.biasFlipGate.state = "CANCELLED";
      }
      return false;
    }

    // Trigger check using 1m extremes (prefer last1m if available, else use current5m)
    const checkBar = last1m ?? current5m;
    const triggered =
      gate.direction === "long"
        ? checkBar.high >= gate.trigger
        : checkBar.low <= gate.trigger;

    if (!triggered) return false;

    // Execute "alerts-only" entry using existing structure
    const oldPhase = exec.phase;

    exec.phase = "IN_TRADE";
    exec.thesisDirection = gate.direction;

    exec.entryPrice = current5m.close;
    exec.entryTs = ts;

    exec.entryType = "BIAS_FLIP_ENTRY";
    exec.entryTrigger = `Bias flip breakout ${gate.direction === "long" ? "above" : "below"} flip candle`;
    exec.reason = `Entered (${exec.entryType}) — ${exec.entryTrigger}`;

    exec.stopPrice = gate.stop;

    // Targets: reuse existing computeTargets helper
    const atr = this.calculateATR(closed5mBars);
    const closedBarsWithVolume = closed5mBars.filter(bar => 'volume' in bar) as Array<{ high: number; low: number; close: number; volume: number }>;
    const vwap = closedBarsWithVolume.length > 0 ? this.calculateVWAP(closedBarsWithVolume) : undefined;
    const targetResult = this.computeTargets(
      gate.direction,
      exec.entryPrice,
      exec.stopPrice,
      atr,
      closedBarsWithVolume,
      vwap,
      exec.pullbackHigh,
      exec.pullbackLow,
      exec.impulseRange
    );
    exec.targets = targetResult.targets;
    exec.targetZones = targetResult.targetZones;

    if (exec.opportunity) {
      exec.opportunity.status = "CONSUMED";
    }

    exec.entryBlocked = false;
    exec.waitReason = "in_trade";

    if (exec.biasFlipGate) {
      exec.biasFlipGate.state = "TRIGGERED";
    }

    console.log(
      `[ENTRY_EXECUTED] ${oldPhase} -> IN_TRADE | BIAS=${exec.bias} SETUP=${exec.setup ?? "NONE"} entry=${exec.entryPrice.toFixed(2)} type=${exec.entryType} trigger="${exec.entryTrigger}" stop=${exec.stopPrice.toFixed(2)}`
    );

    return true; // Entry executed
  }

  // ============================================================================
  // SETUP DETECTION: Simplified to only PULLBACK_CONTINUATION (and optional RIP_REVERSION)
  // ============================================================================
  // Only one setup may be active at a time
  // No setup = no trade (even if bias is strong)
  // Setup detection uses ONLY closed 5m bars (never forming bars) to prevent flicker
  // ============================================================================
  
  private detectSetup(
    exec: MinimalExecutionState,
    current5m: { open: number; high: number; low: number; close: number },
    previous5m: { open: number; high: number; low: number; close: number } | undefined,
    closed5mBars: Array<{ high: number; low: number; close: number; volume: number }>,
    atr: number,
    forming5mBar: Forming5mBar | null // IGNORED - never used to prevent flicker
  ): { setup: SetupType; triggerPrice?: number; stopPrice?: number } {
    const bias = exec.bias;
    const phase = exec.phase;
    const expectedResolution = exec.expectedResolution;
    
    // No setup if no bias
    if (bias === "NEUTRAL") {
      return { setup: "NONE" };
    }
    
    // PULLBACK_CONTINUATION: Trend pullback then continuation
    // Allowed when: bias is established, phase indicates pullback, and expected resolution is continuation
    if ((phase === "BIAS_ESTABLISHED" || phase === "PULLBACK_IN_PROGRESS") &&
        expectedResolution === "CONTINUATION" &&
        exec.pullbackHigh !== undefined &&
        exec.pullbackLow !== undefined &&
        atr > 0) {
      
      // Calculate trigger and stop based on bias
      let triggerPrice: number;
      let stopPrice: number;
      
      if (bias === "BEARISH") {
        // Bearish: trigger on break below pullback low
        triggerPrice = exec.pullbackLow - 0.1 * atr;
        stopPrice = exec.pullbackHigh + 0.1 * atr;
      } else {
        // Bullish: trigger on break above pullback high
        triggerPrice = exec.pullbackHigh + 0.1 * atr;
        stopPrice = exec.pullbackLow - 0.1 * atr;
      }
      
      return {
        setup: "PULLBACK_CONTINUATION",
        triggerPrice,
        stopPrice,
      };
    }
    
    // TODO: RIP_REVERSION setup (optional, phase 2)
    // Extended rip then fade / extended dump then bounce
    
    // No setup detected
    return { setup: "NONE" };
  }
  
  // ============================================================================
  // OLD SETUP DETECTION METHODS (DISABLED - removed after simplifying to PULLBACK_CONTINUATION only)
  // ============================================================================
  // The following methods are no longer used but kept for reference:
  // - detectEarlyRejection()
  // - detectRejectionSetup()
  // - detectBreakdownSetup()
  // - detectCompressionBreak()
  // - detectFailedBounce()
  // - detectTrendReentry()
  // All code between here and detectEntryType() has been removed
  // ============================================================================
  
  // Map LLM action to market bias (sticky, only flips on invalidation)
  // Helper to normalize LLM bias string to MarketBias enum (handles casing safely)
  private normalizeBias(llmBias: string | undefined): "BEARISH" | "BULLISH" | "NEUTRAL" {
    if (!llmBias) return "NEUTRAL";
    const normalized = llmBias.toLowerCase();
    if (normalized === "bullish") return "BULLISH";
    if (normalized === "bearish") return "BEARISH";
    return "NEUTRAL";
  }

  private llmActionToBias(action: "ARM_LONG" | "ARM_SHORT" | "WAIT" | "A+", llmBias: "bullish" | "bearish" | "neutral"): "BEARISH" | "BULLISH" | "NEUTRAL" {
    if (action === "ARM_LONG" || (action === "A+" && llmBias === "bullish")) {
      return "BULLISH";
    } else if (action === "ARM_SHORT" || (action === "A+" && llmBias === "bearish")) {
      return "BEARISH";
    } else if (action === "WAIT") {
      // WAIT action: use llmBias directly (LLM can output WAIT with directional bias)
      return this.normalizeBias(llmBias);
    }
    return "NEUTRAL";
  }

  // Check if bias should flip (only on structural invalidation)
  private shouldFlipBias(currentBias: MarketBias, newBias: MarketBias, invalidationLevel?: number, currentPrice?: number): boolean {
    if (currentBias === newBias || newBias === "NEUTRAL") {
      return false; // No flip needed
    }
    
    // Bias only flips if price crosses invalidation level
    if (invalidationLevel !== undefined && currentPrice !== undefined) {
      if (currentBias === "BULLISH" && currentPrice < invalidationLevel) {
        return true; // Bullish bias invalidated
      }
      if (currentBias === "BEARISH" && currentPrice > invalidationLevel) {
        return true; // Bearish bias invalidated
      }
    }
    
    // If no invalidation level set, allow flip (initial bias establishment)
    return invalidationLevel === undefined;
  }

  // Detect entry type from price action
  private detectEntryType(
    bias: MarketBias,
    current5m: { open: number; high: number; low: number; close: number },
    previous5m?: { open: number; high: number; low: number; close: number }
  ): { type: EntryType; trigger: string } {
    const open = current5m.open ?? current5m.close;
    const isBearish = current5m.close < open;
    const isBullish = current5m.close > open;
    const hasUpperWick = current5m.high > Math.max(current5m.open, current5m.close);
    const hasLowerWick = current5m.low < Math.min(current5m.open, current5m.close);

    if (bias === "BEARISH") {
      // Rejection entry: bearish candle with upper wick at resistance
      if (isBearish && hasUpperWick && previous5m && current5m.high < previous5m.high) {
        return { type: "REJECTION_ENTRY", trigger: "Bearish rejection at resistance" };
      }
      // Breakdown entry: breaks below previous low
      if (previous5m && current5m.low < previous5m.low) {
        return { type: "BREAKDOWN_ENTRY", trigger: "Breakdown below previous low" };
      }
    } else if (bias === "BULLISH") {
      // Rejection entry: bullish candle with lower wick at support
      if (isBullish && hasLowerWick && previous5m && current5m.low > previous5m.low) {
        return { type: "REJECTION_ENTRY", trigger: "Bullish rejection at support" };
      }
      // Breakdown entry: breaks above previous high
      if (previous5m && current5m.high > previous5m.high) {
        return { type: "BREAKDOWN_ENTRY", trigger: "Breakout above previous high" };
      }
    }

    return { type: null, trigger: "" };
  }

  // Enhanced target calculation with multiple methods
  private computeTargets(
    direction: "long" | "short",
    entry: number,
    stop: number,
    atr: number,
    closed5mBars: Array<{ high: number; low: number; close: number; volume: number }>,
    vwap?: number,
    pullbackHigh?: number,
    pullbackLow?: number,
    impulseRange?: number
  ): {
    targets: number[]; // Legacy format [T1, T2, T3]
    targetZones: {
      rTargets: { t1: number; t2: number; t3: number };
      atrTargets: { t1: number; t2: number };
      magnetLevels: {
        microLow?: number;
        majorLow?: number;
        microHigh?: number;
        majorHigh?: number;
        vwap?: number;
      };
      measuredMove?: number;
      expectedZone: { lower: number; upper: number };
      expectedEnd: number;
    };
  } {
    const risk = Math.abs(entry - stop);
    if (!Number.isFinite(risk) || risk <= 0 || atr <= 0) {
      // Fallback to basic R targets only
      const basicT1 = direction === "long" ? entry + risk : entry - risk;
      const basicT2 = direction === "long" ? entry + risk * 2 : entry - risk * 2;
      const basicT3 = direction === "long" ? entry + risk * 3 : entry - risk * 3;
      return {
        targets: [basicT1, basicT2, basicT3],
        targetZones: {
          rTargets: { t1: basicT1, t2: basicT2, t3: basicT3 },
          atrTargets: { t1: basicT1, t2: basicT2 },
          magnetLevels: {},
          expectedZone: { lower: basicT1, upper: basicT2 },
          expectedEnd: (basicT1 + basicT2) / 2,
        },
      };
    }

    // 1. Risk-unit targets (1R, 2R, 3R)
    const rT1 = direction === "long" ? entry + risk : entry - risk;
    const rT2 = direction === "long" ? entry + risk * 2 : entry - risk * 2;
    const rT3 = direction === "long" ? entry + risk * 3 : entry - risk * 3;

    // 2. ATR projection targets
    const k1 = 0.8; // Typical: 0.8 ATR
    const k2 = 1.6; // Typical: 1.6 ATR
    const atrT1 = direction === "long" ? entry + k1 * atr : entry - k1 * atr;
    const atrT2 = direction === "long" ? entry + k2 * atr : entry - k2 * atr;

    // 3. Magnet levels (prior lows/highs, VWAP)
    const magnetLevels: {
      microLow?: number;
      majorLow?: number;
      microHigh?: number;
      majorHigh?: number;
      vwap?: number;
    } = {};

    if (closed5mBars.length >= 6) {
      // Micro low/high (last 6-12 bars = 30-60 minutes)
      const microBars = closed5mBars.slice(-12);
      magnetLevels.microLow = Math.min(...microBars.map(b => b.low));
      magnetLevels.microHigh = Math.max(...microBars.map(b => b.high));
    }

    if (closed5mBars.length >= 24) {
      // Major low/high (last 24-36 bars = 2-3 hours)
      const majorBars = closed5mBars.slice(-36);
      magnetLevels.majorLow = Math.min(...majorBars.map(b => b.low));
      magnetLevels.majorHigh = Math.max(...majorBars.map(b => b.high));
    }

    if (vwap !== undefined && vwap > 0) {
      magnetLevels.vwap = vwap;
    }

    // 4. Measured move projection (for breakdowns/rejections)
    let measuredMove: number | undefined;
    if (direction === "short" && pullbackHigh !== undefined && impulseRange !== undefined && impulseRange > 0) {
      // Bearish: projection = pullbackHigh - impulseRange
      measuredMove = pullbackHigh - impulseRange;
    } else if (direction === "long" && pullbackLow !== undefined && impulseRange !== undefined && impulseRange > 0) {
      // Bullish: projection = pullbackLow + impulseRange
      measuredMove = pullbackLow + impulseRange;
    }

    // 5. Weighted expected zone (median of multiple methods)
    const candidateTargets: number[] = [rT1, atrT1];
    
    // Add magnet levels that are in the right direction
    if (direction === "short") {
      if (magnetLevels.microLow !== undefined && magnetLevels.microLow < entry) {
        candidateTargets.push(magnetLevels.microLow);
      }
      if (magnetLevels.majorLow !== undefined && magnetLevels.majorLow < entry) {
        candidateTargets.push(magnetLevels.majorLow);
      }
      if (magnetLevels.vwap !== undefined && magnetLevels.vwap < entry) {
        candidateTargets.push(magnetLevels.vwap);
      }
    } else {
      if (magnetLevels.microHigh !== undefined && magnetLevels.microHigh > entry) {
        candidateTargets.push(magnetLevels.microHigh);
      }
      if (magnetLevels.majorHigh !== undefined && magnetLevels.majorHigh > entry) {
        candidateTargets.push(magnetLevels.majorHigh);
      }
      if (magnetLevels.vwap !== undefined && magnetLevels.vwap > entry) {
        candidateTargets.push(magnetLevels.vwap);
      }
    }

    if (measuredMove !== undefined) {
      if ((direction === "short" && measuredMove < entry) || (direction === "long" && measuredMove > entry)) {
        candidateTargets.push(measuredMove);
      }
    }

    // Calculate median (ignores outliers)
    candidateTargets.sort((a, b) => a - b);
    const median = candidateTargets.length > 0
      ? candidateTargets[Math.floor(candidateTargets.length / 2)]
      : rT1;

    // Expected zone: median ± 0.3*ATR
    const zoneBuffer = 0.3 * atr;
    let expectedZone = {
      lower: median - zoneBuffer,
      upper: median + zoneBuffer,
    };

    // Ensure zone is in the right direction (below entry for shorts, above entry for longs)
    if (direction === "short") {
      // Short: zone should be below entry
      expectedZone.lower = Math.min(expectedZone.lower, entry);
      expectedZone.upper = Math.min(expectedZone.upper, entry);
      // Ensure lower < upper
      if (expectedZone.lower > expectedZone.upper) {
        const temp = expectedZone.lower;
        expectedZone.lower = expectedZone.upper;
        expectedZone.upper = temp;
      }
    } else {
      // Long: zone should be above entry
      expectedZone.lower = Math.max(expectedZone.lower, entry);
      expectedZone.upper = Math.max(expectedZone.upper, entry);
      // Ensure lower < upper
      if (expectedZone.lower > expectedZone.upper) {
        const temp = expectedZone.lower;
        expectedZone.lower = expectedZone.upper;
        expectedZone.upper = temp;
      }
    }

    return {
      targets: [rT1, rT2, rT3], // Legacy format
      targetZones: {
        rTargets: { t1: rT1, t2: rT2, t3: rT3 },
        atrTargets: { t1: atrT1, t2: atrT2 },
        magnetLevels,
        measuredMove,
        expectedZone,
        expectedEnd: median,
      },
    };
  }

  // Calculate derived confidence from base + structure + momentum - decay - penalty
  private calculateDerivedConfidence(
    exec: MinimalExecutionState,
    currentPrice: number,
    closed5mBars: Array<{ high: number; low: number; close: number }>,
    nowTs: number
  ): number {
    const baseBiasConfidence = exec.baseBiasConfidence ?? 50; // Default to 50 if no LLM confidence
    
    // Structure Alignment Score (0-20 points)
    // Check if price action aligns with bias structure
    let structureAlignmentScore = 0;
    if (exec.bias === "BEARISH" && exec.pullbackHigh !== undefined) {
      // Bearish: price should be below pullback high
      if (currentPrice < exec.pullbackHigh) {
        structureAlignmentScore = 15; // Good alignment
      } else if (currentPrice < exec.pullbackHigh * 1.002) {
        structureAlignmentScore = 10; // Near alignment
      } else {
        structureAlignmentScore = -10; // Misalignment penalty
      }
    } else if (exec.bias === "BULLISH" && exec.pullbackLow !== undefined) {
      // Bullish: price should be above pullback low
      if (currentPrice > exec.pullbackLow) {
        structureAlignmentScore = 15; // Good alignment
      } else if (currentPrice > exec.pullbackLow * 0.998) {
        structureAlignmentScore = 10; // Near alignment
      } else {
        structureAlignmentScore = -10; // Misalignment penalty
      }
    }

    // Momentum Confirmation (0-15 points)
    // Check if recent price action confirms bias direction
    let momentumConfirmation = 0;
    if (closed5mBars.length >= 2) {
      const recentBars = closed5mBars.slice(-3);
      if (exec.bias === "BEARISH") {
        // Bearish: check if recent closes are declining
        const declining = recentBars.every((bar, i) => 
          i === 0 || bar.close < recentBars[i - 1].close
        );
        if (declining) momentumConfirmation = 15;
        else if (recentBars[recentBars.length - 1].close < recentBars[0].close) {
          momentumConfirmation = 10;
        }
      } else if (exec.bias === "BULLISH") {
        // Bullish: check if recent closes are rising
        const rising = recentBars.every((bar, i) => 
          i === 0 || bar.close > recentBars[i - 1].close
        );
        if (rising) momentumConfirmation = 15;
        else if (recentBars[recentBars.length - 1].close > recentBars[0].close) {
          momentumConfirmation = 10;
        }
      }
    }

    // Time Decay (-0 to -20 points)
    // Confidence decays over time if no structure confirmation
    let timeDecay = 0;
    if (exec.biasTs !== undefined) {
      const hoursSinceBias = (nowTs - exec.biasTs) / (1000 * 60 * 60);
      if (hoursSinceBias > 4) {
        timeDecay = 20; // Full decay after 4 hours
      } else if (hoursSinceBias > 2) {
        timeDecay = 10; // Partial decay after 2 hours
      } else if (hoursSinceBias > 1) {
        timeDecay = 5; // Light decay after 1 hour
      }
    }

    // Adverse Excursion Penalty (-0 to -15 points)
    // Penalty if price moves significantly against bias
    let adverseExcursionPenalty = 0;
    if (exec.biasPrice !== undefined) {
      const priceChange = exec.bias === "BEARISH" 
        ? (currentPrice - exec.biasPrice) / exec.biasPrice // Bearish: penalty if price goes up
        : (exec.biasPrice - currentPrice) / exec.biasPrice; // Bullish: penalty if price goes down
      
      if (priceChange > 0.01) { // >1% adverse move
        adverseExcursionPenalty = Math.min(15, priceChange * 1500); // Cap at 15 points
      }
    }

    // Calculate final derived confidence
    const derivedConfidence = Math.max(0, Math.min(100, 
      baseBiasConfidence + 
      structureAlignmentScore + 
      momentumConfirmation - 
      timeDecay - 
      adverseExcursionPenalty
    ));

    const finalConfidence = Math.round(derivedConfidence);
    
    // Log confidence calculation details (only when significant change or every 5 minutes)
    const shouldLogConfidence = exec.biasConfidence === undefined || 
                                 Math.abs(finalConfidence - (exec.biasConfidence ?? 0)) > 5 ||
                                 (nowTs % (5 * 60 * 1000) < 60000); // Log roughly every 5 minutes
    
    if (shouldLogConfidence && exec.bias !== "NEUTRAL") {
      console.log(
        `[CONFIDENCE_CALC] bias=${exec.bias} base=${baseBiasConfidence} structure=${structureAlignmentScore} momentum=${momentumConfirmation} decay=${timeDecay} penalty=${adverseExcursionPenalty} final=${finalConfidence}`
      );
    }

    return finalConfidence;
  }

  // Generate "Why No Trade Fired" diagnostic (mechanical, never narrative)
  private generateNoTradeDiagnostic(
    exec: MinimalExecutionState,
    currentPrice: number,
    atr: number,
    closed5mBars: Array<{ high: number; low: number; close: number }>,
    ts: number // FIX: Pass timestamp to avoid split-brain (system time vs tick time)
  ): NoTradeDiagnostic | null {
    // Emit when: phase === PULLBACK_IN_PROGRESS OR setup === "NONE" (with bias)
    // Only if price moved > 0.75 ATR (to prevent spam)
    if (atr <= 0) return null;
    
    // Check if we should emit diagnostic
    const shouldEmit = (exec.phase === "PULLBACK_IN_PROGRESS") || 
                       (exec.setup === "NONE" && exec.bias !== "NEUTRAL");
    if (!shouldEmit) return null;

    // Check if price moved significantly
    const priceMoved = this.lastDiagnosticPrice !== null 
      ? Math.abs(currentPrice - this.lastDiagnosticPrice) > 0.75 * atr
      : false;

    if (!priceMoved && this.lastDiagnosticPrice !== null) return null;

    // Determine reason code (canonical, no ambiguity)
    let reasonCode: NoTradeReasonCode;
    let details: string;

    // First check: No setup detected
    if (exec.setup === "NONE" || !exec.setup) {
      reasonCode = "NO_GATE_ARMED"; // Reuse this code for "no setup"
      details = "No tradable setup detected - structure incomplete";
    } else if (!exec.resolutionGate || exec.resolutionGate.status === "INACTIVE") {
      reasonCode = "NO_GATE_ARMED";
      details = "Structure not mature - pullback levels not locked";
    } else if (exec.resolutionGate.status === "EXPIRED") {
      reasonCode = "GATE_EXPIRED";
      details = "Continuation occurred before trigger — move not chaseable";
    } else if (exec.resolutionGate.status === "INVALIDATED") {
      reasonCode = "GATE_INVALIDATED";
      details = "Structure broke against bias";
    } else if (exec.resolutionGate.status === "ARMED") {
      // Gate is armed but not triggered - check why
      // FIX: Use tick timestamp instead of Date.now() to avoid split-brain
      const timeExpired = ts > exec.resolutionGate.expiryTs;
      const priceBeyondTrigger = exec.resolutionGate.direction === "short"
        ? currentPrice < exec.resolutionGate.triggerPrice - 0.5 * atr
        : currentPrice > exec.resolutionGate.triggerPrice + 0.5 * atr;
      
      if (timeExpired) {
        reasonCode = "GATE_EXPIRED";
        details = "Gate expired - continuation window closed";
      } else if (priceBeyondTrigger) {
        reasonCode = "GATE_EXPIRED";
        details = "Continuation occurred without structure — move not chaseable";
      } else {
        reasonCode = "AWAITING_PULLBACK_COMPLETION";
        details = "Gate armed, awaiting trigger price";
      }
    } else {
      reasonCode = "AWAITING_PULLBACK_COMPLETION";
      details = "Awaiting pullback completion";
    }

    // Check for session constraints (simplified - would check actual session times)
    // FIX: Use tick timestamp instead of system time to avoid split-brain
    const regime = getMarketRegime(new Date(ts));
    if (!regime.isRTH) {
      // DEBUG: Log timezone/clock mismatch
      const nowDate = new Date(ts);
      const nowET = getETDateString(nowDate);
      console.log(
        `[NO_TRADE_DIAGNOSTIC] Market closed check: ts=${ts} nowDate=${nowDate.toISOString()} nowET=${nowET} nowETTime=${regime.nowEt} isRTH=${regime.isRTH} regime=${regime.regime}`
      );
      reasonCode = "SESSION_CONSTRAINT";
      details = "Market closed or outside trading hours";
    }

    // Volatility check (simplified - would use actual volatility calculation)
    // For now, we'll skip VOL_TOO_HIGH as it requires more sophisticated volatility tracking

    return {
      price: currentPrice,
      bias: exec.bias,
      phase: exec.phase,
      expectedResolution: exec.expectedResolution,
      gateStatus: exec.resolutionGate?.status,
      reasonCode,
      details,
    };
  }

  // Emit diagnostic log
  private emitNoTradeDiagnostic(diagnostic: NoTradeDiagnostic): void {
      console.log(
      `NO_TRADE: price=${diagnostic.price.toFixed(2)} bias=${diagnostic.bias} phase=${diagnostic.phase} expected=${diagnostic.expectedResolution ?? "n/a"} gate=${diagnostic.gateStatus ?? "n/a"} reason=${diagnostic.reasonCode} details="${diagnostic.details}"`
    );
  }

  // Detect if continuation has started (expected continuation now in progress)
  private detectContinuation(
    bias: MarketBias,
    expectedResolution: ExpectedResolution | undefined,
    current5m: { high: number; low: number; close: number },
    previous5m: { high: number; low: number; close: number } | undefined,
    pullbackHigh?: number,
    pullbackLow?: number,
    closed5mBars?: Array<{ high: number; low: number; close: number }>
  ): boolean {
    // Preconditions
    if (expectedResolution !== "CONTINUATION" || bias === "NEUTRAL" || !previous5m) {
      return false;
    }

    // Rule Set A: Structural Break (mandatory)
    let structuralBreak = false;
    if (bias === "BULLISH" && pullbackHigh !== undefined) {
      structuralBreak = current5m.close > pullbackHigh;
    } else if (bias === "BEARISH" && pullbackLow !== undefined) {
      structuralBreak = current5m.close < pullbackLow;
    }
    
    if (!structuralBreak) {
      return false; // Must have structural break
    }

    // Rule Set B: Momentum Confirmation (at least one)
    let momentumConfirmed = false;
    
    // Option 1: Range expansion (current bar range > average of last N bars)
    if (closed5mBars && closed5mBars.length >= 3) {
      const currentRange = Math.abs(current5m.high - current5m.low);
      const recentBars = closed5mBars.slice(-5); // Last 5 bars
      const avgRange = recentBars.reduce((sum, b) => sum + Math.abs(b.high - b.low), 0) / recentBars.length;
      if (currentRange > avgRange * 1.2) {
        momentumConfirmed = true;
      }
    }
    
    // Option 2: Price momentum (close direction matches bias)
    if (!momentumConfirmed) {
      if (bias === "BULLISH" && current5m.close > previous5m.close) {
        momentumConfirmed = true;
      } else if (bias === "BEARISH" && current5m.close < previous5m.close) {
        momentumConfirmed = true;
      }
    }

    if (!momentumConfirmed) {
      return false; // Must have momentum confirmation
    }

    // Rule Set C: Acceptance (anti-fakeout) - close outside pullback range
    let acceptanceConfirmed = false;
    if (bias === "BULLISH" && pullbackHigh !== undefined) {
      acceptanceConfirmed = current5m.close > pullbackHigh;
    } else if (bias === "BEARISH" && pullbackLow !== undefined) {
      acceptanceConfirmed = current5m.close < pullbackLow;
    }

    return structuralBreak && momentumConfirmed && acceptanceConfirmed;
  }

  // Check if entry should be blocked (no-chase rules)
  // Includes target zone-based "don't chase" rules
  private shouldBlockEntry(
    bias: MarketBias,
    phase: MinimalExecutionPhase,
    currentPrice: number,
    pullbackHigh?: number,
    pullbackLow?: number,
    atr?: number,
    targetZones?: {
      expectedZone: { lower: number; upper: number };
      expectedEnd: number;
    }
  ): { blocked: boolean; reason?: string } {
    // Only check blocking during continuation
    if (phase !== "CONTINUATION_IN_PROGRESS") {
      return { blocked: false };
    }

    if (pullbackHigh === undefined && pullbackLow === undefined) {
      return { blocked: false };
    }

    // Rule 1: Extended Distance
    let continuationExtension = 0;
    let pullbackRange = 0;
    
    if (bias === "BULLISH" && pullbackHigh !== undefined) {
      continuationExtension = currentPrice - pullbackHigh;
      // Estimate pullback range (use a reasonable default if not available)
      pullbackRange = pullbackHigh - (pullbackLow ?? pullbackHigh * 0.998);
    } else if (bias === "BEARISH" && pullbackLow !== undefined) {
      continuationExtension = pullbackLow - currentPrice;
      pullbackRange = (pullbackHigh ?? pullbackLow * 1.002) - pullbackLow;
    }

    if (pullbackRange > 0 && continuationExtension > pullbackRange * 1.25) {
      return { blocked: true, reason: "continuation_extended" };
    }

    // Don't-chase rule: if price is already > 0.8*ATR below ideal trigger (for shorts)
    // or > 0.8*ATR above ideal trigger (for longs), don't enter
    if (atr !== undefined && atr > 0) {
      if (bias === "BEARISH" && pullbackLow !== undefined) {
        const idealTrigger = pullbackLow;
        const distanceBelow = idealTrigger - currentPrice;
        if (distanceBelow > 0.8 * atr) {
          return { blocked: true, reason: "continuation_extended" };
        }
      } else if (bias === "BULLISH" && pullbackHigh !== undefined) {
        const idealTrigger = pullbackHigh;
        const distanceAbove = currentPrice - idealTrigger;
        if (distanceAbove > 0.8 * atr) {
          return { blocked: true, reason: "continuation_extended" };
        }
      }
    }

    // Don't-chase rule: if price is already past expected zone, don't enter
    if (targetZones !== undefined) {
      if (bias === "BEARISH" && currentPrice < targetZones.expectedZone.lower) {
        return { blocked: true, reason: "price_past_expected_zone" };
      } else if (bias === "BULLISH" && currentPrice > targetZones.expectedZone.upper) {
        return { blocked: true, reason: "price_past_expected_zone" };
      }
    }

    return { blocked: false };
  }

  // Detect momentum pause or compression (transition to re-entry window)
  private detectMomentumPause(
    bias: MarketBias,
    current5m: { high: number; low: number; close: number },
    previous5m: { high: number; low: number; close: number } | undefined,
    closed5mBars: Array<{ high: number; low: number; close: number }>,
    impulseRange?: number
  ): boolean {
    if (!previous5m || !impulseRange || impulseRange <= 0) {
      return false;
    }

    // Rule B: Range Compression
    const currentRange = Math.abs(current5m.high - current5m.low);
    const previousRange = Math.abs(previous5m.high - previous5m.low);
    const avgRange = (currentRange + previousRange) / 2;
    
    if (avgRange < 0.6 * impulseRange) {
      return true; // Range compression detected
    }

    // Rule A: Momentum Pause (price momentum stalls)
    if (bias === "BULLISH") {
      // Bullish: price should be rising, if it stalls or reverses, pause detected
      if (current5m.close <= previous5m.close && current5m.high <= previous5m.high) {
        return true;
      }
    } else if (bias === "BEARISH") {
      // Bearish: price should be falling, if it stalls or reverses, pause detected
      if (current5m.close >= previous5m.close && current5m.low >= previous5m.low) {
        return true;
      }
    }

    return false;
  }

  // Detect valid re-entry after continuation
  private detectReentry(
    bias: MarketBias,
    current5m: { high: number; low: number; close: number; open?: number },
    previous5m: { high: number; low: number; close: number; open?: number } | undefined,
    continuationHigh?: number,
    continuationLow?: number,
    impulseRange?: number
  ): { valid: boolean; pullbackHigh?: number; pullbackLow?: number } {
    if (!previous5m || !impulseRange || impulseRange <= 0) {
      return { valid: false };
    }

    const currentOpen = current5m.open ?? current5m.close;
    const previousOpen = previous5m.open ?? previous5m.close;

    // Rule Set A: Shallow Pullback (mandatory)
    let shallowPullback = false;
    let reentryPullbackHigh: number | undefined = undefined;
    let reentryPullbackLow: number | undefined = undefined;

    if (bias === "BULLISH" && continuationLow !== undefined) {
      const minPullbackLow = continuationLow + 0.38 * impulseRange;
      if (current5m.low >= minPullbackLow) {
        shallowPullback = true;
        reentryPullbackLow = current5m.low;
        reentryPullbackHigh = current5m.high;
      }
    } else if (bias === "BEARISH" && continuationHigh !== undefined) {
      const maxPullbackHigh = continuationHigh - 0.38 * impulseRange;
      if (current5m.high <= maxPullbackHigh) {
        shallowPullback = true;
        reentryPullbackHigh = current5m.high;
        reentryPullbackLow = current5m.low;
      }
    }

    if (!shallowPullback) {
      return { valid: false };
    }

    // Rule Set B: Structure Preservation (mandatory)
    // For bullish: must not break below continuation low
    // For bearish: must not break above continuation high
    let structurePreserved = false;
    if (bias === "BULLISH" && continuationLow !== undefined) {
      structurePreserved = current5m.low >= continuationLow;
    } else if (bias === "BEARISH" && continuationHigh !== undefined) {
      structurePreserved = current5m.high <= continuationHigh;
    }

    if (!structurePreserved) {
      return { valid: false };
    }

    // Rule Set C: Re-Ignition Signal (one required)
    let reIgnition = false;

    // Option 1: Engulfing candle
    if (bias === "BULLISH") {
      const isBullishEngulfing = current5m.close > currentOpen && 
        previous5m.close < previousOpen &&
        current5m.close > previousOpen &&
        currentOpen < previous5m.close;
      if (isBullishEngulfing) reIgnition = true;
    } else if (bias === "BEARISH") {
      const isBearishEngulfing = current5m.close < currentOpen &&
        previous5m.close > previousOpen &&
        current5m.close < previousOpen &&
        currentOpen > previous5m.close;
      if (isBearishEngulfing) reIgnition = true;
    }

    // Option 2: Break of micro range (price breaks previous bar high/low in bias direction)
    if (!reIgnition) {
      if (bias === "BULLISH" && current5m.high > previous5m.high && current5m.close > previous5m.close) {
        reIgnition = true;
      } else if (bias === "BEARISH" && current5m.low < previous5m.low && current5m.close < previous5m.close) {
        reIgnition = true;
      }
    }

    if (reIgnition) {
      return { valid: true, pullbackHigh: reentryPullbackHigh, pullbackLow: reentryPullbackLow };
    }

    return { valid: false };
  }

  // Check if re-entry should be blocked
  private shouldBlockReentry(
    bias: MarketBias,
    currentPrice: number,
    barsSinceContinuation?: number,
    closed5mBars?: Array<{ high: number; low: number; close: number }>
  ): { blocked: boolean; reason?: string } {
    // Rule 3: Time Decay
    if (barsSinceContinuation !== undefined && barsSinceContinuation > 8) {
      return { blocked: true, reason: "reentry_window_expired" };
    }

    // Rule 1: Too Much Distance (simplified - would need VWAP for full implementation)
    // Rule 2: Exhaustion Signals (would need RSI/volume - simplified for now)
    // These can be enhanced later with actual indicators

    return { blocked: false };
  }

  // Detect if pullback is failing (structure breaking against bias)
  private detectPullbackFailure(
    bias: MarketBias,
    expectedResolution: ExpectedResolution | undefined,
    current5m: { high: number; low: number; close: number },
    previous5m?: { high: number; low: number; close: number },
    pullbackHigh?: number,
    pullbackLow?: number
  ): boolean {
    if (expectedResolution !== "CONTINUATION") {
      return false; // Only check for failure if we expect continuation
    }

    if (!previous5m) {
      return false; // Need previous bar for structure comparison
    }

    // For BEARISH bias: failure = structure printing higher high and holding
    if (bias === "BEARISH") {
      const hasHigherHigh = current5m.high > previous5m.high;
      const isHoldingAbove = current5m.close > previous5m.close;
      // If we have pullback high, check if price is breaking above it
      if (pullbackHigh && current5m.high > pullbackHigh) {
        return true; // Breaking above pullback high = failure
      }
      // Structure failure: higher high + holding above
      return hasHigherHigh && isHoldingAbove;
    }

    // For BULLISH bias: failure = structure printing lower low and holding
    if (bias === "BULLISH") {
      const hasLowerLow = current5m.low < previous5m.low;
      const isHoldingBelow = current5m.close < previous5m.close;
      // If we have pullback low, check if price is breaking below it
      if (pullbackLow && current5m.low < pullbackLow) {
        return true; // Breaking below pullback low = failure
      }
      // Structure failure: lower low + holding below
      return hasLowerLow && isHoldingBelow;
    }

    return false;
  }

  // Generate phase-aware reason that never contradicts bias
  private getPhaseAwareReason(bias: MarketBias, phase: MinimalExecutionPhase, waitReason?: string, execReason?: string): string {
    // If in trade and entry-aligned reason exists, use it (single pipeline proof)
    if (phase === "IN_TRADE" && execReason) {
      return execReason;
    }

    // Never infer bias from phase - bias is authoritative
    if (bias === "NEUTRAL") {
      return "No bias established, waiting for market structure";
    }

    const biasLabel = bias === "BEARISH" ? "bearish" : "bullish";
    
    switch (phase) {
      case "NEUTRAL_PHASE":
        return `No ${biasLabel} bias established yet`;
      
      case "BIAS_ESTABLISHED":
        return `${biasLabel.charAt(0).toUpperCase() + biasLabel.slice(1)} bias established, waiting for pullback`;
      
      case "PULLBACK_IN_PROGRESS":
        return `Counter-trend pullback developing within ${biasLabel} structure, expecting continuation`;
      
      case "PULLBACK_REJECTION":
        return `Pullback rejected, ${biasLabel} structure intact`;
      
      case "PULLBACK_BREAKDOWN":
        return `Pullback breaking down, ${biasLabel} move resuming`;
      
      case "IN_TRADE":
        return `In ${biasLabel} trade, managing position`;
      
      case "CONSOLIDATION_AFTER_REJECTION":
        return `Consolidating after rejection, ${biasLabel} bias maintained`;
      
      case "CONTINUATION_IN_PROGRESS":
        return `${biasLabel.charAt(0).toUpperCase() + biasLabel.slice(1)} continuation underway`;
      
      case "REENTRY_WINDOW":
        return `Post-continuation pause detected, awaiting shallow pullback`;
      
      default:
        // Fallback to waitReason if provided, but never say "neutral bias" when bias exists
        if (waitReason && !waitReason.toLowerCase().includes("neutral bias")) {
          return waitReason;
        }
        return `${biasLabel.charAt(0).toUpperCase() + biasLabel.slice(1)} bias maintained`;
    }
  }

  // ============================================================================
  // SINGLE AUTHORITATIVE 5M CLOSE REDUCER
  // ============================================================================
  // This function runs in strict order on every 5m close:
  // 1. Apply bias from LLM (if available)
  // 2. Update phase deterministically (engine-owned, never from LLM)
  // 3. Run setup detection (closed bars only)
  // 4. Update gate (disarm if setup is NONE, arm if setup exists)
  // 5. Check consistency
  // 6. Generate diagnostics
  // ============================================================================
  private reduce5mClose(
    exec: MinimalExecutionState,
    ts: number,
    close: number,
    closed5mBars: Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }>,
    lastClosed5m: { ts: number; open: number; high: number; low: number; close: number; volume: number } | null,
    forming5mBar: Forming5mBar | null,
    llmDecision: { action: string; bias: string; confidence: number; maturity?: string; waiting_for?: string } | null
  ): { shouldPublishEvent: boolean; noTradeReason?: string } {
    const previousBias = exec.bias;
    const previousPhase = exec.phase;
    const previousSetup = exec.setup;
    let shouldPublishEvent = false;

    // ============================================================================
    // STEP 1: Apply bias from LLM (if available)
    // ============================================================================
    if (llmDecision !== null) {
      const llmDirection: "long" | "short" | "none" = 
        llmDecision.action === "ARM_LONG" ? "long" :
        llmDecision.action === "ARM_SHORT" ? "short" :
        llmDecision.action === "A+" ? (llmDecision.bias === "bearish" ? "short" : "long") : "none";
      
      const newBias = this.llmActionToBias(llmDecision.action as "ARM_LONG" | "ARM_SHORT" | "WAIT" | "A+", llmDecision.bias as "bullish" | "bearish" | "neutral");
      console.log(
        `[LLM_BIAS_MAP] action=${llmDecision.action} llmBias=${llmDecision.bias} -> execBias=${newBias}`
      );
      const shouldFlip = this.shouldFlipBias(
        exec.bias,
        newBias,
        exec.biasInvalidationLevel,
        close
      );

      if (shouldFlip || exec.bias === "NEUTRAL") {
        // Deactivate gate if bias flips
        if (exec.bias !== newBias && exec.bias !== "NEUTRAL") {
          this.deactivateGate(exec);
        }
        exec.bias = newBias;
        exec.baseBiasConfidence = llmDecision.confidence;
        exec.biasPrice = close;
        exec.biasTs = ts;
        if (exec.activeCandidate) {
          exec.biasInvalidationLevel = exec.activeCandidate.invalidationLevel;
        }
        exec.biasConfidence = this.calculateDerivedConfidence(exec, close, closed5mBars, ts);
        shouldPublishEvent = true;
      }

      // Legacy compatibility
      exec.thesisDirection = exec.bias === "BULLISH" ? "long" : exec.bias === "BEARISH" ? "short" : "none";
      if (exec.bias !== "NEUTRAL") {
        exec.biasConfidence = this.calculateDerivedConfidence(exec, close, closed5mBars, ts);
      exec.thesisConfidence = exec.biasConfidence;
      }

      console.log(
        `[LLM5M] action=${llmDecision.action} bias=${exec.bias} baseConf=${exec.baseBiasConfidence ?? llmDecision.confidence} derivedConf=${exec.biasConfidence ?? "n/a"}`
      );
    }

    // ============================================================================
    // STEP 2: Update phase deterministically (engine-owned, never from LLM)
    // ============================================================================
    // Phase transitions are based on bias, confidence, and market structure
    // LLM never sets phase directly
    if (exec.bias !== "NEUTRAL" && exec.biasConfidence !== undefined && exec.biasConfidence >= 65) {
      // Bias is established with sufficient confidence
      if (exec.phase === "NEUTRAL_PHASE") {
        exec.phase = "BIAS_ESTABLISHED";
        exec.expectedResolution = "CONTINUATION";
        exec.waitReason = "waiting_for_pullback";
        shouldPublishEvent = true;
        console.log(
          `[PHASE_TRANSITION] ${previousPhase} -> BIAS_ESTABLISHED | BIAS=${exec.bias} confidence=${exec.biasConfidence}`
        );
      } else if (exec.phase === "BIAS_ESTABLISHED" && lastClosed5m) {
        // Check if pullback is developing
        const current5m = forming5mBar ?? lastClosed5m;
        if (exec.pullbackHigh !== undefined && exec.pullbackLow !== undefined) {
          const inPullback = (exec.bias === "BEARISH" && current5m.close < exec.pullbackHigh) ||
                           (exec.bias === "BULLISH" && current5m.close > exec.pullbackLow);
          if (inPullback) {
            exec.phase = "PULLBACK_IN_PROGRESS";
            exec.expectedResolution = "CONTINUATION";
            shouldPublishEvent = true;
            console.log(
              `[PHASE_TRANSITION] ${previousPhase} -> PULLBACK_IN_PROGRESS | BIAS=${exec.bias}`
            );
          }
        }
      }
    } else if (exec.bias === "NEUTRAL") {
      if (exec.phase !== "NEUTRAL_PHASE") {
        exec.phase = "NEUTRAL_PHASE";
        exec.waitReason = "waiting_for_bias";
        shouldPublishEvent = true;
        console.log(
          `[PHASE_TRANSITION] ${previousPhase} -> NEUTRAL_PHASE | BIAS=NEUTRAL`
        );
      }
    }

    // ============================================================================
    // STEP 3: Run setup detection (closed bars only, with TTL persistence)
    // ============================================================================
    const setupTTLDuration = 2 * 5 * 60 * 1000; // 2 bars = 10 minutes
    const setupTTLExpiry = (exec.setupDetectedAt ?? 0) + setupTTLDuration;
    const now = ts;
    
    // Check if current setup should persist (TTL not expired and not invalidated)
    if (exec.setup && exec.setup !== "NONE" && now < setupTTLExpiry) {
      // Check for invalidation: price breaks setup stop
      const invalidated = (exec.bias === "BEARISH" && exec.setupStopPrice !== undefined && close > exec.setupStopPrice) ||
                         (exec.bias === "BULLISH" && exec.setupStopPrice !== undefined && close < exec.setupStopPrice);
      
      if (invalidated) {
        console.log(
          `[SETUP_INVALIDATED] ${exec.setup} -> NONE | Price broke stop - bias=${exec.bias} price=${close.toFixed(2)} stop=${exec.setupStopPrice?.toFixed(2) ?? "n/a"}`
        );
        exec.setup = "NONE";
        exec.setupTriggerPrice = undefined;
        exec.setupStopPrice = undefined;
        exec.setupDetectedAt = undefined;
      } else {
        // Setup persists - skip re-detection
        console.log(
          `[SETUP_PERSISTS] ${exec.setup} | TTL valid until ${new Date(setupTTLExpiry).toISOString()}`
        );
      }
    }
    
    // Only run setup detection if:
    // - Setup is NONE, OR
    // - Setup TTL expired, OR
    // - Setup was invalidated above
    if (exec.setup === "NONE" || !exec.setup || now >= setupTTLExpiry) {
      if (exec.bias === "NEUTRAL") {
        exec.setup = "NONE";
        exec.setupTriggerPrice = undefined;
        exec.setupStopPrice = undefined;
      } else if (lastClosed5m) {
        const previous5m = closed5mBars.length >= 2 ? closed5mBars[closed5mBars.length - 2] : undefined;
        const atr = this.calculateATR(closed5mBars);
        const setupResult = this.detectSetup(exec, lastClosed5m, previous5m, closed5mBars, atr, null); // Never use forming bar
        
        const oldSetup = exec.setup;
        
        // Handle setup transition (resets gate cleanly)
        this.onSetupTransition(exec, oldSetup, setupResult.setup, ts);
        
        exec.setup = setupResult.setup;
        exec.setupTriggerPrice = setupResult.triggerPrice;
        exec.setupStopPrice = setupResult.stopPrice;
        
        if (oldSetup !== setupResult.setup) {
          exec.setupDetectedAt = ts;
          
          // Log setup change with reason
          const setupChangeReason = setupResult.setup === "NONE" 
            ? (oldSetup ? `setup_invalidated` : `no_setup_detected`)
            : `setup_detected`;
          console.log(
            `[SETUP_DETECTED] ${oldSetup ?? "NONE"} -> ${setupResult.setup} | BIAS=${exec.bias} PHASE=${exec.phase} trigger=${setupResult.triggerPrice?.toFixed(2) ?? "n/a"} stop=${setupResult.stopPrice?.toFixed(2) ?? "n/a"} reason=${setupChangeReason}`
          );
          
          // Enhanced [SETUP_CLEARED] log with more context
          if (setupResult.setup === "NONE" && oldSetup && oldSetup !== "NONE") {
            const pullbackInfo = exec.pullbackHigh !== undefined && exec.pullbackLow !== undefined
              ? `pullbackLow=${exec.pullbackLow.toFixed(2)} pullbackHigh=${exec.pullbackHigh.toFixed(2)}`
              : "pullbackLevels=undefined";
            console.log(
              `[SETUP_CLEARED] priorSetup=${oldSetup} bias=${exec.bias} phase=${exec.phase} reason=${setupChangeReason} price=${close.toFixed(2)} ${pullbackInfo}`
            );
          }
        }
      }
    }

    // ============================================================================
    // STEP 4: OpportunityLatch Management (replaces separated gate mess)
    // ============================================================================
    // This is the single execution gate that composes all permissions
    // Phase = story, Setup = pattern label, OpportunityLatch = "I'm ready to shoot"
    // ============================================================================
    
    const atr = this.calculateATR(closed5mBars);
    
    // First, check if existing opportunity should be invalidated
    if (exec.opportunity && exec.opportunity.status === "LATCHED") {
      const invalidationCheck = this.shouldInvalidateOpportunity(
        exec.opportunity,
        exec,
        close,
        ts,
        atr
      );
      
      if (invalidationCheck.invalidated) {
        exec.opportunity.status = "INVALIDATED";
        console.log(
          `[OPPORTUNITY_INVALIDATED] ${exec.opportunity.side} reason=${invalidationCheck.reason}`
        );
        exec.opportunity = undefined;
      }
    }
    
    // ============================================================================
    // BIAS FLIP ENTRY: Arm gate on bias flip (independent of setup detection)
    // ============================================================================
    // This runs AFTER bias is updated but BEFORE setup detection
    // It's independent - doesn't care if exec.setup=NONE
    // ============================================================================
    if (lastClosed5m && exec.bias !== "NEUTRAL") {
      const closedBarsWithVolume = closed5mBars.filter(bar => 'volume' in bar) as Array<{ high: number; low: number; close: number; volume: number }>;
      const vwap = closedBarsWithVolume.length > 0 ? this.calculateVWAP(closedBarsWithVolume) : undefined;
      this.maybeArmBiasFlipGate(exec, previousBias, lastClosed5m, atr, vwap, ts);
    }

    // ============================================================================
    // OPPORTUNITYLATCH: Make optional/automatic when bias is established
    // ============================================================================
    // For pullback engine, automatically ensure opportunity latch when bias is established
    // This removes "no_opportunity_latched" blocking for basic pullback continuation
    // ============================================================================
    const latchCreated = this.ensureOpportunityLatch(exec, ts, close, atr);
    if (latchCreated) {
      // Force event emission after latching to update Telegram immediately
      shouldPublishEvent = true;
      console.log(
        `[OPP_LATCHED_EVENT] Forcing state snapshot after opportunity latch - bias=${exec.bias} phase=${exec.phase}`
      );
    }
    
    // ============================================================================
    // STEP 5: Gate Arming (explicit criteria for PULLBACK_CONTINUATION)
    // ============================================================================
    // Gate lifecycle must reset on setup change (handled above)
    // Now attempt to ARM if setup is PULLBACK_CONTINUATION and criteria are met
    // ============================================================================
    if (exec.setup === "NONE" || !exec.setup) {
      // No setup - ensure gate is disarmed
      if (exec.resolutionGate && exec.resolutionGate.status === "ARMED") {
        this.deactivateGate(exec);
        console.log(`[GATE_DEACTIVATED] Setup=NONE - gate disarmed`);
      }
    } else if (exec.setup === "PULLBACK_CONTINUATION") {
      // Attempt to arm gate for PULLBACK_CONTINUATION setup using explicit criteria
      const atrForGate = this.calculateATR(closed5mBars);
      const previous5m = closed5mBars.length >= 2 ? closed5mBars[closed5mBars.length - 2] : undefined;
      
      // Use the new explicit arming function (5m close - no 1m data available here)
      const armResult = this.tryArmPullbackGate(
        exec,
        close,
        lastClosed5m,
        previous5m,
        closed5mBars,
        atrForGate,
        ts,
        undefined, // No 1m bar data on 5m close
        undefined
      );
      
      if (armResult.armed && !exec.resolutionGate) {
        // Gate doesn't exist - create/arm it
        exec.resolutionGate = {
          status: "ARMED",
          direction: exec.bias === "BULLISH" ? "long" : "short",
          triggerPrice: armResult.trigger,
          stopPrice: armResult.stop,
          expiryTs: ts + 2 * 5 * 60 * 1000, // 2 timeframes (10 minutes)
          armedTs: ts,
          reason: armResult.reason,
        };
        
        const expiryInMin = Math.floor((exec.resolutionGate.expiryTs - ts) / (60 * 1000));
        console.log(
          `[GATE_ARMED] setup=PULLBACK_CONTINUATION bias=${exec.bias} trigger=${armResult.trigger.toFixed(2)} stop=${armResult.stop.toFixed(2)} reason=${armResult.reason} expiryInMin=${expiryInMin}`
        );
      } else if (!armResult.armed) {
        // Gate not armed - log why with enhanced details
        const closedBarsWithVolume = closed5mBars.filter(bar => 'volume' in bar) as Array<{ high: number; low: number; close: number; volume: number }>;
        const vwap = closedBarsWithVolume.length > 0 ? this.calculateVWAP(closedBarsWithVolume) : undefined;
        const confidence = exec.biasConfidence ?? 0;
        
        console.log(
          `[GATE_NOT_ARMED] bias=${exec.bias} phase=${exec.phase} conf=${confidence} setup=${exec.setup} reason=${armResult.reason} price=${close.toFixed(2)} vwap=${vwap?.toFixed(2) ?? "n/a"} pullbackLow=${exec.pullbackLow?.toFixed(2) ?? "n/a"} pullbackHigh=${exec.pullbackHigh?.toFixed(2) ?? "n/a"}`
        );
      }
    }

    // ============================================================================
    // STEP 5: Consistency checks (architecture-aligned invariants)
    // ============================================================================
    const consistencyErrors: string[] = [];
    const consistencyWarnings: string[] = [];

    const entryStatus = exec.phase === "IN_TRADE" ? "active" : "inactive";

    // ------------------------------------------------------------------
    // Invariant 1: Strong bias should not coexist with NEUTRAL_PHASE
    // ------------------------------------------------------------------
    if (
      exec.bias !== "NEUTRAL" &&
      exec.phase === "NEUTRAL_PHASE" &&
      exec.biasConfidence !== undefined &&
      exec.biasConfidence >= 65
    ) {
      consistencyErrors.push(
        `INVALID: bias=${exec.bias} but phase=NEUTRAL_PHASE (confidence=${exec.biasConfidence})`
      );
    }

    // ------------------------------------------------------------------
    // Invariant 2: Entry active => must be IN_TRADE
    // ------------------------------------------------------------------
    if (entryStatus === "active" && exec.phase !== "IN_TRADE") {
      consistencyErrors.push(
        `INVALID: entryStatus=active but phase=${exec.phase}`
      );
    }

    // ------------------------------------------------------------------
    // Invariant 3: IN_TRADE must have entryType
    // ------------------------------------------------------------------
    if (exec.phase === "IN_TRADE" && !exec.entryType) {
      consistencyErrors.push(
        `INVALID: phase=IN_TRADE but entryType missing`
      );
    }

    // ------------------------------------------------------------------
    // Soft invariant: Pullback-style entries should usually have setup
    // (BiasFlip / Triggered are allowed to bypass setup)
    // ------------------------------------------------------------------
    const setupRequiredTypes = new Set([
      "PULLBACK_ENTRY",
      "PULLBACK_CONTINUATION",
    ]);

    if (
      exec.phase === "IN_TRADE" &&
      setupRequiredTypes.has(exec.entryType ?? "") &&
      (exec.setup === "NONE" || !exec.setup)
    ) {
      consistencyWarnings.push(
        `WARN: ${exec.entryType} entered with setup=NONE`
      );
    }

    // ------------------------------------------------------------------
    // Observability log (always)
    // ------------------------------------------------------------------
    const baseContext =
      `bias=${exec.bias} phase=${exec.phase} setup=${exec.setup} ` +
      `gate=${exec.resolutionGate?.status ?? "none"} entry=${entryStatus} ` +
      `entryType=${exec.entryType ?? "none"}`;

    if (consistencyErrors.length > 0) {
      console.error(
        `[CONSISTENCY_CHECK] ERROR: ${consistencyErrors.join(" | ")} | ${baseContext}`
      );
    } else if (consistencyWarnings.length > 0) {
      console.warn(
        `[CONSISTENCY_CHECK] WARN: ${consistencyWarnings.join(" | ")} | ${baseContext}`
      );
    } else {
      console.log(
        `[CONSISTENCY_CHECK] OK | ${baseContext}`
      );
    }

    // ============================================================================
    // STEP 6: Generate "why no trade" diagnostic (if applicable)
    // ============================================================================
    let noTradeReason: string | undefined = undefined;
    if (exec.phase !== "IN_TRADE" && exec.bias !== "NEUTRAL") {
      // Priority-ordered reasons
      if (exec.biasConfidence === undefined || exec.biasConfidence < 65) {
        noTradeReason = `bias_confidence_below_threshold (${exec.biasConfidence ?? "undefined"})`;
      } else if (exec.phase === "NEUTRAL_PHASE") {
        noTradeReason = `phase_not_ready (phase=NEUTRAL_PHASE)`;
      } else if (exec.setup === "NONE" || !exec.setup) {
        noTradeReason = `setup_none (no tradable pattern detected)`;
      } else if (exec.resolutionGate?.status !== "ARMED" && exec.resolutionGate?.status !== "TRIGGERED") {
        noTradeReason = `gate_not_armed (gate=${exec.resolutionGate?.status ?? "none"})`;
      } else if (exec.resolutionGate?.status === "ARMED") {
        noTradeReason = `price_didnt_cross_trigger (price=${close.toFixed(2)} trigger=${exec.resolutionGate.triggerPrice.toFixed(2)})`;
      }
    }

    // Determine if we should emit heartbeat (while blocked, every 5 minutes)
    const heartbeatInterval = 5 * 60 * 1000; // 5 minutes
    const shouldEmitHeartbeat = 
      exec.phase !== "IN_TRADE" && 
      exec.bias !== "NEUTRAL" && 
      (this.lastHeartbeatTs === null || (ts - this.lastHeartbeatTs) >= heartbeatInterval) &&
      (exec.setup === "NONE" || exec.entryBlocked || noTradeReason !== undefined);
    
    if (shouldEmitHeartbeat) {
      shouldPublishEvent = true; // Force event emission for heartbeat
      this.lastHeartbeatTs = ts;
      console.log(
        `[HEARTBEAT] Blocked state - bias=${exec.bias} phase=${exec.phase} setup=${exec.setup} gate=${exec.resolutionGate?.status ?? "none"} reason=${noTradeReason ?? "waiting"}`
      );
    }

    return { shouldPublishEvent, noTradeReason };
  }

  private async handleMinimal1m(snapshot: TickSnapshot): Promise<DomainEvent[]> {
    const { ts, symbol, close } = snapshot;
    const events: DomainEvent[] = [];
    
    // ============================================================================
    // RULE 2: Guard against out-of-order ticks
    // ============================================================================
    if (this.lastProcessedTs !== null && ts < this.lastProcessedTs) {
      console.log(
        `[STALE_TICK_IGNORED] ts=${ts} lastProcessed=${this.lastProcessedTs} delta=${ts - this.lastProcessedTs} - Out of order tick ignored`
      );
      return events; // Ignore stale ticks - never mutate state
    }
    this.lastProcessedTs = ts;
    
    const regime = getMarketRegime(new Date(ts));
    
    // DEBUG: Log timezone/clock mismatch detection
    const nowDate = new Date(ts);
    const nowET = getETDateString(nowDate);
    const nowETTime = regime.nowEt;
    const mode = this.state.mode;
    
    if (!regime.isRTH) {
      // DEBUG: Log why market is considered closed
      console.log(
        `[MARKET_CLOSED_CHECK] ts=${ts} nowDate=${nowDate.toISOString()} nowET=${nowET} nowETTime=${nowETTime} isRTH=${regime.isRTH} isWeekday=${regime.regime !== "CLOSED"} mode=${mode} regime=${regime.regime}`
      );
      
      this.state.minimalExecution.phase = "NEUTRAL_PHASE";
      this.state.minimalExecution.waitReason = "market_closed";
      return events;
    }

      // Update forming5mBar state
    const previousBucketStart = this.formingBucketStart;
    // Capture the just-closed bar BEFORE rollover (if rollover is about to happen)
    // We need to check if the bucket will change by comparing current bucket start with previous
    const currentBucketStart = Math.floor(snapshot.ts / (5 * 60 * 1000)) * (5 * 60 * 1000);
    const willRollover = previousBucketStart !== null && currentBucketStart !== previousBucketStart;
    const justClosedBar = willRollover && this.forming5mBar ? this.forming5mBar : null;
    
    const forming5mBar = this.updateForming5mBar(snapshot);
    const is5mClose = previousBucketStart !== null && this.formingBucketStart !== previousBucketStart;
    
    if (forming5mBar) {
      const progress = forming5mBar.progressMinutes;
      console.log(
        `[FORMING5M] start=${forming5mBar.startTs} progress=${progress}/5 o=${forming5mBar.open.toFixed(2)} h=${forming5mBar.high.toFixed(2)} l=${forming5mBar.low.toFixed(2)} c=${forming5mBar.close.toFixed(2)} v=${forming5mBar.volume}`
      );
    }

    // Build closed5mBars: use buffer + just-closed bar (if available) for LLM snapshot
    // This fixes the "one bar behind" issue - LLM gets the most recent close
    const closed5mBars = this.recentBars5m;
    const lastClosed5m = closed5mBars[closed5mBars.length - 1] ?? null;
    const exec = this.state.minimalExecution;
    let shouldPublishEvent = false;
    let debugInfo: MinimalDebugInfo | undefined = undefined;
    
    // Track previous state to detect changes (for use in state transitions)
      const previousBias = exec.bias;
      const previousPhase = exec.phase;

    // ============================================================================
    // ============================================================================
    // RULE 1: LLM must NEVER be called on 1m path - ONLY on 5m closes
    // ============================================================================
    // LLM reasoning should only run on closed 5m bars, never on forming or 1m ingestion
    // The engine already knows how to reason intrabar - LLM adds zero value there
    // 
    // LLM calls are stateless by design. No prior context is reused.
    // Each call contains ONLY:
    // - A fixed system prompt (constant)
    // - The current snapshot (closed5mBars + forming5mBar + dailyContextLite)
    // Previous assistant replies are NEVER included in subsequent requests.
    // ============================================================================
    
    // Declare LLM decision at function scope
    let llmDecision: { action: string; bias: string; confidence: number; maturity?: string; waiting_for?: string } | null = null;
    
    // Explicit guard: LLM is ONLY called on 5m bar closes
    if (!is5mClose) {
      // LLM is NOT called on 1m ticks or forming bars - this prevents request storms
      // All processing continues normally, just without LLM input
    } else if (this.llmService && closed5mBars.length >= this.minimalLlmBars) {
      // ============================================================================
      // RULE 3: LLM errors must be NON-FATAL (graceful degradation)
      // ============================================================================
      // Circuit breaker: if too many failures, skip LLM calls temporarily
      const circuitBreakerCooldown = 60 * 1000; // 1 minute cooldown
      const maxFailures = 3;
      
      if (this.llmCircuitBreaker.isOpen) {
        const timeSinceFailure = this.llmCircuitBreaker.lastFailureTs 
          ? ts - this.llmCircuitBreaker.lastFailureTs 
          : Infinity;
        if (timeSinceFailure > circuitBreakerCooldown) {
          // Reset circuit breaker after cooldown
          this.llmCircuitBreaker.isOpen = false;
          this.llmCircuitBreaker.failures = 0;
          console.log(`[CIRCUIT_BREAKER] Resetting - attempting LLM call`);
        } else {
        console.log(
            `[CIRCUIT_BREAKER] OPEN - skipping LLM call (failures=${this.llmCircuitBreaker.failures} lastFailure=${timeSinceFailure}ms ago)`
          );
          // Graceful degradation: maintain current bias and phase, continue without LLM
        }
      }
      
      if (!this.llmCircuitBreaker.isOpen) {
        // Build daily context
        const currentETDate = getETDateString(new Date(ts));
        const exec = this.state.minimalExecution;
        const dailyContextLite = this.buildDailyContextLite(exec, closed5mBars, currentETDate);
        
        // Fix B: Include just-closed bar in LLM snapshot to eliminate 1-bar lag
        // Build snapshot bars: buffer + just-closed bar (if rollover happened)
        let snapshotBars = closed5mBars.slice(-60); // Last 60 from buffer
        if (justClosedBar) {
          // Convert Forming5mBar to closed bar format and append
          const closedBarForSnapshot = {
            ts: justClosedBar.endTs - 1, // Use endTs - 1ms to ensure it's before the new bucket
            open: justClosedBar.open,
            high: justClosedBar.high,
            low: justClosedBar.low,
            close: justClosedBar.close,
            volume: justClosedBar.volume,
          };
          snapshotBars = [...snapshotBars, closedBarForSnapshot].slice(-60); // Keep last 60
        }
        
        const llmSnapshot: MinimalLLMSnapshot = {
          symbol,
          nowTs: ts,
          closed5mBars: snapshotBars, // Includes just-closed bar (no lag)
          forming5mBar: null, // Never pass forming bar to LLM
          dailyContextLite, // Lightweight daily anchor
        };

        console.log(
          `[LLM5M] bufferClosed5m=${closed5mBars.length} snapshotClosed5m=${snapshotBars.length} callingLLM=true (5m close detected) barsWindow=60 dailyContext=${dailyContextLite ? "yes" : "no"}${justClosedBar ? " [JUST_CLOSED_INCLUDED]" : ""}`
        );
        
        try {
          const result = await this.llmService.getArmDecisionRaw5m({
            snapshot: llmSnapshot,
          });
          llmDecision = result.decision;
          
          // Store for debugging/logging only - NEVER sent back to LLM
          // LLM calls are stateless - no prior responses are reused
          this.state.lastLLMCallAt = ts;
          this.state.lastLLMDecision = llmDecision.action;
          
          // Reset circuit breaker on success
          this.llmCircuitBreaker.failures = 0;
          this.llmCircuitBreaker.lastFailureTs = null;
          this.llmCircuitBreaker.isOpen = false;
        } catch (error: any) {
          // RULE 3: LLM errors must be NON-FATAL - graceful degradation
          this.llmCircuitBreaker.failures += 1;
          this.llmCircuitBreaker.lastFailureTs = ts;
          
          if (this.llmCircuitBreaker.failures >= maxFailures) {
            this.llmCircuitBreaker.isOpen = true;
            console.log(
              `[LLM_UNAVAILABLE] Circuit breaker OPEN after ${this.llmCircuitBreaker.failures} failures - maintaining current state (bias=${exec.bias} phase=${exec.phase})`
            );
          } else {
            console.log(
              `[LLM_UNAVAILABLE] Error (${this.llmCircuitBreaker.failures}/${maxFailures}): ${error.message ?? error} - maintaining current state`
            );
          }
          
          // Graceful degradation: maintain current bias and phase
          // Bot can continue trading without LLM temporarily
          // Update derived confidence even without LLM (uses existing baseBiasConfidence)
          if (exec.bias !== "NEUTRAL") {
            exec.biasConfidence = this.calculateDerivedConfidence(exec, close, closed5mBars, ts);
            exec.thesisConfidence = exec.biasConfidence;
          }
          llmDecision = null; // Signal that LLM call failed
        }
      } // Close: if (!this.llmCircuitBreaker.isOpen)
    } // Close: if (this.llmService && is5mClose && closed5mBars.length > 0)
    
    // ============================================================================
    // Call the authoritative reducer on every 5m close
    // CRITICAL: LLM never sets phase directly - phase is engine-owned
    // ============================================================================
    if (is5mClose && lastClosed5m) {
      const reducerResult = this.reduce5mClose(
        exec,
        ts,
        close,
        closed5mBars,
        lastClosed5m,
        forming5mBar,
        llmDecision
      );
      shouldPublishEvent = reducerResult.shouldPublishEvent || shouldPublishEvent;
      
      // Handle A+ immediate entry (special case - bypasses normal flow)
      if (llmDecision && llmDecision.action === "A+" && (llmDecision.bias === "bearish" || llmDecision.bias === "bullish")) {
        const llmDirection: "long" | "short" = llmDecision.bias === "bearish" ? "short" : "long";
        const current5m = forming5mBar ?? lastClosed5m;
        if (current5m) {
          const entryInfo = this.detectEntryType(exec.bias, current5m, closed5mBars.length >= 2 ? closed5mBars[closed5mBars.length - 2] : undefined);
          
          exec.entryPrice = current5m.close;
          exec.entryTs = ts;
          exec.entryType = entryInfo.type;
          exec.entryTrigger = entryInfo.trigger || "A+ maturity flip";
          exec.pullbackHigh = current5m.high;
          exec.pullbackLow = current5m.low;
          exec.pullbackTs = ts;
          exec.stopPrice = llmDirection === "long" ? current5m.low : current5m.high;
          const atr = this.calculateATR(closed5mBars);
          const closedBarsWithVolume = closed5mBars.filter(bar => 'volume' in bar) as Array<{ high: number; low: number; close: number; volume: number }>;
          const vwap = closedBarsWithVolume.length > 0 ? this.calculateVWAP(closedBarsWithVolume) : undefined;
          const targetResult = this.computeTargets(
            llmDirection,
            exec.entryPrice,
            exec.stopPrice,
            atr,
            closedBarsWithVolume,
            vwap,
            exec.pullbackHigh,
            exec.pullbackLow,
            exec.impulseRange
          );
          exec.targets = targetResult.targets;
          exec.targetZones = targetResult.targetZones;
          exec.phase = "IN_TRADE";
          exec.reason = `Entered (${exec.entryType}) — ${exec.entryTrigger}`;
          exec.waitReason = "a+_maturity_flip_entry";
          shouldPublishEvent = true;
          console.log(
            `[A+_ENTRY] ${exec.bias} entry at ${exec.entryPrice.toFixed(2)} type=${exec.entryType} trigger="${exec.entryTrigger}" stop=${exec.stopPrice.toFixed(2)}`
          );
        }
      }
      
      // Emit NO_TRADE diagnostic if applicable
      if (reducerResult.noTradeReason) {
        console.log(
          `[NO_TRADE] price=${close.toFixed(2)} bias=${exec.bias} phase=${exec.phase} expected=${exec.expectedResolution ?? "n/a"} gate=${exec.resolutionGate?.status ?? "n/a"} reason=${reducerResult.noTradeReason}`
        );
      }
    }

    // Monitor continuation progress and detect momentum pause (runs regardless of LLM)
    if (exec.phase === "CONTINUATION_IN_PROGRESS" && exec.bias !== "NEUTRAL") {
        const current5m = forming5mBar ?? lastClosed5m;
        const previous5m = closed5mBars.length >= 2 ? closed5mBars[closed5mBars.length - 2] : (closed5mBars.length >= 1 ? closed5mBars[closed5mBars.length - 1] : null);

        if (current5m && previous5m) {
          // Update continuation tracking
          if (exec.bias === "BULLISH") {
            exec.continuationLow = Math.min(exec.continuationLow ?? current5m.low, current5m.low);
            if (exec.impulseRange !== undefined) {
              exec.impulseRange = Math.max(exec.impulseRange, current5m.high - (exec.pullbackHigh ?? current5m.low));
            }
          } else if (exec.bias === "BEARISH") {
            exec.continuationHigh = Math.max(exec.continuationHigh ?? current5m.high, current5m.high);
            if (exec.impulseRange !== undefined) {
              exec.impulseRange = Math.max(exec.impulseRange, (exec.pullbackLow ?? current5m.high) - current5m.low);
            }
          }

          // Increment bars counter
          if (exec.barsSinceContinuation !== undefined) {
            exec.barsSinceContinuation++;
        } else {
            exec.barsSinceContinuation = 1;
          }

          // Check for momentum pause (transition to re-entry window)
          const momentumPaused = this.detectMomentumPause(
            exec.bias,
            current5m,
            previous5m,
            closed5mBars,
            exec.impulseRange
          );

          if (momentumPaused) {
            const oldPhase = exec.phase;
            exec.phase = "REENTRY_WINDOW";
            exec.waitReason = "waiting_for_reentry_pullback";
          shouldPublishEvent = true;
            console.log(
              `[STATE_TRANSITION] ${oldPhase} -> ${exec.phase} | BIAS=${exec.bias} NOTE: Continuation paused, monitoring for re-entry`
            );
          }
        }
      }

      // Monitor re-entry window and detect valid re-entry
      if (exec.phase === "REENTRY_WINDOW" && exec.bias !== "NEUTRAL") {
        const current5m = forming5mBar ?? lastClosed5m;
        const previous5m = closed5mBars.length >= 2 ? closed5mBars[closed5mBars.length - 2] : (closed5mBars.length >= 1 ? closed5mBars[closed5mBars.length - 1] : null);

        if (current5m && previous5m && current5m.open !== undefined) {
          // Check if re-entry should be blocked
          const blockCheck = this.shouldBlockReentry(
            exec.bias,
            current5m.close,
            exec.barsSinceContinuation,
            closed5mBars
          );

          if (blockCheck.blocked) {
            const oldPhase = exec.phase;
            exec.phase = "CONSOLIDATION_AFTER_REJECTION";
            exec.waitReason = blockCheck.reason ?? "reentry_window_expired";
            shouldPublishEvent = true;
        console.log(
              `[STATE_TRANSITION] ${oldPhase} -> ${exec.phase} | BIAS=${exec.bias} reason=${exec.waitReason} - Re-entry window expired`
            );
          } else {
            // Check for valid re-entry
            const reentryInfo = this.detectReentry(
              exec.bias,
              current5m,
              previous5m,
              exec.continuationHigh,
              exec.continuationLow,
              exec.impulseRange
            );

            if (reentryInfo.valid && reentryInfo.pullbackHigh !== undefined && reentryInfo.pullbackLow !== undefined) {
              const oldPhase = exec.phase;
              const entryInfo = this.detectEntryType(exec.bias, current5m, previous5m);
              
              exec.entryPrice = current5m.close;
              exec.entryTs = ts;
              exec.entryType = "REENTRY_AFTER_CONTINUATION";
              exec.entryTrigger = entryInfo.trigger || "Post-continuation re-entry";
              exec.pullbackHigh = reentryInfo.pullbackHigh;
              exec.pullbackLow = reentryInfo.pullbackLow;
              exec.pullbackTs = ts;
              exec.stopPrice = exec.bias === "BULLISH" ? reentryInfo.pullbackLow : reentryInfo.pullbackHigh;
              const atrReentry = this.calculateATR(closed5mBars);
              const closedBarsWithVolumeReentry = closed5mBars.filter(bar => 'volume' in bar) as Array<{ high: number; low: number; close: number; volume: number }>;
              const vwapReentry = closedBarsWithVolumeReentry.length > 0 ? this.calculateVWAP(closedBarsWithVolumeReentry) : undefined;
              const targetResultReentry = this.computeTargets(
                exec.bias === "BULLISH" ? "long" : "short",
                exec.entryPrice,
                exec.stopPrice,
                atrReentry,
                closedBarsWithVolumeReentry,
                vwapReentry,
                exec.pullbackHigh,
                exec.pullbackLow,
                exec.impulseRange
              );
              exec.targets = targetResultReentry.targets;
              exec.targetZones = targetResultReentry.targetZones;
              exec.phase = "IN_TRADE";
              exec.reason = `Entered (${exec.entryType}) — ${exec.entryTrigger}`;
              exec.waitReason = "in_trade";
              exec.entryBlocked = false;
              exec.entryBlockReason = undefined;
              shouldPublishEvent = true;
              console.log(
                `[STATE_TRANSITION] ${oldPhase} -> IN_TRADE | TYPE=REENTRY_AFTER_CONTINUATION BIAS=${exec.bias} entry=${exec.entryPrice.toFixed(2)} stop=${exec.stopPrice.toFixed(2)} NOTE: ${exec.bias} continuation re-entry after compression`
              );
            }
          }
        }
      }

      // Monitor resolution gate (check trigger, expiry, invalidation)
      if (exec.resolutionGate && exec.resolutionGate.status === "ARMED") {
        const current5m = forming5mBar ?? lastClosed5m;
        if (current5m) {
          const atr = this.calculateATR(closed5mBars);
          const timeToExpiry = exec.resolutionGate.expiryTs - ts;
          const timeToExpiryMin = Math.floor(timeToExpiry / (60 * 1000));
          
          // Log gate status periodically (every minute when armed)
          if (ts % (60 * 1000) < 1000) { // Roughly every minute
            const priceVsTrigger = exec.resolutionGate.direction === "short"
              ? current5m.close - exec.resolutionGate.triggerPrice
              : exec.resolutionGate.triggerPrice - current5m.close;
            console.log(
              `[GATE_STATUS] ${exec.resolutionGate.direction.toUpperCase()} ARMED price=${current5m.close.toFixed(2)} trigger=${exec.resolutionGate.triggerPrice.toFixed(2)} distance=${priceVsTrigger.toFixed(2)} expiryIn=${timeToExpiryMin}m`
            );
          }
          
          // Check for gate trigger (ARMED → TRIGGERED)
          // Pass setup, current5m, and bias for REJECTION tolerance logic
          const triggered = this.checkGateTrigger(
            exec.resolutionGate, 
            current5m.close, 
            ts, 
            exec.setup, 
            current5m, 
            exec.bias
          );
          
          if (triggered) {
            exec.resolutionGate.status = "TRIGGERED";
            console.log(
              `[GATE_TRIGGERED] ${exec.resolutionGate.direction.toUpperCase()} at ${current5m.close.toFixed(2)} trigger=${exec.resolutionGate.triggerPrice.toFixed(2)} setup=${exec.setup} - Entry permission granted`
            );
            // Entry will be handled by normal entry logic below
          } else if (exec.setup === "PULLBACK_CONTINUATION") {
            // Diagnostic: Check for near-miss cases (within tolerance but didn't trigger)
            const rejectionTolerance = 0.08;
            const distanceToTrigger = exec.resolutionGate.direction === "short"
              ? current5m.close - exec.resolutionGate.triggerPrice
              : exec.resolutionGate.triggerPrice - current5m.close;
            
            if (distanceToTrigger > 0 && distanceToTrigger <= rejectionTolerance * 2) {
              // Within 2x tolerance - potential near-miss
              const open = current5m.open ?? current5m.close;
              const momentumAligned = (exec.bias === "BEARISH" && current5m.close < open) ||
                                      (exec.bias === "BULLISH" && current5m.close > open);
              const reason = !momentumAligned 
                ? "momentum not confirmed" 
                : "tolerance not met";
              
              console.log(
                `[MISSED_ENTRY] setup=REJECTION bias=${exec.bias} triggerPrice=${exec.resolutionGate.triggerPrice.toFixed(2)} lowestPriceSeen=${current5m.low.toFixed(2)} distance=${distanceToTrigger.toFixed(2)} reason="${reason}"`
              );
            }
          }
          // Check for gate expiry (ARMED → EXPIRED)
          else if (this.checkGateExpiry(exec.resolutionGate, current5m.close, ts, atr)) {
            exec.resolutionGate.status = "EXPIRED";
          const oldPhase = exec.phase;
            exec.phase = "CONSOLIDATION_AFTER_REJECTION";
            exec.waitReason = "continuation_without_structure";
            exec.expectedResolution = "FAILURE";
            shouldPublishEvent = true;
            const expiryReason = ts > exec.resolutionGate.expiryTs 
              ? "Time expired" 
              : "Continuation occurred without structure";
          console.log(
              `[GATE_EXPIRED] ${exec.resolutionGate.direction.toUpperCase()} - ${expiryReason}, not chaseable`
          );
          console.log(
              `[STATE_TRANSITION] ${oldPhase} -> ${exec.phase} | BIAS=${exec.bias} (maintained) expectedResolution=${exec.expectedResolution} - Gate expired`
            );
          }
          // Check for gate invalidation (ARMED → INVALIDATED)
          else if (this.checkGateInvalidation(
            exec.resolutionGate,
            exec.bias,
            current5m.close,
            exec.pullbackHigh,
            exec.pullbackLow,
            exec.biasInvalidationLevel
          )) {
            exec.resolutionGate.status = "INVALIDATED";
          const oldPhase = exec.phase;
            exec.phase = "CONSOLIDATION_AFTER_REJECTION";
            exec.waitReason = "structure_broken";
            exec.expectedResolution = "FAILURE";
            shouldPublishEvent = true;
            const invalidationReason = exec.bias === "BEARISH" && exec.pullbackHigh && current5m.close > exec.pullbackHigh
              ? `Price ${current5m.close.toFixed(2)} > pullbackHigh ${exec.pullbackHigh.toFixed(2)}`
              : exec.bias === "BULLISH" && exec.pullbackLow && current5m.close < exec.pullbackLow
              ? `Price ${current5m.close.toFixed(2)} < pullbackLow ${exec.pullbackLow.toFixed(2)}`
              : "Structure broken against bias";
          console.log(
              `[GATE_INVALIDATED] ${exec.resolutionGate.direction.toUpperCase()} - ${invalidationReason}`
            );
            console.log(
              `[STATE_TRANSITION] ${oldPhase} -> ${exec.phase} | BIAS=${exec.bias} (maintained) expectedResolution=${exec.expectedResolution} - Gate invalidated`
            );
          }
        }
      }

      // ============================================================================
      // SETUP DETECTION: BIAS → PHASE → SETUP → ENTRY
      // ============================================================================
      // Setup detection runs before entry logic
      // No setup = no trade (even if bias is strong)
      // Only one setup may be active at a time
      // ============================================================================
      const current5m = forming5mBar ?? lastClosed5m;
      const previous5m = closed5mBars.length >= 2 ? closed5mBars[closed5mBars.length - 2] : (closed5mBars.length >= 1 ? closed5mBars[closed5mBars.length - 1] : null);

      // Setup detection: REMOVED from 1m path
      // Setup detection ONLY happens in reduce5mClose() on 5m closes using closed bars only
      // This prevents flicker from forming bars changing shape on every 1m tick
      // Setup state is authoritative from reduce5mClose() - never override here
      
      // ============================================================================
      // BIAS FLIP ENTRY: Execute on 1m trigger (BEFORE pullback entry logic)
      // ============================================================================
      // This is independent of setup detection - gives bias flips first shot
      // ============================================================================
      if (exec.phase !== "IN_TRADE" && exec.bias !== "NEUTRAL") {
        const current5m = forming5mBar ?? lastClosed5m;
        if (current5m) {
          // Get last 1m bar for trigger check (use forming5mBar as proxy if available)
          const last1m = forming5mBar ? {
            high: forming5mBar.high,
            low: forming5mBar.low,
            close: forming5mBar.close,
          } : undefined;
          
          const biasFlipExecuted = this.maybeExecuteBiasFlipEntry(
            exec,
            current5m,
            last1m,
            closed5mBars,
            ts
          );
          
          if (biasFlipExecuted) {
            shouldPublishEvent = true;
            // Skip pullback entry logic if bias flip executed
            // Continue to stop/target checks below
          }
        }
      }

      // ============================================================================
      // ENTRY LOGIC: Find and Enter Setups (only if not already in trade from bias flip)
      // ============================================================================
      // The bot finds setups by:
      // 1. Establishing bias (BEARISH/BULLISH) from LLM analysis
      // 2. Detecting pullback structure (PULLBACK_IN_PROGRESS phase)
      // 3. Detecting explicit setup type (REJECTION, BREAKDOWN, etc.)
      // 4. Arming resolution gate (if expectedResolution = CONTINUATION)
      // 5. Waiting for gate trigger (price hits trigger price)
      // 6. Entering on pullback rejection/breakdown when conditions are met
      //
      // Entry conditions:
      // - Setup must be active (setup !== "NONE")
      // - BULLISH bias: Enter on bearish candle OR lower low during pullback
      // - BEARISH bias: Enter on bullish candle OR higher high during pullback
      //
      // Entry is blocked if:
      // - No setup detected (setup === "NONE")
      // - Gate is ARMED but not TRIGGERED (waiting for price to hit trigger)
      // - No-chase rules triggered (continuation extended too far)
      // - Re-entry window expired
      // ============================================================================
      // Only run pullback entry logic if not already in trade
      if (exec.phase !== "IN_TRADE") {
      // ============================================================================
      // 1M ARMING: Attempt to arm gate on 1m turn signals (responsive arming)
      // ============================================================================
      // Setup is detected on 5m close, but gate can be armed on 1m turn signals
      // This prevents missing best entries that happen on 1m/2m structure
      // ============================================================================
      if (exec.setup === "PULLBACK_CONTINUATION" && 
          !exec.resolutionGate && 
          exec.bias !== "NEUTRAL" &&
          (exec.phase === "BIAS_ESTABLISHED" || exec.phase === "PULLBACK_IN_PROGRESS") &&
          forming5mBar && 
          forming5mBar.progressMinutes >= 1 && 
          forming5mBar.progressMinutes <= 4) {
        // Use forming5mBar as "current 1m bar" and lastClosed5m as "previous 1m bar" proxy
        // This allows responsive arming on 1m turn signals before 5m confirms
        const atrFor1mArming = this.calculateATR(closed5mBars);
        const previous5mFor1m = closed5mBars.length >= 2 ? closed5mBars[closed5mBars.length - 2] : undefined;
        
        // Convert forming5mBar to bar format for tryArmPullbackGate
        const current1mBar = {
          open: forming5mBar.open,
          high: forming5mBar.high,
          low: forming5mBar.low,
          close: forming5mBar.close,
        };
        
        // Use last closed 5m as previous 1m proxy (or previous 5m if available)
        const previous1mBar = lastClosed5m ? {
          open: lastClosed5m.open,
          high: lastClosed5m.high,
          low: lastClosed5m.low,
          close: lastClosed5m.close,
        } : undefined;
        
        const armResult1m = this.tryArmPullbackGate(
          exec,
          close,
          lastClosed5m,
          previous5mFor1m,
          closed5mBars,
          atrFor1mArming,
          ts,
          current1mBar,
          previous1mBar
        );
        
        if (armResult1m.armed && !exec.resolutionGate) {
          // Gate doesn't exist - create/arm it
          exec.resolutionGate = {
            status: "ARMED",
            direction: exec.bias === "BULLISH" ? "long" : "short",
            triggerPrice: armResult1m.trigger,
            stopPrice: armResult1m.stop,
            expiryTs: ts + 2 * 5 * 60 * 1000, // 2 timeframes (10 minutes)
            armedTs: ts,
            reason: armResult1m.reason,
          };
          
          const expiryInMin = Math.floor((exec.resolutionGate.expiryTs - ts) / (60 * 1000));
          console.log(
            `[GATE_ARMED] setup=PULLBACK_CONTINUATION bias=${exec.bias} trigger=${armResult1m.trigger.toFixed(2)} stop=${armResult1m.stop.toFixed(2)} reason=${armResult1m.reason} expiryInMin=${expiryInMin} (1m_turn_signal)`
          );
        }
      }
      
      // ============================================================================
      // OPPORTUNITYLATCH-BASED ENTRY LOGIC
      // ============================================================================
      // Entry now uses OpportunityLatch as the single execution gate
      // This replaces the "separated gate mess" (setup gate, resolution gate, etc.)
      // ============================================================================
      
      // ============================================================
      // FLATTENED ENTRY FLOW (drop-in replacement for 3320–3545)
      // Preserves: logs + waitReason behavior
      // Fixes: TRIGGERED fallthrough + "latch-only scope trap"
      // ============================================================
      // Check for pullback entry every 1m (responsive, not just on 5m close)
      // Skip entry attempts during CONTINUATION_IN_PROGRESS (no-chase rule)
      if (
        exec.bias !== "NEUTRAL" &&
        (exec.phase === "PULLBACK_IN_PROGRESS" || exec.phase === "BIAS_ESTABLISHED") &&
        current5m
      ) {
        const previous5m =
          closed5mBars.length >= 2 ? closed5mBars[closed5mBars.length - 2] : undefined;

        // ------------------------------------------------------------
        // 1) Update opportunity state (LATCHED -> maybe TRIGGERED)
        // ------------------------------------------------------------
        if (exec.opportunity && exec.opportunity.status === "LATCHED") {
          const triggerCheck = this.checkOpportunityTrigger(
            exec.opportunity,
            current5m,
            previous5m,
            closed5mBars,
            this.calculateATR(closed5mBars)
          );

          if (triggerCheck.triggered) {
            exec.opportunity.status = "TRIGGERED";
            console.log(
              `[OPPORTUNITY_TRIGGERED] ${exec.opportunity.side} reason=${triggerCheck.reason} price=${current5m.close.toFixed(
                2
              )}`
            );
            shouldPublishEvent = true;
          } else {
            // Opportunity latched but not triggered yet
            exec.waitReason = `waiting_for_${exec.opportunity.trigger.type.toLowerCase()}_trigger`;
            const priceVsTrigger =
              exec.opportunity.side === "SHORT"
                ? current5m.close - exec.opportunity.trigger.price
                : exec.opportunity.trigger.price - current5m.close;
            console.log(
              `[OPPORTUNITY_LATCHED] ${exec.opportunity.side} price=${current5m.close.toFixed(
                2
              )} trigger=${exec.opportunity.trigger.price.toFixed(
                2
              )} distance=${priceVsTrigger.toFixed(2)}`
            );
          }
        }

        // ------------------------------------------------------------
        // 2) Readiness invariant (no more latch-only scoping)
        // ------------------------------------------------------------
        const hasOpportunity = !!exec.opportunity;
        const oppReady =
          hasOpportunity &&
          (exec.opportunity!.status === "LATCHED" ||
            exec.opportunity!.status === "TRIGGERED");

        const gateReady = exec.resolutionGate?.status === "ARMED";

        // If you want OpportunityLatch optional and gate primary, this keeps that:
        const readyToEvaluateEntry = oppReady || gateReady;

        // ------------------------------------------------------------
        // 3) Hard blocker: not ready -> block + exit (prevents fallthrough)
        // ------------------------------------------------------------
        // Debug log to verify opportunity status before blocker check
        const oppStatus = exec.opportunity?.status ?? "none";
        const gateStatus = exec.resolutionGate?.status ?? "none";
        console.log(
          `[DEBUG_OPP] status=${oppStatus} waitReason=${exec.waitReason} oppReady=${oppReady} gateReady=${gateReady} readyToEvaluateEntry=${readyToEvaluateEntry}`
        );
        
        if (!readyToEvaluateEntry) {
          // FIX 2: No opportunity ready - this is a hard blocker
          // Do not proceed to entry evaluation
          // BUT: Only set waitReason if it's not already set to something more specific
          // This prevents overriding a valid waitReason that was set on 5m close
          if (!exec.waitReason || exec.waitReason === "no_opportunity_latched") {
            exec.waitReason = "no_opportunity_latched";
          }
          exec.entryBlocked = true;
          exec.entryBlockReason =
            "No tradable opportunity ready (need LATCHED/TRIGGERED or gate ARMED)";
          shouldPublishEvent = true;
          console.log(
            `[ENTRY_BLOCKED] Not ready - BIAS=${exec.bias} PHASE=${exec.phase} oppStatus=${oppStatus} gateStatus=${gateStatus} - Waiting for pullback zone`
          );
          // ✅ critical: prevents bogus blocking when opp becomes TRIGGERED
          // Note: This is inside handleMinimal1m which returns events[], so we use else block to prevent fallthrough
        } else {
          // ------------------------------------------------------------
          // 4) Entry signal detection (now runs whenever readyToEvaluateEntry)
          // ------------------------------------------------------------
          const open = current5m.open ?? current5m.close;
          const isBearish = current5m.close < open;
          const isBullish = current5m.close > open;

          let lowerLow = false;
          let higherHigh = false;
          if (previous5m) {
            lowerLow = current5m.low < previous5m.low;
            higherHigh = current5m.high > previous5m.high;
          }

          const entrySignalFires =
            (exec.bias === "BULLISH" && (isBearish || (previous5m && lowerLow))) ||
            (exec.bias === "BEARISH" && (isBullish || (previous5m && higherHigh)));

          // Entry permission: setup exists + entry signal fires
          // (readyToEvaluateEntry already guaranteed above via else block, so oppReady || gateReady is true)
          // STEP 5: Setup is informational for pullback continuation, not a hard gate if opportunity is ready
          // If setup is NONE but opportunity is TRIGGERED and entry signal fires, allow entry
          const canEnter = entrySignalFires && (
            (exec.setup && exec.setup !== "NONE") ||  // Setup exists (preferred)
            (oppReady && exec.opportunity?.status === "TRIGGERED")  // OR opportunity is TRIGGERED (fresh break)
          );

          // ------------------------------------------------------------
          // 4.5) EXPLICIT WAIT HANDLING when canEnter is false
          // ------------------------------------------------------------
          // If an opportunity exists (or gateReady) but we have no setup, explain it.
          // This matches your heartbeat reason naming style.
          // Note: exec.setup is SetupType | undefined, so we check for undefined or falsy
          if (!exec.setup) {
            // Only update if we don't already have something more specific set by earlier logic
            if (!exec.waitReason || exec.waitReason === "no_opportunity_latched") {
              exec.waitReason = "setup_none";
            }
            exec.entryBlocked = true;
            exec.entryBlockReason = "No tradable setup detected - structure incomplete";
            // Optional: set shouldPublishEvent if you want Telegram to update on this state
            // shouldPublishEvent = true;
            // console.log(`[NO_TRADE] ... reason=setup_none ...`) // you already emit similar
          }
          // If setup exists but entry signal hasn't fired yet, this is "waiting", not blocked.
          else if (exec.setup && !entrySignalFires) {
            exec.waitReason = "waiting_for_entry_signal";
            exec.entryBlocked = false;
            exec.entryBlockReason = undefined;
            // Optional publish if you want visibility that you're staged and waiting
            // shouldPublishEvent = true;
            console.log(
              `[ENTRY_WAITING] Setup=${exec.setup} exists but entry signal not yet fired - BIAS=${exec.bias}`
            );
          }
          // If setup exists and signal fires, but canEnter is still false, explain why.
          // With the flattened readiness check, this should be rare, but keep it for safety.
          else if (exec.setup && entrySignalFires && !canEnter) {
            exec.waitReason = gateReady ? "gate_armed_but_entry_blocked" : "opp_ready_but_entry_blocked";
            exec.entryBlocked = true;
            exec.entryBlockReason = "Entry conditions incomplete (diagnostic)";
            // shouldPublishEvent = true;
            console.log(
              `[ENTRY_BLOCKED] Entry conditions incomplete - BIAS=${exec.bias} PHASE=${exec.phase} setup=${exec.setup} oppReady=${oppReady} gateReady=${gateReady}`
            );
          }

          // ------------------------------------------------------------
          // 6) Entry execution (unchanged from your block)
          // ------------------------------------------------------------
          if (canEnter) {
            // Enter ON pullback for BULLISH bias
            if (exec.bias === "BULLISH" && (isBearish || (previous5m && lowerLow))) {
              const atrForBlock = this.calculateATR(closed5mBars);
              const blockCheck = this.shouldBlockEntry(
                exec.bias,
                exec.phase,
                current5m.close,
                exec.pullbackHigh,
                exec.pullbackLow,
                atrForBlock,
                exec.targetZones
              );

              if (blockCheck.blocked) {
                exec.entryBlocked = true;
                exec.entryBlockReason = blockCheck.reason;
                exec.waitReason = blockCheck.reason ?? "entry_blocked";
                shouldPublishEvent = true;
                console.log(
                  `[ENTRY_BLOCKED] BIAS=${exec.bias} phase=${exec.phase} reason=${blockCheck.reason} - No-chase rule triggered`
                );
              } else {
                const oldPhase = exec.phase;
                const entryInfo = this.detectEntryType(
                  exec.bias,
                  current5m,
                  previous5m ?? undefined
                );

                exec.entryPrice = current5m.close;
                exec.entryTs = ts;
                exec.entryType = entryInfo.type;
                exec.entryTrigger = entryInfo.trigger || "Pullback entry";
                exec.pullbackHigh = current5m.high;
                exec.pullbackLow = current5m.low;
                exec.pullbackTs = ts;

                const atrLong = this.calculateATR(closed5mBars);
                const stopFallback = previous5m
                  ? Math.min(previous5m.low, current5m.low) - atrLong * 0.1
                  : current5m.low - atrLong * 0.1;

                exec.stopPrice = exec.opportunity?.stop.price ?? stopFallback;

                const closedBarsWithVolumeLong = closed5mBars.filter(
                  (bar) => "volume" in bar
                ) as Array<{ high: number; low: number; close: number; volume: number }>;

                const vwapLong =
                  closedBarsWithVolumeLong.length > 0
                    ? this.calculateVWAP(closedBarsWithVolumeLong)
                    : undefined;

                const targetResultLong = this.computeTargets(
                  "long",
                  exec.entryPrice,
                  exec.stopPrice,
                  atrLong,
                  closedBarsWithVolumeLong,
                  vwapLong,
                  exec.pullbackHigh,
                  exec.pullbackLow,
                  exec.impulseRange
                );

                exec.targets = targetResultLong.targets;
                exec.targetZones = targetResultLong.targetZones;

                exec.phase = "IN_TRADE";
                exec.reason = `Entered (${exec.entryType}) — ${exec.entryTrigger}`;
                exec.waitReason = "in_trade";
                exec.entryBlocked = false;
                exec.entryBlockReason = undefined;

                if (exec.opportunity) {
                  exec.opportunity.status = "CONSUMED";
                }

                shouldPublishEvent = true;

                console.log(
                  `[ENTRY_EXECUTED] ${oldPhase} -> IN_TRADE | BIAS=${exec.bias} SETUP=${exec.setup} entry=${exec.entryPrice.toFixed(
                    2
                  )} type=${exec.entryType} trigger="${exec.entryTrigger}" stop=${exec.stopPrice.toFixed(
                    2
                  )}`
                );
              }
            }

            // Enter ON pullback for BEARISH bias
            if (
              exec.bias === "BEARISH" &&
              (isBullish || (previous5m && higherHigh))
            ) {
              const atrForBlock = this.calculateATR(closed5mBars);
              const blockCheck = this.shouldBlockEntry(
                exec.bias,
                exec.phase,
                current5m.close,
                exec.pullbackHigh,
                exec.pullbackLow,
                atrForBlock,
                exec.targetZones
              );

              if (blockCheck.blocked) {
                exec.entryBlocked = true;
                exec.entryBlockReason = blockCheck.reason;
                exec.waitReason = blockCheck.reason ?? "entry_blocked";
                shouldPublishEvent = true;
                console.log(
                  `[ENTRY_BLOCKED] BIAS=${exec.bias} phase=${exec.phase} reason=${blockCheck.reason} - No-chase rule triggered`
                );
              } else {
                const oldPhase = exec.phase;
                const entryInfo = this.detectEntryType(
                  exec.bias,
                  current5m,
                  previous5m ?? undefined
                );

                exec.entryPrice = current5m.close;
                exec.entryTs = ts;
                exec.entryType = entryInfo.type;
                exec.entryTrigger = entryInfo.trigger || "Pullback entry";
                exec.pullbackHigh = current5m.high;
                exec.pullbackLow = current5m.low;
                exec.pullbackTs = ts;

                const atrShort = this.calculateATR(closed5mBars);
                const stopFallback = previous5m
                  ? Math.max(previous5m.high, current5m.high) + atrShort * 0.1
                  : current5m.high + atrShort * 0.1;

                exec.stopPrice = exec.opportunity?.stop.price ?? stopFallback;

                const closedBarsWithVolumeShort = closed5mBars.filter(
                  (bar) => "volume" in bar
                ) as Array<{ high: number; low: number; close: number; volume: number }>;

                const vwapShort =
                  closedBarsWithVolumeShort.length > 0
                    ? this.calculateVWAP(closedBarsWithVolumeShort)
                    : undefined;

                const targetResultShort = this.computeTargets(
                  "short",
                  exec.entryPrice,
                  exec.stopPrice,
                  atrShort,
                  closedBarsWithVolumeShort,
                  vwapShort,
                  exec.pullbackHigh,
                  exec.pullbackLow,
                  exec.impulseRange
                );

                exec.targets = targetResultShort.targets;
                exec.targetZones = targetResultShort.targetZones;

                exec.phase = "IN_TRADE";
                exec.reason = `Entered (${exec.entryType}) — ${exec.entryTrigger}`;
                exec.waitReason = "in_trade";
                exec.entryBlocked = false;
                exec.entryBlockReason = undefined;

                if (exec.opportunity) {
                  exec.opportunity.status = "CONSUMED";
                }

                shouldPublishEvent = true;

                console.log(
                  `[ENTRY_EXECUTED] ${oldPhase} -> IN_TRADE | BIAS=${exec.bias} SETUP=${exec.setup} entry=${exec.entryPrice.toFixed(
                    2
                  )} type=${exec.entryType} trigger="${exec.entryTrigger}" stop=${exec.stopPrice.toFixed(
                    2
                  )}`
                );
              }
            }
          }
        }
      }

      // Check trade management if in trade
      // Real-time target updates: recompute targets on each 5m close
      if (exec.phase === "IN_TRADE" && exec.entryPrice !== undefined && exec.stopPrice !== undefined && is5mClose) {
        const atr = this.calculateATR(closed5mBars);
        const closedBarsWithVolume = closed5mBars.filter(bar => 'volume' in bar) as Array<{ high: number; low: number; close: number; volume: number }>;
        const vwap = closedBarsWithVolume.length > 0 ? this.calculateVWAP(closedBarsWithVolume) : undefined;
        const direction = exec.bias === "BULLISH" ? "long" : "short";
        const targetResult = this.computeTargets(
          direction,
          exec.entryPrice,
          exec.stopPrice,
          atr,
          closedBarsWithVolume,
          vwap,
          exec.pullbackHigh,
          exec.pullbackLow,
          exec.impulseRange
        );
        exec.targets = targetResult.targets;
        exec.targetZones = targetResult.targetZones;
        console.log(
          `[TARGETS_UPDATED] Entry=${exec.entryPrice.toFixed(2)} R_Targets: T1=${targetResult.targetZones.rTargets.t1.toFixed(2)} T2=${targetResult.targetZones.rTargets.t2.toFixed(2)} T3=${targetResult.targetZones.rTargets.t3.toFixed(2)} ExpectedZone=${targetResult.targetZones.expectedZone.lower.toFixed(2)}-${targetResult.targetZones.expectedZone.upper.toFixed(2)}`
        );
      }

      if (exec.phase === "IN_TRADE" && exec.entryPrice !== undefined && exec.stopPrice !== undefined && exec.targets) {
        const current5m = forming5mBar ?? lastClosed5m;
        if (current5m) {
          // Check stop (FIXED: use close instead of wick for close-based logic)
          if (exec.thesisDirection === "long" && current5m.close <= exec.stopPrice) {
            const oldPhase = exec.phase;
            const newPhase = exec.bias === "NEUTRAL" ? "NEUTRAL_PHASE" : "PULLBACK_IN_PROGRESS";
            console.log(
              `[STATE_TRANSITION] ${oldPhase} -> ${newPhase} | Stop hit at ${current5m.close.toFixed(2)} (stop=${exec.stopPrice.toFixed(2)}) close-based`
            );
            exec.phase = newPhase;
            exec.waitReason = exec.bias === "NEUTRAL" ? "waiting_for_bias" : "waiting_for_pullback";
            this.clearTradeState(exec);
            shouldPublishEvent = true; // Exit - publish event
          } else if (exec.thesisDirection === "short" && current5m.close >= exec.stopPrice) {
            const oldPhase = exec.phase;
            console.log(
              `[STATE_TRANSITION] ${oldPhase} -> ${exec.bias === "NEUTRAL" ? "NEUTRAL_PHASE" : "PULLBACK_IN_PROGRESS"} | Stop hit at ${current5m.close.toFixed(2)} (stop=${exec.stopPrice.toFixed(2)}) close-based`
            );
            exec.phase = exec.bias === "NEUTRAL" ? "NEUTRAL_PHASE" : "PULLBACK_IN_PROGRESS";
            exec.waitReason = exec.bias === "NEUTRAL" ? "waiting_for_bias" : "waiting_for_pullback";
            this.clearTradeState(exec);
            shouldPublishEvent = true; // Exit - publish event
          }
          // Check targets
          else if (exec.targets.some(target => 
            (exec.thesisDirection === "long" && current5m.high >= target) ||
            (exec.thesisDirection === "short" && current5m.low <= target)
          )) {
            const hitTarget = exec.targets.find(target =>
              (exec.thesisDirection === "long" && current5m.high >= target) ||
              (exec.thesisDirection === "short" && current5m.low <= target)
            );
            const oldPhase = exec.phase;
            const newPhase = exec.bias === "NEUTRAL" ? "NEUTRAL_PHASE" : "PULLBACK_IN_PROGRESS";
            console.log(
              `[STATE_TRANSITION] ${oldPhase} -> ${newPhase} | Target hit at ${hitTarget?.toFixed(2)}`
            );
            exec.phase = newPhase;
            exec.waitReason = exec.bias === "NEUTRAL" ? "waiting_for_bias" : "waiting_for_pullback";
            this.clearTradeState(exec);
            shouldPublishEvent = true; // Exit - publish event
          }
        }
      }
      } // Close: if (exec.phase !== "IN_TRADE") for pullback entry logic

      // Publish event if state changed, important event occurred, or heartbeat needed
      // CRITICAL: This ensures blocked states still emit messages (heartbeat mechanism)
      const shouldEmit = shouldPublishEvent || exec.phase !== previousPhase || exec.bias !== previousBias;
      
      if (shouldEmit) {
        // Track last message timestamp for silent mode detection
        this.lastMessageTs = ts;
        if (!debugInfo) {
          const barsForCandidates = closed5mBars.length > 0 ? closed5mBars : (forming5mBar ? [{
            ts: forming5mBar.endTs,
            open: forming5mBar.open,
            high: forming5mBar.high,
            low: forming5mBar.low,
            close: forming5mBar.close,
            volume: forming5mBar.volume,
          }] : []);
          debugInfo = {
            barsClosed5m: closed5mBars.length,
            hasForming5m: !!forming5mBar,
            formingProgressMin: forming5mBar?.progressMinutes ?? null,
            formingStartTs: forming5mBar?.startTs ?? null,
            formingEndTs: forming5mBar?.endTs ?? null,
            formingRange: forming5mBar ? (forming5mBar.high - forming5mBar.low) : null,
            lastClosedRange: lastClosed5m ? (lastClosed5m.high - lastClosed5m.low) : null,
            candidateBarsUsed: barsForCandidates.length,
            candidateCount: exec.activeCandidate ? 1 : 0,
            botPhase: exec.phase,
            botWaitReason: exec.waitReason ?? null,
          };
        }

        // Determine reference price and label based on phase/state
        let refPrice: number | undefined = undefined;
        let refLabel: string | undefined = undefined;
        
        if (exec.phase === "IN_TRADE" && exec.entryPrice !== undefined) {
          refPrice = exec.entryPrice;
          refLabel = "entry";
        } else if (exec.phase === "PULLBACK_IN_PROGRESS" || exec.phase === "CONTINUATION_IN_PROGRESS" || exec.phase === "REENTRY_WINDOW") {
          if (exec.bias === "BEARISH" && exec.pullbackHigh !== undefined) {
            refPrice = exec.pullbackHigh;
            if (exec.phase === "CONTINUATION_IN_PROGRESS") {
              refLabel = "pullback high (continuation)";
            } else if (exec.phase === "REENTRY_WINDOW") {
              refLabel = "pullback high (re-entry window)";
            } else {
              refLabel = "pullback high";
            }
          } else if (exec.bias === "BULLISH" && exec.pullbackLow !== undefined) {
            refPrice = exec.pullbackLow;
            if (exec.phase === "CONTINUATION_IN_PROGRESS") {
              refLabel = "pullback low (continuation)";
            } else if (exec.phase === "REENTRY_WINDOW") {
              refLabel = "pullback low (re-entry window)";
            } else {
              refLabel = "pullback low";
            }
          } else if (exec.biasPrice !== undefined) {
            refPrice = exec.biasPrice;
            refLabel = "bias established";
          }
        } else if (exec.biasPrice !== undefined) {
          refPrice = exec.biasPrice;
          refLabel = "bias established";
        } else if (exec.thesisPrice !== undefined) {
          refPrice = exec.thesisPrice;
          refLabel = "bias established";
        }

        // Generate no-trade diagnostic if applicable (for PULLBACK_IN_PROGRESS with inactive entry)
        // Also generate if no setup detected (setup === "NONE")
        let noTradeDiagnostic: NoTradeDiagnostic | undefined = undefined;
        if (exec.phase === "PULLBACK_IN_PROGRESS" || (exec.setup === "NONE" && exec.bias !== "NEUTRAL")) {
          const atr = this.calculateATR(closed5mBars);
          const diagnostic = this.generateNoTradeDiagnostic(exec, close, atr, closed5mBars, ts);
          if (diagnostic) {
            noTradeDiagnostic = diagnostic;
            // Also emit to console for logging
            this.emitNoTradeDiagnostic(diagnostic);
            // Update last diagnostic price to prevent spam
            this.lastDiagnosticPrice = close;
          }
        }

        // STEP 4 FIX: Override waitReason if opportunity is actually ready (LATCHED or TRIGGERED) (fixes Telegram state sync)
        // This prevents stale "no_opportunity_latched" from 1m handler overriding the correct state
        // GUARDRAIL: If hasOpp===true, effectiveWaitReason can NEVER be no_opportunity_latched
        let effectiveWaitReason = exec.waitReason;
        const hasOpp = !!exec.opportunity;
        const oppReady = hasOpp && 
          (exec.opportunity!.status === "LATCHED" || exec.opportunity!.status === "TRIGGERED");
        
        if (hasOpp) {
          // STEP 4 GUARDRAIL: If opportunity exists, never show "no_opportunity_latched"
          if (effectiveWaitReason === "no_opportunity_latched") {
            effectiveWaitReason = oppReady 
              ? (exec.setup === "NONE" ? "waiting_for_pullback" : "waiting_for_trigger")
              : `opportunity_${exec.opportunity!.status.toLowerCase()}`;
            // Also update exec.waitReason to prevent future stale reads
            exec.waitReason = effectiveWaitReason;
          }
        }
        
        // Debug logging to verify state sync (as requested)
        console.log(
          `[TELEGRAM_STATE] hasOpp=${!!exec.opportunity} oppStatus=${exec.opportunity?.status ?? "none"} oppExpires=${exec.opportunity?.expiresAtTs ? new Date(exec.opportunity.expiresAtTs).toISOString() : "n/a"} setup=${exec.setup} phase=${exec.phase} waitReason=${exec.waitReason} effectiveWaitReason=${effectiveWaitReason}`
        );

        const mindState = {
          mindId: randomUUID(),
          direction: exec.thesisDirection ?? "none", // Legacy compatibility
          confidence: exec.biasConfidence ?? exec.thesisConfidence ?? 0,
          reason: this.getPhaseAwareReason(exec.bias, exec.phase, effectiveWaitReason, exec.reason),
          bias: exec.bias,
          phase: exec.phase,
          entryStatus: exec.entryBlocked 
            ? "blocked" as const 
            : (exec.phase === "IN_TRADE" ? "active" as const : "inactive" as const),
          entryType: exec.entryType ?? undefined,
          expectedResolution: exec.expectedResolution ?? undefined,
          setup: exec.setup ?? undefined, // Explicit setup type
          price: close, // Current price (first-class)
          refPrice, // Reference price anchor
          refLabel, // Label for reference price
          noTradeDiagnostic, // Why no trade fired (when applicable)
          // Target zones (when in trade)
          targetZones: exec.targetZones ?? undefined,
          entryPrice: exec.entryPrice ?? undefined,
          stopPrice: exec.stopPrice ?? undefined,
          // Opportunity latch timestamps (for debugging Telegram timing)
          oppLatchedAt: exec.opportunity?.latchedAtTs,
          oppExpiresAt: exec.opportunity?.expiresAtTs,
          last5mCloseTs: lastClosed5m?.ts,
          source: is5mClose ? "5m" as const : "1m" as const,
        };

        events.push({
          type: "MIND_STATE_UPDATED",
          timestamp: ts,
          instanceId: this.instanceId,
          data: {
            timestamp: ts,
            symbol,
            price: close,
            mindState,
            thesis: {
              direction: exec.thesisDirection ?? null,
              confidence: exec.thesisConfidence ?? null,
              price: exec.thesisPrice ?? null,
              ts: exec.thesisTs ?? null,
            },
            candidate: exec.activeCandidate ?? null,
            botState: exec.phase,
            waitFor: exec.waitReason ?? null,
            debug: debugInfo,
          },
        });
      } else {
        // Silent mode detection: if no message in 10 minutes while ACTIVE, emit heartbeat
        const silentModeThreshold = 10 * 60 * 1000; // 10 minutes
        const isBlocked = exec.phase !== "IN_TRADE" && exec.bias !== "NEUTRAL" && (exec.setup === "NONE" || exec.entryBlocked);
        
        if (isBlocked && this.lastMessageTs !== null && (ts - this.lastMessageTs) >= silentModeThreshold) {
          // Force heartbeat emission
          this.lastMessageTs = ts;
          this.lastHeartbeatTs = ts;
          
          const atr = this.calculateATR(closed5mBars);
          const diagnostic = this.generateNoTradeDiagnostic(exec, close, atr, closed5mBars, ts);
          
          // STEP 4 FIX: Override waitReason if opportunity is actually ready (LATCHED or TRIGGERED) (fixes Telegram state sync)
          // GUARDRAIL: If hasOpp===true, effectiveWaitReason can NEVER be no_opportunity_latched
          let effectiveWaitReason = exec.waitReason;
          const hasOpp = !!exec.opportunity;
          const oppReady = hasOpp && 
            (exec.opportunity!.status === "LATCHED" || exec.opportunity!.status === "TRIGGERED");
          
          if (hasOpp) {
            // STEP 4 GUARDRAIL: If opportunity exists, never show "no_opportunity_latched"
            if (effectiveWaitReason === "no_opportunity_latched") {
              effectiveWaitReason = oppReady 
                ? (exec.setup === "NONE" ? "waiting_for_pullback" : "waiting_for_trigger")
                : `opportunity_${exec.opportunity!.status.toLowerCase()}`;
              exec.waitReason = effectiveWaitReason;
            }
          }
          
          // Debug logging for heartbeat
          console.log(
            `[TELEGRAM_STATE_HEARTBEAT] hasOpp=${!!exec.opportunity} oppStatus=${exec.opportunity?.status ?? "none"} setup=${exec.setup} phase=${exec.phase} waitReason=${exec.waitReason} effectiveWaitReason=${effectiveWaitReason}`
          );
          
          // Build minimal heartbeat message
          const mindState = {
            mindId: randomUUID(),
            direction: exec.thesisDirection ?? "none",
            confidence: exec.biasConfidence ?? exec.thesisConfidence ?? 0,
            reason: this.getPhaseAwareReason(exec.bias, exec.phase, effectiveWaitReason, exec.reason),
            bias: exec.bias,
            phase: exec.phase,
            entryStatus: exec.entryBlocked ? "blocked" as const : "inactive" as const,
            expectedResolution: exec.expectedResolution ?? undefined,
            setup: exec.setup ?? undefined,
            price: close,
            noTradeDiagnostic: diagnostic ?? undefined,
            // Opportunity latch timestamps (for debugging Telegram timing)
            oppLatchedAt: exec.opportunity?.latchedAtTs,
            oppExpiresAt: exec.opportunity?.expiresAtTs,
            last5mCloseTs: lastClosed5m?.ts,
            source: is5mClose ? "5m" as const : "1m" as const,
          };
          
          events.push({
            type: "MIND_STATE_UPDATED",
            timestamp: ts,
            instanceId: this.instanceId,
            data: {
              timestamp: ts,
              symbol,
              price: close,
              mindState,
              thesis: {
                direction: exec.thesisDirection ?? null,
                confidence: exec.thesisConfidence ?? null,
                price: exec.thesisPrice ?? null,
                ts: exec.thesisTs ?? null,
              },
              candidate: exec.activeCandidate ?? null,
              botState: exec.phase,
              waitFor: exec.waitReason ?? null,
            },
          });
          
          console.log(
            `[SILENT_MODE_HEARTBEAT] No message in ${Math.round((ts - (this.lastMessageTs - silentModeThreshold)) / 60000)}min - emitting heartbeat | bias=${exec.bias} phase=${exec.phase} setup=${exec.setup} reason=${diagnostic?.reasonCode ?? "waiting"}`
          );
        }
      }

      return events;
  }

  /**
   * Preloads historical 5m bars and daily context on startup.
   * This allows the bot to be "ready" immediately instead of waiting for history to build.
   * 
   * @param bars Array of historical 5m bars (should be last 60 bars)
   * @param dailyContext Daily context (prevClose, prevHigh, prevLow, overnightHigh, overnightLow, prevSessionVWAP)
   */
  public preloadHistory(
    bars: Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }>,
    dailyContext?: {
      prevClose: number;
      prevHigh: number;
      prevLow: number;
      overnightHigh: number;
      overnightLow: number;
      prevSessionVWAP: number;
    }
  ): void {
    if (bars.length === 0) {
      console.log(`[PRELOAD] No bars provided - starting with empty history`);
      return;
    }
    
    // Hydrate recentBars5m
    this.recentBars5m = bars.slice(-120); // Keep last 120 bars (10 hours)
    console.log(`[PRELOAD] Loaded ${this.recentBars5m.length} historical 5m bars`);
    
    // Hydrate daily context
    if (dailyContext) {
      this.prevDayClose = dailyContext.prevClose;
      this.prevDayHigh = dailyContext.prevHigh;
      this.prevDayLow = dailyContext.prevLow;
      this.overnightHigh = dailyContext.overnightHigh;
      this.overnightLow = dailyContext.overnightLow;
      this.prevSessionVWAP = dailyContext.prevSessionVWAP;
      console.log(`[PRELOAD] Daily context loaded: prevClose=${dailyContext.prevClose.toFixed(2)} prevHigh=${dailyContext.prevHigh.toFixed(2)} prevLow=${dailyContext.prevLow.toFixed(2)}`);
    }
    
    // If we have enough bars, log readiness
    if (this.recentBars5m.length >= this.minimalLlmBars) {
      console.log(`[PRELOAD] Ready for LLM call: ${this.recentBars5m.length} bars >= ${this.minimalLlmBars} minimal`);
    } else {
      console.log(`[PRELOAD] Not ready for LLM call: ${this.recentBars5m.length} bars < ${this.minimalLlmBars} minimal`);
    }
  }

  private async handleMinimal5m(snapshot: TickSnapshot): Promise<DomainEvent[]> {
    const { ts, symbol, close } = snapshot;
    const events: DomainEvent[] = [];
    const regime = getMarketRegime(new Date(ts));
    if (!regime.isRTH) {
      this.state.minimalExecution.phase = "NEUTRAL_PHASE";
      this.state.minimalExecution.waitReason = "market_closed";
      return events;
    }

    // Closed 5m bar from BarAggregator - ONLY append, don't trigger LLM or reset anything
    const closedBar = {
      ts: snapshot.ts,
      open: snapshot.open ?? close,
      high: snapshot.high ?? close,
      low: snapshot.low ?? close,
      close: close,
      volume: snapshot.volume ?? 0,
    };
    this.recentBars5m.push(closedBar);
    if (this.recentBars5m.length > 120) this.recentBars5m.shift();
    this.state.last5mCloseTs = closedBar.ts;
    console.log(
      `[CLOSE5M] ts=${closedBar.ts} lenClosed=${this.recentBars5m.length} o=${closedBar.open.toFixed(2)} h=${closedBar.high.toFixed(2)} l=${closedBar.low.toFixed(2)} c=${closedBar.close.toFixed(2)} v=${closedBar.volume}`
    );

    // That's it - no LLM call, no candidate regeneration, no reset
    // LLM is called every 1m in handleMinimal1m
    // Entry logic is checked every 1m in handleMinimal1m

    return events;
  }
}
