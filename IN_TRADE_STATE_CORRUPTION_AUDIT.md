# IN_TRADE State Corruption Audit

## Executive Summary

The bot can be **IN_TRADE** (entry active) while setup detection/invalidation runs and resets setup/gate/targets, producing corrupted trade outputs. This occurs because:

1. **Setup detection runs unconditionally** in `reduce5mClose()` without checking if `exec.phase === "IN_TRADE"`
2. **Gate reset occurs while IN_TRADE** via `onSetupTransition()` which resets `exec.resolutionGate` and sets `exec.waitReason = "setup_none"` without IN_TRADE guards
3. **Target computation can collapse** if `entryPrice === stopPrice` (risk = 0), producing R=0.00 and equal targets
4. **Telegram snapshot prioritizes setup state over trade state**, showing "WAITING FOR: setup_none" even when entry is active

---

## 1. Call Paths Where Setup Detection/Gate Reset Runs While IN_TRADE

### Primary Violation: `reduce5mClose()` → `detectSetup()` → `onSetupTransition()`

**File:** `src/orchestrator/orchestrator.ts`

**Call Chain:**
```
handleMinimal1m() [line 4565]
  → reduce5mClose() [line 3898]
    → detectSetup() [line 4249] ❌ NO IN_TRADE CHECK
      → onSetupTransition() [line 4254] ❌ NO IN_TRADE CHECK
        → exec.resolutionGate = undefined [line 732] ❌ NO IN_TRADE GUARD
        → exec.waitReason = "setup_none" [line 753] ❌ NO IN_TRADE GUARD
```

**Exact Code Locations:**

#### 1.1 Setup Detection Invoked Without IN_TRADE Guard

**Location:** `src/orchestrator/orchestrator.ts:4226-4249`

```typescript
// Line 4226: Only checks if setup is NONE or TTL expired - NO phase check
if (exec.setup === "NONE" || !exec.setup || now >= setupTTLExpiry) {
  if (exec.bias === "NEUTRAL") {
    exec.setup = "NONE";
    // ...
  } else if (lastClosed5m) {
    // ...
    // Line 4249: detectSetup() called WITHOUT checking exec.phase === "IN_TRADE"
    const setupResult = this.detectSetup(exec, lastClosed5m, previous5m, closed5mBars, atr, null);
    
    // Line 4254: onSetupTransition() called WITHOUT checking exec.phase === "IN_TRADE"
    this.onSetupTransition(exec, oldSetup, setupResult.setup, ts);
    
    exec.setup = setupResult.setup; // ❌ Can set to "NONE" while IN_TRADE
    // ...
  }
}
```

**Problem:** `detectSetup()` is called on every 5m close when setup is NONE or TTL expired, regardless of whether the bot is IN_TRADE.

#### 1.2 Setup Detection Logic Doesn't Explicitly Exclude IN_TRADE

**Location:** `src/orchestrator/orchestrator.ts:1628-1726`

```typescript
private detectSetup(...): { setup: SetupType; ... } {
  // Line 1637: Reads phase but doesn't check if it's IN_TRADE
  const phase = exec.phase;
  
  // Line 1667: phaseAllowsSetup only checks for BIAS_ESTABLISHED or PULLBACK_IN_PROGRESS
  const phaseAllowsSetup = phase === "BIAS_ESTABLISHED" || phase === "PULLBACK_IN_PROGRESS";
  
  // Line 1688: If phase is IN_TRADE, phaseAllowsSetup = false, so returns "NONE"
  if (phaseAllowsSetup && ...) {
    return { setup: "PULLBACK_CONTINUATION", ... };
  }
  
  // Line 1725: Returns "NONE" when phase is IN_TRADE
  return { setup: "NONE" };
}
```

**Problem:** `detectSetup()` doesn't explicitly guard against IN_TRADE. When `phase === "IN_TRADE"`, `phaseAllowsSetup = false`, so it returns `{ setup: "NONE" }`, which then triggers `onSetupTransition()` to reset the gate and set `waitReason = "setup_none"`.

