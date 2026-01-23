import type { Bias, Direction, SetupCandidate, SetupPattern } from "../types.js";
import type { OHLCVBar } from "../utils/indicators.js";
import { computeATR, computeEMA, computeRSI, computeSessionVWAP, computeVWAP } from "../utils/indicators.js";
import type { RegimeResult } from "./regimeRules.js";
import type { StructureResult } from "../utils/structure.js";
import type { DirectionInference, TacticalBias } from "./directionRules.js";

export interface SetupEngineContext {
  ts: number;
  symbol: string;
  currentPrice: number;
  bars: OHLCVBar[];
  volumeBars?: OHLCVBar[];
  regime: RegimeResult;
  macroBias?: Bias;
  directionInference: DirectionInference;
  tacticalBias?: Pick<TacticalBias, "bias" | "tier">;
  indicators: {
    tf?: "1m" | "5m";
    atr?: number;
    ema9?: number;
    ema20?: number;
    vwap?: number;
    rsi14?: number;
  };
}

export interface SetupEngineResult {
  candidate?: SetupCandidate;
  candidates?: SetupCandidate[];
  reason?: string;
  debug?: {
    breakRetest?: Array<{
      direction: Direction;
      level: number;
      broke: boolean;
      retested: boolean;
      reclaimed: boolean;
    }>;
  };
}

/**
 * Helper: Clamp value between min and max
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Helper: Make targets from R-multiples
 */
function makeTargetsFromR(direction: Direction, entryMid: number, stop: number): { t1: number; t2: number; t3: number } {
  const risk = Math.abs(entryMid - stop);
  return direction === "LONG"
    ? {
        t1: entryMid + risk * 1,
        t2: entryMid + risk * 2,
        t3: entryMid + risk * 3
      }
    : {
        t1: entryMid - risk * 1,
        t2: entryMid - risk * 2,
        t3: entryMid - risk * 3
      };
}

/**
 * Helper: Find recent swing high excluding last N bars
 */
function recentSwingHighExcludingTail(bars: OHLCVBar[], lookback: number, excludeLast: number): number {
  const window = bars.slice(-lookback, -excludeLast);
  return Math.max(...window.map(b => b.high));
}

/**
 * Helper: Find recent swing low excluding last N bars
 */
function recentSwingLowExcludingTail(bars: OHLCVBar[], lookback: number, excludeLast: number): number {
  const window = bars.slice(-lookback, -excludeLast);
  return Math.min(...window.map(b => b.low));
}

/**
 * Helper: Find recent swing high
 */
function recentSwingHigh(bars: OHLCVBar[], lookback: number): number {
  const window = bars.slice(-lookback);
  return Math.max(...window.map(b => b.high));
}

/**
 * Helper: Find recent swing low
 */
function recentSwingLow(bars: OHLCVBar[], lookback: number): number {
  const window = bars.slice(-lookback);
  return Math.min(...window.map(b => b.low));
}

function computeVolSma(bars: OHLCVBar[], lookback: number): number | undefined {
  if (bars.length < lookback) return undefined;
  const window = bars.slice(-lookback);
  const avg = window.reduce((sum, b) => sum + (b.volume ?? 0), 0) / window.length;
  return avg > 0 ? avg : undefined;
}

function computeRelVolume(bars: OHLCVBar[], lookback: number): number | undefined {
  if (bars.length < lookback) return undefined;
  const avg = computeVolSma(bars, lookback);
  const last = bars[bars.length - 1]!;
  if (!avg || avg <= 0) return undefined;
  return (last.volume ?? 0) / avg;
}

function computeVolTrend(bars: OHLCVBar[], lookback: number, shiftBars: number): number | undefined {
  if (bars.length < lookback + shiftBars) return undefined;
  const current = computeVolSma(bars, lookback);
  const past = computeVolSma(bars.slice(0, -shiftBars), lookback);
  if (!current || !past || past <= 0) return undefined;
  return (current - past) / past;
}

function computeImpulseVolRatio(bars: OHLCVBar[]): number | undefined {
  if (bars.length < 8) return undefined;
  const tail = bars.slice(-8);
  const impulse = tail.slice(0, 4);
  const pullback = tail.slice(4);
  const impulseAvg = impulse.reduce((sum, b) => sum + (b.volume ?? 0), 0) / impulse.length;
  const pullbackAvg = pullback.reduce((sum, b) => sum + (b.volume ?? 0), 0) / pullback.length;
  if (pullbackAvg <= 0) return undefined;
  return impulseAvg / pullbackAvg;
}

function computeEmaSlopeAtr(closes: number[], period: number, lookbackBars: number, atr?: number): number | undefined {
  if (!atr || atr <= 0 || closes.length < period + lookbackBars) return undefined;
  const now = computeEMA(closes, period);
  const past = computeEMA(closes.slice(0, Math.max(0, closes.length - lookbackBars)), period);
  if (now === undefined || past === undefined) return undefined;
  return (now - past) / atr;
}

function computeVwapSlopeAtr(bars: OHLCVBar[], vwapPeriod: number, lookbackBars: number, atr?: number): number | undefined {
  if (!atr || atr <= 0 || bars.length < vwapPeriod + lookbackBars) return undefined;
  const now = computeVWAP(bars, vwapPeriod);
  const pastWindow = bars.slice(0, bars.length - lookbackBars);
  const past = computeVWAP(pastWindow, vwapPeriod);
  if (now === undefined || past === undefined) return undefined;
  return (now - past) / atr;
}

/**
 * SetupEngine: Deterministic pattern detection for trading setups
 * 
 * Implements three patterns:
 * 1. FOLLOW: Trend continuation after pullback or break-retest
 * 2. RECLAIM: VWAP/value reclaim or reject
 * 3. FADE: Mean reversion / exhaustion
 */
