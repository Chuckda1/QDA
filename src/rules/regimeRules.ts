import type { Bias, Regime } from "../types.js";
import type { OHLCVBar } from "../utils/indicators.js";
import { computeATR, computeVWAP } from "../utils/indicators.js";
import { detectStructureLLLH } from "../utils/structure.js";

export interface RegimeResult {
  regime: Regime;
  reasons: string[];
  vwap?: number;
  vwapSlope?: "UP" | "DOWN" | "FLAT";
  vwapSlopePct?: number;
  structure?: "BULLISH" | "BEARISH" | "MIXED";
  bullScore?: number;
  bearScore?: number;
  atr?: number;
  atrSlope?: number;
  transitionFlags?: string[];
}

export const MIN_REGIME_BARS = 30;

export interface VWAPSlopeResult {
  vwap: number | undefined;
  slope: "UP" | "DOWN" | "FLAT";
  slopePct: number;
  reasons: string[];
}

/**
 * Compute VWAP slope from recent history
 * Compares current VWAP to VWAP N bars ago
 */
export function vwapSlopeFromHistory(
  bars: OHLCVBar[],
  vwapPeriod: number,
  lookbackBars: number
): VWAPSlopeResult {
  if (bars.length < vwapPeriod + lookbackBars) {
    return {
      vwap: undefined,
      slope: "FLAT",
      slopePct: 0,
      reasons: ["insufficient bars for VWAP slope"],
    };
  }

  const currentVWAP = computeVWAP(bars, vwapPeriod);
  if (currentVWAP === undefined) {
    return {
      vwap: undefined,
      slope: "FLAT",
      slopePct: 0,
      reasons: ["VWAP computation failed"],
    };
  }

  // Compute VWAP from lookbackBars ago
  const lookbackWindow = bars.slice(0, bars.length - lookbackBars);
  if (lookbackWindow.length < vwapPeriod) {
    return {
      vwap: currentVWAP,
      slope: "FLAT",
      slopePct: 0,
      reasons: ["insufficient history for VWAP comparison"],
    };
  }

  const pastVWAP = computeVWAP(lookbackWindow, vwapPeriod);
  if (pastVWAP === undefined) {
    return {
      vwap: currentVWAP,
      slope: "FLAT",
      slopePct: 0,
      reasons: ["past VWAP computation failed"],
    };
  }

  const diff = currentVWAP - pastVWAP;
  const diffPct = pastVWAP !== 0 ? (diff / pastVWAP) * 100 : 0;

  // Threshold: 0.02% change to consider slope meaningful.
  // On SPY intraday, 0.1% over ~10 minutes is ~0.70 points and is far too strict,
  // causing almost everything to classify as FLAT → CHOP. 0.02% (~0.14 points at 700)
  // is still conservative but allows regimes to register during real moves.
  const threshold = 0.02;
  let slope: "UP" | "DOWN" | "FLAT";
  if (diffPct > threshold) {
    slope = "UP";
  } else if (diffPct < -threshold) {
    slope = "DOWN";
  } else {
    slope = "FLAT";
  }

  return {
    vwap: currentVWAP,
    slope,
    slopePct: diffPct,
    reasons: [
      `VWAP: $${currentVWAP.toFixed(2)} (was $${pastVWAP.toFixed(2)} ${lookbackBars} bars ago)`,
      `slope=${diffPct.toFixed(2)}% → ${slope}`,
    ],
  };
}

function atrSlopeFromHistory(
  bars: OHLCVBar[],
  atrPeriod: number,
  lookbackBars: number
): { atr?: number; atrSlope?: number; reasons: string[] } {
  if (bars.length < atrPeriod + lookbackBars + 1) {
    return {
      atr: undefined,
      atrSlope: undefined,
      reasons: ["insufficient bars for ATR slope"],
    };
  }

  const atrNow = computeATR(bars, atrPeriod);
  const lookbackWindow = bars.slice(0, bars.length - lookbackBars);
  const atrPast = computeATR(lookbackWindow, atrPeriod);

  if (!atrNow || !atrPast || atrPast <= 0) {
    return {
      atr: atrNow,
      atrSlope: undefined,
      reasons: ["ATR computation failed for slope"],
    };
  }

  const atrSlope = (atrNow - atrPast) / atrPast;
  return {
    atr: atrNow,
    atrSlope,
    reasons: [`ATR=${atrNow.toFixed(2)} (was ${atrPast.toFixed(2)} ${lookbackBars} bars ago) slope=${(atrSlope * 100).toFixed(1)}%`],
  };
}

