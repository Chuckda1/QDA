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

function oppositeDirection(d: Direction): Direction {
  return d === "LONG" ? "SHORT" : "LONG";
}

function recentSwingLow(bars: OHLCVBar[], lookback: number): number {
  const window = bars.slice(-Math.max(3, lookback));
  return Math.min(...window.map((b) => b.low));
}

function recentSwingHigh(bars: OHLCVBar[], lookback: number): number {
  const window = bars.slice(-Math.max(3, lookback));
  return Math.max(...window.map((b) => b.high));
}

function recentSwingHighExcludingTail(bars: OHLCVBar[], lookback: number, excludeLast: number): number {
  const end = Math.max(0, bars.length - excludeLast);
  const window = bars.slice(Math.max(0, end - lookback), end);
  return window.length ? Math.max(...window.map((b) => b.high)) : recentSwingHigh(bars, lookback);
}

function recentSwingLowExcludingTail(bars: OHLCVBar[], lookback: number, excludeLast: number): number {
  const end = Math.max(0, bars.length - excludeLast);
  const window = bars.slice(Math.max(0, end - lookback), end);
  return window.length ? Math.min(...window.map((b) => b.low)) : recentSwingLow(bars, lookback);
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
 * Patterns implemented:
 * - PULLBACK_CONTINUATION (trend)
 * - BREAK_RETEST (trend)
 * - REVERSAL_ATTEMPT (countertrend, stricter / lower score cap)
 */
export class SetupEngine {
  findSetup(ctx: SetupEngineContext): SetupEngineResult {
    const { ts, symbol, currentPrice, bars, regime, directionInference, indicators } = ctx;
    const baseReasons: string[] = [];

    if (!bars || bars.length < 30) {
      return { reason: "insufficient bars for setup detection (< 30)" };
    }

    const trendDirection = directionInference.direction;
    if (!trendDirection) return { reason: "no direction inference" };
    if (regime.regime === "CHOP") return { reason: "chop regime blocks setups" };

    const atr = indicators.atr ?? computeATR(bars, 14);
    const closes = bars.map((b) => b.close);
    const ema9 = indicators.ema9 ?? computeEMA(closes.slice(-60), 9);
    const ema20 = indicators.ema20 ?? computeEMA(closes.slice(-80), 20);
    const vwap = indicators.vwap ?? computeVWAP(bars, 30);

    if (!atr || atr <= 0) return { reason: "ATR unavailable; cannot size setup" };
    if (ema9 === undefined || ema20 === undefined) return { reason: "EMA unavailable; cannot detect reclaim" };

    baseReasons.push(`regime=${regime.regime} structure=${regime.structure ?? "N/A"}`);
    baseReasons.push(`ema9=${ema9.toFixed(2)} ema20=${ema20.toFixed(2)} atr=${atr.toFixed(2)}`);
    if (vwap !== undefined) baseReasons.push(`vwap=${vwap.toFixed(2)} vwapSlope=${regime.vwapSlope ?? "N/A"}`);

    const candidates: SetupCandidate[] = [];

    const pushCandidate = (candidate: SetupCandidate) => {
      candidates.push(candidate);
    };

    // -------------------------
    // Pattern 1: PULLBACK_CONTINUATION (trend)
    // -------------------------
    {
      const direction = trendDirection;
      // Require regime alignment (hard) for trend patterns
      if (!(regime.regime === "BEAR" && direction === "LONG") && !(regime.regime === "BULL" && direction === "SHORT")) {
        // Require structure alignment (hard)
        if (!(regime.structure === "BEARISH" && direction === "LONG") && !(regime.structure === "BULLISH" && direction === "SHORT")) {
          const hasReclaim = hasReclaimSignal(direction, bars, ema9);
          if (hasReclaim) {
            const pattern: SetupPattern = "PULLBACK_CONTINUATION";
            const reasons = [...baseReasons, `pattern=${pattern}`];

            // VWAP alignment as a setup-quality filter (not hard)
            if (vwap !== undefined) {
              const vwapSideOk = direction === "LONG" ? currentPrice >= vwap : currentPrice <= vwap;
              if (!vwapSideOk) reasons.push("warning: price on wrong side of VWAP for direction");
            }

            const last = bars[bars.length - 1]!;
            const triggerPrice = last.close;

            const swingLookback = 10;
            const buffer = 0.10 * atr;
            const stop = direction === "LONG"
              ? recentSwingLow(bars, swingLookback) - buffer
              : recentSwingHigh(bars, swingLookback) + buffer;

            const risk = Math.abs(triggerPrice - stop);
            if (risk > 0) {
              const entryLow = direction === "LONG" ? triggerPrice - 0.20 * risk : triggerPrice - 0.05 * risk;
              const entryHigh = direction === "LONG" ? triggerPrice + 0.05 * risk : triggerPrice + 0.20 * risk;
              const entryZone = { low: Math.min(entryLow, entryHigh), high: Math.max(entryLow, entryHigh) };
              const entryMid = (entryZone.low + entryZone.high) / 2;
              const targets = makeTargetsFromR(direction, entryMid, stop);

              const alignment = clamp(0.6 * (directionInference.confidence ?? 50) + 0.4 * 80, 0, 100);
              const structureScore = clamp(regime.structure === "BULLISH" || regime.structure === "BEARISH" ? 80 : 55, 0, 100);
              const quality = clamp(
                70
                  + (vwap !== undefined ? (direction === "LONG" ? (currentPrice >= vwap ? 5 : -5) : (currentPrice <= vwap ? 5 : -5)) : 0)
                  + (Math.abs(entryMid - ema20) <= 1.0 * atr ? 5 : -5),
                0,
                100
              );
              const total = Math.round(0.45 * alignment + 0.25 * structureScore + 0.30 * quality);

              pushCandidate({
                id: `setup_${ts}_pullback`,
                ts,
                symbol,
                direction,
                pattern,
                triggerPrice,
                entryZone,
                stop,
                targets,
                rationale: reasons,
                score: { alignment: Math.round(alignment), structure: Math.round(structureScore), quality: Math.round(quality), total }
              });
            }
          }
        }
      }
    }

    // -------------------------
    // Pattern 2: BREAK_RETEST (trend)
    // -------------------------
    {
      const direction = trendDirection;
      // Require regime + structure alignment (hard) for trend patterns
      if (!(regime.regime === "BEAR" && direction === "LONG") && !(regime.regime === "BULL" && direction === "SHORT")) {
        if (!(regime.structure === "BEARISH" && direction === "LONG") && !(regime.structure === "BULLISH" && direction === "SHORT")) {
          const pattern: SetupPattern = "BREAK_RETEST";
          const reasons = [...baseReasons, `pattern=${pattern}`];

          const breakoutLookback = 20;
          const excludeLast = 3;
          const level = direction === "LONG"
            ? recentSwingHighExcludingTail(bars, breakoutLookback, excludeLast)
            : recentSwingLowExcludingTail(bars, breakoutLookback, excludeLast);

          const breakBuffer = 0.10 * atr;
          const retestTol = 0.20 * atr;
          const window = bars.slice(-12);
          const last = bars[bars.length - 1]!;

          let broke = false;
          let retested = false;
          let retestExtreme = direction === "LONG" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;

          for (let i = 0; i < window.length; i++) {
            const b = window[i]!;
            if (direction === "LONG") {
              if (!broke && b.close > level + breakBuffer) broke = true;
              if (broke && !retested && b.low <= level + retestTol) {
                retested = true;
                retestExtreme = Math.min(retestExtreme, b.low);
              }
            } else {
              if (!broke && b.close < level - breakBuffer) broke = true;
              if (broke && !retested && b.high >= level - retestTol) {
                retested = true;
                retestExtreme = Math.max(retestExtreme, b.high);
              }
            }
          }

          const reclaimed = direction === "LONG" ? last.close > level : last.close < level;
          if (broke && retested && reclaimed) {
            reasons.push(`breakLevel=${level.toFixed(2)} broke=${broke} retested=${retested} reclaimed=${reclaimed}`);

            const triggerPrice = last.close;
            const stop = direction === "LONG"
              ? (Number.isFinite(retestExtreme) ? retestExtreme : recentSwingLow(bars, 8)) - 0.10 * atr
              : (Number.isFinite(retestExtreme) ? retestExtreme : recentSwingHigh(bars, 8)) + 0.10 * atr;

            const risk = Math.abs(triggerPrice - stop);
            if (risk > 0) {
              const entryZone = direction === "LONG"
                ? { low: level, high: level + 0.25 * risk }
                : { low: level - 0.25 * risk, high: level };

              const entryMid = (entryZone.low + entryZone.high) / 2;
              const targets = makeTargetsFromR(direction, entryMid, stop);

              const alignment = clamp(0.7 * (directionInference.confidence ?? 50) + 0.3 * 85, 0, 100);
              const structureScore = clamp(regime.structure === "BULLISH" || regime.structure === "BEARISH" ? 85 : 60, 0, 100);
              const quality = clamp(
                75
                  + (vwap !== undefined ? (direction === "LONG" ? (currentPrice >= vwap ? 5 : -8) : (currentPrice <= vwap ? 5 : -8)) : 0)
                  + (Math.abs(entryMid - ema20) <= 1.2 * atr ? 5 : -5),
                0,
                100
              );
              const total = Math.round(0.45 * alignment + 0.25 * structureScore + 0.30 * quality);

              pushCandidate({
                id: `setup_${ts}_breakretest`,
                ts,
                symbol,
                direction,
                pattern,
                triggerPrice,
                entryZone,
                stop,
                targets,
                rationale: reasons,
                score: { alignment: Math.round(alignment), structure: Math.round(structureScore), quality: Math.round(quality), total }
              });
            }
          }
        }
      }
    }

    // -------------------------
    // Pattern 3: REVERSAL_ATTEMPT (countertrend)
    // -------------------------
    {
      const pattern: SetupPattern = "REVERSAL_ATTEMPT";
      const reasons = [...baseReasons, `pattern=${pattern}`, "countertrend=true"];

      const rsi = indicators.rsi14;
      const last = bars[bars.length - 1]!;
      const prev1 = bars[bars.length - 2]!;
      const prev2 = bars[bars.length - 3]!;

      // In BEAR regime, look for oversold bounce attempt (LONG)
      // In BULL regime, look for overbought fade attempt (SHORT)
      const direction = regime.regime === "BEAR" ? "LONG" as Direction : "SHORT" as Direction;
      const needRsi = regime.regime === "BEAR" ? 35 : 65;

      const momentumTurn = regime.regime === "BEAR"
        ? (prev2.close <= prev1.close && prev1.close <= last.close) // 2-step higher closes
        : (prev2.close >= prev1.close && prev1.close >= last.close); // 2-step lower closes

      const reclaimEma9 = direction === "LONG" ? last.close > ema9 : last.close < ema9;

      const rsiOk = rsi !== undefined ? (regime.regime === "BEAR" ? rsi <= needRsi : rsi >= needRsi) : false;

      if (momentumTurn && reclaimEma9 && rsiOk) {
        reasons.push(`rsi14=${rsi!.toFixed(1)} turn=${momentumTurn} reclaimEma9=${reclaimEma9}`);

        const triggerPrice = last.close;
        const swingLookback = 12;
        const buffer = 0.10 * atr;
        const stop = direction === "LONG"
          ? recentSwingLow(bars, swingLookback) - buffer
          : recentSwingHigh(bars, swingLookback) + buffer;

        const risk = Math.abs(triggerPrice - stop);
        if (risk > 0) {
          const entryLow = direction === "LONG" ? triggerPrice - 0.15 * risk : triggerPrice - 0.05 * risk;
          const entryHigh = direction === "LONG" ? triggerPrice + 0.05 * risk : triggerPrice + 0.15 * risk;
          const entryZone = { low: Math.min(entryLow, entryHigh), high: Math.max(entryLow, entryHigh) };
          const entryMid = (entryZone.low + entryZone.high) / 2;
          const targets = makeTargetsFromR(direction, entryMid, stop);

          // Cap scores lower because countertrend is inherently riskier
          const alignment = clamp(45, 0, 100);
          const structureScore = clamp(45, 0, 100);
          const quality = clamp(60, 0, 100);
          const total = Math.min(65, Math.round(0.45 * alignment + 0.25 * structureScore + 0.30 * quality));

          pushCandidate({
            id: `setup_${ts}_reversal`,
            ts,
            symbol,
            direction,
            pattern,
            triggerPrice,
            entryZone,
            stop,
            targets,
            rationale: reasons,
            score: { alignment: Math.round(alignment), structure: Math.round(structureScore), quality: Math.round(quality), total }
          });
        }
      }
    }

    if (candidates.length === 0) {
      return { reason: "no qualifying setup patterns found" };
    }

    // Pick best candidate by deterministic score
    candidates.sort((a, b) => b.score.total - a.score.total);
    return { candidate: candidates[0] };
  }
}