export class SetupEngine {
  /**
   * Find a setup candidate from the current market context
   * Returns best-scoring candidate if patterns exist, otherwise returns reason for rejection
   */
  findSetup(ctx: SetupEngineContext): SetupEngineResult {
    const { ts, symbol, currentPrice, bars, regime, directionInference, indicators } = ctx;
    const baseReasons: string[] = [];

    if (!bars || bars.length < 30) {
      const early = this.buildEarlyCandidates(ctx, "insufficient bars for setup detection (< 30)");
      return { candidate: early[0], candidates: early, reason: "insufficient bars for setup detection (< 30)" };
    }

    const atr = indicators.atr ?? computeATR(bars, 14);
    const closes = bars.map((b) => b.close);
    const ema9 = indicators.ema9 ?? computeEMA(closes.slice(-60), 9);
    const ema20 = indicators.ema20 ?? computeEMA(closes.slice(-80), 20);
    const vwap = indicators.vwap ?? computeSessionVWAP(bars);

    if (!atr || atr <= 0) {
      const early = this.buildEarlyCandidates(ctx, "ATR unavailable; cannot size setup");
      return { candidate: early[0], candidates: early, reason: "ATR unavailable; cannot size setup" };
    }
    if (ema9 === undefined || ema20 === undefined) {
      const early = this.buildEarlyCandidates(ctx, "EMA unavailable; cannot detect reclaim");
      return { candidate: early[0], candidates: early, reason: "EMA unavailable; cannot detect reclaim" };
    }

    const chaseRisk = vwap !== undefined ? Math.abs(currentPrice - vwap) > 0.8 * atr : false;
    const volumeBars = ctx.volumeBars ?? bars;
    const volSma20 = computeVolSma(volumeBars, 20);
    const volNow = volumeBars.length ? (volumeBars[volumeBars.length - 1]!.volume ?? 0) : undefined;
    const relVolume = computeRelVolume(volumeBars, 20);
    const impulseVolVsPullbackVol = computeImpulseVolRatio(volumeBars);
    const volTrend = computeVolTrend(volumeBars, 20, 5);
    const dollarVol = volNow !== undefined ? volNow * currentPrice : undefined;
    const vwapSlopeAtr = computeVwapSlopeAtr(bars, 30, 6, atr);
    const ema9SlopeAtr = computeEmaSlopeAtr(closes, 9, 6, atr);
    const ema20SlopeAtr = computeEmaSlopeAtr(closes, 20, 6, atr);
    const priceVsVwapAtr = vwap !== undefined ? (currentPrice - vwap) / atr : undefined;
    const priceVsEma20Atr = ema20 !== undefined ? (currentPrice - ema20) / atr : undefined;
    const inValueZone = vwap !== undefined ? Math.abs(currentPrice - vwap) <= 0.5 * atr : undefined;
    const extendedFromMean = priceVsVwapAtr !== undefined ? Math.abs(priceVsVwapAtr) : undefined;
    const emaAlignment: "BULL" | "BEAR" | "NEUTRAL" =
      ema9 > ema20 && currentPrice > ema20 ? "BULL" : ema9 < ema20 && currentPrice < ema20 ? "BEAR" : "NEUTRAL";
    const recentHigh = recentSwingHigh(bars, 12);
    const recentLow = recentSwingLow(bars, 12);
    const impulseAtr = (recentHigh - recentLow) / atr;

    // CHOP default is to block new setups, but allow a "momentum + alignment" override.
    // This is intended to catch range breakdowns / repeated rejections (e.g., tap 693 and fail,
    // then break lower) that often classify as CHOP by the stricter regime gate.
    let chopOverride = false;
    let chopOverrideDirection: Direction | undefined = undefined;
    if (regime.regime === "CHOP") {
      const lookback = Math.min(12, closes.length);
      const first = closes[closes.length - lookback]!;
      const last = closes[closes.length - 1]!;
      const slopeAtr = (last - first) / atr;

      const bullAligned =
        Math.abs(slopeAtr) >= 1.2 &&
        slopeAtr > 0 &&
        (vwap !== undefined ? currentPrice > vwap : true) &&
        (currentPrice > ema9 && ema9 > ema20);

      const bearAligned =
        Math.abs(slopeAtr) >= 1.2 &&
        slopeAtr < 0 &&
        (vwap !== undefined ? currentPrice < vwap : true) &&
        (currentPrice < ema9 && ema9 < ema20);

      if (!bullAligned && !bearAligned) {
        baseReasons.push(`chopNoOverride slope=${slopeAtr.toFixed(2)} ATR bullAligned=${bullAligned} bearAligned=${bearAligned}`);
      } else {
        chopOverride = true;
        chopOverrideDirection = bullAligned ? "LONG" : "SHORT";
        baseReasons.push(`chopOverride=true dir=${chopOverrideDirection} slope=${slopeAtr.toFixed(2)} ATR`);
      }

    }

    baseReasons.push(`regime=${regime.regime} structure=${regime.structure ?? "N/A"}`);
    if (ctx.macroBias) {
      baseReasons.push(`macroBias=${ctx.macroBias}`);
    }
    baseReasons.push(`ema9=${ema9.toFixed(2)} ema20=${ema20.toFixed(2)} atr=${atr.toFixed(2)} tf=${indicators.tf ?? "unknown"}`);
    if (vwap !== undefined) baseReasons.push(`vwap=${vwap.toFixed(2)} vwapSlope=${regime.vwapSlope ?? "N/A"}`);
    baseReasons.push(
      `dirInf=${directionInference.direction ?? "N/A"} conf=${directionInference.confidence ?? 0} (${(directionInference.reasons ?? []).join(" | ")})`
    );

    const candidates: SetupCandidate[] = [];
    const enrichCandidate = (candidate: SetupCandidate): SetupCandidate => {
      candidate.intentBucket = candidate.intentBucket ?? candidate.pattern;
      candidate.stage = candidate.stage ?? "READY";
      candidate.qualityTag = candidate.qualityTag ?? "OK";
      const entryMid = (candidate.entryZone.low + candidate.entryZone.high) / 2;
      const riskAtr = Math.abs(entryMid - candidate.stop) / atr;
      const pullbackDepthAtr =
        candidate.direction === "LONG" ? (recentHigh - currentPrice) / atr : (currentPrice - recentLow) / atr;
      const reclaimSignal =
        candidate.direction === "LONG"
          ? currentPrice > ema9 && (vwap === undefined || currentPrice > vwap)
            ? "BOTH"
            : currentPrice > ema9
            ? "EMA_RECLAIM"
            : vwap !== undefined && currentPrice > vwap
            ? "VWAP_RECLAIM"
            : "NONE"
          : currentPrice < ema9 && (vwap === undefined || currentPrice < vwap)
          ? "BOTH"
          : currentPrice < ema9
          ? "EMA_RECLAIM"
          : vwap !== undefined && currentPrice < vwap
          ? "VWAP_RECLAIM"
          : "NONE";

      candidate.scoreComponents = {
        structure: candidate.score.structure,
        momentum: directionInference.confidence,
        location: candidate.score.alignment,
        volatility: clamp(impulseAtr * 25, 0, 25),
        pattern: candidate.score.quality,
        risk: clamp(25 - riskAtr * 10, 0, 25),
      };
      candidate.featureBundle = {
        location: {
          priceVsVWAP: priceVsVwapAtr !== undefined ? { atR: Number(priceVsVwapAtr.toFixed(2)) } : undefined,
          priceVsEMA20: priceVsEma20Atr !== undefined ? { atR: Number(priceVsEma20Atr.toFixed(2)) } : undefined,
          inValueZone,
          extendedFromMean:
            extendedFromMean !== undefined
              ? { atR: Number(extendedFromMean.toFixed(2)), extended: extendedFromMean >= 1 }
              : undefined,
        },
        trend: {
          structure: regime.structure,
          vwapSlopeAtr,
          ema9SlopeAtr,
          ema20SlopeAtr,
          emaAlignment,
        },
        timing: {
          impulseAtr: Number(impulseAtr.toFixed(2)),
          pullbackDepthAtr: Number(pullbackDepthAtr.toFixed(2)),
          reclaimSignal,
          barsSinceImpulse: bars.length >= 6 ? 6 : bars.length,
          barsInPullback: bars.length >= 3 ? 3 : bars.length,
        },
        volatility: {
          atr: Number(atr.toFixed(2)),
          atrSlope: regime.atrSlope,
          regime15m: regime.regime,
          regime5mProvisional: regime.regime,
          confidence: directionInference.confidence,
          tacticalBias: ctx.tacticalBias?.bias ?? "NONE",
        },
        volume: {
          volNow: volNow !== undefined ? Number(volNow.toFixed(0)) : undefined,
          volSma20: volSma20 !== undefined ? Number(volSma20.toFixed(0)) : undefined,
          relVolume: relVolume !== undefined ? Number(relVolume.toFixed(2)) : undefined,
          impulseVolVsPullbackVol: impulseVolVsPullbackVol !== undefined ? Number(impulseVolVsPullbackVol.toFixed(2)) : undefined,
          volTrend: volTrend !== undefined ? Number(volTrend.toFixed(2)) : undefined,
          dollarVol: dollarVol !== undefined ? Number(dollarVol.toFixed(0)) : undefined,
        },
      };
      const flags = new Set(candidate.flags ?? []);
      if (extendedFromMean !== undefined && extendedFromMean >= 1) flags.add("EXTENDED");
      if (reclaimSignal === "NONE") flags.add("WEAK_RECLAIM");
      if (relVolume !== undefined && relVolume < 0.7) {
        flags.add("THIN_TAPE");
      }
      if (relVolume !== undefined && relVolume >= 1.5) flags.add("VOL_SPIKE");
      if (relVolume !== undefined && relVolume >= 2.5) flags.add("CLIMAX_VOL");
      if (candidate.featureBundle.timing?.barsSinceImpulse && candidate.featureBundle.timing.barsSinceImpulse > 6) {
        flags.add("LATE_ENTRY");
      }
      if (regime.regime === "CHOP" || regime.regime === "TRANSITION") flags.add("CHOP_RISK");
      if (ctx.macroBias && candidate.direction !== ctx.macroBias && ctx.macroBias !== "NEUTRAL") flags.add("COUNTER_MACRO");
      if (!ctx.directionInference.direction) flags.add("LOW_CONFIDENCE");
      candidate.flags = Array.from(flags);
      candidate.warningFlags = candidate.warningFlags ?? candidate.flags;
      return candidate;
    };
    const pushCandidate = (candidate: SetupCandidate) => {
      const enriched = enrichCandidate(candidate);
      // Add CHOP_OVERRIDE flag if applicable
      if (chopOverride) {
        enriched.flags = [...(enriched.flags ?? []), "CHOP_OVERRIDE"];
      }
      if (chaseRisk) {
        enriched.flags = [...(enriched.flags ?? []), "CHASE_RISK"];
      }
      enriched.warningFlags = enriched.warningFlags ?? enriched.flags;
      candidates.push(enriched);
    };

    // Try FOLLOW pattern (trend continuation)
    const pullbackResult = this.findPullbackContinuation({
      ts,
      symbol,
      currentPrice,
      bars,
      regime,
      directionInference,
      indicators: { atr, ema9, ema20, vwap }
    });
    if (pullbackResult.candidate) {
      pushCandidate(pullbackResult.candidate);
    }

    // Try RECLAIM pattern (high-expectancy value reclaim)
    const valueReclaimResult = this.findValueReclaim({
      ts,
      symbol,
      currentPrice,
      bars,
      regime,
      macroBias: ctx.macroBias,
      directionInference,
      tacticalBias: ctx.tacticalBias,
      indicators: { atr, ema9, ema20, vwap }
    });
    if (valueReclaimResult.candidate) {
      pushCandidate(valueReclaimResult.candidate);
    }

    // -------------------------
    // Pattern 2: FOLLOW (break-retest)
    // -------------------------
    for (const direction of ["LONG", "SHORT"] as const) {
      // Require regime OR structure alignment for trend patterns.
      // In CHOP/TRANSITION, allow for candidate visibility.
      const regimeAligned =
        (regime.regime === "TREND_UP" && direction === "LONG") ||
        (regime.regime === "TREND_DOWN" && direction === "SHORT");
      const structureAligned = (regime.structure === "BULLISH" && direction === "LONG") || (regime.structure === "BEARISH" && direction === "SHORT");
      const chopAligned = chopOverride && chopOverrideDirection === direction;
      const neutralAligned = regime.regime === "CHOP" || regime.regime === "TRANSITION";


      const pattern: SetupPattern = "FOLLOW";
      const reasons = [
        ...baseReasons,
        `pattern=${pattern}`,
        `aligned: regimeAligned=${regimeAligned} structureAligned=${structureAligned} chopAligned=${chopAligned} neutralAligned=${neutralAligned}`,
      ];

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
      if (!(broke && retested && reclaimed)) continue;

      reasons.push(`breakLevel=${level.toFixed(2)} broke=${broke} retested=${retested} reclaimed=${reclaimed}`);

      const triggerPrice = last.close;
      const stop = direction === "LONG"
        ? (Number.isFinite(retestExtreme) ? retestExtreme : recentSwingLow(bars, 8)) - 0.10 * atr
        : (Number.isFinite(retestExtreme) ? retestExtreme : recentSwingHigh(bars, 8)) + 0.10 * atr;

      const risk = Math.abs(triggerPrice - stop);
      if (risk <= 0) continue;

      const entryZone = direction === "LONG"
        ? { low: level, high: level + 0.25 * risk }
        : { low: level - 0.25 * risk, high: level };

      const entryMid = (entryZone.low + entryZone.high) / 2;
      const targets = makeTargetsFromR(direction, entryMid, stop);

      const alignment = clamp(0.7 * (directionInference.confidence ?? 50) + 0.3 * 85, 0, 100);
      const structureScore = clamp(regime.structure === "BULLISH" || regime.structure === "BEARISH" ? 85 : 60, 0, 100);
      const chasePenalty = chaseRisk ? -12 : 0;
      const quality = clamp(
        75
          + (vwap !== undefined ? (direction === "LONG" ? (currentPrice >= vwap ? 5 : -8) : (currentPrice <= vwap ? 5 : -8)) : 0)
          + (Math.abs(entryMid - ema20) <= 1.2 * atr ? 5 : -5)
          + chasePenalty,
        0,
        100
      );
      const total = Math.round(0.45 * alignment + 0.25 * structureScore + 0.30 * quality);

      const alignmentFlags = [
        ...(regimeAligned ? [] : ["COUNTER_REGIME"]),
        ...(structureAligned ? [] : ["COUNTER_STRUCTURE"]),
        ...(neutralAligned ? ["CHOP_CONTEXT"] : []),
      ];
      pushCandidate({
        id: `setup_${ts}_follow_${direction.toLowerCase()}`,
        ts,
        symbol,
        direction,
        pattern,
        triggerPrice,
        entryZone,
        stop,
        targets,
        rationale: reasons,
        flags: alignmentFlags.length ? alignmentFlags : undefined,
        score: { alignment: Math.round(alignment), structure: Math.round(structureScore), quality: Math.round(quality), total }
      });
    }

    // -------------------------
    // Pattern 3: FADE (countertrend)
    // -------------------------
    {
      const pattern: SetupPattern = "FADE";
      const reasons = [...baseReasons, `pattern=${pattern}`, "countertrend=true"];

      const rsi = indicators.rsi14 ?? computeRSI(closes, 14);
      const last = bars[bars.length - 1]!;
      const prev1 = bars[bars.length - 2]!;
      const prev2 = bars[bars.length - 3]!;

    // In TREND_DOWN: look for oversold bounce attempt (LONG)
    // In TREND_UP: look for overbought fade attempt (SHORT)
      // In CHOP: allow either extreme (lower confidence)
      const reversalDirections: Array<{ direction: Direction; needRsi: number }> = [
        { direction: "LONG", needRsi: regime.regime === "TREND_DOWN" ? 35 : 30 },
        { direction: "SHORT", needRsi: regime.regime === "TREND_UP" ? 65 : 70 },
      ];

      for (const rd of reversalDirections) {
        const direction = rd.direction;
        const needRsi = rd.needRsi;

        const momentumTurn =
          direction === "LONG"
            ? (prev2.close <= prev1.close && prev1.close <= last.close) // 2-step higher closes
            : (prev2.close >= prev1.close && prev1.close >= last.close); // 2-step lower closes

        const reclaimEma9 = direction === "LONG" ? last.close > ema9 : last.close < ema9;

        const rsiOk = rsi !== undefined
          ? (direction === "LONG" ? rsi <= needRsi : rsi >= needRsi)
          : false;

        if (!(momentumTurn && reclaimEma9 && rsiOk)) continue;

        const reversalReasons = [
          ...reasons,
          `reversalDir=${direction}`,
          `rsi14=${rsi!.toFixed(1)} needRsi=${needRsi}`,
          `turn=${momentumTurn} reclaimEma9=${reclaimEma9}`,
        ];

        const triggerPrice = last.close;
        const swingLookback = 12;
        const buffer = 0.10 * atr;
        const stop = direction === "LONG"
          ? recentSwingLow(bars, swingLookback) - buffer
          : recentSwingHigh(bars, swingLookback) + buffer;

        const risk = Math.abs(triggerPrice - stop);
        if (risk <= 0) continue;

        const entryLow = direction === "LONG" ? triggerPrice - 0.15 * risk : triggerPrice - 0.05 * risk;
        const entryHigh = direction === "LONG" ? triggerPrice + 0.05 * risk : triggerPrice + 0.15 * risk;
        const entryZone = { low: Math.min(entryLow, entryHigh), high: Math.max(entryLow, entryHigh) };
        const entryMid = (entryZone.low + entryZone.high) / 2;
        const targets = makeTargetsFromR(direction, entryMid, stop);

        // Cap scores lower because countertrend is inherently riskier
        // (and even lower in CHOP).
        const chopPenalty = regime.regime === "CHOP" ? 10 : 0;
        const alignment = clamp(45 - chopPenalty, 0, 100);
        const structureScore = clamp(45 - chopPenalty, 0, 100);
        const quality = clamp(60 - chopPenalty, 0, 100);
        const total = Math.min(65 - chopPenalty, Math.round(0.45 * alignment + 0.25 * structureScore + 0.30 * quality));

        pushCandidate({
          id: `setup_${ts}_reversal_${direction.toLowerCase()}`,
          ts,
          symbol,
          direction,
          pattern,
          triggerPrice,
          entryZone,
          stop,
          targets,
          rationale: reversalReasons,
          score: { alignment: Math.round(alignment), structure: Math.round(structureScore), quality: Math.round(quality), total }
        });
      }
    }

    if (candidates.length > 0 && candidates.length < 3) {
      const early = this.buildEarlyCandidates(ctx, "low candidate density (visibility-first)");
      const existingIds = new Set(candidates.map((c) => c.id));
      for (const candidate of early) {
        if (!existingIds.has(candidate.id)) {
          pushCandidate(candidate);
        }
      }
    }

    if (candidates.length === 0) {
      const early = this.buildEarlyCandidates(ctx, "no setup patterns matched");
      return { candidate: early[0], candidates: early, reason: "no setup patterns matched" };
    }

    const byScore = [...candidates].sort((a, b) => b.score.total - a.score.total);
    const pickByPreference = (patterns: SetupPattern[]) => {
      for (const pattern of patterns) {
        const best = byScore.find((c) => c.pattern === pattern);
        if (best) return best;
      }
      return undefined;
    };

    let preferred: SetupCandidate | undefined;
    if (regime.regime === "TREND_UP" || regime.regime === "TREND_DOWN") {
      preferred = pickByPreference(["FOLLOW", "RECLAIM", "FADE"]);
    } else if (regime.regime === "TRANSITION") {
      preferred = pickByPreference(["RECLAIM", "FOLLOW", "FADE"]);
    } else {
      preferred = pickByPreference(["RECLAIM", "FOLLOW", "FADE"]);
    }

    return { candidate: preferred ?? byScore[0]!, candidates: byScore };
  }

