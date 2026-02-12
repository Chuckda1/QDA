# Architecture Stabilization Audit

## Executive Summary

This audit identifies all architectural violations that allow trade state corruption while IN_TRADE, and provides a comprehensive plan to stabilize the system before evaluating LLM impact or removing IGNITION setup.

**Strategic Insight:** This is the first time the system is being treated like an engine with invariants instead of a pile of features. The real problem is **trade state isolation**, not individual feature logic. Until trade state is isolated, nothing else can be properly evaluated.

**Critical Finding from Logs:**
- Entry at 693.05 with `setup=NONE`, `gate=none`, `waitReason=setup_none`
- Targets collapsed: `T1=693.05 T2=693.05 T3=693.05` (risk=0, stop=entry)
- Telegram shows contradictory state: `entryStatus=active` but `setup=NONE waitReason=setup_none`

**The Real Problem:**
> **Your trade state was not isolated.**

When trade state isn't isolated, nothing else matters. You can't evaluate entry quality, LLM impact, phase logic, or momentum sequencing if the system is mutating its own trade mid-flight.

---

## A) Prioritized List of Architectural Problems

### 🔴 CRITICAL PRIORITY (Trade Integrity Violations)

#### P1: Setup Detection Runs While IN_TRADE
**Severity:** CRITICAL - Corrupts trade state
**Location:** `src/orchestrator/orchestrator.ts:4249`
**Code:**
```typescript
// Line 4226: No IN_TRADE guard
if (exec.setup === "NONE" || !exec.setup || now >= setupTTLExpiry) {
  // ...
  // Line 4249: detectSetup() called WITHOUT checking exec.phase === "IN_TRADE"
  const setupResult = this.detectSetup(exec, lastClosed5m, previous5m, closed5mBars, atr, null);
  
  // Line 4254: onSetupTransition() called WITHOUT checking exec.phase === "IN_TRADE"
  this.onSetupTransition(exec, oldSetup, setupResult.setup, ts);
  
  // Line 4256: exec.setup can be set to "NONE" while IN_TRADE
  exec.setup = setupResult.setup;
}
```
**Impact:** Setup cleared during trade, causing `setup=NONE` while `phase=IN_TRADE`
**Evidence from Logs:** `[SETUP_DETECT_START] bias=BEARISH phase=IN_TRADE` → `[SETUP_DETECT_BLOCKED] reason=phase_not_allowed` → `[CONSISTENCY_CHECK] WARN: PULLBACK_ENTRY entered with setup=NONE`

#### P2: Gate Reset While IN_TRADE
**Severity:** CRITICAL - Corrupts trade state
**Location:** `src/orchestrator/orchestrator.ts:732`
**Code:**
```typescript
private onSetupTransition(...): void {
  // Line 732: Gate reset WITHOUT checking exec.phase === "IN_TRADE"
  exec.resolutionGate = undefined;
  
  // Line 753: waitReason overwritten WITHOUT checking exec.phase === "IN_TRADE"
  if (nextSetup === "NONE") {
    exec.waitReason = "setup_none"; // ❌ Overwrites "in_trade"
  }
  
  // Line 740: Only entry state clearing is guarded
  if (exec.phase !== "IN_TRADE") {
    exec.entryPrice = undefined;
    // ...
  }
}
```
**Impact:** Gate cleared and `waitReason` overwritten during trade
**Evidence from Logs:** `[TELEGRAM_STATE] setup=NONE phase=IN_TRADE waitReason=setup_none`

#### P3: Target Recomputation Can Collapse (Risk=0)
**Severity:** CRITICAL - Corrupts trade management
**Location:** `src/orchestrator/orchestrator.ts:6061-6082`
**Code:**
```typescript
// Line 6061: Targets recomputed on every 5m close while IN_TRADE
if (exec.phase === "IN_TRADE" && exec.entryPrice !== undefined && exec.stopPrice !== undefined && is5mClose) {
  const targetResult = this.computeTargets(
    direction,
    exec.entryPrice,
    exec.stopPrice, // ❌ If this equals entryPrice, risk = 0
    // ...
  );
  exec.targets = targetResult.targets; // ❌ Can be all equal to entry
}
```
**Location:** `src/orchestrator/orchestrator.ts:2554-2569`
**Code:**
```typescript
const risk = Math.abs(entry - stop);
if (!Number.isFinite(risk) || risk <= 0 || atr <= 0) {
  // All targets equal entry
  const basicT1 = direction === "long" ? entry + risk : entry - risk; // = entry (if risk = 0)
  return { targets: [basicT1, basicT2, basicT3] }; // ❌ All equal
}
```
**Impact:** If `stopPrice === entryPrice`, targets collapse to entry, producing R=0.00
**Evidence from Logs:** `[TARGETS_UPDATED] Entry=693.05 R_Targets: T1=693.05 T2=693.05 T3=693.05` and `[TRADE_MANAGEMENT] entry=693.05 stop=693.05`