function detectImpulseFlip(
  bars: OHLCVBar[],
  atr: number,
  lookbackBars: number,
  impulseAtr: number
): { impulseFlip: boolean; reasons: string[] } {
  if (bars.length < lookbackBars + 2 || atr <= 0) {
    return { impulseFlip: false, reasons: ["insufficient bars for impulse flip"] };
  }

  const window = bars.slice(-lookbackBars);
  let firstSign: 1 | -1 | 0 = 0;
  let flipFound = false;

  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1]!;
    const curr = window[i]!;
    const delta = curr.close - prev.close;
    if (Math.abs(delta) < impulseAtr * atr) continue;

    const sign = delta > 0 ? 1 : -1;
    if (firstSign === 0) {
      firstSign = sign;
    } else if (sign !== firstSign) {
      flipFound = true;
      break;
    }
  }

  return {
    impulseFlip: flipFound,
    reasons: [
      `impulseFlip=${flipFound} (need ≥${impulseAtr.toFixed(2)} ATR move in opposite directions within ${lookbackBars} bars)`,
    ],
  };
}

/**
 * Compute market regime: TREND_UP, TREND_DOWN, CHOP, or TRANSITION
 * 
 * TREND_DOWN iff: price < VWAP AND VWAP slope = DOWN AND structure = BEARISH (LH+LL)
 * TREND_UP iff: price > VWAP AND VWAP slope = UP AND structure = BULLISH (HH+HL)
 * TRANSITION iff: ATR slope rising AND (impulse + counter-impulse within N bars OR structure=MIXED with mildly directional VWAP slope)
 * else CHOP
 */
export function computeRegime(bars: OHLCVBar[], currentPrice: number): RegimeResult {
  if (bars.length < MIN_REGIME_BARS) {
    return {
      regime: "UNKNOWN",
      reasons: [`insufficient bars for regime detection (< ${MIN_REGIME_BARS})`],
    };
  }

  const vwapInfo = vwapSlopeFromHistory(bars, 30, 10);
  const atrInfo = atrSlopeFromHistory(bars, 14, 10);
  const struct = detectStructureLLLH(bars, { lookback: 22, pivotWidth: 2 });

  const vwap = vwapInfo.vwap;
  const vwapSlope = vwapInfo.slope;
  const vwapSlopePct = vwapInfo.slopePct;
  const structure = struct.structure;

  const reasons: string[] = [];
  reasons.push(...vwapInfo.reasons);
  reasons.push(...atrInfo.reasons);
  reasons.push(...struct.reasons);

  const atr = atrInfo.atr;
  const atrSlope = atrInfo.atrSlope;
  const transitionFlags: string[] = [];

  const impulseCheck = atr ? detectImpulseFlip(bars, atr, 3, 0.8) : { impulseFlip: false, reasons: ["ATR unavailable for impulse flip"] };
  reasons.push(...impulseCheck.reasons);

  const atrSlopeRising = atrSlope !== undefined && atrSlope >= 0.08;
  const mildDirectional =
    vwapSlopePct !== undefined && Math.abs(vwapSlopePct) >= 0.02 && Math.abs(vwapSlopePct) <= 0.08;
  const transitionGate =
    atrSlopeRising &&
    (impulseCheck.impulseFlip || (structure === "MIXED" && mildDirectional));

  if (atrSlopeRising) transitionFlags.push("atrSlopeRising");
  if (impulseCheck.impulseFlip) transitionFlags.push("impulseFlip");
  if (structure === "MIXED" && mildDirectional) transitionFlags.push("mixedStructure_mildVwapSlope");

  // Regime should not be so strict that it collapses into CHOP during real intraday trends.
  // We score 3 independent evidences and require 2-of-3 to classify BULL/BEAR.
  //
  // Evidence:
  // 1) price relative to VWAP (if VWAP exists)
  // 2) VWAP slope direction
  // 3) structure (HH+HL or LH+LL)
  let bullScore = 0;
  let bearScore = 0;

  if (vwap !== undefined) {
    if (currentPrice > vwap) bullScore += 1;
    else if (currentPrice < vwap) bearScore += 1;
  }

  if (vwapSlope === "UP") bullScore += 1;
  else if (vwapSlope === "DOWN") bearScore += 1;

  if (structure === "BULLISH") bullScore += 1;
  else if (structure === "BEARISH") bearScore += 1;

  reasons.push(`regimeEvidence: bullScore=${bullScore}/3 bearScore=${bearScore}/3`);

  const bullGate = bullScore >= 2 && bullScore > bearScore;
  const bearGate = bearScore >= 2 && bearScore > bullScore;

  if (transitionGate) {
    return {
      regime: "TRANSITION",
      reasons: [...reasons, `TRANSITION regime: ${transitionFlags.join("+") || "volatility expansion"}`],
      vwap,
      vwapSlope,
      vwapSlopePct,
      structure,
      bullScore,
      bearScore,
      atr,
      atrSlope,
      transitionFlags,
    };
  }

  if (bearGate) {
    const strength = bearScore === 3 ? "strong" : "weak";
    return {
      regime: "TREND_DOWN",
      reasons: [...reasons, `TREND_DOWN regime (${strength}): 2-of-3+ bear evidences`],
      vwap,
      vwapSlope,
      vwapSlopePct,
      structure,
      bullScore,
      bearScore,
      atr,
      atrSlope,
    };
  }

  if (bullGate) {
    const strength = bullScore === 3 ? "strong" : "weak";
    return {
      regime: "TREND_UP",
      reasons: [...reasons, `TREND_UP regime (${strength}): 2-of-3+ bull evidences`],
      vwap,
      vwapSlope,
      vwapSlopePct,
      structure,
      bullScore,
      bearScore,
      atr,
      atrSlope,
    };
  }

  // Default to CHOP
  return {
    regime: "CHOP",
    reasons: [...reasons, "CHOP regime: no 2-of-3 consensus for TREND_UP/TREND_DOWN"],
    vwap,
    vwapSlope,
    vwapSlopePct,
    structure,
    bullScore,
    bearScore,
    atr,
    atrSlope,
  };
}