  private buildEarlyCandidates(ctx: SetupEngineContext, holdReason: string): SetupCandidate[] {
    const { ts, symbol, currentPrice, directionInference, tacticalBias, indicators, bars, volumeBars } = ctx;
    const fallbackRisk = indicators.atr && indicators.atr > 0 ? indicators.atr * 0.5 : Math.max(0.1, currentPrice * 0.001);
    const volBars = volumeBars ?? bars;
    const volNow = volBars?.length ? (volBars[volBars.length - 1]!.volume ?? 0) : undefined;
    const volSma20 = volBars ? computeVolSma(volBars, 20) : undefined;
    const relVolume = volBars ? computeRelVolume(volBars, 20) : undefined;
    const volTrend = volBars ? computeVolTrend(volBars, 20, 5) : undefined;
    const dollarVol = volNow !== undefined ? volNow * currentPrice : undefined;
    const directions: Direction[] = [];
    if (directionInference.direction) {
      directions.push(directionInference.direction);
    } else if (tacticalBias?.bias && tacticalBias.bias !== "NONE") {
      directions.push(tacticalBias.bias);
    } else {
      directions.push("LONG", "SHORT");
    }

    const patterns: SetupPattern[] = ["FOLLOW", "RECLAIM", "FADE"];
    const candidates: SetupCandidate[] = [];
    for (const direction of directions) {
      for (const pattern of patterns) {
        const stop = direction === "LONG" ? currentPrice - fallbackRisk : currentPrice + fallbackRisk;
        const entryZone = direction === "LONG"
          ? { low: currentPrice - fallbackRisk * 0.25, high: currentPrice + fallbackRisk * 0.15 }
          : { low: currentPrice - fallbackRisk * 0.15, high: currentPrice + fallbackRisk * 0.25 };
        const entryMid = (entryZone.low + entryZone.high) / 2;
        const targets = makeTargetsFromR(direction, entryMid, stop);
        candidates.push({
          id: `setup_${ts}_${pattern.toLowerCase()}_${direction.toLowerCase()}_early`,
          ts,
          symbol,
          direction,
          pattern,
          intentBucket: pattern,
          stage: "EARLY",
          holdReason,
          qualityTag: "LOW",
          triggerPrice: currentPrice,
          entryZone,
          stop,
          targets,
          rationale: [`EARLY idea (${pattern})`, holdReason],
          score: { alignment: 20, structure: 20, quality: 25, total: 20 },
          flags: ["EARLY_IDEA"],
          warningFlags: ["EARLY_IDEA"],
          featureBundle: {
            volume: {
              volNow: volNow !== undefined ? Number(volNow.toFixed(0)) : undefined,
              volSma20: volSma20 !== undefined ? Number(volSma20.toFixed(0)) : undefined,
              relVolume: relVolume !== undefined ? Number(relVolume.toFixed(2)) : undefined,
              volTrend: volTrend !== undefined ? Number(volTrend.toFixed(2)) : undefined,
              dollarVol: dollarVol !== undefined ? Number(dollarVol.toFixed(0)) : undefined,
            },
          },
        });
        if (candidates.length >= 6) return candidates;
      }
    }
    return candidates;
  }

