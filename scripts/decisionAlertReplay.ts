import { readFileSync } from "node:fs";
import type { DomainEvent } from "../src/types.js";
import { MessageGovernor } from "../src/governor/messageGovernor.js";
import { normalizeTelegramSnapshot } from "../src/telegram/telegramNormalizer.js";
import { buildTelegramSignature } from "../src/telegram/telegramSignature.js";
import { getDecisionState, isDecisionAlertEvent } from "../src/utils/decisionState.js";

const inputPath = process.argv[2];
const modeArg = (process.argv[3] ?? "ACTIVE").toUpperCase();

if (!inputPath) {
  console.error("Usage: tsx scripts/decisionAlertReplay.ts <events.json> [ACTIVE|QUIET]");
  process.exit(1);
}

const raw = readFileSync(inputPath, "utf-8");
const events = JSON.parse(raw) as DomainEvent[];
const mode = modeArg === "QUIET" ? "QUIET" : "ACTIVE";

const governor = new MessageGovernor();
governor.setMode(mode);

const decisionCounts: Record<string, number> = {
  SIGNAL: 0,
  WATCH: 0,
  UPDATE: 0,
  MANAGE: 0,
  NONE: 0,
};

const stats = {
  total: events.length,
  decisionAlerts: 0,
  snapshots: 0,
  sent: 0,
  droppedByPublisherFilter: 0,
  suppressedBySignature: 0,
  suppressedByMode: 0,
  suppressedByGovernor: 0,
  contractViolations: 0,
};

const lastSignatureBySymbol = new Map<string, string>();

for (const event of events) {
  const decisionState = getDecisionState(event) ?? "NONE";
  decisionCounts[decisionState] = (decisionCounts[decisionState] ?? 0) + 1;

  if (!isDecisionAlertEvent(event)) {
    stats.droppedByPublisherFilter += 1;
    continue;
  }
  stats.decisionAlerts += 1;

  const snapshot = normalizeTelegramSnapshot(event);
  if (!snapshot) {
    stats.contractViolations += 1;
    continue;
  }
  stats.snapshots += 1;

  if (snapshot.type === "UPDATE" && snapshot.update?.cause?.includes("contract violation")) {
    stats.contractViolations += 1;
  }

  const signature = buildTelegramSignature(snapshot);
  const lastSignature = lastSignatureBySymbol.get(snapshot.symbol);
  if (lastSignature && lastSignature === signature) {
    stats.suppressedBySignature += 1;
    continue;
  }
  lastSignatureBySymbol.set(snapshot.symbol, signature);

  if (governor.shouldSend(event, {} as any, 0)) {
    stats.sent += 1;
  } else {
    if (mode === "QUIET" && decisionState !== "UPDATE") {
      stats.suppressedByMode += 1;
    } else {
      stats.suppressedByGovernor += 1;
    }
  }
}

console.log("DecisionState counts:", decisionCounts);
console.log(`Mode: ${mode}`);
console.log(`Events: ${stats.total}`);
console.log(`Decision alerts: ${stats.decisionAlerts}`);
console.log(`Snapshots: ${stats.snapshots}`);
console.log(`Sent: ${stats.sent}`);
console.log(`Suppressed by signature: ${stats.suppressedBySignature}`);
console.log(`Suppressed by mode: ${stats.suppressedByMode}`);
console.log(`Suppressed by governor: ${stats.suppressedByGovernor}`);
console.log(`Dropped by publisher filter: ${stats.droppedByPublisherFilter}`);
console.log(`Contract violations: ${stats.contractViolations}`);
