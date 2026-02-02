import type { TelegramSnapshot } from "./telegramNormalizer.js";
import { formatEtTimestamp } from "./telegramNormalizer.js";

export type TelegramAlert = {
  type: "MIND";
  lines: string[];
  text: string;
};

const formatPrice = (value?: number): string => (Number.isFinite(value) ? (value as number).toFixed(2) : "n/a");

// Helper to get emoji based on bias
function getBiasEmoji(bias?: string): string {
  if (bias === "BEARISH") return "🔴";
  if (bias === "BULLISH") return "🟢";
  return "⚪";
}

// Helper to get emoji for phase (no-trade/patience zone)
function getPhaseEmoji(phase?: string): string {
  const patiencePhases = ["PULLBACK_IN_PROGRESS", "CONSOLIDATION_AFTER_REJECTION", "REENTRY_WINDOW", "BIAS_ESTABLISHED"];
  if (phase && patiencePhases.includes(phase)) return "🟨";
  return "⚪";
}

// Helper to get emoji for entry status
function getEntryEmoji(entryStatus?: string): string {
  if (entryStatus === "active") return "🟢";
  if (entryStatus === "blocked") return "🔴";
  return "⚪";
}

// Helper to get emoji for expected resolution
function getExpectedEmoji(expectedResolution?: string, bias?: string): string {
  if (expectedResolution === "CONTINUATION") {
    return bias === "BEARISH" ? "🔻" : "🔺";
  }
  if (expectedResolution === "FAILURE") {
    return bias === "BEARISH" ? "🔺" : "🔻";
  }
  return "⚪";
}