  /**
   * Find FOLLOW pattern
   * Requirements:
   * - Tactical bias or direction inference provides direction
   * - EMA9 reclaim signal (price above EMA9 for LONG, below for SHORT)
   * - Recent swing point for stop placement
   */
  private findPullbackContinuation(ctx: SetupEngineContext): SetupEngineResult {
    const { ts, symbol, currentPrice, bars, regime, directionInference, indicators, tacticalBias } = ctx;
    const structure = { structure: regime.structure ?? "MIXED" as const };
    const atr = indicators.atr!;
    const ema9 = indicators.ema9!;
    const ema20 = indicators.ema20!;
    const vwap = indicators.vwap;
    const chaseRisk = vwap !== undefined ? Math.abs(currentPrice - vwap) > 0.8 * atr : false;

    if (!atr || !ema9 || !ema20) {
      const fallbackDir = directionInference.direction ?? (tacticalBias?.bias !== "NONE" ? tacticalBias?.bias : undefined);
      const early = fallbackDir
        ? this.buildEarlyCandidateFromContext(ctx, "FOLLOW", fallbackDir, "Missing required indicators for follow setup")
        : undefined;
      return { candidate: early, candidates: early ? [early] : undefined, reason: "Missing required indicators for pullback continuation" };
    }

    const direction: Direction | undefined =
      tacticalBias?.bias && tacticalBias.bias !== "NONE" && tacticalBias.tier !== "NONE"
        ? tacticalBias.bias
        : directionInference.direction;
    if (!direction) {
      return { candidate: undefined, candidates: undefined, reason: "No tactical bias or direction inference" };
    }
    const structureOpposed =
      (direction === "LONG" && structure.structure === "BEARISH") ||
      (direction === "SHORT" && structure.structure === "BULLISH");
    const regimeOpposed =
      (direction === "LONG" && regime.regime === "TREND_DOWN") ||
      (direction === "SHORT" && regime.regime === "TREND_UP");
    const contextFlags = [
      ...(structureOpposed ? ["COUNTER_STRUCTURE"] : []),
      ...(regimeOpposed ? ["COUNTER_REGIME"] : []),
      ...((regime.regime === "CHOP" || regime.regime === "TRANSITION") ? ["CHOP_CONTEXT"] : []),
    ];

    // Check EMA9 reclaim signal
    const reclaimSignal = direction === "LONG"
      ? currentPrice > ema9
      : currentPrice < ema9;

    if (!reclaimSignal) {
      const early = this.buildEarlyCandidateFromContext(ctx, "FOLLOW", direction, `No EMA9 reclaim signal for ${direction}`);
      return { candidate: early, candidates: early ? [early] : undefined, reason: `No EMA9 reclaim signal for ${direction}` };
    }

    // Find recent swing point for stop placement
    const lookback = Math.min(20, bars.length);
    const window = bars.slice(-lookback);

    let swingPoint: number | undefined;
    if (direction === "LONG") {
      // Find recent low (swing low)
      swingPoint = Math.min(...window.map(b => b.low));
    } else {
      // Find recent high (swing high)
      swingPoint = Math.max(...window.map(b => b.high));
    }

    if (swingPoint === undefined) {
      const early = this.buildEarlyCandidateFromContext(ctx, "FOLLOW", direction, "Could not find swing point");
      return { candidate: early, candidates: early ? [early] : undefined, reason: "Could not find swing point" };
    }

    // Build entry zone (around current price, slightly wider for pullback)
    const entryMid = currentPrice;
    const entryZoneWidth = atr * 0.15; // 15% of ATR
    const entryZone = direction === "LONG"
      ? { low: entryMid - entryZoneWidth * 0.6, high: entryMid + entryZoneWidth * 0.4 }
      : { low: entryMid - entryZoneWidth * 0.4, high: entryMid + entryZoneWidth * 0.6 };

    // Build stop: swing point +/- 0.10*ATR
    const stopBuffer = atr * 0.10;
    const stop = direction === "LONG"
      ? swingPoint - stopBuffer
      : swingPoint + stopBuffer;

    // Calculate risk (entryMid to stop)
    const risk = Math.abs(entryMid - stop);
    if (risk <= 0) {
      const early = this.buildEarlyCandidateFromContext(ctx, "FOLLOW", direction, "Invalid risk calculation");
      return { candidate: early, candidates: early ? [early] : undefined, reason: "Invalid risk calculation" };
    }
    const riskAtr = risk / atr;
    if (riskAtr < 0.25 || riskAtr > 1.2) {
      const early = this.buildEarlyCandidateFromContext(ctx, "FOLLOW", direction, `Risk/ATR out of bounds (${riskAtr.toFixed(2)})`);
      return { candidate: early, candidates: early ? [early] : undefined, reason: `Risk/ATR out of bounds (${riskAtr.toFixed(2)})` };
    }

    // Build targets: 1R, 2R, 3R from entryMid
    const targets = makeTargetsFromR(direction, entryMid, stop);

    // Calculate scores
    const alignmentScore = this.scoreAlignment(regime, structure, direction);
    const structureScore = this.scoreStructure(structure, direction);
    const chasePenalty = chaseRisk ? -12 : 0;
    const qualityScore = clamp(this.scoreQuality(atr, risk, ema9, ema20, currentPrice, direction) + chasePenalty, 0, 100);
    const totalScore = Math.round((alignmentScore + structureScore + qualityScore) / 3);

    const rationale: string[] = [
      `Regime: ${regime.regime}`,
      `Structure: ${structure.structure}`,
      `EMA9 reclaim: ${direction === "LONG" ? "above" : "below"}`,
      `Swing: ${swingPoint.toFixed(2)}`,
      `Risk: ${risk.toFixed(2)} (${(risk / atr).toFixed(2)} ATR)`,
      chaseRisk ? "chaseRisk=true (distance to VWAP > 0.8 ATR)" : "chaseRisk=false"
    ];

    const candidate: SetupCandidate = {
      id: `setup_${ts}_pullback`,
      ts,
      symbol,
      direction,
      pattern: "FOLLOW",
      triggerPrice: currentPrice,
      entryZone,
      stop,
      targets,
      rationale,
      flags: contextFlags.length ? [...(contextFlags ?? [])] : undefined,
      score: {
        alignment: alignmentScore,
        structure: structureScore,
        quality: qualityScore,
        total: totalScore
      }
    };

    return { candidate };
  }

