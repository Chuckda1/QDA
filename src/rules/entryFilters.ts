/**
 * Entry Filters - Prevent chasing and bad timing entries
 * 
 * These filters are applied BEFORE creating a new play.
 * They do NOT affect management/exits of existing plays.
 */

import type { Direction } from "../types.js";
import { getETClock } from "../utils/timeUtils.js";

export interface IndicatorData {
  vwap?: number;
  ema20?: number;
  ema9?: number;
  atr?: number;
  rsi14?: number;
}

export interface EntryFilterContext {
  timestamp: number; // ms timestamp
  symbol: string;
  direction: Direction;
  close: number;
  high?: number;
  low?: number;
  open?: number;
  volume?: number;
  indicators?: IndicatorData;
  // For pullback detection - recent price history
  recentBars?: Array<{
    ts: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
}

export interface EntryFilterResult {
  allowed: boolean;
  reason?: string;
  warnings?: string[]; // Warnings that don't block but should inform LLM
}

/**
 * Entry filters to prevent chasing and bad timing
 */
export class EntryFilters {
  // Time-of-day cutoff: 15:30 ET (or 15:45 max)
  private readonly cutoffHour = 15;
  private readonly cutoffMinute = 30; // Can be increased to 45 if needed
  private readonly maxCutoffMinute = 45;

  // Extended-from-mean filter parameters
  private readonly maxVwapDistanceATR = 1.5; // k * ATR
  private readonly maxEmaDistanceATR = 1.5;

  // Pullback requirement parameters
  private readonly minPullbackATR = 0.5; // Minimum 0.5 ATR pullback
  private readonly maxPullbackATR = 1.0; // Maximum 1.0 ATR pullback (sweet spot)

  // RSI exhaustion guard
  private readonly rsiExhaustionThreshold = 70;
  private readonly rsiExhaustionVwapDistanceATR = 1.0;

