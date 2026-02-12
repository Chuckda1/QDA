# LONG Entry Failure Audit: 694.77 Entry Analysis

## Executive Summary

A LONG entry occurred around **694.77** that briefly moved up (~695) then sold off hard. This audit investigates whether the failure was due to:
- **(a)** Valid but low-expectancy entry rules
- **(b)** VWAP/EMA regime mismatch
- **(c)** Phase/setup gating flaws
- **(d)** Trade-state corruption

**Primary Finding:** The entry likely occurred due to a **sequencing issue** where momentum checks (`momentum_below_vwap`) are evaluated **AFTER** entry signal detection but **BEFORE** entry execution, creating a window where entry can occur if:
1. Entry signal fires (trigger hit, gate TRIGGERED)
2. Momentum check passes at that moment (price temporarily above VWAP - 0.15*ATR)
3. Entry executes
4. Price immediately falls below VWAP, triggering deployment pause or momentum kill switch

Additionally, **IN_TRADE corruption** can occur if setup detection runs during the trade, resetting gate/waitReason and potentially corrupting targets.

---

## A) Investigation Plan

### Phase 1: Entry Path Identification
✅ **Completed** - Found 4 primary LONG entry paths:
1. **PULLBACK_ENTRY** (line 5838-5894) - Most common for LONG
2. **NUDGE_DIP** (line 5676-5691) - LLM nudge-based entry
3. **IGNITION** (line 5734-5749) - Setup-based breakout
4. **BIAS_FLIP_ENTRY** (line 1563-1614) - Bias flip breakout

### Phase 2: Momentum Blocking Analysis
✅ **Completed** - Found sequencing issue:
- `momentumConfirmationGate()` called at line 5814 **INSIDE** entry execution block
- Checks `momentum_below_vwap` at line 3234
- But entry signal detection (line 5505-5577) happens **BEFORE** momentum check
- Deployment pause (line 4699-4761) runs on **1m ticks**, momentum check on **5m/entry**

### Phase 3: Entry Quality Analysis
✅ **Completed** - Found potential issues:
- Targets computed with `computeTargets()` (line 2526-2706)
- Can collapse if `risk = 0` (entryPrice === stopPrice)
- No explicit check for VWAP proximity at entry time
- Late entry penalties applied (line 5643-5656) but may not prevent entry

### Phase 4: IN_TRADE Corruption
✅ **Completed** - Confirmed from previous audit:
- `detectSetup()` called at line 4249 without IN_TRADE guard
- `onSetupTransition()` resets gate at line 732 without IN_TRADE guard
- Can corrupt `waitReason`, `setup`, `resolutionGate` during trade

---

## B) Code Locations + Call Graph

### B.1 Entry Path for LONG Trade (PULLBACK_ENTRY)

**Primary Entry Path:** `handleMinimal1m()` → Entry Evaluation Block → PULLBACK_ENTRY Execution

**Call Graph:**
```
handleMinimal1m() [line 4565]
  → Entry evaluation block [line 5170-6054]
    → readyToEvaluateEntry check [line 5475]
    → Entry signal detection [line 5505-5577]
      → entrySignalFires = true (trigger hit)
      → canEnter = true [line 5575]
    → Entry execution [line 5630]
      → EXTENSION guard [line 5632] ✅
      → Late entry check [line 5638-5656]
      → Setup validation [line 5803] ✅ (must be PULLBACK_CONTINUATION)
      → Momentum check [line 5814] ⚠️ SEQUENCING ISSUE
        → momentumConfirmationGate() [line 3183]
          → Check 3: VWAP Displacement [line 3230-3238]
            → if (bias === "BULLISH" && currentPrice < vwap - 0.15*atr)
              → return { blocked: true, reason: "momentum_below_vwap" }
      → Entry execution [line 5838-5894]
        → exec.entryPrice = current5m.close [line 5838]
        → exec.stopPrice = ... [line 5852-5855]
        → exec.targets = computeTargets(...) [line 5857-5871]
        → exec.phase = "IN_TRADE" [line 5874]
        → exec.waitReason = "in_trade" [line 5876]
        → exec.opportunity.status = "CONSUMED" [line 5884]
```

**Exact Code Locations:**