#### P4: Trade Params Can Be Cleared While IN_TRADE
**Severity:** CRITICAL - Corrupts trade management
**Location:** `src/orchestrator/orchestrator.ts:1390-1416` (`clearTradeState()`)
**Code:**
```typescript
private clearTradeState(exec: MinimalExecutionState): void {
  // Line 1402-1407: Clears trade params WITHOUT checking exec.phase === "IN_TRADE"
  exec.entryPrice = undefined;
  exec.entryTs = undefined;
  exec.stopPrice = undefined;
  exec.targets = undefined;
  exec.entryType = undefined;
  exec.entryTrigger = undefined;
  // ...
}
```
**Called From:**
- Line 6134: Stop hit (✅ Valid - exiting trade)
- Line 6142: Stop hit (✅ Valid - exiting trade)
- Line 6264: Momentum slow exit (✅ Valid - exiting trade)
- Line 6301: Momentum slow exit (✅ Valid - exiting trade)
**Impact:** If called incorrectly, trade params cleared during active trade
**Risk:** Low (only called on exit), but no guard prevents misuse

#### P5: Phase Transitions Can Occur While IN_TRADE
**Severity:** CRITICAL - Corrupts trade state
**Location:** `src/orchestrator/orchestrator.ts:4057-4142` (Phase classification in `reduce5mClose()`)
**Code:**
```typescript
// Line 4057: Phase classification runs WITHOUT checking exec.phase === "IN_TRADE"
} else if ((exec.phase === "BIAS_ESTABLISHED" || exec.phase === "PULLBACK_IN_PROGRESS" || exec.phase === "EXTENSION") && lastClosed5m) {
  // Line 4083-4140: Phase transitions can occur
  if (inZone) {
    exec.phase = "PULLBACK_IN_PROGRESS"; // ❌ Can transition from IN_TRADE
  } else if (extended) {
    exec.phase = "EXTENSION"; // ❌ Can transition from IN_TRADE
  } else {
    exec.phase = "BIAS_ESTABLISHED"; // ❌ Can transition from IN_TRADE
  }
}
```
**Impact:** Phase can transition from IN_TRADE to other phases, corrupting trade state
**Evidence from Logs:** Logs show phase transitions while IN_TRADE (though condition checks `exec.phase === "IN_TRADE"` should prevent this, the check may not be comprehensive)

### 🟡 HIGH PRIORITY (Entry Quality & Observability)

#### P6: Entry Can Occur With setup=NONE
**Severity:** HIGH - Entry quality issue
**Location:** `src/orchestrator/orchestrator.ts:5838-5894` (PULLBACK_ENTRY execution)
**Code:**
```typescript
// Line 5803: Setup validation happens INSIDE entry block
if (exec.setup !== "PULLBACK_CONTINUATION") {
  console.error(`[ENTRY_ABORTED] PULLBACK_ENTRY blocked: setup=${exec.setup ?? "NONE"}`);
  // But entry may have already been partially executed
}
```
**Impact:** Entry can occur with `setup=NONE` if setup is cleared between signal detection and execution
**Evidence from Logs:** `[CONSISTENCY_CHECK] WARN: PULLBACK_ENTRY entered with setup=NONE`

#### P7: Telegram Snapshot Shows Contradictory State
**Severity:** HIGH - Observability issue
**Location:** `src/orchestrator/orchestrator.ts:6599-6613` (effectiveWaitReason derivation)
**Code:**
```typescript
// Line 6599: effectiveWaitReason derived from exec.waitReason
let effectiveWaitReason = exec.waitReason;

// Line 6606: Override logic doesn't check if IN_TRADE
if (effectiveWaitReason === "no_opportunity_latched") {
  effectiveWaitReason = oppReady 
    ? (exec.setup === "NONE" ? "waiting_for_pullback" : "waiting_for_trigger")
    : `opportunity_${exec.opportunity!.status.toLowerCase()}`;
  exec.waitReason = effectiveWaitReason; // ❌ Can overwrite "in_trade"
}
```
**Location:** `src/telegram/telegramNormalizer.ts:182,193`
**Code:**
```typescript
waitFor: event.data.waitFor ?? null, // ❌ Uses exec.waitReason which can be "setup_none" while IN_TRADE
setup, // ❌ Can be "NONE" while IN_TRADE
```
**Impact:** Telegram shows `setup=NONE waitReason=setup_none` even when `entryStatus=active`
**Evidence from Logs:** `[TELEGRAM_STATE] setup=NONE phase=IN_TRADE waitReason=setup_none effectiveWaitReason=setup_none`

#### P8: TRADING_ALERT Filtered by MessageGovernor
**Severity:** HIGH - Observability issue
**Location:** `src/governor/messageGovernor.ts:47-54`
**Code:**
```typescript
private static readonly SENDABLE_TYPES: Set<string> = new Set([
  "MIND_STATE_UPDATED",
  "LLM_1M_OPINION",
  "GATE_ARMED",
  "OPPORTUNITY_TRIGGERED",
  "TRADE_ENTRY",
  "TRADE_EXIT",
  // ❌ TRADING_ALERT is NOT in this list!
]);
```
**Impact:** TP alerts never reach user
**Evidence:** TP alerts emitted but not visible in Telegram

