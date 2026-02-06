# Bias Engine Additional Fixes & Improvements

## Summary of Additional Fixes

1. ✅ **Always compute derived confidence** (even when LLM is null)
2. ✅ **Protect IN_TRADE from bias flips** (or allow only neutralize)
3. ✅ **Add [BIAS_CHANGE] log** for debugging
4. ✅ **Clear expectedResolution in REPAIR**
5. ✅ **Fix LLM maturity hint type** (include "exhausting")
6. ✅ **Optional: Bias flip cooldown before setup arming**

---

## 1. Always Compute Derived Confidence (Even When LLM is Null)

**File:** `src/orchestrator/orchestrator.ts:2476` (after STEP 1, before STEP 2)

**Add this block:**

```typescript
// ============================================================================
// STEP 1.5: Always compute derived confidence (bias engine can flip without LLM)
// ============================================================================
// Bias confidence should not depend on LLM availability anymore
// This ensures Step 2 has consistent inputs and logs don't lie
if (exec.bias !== "NEUTRAL") {
  exec.biasConfidence = this.calculateDerivedConfidence(exec, close, closed5mBars, ts);
  exec.thesisConfidence = exec.biasConfidence;
} else {
  exec.biasConfidence = undefined;
  exec.thesisConfidence = undefined;
}
```

**Placement:** Right after STEP 1 (LLM hints), before STEP 2 (phase transitions).

---

## 2. Protect IN_TRADE from Bias Flips

**File:** `src/orchestrator/orchestrator.ts` (in `updateBiasEngine()`)

**Option A: Complete Protection (Safer Default)**

Add at the top of `updateBiasEngine()`:

```typescript
private updateBiasEngine(exec: MinimalExecutionState, ts: number, close: number): void {
  // Don't flip bias while in trade (protect active positions)
  if (exec.phase === "IN_TRADE") {
    return;
  }
  
  // ... rest of function
}
```

**Option B: Allow Neutralize Only (More Nuanced)**

Allow REPAIR state tracking but prevent finalize and clearing:

```typescript
private updateBiasEngine(exec: MinimalExecutionState, ts: number, close: number): void {
  const micro = exec.micro;
  if (!micro) return;

  if (!exec.biasEngine) {
    exec.biasEngine = {
      state: exec.bias === "BULLISH" ? "BULLISH" : exec.bias === "BEARISH" ? "BEARISH" : "NEUTRAL",
      score: 0,
      acceptBullCount: 0,
      acceptBearCount: 0,
    };
  }

  const be = exec.biasEngine;
  const inTrade = exec.phase === "IN_TRADE";
  
  // ... (acceptance tests, etc.)
  
  // In finalizeFlip(), add guard:
  const finalizeFlip = (newBias: MarketBias, newState: BiasEngineState) => {
    if (inTrade) {
      // Don't finalize or clear anything while in trade
      // But allow state tracking for observability
      be.state = newState;  // Track state change
      be.lastFlipTs = ts;
      be.repairStartTs = undefined;
      // DO NOT change exec.bias, clear setup, etc.
      return;
    }
    
    // ... rest of finalizeFlip logic
  };
  
  // ... rest of function
}
```

**Recommendation:** Use **Option A** (complete protection) for safety. Bias engine can resume after trade exits.

---

## 3. Add [BIAS_CHANGE] Log for Debugging

**File:** `src/orchestrator/orchestrator.ts` (in `updateBiasEngine()`)

**Add at the top of function:**

```typescript
private updateBiasEngine(exec: MinimalExecutionState, ts: number, close: number): void {
  const micro = exec.micro;
  if (!micro) return;

  // Track bias change for debugging
  const prevExecBias = exec.bias;
  
  // ... rest of function (initialize biasEngine, etc.)
  
  // At the end, before the existing [BIAS_ENGINE] log:
  if (prevExecBias !== exec.bias) {
    console.log(
      `[BIAS_CHANGE] ${prevExecBias} -> ${exec.bias} | engineState=${be.state} px=${close.toFixed(2)}`
    );
  }
  
  // Existing [BIAS_ENGINE] log for state transitions
  if (prevState !== be.state) {
    console.log(
      `[BIAS_ENGINE] ${prevState} -> ${be.state} | execBias=${exec.bias} px=${close.toFixed(2)} ` +
      `vwap=${vwap.toFixed(2)} ema=${ema.toFixed(2)} av=${aboveVwap} ae=${aboveEma} bv=${belowVwap} be=${belowEma} ` +
      `bullAccept=${bullAccept} bearAccept=${bearAccept} cooldown=${inCooldown}`
    );
  }
}
```

