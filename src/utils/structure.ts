import type { OHLCVBar } from "./indicators.js";

export type StructureType = "BULLISH" | "BEARISH" | "MIXED";

export interface StructureResult {
  structure: StructureType;
  reasons: string[];
  pivots?: {
    highs: Array<{ index: number; price: number }>;
    lows: Array<{ index: number; price: number }>;
  };
}

/**
 * Detect pivot highs and lows using fractal method
 * A pivot high is a bar where high > high of N bars on each side
 * A pivot low is a bar where low < low of N bars on each side
 */
function detectPivots(
  bars: OHLCVBar[],
  pivotWidth: number
): { highs: Array<{ index: number; price: number }>; lows: Array<{ index: number; price: number }> } {
  const highs: Array<{ index: number; price: number }> = [];
  const lows: Array<{ index: number; price: number }> = [];

  for (let i = pivotWidth; i < bars.length - pivotWidth; i++) {
    const bar = bars[i]!;
    let isPivotHigh = true;
    let isPivotLow = true;

    // Check if this is a pivot high
    for (let j = i - pivotWidth; j <= i + pivotWidth; j++) {
      if (j === i) continue;
      const otherBar = bars[j]!;
      if (bar.high <= otherBar.high) {
        isPivotHigh = false;
        break;
      }
    }

    // Check if this is a pivot low
    for (let j = i - pivotWidth; j <= i + pivotWidth; j++) {
      if (j === i) continue;
      const otherBar = bars[j]!;
      if (bar.low >= otherBar.low) {
        isPivotLow = false;
        break;
      }
    }

    if (isPivotHigh) {
      highs.push({ index: i, price: bar.high });
    }
    if (isPivotLow) {
      lows.push({ index: i, price: bar.low });
    }
  }

  return { highs, lows };
}

/**
 * Detect structure using LL+LH (Lower Low + Lower High) for BEARISH
 * and HH+HL (Higher High + Higher Low) for BULLISH
 * 
 * Looks at the last 2 pivot highs and last 2 pivot lows
 */
export function detectStructureLLLH(
  bars: OHLCVBar[],
  opts?: { lookback?: number; pivotWidth?: number }
): StructureResult {
  const lookback = opts?.lookback ?? 22;
  const pivotWidth = opts?.pivotWidth ?? 2;

  if (bars.length < lookback || bars.length < pivotWidth * 2 + 1) {
    return {
      structure: "MIXED",
      reasons: ["insufficient bars for structure detection"],
    };
  }

  const window = bars.slice(-lookback);
  const { highs, lows } = detectPivots(window, pivotWidth);

  if (highs.length < 2 || lows.length < 2) {
    return {
      structure: "MIXED",
      reasons: [`insufficient pivots: ${highs.length} highs, ${lows.length} lows`],
      pivots: { highs, lows },
    };
  }

  // Get last 2 pivot highs and lows
  const h1 = highs[highs.length - 2]!; // Second to last
  const h2 = highs[highs.length - 1]!; // Last
  const l1 = lows[lows.length - 2]!; // Second to last
  const l2 = lows[lows.length - 1]!; // Last

  const isLH = h2.price < h1.price; // Lower High
  const isHH = h2.price > h1.price; // Higher High
  const isLL = l2.price < l1.price; // Lower Low
  const isHL = l2.price > l1.price; // Higher Low

  const reasons: string[] = [];
  reasons.push(`H1=$${h1.price.toFixed(2)} H2=$${h2.price.toFixed(2)} ${isHH ? "HH" : isLH ? "LH" : "="}`);
  reasons.push(`L1=$${l1.price.toFixed(2)} L2=$${l2.price.toFixed(2)} ${isHL ? "HL" : isLL ? "LL" : "="}`);

  // BEARISH: Lower High + Lower Low
  if (isLH && isLL) {
    return {
      structure: "BEARISH",
      reasons: [...reasons, "BEARISH structure: LH + LL"],
      pivots: { highs, lows },
    };
  }

  // BULLISH: Higher High + Higher Low
  if (isHH && isHL) {
    return {
      structure: "BULLISH",
      reasons: [...reasons, "BULLISH structure: HH + HL"],
      pivots: { highs, lows },
    };
  }

  // MIXED: any other combination
  return {
    structure: "MIXED",
    reasons: [...reasons, "MIXED structure: no clear trend"],
    pivots: { highs, lows },
  };
}