#### P9: Extension Logic Can Persist While Price Continues Against Bias
**Severity:** HIGH - Entry quality issue
**Location:** `src/orchestrator/orchestrator.ts:4096-4128` (Extension phase classification)
**Code:**
```typescript
// Line 4096: EXTENSION set when price past zone
} else if (extended) {
  exec.phase = "EXTENSION";
  if (exec.extendedPhaseSinceTs === undefined) exec.extendedPhaseSinceTs = ts;
  
  // Line 4101: Re-anchor check
  const shouldReanchor = extendedAge >= this.EXTENSION_REANCHOR_MS;
  
  // ❌ No check if price continues against bias (e.g., BEARISH bias, price continues down)
  // Extension can persist even when price is clearly continuing in bias direction
}
```
**Location:** `src/orchestrator/orchestrator.ts:4161-4189` (Boundary re-anchoring)
**Code:**
```typescript
// Line 4161: Re-anchor logic
if (exec.phase === "EXTENSION" && 
    exec.extendedPhaseSinceTs !== undefined &&
    (ts - exec.extendedPhaseSinceTs) >= this.EXTENSION_REANCHOR_MS &&
    lastClosed5m) {
  // Re-anchor boundaries
  // ❌ But doesn't check if price is continuing against bias
}
```
**Impact:** Extension can persist while price continues in bias direction, blocking new setups

#### P10: Sequencing: Entry Signal Detection vs Momentum Gates
**Severity:** HIGH - Entry quality issue
**Location:** `src/orchestrator/orchestrator.ts:5505-5814`
**Code:**
```typescript
// Line 5505: Entry signal detection happens FIRST
const entrySignalFires = exec.resolutionGate?.status === "TRIGGERED" && 
                         exec.opportunity?.status === "TRIGGERED";

// Line 5575: canEnter determined BEFORE momentum check
const canEnter = (isPullback && entrySignalFires) || (isIgnition && ignitionSignal);

// Line 5630: Entry execution block entered
if (canEnter) {
  // Line 5814: Momentum check happens INSIDE entry block
  const momentumCheck = this.momentumConfirmationGate(...);
  
  // Line 5822: If blocked, entry prevented
  if (momentumCheck.blocked) { ... }
}
```
**Impact:** Entry signal can fire before momentum check, allowing entry in poor conditions
**Evidence:** Entry at 694.77 (LONG) that sold off hard - likely entered when price was temporarily above VWAP but fell below immediately after

### 🟢 MEDIUM PRIORITY (Edge Cases & Partial Windows)

#### P11: Target Computation with Partial Windows
**Severity:** MEDIUM - Entry quality issue
**Location:** `src/orchestrator/orchestrator.ts:2591-2620` (Magnet levels with partial windows)
**Code:**
```typescript
// Line 2592: Partial window processing
if (closed5mBars.length >= 6) {
  // Full window
} else if (closed5mBars.length >= 3) {
  // Partial window: use available bars
  console.log(`[PARTIAL_WINDOW] Using ${closed5mBars.length} bars...`);
}
```
**Impact:** Targets computed with insufficient bars may be inaccurate
**Risk:** Low (logging added, but targets may still be suboptimal)

#### P12: ATR Calculation with Partial Windows
**Severity:** MEDIUM - Entry quality issue
**Location:** `src/orchestrator/orchestrator.ts:331-344` (`calculateATR()`)
**Code:**
```typescript
private calculateATR(bars: Array<...>, period: number = 14): number {
  if (bars.length < 2) return 0;
  const recentBars = bars.slice(-period);
  // ❌ If bars.length < period, ATR computed with fewer bars
  // May be less accurate
}
```
**Impact:** ATR may be inaccurate with partial windows, affecting target computation
**Risk:** Low (system handles gracefully, but accuracy reduced)

---

## B) Planning Document: State Ownership & Event Ordering

### B.1 State Field Ownership Model

#### Canonical Owners (Single Source of Truth)

| State Field | Owner | Write Locations | Read-Only For |
|-------------|-------|----------------|---------------|
| `exec.bias` | **Bias Engine** (5m-based) | `finalizeBiasFrom5m()` (line 2219), `updateBiasEngine()` (line 1758) | All other subsystems |
| `exec.phase` | **Phase Classifier** (5m-based) | `reduce5mClose()` phase classification (line 4045-4155) | All other subsystems |
| `exec.setup` | **Setup Detector** (5m-based) | `detectSetup()` (line 1628), `maybeDetectIgnition()` (line 1925) | Entry logic (read-only) |
| `exec.resolutionGate` | **Gate Armer** (5m/1m-based) | `tryArmPullbackGate()` (line 759), `onSetupTransition()` (line 714) | Entry logic (read-only) |
| `exec.opportunity` | **Opportunity Latch** (5m-based) | `latchOpportunity()` (line 986), `checkOpportunityTrigger()` (line 5193) | Entry logic (read-only) |
| `exec.entryPrice` | **Entry Executor** (1m-based) | Entry execution blocks (lines 1575, 5010, 5668, 5701, 5838, 5989) | Trade management (read-only) |
| `exec.stopPrice` | **Entry Executor** (1m-based) | Entry execution blocks (lines 1582, 5017, 5673, 5706, 5852, 6003) | Trade management (read-only) |
| `exec.targets` | **Target Computer** (5m-based) | `computeTargets()` called from entry (lines 1588, 5023, 5676, 5720, 5857, 6010) | Trade management (read-only) |
| `exec.thesisDirection` | **Entry Executor** (1m-based) | Entry execution blocks (lines 5034, 5679, 5734, 5873, 6025) | Trade management (read-only) |
| `exec.entryType` | **Entry Executor** (1m-based) | Entry execution blocks (lines 1579, 5036, 5681, 5703, 5840, 5991) | Trade management (read-only) |
| `exec.waitReason` | **State Resolver** (1m/5m-based) | Multiple locations (lines 753, 1242, 1607, etc.) | Telegram snapshot (read-only) |