  /**
   * Score alignment: regime + structure alignment with direction
   */
  private scoreAlignment(regime: RegimeResult, structure: { structure: "BULLISH" | "BEARISH" | "MIXED" }, direction: Direction): number {
    let score = 0;

    // Regime alignment
    if (direction === "LONG" && regime.regime === "TREND_UP") {
      score += 40;
    } else if (direction === "SHORT" && regime.regime === "TREND_DOWN") {
      score += 40;
    }

    // Structure alignment
    if (direction === "LONG" && structure.structure === "BULLISH") {
      score += 30;
    } else if (direction === "SHORT" && structure.structure === "BEARISH") {
      score += 30;
    }

    // VWAP slope alignment
    if (direction === "LONG" && regime.vwapSlope === "UP") {
      score += 15;
    } else if (direction === "SHORT" && regime.vwapSlope === "DOWN") {
      score += 15;
    }

    return Math.min(100, score);
  }

  private buildEarlyCandidateFromContext(
    ctx: SetupEngineContext,
    pattern: SetupPattern,
    direction: Direction,
    holdReason: string
  ): SetupCandidate | undefined {
    const { ts, symbol, currentPrice, indicators } = ctx;
    const atr = indicators.atr ?? computeATR(ctx.bars, 14);
    if (!atr || atr <= 0) return undefined;
    const fallbackRisk = atr * 0.5;
    const stop = direction === "LONG" ? currentPrice - fallbackRisk : currentPrice + fallbackRisk;
    const entryZone = direction === "LONG"
      ? { low: currentPrice - fallbackRisk * 0.25, high: currentPrice + fallbackRisk * 0.15 }
      : { low: currentPrice - fallbackRisk * 0.15, high: currentPrice + fallbackRisk * 0.25 };
    const entryMid = (entryZone.low + entryZone.high) / 2;
    const targets = makeTargetsFromR(direction, entryMid, stop);
    return {
      id: `setup_${ts}_${pattern.toLowerCase()}_${direction.toLowerCase()}_early`,
      ts,
      symbol,
      direction,
      pattern,
      intentBucket: pattern,
      stage: "EARLY",
      holdReason,
      qualityTag: "LOW",
      triggerPrice: currentPrice,
      entryZone,
      stop,
      targets,
      rationale: [`EARLY idea (${pattern})`, holdReason],
      score: { alignment: 20, structure: 20, quality: 25, total: 20 },
      flags: ["EARLY_IDEA"],
      warningFlags: ["EARLY_IDEA"]
    };
  }