/**
 * Check if regime allows a given direction
 * Hard veto: BEAR blocks LONG, BULL blocks SHORT, CHOP blocks everything
 */
export function regimeAllowsDirection(regime: Regime, direction: "LONG" | "SHORT"): { allowed: boolean; reason: string } {
  if (regime === "UNKNOWN") {
    return { allowed: true, reason: "allowed: UNKNOWN regime (insufficient data)" };
  }
  if (regime === "TREND_UP" && direction === "SHORT") {
    return { allowed: false, reason: "blocked: TREND_UP regime disallows SHORT setups" };
  }
  if (regime === "TREND_DOWN" && direction === "LONG") {
    return { allowed: false, reason: "blocked: TREND_DOWN regime disallows LONG setups" };
  }
  if (regime === "CHOP") {
    return { allowed: false, reason: "blocked: CHOP regime (default WAIT / no new plays)" };
  }
  if (regime === "TRANSITION") {
    return { allowed: true, reason: "allowed by transition regime (bias gate applies separately)" };
  }
  return { allowed: true, reason: "allowed by regime" };
}

export function computeMacroBias(bars: OHLCVBar[], currentPrice: number): { bias: Bias; reasons: string[] } {
  if (bars.length < MIN_REGIME_BARS) {
    return { bias: "UNKNOWN", reasons: [`insufficient bars for macro bias detection (< ${MIN_REGIME_BARS})`] };
  }
  const vwapInfo = vwapSlopeFromHistory(bars, 30, 10);
  const struct = detectStructureLLLH(bars, { lookback: 22, pivotWidth: 2 });

  const vwap = vwapInfo.vwap;
  const vwapSlope = vwapInfo.slope;
  const structure = struct.structure;

  let bullScore = 0;
  let bearScore = 0;

  if (vwap !== undefined) {
    if (currentPrice > vwap) bullScore += 1;
    else if (currentPrice < vwap) bearScore += 1;
  }
  if (vwapSlope === "UP") bullScore += 1;
  else if (vwapSlope === "DOWN") bearScore += 1;
  if (structure === "BULLISH") bullScore += 1;
  else if (structure === "BEARISH") bearScore += 1;

  const reasons = [
    ...vwapInfo.reasons,
    ...struct.reasons,
    `biasEvidence: bullScore=${bullScore}/3 bearScore=${bearScore}/3`,
  ];

  if (bullScore >= 2 && bullScore > bearScore) {
    return { bias: "LONG", reasons };
  }
  if (bearScore >= 2 && bearScore > bullScore) {
    return { bias: "SHORT", reasons };
  }
  return { bias: "NEUTRAL", reasons };
}