---

## 4. Clear expectedResolution in REPAIR

**File:** `src/orchestrator/orchestrator.ts` (in `enterRepair()` helper)

**Update the `enterRepair()` helper:**

```typescript
const enterRepair = (repairState: BiasEngineState) => {
  if (be.state === repairState) return;

  be.state = repairState;
  be.repairStartTs = ts;
  be.acceptBullCount = 0;
  be.acceptBearCount = 0;

  // Remove wrong-side active artifacts
  this.deactivateGate(exec);
  clearSetup();
  invalidateOpp();

  // Neutralize immediately to prevent fighting the flip
  exec.bias = "NEUTRAL";
  exec.baseBiasConfidence = undefined;
  exec.biasConfidence = undefined;
  exec.biasInvalidationLevel = undefined;

  exec.biasPrice = close;
  exec.biasTs = ts;

  if (exec.phase !== "IN_TRADE") {
    exec.phase = "NEUTRAL_PHASE";
    exec.waitReason = "waiting_for_bias";
    exec.expectedResolution = undefined;  // ✅ Clear stale resolution
  }
};
```

**Why:** Prevents `phase=NEUTRAL_PHASE` with `expectedResolution=CONTINUATION` (stale from prior regime).

---

## 5. Fix LLM Maturity Hint Type

**File:** `src/types.ts`

**Current type (from earlier):**
```typescript
llmMaturityHint?: "early" | "developing" | "mature" | "extended" | "unclear";
```

**Check what LLM parser actually emits.** If it includes "exhausting", update to:

```typescript
llmMaturityHint?: "early" | "developing" | "mature" | "extended" | "exhausting" | "unclear";
```

**Or make it more flexible:**
```typescript
llmMaturityHint?: string;  // Accept any string from LLM parser
```

**Check LLM parser output** (`src/llm/llmService.ts:208-210`):
```typescript
const maturity = maturityMatch
  ? (maturityMatch[1].toLowerCase() as "early" | "developing" | "mature" | "extended" | "unclear")
  : "unclear";
```

**If parser doesn't include "exhausting", add it:**
```typescript
const maturity = maturityMatch
  ? (maturityMatch[1].toLowerCase() as "early" | "developing" | "mature" | "extended" | "exhausting" | "unclear")
  : "unclear";
```

---

## 6. Optional: Bias Flip Cooldown Before Setup Arming

**Problem:** If bias flips on the same 5m bar, setup detection might immediately arm a setup for the new bias, which could be premature.

**Solution:** Add a one-bar cooldown after bias flip before allowing new setup to arm.

### detectSetup() Return Type

**File:** `src/orchestrator/orchestrator.ts:1504-1511`

```typescript
private detectSetup(
  exec: MinimalExecutionState,
  current5m: { open: number; high: number; low: number; close: number },
  previous5m: { open: number; high: number; low: number; close: number } | undefined,
  closed5mBars: Array<{ high: number; low: number; close: number; volume: number }>,
  atr: number,
  forming5mBar: Forming5mBar | null // IGNORED - never used to prevent flicker
): { setup: SetupType; triggerPrice?: number; stopPrice?: number } {
  // Returns:
  // - { setup: "PULLBACK_CONTINUATION", triggerPrice: number, stopPrice: number }
  // - { setup: "NONE" }
}
```

### Add Bias Flip Cooldown to MinimalExecutionState

**File:** `src/types.ts`

```typescript
export type MinimalExecutionState = {
  // ... existing fields ...
  
  // Bias flip cooldown (prevent setup arming immediately after flip)
  lastBiasFlipTs?: number;  // Timestamp of last bias flip (for setup cooldown)
  
  // ... rest of fields ...
};
```

### Update finalizeFlip() to Set Cooldown

**File:** `src/orchestrator/orchestrator.ts` (in `updateBiasEngine()`)