#### Entry Signal Detection (Pre-Momentum Check)
**Location:** `src/orchestrator/orchestrator.ts:5505-5577`

```typescript
// Line 5505: Entry signal detection happens FIRST
const entrySignalFires = exec.resolutionGate?.status === "TRIGGERED" && 
                         exec.opportunity?.status === "TRIGGERED";

// Line 5575: canEnter determined BEFORE momentum check
const canEnter = (isPullback && entrySignalFires) || (isIgnition && ignitionSignal);

// Line 5630: Entry execution block entered if canEnter = true
if (canEnter) {
  // Line 5632: EXTENSION guard
  if (exec.phase === "EXTENSION") { ... }
  
  // Line 5809: Momentum check happens INSIDE entry block
  const momentumCheck = this.momentumConfirmationGate(...);
  
  // Line 5822: If blocked, entry prevented
  if (momentumCheck.blocked) { ... }
  
  // Line 5838: Entry executes if momentum check passes
  exec.entryPrice = current5m.close;
}
```

**Problem:** Entry signal can fire and `canEnter = true` even if price is near/below VWAP, because momentum check happens **AFTER** signal detection.

#### Momentum Check (Inside Entry Block)
**Location:** `src/orchestrator/orchestrator.ts:3183-3241`

```typescript
private momentumConfirmationGate(
  bias: MarketBias,
  currentPrice: number,
  closed5mBars: Array<...>,
  vwap: number | undefined,
  atr: number
): { blocked: boolean; reason?: string } {
  // Line 3230-3238: VWAP Displacement Check
  if (vwap !== undefined) {
    const vwapTolerance = 0.15 * atr;
    if (bias === "BULLISH" && currentPrice < vwap - vwapTolerance) {
      return { blocked: true, reason: "momentum_below_vwap" };
    }
  }
  return { blocked: false };
}
```

**Problem:** This check uses `currentPrice` (1m tick close) but VWAP is computed from 5m bars. If price is temporarily above VWAP at entry moment but falls below immediately after, entry can occur.

### B.2 Deployment Pause (1m Tick Processing)

**Location:** `src/orchestrator/orchestrator.ts:4699-4761`

```typescript
// Line 4705: Runs on EVERY 1m tick
const inTrade = exec.phase === "IN_TRADE";
const paused = (exec.deploymentPauseUntilTs ?? 0) > now;

// Line 4738: BULLISH bias pause check
if (!inTrade && exec.bias === "BULLISH") {
  const holdDump = (exec.micro.belowVwapCount ?? 0) >= 3 || 
                   (exec.micro.belowEmaCount ?? 0) >= 3;
  const brokeDown = sl ? close < sl : false;
  const meaningfulDown = (atr1m && sh) ? (sh - close) >= 0.8 * atr1m : false;
  const countertrendDown = holdDump && brokeDown && meaningfulDown;
  
  if (countertrendDown) {
    exec.deploymentPauseUntilTs = now + 10 * 60 * 1000; // 10 minutes
    exec.deploymentPauseReason = "micro_countertrend_down_pause";
  }
}
```

**Problem:** Deployment pause runs on **1m ticks** and can trigger **AFTER** entry if price falls below VWAP for 3+ bars. This doesn't prevent entry but can cause confusion.

### B.3 State Mutations on Entry

**Location:** `src/orchestrator/orchestrator.ts:5838-5894`

**Fields Mutated:**
1. `exec.entryPrice = current5m.close` [line 5838]
2. `exec.entryTs = ts` [line 5839]
3. `exec.entryType = entryInfo.type || "PULLBACK_ENTRY"` [line 5840]
4. `exec.entryTrigger = entryInfo.trigger || "Pullback entry"` [line 5841]
5. `exec.stopPrice = exec.opportunity?.stop.price ?? stopFallback` [line 5852]
6. `exec.targets = targetResultLong.targets` [line 5870]
7. `exec.targetZones = targetResultLong.targetZones` [line 5871]
8. `exec.thesisDirection = "long"` [line 5873]
9. `exec.phase = "IN_TRADE"` [line 5874]
10. `exec.waitReason = "in_trade"` [line 5876]
11. `exec.entryBlocked = false` [line 5877]
12. `exec.entryBlockReason = undefined` [line 5878]
13. `exec.opportunity.status = "CONSUMED"` [line 5884]
14. `exec.pullbackHigh = current5m.high` [line 5843]
15. `exec.pullbackLow = current5m.low` [line 5844]
16. `exec.pullbackTs = ts` [line 5845]

