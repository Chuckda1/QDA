import assert from "node:assert/strict";
import type { DomainEvent, TacticalSnapshot } from "../src/types.js";
import { buildTelegramAlert } from "../src/telegram/telegramFormatter.js";
import { normalizeTelegramSnapshot } from "../src/telegram/telegramNormalizer.js";
import { buildTelegramSignature } from "../src/telegram/telegramSignature.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";

const makeBaseEvent = (type: DomainEvent["type"], data: Record<string, any>): DomainEvent => ({
  type,
  timestamp: Date.now(),
  instanceId: "test",
  data,
});

const watchEvent = makeBaseEvent("NO_ENTRY", {
  symbol: "SPY",
  direction: "LONG",
  topPlay: {
    symbol: "SPY",
    direction: "LONG",
    entryZone: { low: 451.2, high: 452.4 },
    stop: 449.8,
    targets: { t1: 454.2, t2: 456.4, t3: 458.2 },
    probability: 78,
  },
  marketState: {
    regime: "TREND_UP",
    permission: { mode: "NORMAL" },
    tacticalSnapshot: { confidence: 100 },
    dataReadiness: { ready: true },
  },
  timing: { phase: "PULLBACK" },
  decision: {
    status: "BLOCKED",
    blockers: ["entry_filter"],
    blockerReasons: [
      "WAIT_FOR_PULLBACK: extended-from-mean (Price 1.35 above VWAP). Re-arm when distance_to_VWAP <= 0.8 * ATR."
    ],
    metrics: { legitimacy: 40, followThrough: 50, riskAtr: 1.2 },
  },
});

const signalEvent = makeBaseEvent("PLAY_ARMED", {
  play: {
    symbol: "SPY",
    direction: "LONG",
    entryZone: { low: 452.1, high: 453.2 },
    stop: 450.4,
    targets: { t1: 455.0, t2: 456.9, t3: 459.2 },
    action: "GO_ALL_IN",
  },
  marketState: {
    regime: "TREND_UP",
    permission: { mode: "NORMAL" },
    tacticalSnapshot: { confidence: 100 },
    dataReadiness: { ready: true },
  },
  timing: { phase: "IMPULSE" },
  decision: { metrics: { legitimacy: 65, followThrough: 62, riskAtr: 1.1 } },
});

const updateEvent = makeBaseEvent("PLAY_CANCELLED", {
  symbol: "SPY",
  direction: "SHORT",
  reason: "invalidated",
  price: 451.2,
  lastSignal: "LONG",
  marketState: {
    permission: { mode: "NORMAL" },
    tacticalSnapshot: { confidence: 80 },
  },
});

const watchSnapshot = normalizeTelegramSnapshot(watchEvent);
assert.ok(watchSnapshot, "WATCH snapshot missing");
const watchAlert = buildTelegramAlert(watchSnapshot!);
assert.ok(watchAlert, "WATCH alert missing");
assert.equal(watchAlert?.type, "WATCH");
assert.ok(watchAlert?.lines.length <= 6, "WATCH line count exceeded");
assert.ok(watchAlert?.text.includes("\n"), "WATCH missing newline separators");
assert.ok(!watchAlert?.text.includes("\\n"), "WATCH contains literal \\n");
assert.ok(watchAlert?.lines[0]?.includes("WATCH"), "WATCH header missing status");
assert.ok(watchAlert?.lines[1]?.startsWith("ARM:"), "WATCH arm line missing");
assert.ok(watchAlert?.lines[2]?.startsWith("ENTRY:"), "WATCH entry line missing");
assert.ok(watchAlert?.lines[3]?.startsWith("PLAN STOP:"), "WATCH plan stop line missing");
assert.ok(watchAlert?.lines[4]?.startsWith("WHY:"), "WATCH why line missing");
assert.ok(watchAlert?.lines[5]?.startsWith("WARN:"), "WATCH warn line missing");
const watchText = watchAlert?.lines.join(" ") ?? "";
assert.ok(!watchText.includes("WAIT_FOR_PULLBACK"), "WATCH contains raw blocker text");
assert.ok(!watchText.includes("extended-from-mean"), "WATCH contains raw blocker text");
assert.ok(!watchText.includes("RISK_CAP"), "WATCH contains raw blocker text");
assert.ok(!/WAIT_FOR_|arming_failed|entry_filter|BLOCKED|SETUP CANDIDATES/i.test(watchText), "WATCH contains raw blocker token");
assert.ok(/^[A-Z]+/.test(watchAlert?.lines[0] ?? ""), "WATCH header malformed");

const signalSnapshot = normalizeTelegramSnapshot(signalEvent);
assert.ok(signalSnapshot, "SIGNAL snapshot missing");
const signalAlert = buildTelegramAlert(signalSnapshot!);
assert.ok(signalAlert, "SIGNAL alert missing");
assert.equal(signalAlert?.type, "SIGNAL");
assert.ok(signalAlert?.lines.length <= 7, "SIGNAL line count exceeded");
assert.ok(signalAlert?.text.includes("\n"), "SIGNAL missing newline separators");
assert.ok(!signalAlert?.text.includes("\\n"), "SIGNAL contains literal \\n");
assert.ok(signalAlert?.lines[0]?.includes("SIGNAL"), "SIGNAL header missing status");
assert.ok(signalAlert?.lines[1]?.startsWith("ENTRY:"), "SIGNAL entry line missing");
assert.ok(signalAlert?.lines[2]?.startsWith("STOP:"), "SIGNAL stop line missing");
assert.ok(signalAlert?.lines[3]?.startsWith("TP1:"), "SIGNAL TP1 line missing");
assert.ok(signalAlert?.lines[4]?.startsWith("SIZE:"), "SIGNAL size line missing");
assert.ok(signalAlert?.lines[5]?.startsWith("WHY:"), "SIGNAL why line missing");
assert.ok(!/WAIT_FOR_|arming_failed|entry_filter|BLOCKED|SETUP CANDIDATES/i.test(signalAlert?.text ?? ""), "SIGNAL contains raw blocker token");
assert.ok(signalAlert?.lines[0]?.includes("✅"), "SIGNAL header missing emoji");

