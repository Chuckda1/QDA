# Entry and Setup Flicker Diagnosis

## Confirmed Issues from Logs

### ✅ Issue 1: Setup Flicker on 1m Ticks (CONFIRMED)

**Evidence from logs:**
- `[SETUP_DETECTED] NONE -> BREAKDOWN` (at 11:35 5m close)
- `[SETUP_DETECTED] BREAKDOWN -> PULLBACK_GENERIC` (at 11:36 1m tick)
- `[SETUP_DETECTED] PULLBACK_GENERIC -> REJECTION` (at 11:37 1m tick)
- `[SETUP_DETECTED] REJECTION -> NONE` (at 11:39 1m tick)

**Root Cause:**
**File:** `src/orchestrator/orchestrator.ts:3226`
```typescript
const setupResult = this.detectSetup(exec, current5m, previous5m ?? undefined, closed5mBars, atr, forming5mBar);
exec.setup = setupResult.setup;  // ❌ Mutates exec.setup on every 1m tick
```

This is in `handleMinimal1m()` and runs on every 1m tick, using `forming5mBar` which changes shape constantly.

**Fix:** Remove setup detection from `handleMinimal1m()` or make it read-only (only update if `exec.setup === "NONE"`).

---

### ✅ Issue 2: Entry Executes After ENTRY_BLOCKED Log (CONFIRMED)

**Evidence from logs:**
- `[ENTRY_BLOCKED] No opportunity latched ...`
- `[ENTRY_EXECUTED] ...` (immediately after)

**Root Cause:**
**File:** `src/orchestrator/orchestrator.ts:3340-3382`

**Flow:**
1. Line 3340-3349: Checks if opportunity is latched
   - If not, logs `[ENTRY_BLOCKED]` and sets `exec.entryBlocked = true`
   - **NO RETURN STATEMENT** - execution continues

2. Line 3377-3380: `canEnter` condition includes fallback:
   ```typescript
   const canEnter = 
     (exec.setup && exec.setup !== "NONE") && 
     entrySignalFires && 
     (exec.opportunity?.status === "LATCHED" || exec.opportunity?.status === "TRIGGERED" || !exec.opportunity); // ❌ Fallback allows entry when opportunity doesn't exist
   ```

3. Line 3382: If `canEnter` is true, proceeds to entry logic

**Problem:** The code logs "blocked" but then allows entry anyway because `|| !exec.opportunity` makes missing opportunity not a blocker.

**Fix Options:**
- **Option A:** Remove `|| !exec.opportunity` fallback from `canEnter` (make opportunity required)
- **Option B:** Add `return` or `continue` after logging `[ENTRY_BLOCKED]` when opportunity is missing
- **Option C:** Create a "default latch" when opportunity is missing (if you want fallback behavior)

---

### ✅ Issue 3: Stop Placement Too Tight (Same Bar as Entry)

**Evidence from logs:**
- `entry=695.42 ... stop=695.34`
- `Stop hit at 695.34 (stop=695.34)` (immediately)

**Root Cause:**
**File:** `src/orchestrator/orchestrator.ts:3417`
```typescript
exec.stopPrice = exec.opportunity?.stop.price ?? current5m.low; // ❌ Uses same bar's low as fallback
```

For BULLISH entries, stop is set to `current5m.low` (the same bar that triggered entry). Any tiny noise will hit it.

**Fix:** Use previous bar's low or add ATR buffer:
```typescript
exec.stopPrice = exec.opportunity?.stop.price ?? (previous5m?.low ?? current5m.low) - (atr * 0.1); // Add small buffer
```

---

## Minimal Fix Plan

### Fix 1: Remove Setup Detection from handleMinimal1m() (Make Read-Only)

**File:** `src/orchestrator/orchestrator.ts:3215-3280`

**Change:** Only update setup if `exec.setup === "NONE"` (read-only otherwise):
```typescript
} else if (current5m && exec.setup === "NONE") {  // Only detect if setup is NONE
  const atr = this.calculateATR(closed5mBars);
  const setupResult = this.detectSetup(exec, current5m, previous5m ?? undefined, closed5mBars, atr, forming5mBar);
  // ... update setup
}
```

### Fix 2: Make OpportunityLatch a Hard Gate (Remove Fallback)

**File:** `src/orchestrator/orchestrator.ts:3377-3380`

**Change:** Remove `|| !exec.opportunity` fallback:
```typescript
const canEnter = 
  (exec.setup && exec.setup !== "NONE") && 
  entrySignalFires && 
  (exec.opportunity?.status === "LATCHED" || exec.opportunity?.status === "TRIGGERED"); // Remove || !exec.opportunity
```

**AND** add early return after ENTRY_BLOCKED log:
```typescript
} else if (!exec.opportunity || exec.opportunity.status !== "LATCHED") {
  exec.waitReason = "no_opportunity_latched";
  exec.entryBlocked = true;
  exec.entryBlockReason = "No tradable opportunity latched - waiting for pullback zone entry";
  shouldPublishEvent = true;
  console.log(`[ENTRY_BLOCKED] No opportunity latched ...`);
  return; // ❌ ADD THIS - prevent entry evaluation from continuing
}
```

### Fix 3: Fix Stop Placement (Add Buffer)

**File:** `src/orchestrator/orchestrator.ts:3417` (and similar for BEARISH)

**Change:** Use previous bar or add ATR buffer:
```typescript
// For BULLISH
exec.stopPrice = exec.opportunity?.stop.price ?? 
  (previous5m ? Math.min(previous5m.low, current5m.low) - (atrLong * 0.1) : current5m.low - (atrLong * 0.1));

// For BEARISH  
exec.stopPrice = exec.opportunity?.stop.price ?? 
  (previous5m ? Math.max(previous5m.high, current5m.high) + (atrBear * 0.1) : current5m.high + (atrBear * 0.1));
```