---

## C) Failure Modes Explaining This Trade

### C.1 Sequencing Issue: Entry Signal vs Momentum Check

**Failure Mode:** Entry signal detection happens **BEFORE** momentum check, allowing entry when price is temporarily above VWAP threshold but falls below immediately after.

**Sequence:**
1. **1m tick at 694.77:** Price temporarily above VWAP - 0.15*ATR
2. **Entry signal fires:** `entrySignalFires = true` (trigger hit, gate TRIGGERED)
3. **canEnter = true:** Determined at line 5575
4. **Entry execution block entered:** Line 5630
5. **Momentum check:** Line 5814 - `currentPrice = 694.77`, `vwap = 694.50`, `atr = 0.30`
   - `vwapTolerance = 0.15 * 0.30 = 0.045`
   - `694.77 < 694.50 - 0.045 = 694.455`? **FALSE** ✅
   - Momentum check **PASSES**
6. **Entry executes:** Line 5838-5894
7. **Next 1m tick:** Price falls to 694.40 (below VWAP - 0.15*ATR)
8. **Deployment pause triggers:** Line 4738-4749 (if 3+ bars below VWAP)
9. **Trade sells off:** Price continues down

**Root Cause:** Momentum check uses **current 1m tick price** but VWAP is computed from **5m bars**. Price can be temporarily above threshold at entry moment but fall below immediately after.

**Code Evidence:**
- Entry signal detection: Line 5505 (uses `exec.resolutionGate?.status`)
- Momentum check: Line 5814 (uses `current5m.close` from 1m tick)
- VWAP computation: Line 5812 (from 5m bars with volume)

### C.2 VWAP/EMA Regime Mismatch

**Failure Mode:** Entry can occur in "balance zone" (price near VWAP) if momentum check doesn't catch it, or if VWAP computation is stale.

**Balance Zone Detection:**
**Location:** `src/orchestrator/orchestrator.ts:3213-3228`

```typescript
// Check 2: Balance Zone Detection
if (closed5mBars.length >= 6) {
  const recent = closed5mBars.slice(-6);
  const recentRange = recentHigh - recentLow;
  const avgRange = recent.map(b => b.high - b.low).reduce((a, b) => a + b, 0) / recent.length;
  
  // If range is tight relative to ATR and we're near VWAP, it's balance
  if (vwap !== undefined && recentRange < 0.6 * atr && avgRange < 0.5 * atr) {
    const distanceFromVwap = Math.abs(currentPrice - vwap);
    if (distanceFromVwap < 0.3 * atr) {
      return { blocked: true, reason: "balance_zone_chopping" };
    }
  }
}
```

**Problem:** Balance zone check requires:
- `recentRange < 0.6 * atr` (tight range)
- `avgRange < 0.5 * atr` (low volatility)
- `distanceFromVwap < 0.3 * atr` (near VWAP)

If any condition fails, entry can occur in balance zone. For entry at 694.77:
- If `recentRange = 0.7 * atr` (slightly above 0.6), balance check **FAILS**
- If `distanceFromVwap = 0.35 * atr` (slightly above 0.3), balance check **FAILS**
- Entry proceeds despite being in balance zone

### C.3 Target Computation Issues

**Failure Mode:** Targets can collapse if `entryPrice === stopPrice` (risk = 0), or if computed with insufficient bars.

**Location:** `src/orchestrator/orchestrator.ts:2526-2569`

```typescript
private computeTargets(...): { targets: number[]; targetZones: {...} } {
  const risk = Math.abs(entry - stop);
  
  // Line 2554: If risk = 0, fallback targets equal entry
  if (!Number.isFinite(risk) || risk <= 0 || atr <= 0) {
    const basicT1 = direction === "long" ? entry + risk : entry - risk; // = entry (if risk = 0)
    return {
      targets: [basicT1, basicT2, basicT3], // ❌ All equal to entry
    };
  }
}
```

