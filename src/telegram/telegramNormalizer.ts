import type { Direction, DomainEvent } from "../types.js";

export type TelegramSnapshotType = "SIGNAL" | "WATCH" | "UPDATE";

export type TelegramSnapshot = {
  type: TelegramSnapshotType;
  symbol: string;
  dir: Direction;
  conf?: number;
  risk: string;
  entryTrigger?: string;
  entryTriggerTf?: string;
  stop?: number;
  invalidation?: string;
  tp1?: number;
  tp2?: number;
  sizeMultiplier?: number;
  why?: string;
  warnTags?: string[];
  armCondition?: string;
  entryRule?: string;
  planStop?: string;
  plan?: string;
  update?: {
    fromSide?: "LONG" | "SHORT";
    toSide?: "LONG" | "SHORT";
    emoji?: string;
    cause: string;
    next: string;
    ts: string;
    price?: number;
    lastSignal?: string;
  };
};

const RISK_ATR_HIGH = 1.5;
const REARM_VWAP_ATR = 0.8;

const isFiniteNumber = (value?: number): value is number => Number.isFinite(value);

const mapRiskMode = (mode?: string): string => {
  switch (mode) {
    case "REDUCE_SIZE":
      return "REDUCE";
    case "SCALP_ONLY":
      return "SCALP";
    case "WATCH_ONLY":
      return "WATCH";
    default:
      return "NORMAL";
  }
};

const normalizeReason = (reason: string): string => reason.replace(/\s+/g, " ").trim();

const unique = (items: string[]): string[] => Array.from(new Set(items));

const getSymbol = (event: DomainEvent): string =>
  event.data.symbol ?? event.data.play?.symbol ?? event.data.topPlay?.symbol ?? event.data.candidate?.symbol ?? "UNKNOWN";

const getDirection = (event: DomainEvent): Direction | undefined =>
  event.data.direction ?? event.data.play?.direction ?? event.data.topPlay?.direction ?? event.data.candidate?.direction;

const getTacticalConfidence = (event: DomainEvent): number | undefined => {
  const tactical = event.data.marketState?.tacticalSnapshot ?? event.data.marketState?.tacticalBias;
  return isFiniteNumber(tactical?.confidence) ? Math.round(tactical.confidence) : undefined;
};

const getEntryZone = (event: DomainEvent): { low: number; high: number } | undefined =>
  event.data.entryZone ?? event.data.play?.entryZone ?? event.data.topPlay?.entryZone ?? event.data.candidate?.entryZone;

const getStop = (event: DomainEvent): number | undefined =>
  event.data.stop ?? event.data.play?.stop ?? event.data.topPlay?.stop ?? event.data.candidate?.stop;

const getTargets = (event: DomainEvent): { t1: number; t2: number } | undefined => {
  const targets = event.data.targets ?? event.data.play?.targets ?? event.data.topPlay?.targets ?? event.data.candidate?.targets;
  if (!targets) return undefined;
  return { t1: targets.t1, t2: targets.t2 };
};

const getRiskMode = (event: DomainEvent): string => mapRiskMode(event.data.marketState?.permission?.mode);

const getRiskAtr = (event: DomainEvent): number | undefined => {
  const riskAtr = event.data.decision?.metrics?.riskAtr;
  return isFiniteNumber(riskAtr) ? riskAtr : undefined;
};

const getDistToVwapAtr = (event: DomainEvent): number | undefined => {
  const loc = event.data.candidate?.featureBundle?.location;
  const dist = loc?.priceVsVWAP?.atR ?? loc?.extendedFromMean?.atR;
  return isFiniteNumber(dist) ? dist : undefined;
};