#### 1.3 Gate Reset in `onSetupTransition()` Without IN_TRADE Guard

**Location:** `src/orchestrator/orchestrator.ts:714-755`

```typescript
private onSetupTransition(
  exec: MinimalExecutionState,
  prevSetup: SetupType | undefined,
  nextSetup: SetupType,
  ts: number
): void {
  if (prevSetup === nextSetup) return;

  // Line 724-732: Gate reset happens WITHOUT checking exec.phase === "IN_TRADE"
  if (exec.resolutionGate) {
    const prevGateStatus = exec.resolutionGate.status;
    console.log(
      `[GATE_RESET] setup ${prevSetup ?? "NONE"} -> ${nextSetup} | prevGate=${prevGateStatus}`
    );
  }
  
  // ❌ CRITICAL: Gate cleared even if IN_TRADE
  exec.resolutionGate = undefined;
  
  // Line 752-753: waitReason set to "setup_none" WITHOUT checking exec.phase === "IN_TRADE"
  if (nextSetup === "NONE") {
    exec.waitReason = "setup_none"; // ❌ Overwrites "in_trade" waitReason
  }
  
  // Line 740: Only entry state clearing is guarded
  if (exec.phase !== "IN_TRADE") {
    exec.entryPrice = undefined;
    // ...
  }
}
```

**Problem:** `onSetupTransition()` resets the gate and sets `waitReason = "setup_none"` even when `exec.phase === "IN_TRADE"`. Only entry state clearing is guarded.

#### 1.4 Setup Invalidation Runs While IN_TRADE

**Location:** `src/orchestrator/orchestrator.ts:4200-4213`

```typescript
// Line 4201: Setup invalidation check runs WITHOUT checking exec.phase === "IN_TRADE"
if (exec.setup && exec.setup !== "NONE" && now < setupTTLExpiry) {
  const invalidated = (exec.bias === "BEARISH" && exec.setupStopPrice !== undefined && close > exec.setupStopPrice) ||
                     (exec.bias === "BULLISH" && exec.setupStopPrice !== undefined && close < exec.setupStopPrice);
  
  if (invalidated) {
    console.log(`[SETUP_INVALIDATED] ${exec.setup} -> NONE | ...`);
    exec.setup = "NONE"; // ❌ Can invalidate setup while IN_TRADE
    exec.setupTriggerPrice = undefined;
    exec.setupStopPrice = undefined;
    exec.setupDetectedAt = undefined;
  }
}
```

**Problem:** Setup invalidation can run while IN_TRADE, setting `exec.setup = "NONE"`, which then triggers the setup detection path above.

---

## 2. Places Where Clearing Setup/Resetting Gate Mutates Trade Fields

### 2.1 Gate Reset Clears `exec.resolutionGate` (Affects Trade Management)

**Location:** `src/orchestrator/orchestrator.ts:732`

```typescript
exec.resolutionGate = undefined; // ❌ Cleared even if IN_TRADE
```

**Impact:** Trade management logic may check `exec.resolutionGate?.status` to determine if entry is valid. When cleared, this can cause inconsistent state.

### 2.2 `waitReason` Overwritten to "setup_none" While IN_TRADE

**Location:** `src/orchestrator/orchestrator.ts:752-753`

```typescript
if (nextSetup === "NONE") {
  exec.waitReason = "setup_none"; // ❌ Overwrites "in_trade" waitReason
}
```

**Impact:** Telegram snapshot shows "WAITING FOR: setup_none" even when entry is active.

### 2.3 Target Computation Can Collapse if `entryPrice === stopPrice`

**Location:** `src/orchestrator/orchestrator.ts:2526-2569`

