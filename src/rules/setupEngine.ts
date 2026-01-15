import type { Bias, Direction, SetupCandidate, SetupPattern } from "../types.js";
import type { OHLCVBar } from "../utils/indicators.js";
import { computeATR, computeEMA, computeVWAP, computeRSI } from "../utils/indicators.js";
import type { RegimeResult } from "./regimeRules.js";
import type { StructureResult } from "../utils/structure.js";
import type { DirectionInference } from "./directionRules.js";

export interface SetupEngineContext {
  ts: number;
  symbol: string;
  currentPrice: number;
  bars: OHLCVBar[];
  regime: RegimeResult;
  macroBias?: Bias;
  directionInference: DirectionInference;
  indicators: {
    atr?: number;
    ema9?: number;
    ema20?: number;
    vwap?: number;
    rsi14?: number;
  };
}

export interface SetupEngineResult {
  candidate?: SetupCandidate;
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

/**
 * SetupEngine: Deterministic pattern detection for trading setups
 * 
 * Implements three patterns:
 * 1. PULLBACK_CONTINUATION: Trend continuation after pullback
 * 2. BREAK_RETEST: Breakout above/below level, retest, then reclaim
 * 3. REVERSAL_ATTEMPT: Countertrend reversal (oversold bounce / overbought fade)
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
      return { reason: "insufficient bars for setup detection (< 30)" };
    }

    const atr = indicators.atr ?? computeATR(bars, 14);
    const closes = bars.map((b) => b.close);
    const ema9 = indicators.ema9 ?? computeEMA(closes.slice(-60), 9);
    const ema20 = indicators.ema20 ?? computeEMA(closes.slice(-80), 20);
    const vwap = indicators.vwap ?? computeVWAP(bars, 30);

    if (!atr || atr <= 0) return { reason: "ATR unavailable; cannot size setup" };
    if (ema9 === undefined || ema20 === undefined) return { reason: "EMA unavailable; cannot detect reclaim" };

    const chaseRisk = vwap !== undefined ? Math.abs(currentPrice - vwap) > 0.8 * atr : false;

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
        return {
          reason: `chop regime blocks setups (override needs |slope|>=1.2 ATR + VWAP/EMA alignment; got slope=${slopeAtr.toFixed(2)} ATR bullAligned=${bullAligned} bearAligned=${bearAligned})`
        };
      }

      chopOverride = true;
      chopOverrideDirection = bullAligned ? "LONG" : "SHORT";
      baseReasons.push(`chopOverride=true dir=${chopOverrideDirection} slope=${slopeAtr.toFixed(2)} ATR`);
    }

    baseReasons.push(`regime=${regime.regime} structure=${regime.structure ?? "N/A"}`);
    if (ctx.macroBias) {
      baseReasons.push(`macroBias=${ctx.macroBias}`);
    }
    baseReasons.push(`ema9=${ema9.toFixed(2)} ema20=${ema20.toFixed(2)} atr=${atr.toFixed(2)}`);
    if (vwap !== undefined) baseReasons.push(`vwap=${vwap.toFixed(2)} vwapSlope=${regime.vwapSlope ?? "N/A"}`);
    baseReasons.push(
      `dirInf=${directionInference.direction ?? "N/A"} conf=${directionInference.confidence ?? 0} (${(directionInference.reasons ?? []).join(" | ")})`
    );

    const candidates: SetupCandidate[] = [];
    const pushCandidate = (candidate: SetupCandidate) => {
      // Add CHOP_OVERRIDE flag if applicable
      if (chopOverride) {
        candidate.flags = [...(candidate.flags ?? []), "CHOP_OVERRIDE"];
      }
      if (chaseRisk) {
        candidate.flags = [...(candidate.flags ?? []), "CHASE_RISK"];
      }
      candidates.push(candidate);
    };

    // Try PULLBACK_CONTINUATION pattern
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

    // Try VALUE_RECLAIM pattern (high-expectancy pullback reclaim)
    const valueReclaimResult = this.findValueReclaim({
      ts,
      symbol,
      currentPrice,
      bars,
      regime,
      macroBias: ctx.macroBias,
      directionInference,
      indicators: { atr, ema9, ema20, vwap }
    });
    if (valueReclaimResult.candidate) {
      pushCandidate(valueReclaimResult.candidate);
    }

    // -------------------------
    // Pattern 2: BREAK_RETEST (trend)
    // -------------------------
    for (const direction of ["LONG", "SHORT"] as const) {
      // Require regime OR structure alignment for trend patterns.
      // In CHOP, allow only if we explicitly have chopOverride for that direction.
      const regimeAligned =
        (regime.regime === "TREND_UP" && direction === "LONG") ||
        (regime.regime === "TREND_DOWN" && direction === "SHORT");
      const structureAligned = (regime.structure === "BULLISH" && direction === "LONG") || (regime.structure === "BEARISH" && direction === "SHORT");
      const chopAligned = chopOverride && chopOverrideDirection === direction;

      if (!(regimeAligned || structureAligned || chopAligned)) continue;

      const pattern: SetupPattern = "BREAK_RETEST";
      const reasons = [
        ...baseReasons,
        `pattern=${pattern}`,
        `aligned: regimeAligned=${regimeAligned} structureAligned=${structureAligned} chopAligned=${chopAligned}`,
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

      pushCandidate({
        id: `setup_${ts}_breakretest_${direction.toLowerCase()}`,
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

    // -------------------------
    // Pattern 3: REVERSAL_ATTEMPT (countertrend)
    // -------------------------
    {
      const pattern: SetupPattern = "REVERSAL_ATTEMPT";
      const reasons = [...baseReasons, `pattern=${pattern}`, "countertrend=true"];

      const rsi = indicators.rsi14 ?? computeRSI(closes, 14);
      const last = bars[bars.length - 1]!;
      const prev1 = bars[bars.length - 2]!;
      const prev2 = bars[bars.length - 3]!;

    // In TREND_DOWN: look for oversold bounce attempt (LONG)
    // In TREND_UP: look for overbought fade attempt (SHORT)
      // In CHOP: allow either extreme (lower confidence)
      const reversalDirections: Array<{ direction: Direction; needRsi: number }> =
        regime.regime === "TREND_DOWN"
          ? [{ direction: "LONG", needRsi: 35 }]
          : regime.regime === "TREND_UP"
          ? [{ direction: "SHORT", needRsi: 65 }]
          : [
              { direction: "LONG", needRsi: 30 },
              { direction: "SHORT", needRsi: 70 },
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

    // Select best candidate deterministically (pullback-only)
    const pullbackCandidates = candidates.filter((c) => c.pattern === "PULLBACK_CONTINUATION");
    if (pullbackCandidates.length === 0) {
      return { reason: "Only PULLBACK_CONTINUATION enabled" };
    }

    // Pick best candidate by deterministic score
    pullbackCandidates.sort((a, b) => b.score.total - a.score.total);
    return { candidate: pullbackCandidates[0]! };
  }

  /**
   * Find PULLBACK_CONTINUATION pattern
   * Requirements:
   * - Regime alignment (BULL for LONG, BEAR for SHORT)
   * - Structure alignment (BULLISH for LONG, BEARISH for SHORT)
   * - EMA9 reclaim signal (price above EMA9 for LONG, below for SHORT)
   * - Recent swing point for stop placement
   */
  private findPullbackContinuation(ctx: SetupEngineContext): SetupEngineResult {
    const { ts, symbol, currentPrice, bars, regime, directionInference, indicators } = ctx;
    const structure = { structure: regime.structure ?? "MIXED" as const };
    const atr = indicators.atr!;
    const ema9 = indicators.ema9!;
    const ema20 = indicators.ema20!;
    const vwap = indicators.vwap;
    const chaseRisk = vwap !== undefined ? Math.abs(currentPrice - vwap) > 0.8 * atr : false;

    if (!atr || !ema9 || !ema20) {
      return { reason: "Missing required indicators for pullback continuation" };
    }

    // Determine direction from regime
    let direction: Direction | undefined;
    if (regime.regime === "TREND_UP" && structure.structure === "BULLISH") {
      direction = "LONG";
    } else if (regime.regime === "TREND_DOWN" && structure.structure === "BEARISH") {
      direction = "SHORT";
    } else {
      return { reason: "Regime/structure misalignment" };
    }

    // Check EMA9 reclaim signal
    const reclaimSignal = direction === "LONG"
      ? currentPrice > ema9
      : currentPrice < ema9;

    if (!reclaimSignal) {
      return { reason: `No EMA9 reclaim signal for ${direction}` };
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
      return { reason: "Could not find swing point" };
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
      return { reason: "Invalid risk calculation" };
    }
    const riskAtr = risk / atr;
    if (riskAtr < 0.25 || riskAtr > 1.2) {
      return { reason: `Risk/ATR out of bounds (${riskAtr.toFixed(2)})` };
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
      pattern: "PULLBACK_CONTINUATION",
      triggerPrice: currentPrice,
      entryZone,
      stop,
      targets,
      rationale,
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

  /**
   * Find VALUE_RECLAIM pattern
   * Requirements:
   * - Macro bias aligns (LONG bias for LONG reclaim, SHORT bias for SHORT reclaim)
   * - Price pulls into VWAP/EMA20 band
   * - Higher low / lower high signal (rejection)
   * - Close back above/below EMA9 and hold 1-2 bars
   */
  private findValueReclaim(ctx: SetupEngineContext): SetupEngineResult {
    const { ts, symbol, currentPrice, bars, regime, macroBias, indicators } = ctx;
    const atr = indicators.atr!;
    const ema9 = indicators.ema9!;
    const ema20 = indicators.ema20!;
    const vwap = indicators.vwap;
    const chaseRisk = vwap !== undefined ? Math.abs(currentPrice - vwap) > 0.8 * atr : false;

    if (!atr || !ema9 || !ema20) {
      return { reason: "Missing required indicators for value reclaim" };
    }

    if (bars.length < 6) {
      return { reason: "Insufficient bars for value reclaim" };
    }

    const direction: Direction | undefined =
      macroBias === "LONG" ? "LONG" : macroBias === "SHORT" ? "SHORT" : undefined;
    if (!direction) {
      return { reason: "Macro bias neutral - value reclaim skipped" };
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
      return { reason: "Value reclaim conditions not met" };
    }

    const triggerPrice = last.close;
    const swingLookback = 12;
    const buffer = 0.10 * atr;
    const stop = direction === "LONG"
      ? recentSwingLow(bars, swingLookback) - buffer
      : recentSwingHigh(bars, swingLookback) + buffer;

    const risk = Math.abs(triggerPrice - stop);
    if (risk <= 0) return { reason: "Invalid risk for value reclaim" };

    const entryZone = direction === "LONG"
      ? { low: triggerPrice - 0.15 * risk, high: triggerPrice + 0.05 * risk }
      : { low: triggerPrice - 0.05 * risk, high: triggerPrice + 0.15 * risk };
    const entryMid = (entryZone.low + entryZone.high) / 2;
    const targets = makeTargetsFromR(direction, entryMid, stop);

    const alignment = clamp(
      (direction === "LONG" && macroBias === "LONG") || (direction === "SHORT" && macroBias === "SHORT") ? 85 : 60,
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
      `pattern=VALUE_RECLAIM`,
      `macroBias=${macroBias}`,
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
        pattern: "VALUE_RECLAIM",
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
