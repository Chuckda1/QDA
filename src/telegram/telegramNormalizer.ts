import type { DomainEvent } from "../types.js";

export type TelegramSnapshotType = "MIND";

import type { MinimalDebugInfo } from "../types.js";

export type TelegramSnapshot = {
  type: TelegramSnapshotType;
  symbol: string;
  price?: number;
  direction: string;
  confidence?: number;
  reason?: string;
  waitFor?: string | null;
  botState?: string;
  invalidation?: number;
  trigger?: string;
  ts?: string;
  debug?: MinimalDebugInfo;
  bias?: string;
  entryStatus?: string;
  refPrice?: number;
  refLabel?: string;
  expectedResolution?: string;
  setup?: string;
  setupTriggerPrice?: number;
  setupStopPrice?: number;
  setupDetectedAt?: number;
  lastBiasFlipTs?: number;
  noTradeDiagnostic?: {
    reasonCode: string;
    details: string;
    reasons?: string[]; // Human-readable reasons array
  };
  targetZones?: {
    rTargets?: { t1: number; t2: number; t3: number };
    atrTargets?: { t1: number; t2: number };
    magnetLevels?: {
      microLow?: number;
      majorLow?: number;
      microHigh?: number;
      majorHigh?: number;
      vwap?: number;
    };
    measuredMove?: number;
    expectedZone?: { lower: number; upper: number };
    expectedEnd?: number;
  };
  entryPrice?: number;
  stopPrice?: number;
  oppLatchedAt?: number; // Timestamp when opportunity was latched
  oppExpiresAt?: number; // Timestamp when opportunity expires
  last5mCloseTs?: number; // Timestamp of last 5m bar close
  source?: "1m" | "5m"; // Source of this state update (1m tick or 5m close)
};

export const formatEtTimestamp = (ts: number): string =>
  new Date(ts).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

export function normalizeTelegramSnapshot(event: DomainEvent): TelegramSnapshot | null {
  if (event.type !== "MIND_STATE_UPDATED") return null;
  const mind = event.data.mindState ?? {};
  const direction = mind.direction ?? "none";
  const confidence = Number.isFinite(mind.confidence) ? Math.round(mind.confidence) : undefined;
  const reason = typeof mind.reason === "string" ? mind.reason : undefined;
  const bias = mind.bias ?? undefined;
  const entryStatus = mind.entryStatus ?? undefined;
  const refPrice = Number.isFinite(mind.refPrice) ? Number(mind.refPrice) : undefined;
  const refLabel = typeof mind.refLabel === "string" ? mind.refLabel : undefined;
  const expectedResolution = mind.expectedResolution ?? undefined;
  const setup = mind.setup ?? undefined;
  const setupTriggerPrice = Number.isFinite(mind.setupTriggerPrice) ? Number(mind.setupTriggerPrice) : undefined;
  const setupStopPrice = Number.isFinite(mind.setupStopPrice) ? Number(mind.setupStopPrice) : undefined;
  const setupDetectedAt = Number.isFinite(mind.setupDetectedAt) ? Number(mind.setupDetectedAt) : undefined;
  const lastBiasFlipTs = Number.isFinite(mind.lastBiasFlipTs) ? Number(mind.lastBiasFlipTs) : undefined;
  const trigger = event.data.candidate?.entryTrigger;
  const invalidation = Number.isFinite(event.data.candidate?.invalidationLevel)
    ? Number(event.data.candidate?.invalidationLevel)
    : undefined;
  
  // Extract no-trade diagnostic if present (include blockers array)
  const noTradeDiagnostic = mind.noTradeDiagnostic ? {
    reasonCode: mind.noTradeDiagnostic.reasonCode,
    details: mind.noTradeDiagnostic.details,
    blockers: mind.noTradeDiagnostic.blockers ?? [],
    // Legacy support for old formatter
    reasons: getHumanReadableReasons(mind.noTradeDiagnostic.reasonCode, mind.noTradeDiagnostic),
  } : undefined;

  // Extract target zones if in trade
  const targetZones = mind.targetZones ?? undefined;
  const entryPrice = Number.isFinite(mind.entryPrice) ? Number(mind.entryPrice) : undefined;
  const stopPrice = Number.isFinite(mind.stopPrice) ? Number(mind.stopPrice) : undefined;
  
  // Extract opportunity timestamps
  const oppLatchedAt = Number.isFinite(mind.oppLatchedAt) ? Number(mind.oppLatchedAt) : undefined;
  const oppExpiresAt = Number.isFinite(mind.oppExpiresAt) ? Number(mind.oppExpiresAt) : undefined;
  const last5mCloseTs = Number.isFinite(mind.last5mCloseTs) ? Number(mind.last5mCloseTs) : undefined;
  const source = mind.source as "1m" | "5m" | undefined;

  return {
    type: "MIND",
    symbol: event.data.symbol,
    price: mind.price ?? event.data.price, // Use mindState price if available, fallback to event price
    direction,
    confidence,
    reason,
    waitFor: event.data.waitFor ?? null,
    botState: event.data.botState,
    invalidation,
    trigger,
    ts: formatEtTimestamp(event.timestamp),
    debug: event.data.debug,
    bias,
    entryStatus,
    refPrice,
    refLabel,
    expectedResolution,
    setup,
    setupTriggerPrice,
    setupStopPrice,
    setupDetectedAt,
    lastBiasFlipTs,
    noTradeDiagnostic,
    targetZones,
    entryPrice,
    stopPrice,
    oppLatchedAt,
    oppExpiresAt,
    last5mCloseTs,
    source,
  };
}

// Helper to convert reason codes to human-readable reasons
function getHumanReadableReasons(reasonCode: string, diagnostic: any): string[] {
  const reasons: string[] = [];
  
  switch (reasonCode) {
    case "NO_GATE_ARMED":
      reasons.push("No lower-high rejection candle");
      reasons.push("No EMA rejection");
      reasons.push("Structure not mature");
      break;
    case "GATE_EXPIRED":
      reasons.push("Continuation occurred before trigger");
      reasons.push("Move not chaseable");
      break;
    case "GATE_INVALIDATED":
      reasons.push("Structure broke against bias");
      reasons.push("No breakdown from consolidation");
      break;
    case "AWAITING_PULLBACK_COMPLETION":
      reasons.push("Awaiting pullback completion");
      reasons.push("Gate armed, awaiting trigger price");
      break;
    case "SESSION_CONSTRAINT":
      reasons.push("Market closed or outside trading hours");
      break;
    case "NO_REJECTION_CANDLE":
      reasons.push("No rejection candle at key level");
      break;
    case "EMA_NOT_REJECTED":
      reasons.push("No EMA rejection");
      break;
    case "STRUCTURE_INTACT":
      reasons.push("Structure intact - no breakdown");
      break;
    case "RR_UNFAVORABLE":
      reasons.push("Risk > Reward unfavorable");
      break;
    default:
      reasons.push(diagnostic.details || "Awaiting setup completion");
  }
  
  return reasons;
}
