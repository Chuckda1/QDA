import type { OHLCVBar } from "../utils/indicators.js";

export type TimingState =
  | "WAITING"
  | "IMPULSE_DETECTED"
  | "PULLBACK_IN_PROGRESS"
  | "ENTRY_WINDOW_OPEN"
  | "ENTERED"
  | "INVALIDATED";

export interface TimingSignal {
  state: TimingState;
  score: number; // 0-100
  reasons: string[];
  components: {
    breakAcceptance: number;
    retestQuality: number;
    vwapReaction: number;
    atrNormalization: number;
  };
}

function barRange(bar: OHLCVBar): number {
  const high = bar.high ?? bar.close;
  const low = bar.low ?? bar.close;
  return Math.max(0, high - low);
}

export function computeTimingSignal(params: {
  bars: OHLCVBar[];
  direction: "LONG" | "SHORT";
  entryZone?: { low: number; high: number };
  vwap?: number;
  atr?: number;
}): TimingSignal {
  const { bars, direction, entryZone, vwap, atr } = params;
  if (!bars || bars.length < 6) {
    return {
      state: "WAITING",
      score: 0,
      reasons: ["insufficient bars for timing"],
      components: { breakAcceptance: 0, retestQuality: 0, vwapReaction: 0, atrNormalization: 0 }
    };
  }

  const last = bars[bars.length - 1]!;
  const prev = bars[bars.length - 2]!;
  const prev2 = bars[bars.length - 3]!;
  const lastRange = barRange(last);
  const prevRange = barRange(prev);
  const shock1 = atr ? lastRange >= 0.6 * atr : false;
  const shock2 = atr ? (lastRange + prevRange) >= 0.9 * atr : false;
  const impulseDetected = shock1 || shock2;

  const level = entryZone
    ? direction === "LONG"
      ? entryZone.high
      : entryZone.low
    : vwap;
  const levelName = entryZone ? "zone" : "VWAP";

  let breakAcceptance = 0;
  if (level !== undefined) {
    const breakHit = direction === "LONG" ? last.close > level : last.close < level;
    const acceptHit = direction === "LONG" ? prev.close > level : prev.close < level;
    if (breakHit && acceptHit) {
      breakAcceptance = 25;
    } else if (breakHit) {
      breakAcceptance = 12;
    }
  }

  let retestQuality = 0;
  if (level !== undefined) {
    const touched = direction === "LONG"
      ? [prev2, prev, last].some((b) => (b.low ?? b.close) <= level)
      : [prev2, prev, last].some((b) => (b.high ?? b.close) >= level);
    const rejected = direction === "LONG" ? last.close > level : last.close < level;
    if (touched && rejected) {
      retestQuality = 25;
    }
  }

  let vwapReaction = 0;
  if (vwap !== undefined) {
    const vwapBreak = direction === "LONG" ? last.close > vwap : last.close < vwap;
    const vwapAccept = direction === "LONG" ? prev.close > vwap : prev.close < vwap;
    if (vwapBreak && vwapAccept) vwapReaction = 25;
    else if (vwapBreak) vwapReaction = 12;
  }

  let atrNormalization = 0;
  const ranges = bars.slice(-6).map(barRange);
  if (ranges.length >= 6) {
    const prevAvg = (ranges[0]! + ranges[1]! + ranges[2]!) / 3;
    const lastAvg = (ranges[3]! + ranges[4]! + ranges[5]!) / 3;
    if (lastAvg < prevAvg * 0.9) atrNormalization = 25;
    else if (lastAvg <= prevAvg * 1.1) atrNormalization = 12;
  }

  const score = Math.min(
    100,
    breakAcceptance + retestQuality + vwapReaction + atrNormalization
  );

  let state: TimingState = "WAITING";
  const inZone =
    entryZone !== undefined &&
    last.close >= entryZone.low &&
    last.close <= entryZone.high;
  if (inZone) state = "ENTRY_WINDOW_OPEN";
  else if (impulseDetected) state = "IMPULSE_DETECTED";
  else if (breakAcceptance > 0 || retestQuality > 0) state = "PULLBACK_IN_PROGRESS";

  const reasons: string[] = [];
  if (breakAcceptance > 0) reasons.push(`break+accept (${levelName})`);
  if (retestQuality > 0) reasons.push(`retest (${levelName})`);
  if (vwapReaction > 0) reasons.push("vwap reaction");
  if (atrNormalization > 0) reasons.push("atr normalization");
  if (impulseDetected) reasons.push("impulse detected");
  if (!reasons.length) reasons.push("timing not ready");

  return {
    state,
    score,
    reasons,
    components: { breakAcceptance, retestQuality, vwapReaction, atrNormalization }
  };
}
