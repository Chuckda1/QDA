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
  RawBar,
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
        exec.bias = newBias;
        exec.biasConfidence = decision.confidence;
        exec.biasPrice = close;
        exec.biasTs = ts;
        if (exec.activeCandidate) {
          exec.biasInvalidationLevel = exec.activeCandidate.invalidationLevel;
        }
      }

      // Legacy compatibility: sync thesisDirection to bias
      exec.thesisDirection = exec.bias === "BULLISH" ? "long" : exec.bias === "BEARISH" ? "short" : "none";
      exec.thesisConfidence = exec.biasConfidence;

      console.log(
        `[LLM1M] action=${decision.action} bias=${exec.bias} maturity=${decision.maturity} conf=${decision.confidence} phase=${exec.phase}`
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
          exec.thesisConfidence = decision.confidence;
          exec.activeCandidate = matchingCandidate;
          exec.thesisPrice = lastClosed5m?.close ?? close;
          exec.thesisTs = ts;
          exec.phase = "BIAS_ESTABLISHED";
          exec.waitReason = "waiting_for_pullback";
          // Set ExpectedResolution: expect continuation when pullback occurs
          exec.expectedResolution = "CONTINUATION";
          this.clearTradeState(exec);
          shouldPublishEvent = true; // Thesis changed - publish event
          console.log(
            `[STATE_TRANSITION] ${oldPhase} -> BIAS_ESTABLISHED | ${llmDirection.toUpperCase()} bias established, candidate=${matchingCandidate.id} inv=${matchingCandidate.invalidationLevel.toFixed(2)} conf=${decision.confidence} expectedResolution=${exec.expectedResolution}`
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
          shouldPublishEvent = true; // Phase change - publish event
          console.log(
            `[STATE_TRANSITION] ${oldPhase} -> ${exec.phase} | BIAS=${exec.bias} (maintained) expectedResolution=${exec.expectedResolution} entry_status=inactive`
          );
        }
      }

      // Check for pullback entry every 1m (responsive, not just on 5m close)
      if (exec.bias !== "NEUTRAL" && (exec.phase === "PULLBACK_IN_PROGRESS" || exec.phase === "BIAS_ESTABLISHED")) {
        const current5m = forming5mBar ?? lastClosed5m;
        const previous5m = closed5mBars.length >= 2 ? closed5mBars[closed5mBars.length - 2] : (closed5mBars.length >= 1 ? closed5mBars[closed5mBars.length - 1] : null);

        if (current5m) {
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
            shouldPublishEvent = true; // Entry executed - publish event
            console.log(
              `[STATE_TRANSITION] ${oldPhase} -> IN_TRADE | BIAS=${exec.bias} entry=${exec.entryPrice.toFixed(2)} type=${exec.entryType} trigger="${exec.entryTrigger}" stop=${exec.stopPrice.toFixed(2)}`
            );
          }

          // Enter ON pullback for BEARISH bias
          // Condition: current bar is bullish OR makes a higher high (if we have previous bar)
          if (exec.bias === "BEARISH" && (isBullish || (previous5m && higherHigh))) {
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
            shouldPublishEvent = true; // Entry executed - publish event
            console.log(
              `[STATE_TRANSITION] ${oldPhase} -> IN_TRADE | BIAS=${exec.bias} entry=${exec.entryPrice.toFixed(2)} type=${exec.entryType} trigger="${exec.entryTrigger}" stop=${exec.stopPrice.toFixed(2)}`
            );
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
            exec.waitReason = "stop_hit";
            this.clearTradeState(exec);
            shouldPublishEvent = true; // Exit - publish event
          } else if (exec.thesisDirection === "short" && current5m.high >= exec.stopPrice) {
            const oldPhase = exec.phase;
            console.log(
              `[STATE_TRANSITION] ${oldPhase} -> ${exec.bias === "NEUTRAL" ? "NEUTRAL_PHASE" : "PULLBACK_IN_PROGRESS"} | Stop hit at ${current5m.high.toFixed(2)} (stop=${exec.stopPrice.toFixed(2)})`
            );
            exec.phase = exec.bias === "NEUTRAL" ? "NEUTRAL_PHASE" : "PULLBACK_IN_PROGRESS";
            exec.waitReason = "stop_hit";
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
            exec.waitReason = "target_hit";
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
        } else if (exec.phase === "PULLBACK_IN_PROGRESS") {
          if (exec.bias === "BEARISH" && exec.pullbackHigh !== undefined) {
            refPrice = exec.pullbackHigh;
            refLabel = "pullback high";
          } else if (exec.bias === "BULLISH" && exec.pullbackLow !== undefined) {
            refPrice = exec.pullbackLow;
            refLabel = "pullback low";
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

        const mindState = {
          mindId: randomUUID(),
          direction: exec.thesisDirection ?? "none", // Legacy compatibility
          confidence: exec.biasConfidence ?? exec.thesisConfidence ?? 0,
          reason: this.getPhaseAwareReason(exec.bias, exec.phase, exec.waitReason),
          bias: exec.bias,
          phase: exec.phase,
          entryStatus: exec.phase === "IN_TRADE" ? "active" as const : "inactive" as const,
          entryType: exec.entryType ?? undefined,
          expectedResolution: exec.expectedResolution ?? undefined,
          price: close, // Current price (first-class)
          refPrice, // Reference price anchor
          refLabel, // Label for reference price
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
