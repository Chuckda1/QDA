import assert from "node:assert/strict";
import type { DomainEvent, TacticalSnapshot } from "../src/types.js";
import { buildTelegramAlert } from "../src/telegram/telegramFormatter.js";
import { normalizeTelegramSnapshot } from "../src/telegram/telegramNormalizer.js";
import { buildTelegramSignature } from "../src/telegram/telegramSignature.js";
import { MessagePublisher } from "../src/telegram/messagePublisher.js";
import { Orchestrator, buildChopPlan } from "../src/orchestrator/orchestrator.js";
import { MessageGovernor } from "../src/governor/messageGovernor.js";
import { isDecisionAlertEvent } from "../src/utils/decisionState.js";

const makeBaseEvent = (type: DomainEvent["type"], data: Record<string, any>): DomainEvent => ({
  type,
  timestamp: Date.now(),
  instanceId: "test",
  data,
});

const watchEvent = makeBaseEvent("NO_ENTRY", {
  symbol: "SPY",
  direction: "LONG",
  decisionState: "WATCH",
  gateStatus: {
    pendingGate: "distance_to_VWAP <= 0.8 ATR (now 0.11)",
    blockedReasons: [
      "WAIT_FOR_PULLBACK: extended-from-mean (Price 1.35 above VWAP). Re-arm when distance_to_VWAP <= 0.8 * ATR."
    ],
  },
  price: 685.76,
  volume: { line: "LOW (0.62x) → 2 closes" },
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
  softBlockers: ["entry_filter"],
  softBlockerReasons: [
    "WAIT_FOR_PULLBACK: extended-from-mean (Price 1.35 above VWAP). Re-arm when distance_to_VWAP <= 0.8 * ATR."
  ],
  decision: {
    status: "BLOCKED",
    decisionState: "WATCH",
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
  decisionState: "SIGNAL",
  price: 685.9,
  volume: { line: "NORMAL (1.05x) → 2 closes" },
  marketState: {
    regime: "TREND_UP",
    permission: { mode: "NORMAL" },
    tacticalSnapshot: { confidence: 100 },
    dataReadiness: { ready: true },
  },
  timing: { phase: "IMPULSE" },
  decision: { decisionState: "SIGNAL", metrics: { legitimacy: 65, followThrough: 62, riskAtr: 1.1 } },
});

const updateEvent = makeBaseEvent("PLAY_CANCELLED", {
  symbol: "SPY",
  direction: "SHORT",
  reason: "invalidated",
  price: 451.2,
  lastSignal: "LONG",
  decisionState: "UPDATE",
  marketState: {
    permission: { mode: "NORMAL" },
    tacticalSnapshot: { confidence: 80 },
  },
  decision: { decisionState: "UPDATE" },
});

const manageEvent = makeBaseEvent("LLM_COACH_UPDATE", {
  symbol: "SPY",
  direction: "LONG",
  price: 452.8,
  action: "HOLD",
  urgency: "LOW",
  nextCheck: "5m",
  decisionState: "MANAGE",
  warnTags: ["SHOCK", "EXTENDED"],
});

const premarketEvent = makeBaseEvent("PREMARKET_UPDATE", {
  symbol: "SPY",
  direction: "LONG",
  price: 451.9,
  decisionState: "UPDATE",
  premarket: {
    kind: "PREMARKET_BRIEF",
    bias: "LONG",
    confidence: 62,
    levels: "entry 451.20-452.40, stop 449.80",
    arm: "retest 451.20-452.40 | pullback only",
  },
});

const watchSnapshot = normalizeTelegramSnapshot(watchEvent);
assert.ok(watchSnapshot, "WATCH snapshot missing");
const watchAlert = buildTelegramAlert(watchSnapshot!);
assert.ok(watchAlert, "WATCH alert missing");
assert.equal(watchAlert?.type, "WATCH");
assert.ok(watchAlert?.lines.length <= 7, "WATCH line count exceeded");
assert.ok(watchAlert?.text.includes("\n"), "WATCH missing newline separators");
assert.ok(!watchAlert?.text.includes("\\n"), "WATCH contains literal \\n");
assert.ok(watchAlert?.lines[0]?.includes("WATCH"), "WATCH header missing status");
assert.ok(watchAlert?.lines[0]?.includes("px"), "WATCH header missing px");
assert.ok(/ET$/.test(watchAlert?.lines[0] ?? ""), "WATCH header missing ET timestamp");
assert.ok(watchAlert?.lines[1]?.startsWith("ARM:"), "WATCH arm line missing");
assert.ok(watchAlert?.lines[2]?.startsWith("ENTRY:"), "WATCH entry line missing");
assert.ok(watchAlert?.lines.some((l) => l.startsWith("VOL:")), "WATCH volume line missing");
assert.ok(watchAlert?.lines.some((l) => l.startsWith("STOP PLAN:")), "WATCH stop plan line missing");
assert.ok(watchAlert?.lines.some((l) => l.startsWith("NEXT:")), "WATCH next line missing");
assert.ok(
  watchAlert?.lines.some((l) => l.includes("distance_to_VWAP <= 0.8 ATR (now 0.11)")),
  "WATCH next line should use pending gate"
);
assert.ok(watchAlert?.lines.some((l) => l.startsWith("WHY:")), "WATCH why line missing");
const watchText = watchAlert?.lines.join(" ") ?? "";
assert.ok(!watchText.includes("WAIT_FOR_PULLBACK"), "WATCH contains raw blocker text");
assert.ok(!watchText.includes("extended-from-mean"), "WATCH contains raw blocker text");
assert.ok(!watchText.includes("RISK_CAP"), "WATCH contains raw blocker text");
assert.ok(!/WAIT_FOR_|arming_failed|entry_filter|BLOCKED|SETUP CANDIDATES/i.test(watchText), "WATCH contains raw blocker token");
assert.ok(/^[A-Z]+/.test(watchAlert?.lines[0] ?? ""), "WATCH header malformed");

const rangeEvent = makeBaseEvent("NO_ENTRY", {
  symbol: "SPY",
  direction: "LONG",
  decisionState: "WATCH",
  range: {
    low: 689.2,
    high: 690.1,
    contextRange: { low: 687.9, high: 691.4 },
    microBox: { low: 689.4, high: 689.9 },
    vwap: 689.6,
    price: 689.7,
    activeSide: "LONG_ONLY",
    location: { zone: "LOW", pos: 0.22 },
    longArm: "retest 689.40-689.70",
    longEntry: "break&hold above 690.10",
    shortArm: "retest 689.60-689.90",
    shortEntry: "break&hold below 689.20",
    stopAnchor: "long < 689.20 | short > 690.10 (armed)",
    ts: Date.now(),
    mode: "NORMAL",
  },
  rangeWarnTags: ["TRANSITION", "LOW_DENSITY", "TF_CONFLICT", "GUARDRAIL", "EXTENDED"],
});
const rangeSnapshot = normalizeTelegramSnapshot(rangeEvent);
assert.ok(rangeSnapshot, "Range WATCH snapshot missing");
assert.ok(rangeSnapshot?.range, "Range WATCH missing range payload");
const rangeAlert = buildTelegramAlert(rangeSnapshot!);
assert.ok(rangeAlert, "Range WATCH alert missing");
assert.ok(rangeAlert?.lines.length <= 12, "Range WATCH line count exceeded");
assert.ok(rangeAlert?.lines[0]?.includes("WATCH"), "Range WATCH header missing WATCH");
assert.ok(rangeAlert?.lines[0]?.includes("RANGE"), "Range WATCH header missing RANGE");
assert.ok(rangeAlert?.lines[0]?.includes("ET"), "Range WATCH header missing ET time");
assert.ok(rangeAlert?.lines.some((l) => l.startsWith("CONTEXT_RANGE:")), "Range WATCH missing context range line");
assert.ok(rangeAlert?.lines.some((l) => l.startsWith("MICRO_BOX:")), "Range WATCH missing micro box line");
assert.ok(rangeAlert?.lines.some((l) => l.startsWith("BIAS:")), "Range WATCH missing bias line");
assert.ok(rangeAlert?.lines.some((l) => l.startsWith("ACTIVE_SIDE:")), "Range WATCH missing active side line");
assert.ok(rangeAlert?.lines.some((l) => l.startsWith("PLAN:")), "Range WATCH missing plan line");
assert.ok(rangeAlert?.lines.some((l) => l.startsWith("ARM:")), "Range WATCH missing arm line");
assert.ok(rangeAlert?.lines.some((l) => l.startsWith("STOP:")), "Range WATCH missing stop anchor");
assert.ok(rangeAlert?.lines.some((l) => l.startsWith("NEXT:")), "Range WATCH missing next line");
assert.ok(
  rangeAlert?.lines.some((l) => l.includes("+1")),
  "Range WATCH warn tags should be capped"
);

const blockedEvent = makeBaseEvent("NO_ENTRY", {
  symbol: "SPY",
  direction: "SHORT",
  decisionState: "WATCH",
  gateStatus: {
    blockedReasons: ["WAIT_FOR_PULLBACK: extended-from-mean", "No reclaim signal"],
  },
  price: 683.12,
  topPlay: {
    entryZone: { low: 681.2, high: 682.4 },
    stop: 684.8,
    targets: { t1: 680.2, t2: 678.4, t3: 676.2 },
  },
  marketState: { permission: { mode: "NORMAL" }, tacticalSnapshot: { confidence: 60 }, dataReadiness: { ready: true } },
  decision: { decisionState: "WATCH" },
});
const blockedSnapshot = normalizeTelegramSnapshot(blockedEvent);
assert.ok(blockedSnapshot, "Blocked snapshot missing");
const blockedAlert = buildTelegramAlert(blockedSnapshot!);
assert.ok(blockedAlert?.lines.some((l) => l.startsWith("BLOCKED_BY:")), "Blocked watch should show BLOCKED_BY");

const signalSnapshot = normalizeTelegramSnapshot(signalEvent);
assert.ok(signalSnapshot, "SIGNAL snapshot missing");
const signalAlert = buildTelegramAlert(signalSnapshot!);
assert.ok(signalAlert, "SIGNAL alert missing");
assert.equal(signalAlert?.type, "SIGNAL");
assert.ok(signalAlert?.lines.length <= 7, "SIGNAL line count exceeded");
assert.ok(signalAlert?.text.includes("\n"), "SIGNAL missing newline separators");
assert.ok(!signalAlert?.text.includes("\\n"), "SIGNAL contains literal \\n");
assert.ok(signalAlert?.lines[0]?.includes("SIGNAL"), "SIGNAL header missing status");
assert.ok(signalAlert?.lines[0]?.includes("px"), "SIGNAL header missing px");
assert.ok(/ET$/.test(signalAlert?.lines[0] ?? ""), "SIGNAL header missing ET timestamp");
assert.ok(signalAlert?.lines[1]?.startsWith("ENTRY:"), "SIGNAL entry line missing");
assert.ok(signalAlert?.lines[2]?.startsWith("STOP:"), "SIGNAL stop line missing");
assert.ok(signalAlert?.lines[3]?.startsWith("TP1:"), "SIGNAL TP1 line missing");
assert.ok(signalAlert?.lines[4]?.startsWith("SIZE:"), "SIGNAL size line missing");
assert.ok(signalAlert?.lines.some((l) => l.startsWith("VOL:")), "SIGNAL volume line missing");
assert.ok(signalAlert?.lines.some((l) => l.startsWith("WHY:")), "SIGNAL why line missing");
assert.ok(!/WAIT_FOR_|arming_failed|entry_filter|BLOCKED|SETUP CANDIDATES/i.test(signalAlert?.text ?? ""), "SIGNAL contains raw blocker token");
assert.ok(signalAlert?.lines[0]?.includes("✅"), "SIGNAL header missing emoji");

const thinVolEvent = makeBaseEvent("PLAY_ARMED", {
  play: {
    symbol: "SPY",
    direction: "LONG",
    entryZone: { low: 452.1, high: 453.2 },
    stop: 450.4,
    targets: { t1: 455.0, t2: 456.9, t3: 459.2 },
  },
  decisionState: "SIGNAL",
  candidate: {
    symbol: "SPY",
    direction: "LONG",
    warningFlags: ["THIN_TAPE"],
    featureBundle: { volume: { relVolume: 0.4 } },
  },
  marketState: {
    permission: { mode: "NORMAL" },
    tacticalSnapshot: { confidence: 100 },
    dataReadiness: { ready: true },
  },
  timing: { phase: "IMPULSE" },
});
const thinVolSnapshot = normalizeTelegramSnapshot(thinVolEvent);
assert.ok(thinVolSnapshot, "Thin volume snapshot missing");
assert.equal(thinVolSnapshot?.type, "SIGNAL", "Thin volume should still produce SIGNAL snapshot");
assert.ok((thinVolSnapshot?.conf ?? 0) <= 70, "Thin volume should cap confidence");
const thinVolAlert = buildTelegramAlert(thinVolSnapshot!);
assert.ok(thinVolAlert?.text.includes("THIN_TAPE"), "Thin volume warn tag missing");
assert.ok(thinVolAlert?.text.toLowerCase().includes("low participation"), "Thin volume WHY missing");

const updateSnapshot = normalizeTelegramSnapshot(updateEvent);
assert.ok(updateSnapshot, "UPDATE snapshot missing");
const updateAlert = buildTelegramAlert(updateSnapshot!);
assert.ok(updateAlert, "UPDATE alert missing");
assert.equal(updateAlert?.type, "UPDATE");
assert.ok(updateAlert?.lines.length <= 3, "UPDATE line count exceeded");
assert.ok(updateAlert?.text.includes("\n"), "UPDATE missing newline separators");
assert.ok(!updateAlert?.text.includes("\\n"), "UPDATE contains literal \\n");
assert.ok(updateAlert?.lines[0]?.startsWith("UPDATE:"), "UPDATE header missing status");
assert.ok(updateAlert?.lines[0]?.includes("SPY"), "UPDATE header missing symbol");
assert.ok(!updateAlert?.lines[0]?.includes("UPDATE: UPDATE"), "UPDATE header duplicated");
assert.ok(updateAlert?.lines[0]?.includes("LONG → SHORT"), "UPDATE header missing side flip");
assert.ok(updateAlert?.lines[0]?.includes("px"), "UPDATE price missing");
assert.ok(/ET$/.test(updateAlert?.lines[0] ?? ""), "UPDATE header missing ET timestamp");
assert.ok(updateAlert?.text.includes("\nCAUSE:"), "UPDATE header not separated from cause");
assert.ok(updateAlert?.lines[1]?.startsWith("CAUSE:"), "UPDATE cause line missing");
assert.ok(updateAlert?.lines[1]?.includes("last"), "UPDATE last signal missing");
assert.ok(updateAlert?.lines[2]?.startsWith("NEXT:"), "UPDATE next line missing");

const manageSnapshot = normalizeTelegramSnapshot(manageEvent);
assert.ok(manageSnapshot, "MANAGE snapshot missing");
const manageAlert = buildTelegramAlert(manageSnapshot!);
assert.ok(manageAlert, "MANAGE alert missing");
assert.equal(manageAlert?.type, "MANAGE");
assert.ok(manageAlert?.lines.length <= 4, "MANAGE line count exceeded");
assert.ok(manageAlert?.text.includes("\n"), "MANAGE missing newline separators");
assert.ok(!manageAlert?.text.includes("\\n"), "MANAGE contains literal \\n");
assert.ok(manageAlert?.lines[0]?.startsWith("MANAGE:"), "MANAGE header missing status");
assert.ok(manageAlert?.lines[0]?.includes("px"), "MANAGE header missing px");
assert.ok(/ET$/.test(manageAlert?.lines[0] ?? ""), "MANAGE header missing ET timestamp");
assert.ok(manageAlert?.lines[1]?.startsWith("ACTION:"), "MANAGE action line missing");
assert.ok(manageAlert?.lines[2]?.startsWith("NEXT:"), "MANAGE next line missing");
assert.ok(
  /^WARN\((H\/S|H|S)\):/.test(manageAlert?.lines[3] ?? ""),
  "MANAGE warn line missing"
);

const premarketSnapshot = normalizeTelegramSnapshot(premarketEvent);
assert.ok(premarketSnapshot, "Premarket snapshot missing");
assert.equal(premarketSnapshot?.type, "UPDATE", "Premarket should produce UPDATE");

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
assert.equal(signatureA, signatureB, "Signature should ignore WHY differences");

const timeCutoffEvent = makeBaseEvent("NO_ENTRY", {
  symbol: "SPY",
  direction: "LONG",
  decisionState: "UPDATE",
  price: 688.9,
  hardBlockers: ["time_window"],
  hardBlockerReasons: ["Time-of-day cutoff: No new plays after 15:30 ET"],
  decision: { decisionState: "UPDATE" },
});
const timeCutoffSnapshot = normalizeTelegramSnapshot(timeCutoffEvent);
assert.ok(timeCutoffSnapshot, "Time cutoff snapshot missing");
assert.equal(timeCutoffSnapshot?.type, "UPDATE", "Time cutoff should produce UPDATE");
const timeCutoffAlert = buildTelegramAlert(timeCutoffSnapshot!);
assert.ok(timeCutoffAlert, "Time cutoff alert missing");
assert.ok(timeCutoffAlert?.lines[0]?.includes("TIME CUTOFF"), "Time cutoff header should call out cutoff");
assert.ok(!timeCutoffAlert?.lines[0]?.includes("→"), "Time cutoff should not show side flip");
assert.ok(timeCutoffAlert?.lines[0]?.includes("px"), "Time cutoff should include px");

const dataReadyEvent = makeBaseEvent("NO_ENTRY", {
  symbol: "SPY",
  direction: "LONG",
  decisionState: "WATCH",
  hardBlockers: ["guardrail"],
  hardBlockerReasons: ["DATA_READY: missing VWAP"],
  topPlay: {
    entryZone: { low: 451.2, high: 452.4 },
    stop: 449.8,
    targets: { t1: 454.2, t2: 456.4, t3: 458.2 },
  },
  decision: { decisionState: "WATCH" },
});
const dataReadySnapshot = normalizeTelegramSnapshot(dataReadyEvent);
assert.ok(dataReadySnapshot, "Data readiness snapshot missing");
assert.equal(dataReadySnapshot?.type, "WATCH", "Data readiness should produce WATCH");

const governorActive = new MessageGovernor();
governorActive.setMode("ACTIVE");
assert.ok(governorActive.shouldSend(watchEvent, {} as any, 0), "WATCH should send in ACTIVE");

const governorQuiet = new MessageGovernor();
governorQuiet.setMode("QUIET");
const quietUpdateEvent = makeBaseEvent("PLAY_CANCELLED", {
  symbol: "SPY",
  direction: "LONG",
  decisionState: "UPDATE",
  reason: "time cutoff",
  decision: { decisionState: "UPDATE" },
});
assert.ok(governorQuiet.shouldSend(quietUpdateEvent, {} as any, 0), "UPDATE should send in QUIET");

const debugEvent = makeBaseEvent("SETUP_CANDIDATES", { symbol: "SPY" });
assert.equal(isDecisionAlertEvent(debugEvent), false, "Debug events should not be decision alerts");

const watchMissingArmEvent = makeBaseEvent("NO_ENTRY", {
  symbol: "SPY",
  direction: "LONG",
  decisionState: "WATCH",
  decision: { decisionState: "WATCH" },
});
const watchMissingArmSnapshot = normalizeTelegramSnapshot(watchMissingArmEvent);
assert.ok(watchMissingArmSnapshot, "Missing ARM snapshot missing");
assert.equal(watchMissingArmSnapshot?.type, "UPDATE", "WATCH without ARM should emit UPDATE");
assert.ok(
  watchMissingArmSnapshot?.update?.cause.includes("contract violation"),
  "WATCH without ARM should flag contract violation"
);

const watchReadinessEvent = makeBaseEvent("NO_ENTRY", {
  symbol: "SPY",
  direction: "LONG",
  decisionState: "WATCH",
  hardWaitBlockers: ["guardrail"],
  decision: { decisionState: "WATCH" },
});
const watchReadinessSnapshot = normalizeTelegramSnapshot(watchReadinessEvent);
assert.ok(watchReadinessSnapshot, "Readiness snapshot missing");
assert.equal(watchReadinessSnapshot?.type, "UPDATE", "Readiness missing should emit UPDATE");
assert.ok(
  watchReadinessSnapshot?.update?.cause.includes("readiness not met"),
  "Readiness missing should explain readiness"
);

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

const runPublisherFilterTest = async () => {
  const sent: string[] = [];
  const bot = {
    sendMessage: async (_chatId: number, text: string) => {
      sent.push(text);
      return Promise.resolve();
    },
    onText: () => {},
    on: () => {},
  };
  const governor = new MessageGovernor();
  governor.setMode("ACTIVE");
  const publisher = new MessagePublisher(governor, bot as any, 0);
  const rangeOnlyEvent = makeBaseEvent("NO_ENTRY", {
    symbol: "SPY",
    direction: "LONG",
    decisionState: "WATCH",
    modeState: "CHOP",
    range: {
      low: 689.2,
      high: 690.1,
      vwap: 689.6,
      price: 689.7,
      longArm: "retest 689.40-689.70",
      longEntry: "break&hold above 690.10",
      shortArm: "retest 689.60-689.90",
      shortEntry: "break&hold below 689.20",
      stopAnchor: "long < 689.20 | short > 690.10 (armed)",
      ts: Date.now(),
      mode: "NORMAL",
    },
  });
  const directionalEvent = makeBaseEvent("PLAY_ARMED", {
    play: {
      symbol: "SPY",
      direction: "LONG",
      entryZone: { low: 452.1, high: 453.2 },
      stop: 450.4,
      targets: { t1: 455.0, t2: 456.9, t3: 459.2 },
    },
    decisionState: "SIGNAL",
    modeState: "CHOP",
    price: 685.9,
    marketState: {
      regime: "CHOP",
      permission: { mode: "NORMAL" },
      tacticalSnapshot: { confidence: 80 },
      dataReadiness: { ready: true },
    },
    decision: { decisionState: "SIGNAL", metrics: { legitimacy: 65, followThrough: 62, riskAtr: 1.1 } },
  });
  await (publisher as any)._publishOrderedInternal([directionalEvent, rangeOnlyEvent]);
  assert.equal(sent.length, 1, "Range mode should suppress directional card");
  assert.ok(sent[0]?.includes("RANGE") || sent[0]?.includes("CHOP"), "Range card should be sent");
};

await runPublisherFilterTest();

const makeBar = (ts: number, close: number, high: number, low: number) => ({
  ts,
  open: close,
  high,
  low,
  close,
  volume: 1000,
});

const baseTs = Date.parse("2026-01-21T19:00:00Z");
const barsA = Array.from({ length: 10 }, (_, idx) => {
  const ts = baseTs - (9 - idx) * 60_000;
  const low = 688.1 + idx * 0.01;
  const high = 688.9 + idx * 0.01;
  const close = (low + high) / 2;
  return makeBar(ts, close, high, low);
});
const barsB = Array.from({ length: 10 }, (_, idx) => {
  const ts = baseTs - (9 - idx) * 60_000;
  const low = 688.6 + idx * 0.01;
  const high = 689.4 + idx * 0.01;
  const close = (low + high) / 2;
  return makeBar(ts, close, high, low);
});

const candidateBase = {
  id: "test",
  ts: baseTs,
  symbol: "SPY",
  direction: "LONG" as const,
  pattern: "FOLLOW" as const,
  triggerPrice: 688.5,
  entryZone: { low: 688.3, high: 688.7 },
  stop: 687.8,
  targets: { t1: 689.2, t2: 689.6, t3: 690.0 },
  rationale: [],
  score: { alignment: 60, structure: 60, quality: 60, total: 60 },
};

const planA = buildChopPlan({
  ts: baseTs,
  close: 688.5,
  indicatorSnapshot: { vwap: 688.6 },
  rangeCandidates: [candidateBase],
  recentBars1m: barsA,
  recentBars5m: [],
});
const planB = buildChopPlan({
  ts: baseTs,
  close: 689.0,
  indicatorSnapshot: { vwap: 688.9 },
  rangeCandidates: [candidateBase],
  recentBars1m: barsB,
  recentBars5m: [],
});

assert.ok(!planA.microBox, "Micro box should be null for short history");
assert.ok(planA.contextRange, "Context range should be present");
assert.ok(planB.contextRange, "Context range should be present");
assert.notEqual(planA.longEntry, planB.longEntry, "Plan rails must change with context range");
assert.notEqual(planA.shortEntry, planB.shortEntry, "Plan rails must change with context range");
const expectedLongA = `break&hold above ${(planA.contextRange!.high + planA.buffer).toFixed(2)}`;
const expectedShortA = `break&hold below ${(planA.contextRange!.low - planA.buffer).toFixed(2)}`;
assert.equal(planA.longEntry, expectedLongA, "Plan A should derive from context rails");
assert.equal(planA.shortEntry, expectedShortA, "Plan B should derive from context rails");
const expectedStopA = `long < ${(planA.contextRange!.low - planA.buffer).toFixed(2)} | short > ${(planA.contextRange!.high + planA.buffer).toFixed(2)} (armed)`;
assert.equal(planA.stopAnchor, expectedStopA, "Stop rails should match plan rails + buffer");

console.log("✅ Telegram formatter tests passed.");