#### Trade State Isolation (Immutable Once IN_TRADE)

**Trade Snapshot (Created on Entry):**
```typescript
exec.entrySnapshot = {
  entryPrice: exec.entryPrice,
  stopPrice: exec.stopPrice,
  entryTs: exec.entryTs,
  entryType: exec.entryType,
  entryTrigger: exec.entryTrigger,
  thesisDirection: exec.thesisDirection,
  targets: exec.targets,
  targetZones: exec.targetZones,
  // Immutable once set
};
```

**Invariant:** Once `exec.phase === "IN_TRADE"`, `exec.entrySnapshot` must exist and be immutable. All trade management must use `exec.entrySnapshot`, not `exec.entryPrice`/`exec.stopPrice` directly.

**CRITICAL:** Target recomputation on 5m close (line 6061-6082) currently uses `exec.entryPrice` and `exec.stopPrice` directly. This must be changed to use `exec.entrySnapshot.entryPrice` and `exec.entrySnapshot.stopPrice` to prevent corruption if mutable fields are overwritten. The only exception is `exec.stopPrice` can be moved to breakeven (1R hit), but target recomputation must still use the original snapshot values.

### B.2 Event Ordering Model

#### 1m Tick Processing Order (handleMinimal1m)
```
1. Update forming5mBar (line 4552)
2. Detect rollover (line 4549)
3. Update micro indicators (line 4690-4696)
4. Deployment pause check (line 4699-4761)
5. Update bias engine (1m-based) (line 1758)
6. LLM 1m call (if conditions met) (line 4681)
7. Entry evaluation (if not paused) (line 5170-6054)
   a. Opportunity/gate readiness check
   b. Entry signal detection
   c. Momentum check
   d. Entry execution
8. Trade management (if IN_TRADE) (line 6084-6308)
   a. Stop/target checks
   b. Target recomputation (on 5m close)
9. Event emission (line 6314-6422)
```

#### 5m Close Processing Order (reduce5mClose)
```
1. Apply LLM bias (if available) (line 3962-3974)
2. Phase classification (line 4045-4155)
   ❌ VIOLATION: Can transition from IN_TRADE
3. Setup detection (line 4226-4283)
   ❌ VIOLATION: Runs while IN_TRADE
4. Opportunity latch management (line 4285-4350)
5. Gate arming (line 4344-4448)
6. Consistency checks (line 4283-4537)
7. Diagnostics (line 4531-4562)
```

**Required Ordering:**
1. **Phase classification** must check `exec.phase === "IN_TRADE"` and skip if IN_TRADE
2. **Setup detection** must check `exec.phase === "IN_TRADE"` and skip if IN_TRADE
3. **Gate arming** must check `exec.phase === "IN_TRADE"` and skip if IN_TRADE
4. **Trade management** must run AFTER all setup/bias logic

### B.3 Trade State Isolation Strategy

#### Isolation Boundaries

**Pre-Entry State (Mutable):**
- `exec.bias`, `exec.phase`, `exec.setup`, `exec.resolutionGate`, `exec.opportunity`
- Can be modified by bias engine, phase classifier, setup detector, gate armer

**Entry State (Immutable Once Set):**
- `exec.entrySnapshot` (created on entry)
- `exec.phase = "IN_TRADE"` (only trade management can transition out)

**Post-Entry State (Trade Management Only):**
- `exec.targets`, `exec.targetZones` (can be recomputed, but must use `entrySnapshot`)
- `exec.stopPrice` (can be moved to breakeven on 1R hit)
- `exec.targetsHit`, `exec.t1HitAt`, `exec.barsSince1R` (trade tracking)

#### Isolation Enforcement

**Guard Pattern:**
```typescript
// In all setup/bias/gate logic
if (exec.phase === "IN_TRADE") {
  console.log(`[SKIP] phase=IN_TRADE - skipping ${operationName}`);
  return; // Skip operation
}

// In trade management
if (exec.phase === "IN_TRADE" && exec.entrySnapshot) {
  // Use entrySnapshot, not exec.entryPrice/stopPrice directly
  const entryPrice = exec.entrySnapshot.entryPrice;
  const stopPrice = exec.entrySnapshot.stopPrice;
  // ...
}
```

---

## C) Staged Implementation Plan

### Phase 1: Trade Integrity (CRITICAL - Must Complete First)