const getIndicatorSnapshot = (event: DomainEvent): { vwap?: number; ema9?: number; ema20?: number } => {
  const fromRules = event.data.decision?.rules?.indicators ?? {};
  const fromCandidate = event.data.candidate?.featureBundle?.indicators ?? {};
  return {
    vwap: fromRules.vwap ?? fromRules.vwap1m ?? fromCandidate.vwap_1m ?? fromCandidate.vwap_5m,
    ema9: fromRules.ema9 ?? fromRules.ema9_1m ?? fromCandidate.ema9_1m ?? fromCandidate.ema9_5m,
    ema20: fromRules.ema20 ?? fromRules.ema20_1m ?? fromCandidate.ema20_1m ?? fromCandidate.ema20_5m,
  };
};

const isExtendedFromMean = (event: DomainEvent, reasons: string[]): boolean => {
  if (reasons.some((reason) => /extended-from-mean/i.test(reason))) return true;
  if (event.data.candidate?.warningFlags?.includes("EXTENDED")) return true;
  return event.data.candidate?.featureBundle?.location?.extendedFromMean?.extended ?? false;
};

const isDataNotReady = (event: DomainEvent, reasons: string[]): boolean => {
  if (event.data.marketState?.dataReadiness?.ready === false) return true;
  return reasons.some((reason) => /data_ready|missing|required|insufficient/i.test(reason));
};

const isTimeOfDayCutoff = (reason?: string): boolean => !!reason && /time-of-day cutoff/i.test(reason);

const isMarketUnavailable = (reason?: string): boolean =>
  !!reason && /(market unavailable|spread|liquidity)/i.test(reason);

