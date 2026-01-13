import type { Direction, Regime, SetupCandidate, SetupPattern } from "../types.js";
import type { OHLCVBar } from "../utils/indicators.js";
import { computeATR, computeEMA, computeVWAP } from "../utils/indicators.js";
import type { RegimeResult } from "./regimeRules.js";
import type { DirectionInference } from "./directionRules.js";

export interface SetupEngineContext {
  ts: number;
  symbol: string;
  currentPrice: number;
  bars: OHLCVBar[];
  regime: RegimeResult;
  directionInference: DirectionInference;
  indicators: {
    vwap?: number;
    ema9?: number;
    ema20?: number;
    atr?: number;
    rsi14?: number;
  };
}

export interface SetupEngineResult {
  candidate?: SetupCandidate;
  reason?: string;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function gradeFromScore(score: number): string {
  if (score >= 80) return "A";
  if (score >= 70) return "B";
  if (score >= 60) return "C";
  if (score >= 50) return "D";
  return "F";
}

function makeTargetsFromR(direction: Direction, entry: number, stop: number): { t1: number; t2: number; t3: number } {
  const risk = Math.abs(entry - stop);
  const r1 = risk * 1.0;
  const r2 = risk * 2.0;
  const r3 = risk * 3.0;
  if (direction === "LONG") {
    return { t1: entry + r1, t2: entry + r2, t3: entry + r3 };
  }
  return { t1: entry - r1, t2: entry - r2, t3: entry - r3 };
}

function recentSwingLow(bars: OHLCVBar[], lookback: number): number {
  const window = bars.slice(-Math.max(3, lookback));
  return Math.min(...window.map((b) => b.low));
}

function recentSwingHigh(bars: OHLCVBar[], lookback: number): number {
  const window = bars.slice(-Math.max(3, lookback));
  return Math.max(...window.map((b) => b.high));
}

function hasReclaimSignal(direction: Direction, bars: OHLCVBar[], ema9?: number): boolean {
  // Simple reclaim definition:
  // LONG: recently dipped below EMA9 and last close is back above EMA9 with green candle.
  // SHORT: recently popped above EMA9 and last close back below EMA9 with red candle.
  if (ema9 === undefined) return false;
  const window = bars.slice(-8);
  if (window.length < 4) return false;
  const last = window[window.length - 1]!;
  const prev = window[window.length - 2]!;

  const lastOpen = last.open ?? last.close;
  const prevOpen = prev.open ?? prev.close;

  if (direction === "LONG") {
    const dipped = window.some((b) => b.close < ema9);
    const reclaimed = last.close > ema9 && last.close > lastOpen;
    const improving = last.close > prev.close || (prev.close < prevOpen && last.close > lastOpen);
    return dipped && reclaimed && improving;
  } else {
    const popped = window.some((b) => b.close > ema9);
    const reclaimed = last.close < ema9 && last.close < lastOpen;
    const improving = last.close < prev.close || (prev.close > prevOpen && last.close < lastOpen);
    return popped && reclaimed && improving;
  }
}

/**
 * SetupEngine (rules): emits a setup only when a pattern exists.
 *
 * This replaces the old "template setup" approach.
 * For now we implement one concrete pattern deterministically:
 * - PULLBACK_CONTINUATION aligned with regime + structure, using EMA9 reclaim.
 */
export class SetupEngine {
  findSetup(ctx: SetupEngineContext): SetupEngineResult {
    const { ts, symbol, currentPrice, bars, regime, directionInference, indicators } = ctx;
    const reasons: string[] = [];

    if (!bars || bars.length < 30) {
      return { reason: "insufficient bars for setup detection (< 30)" };
    }

    const direction = directionInference.direction;
    if (!direction) return { reason: "no direction inference" };

    // Require regime alignment (hard)
    if (regime.regime === "BEAR" && direction === "LONG") return { reason: "bear regime blocks long setup" };
    if (regime.regime === "BULL" && direction === "SHORT") return { reason: "bull regime blocks short setup" };
    if (regime.regime === "CHOP") return { reason: "chop regime blocks setups" };

    // Require structure alignment
    if (regime.structure === "BEARISH" && direction === "LONG") return { reason: "bearish structure blocks long setup" };
    if (regime.structure === "BULLISH" && direction === "SHORT") return { reason: "bullish structure blocks short setup" };

    const atr = indicators.atr ?? computeATR(bars, 14);
    const closes = bars.map((b) => b.close);
    const ema9 = indicators.ema9 ?? computeEMA(closes.slice(-60), 9);
    const ema20 = indicators.ema20 ?? computeEMA(closes.slice(-80), 20);
    const vwap = indicators.vwap ?? computeVWAP(bars, 30);

    if (!atr || atr <= 0) return { reason: "ATR unavailable; cannot size setup" };
    if (ema9 === undefined || ema20 === undefined) return { reason: "EMA unavailable; cannot detect reclaim" };

    // VWAP alignment as a setup-quality filter (not hard)
    if (vwap !== undefined) {
      const vwapSideOk = direction === "LONG" ? currentPrice >= vwap : currentPrice <= vwap;
      if (!vwapSideOk) reasons.push("warning: price on wrong side of VWAP for direction");
    }

    // Pattern: Pullback continuation with EMA9 reclaim
    const hasReclaim = hasReclaimSignal(direction, bars, ema9);
    if (!hasReclaim) return { reason: "no reclaim signal (EMA9) for pullback continuation" };

    const pattern: SetupPattern = "PULLBACK_CONTINUATION";
    reasons.push(`pattern=${pattern}`);
    reasons.push(`regime=${regime.regime} structure=${regime.structure ?? "N/A"}`);
    reasons.push(`ema9=${ema9.toFixed(2)} ema20=${ema20.toFixed(2)} atr=${atr.toFixed(2)}`);
    if (vwap !== undefined) reasons.push(`vwap=${vwap.toFixed(2)} vwapSlope=${regime.vwapSlope ?? "N/A"}`);

    // Levels: trigger at reclaim close (last close)
    const last = bars[bars.length - 1]!;
    const triggerPrice = last.close;

    // Entry zone around trigger: small buffer based on risk fraction
    // Use stop from recent swing + small ATR buffer
    const swingLookback = 10;
    const buffer = 0.10 * atr;

    const stop = direction === "LONG"
      ? recentSwingLow(bars, swingLookback) - buffer
      : recentSwingHigh(bars, swingLookback) + buffer;

    const risk = Math.abs(triggerPrice - stop);
    if (risk <= 0) return { reason: "invalid risk (trigger == stop)" };

    // Entry zone: favor entering near trigger with a small pullback allowance
    const entryLow = direction === "LONG" ? triggerPrice - 0.20 * risk : triggerPrice - 0.05 * risk;
    const entryHigh = direction === "LONG" ? triggerPrice + 0.05 * risk : triggerPrice + 0.20 * risk;

    const entryZone = { low: Math.min(entryLow, entryHigh), high: Math.max(entryLow, entryHigh) };
    const entryMid = (entryZone.low + entryZone.high) / 2;
    const targets = makeTargetsFromR(direction, entryMid, stop);

    // Deterministic scoring (simple weighted model)
    const alignment = clamp(
      0.6 * (directionInference.confidence ?? 50) + 0.4 * (regime.regime === "BULL" || regime.regime === "BEAR" ? 80 : 50),
      0,
      100
    );
    const structureScore = clamp(regime.structure === "BULLISH" || regime.structure === "BEARISH" ? 80 : 55, 0, 100);
    const quality = clamp(
      70
        + (vwap !== undefined ? (direction === "LONG" ? (currentPrice >= vwap ? 5 : -5) : (currentPrice <= vwap ? 5 : -5)) : 0)
        + (Math.abs(entryMid - ema20) <= 1.0 * atr ? 5 : -5),
      0,
      100
    );
    const total = Math.round(0.45 * alignment + 0.25 * structureScore + 0.30 * quality);

    const candidate: SetupCandidate = {
      id: `setup_${ts}`,
      ts,
      symbol,
      direction,
      pattern,
      triggerPrice,
      entryZone,
      stop,
      targets,
      rationale: reasons,
      score: {
        alignment: Math.round(alignment),
        structure: Math.round(structureScore),
        quality: Math.round(quality),
        total
      }
    };

    return { candidate };
  }
}