```typescript
private computeTargets(...): { targets: number[]; targetZones: {...} } {
  const risk = Math.abs(entry - stop);
  
  // Line 2554: If risk = 0, fallback targets are computed
  if (!Number.isFinite(risk) || risk <= 0 || atr <= 0) {
    const basicT1 = direction === "long" ? entry + risk : entry - risk; // = entry (if risk = 0)
    const basicT2 = direction === "long" ? entry + risk * 2 : entry - risk * 2; // = entry
    const basicT3 = direction === "long" ? entry + risk * 3 : entry - risk * 3; // = entry
    return {
      targets: [basicT1, basicT2, basicT3], // ❌ All equal to entry
      // ...
    };
  }
  // ...
}
```

**Impact:** If `entryPrice === stopPrice` (risk = 0), all targets equal entry, producing R=0.00 and corrupted trade outputs.

**When This Happens:**
- If `exec.stopPrice` is corrupted or reset to `exec.entryPrice` during setup clearing
- If stop is moved to breakeven (1R hit) but entry price is incorrectly set

**Location Where Targets Are Recomputed While IN_TRADE:**

**Location:** `src/orchestrator/orchestrator.ts:6061-6082`

```typescript
// Line 6061: Targets recomputed on every 5m close while IN_TRADE
if (exec.phase === "IN_TRADE" && exec.entryPrice !== undefined && exec.stopPrice !== undefined && is5mClose) {
  const targetResult = this.computeTargets(
    direction,
    exec.entryPrice,
    exec.stopPrice, // ❌ If this equals entryPrice, risk = 0
    atr,
    // ...
  );
  exec.targets = targetResult.targets; // ❌ Can be all equal to entry
  exec.targetZones = targetResult.targetZones;
}
```

**Problem:** If `exec.stopPrice` was corrupted or reset during setup clearing, targets will collapse on the next 5m close.

---

## 3. Telegram Snapshot Field Derivation

### 3.1 `waitReason` Source

**Location:** `src/orchestrator/orchestrator.ts:6599-6613`

```typescript
// Line 6599: effectiveWaitReason derived from exec.waitReason
let effectiveWaitReason = exec.waitReason;

// Line 6606-6611: Override logic, but doesn't check if IN_TRADE
if (effectiveWaitReason === "no_opportunity_latched") {
  effectiveWaitReason = oppReady 
    ? (exec.setup === "NONE" ? "waiting_for_pullback" : "waiting_for_trigger")
    : `opportunity_${exec.opportunity!.status.toLowerCase()}`;
  exec.waitReason = effectiveWaitReason; // ❌ Can overwrite "in_trade"
}
```

**Location:** `src/telegram/telegramNormalizer.ts:182`

```typescript
waitFor: event.data.waitFor ?? null, // ❌ Uses exec.waitReason which can be "setup_none" while IN_TRADE
```

**Location:** `src/telegram/telegramFormatter.ts:158-162`

```typescript
entryLine = snapshot.setup && snapshot.setup !== "NONE"
  ? `${entryEmoji} ENTRY: WAITING (${triggerLabel})`
  : `${entryEmoji} ENTRY: ${snapshot.entryStatus === "active" ? "ACTIVE" : ...}`;
```

**Problem:** Telegram snapshot uses `exec.waitReason` which can be "setup_none" even when `entryStatus === "active"`, causing "WAITING FOR: setup_none" to display while entry is active.

### 3.2 `setup` Field Source

**Location:** `src/telegram/telegramNormalizer.ts:193`

```typescript
setup, // ❌ Can be "NONE" while IN_TRADE
```

**Problem:** Telegram shows `setup: "NONE"` even when entry is active, because setup detection cleared it.

### 3.3 `entryStatus` Derivation

**Location:** `src/orchestrator/orchestrator.ts:6620-6624`

```typescript
const entryStatusValue: "blocked" | "active" | "inactive" = 
  exec.entryBlocked
    ? "blocked"
    : (exec.phase === "IN_TRADE" ? "active" : "inactive");
```

**Problem:** `entryStatus` correctly shows "active" when `exec.phase === "IN_TRADE"`, but `waitReason` and `setup` can still be corrupted, causing contradictory state.

