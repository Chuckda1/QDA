import type { Direction } from "../types.js";
import type { OHLCVBar } from "../utils/indicators.js";
import { computeATR, computeEMA, computeVWAP } from "../utils/indicators.js";

export interface DirectionInference {
  direction: Direction | undefined;
  confidence: number; // 0-100
  reasons: string[];
}

/**
 * Calculate percentage move
 */
function pctMove(from: number, to: number): number {
  if (from === 0) return 0;
  return ((to - from) / from) * 100;
}

/**
 * Infer trading direction from recent 1m bars
 * Returns LONG, SHORT, or undefined (unclear)
 */
export function inferDirectionFromRecentBars(bars: OHLCVBar[]): DirectionInference {
  if (!bars || bars.length < 6) {
    return {
      direction: undefined,
      confidence: 0,
      reasons: ["insufficient bars (< 6) to infer direction"],
    };
  }

  const lookback = Math.min(12, bars.length);
  const window = bars.slice(bars.length - lookback);
  const closes = window.map((b) => b.close);
  const opens = window.map((b) => b.open);

  const lastClose = closes[closes.length - 1]!;
  const firstClose = closes[0]!;

  const atr14 = computeATR(bars, 14);
  const ema9 = computeEMA(bars.slice(-30).map((b) => b.close), 9);
  const ema20 = computeEMA(bars.slice(-60).map((b) => b.close), 20);
  const vwap30 = computeVWAP(bars, 30);

  const slope = lastClose - firstClose;
  const slopePct = pctMove(firstClose, lastClose);
  const slopeAtr = atr14 && atr14 > 0 ? slope / atr14 : undefined;

  // Count bullish vs bearish candles
  let greenCount = 0;
  let redCount = 0;
  for (let i = 0; i < window.length; i++) {
    const bar = window[i]!;
    const barOpen = bar.open ?? bar.close; // Fallback to close if open missing
    if (bar.close > barOpen) {
      greenCount++;
    } else if (bar.close < barOpen) {
      redCount++;
    }
  }
  const greenRatio = window.length > 0 ? greenCount / window.length : 0;
  const redRatio = window.length > 0 ? redCount / window.length : 0;

  // Check for streaks (consecutive same-direction candles)
  let bullishStreak = 0;
  let bearishStreak = 0;
  let maxBullishStreak = 0;
  let maxBearishStreak = 0;

  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1]!;
    const curr = window[i]!;
    
    if (curr.close > prev.close) {
      bullishStreak++;
      bearishStreak = 0;
      maxBullishStreak = Math.max(maxBullishStreak, bullishStreak);
    } else if (curr.close < prev.close) {
      bearishStreak++;
      bullishStreak = 0;
      maxBearishStreak = Math.max(maxBearishStreak, bearishStreak);
    } else {
      bullishStreak = 0;
      bearishStreak = 0;
    }
  }

  // EMA alignment check
  let emaBull: boolean | undefined = undefined;
  let emaBear: boolean | undefined = undefined;
  
  if (ema9 !== undefined && ema20 !== undefined && lastClose !== undefined) {
    // Bullish: price above both EMAs, EMA9 > EMA20
    emaBull = lastClose > ema9 && ema9 > ema20;
    // Bearish: price below both EMAs, EMA9 < EMA20
    emaBear = lastClose < ema9 && ema9 < ema20;
  } else if (ema9 !== undefined && lastClose !== undefined) {
    emaBull = lastClose > ema9;
    emaBear = lastClose < ema9;
  } else if (ema20 !== undefined && lastClose !== undefined) {
    emaBull = lastClose > ema20;
    emaBear = lastClose < ema20;
  }

  // Evidence thresholds
  const bearishEvidence =
    (slopeAtr !== undefined ? slopeAtr <= -0.6 : slopePct <= -0.15) &&
    redRatio >= 0.65 &&
    (emaBear !== false);

  const bullishEvidence =
    (slopeAtr !== undefined ? slopeAtr >= 0.6 : slopePct >= 0.15) &&
    greenRatio >= 0.65 &&
    (emaBull !== false);

  let direction: Direction | undefined;
  if (bearishEvidence && !bullishEvidence) {
    direction = "SHORT";
  } else if (bullishEvidence && !bearishEvidence) {
    direction = "LONG";
  } else {
    direction = undefined;
  }

  // VWAP + EMA alignment veto (fast safety filter)
  const last = window[window.length - 1]!;
  if (direction === "LONG" && vwap30 !== undefined) {
    const emaBearStack = ema9 !== undefined && ema20 !== undefined ? ema9 < ema20 : false;
    if (last.close < vwap30 && emaBearStack) {
      direction = undefined;
    }
  }
  if (direction === "SHORT" && vwap30 !== undefined) {
    const emaBullStack = ema9 !== undefined && ema20 !== undefined ? ema9 > ema20 : false;
    if (last.close > vwap30 && emaBullStack) {
      direction = undefined;
    }
  }

  // Build reasons array
  const reasons: string[] = [];
  
  if (direction === undefined) {
    reasons.push("direction unclear");
    // Check if veto was applied
    if (vwap30 !== undefined && last.close !== undefined) {
      const emaBearStack = ema9 !== undefined && ema20 !== undefined ? ema9 < ema20 : false;
      const emaBullStack = ema9 !== undefined && ema20 !== undefined ? ema9 > ema20 : false;
      if (last.close < vwap30 && emaBearStack) {
        reasons.unshift("veto: price<VWAP and EMA9<EMA20 (bear alignment) — block LONG");
      } else if (last.close > vwap30 && emaBullStack) {
        reasons.unshift("veto: price>VWAP and EMA9>EMA20 (bull alignment) — block SHORT");
      }
    }
    if (slopeAtr !== undefined) {
      reasons.push(`slope=${slopeAtr.toFixed(2)} ATR (need |slope| >= 0.6)`);
    } else {
      reasons.push(`slope=${slopePct.toFixed(2)}% (need |slope| >= 0.15%)`);
    }
    reasons.push(`greenRatio=${(greenRatio * 100).toFixed(0)}% redRatio=${(redRatio * 100).toFixed(0)}% (need >= 65%)`);
    if (emaBull === false && emaBear === false) {
      reasons.push("EMA alignment unclear");
    }
  } else {
    if (slopeAtr !== undefined) {
      reasons.push(`slope=${slopeAtr.toFixed(2)} ATR`);
    } else {
      reasons.push(`slope=${slopePct.toFixed(2)}%`);
    }
    if (direction === "LONG") {
      reasons.push(`greenRatio=${(greenRatio * 100).toFixed(0)}%`);
      if (maxBullishStreak > 0) {
        reasons.push(`bullishStreak=${maxBullishStreak}`);
      }
    } else {
      reasons.push(`redRatio=${(redRatio * 100).toFixed(0)}%`);
      if (maxBearishStreak > 0) {
        reasons.push(`bearishStreak=${maxBearishStreak}`);
      }
    }
    if (emaBull !== undefined || emaBear !== undefined) {
      reasons.push(`EMA alignment: ${direction === "LONG" ? "bullish" : "bearish"}`);
    }
  }

  // Calculate confidence (0-100)
  let confidence = 0;
  if (direction !== undefined) {
    // Base confidence from slope strength
    if (slopeAtr !== undefined) {
      confidence += Math.min(40, Math.abs(slopeAtr) * 20); // Up to 40 points
    } else {
      confidence += Math.min(30, Math.abs(slopePct) * 100); // Up to 30 points
    }
    
    // Candle ratio contribution
    const candleRatio = direction === "LONG" ? greenRatio : redRatio;
    confidence += candleRatio * 30; // Up to 30 points
    
    // Streak contribution
    const streak = direction === "LONG" ? maxBullishStreak : maxBearishStreak;
    confidence += Math.min(20, streak * 3); // Up to 20 points
    
    // EMA alignment contribution
    if ((direction === "LONG" && emaBull) || (direction === "SHORT" && emaBear)) {
      confidence += 10; // 10 points
    }
    
    confidence = Math.min(100, Math.max(0, Math.round(confidence)));
  }

  return { direction, confidence, reasons };
}
