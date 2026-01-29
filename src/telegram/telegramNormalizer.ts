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
};

const formatEtTimestamp = (ts: number): string =>
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
  const trigger = event.data.candidate?.entryTrigger;
  const invalidation = Number.isFinite(event.data.candidate?.invalidationLevel)
    ? Number(event.data.candidate?.invalidationLevel)
    : undefined;

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
  };
}
