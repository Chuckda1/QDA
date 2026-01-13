import type { BotState, DomainEvent, Play, TradeAction } from "../types.js";
import type { LLMService } from "../llm/llmService.js";
import { StopProfitRules } from "../rules/stopProfitRules.js";
import { EntryFilters, type EntryFilterContext } from "../rules/entryFilters.js";
import { getMarketSessionLabel } from "../utils/timeUtils.js";

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
  private llmCoachCache: Map<string, number> = new Map(); // playId_barTs -> timestamp (for entered plays)
  private llmArmedCoachCache: Map<string, number> = new Map(); // playId_barTs -> timestamp (for armed plays)
  private recentBars: Array<{ ts: number; high: number; low: number; close: number }> = []; // For pullback detection

  constructor(instanceId: string, llmService?: LLMService, initialState?: { activePlay?: Play | null }) {
    this.instanceId = instanceId;
    this.llmService = llmService;
    this.stopProfitRules = new StopProfitRules();
    this.entryFilters = new EntryFilters();
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

    // Update recent bars buffer for pullback detection (keep last 20 bars)
    if (high !== undefined && low !== undefined) {
      this.recentBars.push({ ts, high, low, close });
      if (this.recentBars.length > 20) {
        this.recentBars.shift();
      }
    }

    // If no active play, check entry filters before creating one
    if (!this.state.activePlay) {
      // Build entry filter context
      // Note: Indicators (VWAP, EMA, ATR, RSI) are optional - filters gracefully degrade if not available
      const filterContext: EntryFilterContext = {
        timestamp: ts,
        symbol,
        direction: "LONG", // Default direction (can be determined by setup detection logic)
        close,
        high,
        low,
        open,
        volume,
        indicators: undefined, // TODO: Calculate or fetch indicators if available
        recentBars: this.recentBars.length >= 5 ? [...this.recentBars] : undefined
      };

      // Check entry filters
      const filterResult = this.entryFilters.canCreateNewPlay(filterContext);
      if (!filterResult.allowed) {
        console.log(`[1m] Entry blocked by filter: ${filterResult.reason}`);
        return events; // Return empty events - no play created
      }
      
      // Log warnings if any (these don't block but inform LLM)
      if (filterResult.warnings && filterResult.warnings.length > 0) {
        console.log(`[1m] Entry filter warnings: ${filterResult.warnings.join("; ")}`);
      }
      
      const play: Play = {
        id: `play_${ts}`,
        symbol,
        direction: "LONG",
        score: 53,
        grade: "C",
        mode: "SCOUT",
        confidence: 53,
        entryZone: { low: close - 0.28, high: close + 0.20 },
        stop: close - 0.72,
        targets: { t1: close + 0.92, t2: close + 1.88, t3: close + 2.85 },
        legitimacy: 72, // Will be updated by LLM
        followThroughProb: 65, // Will be updated by LLM
        action: "SCALP" as TradeAction, // Will be updated by LLM
        armedTimestamp: ts, // Track when play was armed
        entered: false
      };
      this.state.activePlay = play;

      // Strict ordering: all events in same tick
      events.push(this.ev("PLAY_ARMED", ts, {
        play,
        headline: `${play.mode} PLAY ARMED`,
      }));

      events.push(this.ev("TIMING_COACH", ts, {
        playId: play.id,
        symbol: play.symbol,
        direction: play.direction,
        mode: play.mode,
        confidence: play.confidence,
        eligibility: "READY", // READY or NOT_READY
        eligibilityReason: "entry zone active",
        waitBars: 0, // Keep for cooldown logic if needed
        llmStatus: "Pending decision"
      }));

      // Call LLM for verification (if available)
      if (this.llmService) {
        try {
          console.log(`[1m] Calling LLM for play verification: ${play.id}`);
          // STAGE 3: Track LLM call
          this.state.lastLLMCallAt = Date.now();
          const llmVerify = await this.llmService.verifyPlaySetup({
            symbol: play.symbol,
            direction: play.direction,
            entryZone: play.entryZone,
            stop: play.stop,
            targets: play.targets,
            score: play.score,
            grade: play.grade,
            confidence: play.confidence,
            currentPrice: close,
            warnings: filterResult.warnings // Pass filter warnings to LLM
          });
          
          // STAGE 3: Track LLM decision
          this.state.lastLLMDecision = `VERIFY:${llmVerify.action}`;
          
          // Update play with LLM results
          play.legitimacy = llmVerify.legitimacy;
          play.followThroughProb = llmVerify.followThroughProb;
          play.action = llmVerify.action as TradeAction;
          
          events.push(this.ev("LLM_VERIFY", ts, {
            playId: play.id,
            symbol: play.symbol,
            direction: play.direction,
            legitimacy: llmVerify.legitimacy,
            followThroughProb: llmVerify.followThroughProb,
            action: llmVerify.action,
            reasoning: llmVerify.reasoning
          }));

          events.push(this.ev("TRADE_PLAN", ts, {
            playId: play.id,
            symbol: play.symbol,
            direction: play.direction,
            action: llmVerify.action,
            size: llmVerify.action === "GO_ALL_IN" ? "Full position" : "1/3 position",
            probability: llmVerify.followThroughProb,
            plan: llmVerify.plan
          }));
        } catch (error: any) {
          console.error(`[1m] LLM verification failed:`, error.message);
          // Fallback to hardcoded values
          events.push(this.ev("LLM_VERIFY", ts, {
            playId: play.id,
            symbol: play.symbol,
            direction: play.direction,
            legitimacy: play.legitimacy,
            followThroughProb: play.followThroughProb,
            action: play.action,
            reasoning: "LLM unavailable - using default values"
          }));

          events.push(this.ev("TRADE_PLAN", ts, {
            playId: play.id,
            symbol: play.symbol,
            direction: play.direction,
            action: play.action,
            size: "1/3 position",
            probability: play.followThroughProb,
            plan: "Enter on pullback to entry zone. Tight stop. Target T1."
          }));
        }
      } else {
        // No LLM service - use hardcoded values
        events.push(this.ev("LLM_VERIFY", ts, {
          playId: play.id,
          symbol: play.symbol,
          direction: play.direction,
          legitimacy: play.legitimacy,
          followThroughProb: play.followThroughProb,
          action: play.action,
          reasoning: "LLM service not available - using default values"
        }));

        events.push(this.ev("TRADE_PLAN", ts, {
          playId: play.id,
          symbol: play.symbol,
          direction: play.direction,
          action: play.action,
          size: "1/3 position",
          probability: play.followThroughProb,
          plan: "Enter on pullback to entry zone. Tight stop. Target T1."
        }));
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

    // Gate 1 - If no active play → return [] (no coaching)
    if (!this.state.activePlay) {
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