---

## 4. Architecture Flaw Explanation

### The Core Problem: **Trade State Is Not Isolated/Immutable**

The architecture flaw is that **setup/gate logic shares fields with trade management and can overwrite trade state while IN_TRADE**:

1. **Shared State Fields:**
   - `exec.setup` - Used by both setup detection (pre-entry) and trade management (post-entry)
   - `exec.resolutionGate` - Used by both gate arming (pre-entry) and trade validation (post-entry)
   - `exec.waitReason` - Used by both setup waiting (pre-entry) and trade status (post-entry)
   - `exec.entryPrice`, `exec.stopPrice`, `exec.targets` - Used by both entry logic and trade management

2. **No State Isolation:**
   - Setup detection runs unconditionally in `reduce5mClose()`, even when `exec.phase === "IN_TRADE"`
   - Gate reset in `onSetupTransition()` doesn't check if IN_TRADE before clearing `exec.resolutionGate`
   - `waitReason` is overwritten to "setup_none" even when IN_TRADE

3. **No Immutability:**
   - Trade parameters (`entryPrice`, `stopPrice`, `targets`) can be recomputed or cleared by setup logic
   - If `exec.stopPrice` is corrupted or reset, target computation collapses (risk = 0)

4. **No Priority:**
   - Telegram snapshot doesn't prioritize in-trade truth over setup truth
   - `waitReason` from setup clearing overrides "in_trade" status

### Minimal Reproduction Sequence

```
1. Bot enters trade: exec.phase = "IN_TRADE", exec.setup = "IGNITION", exec.waitReason = "in_trade"
2. 5m bar closes → reduce5mClose() called
3. Setup detection runs (line 4249): detectSetup() called WITHOUT checking IN_TRADE
4. detectSetup() returns { setup: "NONE" } because phaseAllowsSetup = false (IN_TRADE not in allowed phases)
5. onSetupTransition() called (line 4254) WITHOUT checking IN_TRADE
6. Gate reset: exec.resolutionGate = undefined (line 732) ❌
7. waitReason overwritten: exec.waitReason = "setup_none" (line 753) ❌
8. exec.setup = "NONE" (line 4256) ❌
9. Next 5m close: Targets recomputed (line 6061)
10. If exec.stopPrice was corrupted: risk = 0, targets all equal entry ❌
11. Telegram snapshot: waitFor = "setup_none", setup = "NONE", entryStatus = "active" ❌ CONTRADICTION
```

---

## 5. Invariant Enforcement Plan

### Invariant A: Setup Detection Must Be Read-Only or Skipped While IN_TRADE

**Current Violation:** `detectSetup()` is called at line 4249 without checking `exec.phase === "IN_TRADE"`.

**Fix:**
1. Add guard in `reduce5mClose()` before calling `detectSetup()`:
   ```typescript
   // Skip setup detection if IN_TRADE
   if (exec.phase === "IN_TRADE") {
     console.log(`[SETUP_DETECT_SKIP] phase=IN_TRADE - skipping setup detection`);
     return; // or continue to next step
   }
   ```

2. Add explicit guard in `detectSetup()`:
   ```typescript
   if (exec.phase === "IN_TRADE") {
     console.log(`[SETUP_DETECT_BLOCKED] reason=in_trade`);
     return { setup: exec.setup ?? "NONE" }; // Return current setup, don't change it
   }
   ```

**Risk Assessment:**
- **Low risk:** Setup detection is informational for pre-entry logic. Skipping it while IN_TRADE doesn't affect trade management.
- **Potential side effect:** If setup TTL expires while IN_TRADE, setup won't be refreshed. This is acceptable because setup is only needed for entry, not trade management.

### Invariant B: Gate Reset Must Not Occur While IN_TRADE

**Current Violation:** `onSetupTransition()` resets `exec.resolutionGate` at line 732 without checking IN_TRADE.

