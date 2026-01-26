import type { Bias, Direction, DomainEvent } from "../types.js";
import { getDecisionState } from "../utils/decisionState.js";
import { volumePolicy } from "../utils/volumePolicy.js";

export type TelegramSnapshotType = "SIGNAL" | "WATCH" | "UPDATE" | "MANAGE" | "MIND";

export type TelegramSnapshot = {
  type: TelegramSnapshotType;
  symbol: string;
  dir: Direction;
  conf?: number;
  risk: string;
  px?: number;
  ts?: string;
  mode?: string;
  modeState?: string;
  volumeLine?: string;
  status?: "WATCH" | "SIGNAL";
  blockedBy?: string[];
  gates?: string;
  volumeRetestOk?: boolean;
  mindState?: Record<string, any>;
  thesis?: { direction?: string | null; confidence?: number | null };
  botState?: string;
  waitFor?: string | null;
  sessionRegime?: string;
  indicators?: Record<string, any>;
  formingProgress?: number | null;
  lastClosed5mTs?: string;
  lastClosed5mBar?: { ts: number; open: number; high: number; low: number; close: number; volume: number } | null;
  levels?: { entry: number | null; stop: number | null; targets: number[] };
  entry?: number | null;
  targets?: number[] | null;
  extras?: { rsi14_5m?: number | null; atr14_5m?: number | null; relVol5m?: number | null };
  rangeBias?: { bias: Bias; confidence?: number; note?: string };
  range?: {
    low: number;
    high: number;
    vwap?: number;
    price?: number;
    ts?: string;
    contextRange?: { low: number; high: number };
    microBox?: { low: number; high: number };
    buffer?: number;
    atr1m?: number;
    activeSide?: "LONG_ONLY" | "SHORT_ONLY" | "NONE";
    location?: { zone: "LOW" | "MID" | "HIGH"; pos: number };
    longArm?: string;
    longEntry?: string;
    shortArm?: string;
    shortEntry?: string;
    stopAnchor?: string;
    mode?: string;
    note?: string;
  };
  entryTrigger?: string;
  entryTriggerTf?: string;
  stop?: number;
  invalidation?: string;
  tp1?: number;
  tp2?: number;
  sizeMultiplier?: number;
  entryMode?: "MOMENTUM" | "PULLBACK";
  chaseAllowed?: boolean;
  why?: string;
  warnTags?: string[];
  armCondition?: string;
  entryRule?: string;
  planStop?: string;
  plan?: string;
  next?: string;
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

const getPrice = (event: DomainEvent): number | undefined => {
  const px =
    event.data.price ??
    event.data.close ??
    event.data.entryPrice ??
    event.data.candidate?.triggerPrice ??
    event.data.topPlay?.triggerPrice ??
    event.data.play?.entryPrice;
  return isFiniteNumber(px) ? px : undefined;
};

const buildGatesLine = (event: DomainEvent): string | undefined => {
  const gates: string[] = [];
  const volume = event.data.volume;
  if (volume) {
    const rel = Number.isFinite(volume.relVol) ? volume.relVol.toFixed(2) : "n/a";
    const regime = volume.regime ?? volume.label ?? "UNKNOWN";
    gates.push(`relVol=${rel} ${regime}`);
    if (Number.isFinite(volume.confirmBarsRequired)) {
      const closes = Number.isFinite(volume.closesMet) ? volume.closesMet : 0;
      gates.push(`closes=${closes}/${volume.confirmBarsRequired}`);
    }
    if (volume.requiresRetest) {
      gates.push(`retest=${volume.retestOk ? "ok" : "no"}`);
    }
  }
  return gates.length ? `GATES: ${gates.join(", ")}` : undefined;
};

const buildDataStaleUpdate = (event: DomainEvent, decisionState?: string): TelegramSnapshot | null => {
  if (!decisionState || !["WATCH", "SIGNAL"].includes(decisionState)) return null;
  const dataTs =
    typeof event.data.lastBarTs === "number"
      ? event.data.lastBarTs
      : typeof event.data.barTs === "number"
      ? event.data.barTs
      : event.timestamp;
  const ageMs = Date.now() - dataTs;
  const barTf = event.data.barTf;
  const defaultStaleAfterMs = barTf === "5m" ? 6 * 60 * 1000 : 90_000;
  const staleAfterMs = typeof event.data.staleAfterMs === "number" ? event.data.staleAfterMs : defaultStaleAfterMs;
  if (!Number.isFinite(ageMs) || ageMs <= staleAfterMs) return null;
  const symbol = getSymbol(event);
  const dir = getDirection(event) ?? "LONG";
  const risk = getRiskMode(event);
  const px = getPrice(event);
  const ts = formatEtTimestamp(Date.now());
  const ageSec = Math.round(ageMs / 1000);
  return {
    type: "UPDATE",
    symbol,
    dir,
    risk,
    px,
    ts,
    update: {
      cause: `data stale (${ageSec}s)`,
      next: "wait for fresh bars",
      ts,
      price: px,
    },
  };
};

const buildNextLine = (event: DomainEvent, reasons: string[], warnTags: string[]): string | undefined => {
  const gateStatus = event.data.gateStatus as { pendingGate?: string; blockedReasons?: string[]; metrics?: { distToVwapAtr?: number } } | undefined;
  if (gateStatus?.pendingGate) {
    return gateStatus.pendingGate;
  }
  if (gateStatus?.blockedReasons && gateStatus.blockedReasons.length > 1) {
    const top = gateStatus.blockedReasons.slice(0, 3).map(normalizeReason);
    return `BLOCKED_BY: ${top.join(" | ")}`;
  }
  const pullbackMatch = reasons
    .map((reason) => reason.match(/Pullback depth\s+([\d.]+)\s+is less than minimum\s+([\d.]+)/i))
    .find(Boolean);
  if (pullbackMatch) {
    const current = pullbackMatch[1];
    const min = pullbackMatch[2];
    return `pullback depth >= ${min} ATR (now ${current})`;
  }

  if (reasons.some((reason) => /No reclaim signal/i.test(reason))) {
    return "waiting on reclaim signal";
  }

  const distToVwap = gateStatus?.metrics?.distToVwapAtr ?? getDistToVwapAtr(event);
  if (warnTags.includes("EXTENDED") && isFiniteNumber(distToVwap)) {
    return `distance_to_VWAP <= ${REARM_VWAP_ATR} ATR (now ${distToVwap.toFixed(2)})`;
  }

  return undefined;
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

const buildContractViolationUpdate = (params: {
  event: DomainEvent;
  symbol: string;
  dir: Direction;
  conf?: number;
  risk: string;
  reason: string;
}): TelegramSnapshot => {
  console.error(
    `[TELEGRAM] contract violation: ${params.reason} type=${params.event.type} symbol=${params.symbol}`
  );
  const ts = formatEtTimestamp(params.event.timestamp);
  return {
    type: "UPDATE",
    symbol: params.symbol,
    dir: params.dir,
    conf: params.conf,
    risk: params.risk,
    px: getPrice(params.event),
    ts,
    update: {
      cause: `contract violation: ${params.reason}`,
      next: "fix event payload",
      ts,
      price: params.event.data.price ?? params.event.data.close ?? params.event.data.entryPrice,
    },
  };
};

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
  const clause = match[0]
    .replace(/Re-arm\s*when\s*/i, "")
    .replace(/Re-arm\s*/i, "")
    .replace(/\.$/, "")
    .trim();
  if (/distance_to_vwap\s*<=\s*0(\.0+)?/i.test(clause)) return undefined;
  return clause;
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
  const candidateFlags = new Set([
    ...(event.data.candidate?.warningFlags ?? []),
    ...(event.data.candidate?.flags ?? [])
  ]);
  if (isExtendedFromMean(event, reasons)) tags.push("EXTENDED");
  if (reasons.some((reason) => /RISK_CAP/i.test(reason))) tags.push("RISK_ATR");
  if (reasons.some((reason) => /No reclaim signal/i.test(reason))) tags.push("RECLAIM");
  if (reasons.some((reason) => /cooldown/i.test(reason))) tags.push("COOLDOWN");
  if (reasons.some((reason) => /LOW_CONTEXT/i.test(reason))) tags.push("LOW_CONTEXT");
  if (reasons.some((reason) => /TRANSITION_LOCK|SHOCK/i.test(reason))) tags.push("TRANSITION");
  if (reasons.some((reason) => /TIMEFRAME_CONFLICT/i.test(reason))) tags.push("TF_CONFLICT");
  if (reasons.some((reason) => /LOW_CANDIDATE_DENSITY/i.test(reason))) tags.push("LOW_DENSITY");
  if (isDataNotReady(event, reasons)) tags.push("DATA");
  if (candidateFlags.has("LOW_VOL")) tags.push("LOW_VOL");
  if (candidateFlags.has("THIN_TAPE")) tags.push("THIN_TAPE");
  if (candidateFlags.has("VOL_SPIKE")) tags.push("VOL_SPIKE");
  if (candidateFlags.has("CLIMAX_VOL")) tags.push("CLIMAX_VOL");

  for (const blocker of blockers) {
    if (blocker === "guardrail") tags.push("GUARDRAIL");
    if (blocker === "cooldown") tags.push("COOLDOWN");
    if (blocker === "entry_filter" && !tags.includes("EXTENDED")) tags.push("ENTRY_FILTER");
  }

  const extraTags = Array.isArray(event.data.warnTags) ? event.data.warnTags.filter((tag) => typeof tag === "string") : [];
  return unique([...tags, ...extraTags]);
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
  if (warnTags.includes("LOW_VOL")) multiplier = Math.min(multiplier, 0.5);
  if (warnTags.includes("THIN_TAPE")) multiplier = Math.min(multiplier, 0.25);
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

  const cleaned = parts.filter((part) => !/distance_to_vwap\s*<=\s*0(\.0+)?/i.test(part));
  return cleaned.length ? unique(cleaned).join(" OR ") : undefined;
};

const buildPlanStop = (dir: Direction, stop?: number, vwap?: number): string => {
  if (isFiniteNumber(stop)) return `use ${stop.toFixed(2)} as stop when armed`;
  if (isFiniteNumber(vwap)) return `${dir === "LONG" ? "below" : "above"} VWAP (auto when armed)`;
  return "last swing (auto when armed)";
};

const buildWhy = (event: DomainEvent, dir: Direction, reasons: string[], warnTags: string[]): string => {
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

  if (warnTags.includes("THIN_TAPE")) {
    whyParts.push("thin tape: low participation");
  } else if (warnTags.includes("LOW_VOL")) {
    whyParts.push("low participation");
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
  const dir = getDirection(event) ?? (event.type === "MIND_STATE_UPDATED" ? "LONG" : undefined);
  const decisionState = getDecisionState(event);
  if (!dir) return null;
  let conf = getTacticalConfidence(event);
  const risk = getRiskMode(event);
  const entryZone = getEntryZone(event);
  const stop = getStop(event);
  const targets = getTargets(event);
  const indicatorTf = event.data.marketState?.tacticalSnapshot?.indicatorTf ?? event.data.marketState?.tacticalBias?.indicatorTf ?? "1m";
  const { vwap } = getIndicatorSnapshot(event);
  const decision = event.data.decision;
  const blockers = decision?.blockers ?? event.data.blockerTags ?? [];
  const blockerReasons = decision?.blockerReasons ?? event.data.blockerReasons ?? [];
  const hardBlockers = event.data.hardBlockers ?? decision?.hardBlockers ?? [];
  const softBlockers = event.data.softBlockers ?? decision?.softBlockers ?? [];
  const hardBlockerReasons = event.data.hardBlockerReasons ?? decision?.hardBlockerReasons ?? [];
  const softBlockerReasons = event.data.softBlockerReasons ?? decision?.softBlockerReasons ?? [];
  const hardStopBlockers = event.data.hardStopBlockers ?? decision?.hardStopBlockers ?? [];
  const hardWaitBlockers = event.data.hardWaitBlockers ?? decision?.hardWaitBlockers ?? [];
  const hardStopReasons = event.data.hardStopReasons ?? decision?.hardStopReasons ?? [];
  const hardWaitReasons = event.data.hardWaitReasons ?? decision?.hardWaitReasons ?? [];
  const staleUpdate = buildDataStaleUpdate(event, decisionState);
  if (staleUpdate) {
    return staleUpdate;
  }
  const reasons = [...blockerReasons, ...softBlockerReasons, ...hardBlockerReasons, ...hardStopReasons, ...hardWaitReasons].map(normalizeReason);
  const warnTags = buildWarnTags(event, reasons, [...blockers, ...softBlockers]);
  const entryMode = deriveEntryMode(event, reasons, warnTags);
  const sizeMultiplier = deriveSizeMultiplier(warnTags);
  const armCondition = buildArmCondition(event, dir, reasons, warnTags);
  const why = buildWhy(event, dir, reasons, warnTags);
  const relVol = event.data.candidate?.featureBundle?.volume?.relVolume;
  const structure = event.data.marketState?.regime?.structure;
  const structureAligned =
    (dir === "LONG" && structure === "BULLISH") || (dir === "SHORT" && structure === "BEARISH");
  if (warnTags.includes("THIN_TAPE") && conf !== undefined) {
    conf = Math.min(conf, 70);
  } else if (warnTags.includes("LOW_VOL") && conf !== undefined) {
    conf = Math.min(conf, 85);
  }
  if (warnTags.includes("CLIMAX_VOL") && conf !== undefined && !structureAligned) {
    conf = Math.min(conf, 90);
  }
  if (conf !== undefined && conf >= 100 && relVol !== undefined && relVol < 0.9) {
    conf = 95;
  }
  const px = getPrice(event);
  const ts = formatEtTimestamp(event.timestamp);
  const next = buildNextLine(event, reasons, warnTags);
  const blockedBy = event.data.gateStatus?.blockedReasons?.slice(0, 3);
  const gatesLine = buildGatesLine(event);
  const chaseAllowed = entryMode === "MOMENTUM" && !warnTags.includes("EXTENDED") && !warnTags.includes("RISK_ATR");
  let volumeLine = typeof event.data.volume?.line === "string" ? event.data.volume.line : undefined;
  if (!volumeLine && relVol !== undefined) {
    const policy = volumePolicy(relVol);
    const suffix = policy.requiresRetest ? " + retest" : policy.allowOneBarBreakout ? " ok" : "";
    volumeLine = `${policy.label} (${relVol.toFixed(2)}x) → ${policy.confirmBarsRequired} closes${suffix}`;
  }

  if (event.type === "VOLUME_UPDATE") {
    const update = event.data.update ?? {};
    const cause = update.cause ?? `volume ${event.data.volume?.label ?? event.data.volume?.regime ?? "update"}`;
    const nextLine = update.next ?? "confirm with price + volume";
    return {
      type: "UPDATE",
      symbol,
      dir,
      conf,
      risk,
      px,
      ts,
      modeState: event.data.modeState,
      update: {
        cause,
        next: nextLine,
        ts,
        price: event.data.price ?? event.data.close ?? event.data.entryPrice,
      },
    };
  }

  if (event.type === "SESSION_UPDATE") {
    const update = event.data ?? {};
    const cause = `SESSION MODE: ${update.sessionRegime ?? "UNKNOWN"}`;
    const nextLine = update.note ?? "monitor session";
    return {
      type: "UPDATE",
      symbol,
      dir: dir ?? "LONG",
      conf,
      risk,
      px,
      ts,
      modeState: event.data.modeState,
      update: {
        cause,
        next: nextLine,
        ts,
        price: event.data.price ?? event.data.close ?? event.data.entryPrice,
      },
    };
  }

  if (event.type === "MIND_STATE_UPDATED") {
    const lastClosed5mTs =
      typeof event.data.lastClosed5mTs === "number" ? formatEtTimestamp(event.data.lastClosed5mTs) : undefined;
    const formingProgress =
      Number.isFinite(event.data.formingProgress) ? Number(event.data.formingProgress) : undefined;
    const levels = event.data.mindState?.levels ?? event.data.levels;
    const lastClosed5mBar =
      event.data.lastClosed5mBar && typeof event.data.lastClosed5mBar === "object"
        ? event.data.lastClosed5mBar
        : undefined;
    return {
      type: "MIND",
      symbol,
      dir,
      risk,
      px,
      ts,
      mode: event.data.mode,
      mindState: event.data.mindState,
      thesis: event.data.thesis,
      botState: event.data.botState,
      waitFor: event.data.waitFor,
      sessionRegime: event.data.sessionRegime,
      formingProgress,
      lastClosed5mTs,
      lastClosed5mBar,
      levels,
      entry: event.data.entry ?? event.data.entryPrice,
      stop: event.data.stop ?? event.data.stopPrice,
      targets: Array.isArray(event.data.targets) ? event.data.targets : undefined,
      extras: event.data.extras,
    };
  }

  if (event.type === "PREMARKET_UPDATE") {
    const premarket = event.data.premarket ?? {};
    const kind = premarket.kind ?? "PREMARKET_UPDATE";
    const bias = premarket.bias ?? "NEUTRAL";
    const levels = premarket.levels ?? "levels n/a";
    const confText = Number.isFinite(premarket.confidence) ? ` (${Math.round(premarket.confidence)}%)` : "";
    const arm = premarket.arm ? ` | arm ${premarket.arm}` : "";
    return {
      type: "UPDATE",
      symbol,
      dir,
      conf,
      risk,
      px,
      ts,
      modeState: event.data.modeState,
      volumeLine,
      update: {
        cause: `${kind === "PREMARKET_BRIEF" ? "premarket brief" : "premarket bias"} ${bias}${confText}`,
        next: `levels ${levels}${arm}`,
        ts,
        price: event.data.price,
      },
    };
  }

  if (event.type === "LLM_COACH_UPDATE") {
    const action = event.data.action ?? "MANAGE";
    const urgency = event.data.urgency ? ` (${event.data.urgency})` : "";
    const nextCheck = event.data.nextCheck ? `next check ${event.data.nextCheck}` : "monitor for exits";
    return {
      type: "MANAGE",
      symbol,
      dir,
      conf,
      risk,
      px,
      ts,
      modeState: event.data.modeState,
      warnTags: warnTags.length ? warnTags : undefined,
      update: {
        cause: `LLM ${action}${urgency}`,
        next: nextCheck,
        ts,
        price: event.data.price ?? event.data.close ?? event.data.entryPrice,
        lastSignal: dir,
      },
    };
  }

  const timeCutoff =
    reasons.some((reason: string) => isTimeOfDayCutoff(reason)) ||
    hardStopReasons.some((reason: string) => isTimeOfDayCutoff(reason));
  const hardBlocker =
    hardBlockers.length > 0 ||
    hardStopBlockers.length > 0 ||
    hardWaitBlockers.length > 0 ||
    hardBlockerReasons.length > 0 ||
    hardStopReasons.length > 0 ||
    hardWaitReasons.length > 0 ||
    isDataNotReady(event, reasons) ||
    timeCutoff ||
    reasons.some((reason: string) => isMarketUnavailable(reason)) ||
    blockers.includes("datafeed");

  if (event.type === "PLAY_ARMED" && entryZone && stop && targets) {
    if (hardBlocker) {
      if (timeCutoff) {
        return {
          type: "UPDATE",
          symbol,
          dir,
          conf,
          risk,
          px,
          ts,
          update: {
            emoji: "⏱️",
            cause: "time cutoff",
            next: "stop new entries",
            ts,
            price: px,
          },
        };
      }
      return {
        type: "UPDATE",
        symbol,
        dir,
        conf,
        risk,
        px,
        ts,
        update: {
          emoji: timeCutoff ? "⏱️" : "⚠️",
          cause: timeCutoff ? "time cutoff" : "hard block active",
          next: timeCutoff ? "stop new entries" : "wait for readiness",
          ts,
          price: px,
        },
      };
    }
    return {
      type: "SIGNAL",
      symbol,
      dir,
      conf,
      risk,
      px,
      ts,
      volumeLine,
      entryTrigger: buildEntryTrigger(entryZone, dir),
      entryTriggerTf: indicatorTf,
      stop,
      invalidation: `${indicatorTf} close ${dir === "LONG" ? "<" : ">"} ${stop.toFixed(2)}`,
      tp1: targets.t1,
      tp2: targets.t2,
      sizeMultiplier,
      entryMode,
      chaseAllowed,
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
    const readinessMissing = hardWaitBlockers.length > 0 || hardWaitReasons.length > 0;
    const rangePayload = event.data.range;
    if (rangePayload && event.type === "NO_ENTRY") {
      const rangeTs =
        typeof rangePayload.ts === "number"
          ? formatEtTimestamp(rangePayload.ts)
          : typeof rangePayload.ts === "string"
          ? rangePayload.ts
          : ts;
      const rangeBias = rangePayload.bias;
      const bias = rangeBias?.bias ?? (rangePayload.mode === "TIGHT" ? "NEUTRAL" : undefined);
      const biasConf = rangeBias?.confidence ?? (bias ? 50 : conf);
      return {
        type: "WATCH",
        symbol,
        dir,
        conf,
        risk,
        volumeLine,
        status: decisionState === "SIGNAL" ? "SIGNAL" : "WATCH",
        blockedBy,
        gates: gatesLine,
        volumeRetestOk: event.data.volume?.retestOk,
        px: isFiniteNumber(rangePayload.price) ? rangePayload.price : px,
        ts: rangeTs,
        modeState: event.data.modeState,
        rangeBias: bias
          ? {
              bias,
              confidence: biasConf,
              note: rangeBias?.note,
            }
          : undefined,
        range: {
          low: rangePayload.low,
          high: rangePayload.high,
          vwap: rangePayload.vwap,
          price: isFiniteNumber(rangePayload.price) ? rangePayload.price : px,
          ts: rangeTs,
          contextRange: rangePayload.contextRange
            ? { low: rangePayload.contextRange.low, high: rangePayload.contextRange.high }
            : undefined,
          microBox: rangePayload.microBox
            ? { low: rangePayload.microBox.low, high: rangePayload.microBox.high }
            : undefined,
          buffer: Number.isFinite(rangePayload.buffer) ? rangePayload.buffer : undefined,
          atr1m: Number.isFinite(rangePayload.atr1m) ? rangePayload.atr1m : undefined,
          activeSide: rangePayload.activeSide,
          location: rangePayload.location,
          longArm: rangePayload.longArm,
          longEntry: rangePayload.longEntry,
          shortArm: rangePayload.shortArm,
          shortEntry: rangePayload.shortEntry,
          stopAnchor: rangePayload.stopAnchor,
          mode: rangePayload.mode,
          note: rangePayload.note,
        },
        warnTags: Array.isArray(event.data.rangeWarnTags)
          ? event.data.rangeWarnTags.filter((tag: unknown) => typeof tag === "string")
          : warnTags,
      };
    }
    if (decisionState === "UPDATE" || (hardBlocker && timeCutoff)) {
      if (timeCutoff) {
        return {
          type: "UPDATE",
          symbol,
          dir,
          conf,
          risk,
          px,
          ts,
          update: {
            emoji: "⏱️",
            cause: "time cutoff",
            next: "stop new entries",
            ts,
            price: px,
          },
        };
      }
    }
    if (hardBlocker) {
      const hardArmReasons = [...hardStopReasons, ...hardWaitReasons, ...hardBlockerReasons];
      const hardArm = hardArmReasons.length ? buildHardArmCondition(hardArmReasons) : undefined;
      if (readinessMissing) {
        return {
          type: "UPDATE",
          symbol,
          dir,
          conf,
          risk,
          px,
          ts,
          update: {
            cause: "readiness not met",
            next: "wait for data readiness",
            ts,
            price: event.data.price ?? event.data.close ?? event.data.entryPrice,
          },
        };
      }
      if (!hardArm) {
        return buildContractViolationUpdate({
          event,
          symbol,
          dir,
          conf,
          risk,
          reason: "missing hard arm condition",
        });
      }
      return {
        type: "WATCH",
        symbol,
        dir,
        conf,
        risk,
        volumeLine,
        status: "WATCH",
        blockedBy,
        gates: gatesLine,
        volumeRetestOk: event.data.volume?.retestOk,
        px,
        ts,
        armCondition: hardArm,
        entryRule: "pullback only (NO chase)",
        planStop: buildPlanStop(dir, stop, vwap),
        next,
        why,
        warnTags: warnTags.length ? warnTags : ["DATA"],
      };
    }
    if (decisionState === "WATCH") {
      const derivedArm = armCondition ?? (entryZone ? `retest ${entryZone.low.toFixed(2)}–${entryZone.high.toFixed(2)}` : undefined);
      if (!derivedArm) {
        if (readinessMissing) {
          return {
            type: "UPDATE",
            symbol,
            dir,
            conf,
            risk,
            px,
            ts,
            update: {
              cause: "readiness not met",
              next: "wait for data readiness",
              ts,
              price: event.data.price ?? event.data.close ?? event.data.entryPrice,
            },
          };
        }
        return buildContractViolationUpdate({
          event,
          symbol,
          dir,
          conf,
          risk,
          reason: "missing arm condition",
        });
      }
      return {
        type: "WATCH",
        symbol,
        dir,
        conf,
        risk,
        volumeLine,
        status: "WATCH",
        blockedBy,
        gates: gatesLine,
        volumeRetestOk: event.data.volume?.retestOk,
        px,
        ts,
        armCondition: derivedArm,
        entryRule: "pullback only (NO chase)",
        planStop: buildPlanStop(dir, stop, vwap),
        next,
        why,
        warnTags: warnTags.length ? warnTags : ["DATA"],
      };
    }
    if (!hasEntryData) return null;

    const entryRule = warnTags.includes("RECLAIM") ? "reclaim only" : "pullback only (NO chase)";
    const planParts = ["patience", entryMode === "PULLBACK" ? "pullback entry" : "breakout entry"];
    if (warnTags.includes("RISK_ATR")) planParts.push("tight stop");
    const planStop = isFiniteNumber(vwap)
      ? `${dir === "LONG" ? "below" : "above"} VWAP or last swing (auto when armed)`
      : "last swing (auto when armed)";
    const derivedArm = armCondition ?? `retest ${entryZone.low.toFixed(2)}–${entryZone.high.toFixed(2)}`;
    if (!derivedArm) {
      if (readinessMissing) {
        return {
          type: "UPDATE",
          symbol,
          dir,
          conf,
          risk,
          update: {
            cause: "readiness not met",
            next: "wait for data readiness",
            ts: formatEtTimestamp(event.timestamp),
            price: event.data.price ?? event.data.close ?? event.data.entryPrice,
          },
        };
      }
      return buildContractViolationUpdate({
        event,
        symbol,
        dir,
        conf,
        risk,
        reason: "missing arm condition",
      });
    }
    return {
      type: "WATCH",
      symbol,
      dir,
      conf,
      risk,
      volumeLine,
      status: decisionState === "SIGNAL" ? "SIGNAL" : "WATCH",
      blockedBy,
      gates: gatesLine,
      volumeRetestOk: event.data.volume?.retestOk,
      px,
      ts,
      armCondition: derivedArm,
      entryRule,
      planStop,
      plan: planParts.join(", "),
      next,
      why,
      warnTags: warnTags.length ? warnTags : ["NONE"],
    };
  }

  if (decisionState === "MANAGE") {
    const manageCause = event.data.reason ?? event.data.result ?? event.data.mode ?? "manage active play";
    const manageNext = event.data.next ?? "monitor for exits";
    return {
      type: "MANAGE",
      symbol,
      dir,
      conf,
      risk,
      px,
      ts,
      warnTags: warnTags.length ? warnTags : undefined,
      update: {
        fromSide: dir,
        toSide: dir,
        cause: manageCause,
        next: manageNext,
        ts,
        price: event.data.price ?? event.data.close ?? event.data.entryPrice,
        lastSignal: dir,
      },
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
      px,
      ts,
      update: {
        fromSide: lastSignal === "LONG" || lastSignal === "SHORT" ? lastSignal : undefined,
        toSide: dir,
        emoji: "🔁",
        cause,
        next: "wait for new setup",
        ts,
        price: isFiniteNumber(price) ? price : undefined,
        lastSignal: lastSignal ? String(lastSignal) : undefined,
      },
    };
  }

  return null;
}
