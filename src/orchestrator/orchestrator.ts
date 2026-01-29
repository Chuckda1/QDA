import { randomUUID } from "crypto";
import { getMarketRegime, getMarketSessionLabel } from "../utils/timeUtils.js";
import { extractSwings, lastSwings } from "../utils/swing.js";
import type {
  BotMode,
  BotState,
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
  RawBar,
  ResolutionGate,
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
  private checkGateTrigger(
    gate: ResolutionGate,
    currentPrice: number,
    nowTs: number,
    maxVolThreshold: number = 2.0 // Simplified - would use actual volatility
  ): boolean {
    if (gate.status !== "ARMED") return false;
    if (nowTs > gate.expiryTs) return false;

    // Check price trigger
    let priceTriggered = false;
    if (gate.direction === "short") {
      priceTriggered = currentPrice <= gate.triggerPrice;
    } else {
      priceTriggered = currentPrice >= gate.triggerPrice;
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
  }

  // Map LLM action to market bias (sticky, only flips on invalidation)
  private llmActionToBias(action: "ARM_LONG" | "ARM_SHORT" | "WAIT" | "A+", llmBias: "bullish" | "bearish" | "neutral"): "BEARISH" | "BULLISH" | "NEUTRAL" {
    if (action === "ARM_LONG" || (action === "A+" && llmBias === "bullish")) {
      return "BULLISH";
    } else if (action === "ARM_SHORT" || (action === "A+" && llmBias === "bearish")) {
      return "BEARISH";
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
      if (isBearish && hasUpperWick && previous5m && current5m.high > previous5m.high) {
        return { type: "REJECTION_ENTRY", trigger: "Bearish rejection at resistance" };
      }
      // Breakdown entry: breaks below previous low
      if (previous5m && current5m.low < previous5m.low) {
        return { type: "BREAKDOWN_ENTRY", trigger: "Breakdown below previous low" };
      }
    } else if (bias === "BULLISH") {
      // Rejection entry: bullish candle with lower wick at support
      if (isBullish && hasLowerWick && previous5m && current5m.low < previous5m.low) {
        return { type: "REJECTION_ENTRY", trigger: "Bullish rejection at support" };
      }
      // Breakdown entry: breaks above previous high
      if (previous5m && current5m.high > previous5m.high) {
        return { type: "BREAKDOWN_ENTRY", trigger: "Breakout above previous high" };
      }
    }

    return { type: null, trigger: "" };
  }

  private computeTargets(direction: "long" | "short", entry: number, stop: number): number[] {
    const risk = Math.abs(entry - stop);
    if (!Number.isFinite(risk) || risk <= 0) return [];
    return direction === "long"
      ? [entry + risk, entry + risk * 2]
      : [entry - risk, entry - risk * 2];
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
    closed5mBars: Array<{ high: number; low: number; close: number }>
  ): NoTradeDiagnostic | null {
    // Only emit when: phase === PULLBACK_IN_PROGRESS, entryStatus === inactive (not IN_TRADE), price moved > 0.75 ATR
    if (exec.phase !== "PULLBACK_IN_PROGRESS") return null;
    if (atr <= 0) return null;

    // Check if price moved significantly
    const priceMoved = this.lastDiagnosticPrice !== null 
      ? Math.abs(currentPrice - this.lastDiagnosticPrice) > 0.75 * atr
      : false;

    if (!priceMoved && this.lastDiagnosticPrice !== null) return null;

    // Determine reason code (canonical, no ambiguity)
    let reasonCode: NoTradeReasonCode;
    let details: string;

    if (!exec.resolutionGate || exec.resolutionGate.status === "INACTIVE") {
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
      const timeExpired = Date.now() > exec.resolutionGate.expiryTs;
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
    const regime = getMarketRegime(new Date());
    if (!regime.isRTH) {
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
  private shouldBlockEntry(
    bias: MarketBias,
    phase: MinimalExecutionPhase,
    currentPrice: number,
    pullbackHigh?: number,
    pullbackLow?: number
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
  private getPhaseAwareReason(bias: MarketBias, phase: MinimalExecutionPhase, waitReason?: string): string {
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

  private async handleMinimal1m(snapshot: TickSnapshot): Promise<DomainEvent[]> {
    const { ts, symbol, close } = snapshot;
    const events: DomainEvent[] = [];
      const regime = getMarketRegime(new Date(ts));
      if (!regime.isRTH) {
        this.state.minimalExecution.phase = "NEUTRAL_PHASE";
        this.state.minimalExecution.waitReason = "market_closed";
        return events;
      }

      // Update forming5mBar state
    const forming5mBar = this.updateForming5mBar(snapshot);
    if (forming5mBar) {
      const progress = forming5mBar.progressMinutes;
      console.log(
        `[FORMING5M] start=${forming5mBar.startTs} progress=${progress}/5 o=${forming5mBar.open.toFixed(2)} h=${forming5mBar.high.toFixed(2)} l=${forming5mBar.low.toFixed(2)} c=${forming5mBar.close.toFixed(2)} v=${forming5mBar.volume}`
      );
    }

    const closed5mBars = this.recentBars5m;
    const lastClosed5m = closed5mBars[closed5mBars.length - 1] ?? null;
    const exec = this.state.minimalExecution;
    let shouldPublishEvent = false;
    let debugInfo: MinimalDebugInfo | undefined = undefined;

    // LLM called every 1m with RAW BARS ONLY (no candidates)
    if (this.llmService && (closed5mBars.length > 0 || forming5mBar !== null)) {
      const llmSnapshot: MinimalLLMSnapshot = {
        symbol,
        nowTs: ts,
        closed5mBars: closed5mBars.slice(-30), // Last 30 closed bars
        forming5mBar,
      };

      console.log(
        `[LLM1M] closed5m=${closed5mBars.length} forming=${forming5mBar ? "yes" : "no"} callingLLM=true`
      );
      const result = await this.llmService.getArmDecisionRaw5m({
        snapshot: llmSnapshot,
      });
      const decision = result.decision;
      this.state.lastLLMCallAt = ts;
      this.state.lastLLMDecision = decision.because ?? decision.action;

      const llmDirection: "long" | "short" | "none" = 
        decision.action === "ARM_LONG" ? "long" :
        decision.action === "ARM_SHORT" ? "short" :
        decision.action === "A+" ? (decision.bias === "bearish" ? "short" : "long") : "none";
      
      const isMaturityFlip = decision.action === "A+";

      // CRITICAL: Wire MarketBias as single source of truth
      const newBias = this.llmActionToBias(decision.action, decision.bias);
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
        // LLM confidence becomes base weight only
        exec.baseBiasConfidence = decision.confidence;
        exec.biasPrice = close;
        exec.biasTs = ts;
        if (exec.activeCandidate) {
          exec.biasInvalidationLevel = exec.activeCandidate.invalidationLevel;
        }
        // Calculate derived confidence
        exec.biasConfidence = this.calculateDerivedConfidence(exec, close, closed5mBars, ts);
      }

      // Legacy compatibility: sync thesisDirection to bias
      exec.thesisDirection = exec.bias === "BULLISH" ? "long" : exec.bias === "BEARISH" ? "short" : "none";
      // Update derived confidence continuously (not just on bias change)
      if (exec.bias !== "NEUTRAL") {
        exec.biasConfidence = this.calculateDerivedConfidence(exec, close, closed5mBars, ts);
      exec.thesisConfidence = exec.biasConfidence;
      }

      console.log(
        `[LLM1M] action=${decision.action} bias=${exec.bias} maturity=${decision.maturity} baseConf=${exec.baseBiasConfidence ?? decision.confidence} derivedConf=${exec.biasConfidence ?? "n/a"} phase=${exec.phase}`
      );

      // Track previous state to detect changes
      const previousBias = exec.bias;
      const previousPhase = exec.phase;

      // Generate candidates and match direction ONLY if:
      // 1. Bias changed, OR
      // 2. No bias exists yet (NEUTRAL)
      const needsNewSetup = 
        (newBias !== exec.bias) ||
        (exec.bias === "NEUTRAL");

      // Handle A+ (maturity flip) - immediate entry opportunity
      if (isMaturityFlip && (llmDirection === "long" || llmDirection === "short")) {
        console.log(
          `[A+_FLIP] Maturity flip detected: ${decision.bias} bias, ${decision.maturity} maturity, immediate ${llmDirection.toUpperCase()} opportunity`
        );
        
        // For A+, we can enter immediately without waiting for pullback
        const barsForCandidates = closed5mBars.length > 0 ? closed5mBars : (forming5mBar ? [{
          ts: forming5mBar.endTs,
          open: forming5mBar.open,
          high: forming5mBar.high,
          low: forming5mBar.low,
          close: forming5mBar.close,
          volume: forming5mBar.volume,
        }] : []);

        const candidates = this.buildMinimalSetupCandidates({
          closed5mBars: barsForCandidates,
          activeDirection: exec.thesisDirection,
        });

        const matchingCandidate = candidates.find(
          (c) => c.direction === (llmDirection === "long" ? "LONG" : "SHORT")
        );

        // A+ can enter even without perfect candidate match (maturity flips are opportunistic)
        exec.activeCandidate = matchingCandidate; // May be undefined for A+ - that's OK
        if (matchingCandidate) {
          exec.biasInvalidationLevel = matchingCandidate.invalidationLevel;
        }
        
        // A+ can enter immediately on the current bar
        const current5m = forming5mBar ?? lastClosed5m;
        if (current5m) {
          const oldPhase = exec.phase;
          const entryInfo = this.detectEntryType(exec.bias, current5m, closed5mBars.length >= 2 ? closed5mBars[closed5mBars.length - 2] : undefined);
          
          exec.entryPrice = current5m.close;
          exec.entryTs = ts;
          exec.entryType = entryInfo.type;
          exec.entryTrigger = entryInfo.trigger || "A+ maturity flip";
          exec.pullbackHigh = current5m.high;
          exec.pullbackLow = current5m.low;
          exec.pullbackTs = ts;
          exec.stopPrice = llmDirection === "long" ? current5m.low : current5m.high;
          exec.targets = this.computeTargets(llmDirection, exec.entryPrice, exec.stopPrice);
          exec.phase = "IN_TRADE";
          exec.waitReason = "a+_maturity_flip_entry";
          shouldPublishEvent = true;
          console.log(
            `[STATE_TRANSITION] ${oldPhase} -> IN_TRADE | A+ ${exec.bias} entry at ${exec.entryPrice.toFixed(2)} type=${exec.entryType} trigger="${exec.entryTrigger}" stop=${exec.stopPrice.toFixed(2)}`
          );
        } else {
          exec.phase = exec.bias === "NEUTRAL" ? "NEUTRAL_PHASE" : "PULLBACK_IN_PROGRESS";
          exec.waitReason = "waiting_for_pullback";
          shouldPublishEvent = true;
        }
      } else if (needsNewSetup && (llmDirection === "long" || llmDirection === "short")) {
        console.log(
          `[SETUP_GEN] BIAS change: ${exec.bias} -> ${newBias}, generating candidates`
        );

        // Bot generates setups from raw data
        const barsForCandidates = closed5mBars.length > 0 ? closed5mBars : (forming5mBar ? [{
          ts: forming5mBar.endTs,
          open: forming5mBar.open,
          high: forming5mBar.high,
          low: forming5mBar.low,
          close: forming5mBar.close,
          volume: forming5mBar.volume,
        }] : []);

        const candidates = this.buildMinimalSetupCandidates({
          closed5mBars: barsForCandidates,
          activeDirection: exec.thesisDirection,
        });

        debugInfo = {
          barsClosed5m: closed5mBars.length,
          hasForming5m: !!forming5mBar,
          formingProgressMin: forming5mBar?.progressMinutes ?? null,
          formingStartTs: forming5mBar?.startTs ?? null,
          formingEndTs: forming5mBar?.endTs ?? null,
          formingRange: forming5mBar ? (forming5mBar.high - forming5mBar.low) : null,
          lastClosedRange: lastClosed5m ? (lastClosed5m.high - lastClosed5m.low) : null,
          candidateBarsUsed: barsForCandidates.length,
          candidateCount: candidates.length,
          botPhase: exec.phase,
          botWaitReason: exec.waitReason ?? null,
        };

        // Bot matches LLM direction to correct candidate
        const matchingCandidate = candidates.find(
          (c) => c.direction === (llmDirection === "long" ? "LONG" : "SHORT")
        );

        if (matchingCandidate) {
          const oldPhase = exec.phase;
          exec.thesisDirection = llmDirection;
          // LLM confidence becomes base weight only
          exec.baseBiasConfidence = decision.confidence;
          exec.activeCandidate = matchingCandidate;
          exec.thesisPrice = lastClosed5m?.close ?? close;
          exec.thesisTs = ts;
          exec.phase = "BIAS_ESTABLISHED";
          exec.waitReason = "waiting_for_pullback";
          // Set ExpectedResolution: expect continuation when pullback occurs
          exec.expectedResolution = "CONTINUATION";
          // Calculate derived confidence
          exec.biasConfidence = this.calculateDerivedConfidence(exec, close, closed5mBars, ts);
          exec.thesisConfidence = exec.biasConfidence;
          this.clearTradeState(exec);
          shouldPublishEvent = true; // Thesis changed - publish event
          console.log(
            `[STATE_TRANSITION] ${oldPhase} -> BIAS_ESTABLISHED | ${llmDirection.toUpperCase()} bias established, candidate=${matchingCandidate.id} inv=${matchingCandidate.invalidationLevel.toFixed(2)} baseConf=${decision.confidence} derivedConf=${exec.biasConfidence} expectedResolution=${exec.expectedResolution}`
          );
        } else {
          console.log(
            `[SETUP_MATCH] FAIL: No matching candidate for ${llmDirection} (candidates=${candidates.length}, directions=${candidates.map(c => c.direction).join(",")})`
          );
        }
      } else if (llmDirection === "none" || newBias === "NEUTRAL") {
        // LLM says WAIT - but keep bias unless invalidated
        // Only change phase, don't clear bias unless price invalidates it
        if (exec.bias !== "NEUTRAL" && exec.phase !== "IN_TRADE") {
          const oldPhase = exec.phase;
          exec.activeCandidate = undefined;
          exec.phase = "PULLBACK_IN_PROGRESS";
          exec.waitReason = decision.waiting_for ?? "waiting_for_setup";
          // Set ExpectedResolution: expect continuation of bias direction
          exec.expectedResolution = exec.bias === "BEARISH" || exec.bias === "BULLISH" ? "CONTINUATION" : "UNDECIDED";
          // Track pullback levels for failure detection
          const current5mForPullback = forming5mBar ?? lastClosed5m;
          if (current5mForPullback) {
            exec.pullbackHigh = current5mForPullback.high;
            exec.pullbackLow = current5mForPullback.low;
            exec.pullbackTs = ts;
          }
          // Clear entry state but keep pullback levels
          exec.entryPrice = undefined;
          exec.entryTs = undefined;
          exec.entryType = undefined;
          exec.entryTrigger = undefined;
          exec.stopPrice = undefined;
          exec.targets = undefined;
          
          // Arm resolution gate if conditions are met
          if (exec.expectedResolution === "CONTINUATION" && 
              exec.pullbackHigh !== undefined && 
              exec.pullbackLow !== undefined &&
              (exec.bias === "BEARISH" || exec.bias === "BULLISH")) {
            const atr = this.calculateATR(closed5mBars);
            if (atr > 0) {
              this.armResolutionGate(
                exec,
                exec.bias,
                exec.pullbackHigh,
                exec.pullbackLow,
                atr,
                ts
              );
              // Logging is done inside armResolutionGate
            } else {
              console.log(
                `[GATE_NOT_ARMED] ATR=${atr.toFixed(4)} - ATR too low, cannot arm gate`
              );
            }
          } else {
            // Log why gate wasn't armed
            const reasons: string[] = [];
            if (exec.expectedResolution !== "CONTINUATION") reasons.push(`expectedResolution=${exec.expectedResolution}`);
            if (exec.pullbackHigh === undefined) reasons.push("pullbackHigh=undefined");
            if (exec.pullbackLow === undefined) reasons.push("pullbackLow=undefined");
            if (exec.bias !== "BEARISH" && exec.bias !== "BULLISH") reasons.push(`bias=${exec.bias}`);
            console.log(
              `[GATE_NOT_ARMED] Conditions not met: ${reasons.join(", ")}`
            );
          }
          
          shouldPublishEvent = true; // Phase change - publish event
          console.log(
            `[STATE_TRANSITION] ${oldPhase} -> ${exec.phase} | BIAS=${exec.bias} (maintained) expectedResolution=${exec.expectedResolution} entry_status=inactive`
          );
        }
      }

      // Monitor continuation progress and detect momentum pause
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
              exec.targets = this.computeTargets(exec.bias === "BULLISH" ? "long" : "short", exec.entryPrice, exec.stopPrice);
              exec.phase = "IN_TRADE";
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
          if (this.checkGateTrigger(exec.resolutionGate, current5m.close, ts)) {
            exec.resolutionGate.status = "TRIGGERED";
            console.log(
              `[GATE_TRIGGERED] ${exec.resolutionGate.direction.toUpperCase()} at ${current5m.close.toFixed(2)} trigger=${exec.resolutionGate.triggerPrice.toFixed(2)} - Entry permission granted`
            );
            // Entry will be handled by normal entry logic below
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
      // ENTRY LOGIC: Find and Enter Setups
      // ============================================================================
      // The bot finds setups by:
      // 1. Establishing bias (BEARISH/BULLISH) from LLM analysis
      // 2. Detecting pullback structure (PULLBACK_IN_PROGRESS phase)
      // 3. Arming resolution gate (if expectedResolution = CONTINUATION)
      // 4. Waiting for gate trigger (price hits trigger price)
      // 5. Entering on pullback rejection/breakdown when conditions are met
      //
      // Entry conditions:
      // - BULLISH bias: Enter on bearish candle OR lower low during pullback
      // - BEARISH bias: Enter on bullish candle OR higher high during pullback
      //
      // Entry is blocked if:
      // - Gate is ARMED but not TRIGGERED (waiting for price to hit trigger)
      // - No-chase rules triggered (continuation extended too far)
      // - Re-entry window expired
      // ============================================================================
      // Check for pullback entry every 1m (responsive, not just on 5m close)
      // Skip entry attempts during CONTINUATION_IN_PROGRESS (no-chase rule)
      if (exec.bias !== "NEUTRAL" && (exec.phase === "PULLBACK_IN_PROGRESS" || exec.phase === "BIAS_ESTABLISHED")) {
        const current5m = forming5mBar ?? lastClosed5m;
        const previous5m = closed5mBars.length >= 2 ? closed5mBars[closed5mBars.length - 2] : (closed5mBars.length >= 1 ? closed5mBars[closed5mBars.length - 1] : null);

        if (current5m) {
          // Diagnostic generation moved to mindState construction (below) to pass through to Telegram

          // Only allow entry if gate is TRIGGERED or no gate exists
          const gateAllowsEntry = !exec.resolutionGate || 
                                  exec.resolutionGate.status === "TRIGGERED" ||
                                  exec.resolutionGate.status === "INACTIVE";
          
          if (!gateAllowsEntry && exec.resolutionGate) {
            // Gate is ARMED but not triggered - wait for gate
            exec.waitReason = `waiting_for_gate_trigger_${exec.resolutionGate.direction}`;
            const priceVsTrigger = exec.resolutionGate.direction === "short"
              ? current5m.close - exec.resolutionGate.triggerPrice
              : exec.resolutionGate.triggerPrice - current5m.close;
            console.log(
              `[ENTRY_BLOCKED_BY_GATE] ${exec.resolutionGate.direction.toUpperCase()} gate=${exec.resolutionGate.status} price=${current5m.close.toFixed(2)} trigger=${exec.resolutionGate.triggerPrice.toFixed(2)} distance=${priceVsTrigger.toFixed(2)} - Waiting for gate trigger`
            );
            return events;
          } else if (gateAllowsEntry && exec.resolutionGate?.status === "TRIGGERED") {
            console.log(
              `[ENTRY_PERMITTED] Gate TRIGGERED, entry logic proceeding`
            );
          }
          // Check for pullback failure first (structure breaking against bias)
          if (exec.phase === "PULLBACK_IN_PROGRESS" && previous5m) {
            const pullbackFailed = this.detectPullbackFailure(
              exec.bias,
              exec.expectedResolution,
              current5m,
              previous5m,
              exec.pullbackHigh,
              exec.pullbackLow
            );

            if (pullbackFailed) {
              const oldPhase = exec.phase;
              exec.expectedResolution = "FAILURE";
              exec.phase = "CONSOLIDATION_AFTER_REJECTION";
              exec.waitReason = "pullback_failed";
              shouldPublishEvent = true;
              console.log(
                `[STATE_TRANSITION] ${oldPhase} -> ${exec.phase} | BIAS=${exec.bias} (maintained) expectedResolution=${exec.expectedResolution} - Pullback failed, structure breaking against bias`
              );
            } else {
              // Check for continuation detection (expected continuation now in progress)
              const continuationDetected = this.detectContinuation(
                exec.bias,
                exec.expectedResolution,
                current5m,
                previous5m,
                exec.pullbackHigh,
                exec.pullbackLow,
                closed5mBars
              );

              if (continuationDetected) {
                const oldPhase = exec.phase;
                exec.phase = "CONTINUATION_IN_PROGRESS";
                exec.waitReason = "continuation_underway";
                // Calculate continuation extension and track metrics
                if (exec.bias === "BULLISH" && exec.pullbackHigh !== undefined) {
                  exec.continuationExtension = current5m.close - exec.pullbackHigh;
                  exec.continuationLow = current5m.low; // Track lowest point during continuation
                  exec.impulseRange = current5m.high - exec.pullbackHigh; // Initial impulse range
                } else if (exec.bias === "BEARISH" && exec.pullbackLow !== undefined) {
                  exec.continuationExtension = exec.pullbackLow - current5m.close;
                  exec.continuationHigh = current5m.high; // Track highest point during continuation
                  exec.impulseRange = exec.pullbackLow - current5m.low; // Initial impulse range
                }
                exec.continuationStartTs = ts;
                exec.barsSinceContinuation = 0;
                shouldPublishEvent = true;
                console.log(
                  `[STATE_TRANSITION] ${oldPhase} -> ${exec.phase} | BIAS=${exec.bias} PRICE=${current5m.close.toFixed(2)} REF=${exec.pullbackHigh ?? exec.pullbackLow ?? "n/a"} NOTE: Expected continuation now in progress`
                );
              }
            }
          }

          const open = current5m.open ?? current5m.close;
          const isBearish = current5m.close < open;
          const isBullish = current5m.close > open;
          
          // For pullback detection, we need previous bar to compare, but allow entry with just current bar if it's bearish/bullish
          let lowerLow = false;
          let higherHigh = false;
          if (previous5m) {
            lowerLow = current5m.low < previous5m.low;
            higherHigh = current5m.high > previous5m.high;
          }

          // Enter ON pullback for BULLISH bias
          // Condition: current bar is bearish OR makes a lower low (if we have previous bar)
          if (exec.bias === "BULLISH" && (isBearish || (previous5m && lowerLow))) {
            console.log(
              `[ENTRY_CHECK] BULLISH bias - Entry condition met: isBearish=${isBearish} lowerLow=${lowerLow} price=${current5m.close.toFixed(2)} gate=${exec.resolutionGate?.status ?? "none"}`
            );
            // Check no-chase rules
            const blockCheck = this.shouldBlockEntry(exec.bias, exec.phase, current5m.close, exec.pullbackHigh, exec.pullbackLow);
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
            const entryInfo = this.detectEntryType(exec.bias, current5m, previous5m ?? undefined);
            
            exec.entryPrice = current5m.close;
            exec.entryTs = ts;
            exec.entryType = entryInfo.type;
            exec.entryTrigger = entryInfo.trigger || "Pullback entry";
            exec.pullbackHigh = current5m.high;
            exec.pullbackLow = current5m.low;
            exec.pullbackTs = ts;
            exec.stopPrice = current5m.low; // Stop at pullback low
            exec.targets = this.computeTargets("long", exec.entryPrice, exec.stopPrice);
            exec.phase = "IN_TRADE";
            exec.waitReason = "in_trade";
              exec.entryBlocked = false;
              exec.entryBlockReason = undefined;
            shouldPublishEvent = true; // Entry executed - publish event
            console.log(
              `[STATE_TRANSITION] ${oldPhase} -> IN_TRADE | BIAS=${exec.bias} entry=${exec.entryPrice.toFixed(2)} type=${exec.entryType} trigger="${exec.entryTrigger}" stop=${exec.stopPrice.toFixed(2)}`
            );
            }
          }

          // Enter ON pullback for BEARISH bias
          // Condition: current bar is bullish OR makes a higher high (if we have previous bar)
          if (exec.bias === "BEARISH" && (isBullish || (previous5m && higherHigh))) {
            console.log(
              `[ENTRY_CHECK] BEARISH bias - Entry condition met: isBullish=${isBullish} higherHigh=${higherHigh} price=${current5m.close.toFixed(2)} gate=${exec.resolutionGate?.status ?? "none"}`
            );
            // Check no-chase rules
            const blockCheck = this.shouldBlockEntry(exec.bias, exec.phase, current5m.close, exec.pullbackHigh, exec.pullbackLow);
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
            const entryInfo = this.detectEntryType(exec.bias, current5m, previous5m ?? undefined);
            
            exec.entryPrice = current5m.close;
            exec.entryTs = ts;
            exec.entryType = entryInfo.type;
            exec.entryTrigger = entryInfo.trigger || "Pullback entry";
            exec.pullbackHigh = current5m.high;
            exec.pullbackLow = current5m.low;
            exec.pullbackTs = ts;
            exec.stopPrice = current5m.high; // Stop at pullback high
            exec.targets = this.computeTargets("short", exec.entryPrice, exec.stopPrice);
            exec.phase = "IN_TRADE";
            exec.waitReason = "in_trade";
              exec.entryBlocked = false;
              exec.entryBlockReason = undefined;
            shouldPublishEvent = true; // Entry executed - publish event
            console.log(
              `[STATE_TRANSITION] ${oldPhase} -> IN_TRADE | BIAS=${exec.bias} entry=${exec.entryPrice.toFixed(2)} type=${exec.entryType} trigger="${exec.entryTrigger}" stop=${exec.stopPrice.toFixed(2)}`
            );
            }
          }
        }
      }

      // Check trade management if in trade
      if (exec.phase === "IN_TRADE" && exec.entryPrice !== undefined && exec.stopPrice !== undefined && exec.targets) {
        const current5m = forming5mBar ?? lastClosed5m;
        if (current5m) {
          // Check stop
          if (exec.thesisDirection === "long" && current5m.low <= exec.stopPrice) {
            const oldPhase = exec.phase;
            const newPhase = exec.bias === "NEUTRAL" ? "NEUTRAL_PHASE" : "PULLBACK_IN_PROGRESS";
            console.log(
              `[STATE_TRANSITION] ${oldPhase} -> ${newPhase} | Stop hit at ${current5m.low.toFixed(2)} (stop=${exec.stopPrice.toFixed(2)})`
            );
            exec.phase = newPhase;
            exec.waitReason = exec.bias === "NEUTRAL" ? "waiting_for_bias" : "waiting_for_pullback";
            this.clearTradeState(exec);
            shouldPublishEvent = true; // Exit - publish event
          } else if (exec.thesisDirection === "short" && current5m.high >= exec.stopPrice) {
            const oldPhase = exec.phase;
            console.log(
              `[STATE_TRANSITION] ${oldPhase} -> ${exec.bias === "NEUTRAL" ? "NEUTRAL_PHASE" : "PULLBACK_IN_PROGRESS"} | Stop hit at ${current5m.high.toFixed(2)} (stop=${exec.stopPrice.toFixed(2)})`
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

      // Publish event if state changed or important event occurred
      if (shouldPublishEvent || exec.phase !== previousPhase || exec.bias !== previousBias) {
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
        let noTradeDiagnostic: NoTradeDiagnostic | undefined = undefined;
        if (exec.phase === "PULLBACK_IN_PROGRESS") {
          const atr = this.calculateATR(closed5mBars);
          const diagnostic = this.generateNoTradeDiagnostic(exec, close, atr, closed5mBars);
          if (diagnostic) {
            noTradeDiagnostic = diagnostic;
            // Also emit to console for logging
            this.emitNoTradeDiagnostic(diagnostic);
            // Update last diagnostic price to prevent spam
            this.lastDiagnosticPrice = close;
          }
        }

        const mindState = {
          mindId: randomUUID(),
          direction: exec.thesisDirection ?? "none", // Legacy compatibility
          confidence: exec.biasConfidence ?? exec.thesisConfidence ?? 0,
          reason: this.getPhaseAwareReason(exec.bias, exec.phase, exec.waitReason),
          bias: exec.bias,
          phase: exec.phase,
          entryStatus: exec.entryBlocked 
            ? "blocked" as const 
            : (exec.phase === "IN_TRADE" ? "active" as const : "inactive" as const),
          entryType: exec.entryType ?? undefined,
          expectedResolution: exec.expectedResolution ?? undefined,
          price: close, // Current price (first-class)
          refPrice, // Reference price anchor
          refLabel, // Label for reference price
          noTradeDiagnostic, // Why no trade fired (when applicable)
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
      }
    }

    return events;
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