**Fix:**
1. Add guard in `onSetupTransition()`:
   ```typescript
   private onSetupTransition(...): void {
     if (prevSetup === nextSetup) return;
     
     // ❌ CRITICAL FIX: Don't reset gate if IN_TRADE
     if (exec.phase === "IN_TRADE") {
       console.log(`[GATE_RESET_SKIP] phase=IN_TRADE - preserving gate state`);
       return; // Don't reset gate or waitReason
     }
     
     // Existing gate reset logic...
   }
   ```

2. Alternative: Make gate reset conditional:
   ```typescript
   if (exec.phase !== "IN_TRADE") {
     exec.resolutionGate = undefined;
     if (nextSetup === "NONE") {
       exec.waitReason = "setup_none";
     }
   }
   ```

**Risk Assessment:**
- **Low risk:** Gate is only needed for entry arming. Once IN_TRADE, gate state is irrelevant.
- **Potential side effect:** If gate was in a bad state before entry, it won't be cleared. This is acceptable because gate state doesn't affect trade management.

### Invariant C: Trade Params Must Be Derived from Entry Snapshot

**Current Violation:** `exec.entryPrice`, `exec.stopPrice`, `exec.targets` can be recomputed or cleared by setup logic.

**Fix:**
1. Create immutable entry snapshot on trade entry:
   ```typescript
   // On entry execution, create snapshot
   exec.entrySnapshot = {
     entryPrice: exec.entryPrice,
     stopPrice: exec.stopPrice,
     entryTs: exec.entryTs,
     entryType: exec.entryType,
     entryTrigger: exec.entryTrigger,
     // Compute targets once and store
     targets: targetResult.targets,
     targetZones: targetResult.targetZones,
   };
   ```

2. Guard trade param mutations:
   ```typescript
   // In onSetupTransition()
   if (exec.phase === "IN_TRADE" && exec.entrySnapshot) {
     // Restore from snapshot if corrupted
     exec.entryPrice = exec.entrySnapshot.entryPrice;
     exec.stopPrice = exec.entrySnapshot.stopPrice;
     exec.targets = exec.entrySnapshot.targets;
     exec.targetZones = exec.entrySnapshot.targetZones;
   }
   ```

3. Only allow trade management to update targets (not setup logic):
   ```typescript
   // In trade management block (line 6061)
   if (exec.phase === "IN_TRADE" && exec.entrySnapshot) {
     // Only recompute if entrySnapshot exists (entry was valid)
     const targetResult = this.computeTargets(
       direction,
       exec.entrySnapshot.entryPrice, // Use snapshot, not exec.entryPrice
       exec.entrySnapshot.stopPrice,  // Use snapshot, not exec.stopPrice
       // ...
     );
   }
   ```

**Risk Assessment:**
- **Medium risk:** Requires adding new state field `entrySnapshot`. Must ensure it's set on all entry paths.
- **Potential side effect:** If entry snapshot is not set correctly, trade management may fail. Need comprehensive testing.

### Invariant D: UI Snapshot Must Prioritize In-Trade Truth

**Current Violation:** Telegram snapshot uses `exec.waitReason` which can be "setup_none" even when `entryStatus === "active"`.

**Fix:**
1. Create `resolveEffectiveWaitReason()` function:
   ```typescript
   private resolveEffectiveWaitReason(exec: MinimalExecutionState): string {
     // Priority 1: IN_TRADE always wins
     if (exec.phase === "IN_TRADE") {
       return "in_trade";
     }
     
     // Priority 2: Use exec.waitReason if not corrupted
     if (exec.waitReason && exec.waitReason !== "setup_none") {
       return exec.waitReason;
     }
     
     // Priority 3: Derive from opportunity/setup state
     // ...
   }
   ```

2. Use in Telegram snapshot:
   ```typescript
   waitFor: this.resolveEffectiveWaitReason(exec),
   ```

