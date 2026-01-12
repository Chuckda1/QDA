import type { Play } from "../types.js";

export interface RulesContext {
  // Hard stop on close (only exit trigger - no override)
  stopHitOnClose: boolean;
  
  // Information for LLM pattern analysis
  distanceToStop: number; // percentage (using close as denominator)
  distanceToStopDollars: number;
  distanceToT1: number; // percentage
  distanceToT1Dollars: number;
  distanceToT2: number; // percentage
  distanceToT2Dollars: number;
  distanceToT3: number; // percentage
  distanceToT3Dollars: number;
  
  // Pattern analysis data
  stopThreatened: boolean; // warning only (within threatR)
  nearTarget: "T1" | "T2" | "T3" | null;
  targetHit: "T1" | "T2" | "T3" | null;
  
  // Probability context for LLM
  risk: number; // |entry - stop| per share
  rewardT1: number; // reward to T1 per share
  rewardT2: number; // reward to T2 per share
  rewardT3: number; // reward to T3 per share
  rMultipleT1: number; // R-multiple to T1
  rMultipleT2: number; // R-multiple to T2
  rMultipleT3: number; // R-multiple to T3
  profitPercent: number; // if entered
}

/**
 * Rules provide context and information to LLM
 * LLM makes final decision - rules only trigger exit on hard stop close
 * 
 * All calculations follow exact formulas for SPY ETF
 */
export class StopProfitRules {
  private readonly threatR = 0.25; // Stop threatened threshold in R-multiples
  private readonly nearDollar = 0.03; // Near target threshold in dollars