const formatEtTimestamp = (ts: number): string => {
  const dt = new Date(ts);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(dt);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} ET`;
};

const extractRearmClause = (reason: string): string | undefined => {
  const match = reason.match(/Re-arm[^.]*\./i);
  if (!match) return undefined;
  return match[0]
    .replace(/Re-arm\s*when\s*/i, "")
    .replace(/Re-arm\s*/i, "")
    .replace(/\.$/, "")
    .trim();
};

const extractReclaimCondition = (reason: string, dir: Direction): string | undefined => {
  const emaMatch = reason.match(/close\s+[^\s]+\s+EMA\s*\(([\d.]+)\)/i);
  if (emaMatch) {
    const comparator = dir === "LONG" ? "close > EMA" : "close < EMA";
    return `${comparator} ${emaMatch[1]}`;
  }
  const pullbackMatch = reason.match(/Pullback depth\s+([\d.]+)\s+is less than minimum\s+([\d.]+)/i);
  if (pullbackMatch) {
    return `pullback >= ${pullbackMatch[2]}`;
  }
  return undefined;
};

const buildWarnTags = (event: DomainEvent, reasons: string[], blockers: string[]): string[] => {
  const tags: string[] = [];
  if (isExtendedFromMean(event, reasons)) tags.push("EXTENDED");
  if (reasons.some((reason) => /RISK_CAP/i.test(reason))) tags.push("RISK_ATR");
  if (reasons.some((reason) => /No reclaim signal/i.test(reason))) tags.push("RECLAIM");
  if (reasons.some((reason) => /cooldown/i.test(reason))) tags.push("COOLDOWN");
  if (reasons.some((reason) => /LOW_CONTEXT/i.test(reason))) tags.push("LOW_CONTEXT");
  if (reasons.some((reason) => /TRANSITION_LOCK|SHOCK/i.test(reason))) tags.push("TRANSITION");
  if (reasons.some((reason) => /TIMEFRAME_CONFLICT/i.test(reason))) tags.push("TF_CONFLICT");
  if (reasons.some((reason) => /LOW_CANDIDATE_DENSITY/i.test(reason))) tags.push("LOW_DENSITY");
  if (isDataNotReady(event, reasons)) tags.push("DATA");

  for (const blocker of blockers) {
    if (blocker === "guardrail") tags.push("GUARDRAIL");
    if (blocker === "cooldown") tags.push("COOLDOWN");
    if (blocker === "entry_filter" && !tags.includes("EXTENDED")) tags.push("ENTRY_FILTER");
  }

  return unique(tags);
};

const deriveEntryMode = (event: DomainEvent, reasons: string[], warnTags: string[]): "MOMENTUM" | "PULLBACK" => {
  const timingPhase = event.data.timing?.phase ?? event.data.timing?.state;
  const impulseDetected = timingPhase === "IMPULSE" || timingPhase === "ENTRY_WINDOW";
  const tacticalConfidence = getTacticalConfidence(event);
  const distToVwapAtr = getDistToVwapAtr(event);
  const extremeExtended = isFiniteNumber(distToVwapAtr) ? Math.abs(distToVwapAtr) >= 1.0 : warnTags.includes("EXTENDED");
  const riskAtr = getRiskAtr(event);
  const riskAtrHigh = isFiniteNumber(riskAtr) ? riskAtr > RISK_ATR_HIGH : warnTags.includes("RISK_ATR");
  const extended = isExtendedFromMean(event, reasons);

  if (extended || riskAtrHigh) return "PULLBACK";
  if (impulseDetected && tacticalConfidence === 100 && !extremeExtended) return "MOMENTUM";
  return "PULLBACK";
};

const deriveSizeMultiplier = (warnTags: string[]): number => {
  let multiplier = 1;
  if (warnTags.includes("EXTENDED")) multiplier = Math.min(multiplier, 0.5);
  if (warnTags.includes("RISK_ATR")) multiplier = Math.min(multiplier, 0.5);
  if (warnTags.includes("COOLDOWN")) multiplier = Math.min(multiplier, 0.7);
  if (warnTags.includes("LOW_CONTEXT")) multiplier = Math.min(multiplier, 0.7);
  if (warnTags.includes("GUARDRAIL")) multiplier = Math.min(multiplier, 0.7);
  return Math.max(0.25, Math.round(multiplier * 100) / 100);
};

const buildArmCondition = (event: DomainEvent, dir: Direction, reasons: string[], warnTags: string[]): string | undefined => {
  const parts: string[] = [];
  for (const reason of reasons) {
    const clean = normalizeReason(reason);
    const rearm = extractRearmClause(clean);
    if (rearm) parts.push(rearm);
    const reclaim = extractReclaimCondition(clean, dir);
    if (reclaim) parts.push(reclaim);
    if (/cooldown/i.test(clean)) parts.push("cooldown cleared");
  }

  const distToVwap = getDistToVwapAtr(event);
  const hasVwapClause = parts.some((part) => /vwap/i.test(part));
  if (warnTags.includes("EXTENDED") && isFiniteNumber(distToVwap) && !hasVwapClause) {
    parts.push(`distance_to_VWAP <= ${REARM_VWAP_ATR} ATR`);
  }

  if (warnTags.includes("RISK_ATR")) {
    parts.push("tighter stop (reduce risk/ATR)");
  }

  return parts.length ? unique(parts).join(" OR ") : undefined;
};

const buildWhy = (event: DomainEvent, dir: Direction, reasons: string[]): string => {
  const timingPhase = event.data.timing?.phase ?? event.data.timing?.state;
  const regime = event.data.marketState?.regime;
  const regimeLabel = regime === "TREND_UP" || regime === "TREND_DOWN" ? "trend" : regime === "CHOP" ? "chop" : "trend";
  const dirLabel = dir === "LONG" ? "up" : "down";
  const whyParts: string[] = [];
  const { vwap, ema9, ema20 } = getIndicatorSnapshot(event);
  const close = event.data.price ?? event.data.close ?? event.data.candidate?.triggerPrice;
  const priceAboveVwap = isFiniteNumber(close) && isFiniteNumber(vwap) ? (close as number) > (vwap as number) : undefined;
  const emaAligned = isFiniteNumber(ema9) && isFiniteNumber(ema20) ? (ema9 as number) > (ema20 as number) : undefined;

  if (timingPhase === "IMPULSE") whyParts.push("impulse");
  if (timingPhase === "PULLBACK") whyParts.push("pullback");

  if (priceAboveVwap !== undefined) {
    whyParts.push(`price${priceAboveVwap ? ">" : "<"}VWAP`);
  }
  if (emaAligned !== undefined) {
    whyParts.push(`EMA9${emaAligned ? ">" : "<"}EMA20`);
  }

  if (whyParts.length === 0) {
    return `${regimeLabel} ${dirLabel}`;
  }

  if (isExtendedFromMean(event, reasons)) {
    return `${regimeLabel} ${dirLabel}, impulse but extended`;
  }

  return `${regimeLabel} ${dirLabel}, ${whyParts.join(", ")}`;
};

const buildEntryTrigger = (entryZone: { low: number; high: number }, dir: Direction): string => {
  const level = dir === "LONG" ? entryZone.high : entryZone.low;
  return `break&hold ${dir === "LONG" ? "above" : "below"} ${level.toFixed(2)}`;
};

const buildHardArmCondition = (reasons: string[]): string => {
  const reasonText = reasons.join(" ").toLowerCase();
  if (reasonText.includes("data_ready") || reasonText.includes("warmup") || reasonText.includes("vwap")) {
    return "data ready (VWAP/ATR)";
  }
  if (reasonText.includes("stop_invalid")) {
    return "valid stop set";
  }
  if (reasonText.includes("atr_invalid")) {
    return "ATR valid";
  }
  if (reasonText.includes("data gap") || reasonText.includes("datafeed")) {
    return "fresh bars";
  }
  return "resolve hard block";
};

export function normalizeTelegramSnapshot(event: DomainEvent): TelegramSnapshot | null {
  const symbol = getSymbol(event);
  const dir = getDirection(event);
  if (!dir) return null;
  const conf = getTacticalConfidence(event);
  const risk = getRiskMode(event);
  const entryZone = getEntryZone(event);
  const stop = getStop(event);
  const targets = getTargets(event);
  const indicatorTf = event.data.marketState?.tacticalSnapshot?.indicatorTf ?? event.data.marketState?.tacticalBias?.indicatorTf ?? "1m";
  const decision = event.data.decision;
  const blockers = decision?.blockers ?? event.data.blockerTags ?? [];
  const blockerReasons = decision?.blockerReasons ?? event.data.blockerReasons ?? [];
  const hardBlockers = event.data.hardBlockers ?? decision?.hardBlockers ?? [];
  const softBlockers = event.data.softBlockers ?? decision?.softBlockers ?? [];
  const hardBlockerReasons = event.data.hardBlockerReasons ?? decision?.hardBlockerReasons ?? [];
  const softBlockerReasons = event.data.softBlockerReasons ?? decision?.softBlockerReasons ?? [];
  const reasons = [...blockerReasons, ...softBlockerReasons, ...hardBlockerReasons].map(normalizeReason);
  const warnTags = buildWarnTags(event, reasons, [...blockers, ...softBlockers]);
  const entryMode = deriveEntryMode(event, reasons, warnTags);
  const sizeMultiplier = deriveSizeMultiplier(warnTags);
  const armCondition = buildArmCondition(event, dir, reasons, warnTags);
  const why = buildWhy(event, dir, reasons);

  const timeCutoff = reasons.some((reason: string) => isTimeOfDayCutoff(reason));
  const hardBlocker =
    hardBlockers.length > 0 ||
    hardBlockerReasons.length > 0 ||
    isDataNotReady(event, reasons) ||
    timeCutoff ||
    reasons.some((reason: string) => isMarketUnavailable(reason)) ||
    blockers.includes("datafeed");

  if (event.type === "PLAY_ARMED" && entryZone && stop && targets) {
    if (hardBlocker) {
      return {
        type: "UPDATE",
        symbol,
        dir,
        conf,
        risk,
        update: {
          fromSide: dir,
          toSide: dir,
          emoji: timeCutoff ? "⏱️" : "⚠️",
          cause: timeCutoff ? "time cutoff" : "hard block active",
          next: timeCutoff ? "stop new entries" : "wait for readiness",
          ts: formatEtTimestamp(event.timestamp),
        },
      };
    }
    return {
      type: "SIGNAL",
      symbol,
      dir,
      conf,
      risk,
      entryTrigger: buildEntryTrigger(entryZone, dir),
      entryTriggerTf: indicatorTf,
      stop,
      invalidation: `${indicatorTf} close ${dir === "LONG" ? "<" : ">"} ${stop.toFixed(2)}`,
      tp1: targets.t1,
      tp2: targets.t2,
      sizeMultiplier,
      why,
      warnTags: warnTags.length ? warnTags : undefined,
    };
  }

  if (event.type === "SETUP_CANDIDATES") {
    // Explicitly internal-only: never emit Telegram alerts.
    return null;
  }

  if (event.type === "NO_ENTRY" || event.type === "LLM_VERIFY") {
    const hasEntryData = !!entryZone && !!stop && !!targets;
    if (hardBlocker) {
      if (timeCutoff) {
        return {
          type: "UPDATE",
          symbol,
          dir,
          conf,
          risk,
          update: {
            fromSide: dir,
            toSide: dir,
            emoji: "⏱️",
            cause: "time cutoff",
            next: "stop new entries",
            ts: formatEtTimestamp(event.timestamp),
          },
        };
      }
      return {
        type: "WATCH",
        symbol,
        dir,
        conf,
        risk,
        armCondition: buildHardArmCondition(hardBlockerReasons),
        entryRule: "pullback only (NO chase)",
        planStop: isFiniteNumber(stop) ? "use valid stop when armed" : "stop missing (needs valid stop)",
        why,
        warnTags: warnTags.length ? warnTags : ["DATA"],
      };
    }
    if (!hasEntryData) return null;

    const entryRule = warnTags.includes("RECLAIM") ? "reclaim only" : "pullback only (NO chase)";
    const planParts = ["patience", entryMode === "PULLBACK" ? "pullback entry" : "breakout entry"];
    if (warnTags.includes("RISK_ATR")) planParts.push("tight stop");
    const { vwap } = getIndicatorSnapshot(event);
    const planStop = isFiniteNumber(vwap)
      ? `${dir === "LONG" ? "below" : "above"} VWAP or last swing (auto when armed)`
      : "last swing (auto when armed)";
    return {
      type: "WATCH",
      symbol,
      dir,
      conf,
      risk,
      armCondition: armCondition ?? `retest ${entryZone.low.toFixed(2)}–${entryZone.high.toFixed(2)}`,
      entryRule,
      planStop,
      plan: planParts.join(", "),
      why,
      warnTags: warnTags.length ? warnTags : ["NONE"],
    };
  }

  if (event.type === "PLAY_CANCELLED" || event.type === "PLAY_CLOSED" || event.type === "PLAY_SIZED_UP") {
    const cause = event.data.reason ?? event.data.result ?? event.data.mode ?? "status update";
    const price = event.data.price ?? event.data.close ?? event.data.play?.entryPrice ?? event.data.entryPrice;
    const lastSignal = event.data.lastSignal ?? event.data.prevDirection ?? event.data.previousDirection ?? event.data.play?.direction;
    return {
      type: "UPDATE",
      symbol,
      dir,
      conf,
      risk,
      update: {
        fromSide: lastSignal === "LONG" || lastSignal === "SHORT" ? lastSignal : undefined,
        toSide: dir,
        emoji: "🔁",
        cause,
        next: "wait for new setup",
        ts: formatEtTimestamp(event.timestamp),
        price: isFiniteNumber(price) ? price : undefined,
        lastSignal: lastSignal ? String(lastSignal) : undefined,
      },
    };
  }

  return null;
}
