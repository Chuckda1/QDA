import type { Regime } from "../types.js";
import type { OHLCVBar } from "../utils/indicators.js";
import { computeVWAP } from "../utils/indicators.js";
import { detectStructureLLLH } from "../utils/structure.js";

export interface RegimeResult {
  regime: Regime;
  reasons: string[];
  vwap?: number;
  vwapSlope?: "UP" | "DOWN" | "FLAT";
  structure?: "BULLISH" | "BEARISH" | "MIXED";
}

export interface VWAPSlopeResult {
  vwap: number | undefined;
  slope: "UP" | "DOWN" | "FLAT";
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
      reasons: ["insufficient bars for VWAP slope"],
    };
  }

  const currentVWAP = computeVWAP(bars, vwapPeriod);
  if (currentVWAP === undefined) {
    return {
      vwap: undefined,
      slope: "FLAT",
      reasons: ["VWAP computation failed"],
    };
  }

  // Compute VWAP from lookbackBars ago
  const lookbackWindow = bars.slice(0, bars.length - lookbackBars);
  if (lookbackWindow.length < vwapPeriod) {
    return {
      vwap: currentVWAP,
      slope: "FLAT",
      reasons: ["insufficient history for VWAP comparison"],
    };
  }

  const pastVWAP = computeVWAP(lookbackWindow, vwapPeriod);
  if (pastVWAP === undefined) {
    return {
      vwap: currentVWAP,
      slope: "FLAT",
      reasons: ["past VWAP computation failed"],
    };
  }

  const diff = currentVWAP - pastVWAP;
  const diffPct = pastVWAP !== 0 ? (diff / pastVWAP) * 100 : 0;

  // Threshold: 0.1% change to consider slope meaningful
  const threshold = 0.1;
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
    reasons: [
      `VWAP: $${currentVWAP.toFixed(2)} (was $${pastVWAP.toFixed(2)} ${lookbackBars} bars ago)`,
      `slope=${diffPct.toFixed(2)}% → ${slope}`,
    ],
  };
}

/**
 * Compute market regime: BULL, BEAR, or CHOP
 * 
 * BEAR iff: price < VWAP AND VWAP slope = DOWN AND structure = BEARISH (LH+LL)
 * BULL iff: price > VWAP AND VWAP slope = UP AND structure = BULLISH (HH+HL)
 * else CHOP
 */
export function computeRegime(bars: OHLCVBar[], currentPrice: number): RegimeResult {
  if (bars.length < 30) {
    return {
      regime: "CHOP",
      reasons: ["insufficient bars for regime detection"],
    };
  }

  const vwapInfo = vwapSlopeFromHistory(bars, 30, 10);
  const struct = detectStructureLLLH(bars, { lookback: 22, pivotWidth: 2 });

  const vwap = vwapInfo.vwap;
  const vwapSlope = vwapInfo.slope;
  const structure = struct.structure;

  const reasons: string[] = [];
  reasons.push(...vwapInfo.reasons);
  reasons.push(...struct.reasons);

  const belowVWAP = vwap !== undefined ? currentPrice < vwap : false;
  const aboveVWAP = vwap !== undefined ? currentPrice > vwap : false;

  // BEAR gate: price < VWAP AND VWAP slope DOWN AND structure BEARISH
  const bearGate = vwap !== undefined && belowVWAP && vwapSlope === "DOWN" && structure === "BEARISH";

  // BULL gate: price > VWAP AND VWAP slope UP AND structure BULLISH
  const bullGate = vwap !== undefined && aboveVWAP && vwapSlope === "UP" && structure === "BULLISH";

  if (bearGate) {
    return {
      regime: "BEAR",
      reasons: [...reasons, "BEAR regime: price<VWAP + VWAP slope DOWN + BEARISH structure"],
      vwap,
      vwapSlope,
      structure,
    };
  }

  if (bullGate) {
    return {
      regime: "BULL",
      reasons: [...reasons, "BULL regime: price>VWAP + VWAP slope UP + BULLISH structure"],
      vwap,
      vwapSlope,
      structure,
    };
  }

  // Default to CHOP
  return {
    regime: "CHOP",
    reasons: [...reasons, "CHOP regime: conditions not met for BULL or BEAR"],
    vwap,
    vwapSlope,
    structure,
  };
}

/**
 * Check if regime allows a given direction
 * Hard veto: BEAR blocks LONG, BULL blocks SHORT, CHOP blocks everything
 */
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