#### Stage 1.1: Add IN_TRADE Guards to Setup Detection
**Goal:** Prevent setup detection from running while IN_TRADE
**Files:** `src/orchestrator/orchestrator.ts`
**Changes:**
1. Add guard in `reduce5mClose()` before setup detection (line 4226)
2. Add guard in `detectSetup()` to return current setup if IN_TRADE (line 1628)
3. Add guard in setup invalidation (line 4201)

**Validation:**
- Log: `[SETUP_DETECT_SKIP] phase=IN_TRADE`
- Assert: `exec.setup` unchanged while IN_TRADE

#### Stage 1.2: Add IN_TRADE Guards to Gate Reset
**Goal:** Prevent gate reset while IN_TRADE
**Files:** `src/orchestrator/orchestrator.ts`
**Changes:**
1. Add guard in `onSetupTransition()` before gate reset (line 732)
2. Add guard before `waitReason` overwrite (line 753)

**Validation:**
- Log: `[GATE_RESET_SKIP] phase=IN_TRADE`
- Assert: `exec.resolutionGate` unchanged while IN_TRADE
- Assert: `exec.waitReason === "in_trade"` while IN_TRADE

#### Stage 1.3: Create Entry Snapshot on Trade Entry
**Goal:** Make trade params immutable once IN_TRADE
**Files:** `src/orchestrator/orchestrator.ts`, `src/types.ts`
**Changes:**
1. Add `entrySnapshot` field to `MinimalExecutionState` type
2. Create snapshot on all entry execution points (lines 1575, 5010, 5668, 5701, 5838, 5989)
3. Guard trade param mutations with entry snapshot

**Validation:**
- Assert: `exec.entrySnapshot` exists when `exec.phase === "IN_TRADE"`
- Assert: `exec.entrySnapshot` immutable (no mutations)

#### Stage 1.4: Guard Phase Transitions While IN_TRADE
**Goal:** Prevent phase transitions from IN_TRADE
**Files:** `src/orchestrator/orchestrator.ts`
**Changes:**
1. Add guard in phase classification (line 4057) to skip if IN_TRADE
2. Ensure only trade management can transition OUT of IN_TRADE

**Validation:**
- Log: `[PHASE_CLASSIFY_SKIP] phase=IN_TRADE`
- Assert: `exec.phase === "IN_TRADE"` unchanged by phase classifier

#### Stage 1.5: Fix Target Collapse (Risk=0) + Use EntrySnapshot for Recomputation
**Goal:** Prevent targets from collapsing when risk=0 AND ensure recomputation uses immutable snapshot
**Files:** `src/orchestrator/orchestrator.ts`
**Changes:**
1. Validate `Math.abs(entry - stop) > 0.1 * atr` before entry
2. **CRITICAL:** Use `entrySnapshot` for target recomputation (NOT `exec.entryPrice`/`stopPrice`)
   - Current code (line 6068-6069) uses `exec.entryPrice` and `exec.stopPrice` directly
   - Must change to: `exec.entrySnapshot.entryPrice` and `exec.entrySnapshot.stopPrice`
   - This prevents corruption if mutable fields are overwritten
3. Guard against `stopPrice === entryPrice` in trade management
4. Only allow `exec.stopPrice` mutation for breakeven moves (1R hit), but recompute targets from snapshot

**Validation:**
- Assert: `exec.targets[0] !== exec.entryPrice` (targets not equal to entry)
- Assert: `Math.abs(exec.entrySnapshot.entryPrice - exec.entrySnapshot.stopPrice) > 0.1 * atr`
- Assert: Target recomputation always uses `exec.entrySnapshot.entryPrice` and `exec.entrySnapshot.stopPrice`
- Log: `[TARGETS_RECOMPUTED] using entrySnapshot entry=${entrySnapshot.entryPrice} stop=${entrySnapshot.stopPrice}`

### Phase 2: Entry Quality (After Trade Integrity)

#### Stage 2.1: Fix Sequencing (Momentum Check Before Entry Signal)
**Goal:** Prevent entry when momentum is poor
**Files:** `src/orchestrator/orchestrator.ts`
**Changes:**
1. Move momentum check BEFORE entry signal detection (line 5505)
2. Block entry signal if momentum check fails

**Validation:**
- Assert: Momentum check runs before `canEnter` determination
- Log: `[ENTRY_BLOCKED] reason=momentum_below_vwap` before entry signal fires

#### Stage 2.2: Fix Telegram Snapshot Priority
**Goal:** Prioritize IN_TRADE state in Telegram snapshot
**Files:** `src/orchestrator/orchestrator.ts`
**Changes:**
1. Create `resolveEffectiveWaitReason()` function
2. Prioritize `"in_trade"` when `exec.phase === "IN_TRADE"`
3. Override `setup` field if IN_TRADE

**Validation:**
- Assert: `waitFor === "in_trade"` when `entryStatus === "active"`
- Assert: `setup !== "NONE"` when `entryStatus === "active"` (or show entry type)

#### Stage 2.3: Add TRADING_ALERT to MessageGovernor
**Goal:** Allow TP alerts to reach user
**Files:** `src/governor/messageGovernor.ts`
**Changes:**
1. Add `"TRADING_ALERT"` to `SENDABLE_TYPES` (line 47)

**Validation:**
- Assert: TP alerts visible in Telegram