  /**
   * Find RECLAIM pattern
   * Requirements:
   * - Tactical bias or direction inference provides direction
   * - Price pulls into VWAP/EMA20 band
   * - Higher low / lower high signal (rejection)
   * - Close back above/below EMA9 and hold 1-2 bars
   */
  private findValueReclaim(ctx: SetupEngineContext): SetupEngineResult {
    const { ts, symbol, currentPrice, bars, regime, indicators, directionInference, tacticalBias } = ctx;
    const atr = indicators.atr!;
    const ema9 = indicators.ema9!;
    const ema20 = indicators.ema20!;
    const vwap = indicators.vwap;
    const chaseRisk = vwap !== undefined ? Math.abs(currentPrice - vwap) > 0.8 * atr : false;

    if (!atr || !ema9 || !ema20) {
      const fallbackDir = directionInference.direction ?? (tacticalBias?.bias !== "NONE" ? tacticalBias?.bias : undefined);
      const early = fallbackDir
        ? this.buildEarlyCandidateFromContext(ctx, "RECLAIM", fallbackDir, "Missing required indicators for reclaim setup")
        : undefined;
      return { candidate: early, candidates: early ? [early] : undefined, reason: "Missing required indicators for value reclaim" };
    }

    if (bars.length < 6) {
      const fallbackDir = directionInference.direction ?? (tacticalBias?.bias !== "NONE" ? tacticalBias?.bias : undefined);
      const early = fallbackDir
        ? this.buildEarlyCandidateFromContext(ctx, "RECLAIM", fallbackDir, "Insufficient bars for reclaim setup")
        : undefined;
      return { candidate: early, candidates: early ? [early] : undefined, reason: "Insufficient bars for value reclaim" };
    }

    const direction: Direction | undefined =
      tacticalBias?.bias && tacticalBias.bias !== "NONE" ? tacticalBias.bias : directionInference.direction;
    if (!direction) {
      return { candidate: undefined, candidates: undefined, reason: "No tactical bias or direction inference" };
    }

    const bandLow = vwap !== undefined ? Math.min(vwap, ema20) : ema20;
    const bandHigh = vwap !== undefined ? Math.max(vwap, ema20) : ema20;

    const last = bars[bars.length - 1]!;
    const prev = bars[bars.length - 2]!;
    const prev2 = bars[bars.length - 3]!;

    const pulledIntoValue = [prev2, prev, last].some((b) => b.low <= bandHigh && b.close >= bandLow);
    const rejectionSignal = direction === "LONG"
      ? last.low > prev.low && last.close > prev.close
      : last.high < prev.high && last.close < prev.close;

    const emaHold = direction === "LONG"
      ? last.close > ema9 && prev.close > ema9
      : last.close < ema9 && prev.close < ema9;

    if (!pulledIntoValue || !rejectionSignal || !emaHold) {
      const early = this.buildEarlyCandidateFromContext(ctx, "RECLAIM", direction, "Reclaim conditions not met");
      return { candidate: early, candidates: early ? [early] : undefined, reason: "Value reclaim conditions not met" };
    }

    const triggerPrice = last.close;
    const swingLookback = 12;
    const buffer = 0.10 * atr;
    const stop = direction === "LONG"
      ? recentSwingLow(bars, swingLookback) - buffer
      : recentSwingHigh(bars, swingLookback) + buffer;

    const risk = Math.abs(triggerPrice - stop);
    if (risk <= 0) {
      const early = this.buildEarlyCandidateFromContext(ctx, "RECLAIM", direction, "Invalid risk for reclaim");
      return { candidate: early, candidates: early ? [early] : undefined, reason: "Invalid risk for value reclaim" };
    }

    const entryZone = direction === "LONG"
      ? { low: triggerPrice - 0.15 * risk, high: triggerPrice + 0.05 * risk }
      : { low: triggerPrice - 0.05 * risk, high: triggerPrice + 0.15 * risk };
    const entryMid = (entryZone.low + entryZone.high) / 2;
    const targets = makeTargetsFromR(direction, entryMid, stop);

    const alignment = clamp(
      tacticalBias?.bias && tacticalBias.bias !== "NONE"
        ? (tacticalBias.bias === direction ? 85 : 60)
        : directionInference.confidence ?? 60,
      0,
      100
    );
    const structureScore = clamp(regime.structure === "BULLISH" || regime.structure === "BEARISH" ? 80 : 60, 0, 100);
    const chasePenalty = chaseRisk ? -12 : 0;
    const quality = clamp(
      78
        + (vwap !== undefined ? (direction === "LONG" ? (currentPrice >= vwap ? 4 : -6) : (currentPrice <= vwap ? 4 : -6)) : 0)
        + (Math.abs(entryMid - ema20) <= 0.8 * atr ? 6 : -6)
        + chasePenalty,
      0,
      100
    );
    const total = Math.round(0.45 * alignment + 0.25 * structureScore + 0.30 * quality);

    const rationale = [
      `pattern=RECLAIM`,
      `tacticalBias=${tacticalBias?.bias ?? "N/A"}`,
      `dirInf=${directionInference.direction ?? "N/A"}(${directionInference.confidence ?? 0})`,
      `valueBand=${bandLow.toFixed(2)}-${bandHigh.toFixed(2)}`,
      `rejection=${rejectionSignal}`,
      `emaHold=${emaHold}`,
      chaseRisk ? "chaseRisk=true (distance to VWAP > 0.8 ATR)" : "chaseRisk=false",
    ];

    return {
      candidate: {
        id: `setup_${ts}_valuereclaim_${direction.toLowerCase()}`,
        ts,
        symbol,
        direction,
        pattern: "RECLAIM",
        triggerPrice,
        entryZone,
        stop,
        targets,
        meta: {
          valueBand: { low: bandLow, high: bandHigh },
          vwapRef: vwap ?? null
        },
        rationale,
        score: { alignment: Math.round(alignment), structure: Math.round(structureScore), quality: Math.round(quality), total }
      }
    };
  }

