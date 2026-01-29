import type { TelegramSnapshot } from "./telegramNormalizer.js";

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

  const lines = [
    `${biasEmoji} PRICE: ${price}`, // Always first with bias emoji
    refLine, // Reference price if available
    `${biasEmoji} BIAS: ${biasLabel} (${conf})`,
    `${phaseEmoji} PHASE: ${snapshot.botState ?? "n/a"}`,
    `${entryEmoji} ENTRY: ${snapshot.entryStatus === "active" ? "ACTIVE" : snapshot.entryStatus === "blocked" ? "BLOCKED" : "NONE"}`,
    snapshot.reason ? `NOTE: ${snapshot.reason}` : undefined,
    expectedLine, // Expected resolution if available
    invalidation,
    `⏳ WAITING FOR: ${waitFor}`,
  ].filter(Boolean) as string[];
  
  // Add no-trade diagnostic if present
  if (snapshot.noTradeDiagnostic && snapshot.noTradeDiagnostic.reasons && snapshot.noTradeDiagnostic.reasons.length > 0) {
    lines.push(""); // Blank line separator
    lines.push("🚫 NO TRADE FIRED");
    lines.push("Reason:");
    snapshot.noTradeDiagnostic.reasons.forEach(reason => {
      lines.push(`• ${reason}`);
    });
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