export function buildTelegramAlert(snapshot: TelegramSnapshot): TelegramAlert | null {
  if (snapshot.type !== "MIND") return null;
  const price = formatPrice(snapshot.price);
  const conf = Number.isFinite(snapshot.confidence) ? `${snapshot.confidence}%` : "n/a";
  const waitFor = snapshot.trigger ?? snapshot.waitFor ?? "n/a";
  const invalidation = Number.isFinite(snapshot.invalidation)
    ? `INVALIDATION: ${formatPrice(snapshot.invalidation)}`
    : undefined;

  const biasLabel = snapshot.bias ? `${snapshot.bias}` : (snapshot.direction !== "none" ? snapshot.direction.toUpperCase() : "NEUTRAL");
  const biasEmoji = getBiasEmoji(snapshot.bias);
  const phaseEmoji = getPhaseEmoji(snapshot.botState);
  const entryEmoji = getEntryEmoji(snapshot.entryStatus);
  const expectedEmoji = getExpectedEmoji(snapshot.expectedResolution, snapshot.bias);
  
  const refPrice = formatPrice(snapshot.refPrice);
  const refLine = snapshot.refPrice && snapshot.refLabel 
    ? `${biasEmoji} REF: ${refPrice} (${snapshot.refLabel})`
    : undefined;
  
  // Format expected resolution with emoji
  let expectedLine: string | undefined;
  if (snapshot.expectedResolution) {
    const expectedText = snapshot.expectedResolution === "CONTINUATION" 
      ? (snapshot.bias === "BEARISH" ? "Continuation down" : "Continuation up")
      : snapshot.expectedResolution === "FAILURE"
      ? (snapshot.bias === "BEARISH" ? "Pullback failure → continuation down" : "Pullback failure → continuation up")
      : snapshot.expectedResolution;
    expectedLine = `${expectedEmoji} EXPECTATION: ${expectedText}`;
  }

  // Format setup with emoji
  const setupEmoji = snapshot.setup && snapshot.setup !== "NONE" ? "🎯" : "⚪";
  const setupLine = snapshot.setup 
    ? `${setupEmoji} SETUP: ${snapshot.setup}${snapshot.setupTriggerPrice ? ` (trigger: ${formatPrice(snapshot.setupTriggerPrice)})` : ""}`
    : undefined;
  
  // Format entry status with trigger info
  const entryLine = snapshot.setup && snapshot.setup !== "NONE" && snapshot.setupTriggerPrice
    ? `${entryEmoji} ENTRY: WAITING (trigger: ${formatPrice(snapshot.setupTriggerPrice)})`
    : `${entryEmoji} ENTRY: ${snapshot.entryStatus === "active" ? "ACTIVE" : snapshot.entryStatus === "blocked" ? "BLOCKED" : "NONE"}`;

  const lines = [
    `${biasEmoji} PRICE: ${price}`, // Always first with bias emoji
    refLine, // Reference price if available
    `${biasEmoji} BIAS: ${biasLabel} (${conf})`,
    `${phaseEmoji} PHASE: ${snapshot.botState ?? "n/a"}`,
    setupLine, // Setup type if available
    entryLine, // Entry status
    snapshot.reason ? `NOTE: ${snapshot.reason}` : undefined,
    expectedLine, // Expected resolution if available
    invalidation,
    `⏳ WAITING FOR: ${waitFor}`,
  ].filter(Boolean) as string[];
  
  // If no setup, add explicit message
  if (snapshot.setup === "NONE" || (!snapshot.setup && snapshot.entryStatus !== "active")) {
    lines.push("⚪ SETUP: NONE");
    lines.push("🚫 NO TRADE — structure incomplete");
  }
  
  // Add no-trade diagnostic if present
  if (snapshot.noTradeDiagnostic && snapshot.noTradeDiagnostic.reasons && snapshot.noTradeDiagnostic.reasons.length > 0) {
    lines.push(""); // Blank line separator
    lines.push("🚫 NO TRADE FIRED");
    lines.push("Reason:");
    snapshot.noTradeDiagnostic.reasons.forEach(reason => {
      lines.push(`• ${reason}`);
    });
  }

  // Add timestamps for debugging (if available)
  if (snapshot.oppLatchedAt || snapshot.oppExpiresAt || snapshot.last5mCloseTs || snapshot.source) {
    const timestampLines: string[] = [];
    if (snapshot.source) {
      timestampLines.push(`📡 SOURCE: ${snapshot.source.toUpperCase()}`);
    }
    if (snapshot.last5mCloseTs) {
      const last5mCloseTime = formatEtTimestamp(snapshot.last5mCloseTs);
      timestampLines.push(`🕐 LAST 5M CLOSE: ${last5mCloseTime}`);
    }
    if (snapshot.oppLatchedAt) {
      const latchedTime = formatEtTimestamp(snapshot.oppLatchedAt);
      timestampLines.push(`🔒 OPP LATCHED: ${latchedTime}`);
    }
    if (snapshot.oppExpiresAt) {
      const expiresTime = formatEtTimestamp(snapshot.oppExpiresAt);
      const timeUntilExpiry = snapshot.oppExpiresAt - Date.now();
      const minutesUntilExpiry = Math.floor(timeUntilExpiry / (60 * 1000));
      timestampLines.push(`⏰ OPP EXPIRES: ${expiresTime} (${minutesUntilExpiry > 0 ? `in ${minutesUntilExpiry}m` : 'expired'})`);
    }
    if (timestampLines.length > 0) {
      lines.push(""); // Blank line separator
      lines.push(...timestampLines);
    }
  }

  // Add target zones if in trade
  if (snapshot.entryStatus === "active" && snapshot.entryPrice && snapshot.stopPrice && snapshot.targetZones) {
    const risk = Math.abs(snapshot.entryPrice - snapshot.stopPrice);
    const riskStr = risk.toFixed(2);
    
    lines.push(""); // Blank line separator
    lines.push(`📊 ENTRY: ${formatPrice(snapshot.entryPrice)} STOP: ${formatPrice(snapshot.stopPrice)} (R=${riskStr})`);
    
    // R targets
    if (snapshot.targetZones.rTargets) {
      const r = snapshot.targetZones.rTargets;
      lines.push(`🎯 TARGETS: 1R=${formatPrice(r.t1)} | 2R=${formatPrice(r.t2)} | 3R=${formatPrice(r.t3)}`);
    }
    
    // ATR targets
    if (snapshot.targetZones.atrTargets) {
      const atr = snapshot.targetZones.atrTargets;
      lines.push(`📈 ATR: T1=${formatPrice(atr.t1)} | T2=${formatPrice(atr.t2)}`);
    }
    
    // Magnet levels
    const magnets: string[] = [];
    if (snapshot.targetZones.magnetLevels?.microLow) {
      magnets.push(`microLow=${formatPrice(snapshot.targetZones.magnetLevels.microLow)}`);
    }
    if (snapshot.targetZones.magnetLevels?.majorLow) {
      magnets.push(`majorLow=${formatPrice(snapshot.targetZones.magnetLevels.majorLow)}`);
    }
    if (snapshot.targetZones.magnetLevels?.vwap) {
      magnets.push(`vwap=${formatPrice(snapshot.targetZones.magnetLevels.vwap)}`);
    }
    if (magnets.length > 0) {
      lines.push(`🧲 MAGNET: ${magnets.join(" | ")}`);
    }
    
    // Expected zone
    if (snapshot.targetZones.expectedZone) {
      const zone = snapshot.targetZones.expectedZone;
      lines.push(`📍 EXPECTED_ZONE: ${formatPrice(zone.lower)} – ${formatPrice(zone.upper)}`);
    }
    
    // Measured move if available
    if (snapshot.targetZones.measuredMove) {
      lines.push(`📏 MEASURED_MOVE: ${formatPrice(snapshot.targetZones.measuredMove)}`);
    }
  }

  // Add debug line for minimal mode
  if (snapshot.debug) {
    const d = snapshot.debug;
    const barsClosed = d.barsClosed5m ?? "n/a";
    const forming = d.hasForming5m ? `Y(${d.formingProgressMin ?? "n/a"})` : "N";
    const cand = d.candidateCount ?? "n/a";
    const phase = d.botPhase ?? "n/a";
    const sel = snapshot.direction ?? "n/a";
    const debugLine = `DEBUG: 5mClosed=${barsClosed} forming=${forming} cand=${cand} phase=${phase} conf=${conf} sel=${sel}`;
    lines.push(debugLine);
  }

  return { type: "MIND", lines, text: lines.join("\n") };
}