  /**
   * Check entry conditions for a new play.
   *
   * IMPORTANT: These are now advisory-only (warnings). We do NOT hard-block
   * plays here; the LLM is the final gate to approve/veto after scoring.
   */
  canCreateNewPlay(context: EntryFilterContext): EntryFilterResult {
    const warnings: string[] = [];

    // Filter 1: Time-of-day cutoff
    const timeCheck = this.checkTimeOfDayCutoff(context.timestamp);
    if (!timeCheck.allowed) {
      warnings.push(`FILTER (non-blocking): ${timeCheck.reason}`);
    }

    // Filter 2: Extended-from-mean (anti-chase)
    const meanCheck = this.checkExtendedFromMean(context);
    if (!meanCheck.allowed) {
      warnings.push(`FILTER (non-blocking): ${meanCheck.reason}`);
    }

    // Filter 3: Impulse-then-pullback structure
    const pullbackCheck = this.checkImpulseThenPullback(context);
    if (!pullbackCheck.allowed) {
      warnings.push(`FILTER (non-blocking): ${pullbackCheck.reason}`);
    }

    // Filter 4: RSI/momentum exhaustion guard (warning only, doesn't block)
    const rsiCheck = this.checkRSIExhaustion(context);
    if (rsiCheck.warnings && rsiCheck.warnings.length > 0) {
      warnings.push(...rsiCheck.warnings);
    }

    return { 
      allowed: true,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Filter 1: Time-of-day cutoff
   * No new plays after 15:30 ET (or 15:45 max)
   * Still allows management + exits after cutoff
   */
  private checkTimeOfDayCutoff(timestamp: number): EntryFilterResult {
    const { hour, minute } = getETClock(new Date(timestamp));

    const currentMinutes = hour * 60 + minute;
    const cutoffMinutes = this.cutoffHour * 60 + this.cutoffMinute;

    if (currentMinutes >= cutoffMinutes) {
      return {
        allowed: false,
        reason: `Time-of-day cutoff: No new plays after ${this.cutoffHour}:${this.cutoffMinute.toString().padStart(2, '0')} ET (current: ${hour}:${minute.toString().padStart(2, '0')} ET)`
      };
    }

    return { allowed: true };
  }

  /**
   * Filter 2: Extended-from-mean (anti-chase)
   * If price is far above VWAP/EMA20/EMA9, require it to be within k * ATR
   */
  private checkExtendedFromMean(context: EntryFilterContext): EntryFilterResult {
    const { close, direction, indicators } = context;
    
    // If no indicators available, allow (graceful degradation)
    if (!indicators || !indicators.atr || indicators.atr <= 0) {
      return { allowed: true };
    }

    const atr = indicators.atr;
    const issues: string[] = [];

    // Check VWAP distance
    if (indicators.vwap !== undefined) {
      const vwapDistance = Math.abs(close - indicators.vwap);
      const maxAllowedDistance = this.maxVwapDistanceATR * atr;
      
      if (vwapDistance > maxAllowedDistance) {
        if (direction === "LONG" && close > indicators.vwap) {
          issues.push(`Price ${vwapDistance.toFixed(2)} above VWAP (max: ${maxAllowedDistance.toFixed(2)} = ${this.maxVwapDistanceATR} * ATR)`);
        } else if (direction === "SHORT" && close < indicators.vwap) {
          issues.push(`Price ${vwapDistance.toFixed(2)} below VWAP (max: ${maxAllowedDistance.toFixed(2)} = ${this.maxVwapDistanceATR} * ATR)`);
        }
      }
    }

    // Check EMA20 distance
    if (indicators.ema20 !== undefined) {
      const ema20Distance = Math.abs(close - indicators.ema20);
      const maxAllowedDistance = this.maxEmaDistanceATR * atr;
      
      if (ema20Distance > maxAllowedDistance) {
        if (direction === "LONG" && close > indicators.ema20) {
          issues.push(`Price ${ema20Distance.toFixed(2)} above EMA20 (max: ${maxAllowedDistance.toFixed(2)} = ${this.maxEmaDistanceATR} * ATR)`);
        } else if (direction === "SHORT" && close < indicators.ema20) {
          issues.push(`Price ${ema20Distance.toFixed(2)} below EMA20 (max: ${maxAllowedDistance.toFixed(2)} = ${this.maxEmaDistanceATR} * ATR)`);
        }
      }
    }

    // Check EMA9 distance (if available)
    if (indicators.ema9 !== undefined) {
      const ema9Distance = Math.abs(close - indicators.ema9);
      const maxAllowedDistance = this.maxEmaDistanceATR * atr;
      
      if (ema9Distance > maxAllowedDistance) {
        if (direction === "LONG" && close > indicators.ema9) {
          issues.push(`Price ${ema9Distance.toFixed(2)} above EMA9 (max: ${maxAllowedDistance.toFixed(2)} = ${this.maxEmaDistanceATR} * ATR)`);
        } else if (direction === "SHORT" && close < indicators.ema9) {
          issues.push(`Price ${ema9Distance.toFixed(2)} below EMA9 (max: ${maxAllowedDistance.toFixed(2)} = ${this.maxEmaDistanceATR} * ATR)`);
        }
      }
    }

    if (issues.length > 0) {
      return {
        allowed: false,
        reason: `Extended-from-mean filter: ${issues.join("; ")}`
      };
    }

    return { allowed: true };
  }

  /**
   * Filter 3: Impulse-then-pullback structure requirement
   * For trend continuation, require:
   * - Pullback of at least 0.5-1.0 ATR off the local high
   * - Reclaim signal (close back above EMA9/EMA20 for LONG, or below for SHORT)
   */
  private checkImpulseThenPullback(context: EntryFilterContext): EntryFilterResult {
    const { close, direction, indicators, recentBars } = context;

    // If no indicators or recent bars, allow (graceful degradation)
    if (!indicators || !indicators.atr || indicators.atr <= 0) {
      return { allowed: true };
    }

    if (!recentBars || recentBars.length < 5) {
      // Need at least 5 bars to detect pullback structure
      return { allowed: true };
    }

    const atr = indicators.atr;

    if (direction === "LONG") {
      // Find local high in recent bars
      const localHigh = Math.max(...recentBars.map(b => b.high));
      const pullbackDepth = localHigh - close;

      // Require pullback of at least 0.5 ATR
      if (pullbackDepth < this.minPullbackATR * atr) {
        return {
          allowed: false,
          reason: `Impulse-then-pullback filter: Pullback depth ${pullbackDepth.toFixed(2)} is less than minimum ${(this.minPullbackATR * atr).toFixed(2)} (${this.minPullbackATR} * ATR). Local high: ${localHigh.toFixed(2)}`
        };
      }

      // Optional: Check for reclaim signal (close above EMA9 or EMA20)
      // If EMA data available, prefer it; otherwise just check pullback depth
      if (indicators.ema9 !== undefined || indicators.ema20 !== undefined) {
        const ema = indicators.ema9 ?? indicators.ema20!;
        if (close <= ema) {
          return {
            allowed: false,
            reason: `Impulse-then-pullback filter: No reclaim signal - close ${close.toFixed(2)} is not above EMA (${ema.toFixed(2)})`
          };
        }
      }
    } else {
      // SHORT direction
      // Find local low in recent bars
      const localLow = Math.min(...recentBars.map(b => b.low));
      const pullbackDepth = close - localLow;

      // Require pullback of at least 0.5 ATR
      if (pullbackDepth < this.minPullbackATR * atr) {
        return {
          allowed: false,
          reason: `Impulse-then-pullback filter: Pullback depth ${pullbackDepth.toFixed(2)} is less than minimum ${(this.minPullbackATR * atr).toFixed(2)} (${this.minPullbackATR} * ATR). Local low: ${localLow.toFixed(2)}`
        };
      }

      // Optional: Check for reclaim signal (close below EMA9 or EMA20)
      if (indicators.ema9 !== undefined || indicators.ema20 !== undefined) {
        const ema = indicators.ema9 ?? indicators.ema20!;
        if (close >= ema) {
          return {
            allowed: false,
            reason: `Impulse-then-pullback filter: No reclaim signal - close ${close.toFixed(2)} is not below EMA (${ema.toFixed(2)})`
          };
        }
      }
    }

    return { allowed: true };
  }

  /**
   * Filter 4: RSI / momentum exhaustion guard
   * Warns LLM (doesn't block) if RSI(14) > 70 and price is above VWAP by > 1 ATR
   * LLM can use this to adjust probability/legitimacy
   */
  private checkRSIExhaustion(context: EntryFilterContext): EntryFilterResult {
    const { close, direction, indicators } = context;

    // Only applies to LONG direction
    if (direction !== "LONG") {
      return { allowed: true };
    }

    // If no indicators available, allow (graceful degradation)
    if (!indicators || !indicators.rsi14 || !indicators.vwap || !indicators.atr || indicators.atr <= 0) {
      return { allowed: true };
    }

    const rsi = indicators.rsi14;
    const vwap = indicators.vwap;
    const atr = indicators.atr;

    // Check if RSI is exhausted - warn but don't block
    if (rsi > this.rsiExhaustionThreshold) {
      const vwapDistance = close - vwap;
      const maxAllowedDistance = this.rsiExhaustionVwapDistanceATR * atr;

      if (vwapDistance > maxAllowedDistance) {
        return {
          allowed: true, // Don't block, just warn
          warnings: [
            `RSI exhaustion warning: RSI(14) = ${rsi.toFixed(1)} > ${this.rsiExhaustionThreshold} and price is ${vwapDistance.toFixed(2)} above VWAP (threshold: ${maxAllowedDistance.toFixed(2)} = ${this.rsiExhaustionVwapDistanceATR} * ATR). Consider reducing probability/legitimacy due to momentum exhaustion risk.`
          ]
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Update cutoff time (if needed to adjust to 15:45)
   */
  setCutoffTime(hour: number, minute: number): void {
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error("Invalid cutoff time");
    }
    if (minute > this.maxCutoffMinute) {
      throw new Error(`Cutoff minute cannot exceed ${this.maxCutoffMinute}`);
    }
    // Note: This would require making cutoffHour and cutoffMinute mutable
    // For now, we'll keep them as constants and document the max
  }
}