3. Override setup field if IN_TRADE:
   ```typescript
   setup: exec.phase === "IN_TRADE" ? exec.entrySnapshot?.entryType ?? "IN_TRADE" : exec.setup,
   ```

**Risk Assessment:**
- **Low risk:** Only affects UI display, not trading logic.
- **Potential side effect:** UI may show different state than internal state. This is acceptable if it prevents user confusion.

---

## 6. Test Cases

### Unit Tests

1. **Test: Setup Detection Skipped While IN_TRADE**
   ```typescript
   test("detectSetup() should not run when phase === IN_TRADE", () => {
     exec.phase = "IN_TRADE";
     exec.setup = "IGNITION";
     const result = orchestrator.detectSetup(...);
     expect(result.setup).toBe("IGNITION"); // Should return current, not "NONE"
   });
   ```

2. **Test: Gate Reset Skipped While IN_TRADE**
   ```typescript
   test("onSetupTransition() should not reset gate when phase === IN_TRADE", () => {
     exec.phase = "IN_TRADE";
     exec.resolutionGate = { status: "TRIGGERED" };
     orchestrator.onSetupTransition(exec, "IGNITION", "NONE", ts);
     expect(exec.resolutionGate).toBeDefined(); // Should not be cleared
     expect(exec.waitReason).toBe("in_trade"); // Should not be "setup_none"
   });
   ```

3. **Test: Entry Snapshot Created on Entry**
   ```typescript
   test("entrySnapshot should be created when entering trade", () => {
     orchestrator.executeEntry(...);
     expect(exec.entrySnapshot).toBeDefined();
     expect(exec.entrySnapshot.entryPrice).toBe(exec.entryPrice);
     expect(exec.entrySnapshot.targets).toBeDefined();
   });
   ```

4. **Test: Targets Don't Collapse When Risk > 0**
   ```typescript
   test("computeTargets() should not return equal targets when risk > 0", () => {
     const result = orchestrator.computeTargets("long", 100, 95, 2, bars, vwap);
     expect(result.targets[0]).not.toBe(result.targets[1]);
     expect(result.targets[0]).not.toBe(100); // Should not equal entry
   });
   ```

### Integration Tests

1. **Test: Full Reproduction Sequence**
   ```typescript
   test("setup detection should not corrupt IN_TRADE state", async () => {
     // 1. Enter trade
     await orchestrator.processTick({...}, "1m");
     expect(exec.phase).toBe("IN_TRADE");
     expect(exec.setup).toBe("IGNITION");
     expect(exec.waitReason).toBe("in_trade");
     
     // 2. 5m close triggers reduce5mClose()
     await orchestrator.processTick({...}, "5m");
     
     // 3. Verify state not corrupted
     expect(exec.phase).toBe("IN_TRADE");
     expect(exec.setup).toBe("IGNITION"); // Should not be "NONE"
     expect(exec.waitReason).toBe("in_trade"); // Should not be "setup_none"
     expect(exec.resolutionGate).toBeDefined(); // Should not be cleared
     expect(exec.targets[0]).not.toBe(exec.entryPrice); // Targets should not collapse
   });
   ```

2. **Test: Telegram Snapshot Priority**
   ```typescript
   test("Telegram snapshot should prioritize IN_TRADE over setup", () => {
     exec.phase = "IN_TRADE";
     exec.setup = "NONE"; // Corrupted by setup detection
     exec.waitReason = "setup_none"; // Corrupted by setup detection
     
     const snapshot = orchestrator.buildTelegramSnapshot(...);
     expect(snapshot.entryStatus).toBe("active");
     expect(snapshot.waitFor).toBe("in_trade"); // Should override "setup_none"
     expect(snapshot.setup).not.toBe("NONE"); // Should show entry type or "IN_TRADE"
   });
   ```

### Log Assertions

1. **Assert: Setup Detection Logs Skip When IN_TRADE**
   ```
   [SETUP_DETECT_SKIP] phase=IN_TRADE - skipping setup detection
   ```

