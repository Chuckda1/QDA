import type { BotState, DomainEvent, Play, TradeAction } from "../types.js";
import type { LLMService } from "../llm/llmService.js";
import { StopProfitRules } from "../rules/stopProfitRules.js";

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
  private llmCoachCache: Map<string, number> = new Map(); // playId_barTs -> timestamp

  constructor(instanceId: string, llmService?: LLMService) {
    this.instanceId = instanceId;
    this.llmService = llmService;
    this.stopProfitRules = new StopProfitRules();
    this.state = {
      startedAt: Date.now(),
      session: "RTH",
      activePlay: null,
      mode: "QUIET"
    };
  }

  getState(): BotState {
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
    const { ts, symbol, close } = snapshot;

    // If no active play, create one deterministically
    if (!this.state.activePlay) {
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
        legitimacy: 72,
        followThroughProb: 65,
        action: "SCALP" as TradeAction,
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
        text: `Entry zone active. Ready to enter now.`,
        waitBars: 0
      }));

      events.push(this.ev("LLM_VERIFY", ts, {
        playId: play.id,
        symbol: play.symbol,
        direction: play.direction,
        legitimacy: play.legitimacy,
        followThroughProb: play.followThroughProb,
        action: play.action,
        reasoning: "Setup looks valid with moderate confidence. Scalp approach recommended."
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
   * Handle 5m bars: LLM coaching loop (only if active play + entered)
   */
  private async handle5m(snapshot: TickSnapshot): Promise<DomainEvent[]> {
    const events: DomainEvent[] = [];
    const { ts, symbol, close } = snapshot;

    // Production sanity log: 5m bar close
    const playId = this.state.activePlay?.id || "none";
    const entered = this.state.activePlay?.entered || false;
    console.log(`[5m] barClose ts=${ts} play=${playId} entered=${entered}`);

    // If no active play → return []
    if (!this.state.activePlay) {
      return events;
    }

    const play = this.state.activePlay;

    // INVARIANT CHECK: If active play exists but not entered → return [] (no coaching yet)
    if (!play.entered) {
      console.log(`[5m] Skipping coaching - play ${play.id} not yet entered`);
      return events;
    }

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

    // Call LLM with rules context for pattern analysis
    if (this.llmService && !play.stopHit) {
      try {
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

        // Cache this call (mark as processed for this 5m bar)
        // Cache key: playId + "_" + bar5m.ts (stable 5m close timestamp)
        this.llmCoachCache.set(cacheKey, Date.now());
        
        // Clean old cache entries (keep last 10)
        if (this.llmCoachCache.size > 10) {
          const firstKey = this.llmCoachCache.keys().next().value;
          if (firstKey) this.llmCoachCache.delete(firstKey);
        }

        // Production sanity log: coaching sent
        console.log(`[5m] sentCoach play=${play.id} ts=${ts} action=${llmAction}`);

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
        console.error("LLM call failed:", error.message);
        // If LLM fails, continue holding (don't exit on error)
      }
    }

    return events;
  }

  private ev(type: DomainEvent["type"], timestamp: number, data: Record<string, any>): DomainEvent {
    return { type, timestamp, instanceId: this.instanceId, data };
  }
}
