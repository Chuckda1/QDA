import assert from "node:assert/strict";
import type { DomainEvent } from "../src/types.js";
import { normalizeTelegramSnapshot } from "../src/telegram/telegramNormalizer.js";
import { buildTelegramAlert } from "../src/telegram/telegramFormatter.js";
import { isDecisionAlertEvent } from "../src/utils/decisionState.js";

const makeBaseEvent = (type: DomainEvent["type"], data: Record<string, any>): DomainEvent => ({
  type,
  timestamp: Date.now(),
  instanceId: "test",
  data,
});

const rangeEvent = makeBaseEvent("NO_ENTRY", {
  symbol: "SPY",
  direction: "LONG",
  decisionState: "WATCH",
  price: 688.85,
  range: {
    low: 688.2,
    high: 689.4,
    vwap: 688.8,
    price: 688.85,
    longArm: "retest 688.40-688.80",
    longEntry: "break&hold above 689.40",
    shortArm: "retest 688.50-688.90",
    shortEntry: "break&hold below 688.20",
    stopAnchor: "long < 688.20 | short > 689.40 (armed)",
    ts: Date.now(),
  },
});

const rangeSnapshot = normalizeTelegramSnapshot(rangeEvent);
assert.ok(rangeSnapshot?.range, "Range mode should create a range payload");
const rangeAlert = buildTelegramAlert(rangeSnapshot!);
assert.ok(rangeAlert, "Range mode should emit a WATCH alert");
assert.ok(rangeAlert?.lines[0]?.includes("RANGE"), "Range mode should use RANGE header");
assert.ok(
  !rangeAlert?.lines.some((line) => line.startsWith("ARM:") || line.startsWith("ENTRY:")),
  "Range mode should not emit directional ARM/ENTRY lines"
);

const softOnlyEvent = makeBaseEvent("NO_ENTRY", {
  symbol: "SPY",
  direction: "LONG",
  decisionState: "WATCH",
  price: 688.9,
  softBlockers: ["entry_filter"],
  softBlockerReasons: ["WAIT_FOR_PULLBACK: extended-from-mean (Price 1.35 above VWAP)."],
  topPlay: {
    entryZone: { low: 688.2, high: 689.2 },
    stop: 687.6,
    targets: { t1: 690.1, t2: 691.2, t3: 692.0 },
  },
  decision: { decisionState: "WATCH" },
});

const softOnlySnapshot = normalizeTelegramSnapshot(softOnlyEvent);
assert.ok(softOnlySnapshot, "Soft-only event snapshot missing");
assert.equal(softOnlySnapshot?.type, "WATCH", "Soft-only reasons should not hard-block to UPDATE");

const dualDirEvent = makeBaseEvent("NO_ENTRY", {
  symbol: "SPY",
  direction: "LONG",
  decisionState: "WATCH",
  price: 688.9,
  marketState: {
    permission: { mode: "NORMAL" },
    tacticalSnapshot: {
      activeDirection: "LONG",
      confirm: { bias: "SHORT" },
    },
  },
  topPlay: {
    entryZone: { low: 688.2, high: 689.2 },
    stop: 687.6,
    targets: { t1: 690.1, t2: 691.2, t3: 692.0 },
  },
  decision: { decisionState: "WATCH" },
});

const dualDirSnapshot = normalizeTelegramSnapshot(dualDirEvent);
const dualDirAlert = dualDirSnapshot ? buildTelegramAlert(dualDirSnapshot) : null;
assert.ok(dualDirAlert, "Dual-direction event should still produce an alert");
assert.ok(!/dir1m|dir5m|1m=|5m=/.test(dualDirAlert?.text ?? ""), "Telegram should not show dual direction fields");

const internalEvent = makeBaseEvent("SETUP_CANDIDATES", { symbol: "SPY" });
assert.equal(isDecisionAlertEvent(internalEvent), false, "Internal events must not be decision alerts");

console.log("✅ One-engine invariant tests passed.");
