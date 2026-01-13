import type { Regime } from "../types.js";
import type { OHLCVBar } from "../utils/indicators.js";
import { computeEMA, computeVWAP } from "../utils/indicators.js";
import { detectStructureLLLH } from "../utils/structure.js";

export interface RegimeResult {
  regime: Regime;
  reasons: string[];
  vwap?: number;
  vwapSlope?: "UP" | "DOWN" | "FLAT" | "UNKNOWN";
  structure?: "BULLISH" | "BEARISH" | "MIXED";
}

function vwapSlopeFromHistory(bars: OHLCVBar[], period: number, deltaBars: number): { vwap?: number; slope?: "UP" | "DOWN" | "FLAT" | "UNKNOWN"; reasons: string[] } {
  const reasons: string[] = [];
  const vwapNow = computeVWAP(bars, period);
  if (vwapNow === undefined) {
    reasons.push("vwap unavailable (missing/zero volume)");
    return { vwap: undefined, slope: "UNKNOWN", reasons };
  }

  const idx = Math.max(0, bars.length - deltaBars);
  const older = bars.slice(0, idx);
  const vwapThen = older.length >= period ? computeVWAP(older, period) : undefined;
  if (vwapThen === undefined) {
    reasons.push("vwap slope unavailable (insufficient history)");
    return { vwap: vwapNow, slope: "UNKNOWN", reasons };
  }

  const diff = vwapNow - vwapThen;
  // Small deadband so we don't flip-flop in chop
  const deadband = 0.01;
  const slope = diff > deadband ? "UP" : diff < -deadband ? "DOWN" : "FLAT";
  reasons.push(`vwapNow=${vwapNow.toFixed(2)} vwapThen=${vwapThen.toFixed(2)} diff=${diff.toFixed(2)} slope=${slope}`);
  return { vwap: vwapNow, slope, reasons };
}

/**
 * Regime gate: BULL / BEAR / CHOP with hard veto logic.
 *
 * Minimal high-impact rules:
 * - BEAR if price < VWAP and VWAP slope DOWN and structure is bearish (LL+LH)
 * - BULL if price > VWAP and VWAP slope UP and structure is bullish (HH+HL)
 * - else CHOP
 */
export function computeRegime(bars: OHLCVBar[], currentPrice: number): RegimeResult {
  const reasons: string[] = [];
  if (!bars || bars.length < 25) {
    return { regime: "CHOP", reasons: ["insufficient bars for regime (need ~25+)"] };
  }

  const closes = bars.map((b) => b.close);
  const ema9 = computeEMA(closes.slice(-60), 9);
  const ema20 = computeEMA(closes.slice(-80), 20);
  if (ema9 !== undefined && ema20 !== undefined) {
    reasons.push(`ema9=${ema9.toFixed(2)} ema20=${ema20.toFixed(2)}`);
  }

  const vwapInfo = vwapSlopeFromHistory(bars, 30, 10);
  reasons.push(...vwapInfo.reasons);

  const struct = detectStructureLLLH(bars, { lookback: 22, pivotWidth: 2 });
  reasons.push(...struct.reasons);

  const vwap = vwapInfo.vwap;
  const vwapSlope = vwapInfo.slope;
  const structure = struct.structure;

  const belowVWAP = vwap !== undefined ? currentPrice < vwap : false;
  const aboveVWAP = vwap !== undefined ? currentPrice > vwap : false;

  const bearGate = vwap !== undefined && belowVWAP && vwapSlope === "DOWN" && structure === "BEARISH";
  const bullGate = vwap !== undefined && aboveVWAP && vwapSlope === "UP" && structure === "BULLISH";

  if (bearGate) {
    reasons.unshift("regime=BEAR (price<VWAP + VWAP slope down + LH+LL)");
    return { regime: "BEAR", reasons, vwap, vwapSlope, structure };
  }

  if (bullGate) {
    reasons.unshift("regime=BULL (price>VWAP + VWAP slope up + HH+HL)");
    return { regime: "BULL", reasons, vwap, vwapSlope, structure };
  }

  reasons.unshift("regime=CHOP (no strong bull/bear alignment)");
  return { regime: "CHOP", reasons, vwap, vwapSlope, structure };
}

export function regimeAllowsDirection(regime: Regime, direction: "LONG" | "SHORT"): { allowed: boolean; reason: string } {
  if (regime === "BULL" && direction === "SHORT") {
    return { allowed: false, reason: "blocked: BULL regime disallows SHORT setups" };
  }
  if (regime === "BEAR" && direction === "LONG") {
    return { allowed: false, reason: "blocked: BEAR regime disallows LONG setups" };
  }
  if (regime === "CHOP") {
    return { allowed: false, reason: "blocked: CHOP regime (default WAIT / no new plays)" };
  }
  return { allowed: true, reason: "allowed by regime" };
}

