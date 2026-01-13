import type { OHLCVBar } from "./indicators.js";

export type MarketStructure = "BULLISH" | "BEARISH" | "MIXED";

export interface Pivot {
  idx: number; // index in the input window array
  price: number;
  ts: number;
}

function isPivotHigh(bars: OHLCVBar[], i: number, leftRight: number): boolean {
  const c = bars[i];
  if (!c) return false;
  for (let k = 1; k <= leftRight; k++) {
    const l = bars[i - k];
    const r = bars[i + k];
    if (!l || !r) return false;
    if (l.high >= c.high) return false;
    if (r.high >= c.high) return false;
  }
  return true;
}

function isPivotLow(bars: OHLCVBar[], i: number, leftRight: number): boolean {
  const c = bars[i];
  if (!c) return false;
  for (let k = 1; k <= leftRight; k++) {
    const l = bars[i - k];
    const r = bars[i + k];
    if (!l || !r) return false;
    if (l.low <= c.low) return false;
    if (r.low <= c.low) return false;
  }
  return true;
}

export function detectStructureLLLH(
  bars: OHLCVBar[],
  opts?: { lookback?: number; pivotWidth?: number }
): {
  structure: MarketStructure;
  reasons: string[];
  lastTwoHighs?: [Pivot, Pivot];
  lastTwoLows?: [Pivot, Pivot];
} {
  const lookback = Math.max(12, opts?.lookback ?? 20);
  const w = Math.max(2, opts?.pivotWidth ?? 2);
  if (!bars || bars.length < lookback) {
    return { structure: "MIXED", reasons: [`insufficient bars (< ${lookback}) for structure`] };
  }

  const window = bars.slice(bars.length - lookback);
  const highs: Pivot[] = [];
  const lows: Pivot[] = [];

  for (let i = w; i < window.length - w; i++) {
    if (isPivotHigh(window, i, w)) highs.push({ idx: i, price: window[i]!.high, ts: window[i]!.ts });
    if (isPivotLow(window, i, w)) lows.push({ idx: i, price: window[i]!.low, ts: window[i]!.ts });
  }

  const reasons: string[] = [];
  reasons.push(`lookback=${lookback} pivotWidth=${w}`);
  reasons.push(`pivotHighs=${highs.length} pivotLows=${lows.length}`);

  if (highs.length < 2 || lows.length < 2) {
    reasons.push("not enough pivots to classify");
    return { structure: "MIXED", reasons };
  }

  const h1 = highs[highs.length - 2]!;
  const h2 = highs[highs.length - 1]!;
  const l1 = lows[lows.length - 2]!;
  const l2 = lows[lows.length - 1]!;

  const isLH = h2.price < h1.price;
  const isHH = h2.price > h1.price;
  const isLL = l2.price < l1.price;
  const isHL = l2.price > l1.price;

  if (isLH && isLL) {
    reasons.push(`bearish structure: LH (${h2.price.toFixed(2)} < ${h1.price.toFixed(2)}) + LL (${l2.price.toFixed(2)} < ${l1.price.toFixed(2)})`);
    return { structure: "BEARISH", reasons, lastTwoHighs: [h1, h2], lastTwoLows: [l1, l2] };
  }

  if (isHH && isHL) {
    reasons.push(`bullish structure: HH (${h2.price.toFixed(2)} > ${h1.price.toFixed(2)}) + HL (${l2.price.toFixed(2)} > ${l1.price.toFixed(2)})`);
    return { structure: "BULLISH", reasons, lastTwoHighs: [h1, h2], lastTwoLows: [l1, l2] };
  }

  reasons.push("mixed structure (no HH+HL or LH+LL)");
  return { structure: "MIXED", reasons, lastTwoHighs: [h1, h2], lastTwoLows: [l1, l2] };
}