2. **Assert: Gate Reset Logs Skip When IN_TRADE**
   ```
   [GATE_RESET_SKIP] phase=IN_TRADE - preserving gate state
   ```

3. **Assert: No Contradictory State in Consistency Check**
   ```
   [CONSISTENCY_CHECK] phase=IN_TRADE setup=IGNITION gate=TRIGGERED entry=active entryType=PULLBACK_ENTRY
   ```
   Should never show: `phase=IN_TRADE setup=NONE gate=none entry=active`

---

## 7. Risk Assessment of Invariant Changes

### Unintended Side Effects

1. **Opportunity Latch and Gate Logic Interaction:**
   - **Risk:** If gate is not reset while IN_TRADE, opportunity latch may remain in "TRIGGERED" state.
   - **Mitigation:** Opportunity latch is set to "CONSUMED" on entry (line 6034). Gate state doesn't affect trade management.

2. **Trade Lifecycle Interaction:**
   - **Risk:** If entry snapshot is not created on all entry paths, trade management may fail.
   - **Mitigation:** Add entry snapshot creation to all entry execution points (bias flip entry, pullback entry, nudge entry, etc.).

3. **Setup TTL Expiration While IN_TRADE:**
   - **Risk:** If setup TTL expires while IN_TRADE, setup won't be refreshed.
   - **Mitigation:** This is acceptable because setup is only needed for entry, not trade management. Setup can be refreshed after exit.

4. **Target Recalculation:**
   - **Risk:** If entry snapshot is used for target recalculation, targets won't update if stop is moved to breakeven.
   - **Mitigation:** Allow stop price updates in trade management, but preserve entry price from snapshot.

---

## 8. Summary of Required Changes

### Immediate Fixes (Critical)

1. **Add IN_TRADE guard in `reduce5mClose()` before setup detection** (line 4226)
2. **Add IN_TRADE guard in `onSetupTransition()` before gate reset** (line 732)
3. **Add IN_TRADE guard in `onSetupTransition()` before waitReason update** (line 753)
4. **Add IN_TRADE guard in setup invalidation** (line 4201)

### Medium-Term Fixes (Architectural)

5. **Create entry snapshot on trade entry** (all entry execution points)
6. **Guard trade param mutations with entry snapshot** (trade management block)
7. **Create `resolveEffectiveWaitReason()` function** (Telegram snapshot)

### Long-Term Fixes (Testing)

8. **Add unit tests for invariant enforcement**
9. **Add integration tests for full reproduction sequence**
10. **Add log assertions for state corruption detection**

---

## 9. Files and Line References

### Primary Violations

- `src/orchestrator/orchestrator.ts:4226-4283` - Setup detection in `reduce5mClose()` without IN_TRADE guard
- `src/orchestrator/orchestrator.ts:4249` - `detectSetup()` called without IN_TRADE check
- `src/orchestrator/orchestrator.ts:4254` - `onSetupTransition()` called without IN_TRADE check
- `src/orchestrator/orchestrator.ts:714-755` - `onSetupTransition()` resets gate/waitReason without IN_TRADE guard
- `src/orchestrator/orchestrator.ts:4200-4213` - Setup invalidation without IN_TRADE guard
- `src/orchestrator/orchestrator.ts:1628-1726` - `detectSetup()` doesn't explicitly exclude IN_TRADE
- `src/orchestrator/orchestrator.ts:6061-6082` - Target recomputation can collapse if stopPrice corrupted
- `src/orchestrator/orchestrator.ts:2526-2569` - `computeTargets()` returns equal targets when risk = 0

### Telegram Snapshot

- `src/orchestrator/orchestrator.ts:6599-6613` - `effectiveWaitReason` derivation doesn't prioritize IN_TRADE
- `src/telegram/telegramNormalizer.ts:182` - `waitFor` uses `exec.waitReason` which can be corrupted
- `src/telegram/telegramFormatter.ts:158-162` - Entry line doesn't override setup state when IN_TRADE

---

**End of Audit**