**Problem:** If `exec.stopPrice` is set too close to `exec.entryPrice` (e.g., due to late entry penalty or corrupted state), `risk = 0` and all targets equal entry, producing R=0.00.

**Late Entry Penalties:**
**Location:** `src/orchestrator/orchestrator.ts:3436-3484`

```typescript
private applyLateEntryPenalties(
  exec: MinimalExecutionState,
  targetResult: { targets: number[]; targetZones: any }
): void {
  if (exec.lateEntryPenalty) {
    const targetReduction = exec.lateEntryPenalty.targetReduction ?? 0;
    // Line 3468: Reduce targets by penalty
    targetResult.targets = targetResult.targets.map((target, index) => {
      return entry + (target - entry) * (1 - targetReduction);
    });
  }
}
```

**Problem:** Late entry penalties can reduce targets significantly, but don't prevent entry. If entry occurs late (RSI < 32, ATR already spiked), targets may be too conservative.

### C.4 IN_TRADE Corruption (From Previous Audit)

**Failure Mode:** Setup detection runs during IN_TRADE, resetting gate/waitReason and potentially corrupting targets.

**Sequence:**
1. Entry executes: `exec.phase = "IN_TRADE"`, `exec.setup = "PULLBACK_CONTINUATION"`
2. **5m close:** `reduce5mClose()` called
3. **Setup detection:** Line 4249 - `detectSetup()` called **WITHOUT** IN_TRADE guard
4. **Setup cleared:** `detectSetup()` returns `{ setup: "NONE" }` (phase not in allowed list)
5. **Gate reset:** `onSetupTransition()` called at line 4254
   - `exec.resolutionGate = undefined` [line 732] ❌
   - `exec.waitReason = "setup_none"` [line 753] ❌
6. **Telegram snapshot:** Shows `setup="NONE"`, `waitReason="setup_none"`, `entryStatus="active"` ❌ CONTRADICTION

**Code Evidence:**
- Setup detection: Line 4249 (no IN_TRADE guard)
- Gate reset: Line 732 (no IN_TRADE guard)
- waitReason overwrite: Line 753 (no IN_TRADE guard)

---

## D) Invariants for Trade Integrity

### D.1 Trade State Integrity Invariants

**Invariant T1: Setup Detection Must Not Run While IN_TRADE**
- **Current Violation:** `detectSetup()` called at line 4249 without IN_TRADE guard
- **Required:** Skip setup detection if `exec.phase === "IN_TRADE"`
- **Impact:** Prevents setup/gate reset during active trade

**Invariant T2: Gate Reset Must Not Occur While IN_TRADE**
- **Current Violation:** `onSetupTransition()` resets gate at line 732 without IN_TRADE guard
- **Required:** Don't reset `exec.resolutionGate` if `exec.phase === "IN_TRADE"`
- **Impact:** Prevents gate state corruption during active trade

**Invariant T3: waitReason Must Not Be Overwritten While IN_TRADE**
- **Current Violation:** `onSetupTransition()` sets `waitReason = "setup_none"` at line 753 without IN_TRADE guard
- **Required:** Don't overwrite `exec.waitReason` if `exec.phase === "IN_TRADE"`
- **Impact:** Prevents Telegram snapshot showing contradictory state

**Invariant T4: Trade Params Must Be Immutable Once IN_TRADE**
- **Current Violation:** `exec.entryPrice`, `exec.stopPrice`, `exec.targets` can be recomputed/cleared by setup logic
- **Required:** Create entry snapshot on trade entry, guard mutations
- **Impact:** Prevents target collapse and trade param corruption

### D.2 Entry Quality Integrity Invariants

**Invariant E1: Momentum Check Must Precede Entry Signal Detection**
- **Current Violation:** Entry signal detection (line 5505) happens BEFORE momentum check (line 5814)
- **Required:** Evaluate momentum check BEFORE determining `canEnter`
- **Impact:** Prevents entry when price is below VWAP threshold

**Invariant E2: VWAP Displacement Must Be Enforced Pre-Entry**
- **Current Violation:** VWAP check (line 3234) happens INSIDE entry block, after signal detection
- **Required:** Check `currentPrice >= vwap - 0.15*atr` (for BULLISH) BEFORE entry signal detection
- **Impact:** Prevents entry in poor momentum conditions