### Phase 3: IGNITION Removal (After Invariants Fixed)

#### Stage 3.1: Identify All IGNITION References
**Files to Audit:**
- `src/orchestrator/orchestrator.ts:1925` - `maybeDetectIgnition()`
- `src/orchestrator/orchestrator.ts:5334-5390` - BREAK_TRIGGER_SETUP (creates IGNITION)
- `src/orchestrator/orchestrator.ts:5518-5531` - IGNITION expiration
- `src/orchestrator/orchestrator.ts:5560-5614` - IGNITION signal detection
- `src/orchestrator/orchestrator.ts:5694-5749` - IGNITION_ENTRY execution
- `src/orchestrator/orchestrator.ts:6682-6683, 6777-6778` - Coaching filtering (IGNITION references)

**Changes:**
1. Remove `maybeDetectIgnition()` call (line 4875)
2. Remove BREAK_TRIGGER_SETUP logic (lines 5334-5390)
3. Remove IGNITION signal detection (lines 5560-5614)
4. Remove IGNITION_ENTRY execution (lines 5694-5749)
5. Update coaching filtering to remove IGNITION references (lines 6682-6683, 6777-6778)
6. Remove IGNITION constants (lines 100-106)

**Validation:**
- Assert: No `exec.setup === "IGNITION"` after removal
- Assert: System continues to trade using PULLBACK_CONTINUATION only

### Phase 4: LLM Impact Evaluation (After Stabilization)

#### Stage 4.1: Add Shadow Mode Instrumentation
**Goal:** Track LLM impact without changing behavior
**Files:** `src/orchestrator/orchestrator.ts`
**Changes:**
1. Add `exec.llmBiasProposal` field (shadow mode)
2. Log LLM bias proposals vs canonical bias
3. Track bias flips caused by LLM vs bias engine

**Validation:**
- Log: `[LLM_BIAS_PROPOSAL] llmBias=${proposal} canonicalBias=${exec.bias} applied=${applied}`
- Metrics: LLM bias proposal acceptance rate, bias flip correlation

---

## D) Test Plan

### D.1 Minimal Reproduction Scenario Tests

#### Test T1: IN_TRADE Corruption Reproduction
**Scenario:**
1. Bot enters trade: `exec.phase = "IN_TRADE"`, `exec.setup = "PULLBACK_CONTINUATION"`
2. 5m close triggers `reduce5mClose()`
3. Setup detection runs (should be skipped)
4. Gate reset occurs (should be skipped)
5. Verify state not corrupted

**Test Code:**
```typescript
test("setup detection should not corrupt IN_TRADE state", async () => {
  // 1. Enter trade
  exec.phase = "IN_TRADE";
  exec.setup = "PULLBACK_CONTINUATION";
  exec.waitReason = "in_trade";
  exec.resolutionGate = { status: "TRIGGERED", ... };
  
  // 2. 5m close triggers reduce5mClose()
  await orchestrator.processTick({...}, "5m");
  
  // 3. Verify state not corrupted
  expect(exec.phase).toBe("IN_TRADE");
  expect(exec.setup).toBe("PULLBACK_CONTINUATION"); // Should not be "NONE"
  expect(exec.waitReason).toBe("in_trade"); // Should not be "setup_none"
  expect(exec.resolutionGate).toBeDefined(); // Should not be undefined
});
```

#### Test T2: Target Collapse Prevention
**Scenario:**
1. Bot enters trade: `exec.entryPrice = 693.05`, `exec.stopPrice = 693.05` (risk=0)
2. Target computation runs
3. Verify targets don't collapse

**Test Code:**
```typescript
test("targets should not collapse when risk=0", () => {
  const result = orchestrator.computeTargets("long", 693.05, 693.05, 1.0, bars, vwap);
  // Should either:
  // 1. Return error/undefined (entry validation failed)
  // 2. Use minimum risk (0.1 * atr) instead of 0
  expect(result.targets[0]).not.toBe(693.05);
  expect(result.targets[0]).not.toBe(result.targets[1]);
});
```

#### Test T3: Entry Snapshot Immutability
**Scenario:**
1. Bot enters trade: `exec.entrySnapshot` created
2. Setup detection runs (should not modify snapshot)
3. Gate reset occurs (should not modify snapshot)
4. Verify snapshot unchanged

**Test Code:**
```typescript
test("entrySnapshot should be immutable while IN_TRADE", () => {
  exec.phase = "IN_TRADE";
  exec.entrySnapshot = { entryPrice: 693.05, stopPrice: 692.00, ... };
  const originalSnapshot = { ...exec.entrySnapshot };
  
  // Setup detection runs
  orchestrator.reduce5mClose(...);
  
  // Verify snapshot unchanged
  expect(exec.entrySnapshot).toEqual(originalSnapshot);
});
```

### D.2 Regression Tests

#### Test R1: Valid Setup Detection Still Works
**Scenario:**
1. Bot not in trade: `exec.phase = "PULLBACK_IN_PROGRESS"`
2. Setup detection runs
3. Verify setup detected correctly