const updateSnapshot = normalizeTelegramSnapshot(updateEvent);
assert.ok(updateSnapshot, "UPDATE snapshot missing");
const updateAlert = buildTelegramAlert(updateSnapshot!);
assert.ok(updateAlert, "UPDATE alert missing");
assert.equal(updateAlert?.type, "UPDATE");
assert.ok(updateAlert?.lines.length <= 4, "UPDATE line count exceeded");
assert.ok(updateAlert?.text.includes("\n"), "UPDATE missing newline separators");
assert.ok(!updateAlert?.text.includes("\\n"), "UPDATE contains literal \\n");
assert.ok(updateAlert?.lines[0]?.startsWith("UPDATE:"), "UPDATE header missing status");
assert.ok(updateAlert?.lines[0]?.includes("px"), "UPDATE price missing");
assert.ok(updateAlert?.text.includes("\nCAUSE:"), "UPDATE header not separated from cause");
assert.ok(updateAlert?.lines[1]?.startsWith("CAUSE:"), "UPDATE cause line missing");
assert.ok(updateAlert?.lines[1]?.includes("last"), "UPDATE last signal missing");
assert.ok(updateAlert?.lines[2]?.startsWith("NEXT:"), "UPDATE next line missing");
assert.ok(updateAlert?.lines[3]?.startsWith("TS:"), "UPDATE timestamp line missing");
assert.ok(updateAlert?.lines[3]?.endsWith(" ET"), "UPDATE timestamp not ET");

const setupSnapshot = normalizeTelegramSnapshot(makeBaseEvent("SETUP_CANDIDATES", { symbol: "SPY" }));
assert.equal(setupSnapshot, null, "SETUP_CANDIDATES should not emit telegram alerts");

const signatureA = buildTelegramSignature({
  type: "WATCH",
  symbol: "SPY",
  dir: "LONG",
  risk: "NORMAL",
  why: "trend up",
  armCondition: "distance_to_VWAP <= 0.8 ATR",
  entryRule: "pullback only (NO chase)",
  planStop: "below VWAP",
  warnTags: ["EXTENDED"],
});
const signatureB = buildTelegramSignature({
  type: "WATCH",
  symbol: "SPY",
  dir: "LONG",
  risk: "NORMAL",
  why: "trend up + impulse",
  armCondition: "distance_to_VWAP <= 0.8 ATR",
  entryRule: "pullback only (NO chase)",
  planStop: "below VWAP",
  warnTags: ["EXTENDED"],
});
assert.notEqual(signatureA, signatureB, "Signature must change when WHY changes");

const timeCutoffEvent = makeBaseEvent("NO_ENTRY", {
  symbol: "SPY",
  direction: "LONG",
  hardBlockers: ["time_window"],
  hardBlockerReasons: ["Time-of-day cutoff: No new plays after 15:30 ET"],
});
const timeCutoffSnapshot = normalizeTelegramSnapshot(timeCutoffEvent);
assert.ok(timeCutoffSnapshot, "Time cutoff snapshot missing");
assert.equal(timeCutoffSnapshot?.type, "UPDATE", "Time cutoff should produce UPDATE");

const dataReadyEvent = makeBaseEvent("NO_ENTRY", {
  symbol: "SPY",
  direction: "LONG",
  hardBlockers: ["guardrail"],
  hardBlockerReasons: ["DATA_READY: missing VWAP"],
  topPlay: {
    entryZone: { low: 451.2, high: 452.4 },
    stop: 449.8,
    targets: { t1: 454.2, t2: 456.4, t3: 458.2 },
  },
});
const dataReadySnapshot = normalizeTelegramSnapshot(dataReadyEvent);
assert.ok(dataReadySnapshot, "Data readiness snapshot missing");
assert.equal(dataReadySnapshot?.type, "WATCH", "Data readiness should produce WATCH");

const debounceOrch = new Orchestrator("debounce-test");
const baseSnapshot: TacticalSnapshot = {
  activeDirection: "LONG",
  confidence: 80,
  reasons: ["price>VWAP"],
  tier: "CLEAR",
  score: 3,
  shock: false,
  indicatorTf: "1m",
};
const ts = Date.now();
const s1 = (debounceOrch as any).applyTacticalDebounce(baseSnapshot, ts) as TacticalSnapshot;
const s2 = (debounceOrch as any).applyTacticalDebounce({ ...baseSnapshot, activeDirection: "SHORT" }, ts + 60_000) as TacticalSnapshot;
const s3 = (debounceOrch as any).applyTacticalDebounce({ ...baseSnapshot, activeDirection: "SHORT" }, ts + 120_000) as TacticalSnapshot;
const s4 = (debounceOrch as any).applyTacticalDebounce({ ...baseSnapshot, activeDirection: "LONG" }, ts + 180_000) as TacticalSnapshot;
assert.equal(s1.activeDirection, "LONG", "Initial direction should be LONG");
assert.equal(s2.activeDirection, "LONG", "Debounce should block first flip");
assert.equal(s3.activeDirection, "SHORT", "Debounce should allow second flip");
assert.equal(s4.activeDirection, "SHORT", "Cooldown should block immediate re-flip");

console.log("✅ Telegram formatter tests passed.");