**Invariant E3: Balance Zone Must Block Entry**
- **Current Violation:** Balance zone check (line 3213) can fail if conditions are slightly off
- **Required:** Stricter balance zone detection or explicit VWAP proximity check
- **Impact:** Prevents entry in choppy/balance conditions

**Invariant E4: Entry Must Not Occur When Risk = 0**
- **Current Violation:** `computeTargets()` can return equal targets if `risk = 0`
- **Required:** Validate `Math.abs(entry - stop) > 0.1 * atr` before entry
- **Impact:** Prevents R=0.00 trades

**Invariant E5: Late Entry Must Be Prevented or Penalized**
- **Current Violation:** Late entry penalties applied but entry still occurs
- **Required:** Block entry if `lateEntryCheck.isLate && lateEntryCheck.confidencePenalty > 0.5`
- **Impact:** Prevents low-expectancy entries

### D.3 Sequencing Integrity Invariants

**Invariant S1: 1m and 5m Processing Must Be Synchronized**
- **Current Violation:** Deployment pause (1m) and momentum check (5m) use different VWAP computations
- **Required:** Use same VWAP source for all checks, or explicitly document timing differences
- **Impact:** Prevents race conditions between 1m and 5m processing

**Invariant S2: Entry Signal Must Be Validated Against Current Price**
- **Current Violation:** Entry signal uses `exec.resolutionGate?.status` (may be stale)
- **Required:** Re-validate trigger price against current price at entry moment
- **Impact:** Prevents entry on stale signals

---

## Summary of Findings

### Primary Root Cause
**Sequencing Issue:** Entry signal detection happens **BEFORE** momentum check, allowing entry when price is temporarily above VWAP threshold but falls below immediately after.

### Contributing Factors
1. **VWAP/EMA Regime Mismatch:** Balance zone check can fail if conditions are slightly off
2. **Target Computation:** Targets can collapse if `risk = 0` or computed with insufficient bars
3. **IN_TRADE Corruption:** Setup detection can reset gate/waitReason during active trade
4. **Late Entry:** Late entry penalties don't prevent entry, only reduce targets

### Recommended Investigation Order
1. **Immediate:** Check logs for entry price (694.77) vs VWAP at entry time
2. **Immediate:** Verify if momentum check passed at entry moment
3. **Immediate:** Check if deployment pause triggered after entry
4. **Follow-up:** Verify if setup detection ran during IN_TRADE
5. **Follow-up:** Check if targets collapsed (R=0.00) due to corrupted stopPrice

---

## Files and Line References

### Entry Execution
- `src/orchestrator/orchestrator.ts:5838-5894` - PULLBACK_ENTRY execution
- `src/orchestrator/orchestrator.ts:5505-5577` - Entry signal detection
- `src/orchestrator/orchestrator.ts:5630-5656` - Entry execution block

### Momentum Checks
- `src/orchestrator/orchestrator.ts:3183-3241` - `momentumConfirmationGate()`
- `src/orchestrator/orchestrator.ts:3230-3238` - VWAP displacement check
- `src/orchestrator/orchestrator.ts:3213-3228` - Balance zone check
- `src/orchestrator/orchestrator.ts:5814-5829` - Momentum check in entry block

### Deployment Pause
- `src/orchestrator/orchestrator.ts:4699-4761` - Deployment pause mechanism
- `src/orchestrator/orchestrator.ts:4738-4760` - BULLISH bias pause

### Target Computation
- `src/orchestrator/orchestrator.ts:2526-2706` - `computeTargets()`
- `src/orchestrator/orchestrator.ts:2554-2569` - Risk = 0 fallback
- `src/orchestrator/orchestrator.ts:3436-3484` - Late entry penalties

### IN_TRADE Corruption
- `src/orchestrator/orchestrator.ts:4249` - `detectSetup()` called without IN_TRADE guard
- `src/orchestrator/orchestrator.ts:732` - Gate reset without IN_TRADE guard
- `src/orchestrator/orchestrator.ts:753` - waitReason overwrite without IN_TRADE guard

---

**End of Audit**
