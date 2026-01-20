import type { Direction } from "../types.js";
import type { OHLCVBar } from "../utils/indicators.js";
import { computeATR, computeEMA, computeVWAP } from "../utils/indicators.js";

export interface DirectionInference {
  direction: Direction | undefined;
  confidence: number; // 0-100
  reasons: string[];
}

export interface TacticalBias {
  bias: Direction | "NONE";
  tier: "CLEAR" | "LEAN" | "NONE";
  score: number;
  confidence: number; // 0-100
  reasons: string[];
  shock: boolean;
  shockReason?: string;
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
  //
  // Base logic is intentionally strict to avoid "direction" in chop, but
  // real intraday moves often present with strong slope while candle-ratio
  // is only ~55-60% due to wicks/mean-reversion bars. When slope is strong
  // AND VWAP/EMA alignment agrees, we relax the candle-ratio requirement.
  const baseCandleRatio = 0.65;
  const strongSlopeAtr = 1.2;
  const strongSlopePct = 0.30;
  const strongCandleRatio = 0.55;

  const vwapAlignedBear = vwap30 !== undefined ? lastClose < vwap30 : true;
  const vwapAlignedBull = vwap30 !== undefined ? lastClose > vwap30 : true;

  const isStrongBearMove =
    slopeAtr !== undefined ? slopeAtr <= -strongSlopeAtr : slopePct <= -strongSlopePct;
  const isStrongBullMove =
    slopeAtr !== undefined ? slopeAtr >= strongSlopeAtr : slopePct >= strongSlopePct;

  const requiredBearRatio = isStrongBearMove && vwapAlignedBear && emaBear ? strongCandleRatio : baseCandleRatio;
  const requiredBullRatio = isStrongBullMove && vwapAlignedBull && emaBull ? strongCandleRatio : baseCandleRatio;

  const bearishEvidence =
    (slopeAtr !== undefined ? slopeAtr <= -0.6 : slopePct <= -0.15) &&
    redRatio >= requiredBearRatio &&
    (emaBear !== false) &&
    vwapAlignedBear;

