import type { TelegramSnapshot } from "./telegramNormalizer.js";
import { formatEtTimestamp } from "./telegramNormalizer.js";
import type { NoTradeBlocker, NoTradeBlockerSeverity } from "../types.js";

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
  let setupLine: string | undefined;
  let entryLine: string | undefined;
  
  // Special handling for IGNITION setup with actionable info
  if (snapshot.setup === "IGNITION" && snapshot.setupDetectedAt && snapshot.lastBiasFlipTs && snapshot.ts) {
    const now = Date.now();
    const flipAge = now - snapshot.lastBiasFlipTs;
    const setupAge = snapshot.setupDetectedAt ? (now - snapshot.setupDetectedAt) : 0;
    const windowMs = 3 * 60 * 1000; // IGNITION_WINDOW_MS
    const ttlMs = 2 * 60 * 1000; // IGNITION_TTL_MS
    const windowRemaining = Math.max(0, windowMs - flipAge);
    const ttlRemaining = snapshot.setupDetectedAt ? Math.max(0, ttlMs - setupAge) : undefined;
    
    const windowText = windowRemaining > 0 
      ? `window open (${Math.round(windowRemaining / 1000)}s left)`
      : "window closed";
    const ttlText = ttlRemaining !== undefined && ttlRemaining > 0
      ? `expires in ${Math.round(ttlRemaining / 1000)}s`
      : ttlRemaining === 0 ? "expired" : undefined;
    
    setupLine = `${setupEmoji} SETUP: IGNITION ${windowText}${ttlText ? ` | ${ttlText}` : ""}`;
    
    if (snapshot.setupTriggerPrice && snapshot.setupStopPrice) {
      const triggerDir = snapshot.bias === "BULLISH" ? ">" : "<";
      entryLine = `${entryEmoji} ENTRY: WAITING | Trigger ${triggerDir} ${formatPrice(snapshot.setupTriggerPrice)} | Stop ${triggerDir === ">" ? "<" : ">"} ${formatPrice(snapshot.setupStopPrice)}`;
    } else {
      entryLine = `${entryEmoji} ENTRY: WAITING (trigger: ${snapshot.setupTriggerPrice ? formatPrice(snapshot.setupTriggerPrice) : "n/a"})`;
    }
  } else {
    // Standard setup formatting
    setupLine = snapshot.setup 
      ? `${setupEmoji} SETUP: ${snapshot.setup}${snapshot.setupTriggerPrice ? ` (trigger: ${formatPrice(snapshot.setupTriggerPrice)})` : ""}`
      : undefined;
    
    entryLine = snapshot.setup && snapshot.setup !== "NONE" && snapshot.setupTriggerPrice
      ? `${entryEmoji} ENTRY: WAITING (trigger: ${formatPrice(snapshot.setupTriggerPrice)})`
      : `${entryEmoji} ENTRY: ${snapshot.entryStatus === "active" ? "ACTIVE" : snapshot.entryStatus === "blocked" ? "BLOCKED" : "NONE"}`;
  }

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
  
  const inTrade = snapshot.botState === "IN_TRADE" || snapshot.entryStatus === "active";

  // ============================================================================
  // Single reducer: ONE state, ONE headline, no contradictions
  // ============================================================================
  type Severity = NoTradeBlockerSeverity;

  type TradeReadinessView = {
    headline?: string;          // e.g. "🚫 NO TRADE — HARD: No setup armed"
    secondary?: string[];       // up to 2
    info?: string[];            // hints only
    primary?: NoTradeBlocker;
  };

  const severityOrder: Record<Severity, number> = { HARD: 2, SOFT: 1, INFO: 0 };

  function buildTradeReadinessView(
    inTrade: boolean,
    setup: string | undefined,
    noTradeDiagnostic: { blockers?: NoTradeBlocker[] } | undefined,
    now: number = Date.now()
  ): TradeReadinessView {
    if (inTrade) return {};

    // 1) Collect blockers (diagnostic is source of truth)
    const blockers: NoTradeBlocker[] = (noTradeDiagnostic?.blockers ?? [])
      .filter((b: NoTradeBlocker) => now <= b.expiresAtTs);

    // 2) If there is no setup, treat it as a HARD blocker (but DO NOT print separate NO_TRADE text)
    // This replaces the old direct "NO TRADE — structure incomplete" line.
    const hasSetup = !!setup && setup !== "NONE";
    if (!hasSetup) {
      blockers.push({
        code: "NO_SETUP",
        message: "No setup armed",
        severity: "HARD",
        updatedAtTs: now,
        expiresAtTs: now + 5 * 60 * 1000,
        weight: 100,
      });
    }

    if (blockers.length === 0) return {};

    // 3) Separate info vs actionable
    const info = blockers.filter((b: NoTradeBlocker) => b.severity === "INFO");
    const actionable = blockers.filter((b: NoTradeBlocker) => b.severity !== "INFO");

    // If only info blockers exist, don't show "NO TRADE fired"
    if (actionable.length === 0) {
      return {
        info: info.slice(0, 3).map((b: NoTradeBlocker) => `💡 ${b.message}`),
      };
    }

    // 4) Sort actionable blockers: severity first, then weight
    actionable.sort((a: NoTradeBlocker, b: NoTradeBlocker) => {
      const sev = severityOrder[b.severity] - severityOrder[a.severity];
      if (sev !== 0) return sev;
      return b.weight - a.weight;
    });

    const primary = actionable[0];
    const secondary = actionable.slice(1, 3);

    const severityEmoji = primary.severity === "HARD" ? "🚫" : "⚠️";

    return {
      primary,
      headline: `${severityEmoji} NO TRADE — ${primary.severity}: ${primary.message}`,
      secondary: secondary.map((b: NoTradeBlocker) => {
        const e = b.severity === "HARD" ? "🚫" : "⚠️";
        return `${e} ${b.severity}: ${b.message}`;
      }),
      info: info.slice(0, 3).map((b: NoTradeBlocker) => `💡 ${b.message}`),
    };
  }

  // ------------------------------
  // NO_TRADE: single source of truth
  // ------------------------------
  if (!inTrade) {
    // Always show setup line as STATUS only (not a reason)
    lines.push(`⚪ SETUP: ${snapshot.setup ?? "NONE"}`);

    const view = buildTradeReadinessView(
      inTrade,
      snapshot.setup,
      snapshot.noTradeDiagnostic
    );

    // Print exactly one NO_TRADE headline max
    if (view.headline) {
      lines.push("");
      lines.push(view.headline);

      if (view.secondary && view.secondary.length > 0) {
        lines.push("Secondary:");
        view.secondary.forEach((s: string) => lines.push(s));
      }

      if (view.info && view.info.length > 0) {
        lines.push("Info:");
        view.info.forEach((s: string) => lines.push(s));
      }
    } else if (view.info && view.info.length > 0) {
      // Only hints, no "NO TRADE" headline
      lines.push("");
      view.info.forEach((s: string) => lines.push(s));
    }
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