```typescript
const finalizeFlip = (newBias: MarketBias, newState: BiasEngineState) => {
  be.state = newState;
  be.lastFlipTs = ts;
  be.repairStartTs = undefined;
  be.acceptBullCount = 0;
  be.acceptBearCount = 0;

  // Set bias flip cooldown (prevent setup arming on same bar)
  exec.lastBiasFlipTs = ts;  // ✅ Track when bias flipped

  // ... rest of finalizeFlip logic
};
```

### Add Cooldown Check in STEP 3 (Setup Detection)

**File:** `src/orchestrator/orchestrator.ts:2553-2594` (STEP 3)

**Add before calling `detectSetup()`:**

```typescript
// Only run setup detection if:
// - Setup is NONE, OR
// - Setup TTL expired, OR
// - Setup was invalidated above
if (exec.setup === "NONE" || !exec.setup || now >= setupTTLExpiry) {
  if (exec.bias === "NEUTRAL") {
    exec.setup = "NONE";
    exec.setupTriggerPrice = undefined;
    exec.setupStopPrice = undefined;
  } else if (lastClosed5m) {
    // Optional: Bias flip cooldown - don't arm setup on same bar as flip
    const biasFlipCooldownMs = 5 * 60 * 1000;  // 5 minutes (one 5m bar)
    const timeSinceBiasFlip = exec.lastBiasFlipTs ? (ts - exec.lastBiasFlipTs) : Infinity;
    const inBiasFlipCooldown = timeSinceBiasFlip < biasFlipCooldownMs;
    
    if (inBiasFlipCooldown) {
      // Bias just flipped - wait one bar before arming new setup
      exec.setup = "NONE";
      exec.setupTriggerPrice = undefined;
      exec.setupStopPrice = undefined;
      console.log(
        `[SETUP_COOLDOWN] Bias flipped ${Math.round(timeSinceBiasFlip / 1000)}s ago - skipping setup detection (cooldown=${biasFlipCooldownMs}ms)`
      );
    } else {
      // Normal setup detection
      const previous5m = closed5mBars.length >= 2 ? closed5mBars[closed5mBars.length - 2] : undefined;
      const atr = this.calculateATR(closed5mBars);
      const setupResult = this.detectSetup(exec, lastClosed5m, previous5m, closed5mBars, atr, null);
      
      // ... rest of setup detection logic
    }
  }
}
```

**Alternative (Simpler):** Just check if bias flipped on this exact bar:

```typescript
// Check if bias flipped on this bar (compare with previous bar's bias)
// This requires tracking previous bias, or checking if lastBiasFlipTs is very recent
const biasJustFlipped = exec.lastBiasFlipTs && (ts - exec.lastBiasFlipTs) < 60 * 1000;  // Within last minute

if (biasJustFlipped) {
  exec.setup = "NONE";
  // ... skip setup detection
} else {
  // Normal setup detection
  const setupResult = this.detectSetup(...);
  // ...
}
```

**Recommendation:** Use the 5-minute cooldown (one bar) - it's safer and prevents premature arming.

---

## Summary Checklist

- [ ] Add STEP 1.5: Always compute derived confidence (even when LLM is null)
- [ ] Add IN_TRADE protection in `updateBiasEngine()` (Option A or B)
- [ ] Add `[BIAS_CHANGE]` log in `updateBiasEngine()`
- [ ] Clear `expectedResolution` in `enterRepair()`
- [ ] Fix `llmMaturityHint` type (include "exhausting" or use `string`)
- [ ] Optional: Add bias flip cooldown before setup arming

---

## Expected Behavior After All Fixes

**Scenario: Bias flips to BULLISH at minute 6**

1. **Minute 6:** `updateBiasEngine()` sets `exec.bias = "BULLISH"`, logs `[BIAS_CHANGE]`
2. **Next 5m close:** 
   - STEP 1: Stores LLM hints (no bias mutation)
   - STEP 1.5: Computes derived confidence (even if LLM null)
   - STEP 2: Checks `stable = true` → `BIAS_ESTABLISHED` ✅
   - STEP 3: Checks bias flip cooldown → skips setup detection (if within 5 min) ✅
   - Next bar: Setup detection runs normally ✅

**Result:** Bias engine owns truth, setup arming is protected from premature flips. ✅
