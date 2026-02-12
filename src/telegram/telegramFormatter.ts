import type { TelegramSnapshot } from "./telegramNormalizer.js";
import { formatEtTimestamp } from "./telegramNormalizer.js";
import type { NoTradeBlocker, NoTradeBlockerSeverity } from "../types.js";

export type TelegramAlert = {
  type: "MIND" | "LLM_1M_OPINION" | "ALERT";
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
  if (phase === "EXTENSION") return "🟠";
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
  // Handle LLM_1M_OPINION messages
  if (snapshot.type === "LLM_1M_OPINION") {
    const price = formatPrice(snapshot.price);
    const direction = snapshot.direction ?? "NEUTRAL";
    const confidence = snapshot.confidence ?? 0;
    const text = `🧠 LLM(1m): ${direction} ${confidence} | px=${price} | based on 5m candles`;
    return {
      type: "LLM_1M_OPINION",
      lines: [text],
      text,
    };
  }

  // Helper to get alert label
  const getAlertLabel = (alertKind: string): string => {
    const labelMap: Record<string, string> = {
      "GATE_ARMED": "GATE ARMED",
      "OPPORTUNITY_TRIGGERED": "TRIGGER HIT",
      "TRADE_ENTRY": "IN TRADE",
    };
    return labelMap[alertKind] ?? "EXIT";
  };

  // Trading alerts (discrete events: gate armed, trigger, entry, exit)
  if (snapshot.type === "ALERT" && snapshot.alertKind && snapshot.alertPayload) {
    const p = snapshot.alertPayload;
    const price = formatPrice(snapshot.price);
    const label = getAlertLabel(snapshot.alertKind);
    const parts: string[] = [
      `🚨 ALERT: ${label}`,
      `${p.direction} | px=${price}`,
    ];
    if (p.triggerPrice !== undefined) parts.push(`trigger ${formatPrice(p.triggerPrice)}`);
    if (p.stopPrice !== undefined) parts.push(`stop ${formatPrice(p.stopPrice)}`);
    if (p.entryPrice !== undefined) parts.push(`entry ${formatPrice(p.entryPrice)}`);
    if (p.reason) parts.push(`| ${p.reason}`);
    if (p.exitReason) parts.push(`| ${p.exitReason}`);
    if (p.result) parts.push(`(${p.result})`);
    const text = parts.join(" ");
    return {
      type: "ALERT",
      lines: [text],
      text,
    };
  }

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
  
  // Helper to format expected resolution text
  const formatExpectedResolutionText = (resolution: string, bias?: string): string => {
    if (resolution === "CONTINUATION") {
      return bias === "BEARISH" ? "Continuation down" : "Continuation up";
    }
    if (resolution === "FAILURE") {
      return bias === "BEARISH" ? "Pullback failure → continuation down" : "Pullback failure → continuation up";
    }
    return resolution;
  };

  // Format expected resolution with emoji
  const expectedLine = snapshot.expectedResolution
    ? `${expectedEmoji} EXPECTATION: ${formatExpectedResolutionText(snapshot.expectedResolution, snapshot.bias)}`
    : undefined;

  // Format setup with emoji
  const setupEmoji = snapshot.setup && snapshot.setup !== "NONE" ? "🎯" : "⚪";
  
  // Helper to format trigger label
  const formatTriggerLabel = (): string => {
    if (snapshot.setupTriggerPrice == null) return "";
    const priceText = `trigger: ${formatPrice(snapshot.setupTriggerPrice)}`;
    if (snapshot.triggerContext) {
      const contextText = snapshot.triggerContext === "extended" ? "extended" : "in pullback";
      return `${priceText} (${contextText})`;
    }
    return priceText;
  };
  
  // Format setup line
  const triggerLabel = formatTriggerLabel();
  const setupLine = snapshot.setup 
    ? `${setupEmoji} SETUP: ${snapshot.setup}${triggerLabel ? ` (${triggerLabel})` : ""}`
    : undefined;
  
  // Format entry line
  const formatEntryLine = (): string => {
    if (snapshot.entryStatus === "active") return `${entryEmoji} ENTRY: ACTIVE`;
    if (snapshot.entryStatus === "blocked") return `${entryEmoji} ENTRY: BLOCKED`;
    
    if (snapshot.setup && snapshot.setup !== "NONE") {
      if (snapshot.setupTriggerPrice != null) {
        return `${entryEmoji} ENTRY: WAITING (${triggerLabel})`;
      }
      const contextText = snapshot.triggerContext === "extended" 
        ? "extended" 
        : snapshot.triggerContext === "in_pullback" 
          ? "in pullback" 
          : "waiting for level";
      return `${entryEmoji} ENTRY: WAITING (${contextText})`;
    }
    
    return `${entryEmoji} ENTRY: NONE`;
  };
  const entryLine = formatEntryLine();

  // Market condition line (if available)
  const marketConditionLine = snapshot.marketCondition
    ? `📊 MARKET: ${snapshot.marketCondition}${snapshot.conditionReason ? ` (${snapshot.conditionReason})` : ""}`
    : undefined;

  // LLM coaching line (into/out of setup)
  const coachLine = snapshot.coachLine?.trim();
  const nextLevel = Number.isFinite(snapshot.nextLevel) ? (snapshot.nextLevel as number) : undefined;
  const likelihoodHit = Number.isFinite(snapshot.likelihoodHit) ? (snapshot.likelihoodHit as number) : undefined;
  const nextPart = nextLevel !== undefined && likelihoodHit !== undefined ? `Next: ${formatPrice(nextLevel)} (${likelihoodHit}% likely)` : null;
  const coachLineFormatted =
    coachLine || nextPart
      ? `🎯 Coach: ${[coachLine, nextPart].filter(Boolean).join(" | ")}`
      : undefined;

  const lines = [
    `${biasEmoji} PRICE: ${price}`, // Always first with bias emoji
    refLine, // Reference price if available
    `${biasEmoji} BIAS: ${biasLabel} (${conf})`,
    `${phaseEmoji} PHASE: ${snapshot.botState ?? "n/a"}`,
    marketConditionLine, // Market condition if available
    setupLine, // Setup type if available
    entryLine, // Entry status
    snapshot.reason ? `NOTE: ${snapshot.reason}` : undefined,
    coachLineFormatted, // LLM coaching (into/out of setup)
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
    // Note: setupLine is already added in main block (line 190), no need to duplicate here

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

  // Helper to format timestamp lines
  const formatTimestampLines = (): string[] => {
    const timestampLines: string[] = [];
    if (snapshot.source) {
      timestampLines.push(`📡 SOURCE: ${snapshot.source.toUpperCase()}`);
    }
    if (snapshot.last5mCloseTs) {
      timestampLines.push(`🕐 LAST 5M CLOSE: ${formatEtTimestamp(snapshot.last5mCloseTs)}`);
    }
    if (snapshot.oppLatchedAt) {
      timestampLines.push(`🔒 OPP LATCHED: ${formatEtTimestamp(snapshot.oppLatchedAt)}`);
    }
    if (snapshot.oppExpiresAt) {
      const expiresTime = formatEtTimestamp(snapshot.oppExpiresAt);
      const timeUntilExpiry = snapshot.oppExpiresAt - Date.now();
      const minutesUntilExpiry = Math.floor(timeUntilExpiry / (60 * 1000));
      const expiryText = minutesUntilExpiry > 0 ? `in ${minutesUntilExpiry}m` : 'expired';
      timestampLines.push(`⏰ OPP EXPIRES: ${expiresTime} (${expiryText})`);
    }
    return timestampLines;
  };

  // Add timestamps for debugging (if available)
  const timestampLines = formatTimestampLines();
  if (timestampLines.length > 0) {
    lines.push(""); // Blank line separator
    lines.push(...timestampLines);
  }

  // Helper to format target zone lines
  const formatTargetZoneLines = (): string[] => {
    if (!snapshot.entryStatus || snapshot.entryStatus !== "active" || !snapshot.entryPrice || !snapshot.stopPrice || !snapshot.targetZones) {
      return [];
    }
    
    const targetLines: string[] = [];
    const risk = Math.abs(snapshot.entryPrice - snapshot.stopPrice);
    targetLines.push(`📊 ENTRY: ${formatPrice(snapshot.entryPrice)} STOP: ${formatPrice(snapshot.stopPrice)} (R=${risk.toFixed(2)})`);
    
    // R targets
    if (snapshot.targetZones.rTargets) {
      const r = snapshot.targetZones.rTargets;
      targetLines.push(`🎯 TARGETS: 1R=${formatPrice(r.t1)} | 2R=${formatPrice(r.t2)} | 3R=${formatPrice(r.t3)}`);
    }
    
    // ATR targets
    if (snapshot.targetZones.atrTargets) {
      const atr = snapshot.targetZones.atrTargets;
      targetLines.push(`📈 ATR: T1=${formatPrice(atr.t1)} | T2=${formatPrice(atr.t2)}`);
    }
    
    // Magnet levels
    const magnets: string[] = [];
    const magnetLevels = snapshot.targetZones.magnetLevels;
    if (magnetLevels?.microLow) magnets.push(`microLow=${formatPrice(magnetLevels.microLow)}`);
    if (magnetLevels?.majorLow) magnets.push(`majorLow=${formatPrice(magnetLevels.majorLow)}`);
    if (magnetLevels?.vwap) magnets.push(`vwap=${formatPrice(magnetLevels.vwap)}`);
    if (magnets.length > 0) {
      targetLines.push(`🧲 MAGNET: ${magnets.join(" | ")}`);
    }
    
    // Expected zone
    if (snapshot.targetZones.expectedZone) {
      const zone = snapshot.targetZones.expectedZone;
      targetLines.push(`📍 EXPECTED_ZONE: ${formatPrice(zone.lower)} – ${formatPrice(zone.upper)}`);
    }
    
    // Measured move
    if (snapshot.targetZones.measuredMove) {
      targetLines.push(`📏 MEASURED_MOVE: ${formatPrice(snapshot.targetZones.measuredMove)}`);
    }
    
    return targetLines;
  };

  // Add target zones if in trade
  const targetZoneLines = formatTargetZoneLines();
  if (targetZoneLines.length > 0) {
    lines.push(""); // Blank line separator
    lines.push(...targetZoneLines);
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