  const bullishEvidence =
    (slopeAtr !== undefined ? slopeAtr >= 0.6 : slopePct >= 0.15) &&
    greenRatio >= requiredBullRatio &&
    (emaBull !== false) &&
    vwapAlignedBull;

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
    const strongDown = slopeAtr !== undefined ? slopeAtr <= -0.8 : slopePct <= -0.30;
    const downMomentumOk = strongDown && redRatio >= strongCandleRatio;
    if (last.close > vwap30 && emaBullStack && !downMomentumOk) {
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
    const needPct = Math.round(baseCandleRatio * 100);
    reasons.push(`greenRatio=${(greenRatio * 100).toFixed(0)}% redRatio=${(redRatio * 100).toFixed(0)}% (need >= ${needPct}%)`);
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

/**
 * Infer fast tactical bias from recent bars (short lookback).
 * Intended for CHOP/TRANSITION permission gating.
 */
export function inferTacticalBiasFromRecentBars(
  bars: OHLCVBar[],
  opts?: { lookback?: number }
): TacticalBias {
  if (!bars || bars.length < 6) {
    return {
      bias: "NONE",
      tier: "NONE",
      score: 0,
      confidence: 0,
      reasons: ["insufficient bars (< 6) for tactical bias"],
      shock: false,
    };
  }

  const lookback = Math.min(opts?.lookback ?? 5, bars.length);
  const window = bars.slice(bars.length - lookback);
  const closes = window.map((b) => b.close);
  const last = window[window.length - 1]!;
  const first = window[0]!;

  const atr14 = computeATR(bars, 14);
  const ema9 = computeEMA(bars.slice(-30).map((b) => b.close), 9);
  const ema20 = computeEMA(bars.slice(-60).map((b) => b.close), 20);
  const vwap30 = computeVWAP(bars, 30);

  const slope = last.close - first.close;
  const slopeAtr = atr14 && atr14 > 0 ? slope / atr14 : undefined;

  // Shock detection: 1-bar or 2-bar range expansion
  const lastRange = (last.high ?? last.close) - (last.low ?? last.close);
  const prev = window.length >= 2 ? window[window.length - 2] : undefined;
  const prevRange = prev ? (prev.high ?? prev.close) - (prev.low ?? prev.close) : 0;
  const shock1 = atr14 ? lastRange >= 0.6 * atr14 : false;
  const shock2 = atr14 ? (lastRange + prevRange) >= 0.9 * atr14 : false;
  const shock = shock1 || shock2;
  const shockBias = last.close >= (last.open ?? last.close) ? "LONG" : "SHORT";

  let score = 0;
  const reasons: string[] = [];

  if (vwap30 !== undefined) {
    if (last.close > vwap30) {
      score += 1;
      reasons.push("price>VWAP");
    } else if (last.close < vwap30) {
      score -= 1;
      reasons.push("price<VWAP");
    }
  }

  if (ema9 !== undefined && ema20 !== undefined) {
    if (ema9 > ema20) {
      score += 1;
      reasons.push("EMA9>EMA20");
    } else if (ema9 < ema20) {
      score -= 1;
      reasons.push("EMA9<EMA20");
    }
  }

  // Candle ratio (directional)
  let greenCount = 0;
  let redCount = 0;
  for (const bar of window) {
    const barOpen = bar.open ?? bar.close;
    if (bar.close > barOpen) greenCount += 1;
    else if (bar.close < barOpen) redCount += 1;
  }
  const greenRatio = window.length > 0 ? greenCount / window.length : 0;
  const redRatio = window.length > 0 ? redCount / window.length : 0;

  const alignedUp = (vwap30 !== undefined ? last.close > vwap30 : true) && (ema9 !== undefined && ema20 !== undefined ? ema9 > ema20 : true);
  const alignedDown = (vwap30 !== undefined ? last.close < vwap30 : true) && (ema9 !== undefined && ema20 !== undefined ? ema9 < ema20 : true);

  const baseCandleRatio = 0.58;
  const relaxedCandleRatio = 0.52;

  if (alignedUp && slopeAtr !== undefined && slopeAtr >= 0.5 && greenRatio >= relaxedCandleRatio) {
    score += 1;
    reasons.push(`greenRatio=${(greenRatio * 100).toFixed(0)}%`);
  } else if (alignedDown && slopeAtr !== undefined && slopeAtr <= -0.5 && redRatio >= relaxedCandleRatio) {
    score -= 1;
    reasons.push(`redRatio=${(redRatio * 100).toFixed(0)}%`);
  } else if (greenRatio >= baseCandleRatio) {
    score += 1;
    reasons.push(`greenRatio=${(greenRatio * 100).toFixed(0)}%`);
  } else if (redRatio >= baseCandleRatio) {
    score -= 1;
    reasons.push(`redRatio=${(redRatio * 100).toFixed(0)}%`);
  }

  if (slopeAtr !== undefined) {
    if (slopeAtr <= -0.8 && redRatio >= relaxedCandleRatio) {
      score -= 2;
      reasons.push(`downMomentum=${slopeAtr.toFixed(2)} ATR`);
    } else if (slopeAtr >= 0.8 && greenRatio >= relaxedCandleRatio) {
      score += 2;
      reasons.push(`upMomentum=${slopeAtr.toFixed(2)} ATR`);
    }
  }

  if (slopeAtr !== undefined) {
    if (slopeAtr >= 0.5) {
      score += 1;
      reasons.push(`slope=${slopeAtr.toFixed(2)} ATR up`);
    } else if (slopeAtr <= -0.5) {
      score -= 1;
      reasons.push(`slope=${slopeAtr.toFixed(2)} ATR down`);
    }
  }

  let bias: Direction | "NONE" = "NONE";
  let tier: "CLEAR" | "LEAN" | "NONE" = "NONE";
  if (score >= 3) {
    bias = "LONG";
    tier = "CLEAR";
  } else if (score === 2) {
    bias = "LONG";
    tier = "LEAN";
  } else if (score <= -3) {
    bias = "SHORT";
    tier = "CLEAR";
  } else if (score === -2) {
    bias = "SHORT";
    tier = "LEAN";
  }

  let confidence = Math.min(100, Math.round((Math.abs(score) / 4) * 100));
  let shockReason: string | undefined;
  if (shock) {
    confidence = Math.min(100, Math.max(confidence, 80));
    shockReason = atr14 ? `range=${lastRange.toFixed(2)}; 2-bar=${(lastRange + prevRange).toFixed(2)}` : "range expansion";
    bias = shockBias;
    tier = "CLEAR";
  }

  if (bias === "NONE") {
    reasons.push("tactical bias unclear");
  }

  return {
    bias,
    tier,
    score: Math.abs(score),
    confidence,
    reasons,
    shock,
    shockReason
  };
}
