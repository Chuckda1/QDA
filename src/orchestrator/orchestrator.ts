import type { BotState, DomainEvent, Play, TradeAction } from "../types.js";
import type { LLMService } from "../llm/llmService.js";
import { StopProfitRules } from "../rules/stopProfitRules.js";

export class Orchestrator {
  private state: BotState;
  private instanceId: string;
  private llmService?: LLMService;
  private stopProfitRules: StopProfitRules;

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
   * Entry zone: Rules first → LLM second
   *   Order: PLAY_ARMED → TIMING_COACH → LLM_VERIFY → TRADE_PLAN
   * 
   * Stop/Take Profit: LLM first → Rules second
   *   Order: LLM_COACH_UPDATE → Rules validation → PLAY_CLOSED (if exit)
   */
  async processTick(input: { ts: number; symbol: string; close: number }): Promise<DomainEvent[]> {
    const events: DomainEvent[] = [];
    this.state.lastTickAt = input.ts;
    this.state.price = input.close;

    // If no active play, create one deterministically
    if (!this.state.activePlay) {
      const play: Play = {
        id: `play_${input.ts}`,
        symbol: input.symbol,
        direction: "LONG",
        score: 53,
        grade: "C",
        mode: "SCOUT",
        confidence: 53,
        entryZone: { low: input.close - 0.28, high: input.close + 0.20 },
        stop: input.close - 0.72,
        targets: { t1: input.close + 0.92, t2: input.close + 1.88, t3: input.close + 2.85 },
        legitimacy: 72,
        followThroughProb: 65,
        action: "SCALP" as TradeAction
      };
      this.state.activePlay = play;

      // Strict ordering: all events in same tick
      events.push(this.ev("PLAY_ARMED", input.ts, {
        play,
        headline: `${play.mode} PLAY ARMED`,
      }));

      events.push(this.ev("TIMING_COACH", input.ts, {
        playId: play.id,
        symbol: play.symbol,
        direction: play.direction,
        mode: play.mode,
        confidence: play.confidence,
        text: `Entry zone active. Ready to enter now.`,
        waitBars: 0
      }));

      events.push(this.ev("LLM_VERIFY", input.ts, {
        playId: play.id,
        symbol: play.symbol,
        direction: play.direction,
        legitimacy: play.legitimacy,
        followThroughProb: play.followThroughProb,
        action: play.action,
        reasoning: "Setup looks valid with moderate confidence. Scalp approach recommended."
      }));

      events.push(this.ev("TRADE_PLAN", input.ts, {
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
    const close = input.close;

    // ============================================
    // STOP/TAKE PROFIT: LLM FIRST (with rules context), LLM DECISION IS FINAL
    // ============================================
    
    // Step 1: Get rules context for LLM pattern analysis
    // Use actual entry price if available, otherwise use entryZone midpoint
    const entryPrice = play.entryZone.low + (play.entryZone.high - play.entryZone.low) / 2;
    const rulesContext = this.stopProfitRules.getContext(play, close, entryPrice);
    
    // Step 2: Check hard stop on CLOSE (only exit trigger - no override)
    // Note: Only close price triggers stop, not wicks
    if (rulesContext.stopHitOnClose && !play.stopHit) {
      play.stopHit = true;
      events.push(this.ev("PLAY_CLOSED", input.ts, {
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
    
    // Step 3: Call LLM with rules context for pattern analysis
    let llmAction: "HOLD" | "TAKE_PROFIT" | "TIGHTEN_STOP" | "STOP_OUT" | "SCALE_OUT" = "HOLD";
    let llmReasoning = "";
    let llmUrgency: "LOW" | "MEDIUM" | "HIGH" = "LOW";

    if (this.llmService && !play.stopHit) {
      try {
        const timeInTrade = this.state.lastTickAt 
          ? Math.floor((input.ts - this.state.lastTickAt) / 60000)
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
            stopThreatened: rulesContext.stopThreatened,
            nearTarget: rulesContext.nearTarget,
            targetHit: rulesContext.targetHit,
            risk: rulesContext.risk,
            rewardT1: rulesContext.rewardT1,
            rMultipleT1: rulesContext.rMultipleT1,
            rMultipleT2: rulesContext.rMultipleT2,
            rMultipleT3: rulesContext.rMultipleT3,
            profitPercent: rulesContext.profitPercent
          }
        });

        llmAction = llmResponse.action;
        llmReasoning = llmResponse.reasoning;
        llmUrgency = llmResponse.urgency;

        // Emit LLM coaching update
        events.push(this.ev("LLM_COACH_UPDATE", input.ts, {
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
        
        // Step 4: LLM decision is FINAL - if LLM says exit, we exit
        if (llmAction === "STOP_OUT" || llmAction === "TAKE_PROFIT") {
          play.stopHit = true;
          
          const result = llmAction === "TAKE_PROFIT" ? "WIN" : "LOSS";
          const exitType = llmAction === "TAKE_PROFIT" ? "TAKE_PROFIT" : "STOP_HIT";
          
          events.push(this.ev("PLAY_CLOSED", input.ts, {
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
    } else {
      // No LLM service - use periodic updates
      const tsMinutes = Math.floor(input.ts / 1000 / 60);
      const fiveMinMark = tsMinutes % 5 === 0;
      if (fiveMinMark && play.lastCoachUpdate !== tsMinutes) {
        play.lastCoachUpdate = tsMinutes;
        events.push(this.ev("LLM_COACH_UPDATE", input.ts, {
          playId: play.id,
          symbol: play.symbol,
          direction: play.direction,
          price: close,
          update: "Monitoring price action. Stay disciplined with stop."
        }));
      }
    }

    // Entry eligible tracking
    const inZone = close >= play.entryZone.low && close <= play.entryZone.high;
    if (inZone && !play.inEntryZone) {
      play.inEntryZone = true;
    }
    if (!inZone) play.inEntryZone = false;

    return events;
  }

  private ev(type: DomainEvent["type"], timestamp: number, data: Record<string, any>): DomainEvent {
    return { type, timestamp, instanceId: this.instanceId, data };
  }
}