**Test Code:**
```typescript
test("setup detection should work when not IN_TRADE", () => {
  exec.phase = "PULLBACK_IN_PROGRESS";
  exec.setup = "NONE";
  
  const result = orchestrator.detectSetup(...);
  
  expect(result.setup).toBe("PULLBACK_CONTINUATION"); // Should detect setup
});
```

#### Test R2: Valid Entry Still Works
**Scenario:**
1. All entry conditions met: bias, phase, setup, gate, momentum
2. Entry executes
3. Verify entry state set correctly

**Test Code:**
```typescript
test("entry should execute when all conditions met", () => {
  exec.bias = "BULLISH";
  exec.phase = "PULLBACK_IN_PROGRESS";
  exec.setup = "PULLBACK_CONTINUATION";
  exec.resolutionGate = { status: "TRIGGERED", ... };
  exec.opportunity = { status: "TRIGGERED", ... };
  
  await orchestrator.processTick({...}, "1m");
  
  expect(exec.phase).toBe("IN_TRADE");
  expect(exec.entrySnapshot).toBeDefined();
  expect(exec.entryPrice).toBeDefined();
});
```

### D.3 Observability/Logging Plan

#### Log Assertions

**Invariant T1: Setup Detection Skip**
```
[SETUP_DETECT_SKIP] phase=IN_TRADE - skipping setup detection
```

**Invariant T2: Gate Reset Skip**
```
[GATE_RESET_SKIP] phase=IN_TRADE - preserving gate state
```

**Invariant T3: waitReason Preservation**
```
[WAITREASON_PRESERVED] phase=IN_TRADE waitReason=in_trade (not overwritten)
```

**Invariant T4: Entry Snapshot Created**
```
[ENTRY_SNAPSHOT_CREATED] entryPrice=${entryPrice} stopPrice=${stopPrice} targets=[${targets}]
```

**Invariant T5: Phase Transition Blocked**
```
[PHASE_CLASSIFY_SKIP] phase=IN_TRADE - skipping phase classification
```

#### Consistency Check Assertions

**No Contradictory State:**
```
[CONSISTENCY_CHECK] phase=IN_TRADE setup=PULLBACK_CONTINUATION gate=TRIGGERED entry=active entryType=PULLBACK_ENTRY
```
Should NEVER show: `phase=IN_TRADE setup=NONE gate=none entry=active`

**No Target Collapse:**
```
[TARGETS_UPDATED] Entry=693.05 R_Targets: T1=692.00 T2=691.00 T3=690.00
```
Should NEVER show: `T1=693.05 T2=693.05 T3=693.05`

**No Risk=0:**
```
[ENTRY_VALIDATION] entryPrice=693.05 stopPrice=692.00 risk=1.05 atr=1.0 riskRatio=1.05
```
Should NEVER show: `risk=0` or `riskRatio=0`

---

## E) IGNITION Removal Plan

### E.1 IGNITION References Inventory

**Setup Detection:**
- `src/orchestrator/orchestrator.ts:1925-2003` - `maybeDetectIgnition()`
- Called from: `src/orchestrator/orchestrator.ts:4875`

**Setup Creation from BREAK Trigger:**
- `src/orchestrator/orchestrator.ts:5334-5390` - BREAK_TRIGGER_SETUP logic
- Creates IGNITION setup when BREAK trigger fires

**IGNITION Expiration:**
- `src/orchestrator/orchestrator.ts:5518-5531` - IGNITION TTL check

**IGNITION Signal Detection:**
- `src/orchestrator/orchestrator.ts:5560-5614` - `ignitionSignal` logic

**IGNITION Entry Execution:**
- `src/orchestrator/orchestrator.ts:5694-5749` - IGNITION_ENTRY execution

**Coaching Filtering:**
- `src/orchestrator/orchestrator.ts:6682-6683` - IGNITION in coaching filter
- `src/orchestrator/orchestrator.ts:6777-6778` - IGNITION in coaching filter

**Constants:**
- `src/orchestrator/orchestrator.ts:100-106` - IGNITION constants

### E.2 Removal Strategy

**Step 1: Remove IGNITION Detection**
- Remove `maybeDetectIgnition()` call (line 4875)
- Remove `maybeDetectIgnition()` function (lines 1925-2003)
- Remove IGNITION constants (lines 100-106)

**Step 2: Remove BREAK_TRIGGER_SETUP**
- Remove BREAK trigger → IGNITION setup creation (lines 5334-5390)
- BREAK triggers should not create setups (or create PULLBACK_CONTINUATION instead)

**Step 3: Remove IGNITION Entry Path**
- Remove IGNITION signal detection (lines 5560-5614)
- Remove IGNITION_ENTRY execution (lines 5694-5749)
- Remove IGNITION expiration check (lines 5518-5531)

**Step 4: Update Coaching Filtering**
- Remove IGNITION references from coaching filters (lines 6682-6683, 6777-6778)
- Update to only check `PULLBACK_CONTINUATION`

**Step 5: Update Type Definitions**
- Remove `"IGNITION"` from `SetupType` if it's a union type
- Update any type guards that check for IGNITION

### E.3 Validation After Removal