  /**
   * Score structure quality
   */
  private scoreStructure(structure: { structure: "BULLISH" | "BEARISH" | "MIXED" }, direction: Direction): number {
    if (direction === "LONG" && structure.structure === "BULLISH") {
      return 80;
    } else if (direction === "SHORT" && structure.structure === "BEARISH") {
      return 80;
    } else if (structure.structure === "MIXED") {
      return 40;
    }
    return 20; // Wrong structure
  }

  /**
   * Score setup quality: risk/reward, EMA alignment, etc.
   */
  private scoreQuality(
    atr: number,
    risk: number,
    ema9: number,
    ema20: number,
    currentPrice: number,
    direction: Direction
  ): number {
    let score = 50; // Base score

    // Risk in ATR terms (prefer 0.5-1.5 ATR)
    const riskAtr = risk / atr;
    if (riskAtr >= 0.5 && riskAtr <= 1.5) {
      score += 20;
    } else if (riskAtr < 0.3 || riskAtr > 2.0) {
      score -= 20;
    }

    // EMA alignment
    if (direction === "LONG") {
      if (currentPrice > ema9 && ema9 > ema20) {
        score += 20; // Perfect bullish stack
      } else if (currentPrice > ema9) {
        score += 10; // Above EMA9
      }
    } else {
      if (currentPrice < ema9 && ema9 < ema20) {
        score += 20; // Perfect bearish stack
      } else if (currentPrice < ema9) {
        score += 10; // Below EMA9
      }
    }

    return Math.max(0, Math.min(100, score));
  }
}
