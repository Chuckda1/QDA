/**
 * Tests for Breakdown Impulse Family:
 * 1) Trigger hit with gate undefined → gate created, entry can execute
 * 2) Trigger hit then phase EXTENSION → entry allowed within impulse window
 * 3) Chase protection: price > k×ATR beyond trigger → block with reason
 * 4) Long mirror: same logic for breakout above prior high
 */
import assert from "node:assert/strict";
import type { MinimalExecutionState, OpportunityLatch, ResolutionGate } from "../src/types.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";

const ts = Date.now();
const fiveMinMs = 5 * 60 * 1000;

function makeExec(overrides: Partial<MinimalExecutionState> = {}): MinimalExecutionState {
  return {
    bias: "BEARISH",
    phase: "BIAS_ESTABLISHED",
    setup: "PULLBACK_CONTINUATION",
    pullbackHigh: 696,
    pullbackLow: 692,
    resolutionGate: undefined,
    opportunity: undefined,
    entryBlocked: false,
    ...overrides,
  };
}

function makeBreakOpportunity(triggerPrice: number, side: "LONG" | "SHORT" = "SHORT"): OpportunityLatch {
  return {
    status: "TRIGGERED",
    side,
    biasAtLatch: "BEARISH",
    phaseAtLatch: "BIAS_ESTABLISHED",
    setupAtLatch: "PULLBACK_CONTINUATION",
    latchedAtTs: ts - 2 * 60 * 1000,
    expiresAtTs: ts + 45 * 60 * 1000,
    zone: { low: 692, high: 696 },
    trigger: { type: "BREAK", price: triggerPrice, description: "break of prior low" },
    stop: { price: 696 + 0.5, reason: "pullback_level_buffer" },
    armedAtPrice: 694,
  };
}

function makeTriggeredGate(triggerPrice: number, armedTs: number, direction: "long" | "short" = "short"): ResolutionGate {
  return {
    status: "TRIGGERED",
    direction,
    triggerPrice,
    stopPrice: direction === "short" ? 696.5 : 691.5,
    expiryTs: armedTs + 2 * 5 * 60 * 1000,
    armedTs,
    reason: `Breakdown trigger fired at ${triggerPrice}`,
  };
}

// Access private method for testing (Orchestrator instance)
const orch = new Orchestrator("test-instance");
const isBreakImpulseEligible = (exec: MinimalExecutionState, t: number) =>
  (orch as any).isBreakImpulseEligible(exec, t);
const checkBreakImpulseChase = (exec: MinimalExecutionState, close: number, atr: number) =>
  (orch as any).checkBreakImpulseChase(exec, close, atr);

// 1) Trigger hit with gate undefined → after fix, gate must exist (simulated: we assert eligible when gate is created)
console.log("Test 1: Break impulse eligible when gate TRIGGERED and within window");
{
  const exec = makeExec({
    opportunity: makeBreakOpportunity(693),
    resolutionGate: makeTriggeredGate(693, ts - 1 * 60 * 1000),
  });
  assert.equal(exec.resolutionGate?.status, "TRIGGERED", "Gate must be TRIGGERED");
  assert.ok(isBreakImpulseEligible(exec, ts), "Should be eligible within 5m window");
}

// 2) Phase EXTENSION with gate TRIGGERED and within window → eligible
console.log("Test 2: EXTENSION phase but impulse within window → eligible");
{
  const exec = makeExec({
    phase: "EXTENSION",
    opportunity: makeBreakOpportunity(693),
    resolutionGate: makeTriggeredGate(693, ts - 2 * 60 * 1000),
  });
  assert.ok(isBreakImpulseEligible(exec, ts), "Should be eligible in EXTENSION within window");
}

// 3) Chase: price beyond trigger + k×ATR → block
console.log("Test 3: Chase protection blocks when distance > k×ATR");
{
  const triggerPrice = 693;
  const atr = 1.0;
  const exec = makeExec({
    opportunity: makeBreakOpportunity(triggerPrice),
    resolutionGate: makeTriggeredGate(triggerPrice, ts),
  });
  // SHORT: triggerPrice - close = distance in trade direction. If close = 691, dist = 2 > 0.8*ATR
  const closeFar = 690.5;
  const chase = checkBreakImpulseChase(exec, closeFar, atr);
  assert.ok(!chase.allowed && chase.reason?.includes("chase_limit"), "Should block when chased");
}

// 4) Within chase limit → allowed
console.log("Test 4: Within chase limit → allowed");
{
  const triggerPrice = 693;
  const atr = 1.0;
  const exec = makeExec({
    opportunity: makeBreakOpportunity(triggerPrice),
    resolutionGate: makeTriggeredGate(triggerPrice, ts),
  });
  const closeOk = 692.5; // 0.5 below trigger < 0.8*ATR
  const chase = checkBreakImpulseChase(exec, closeOk, atr);
  assert.ok(chase.allowed === true, "Should allow when within chase limit");
}

// 5) Impulse window expired → not eligible
console.log("Test 5: Impulse window expired → not eligible");
{
  const windowMs = 5 * 60 * 1000;
  const exec = makeExec({
    phase: "EXTENSION",
    opportunity: makeBreakOpportunity(693),
    resolutionGate: makeTriggeredGate(693, ts - windowMs - 60000), // armed 6+ min ago
  });
  assert.ok(!isBreakImpulseEligible(exec, ts), "Should not be eligible after window");
}

// 6) Long mirror: LONG breakout gate
console.log("Test 6: Long mirror - breakout gate direction long");
{
  const exec = makeExec({
    bias: "BULLISH",
    opportunity: { ...makeBreakOpportunity(697, "LONG"), side: "LONG" },
    resolutionGate: makeTriggeredGate(697, ts - 1 * 60 * 1000, "long"),
  });
  exec.resolutionGate!.direction = "long";
  const closeLong = 697.5; // slightly above trigger, within 0.8*ATR
  const atr = 1.0;
  const chase = checkBreakImpulseChase(exec, closeLong, atr);
  assert.ok(chase.allowed === true, "Long: within chase limit above trigger");
  const closeChased = 698.5; // 1.5 above trigger > 0.8*ATR
  const chase2 = checkBreakImpulseChase(exec, closeChased, atr);
  assert.ok(!chase2.allowed && chase2.reason?.includes("chase_limit"), "Long: chase blocks when too far above");
}

console.log("All breakdown impulse tests passed.");
process.exit(0);