**Assertions:**
- `exec.setup` should never be `"IGNITION"`
- `exec.entryType` should never be `"IGNITION_ENTRY"`
- System should continue trading using `PULLBACK_CONTINUATION` only
- No references to IGNITION in logs (except removal logs)

**Regression Tests:**
- Valid PULLBACK_CONTINUATION setups still work
- Entry quality improves (no "chase entries")
- R:R ratios improve (better timing)

---

## Summary

### Critical Path
1. **Phase 1 (Trade Integrity)** - MUST complete first
   - Add IN_TRADE guards to setup detection, gate reset, phase classification
   - Create entry snapshot on trade entry
   - Fix target collapse (risk=0)

2. **Phase 2 (Entry Quality)** - After Phase 1
   - Fix sequencing (momentum check before entry signal)
   - Fix Telegram snapshot priority
   - Add TRADING_ALERT to MessageGovernor

3. **Phase 3 (IGNITION Removal)** - After Phase 2
   - Remove all IGNITION references
   - Ensure system continues trading with PULLBACK_CONTINUATION only

4. **Phase 4 (LLM Evaluation)** - After Phase 3
   - Add shadow mode instrumentation
   - Evaluate LLM impact on bias/phase churn

### Success Criteria
- ✅ No setup detection while IN_TRADE
- ✅ No gate reset while IN_TRADE
- ✅ No waitReason overwrite while IN_TRADE
- ✅ Trade params immutable once IN_TRADE (entrySnapshot pattern)
- ✅ **Target recomputation uses entrySnapshot, not mutable exec.entryPrice/stopPrice**
- ✅ Targets never collapse (risk > 0)
- ✅ Telegram snapshot shows consistent state
- ✅ IGNITION removed, system trades with PULLBACK_CONTINUATION only
- ✅ Entry quality improves (no "chase entries")

---

## Strategic Validation & Final Verdict

### Why This Order Matters

**1. Trade Integrity First**
Without isolated trade state, you cannot evaluate:
- Entry quality (was it a bad setup or corruption?)
- LLM impact (was bias stable or corrupted?)
- Phase logic (was phase correct or overwritten?)
- Momentum sequencing (was entry valid or premature?)

**2. IGNITION Removal After**
Removing IGNITION before fixing invariants would:
- Reduce corrupted trades but not eliminate them
- Make debugging harder (fewer examples)
- Not address root cause

**3. LLM Evaluation Last**
Only after trade state is isolated can you:
- Measure LLM's true impact on bias/phase
- Determine if LLM causes churn or improves timing
- Make data-driven decisions about LLM authority

### What Changes After Phase 1

**You can finally answer:**
- "Was the 694.77 long actually a bad setup, or did corruption make it look bad?"
- "Was LLM flip affecting bias, or was bias stable and entry logic flawed?"
- "Is entry quality poor, or is state corruption masking good entries?"

**Right now, you cannot answer those questions. After Phase 1, you can.**

### The 5 Non-Negotiable Invariants

1. ✅ **Setup Detection MUST NOT Run While IN_TRADE** (architectural contamination)
2. ✅ **Gate Reset Must Be Disabled While IN_TRADE** (structural violation)
3. ✅ **Entry Snapshot Must Be Immutable** (biggest maturity step - transforms "live wires" to "frozen snapshot")
4. ✅ **Phase Classification Must Skip While IN_TRADE** (inverted ownership fix - execution owns trade, not context)
5. ✅ **Fix Risk = 0 Immediately** (engine reliability - not optional)

### IGNITION Removal Justification

**Why IGNITION is structurally flawed:**
- IGNITION is "break and chase" (liquidity sweep breakout failures)
- Worst R:R (enters at structural extremes)
- Depends heavily on momentum continuation
- Extremely sensitive to regime shifts

**Example from logs:**
- Entry 694.77 (LONG)
- Quick pop to 695 (~0.50 move)
- Then dump hard

This is a classic liquidity sweep breakout failure.

**Removing IGNITION:**
- Simplifies system (removes sequencing race conditions)
- Removes early FOMO entries
- Makes system slower but higher quality
- Aligns with goal: "Best moves with best direction and best price movement"

**Not:** "Price moves 50 cents then collapses."

### Critical Clarification: Target Recomputation

**CRITICAL:** Target recomputation on 5m close (line 6061-6082) currently uses:
```typescript
exec.entryPrice,  // ❌ Mutable, can be corrupted
exec.stopPrice,   // ❌ Mutable, can be corrupted
```

**Must change to:**
```typescript
exec.entrySnapshot.entryPrice,  // ✅ Immutable
exec.entrySnapshot.stopPrice,   // ✅ Immutable
```

**Exception:** `exec.stopPrice` can be moved to breakeven (1R hit), but target recomputation must still use the original snapshot values.

**Why this matters:**
If `exec.entryPrice` or `exec.stopPrice` get mutated (corrupted), recomputation will inherit that corruption. Using `entrySnapshot` ensures targets are always computed from the original, immutable entry parameters.

---

**End of Audit**

**Final Verdict:** ✅ **Architecturally Sound**
- Priority order is correct
- IGNITION removal is justified
- Isolation model is correct
- Snapshot model is necessary
- This is the right direction: treating the system like an engine with invariants, not a pile of features