  /**
   * Get rules context for LLM pattern analysis
   * Returns information, not decisions
   * 
   * Uses exact formulas:
   * - Stop hit: close <= stop (LONG) or close >= stop (SHORT)
   * - Stop threatened: close <= stop + threatR * risk (LONG)
   * - Distances: dStop = close - stop (LONG), dStop = stop - close (SHORT)
   * - Percent: pct = 100 * (distance / close)
   * - Risk: risk = |entry - stop|
   * - Reward: reward = T1 - entry (LONG) or entry - T1 (SHORT)
   * - R-multiple: R = reward / risk
   */
  getContext(
    play: Play,
    close: number, // 1m candle close price
    entryPrice?: number // actual entry fill price (if entered)
  ): RulesContext {
    // Get stop price (must be below entry for LONG, above for SHORT)
    const stop = this.getStopPrice(play);
    
    // Use provided entry or calculate from entryZone midpoint
    const entry = entryPrice ?? (play.entryZone.low + play.entryZone.high) / 2;
    
    // ============================================
    // 1) HARD STOP ON CLOSE (only exit trigger)
    // ============================================
    // LONG: STOP_HIT = (close <= stop)
    // SHORT: STOP_HIT = (close >= stop)
    const stopHitOnClose = play.direction === "LONG"
      ? close <= stop
      : close >= stop;
    
    // ============================================
    // 2) DOLLAR DISTANCES (exact formulas)
    // ============================================
    let distanceToStopDollars: number;
    let distanceToT1Dollars: number;
    let distanceToT2Dollars: number;
    let distanceToT3Dollars: number;
    
    if (play.direction === "LONG") {
      // LONG: dStop = close - stop
      distanceToStopDollars = close - stop;
      // LONG: dT1 = T1 - close
      distanceToT1Dollars = play.targets.t1 - close;
      distanceToT2Dollars = play.targets.t2 - close;
      distanceToT3Dollars = play.targets.t3 - close;
    } else {
      // SHORT: dStop = stop - close
      distanceToStopDollars = stop - close;
      // SHORT: dT1 = close - T1
      distanceToT1Dollars = close - play.targets.t1;
      distanceToT2Dollars = close - play.targets.t2;
      distanceToT3Dollars = close - play.targets.t3;
    }
    
    // ============================================
    // 3) PERCENT DISTANCES (exact formula)
    // ============================================
    // pct(x) = 100 * (x / close)
    const distanceToStop = 100 * (distanceToStopDollars / close);
    const distanceToT1 = 100 * (distanceToT1Dollars / close);
    const distanceToT2 = 100 * (distanceToT2Dollars / close);
    const distanceToT3 = 100 * (distanceToT3Dollars / close);
    
    // ============================================
    // 4) RISK (exact formula)
    // ============================================
    // risk = |entry - stop|
    const risk = Math.abs(entry - stop);
    
    // ============================================
    // 5) REWARD (exact formulas)
    // ============================================
    let rewardT1: number;
    let rewardT2: number;
    let rewardT3: number;
    
    if (play.direction === "LONG") {
      // LONG: reward_T1 = T1 - entry
      rewardT1 = play.targets.t1 - entry;
      rewardT2 = play.targets.t2 - entry;
      rewardT3 = play.targets.t3 - entry;
    } else {
      // SHORT: reward_T1 = entry - T1
      rewardT1 = entry - play.targets.t1;
      rewardT2 = entry - play.targets.t2;
      rewardT3 = entry - play.targets.t3;
    }
    
    // ============================================
    // 6) R-MULTIPLES (exact formula)
    // ============================================
    // R_T1 = reward_T1 / risk
    const rMultipleT1 = risk > 0 ? rewardT1 / risk : 0;
    const rMultipleT2 = risk > 0 ? rewardT2 / risk : 0;
    const rMultipleT3 = risk > 0 ? rewardT3 / risk : 0;
    
    // ============================================
    // 7) STOP THREATENED (warning only, R-based)
    // ============================================
    // Option B: within threatR * risk
    // LONG: stopThreatened = close <= stop + threatR * risk
    // SHORT: stopThreatened = close >= stop - threatR * risk
    const stopThreatened = play.direction === "LONG"
      ? close <= stop + this.threatR * risk
      : close >= stop - this.threatR * risk;
    
    // ============================================
    // 8) TARGET HIT (close-based)
    // ============================================
    // LONG: T1Hit = (close >= T1)
    // SHORT: T1Hit = (close <= T1)
    let targetHit: "T1" | "T2" | "T3" | null = null;
    
    if (play.direction === "LONG") {
      if (close >= play.targets.t3) targetHit = "T3";
      else if (close >= play.targets.t2) targetHit = "T2";
      else if (close >= play.targets.t1) targetHit = "T1";
    } else {
      // SHORT
      if (close <= play.targets.t3) targetHit = "T3";
      else if (close <= play.targets.t2) targetHit = "T2";
      else if (close <= play.targets.t1) targetHit = "T1";
    }
    
    // ============================================
    // 9) NEAR TARGET (optional)
    // ============================================
    // Using dollar threshold: nearDollar = 0.03
    let nearTarget: "T1" | "T2" | "T3" | null = null;
    
    if (play.direction === "LONG") {
      if (!targetHit) {
        if (close >= play.targets.t1 - this.nearDollar) nearTarget = "T1";
        else if (close >= play.targets.t2 - this.nearDollar) nearTarget = "T2";
        else if (close >= play.targets.t3 - this.nearDollar) nearTarget = "T3";
      }
    } else {
      // SHORT
      if (!targetHit) {
        if (close <= play.targets.t1 + this.nearDollar) nearTarget = "T1";
        else if (close <= play.targets.t2 + this.nearDollar) nearTarget = "T2";
        else if (close <= play.targets.t3 + this.nearDollar) nearTarget = "T3";
      }
    }
    
    // ============================================
    // 10) PROFIT PERCENT (if entered)
    // ============================================
    // LONG: profitPct = 100 * (close - entry) / entry
    // SHORT: profitPct = 100 * (entry - close) / entry
    let profitPercent: number;
    if (play.direction === "LONG") {
      profitPercent = 100 * (close - entry) / entry;
    } else {
      profitPercent = 100 * (entry - close) / entry;
    }
    
    return {
      stopHitOnClose, // Only hard exit trigger
      distanceToStop,
      distanceToStopDollars,
      distanceToT1,
      distanceToT1Dollars,
      distanceToT2,
      distanceToT2Dollars,
      distanceToT3,
      distanceToT3Dollars,
      stopThreatened, // Warning only, not exit trigger
      nearTarget,
      targetHit,
      risk,
      rewardT1,
      rewardT2,
      rewardT3,
      rMultipleT1,
      rMultipleT2,
      rMultipleT3,
      profitPercent
    };
  }
  
  /**
   * Get stop price from play
   * For LONG: stop must be below entry
   * For SHORT: stop must be above entry
   * 
   * If play.stop is invalid (e.g., stop > entry for LONG), 
   * this will be caught by validation
   */
  private getStopPrice(play: Play): number {
    return play.stop;
  }
  
  /**
   * Check if hard stop was hit on close (only exit trigger)
   * Returns true only if close price crossed stop
   * 
   * LONG: close <= stop
   * SHORT: close >= stop
   */
  isStopHitOnClose(play: Play, closePrice: number): boolean {
    const stop = this.getStopPrice(play);
    return play.direction === "LONG"
      ? closePrice <= stop
      : closePrice >= stop;
  }
  
  /**
   * Validate stop price is correct for direction
   * LONG: stop must be < entry
   * SHORT: stop must be > entry
   */
  validateStop(play: Play, entryPrice: number): { valid: boolean; error?: string } {
    const stop = this.getStopPrice(play);
    
    if (play.direction === "LONG") {
      if (stop >= entryPrice) {
        return {
          valid: false,
          error: `LONG stop (${stop}) must be below entry (${entryPrice})`
        };
      }
    } else {
      // SHORT
      if (stop <= entryPrice) {
        return {
          valid: false,
          error: `SHORT stop (${stop}) must be above entry (${entryPrice})`
        };
      }
    }
    
    return { valid: true };
  }
}
