import type { Direction } from "../types.js";
import type { OHLCVBar } from "../utils/indicators.js";
import { computeATR, computeEMA } from "../utils/indicators.js";

export interface DirectionInference {
  direction?: Direction; // undefined means "no edge / unclear"
  confidence: number; // 0-100
  reasons: string[];
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function pctMove(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return 0;
  return (100 * (to - from)) / from;
}

/**
 * Infer market direction from recent 1m bars.
 *
 * Goal: Avoid repeatedly arming LONG plays into clear sell pressure.
 * Strategy: Use slope + candle pressure + EMA alignment; return "unclear" when mixed.
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

  const slope = lastClose - firstClose;
  const slopePct = pctMove(firstClose, lastClose);
  const slopeAtr = atr14 && atr14 > 0 ? slope / atr14 : undefined;

  let red = 0;
  let green = 0;
  let consecutiveDown = 0;
  let maxConsecutiveDown = 0;
  let consecutiveUp = 0;
  let maxConsecutiveUp = 0;

  for (let i = 0; i < window.length; i++) {
    if (closes[i]! < opens[i]!) red++;
    else if (closes[i]! > opens[i]!) green++;

    if (i > 0) {
      const diff = closes[i]! - closes[i - 1]!;
      if (diff < 0) {
        consecutiveDown++;
        consecutiveUp = 0;
      } else if (diff > 0) {
        consecutiveUp++;
        consecutiveDown = 0;
      } else {
        // flat resets neither strongly; treat as neutral reset
        consecutiveUp = 0;
        consecutiveDown = 0;
      }
      maxConsecutiveDown = Math.max(maxConsecutiveDown, consecutiveDown);
      maxConsecutiveUp = Math.max(maxConsecutiveUp, consecutiveUp);
    }
  }

  const redRatio = red / lookback;
  const greenRatio = green / lookback;

  const emaBull =
    ema9 !== undefined && ema20 !== undefined
      ? lastClose >= ema9 && ema9 >= ema20
      : undefined;
  const emaBear =
    ema9 !== undefined && ema20 !== undefined
      ? lastClose <= ema9 && ema9 <= ema20
      : undefined;

  // Momentum strength signals
  const slopeStrength = slopeAtr !== undefined ? Math.min(1, Math.abs(slopeAtr) / 1.2) : clamp01(Math.abs(slopePct) / 0.35);
  const pressureStrength = Math.max(redRatio, greenRatio);
  const streakStrength = Math.max(maxConsecutiveDown, maxConsecutiveUp) / (lookback - 1);

  // Decide direction only when we have consistent evidence.
  const bearishEvidence =
    (slopeAtr !== undefined ? slopeAtr <= -0.6 : slopePct <= -0.15) &&
    redRatio >= 0.65 &&
    (emaBear !== false); // if emaBear is undefined, don't block

  const bullishEvidence =
    (slopeAtr !== undefined ? slopeAtr >= 0.6 : slopePct >= 0.15) &&
    greenRatio >= 0.65 &&
    (emaBull !== false);

  const reasons: string[] = [];
  reasons.push(`lookback=${lookback}`);
  reasons.push(`slope=${slope.toFixed(2)} (${slopePct.toFixed(2)}%)`);
  if (slopeAtr !== undefined) reasons.push(`slopeATR=${slopeAtr.toFixed(2)}`);
  reasons.push(`red=${red}/${lookback} green=${green}/${lookback}`);
  reasons.push(`maxDownStreak=${maxConsecutiveDown} maxUpStreak=${maxConsecutiveUp}`);
  if (ema9 !== undefined) reasons.push(`ema9=${ema9.toFixed(2)}`);
  if (ema20 !== undefined) reasons.push(`ema20=${ema20.toFixed(2)}`);

  let direction: Direction | undefined;
  if (bearishEvidence && !bullishEvidence) direction = "SHORT";
  else if (bullishEvidence && !bearishEvidence) direction = "LONG";
  else direction = undefined;

  // Confidence: combine strength components + EMA alignment bonus
  const base = 0.45 * slopeStrength + 0.35 * pressureStrength + 0.20 * streakStrength;
  const emaBonus =
    direction === "LONG" && emaBull === true ? 0.12 :
    direction === "SHORT" && emaBear === true ? 0.12 :
    0;

  const confidence = direction ? Math.round(100 * Math.min(1, base + emaBonus)) : Math.round(100 * Math.min(0.5, base));

  if (!direction) {
    reasons.unshift("direction unclear (mixed evidence) — skipping new play");
  } else {
    reasons.unshift(`direction=${direction} inferred`);
  }

  return { direction, confidence, reasons };
}

