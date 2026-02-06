# Bias Engine Final Integration Fixes

## Summary of Required Changes

1. ✅ **STEP 1:** Store LLM hints only (don't overwrite bias)
2. ✅ **STEP 2:** Guard phase transitions (prevent REPAIR → BIAS_ESTABLISHED)
3. ✅ **Gate Arming:** Already safe (doesn't use LLM hints)
4. ✅ **Entry Logic:** Already safe (doesn't use LLM hints)

---

## 1. Final STEP 1 Replacement (Clean + Safe)

**File:** `src/orchestrator/orchestrator.ts:2430-2476`

**Replace with:**

```typescript
// ============================================================================
// STEP 1: Store LLM advisory hints (LLM does NOT own exec.bias anymore)
// ============================================================================
if (llmDecision !== null) {
  exec.llmBiasHint = llmDecision.bias as "bullish" | "bearish" | "neutral";
  exec.llmActionHint = llmDecision.action as "WAIT" | "ARM_LONG" | "ARM_SHORT" | "A+";
  exec.llmMaturityHint = llmDecision.maturity;
  exec.llmWaitingForHint = llmDecision.waiting_for;
  exec.llmConfidenceHint = llmDecision.confidence;

  // Legacy compatibility derived from engine-owned bias
  exec.thesisDirection =
    exec.bias === "BULLISH" ? "long" :
    exec.bias === "BEARISH" ? "short" : "none";

  if (exec.bias !== "NEUTRAL") {
    exec.biasConfidence = this.calculateDerivedConfidence(exec, close, closed5mBars, ts);
    exec.thesisConfidence = exec.biasConfidence;
  } else {
    exec.biasConfidence = undefined;
    exec.thesisConfidence = undefined;
  }

  console.log(
    `[LLM_HINT] action=${exec.llmActionHint} biasHint=${exec.llmBiasHint} execBias=${exec.bias} ` +
    `maturity=${exec.llmMaturityHint ?? "n/a"} waiting_for=${exec.llmWaitingForHint ?? "n/a"} ` +
    `llmConf=${exec.llmConfidenceHint ?? "n/a"} derivedConf=${exec.biasConfidence ?? "n/a"}`
  );
}
```

**Key Changes:**
- ❌ Removed `shouldFlipBias()` call (dead code)
- ❌ Removed `exec.bias = newBias` (bias engine owns it)
- ❌ Removed `exec.baseBiasConfidence = llmDecision.confidence` (bias engine sets it)
- ✅ Store all LLM output as hints
- ✅ Log renamed from `[LLM_BIAS_MAP]` to `[LLM_HINT]`
- ✅ Derived confidence computed from engine-owned bias

---

## 2. Guard STEP 2 Phase Transitions (Prevent REPAIR → BIAS_ESTABLISHED)

**File:** `src/orchestrator/orchestrator.ts:2478-2518`

**Current Code (Line 2483):**
```typescript
if (exec.bias !== "NEUTRAL" && exec.biasConfidence !== undefined && exec.biasConfidence >= 65) {
  // Bias is established with sufficient confidence
  if (exec.phase === "NEUTRAL_PHASE") {
    exec.phase = "BIAS_ESTABLISHED";
    // ...
  }
}
```

**Replace with:**
```typescript
// ============================================================================
// STEP 2: Update phase deterministically (engine-owned, never from LLM)
// ============================================================================
// Phase transitions are based on bias, confidence, and market structure
// LLM never sets phase directly
// Guard: Only transition to BIAS_ESTABLISHED if bias engine is in stable state (not REPAIR)
const beState = exec.biasEngine?.state;
const stable = beState === "BULLISH" || beState === "BEARISH";

if (stable && exec.bias !== "NEUTRAL" && exec.biasConfidence !== undefined && exec.biasConfidence >= 65) {
  // Bias is established with sufficient confidence AND bias engine is stable
  if (exec.phase === "NEUTRAL_PHASE") {
    exec.phase = "BIAS_ESTABLISHED";
    exec.expectedResolution = "CONTINUATION";
    exec.waitReason = "waiting_for_pullback";
    shouldPublishEvent = true;
    console.log(
      `[PHASE_TRANSITION] ${previousPhase} -> BIAS_ESTABLISHED | BIAS=${exec.bias} confidence=${exec.biasConfidence} engineState=${beState}`
    );
  } else if (exec.phase === "BIAS_ESTABLISHED" && lastClosed5m) {
    // Check if pullback is developing
    const current5m = forming5mBar ?? lastClosed5m;
    if (exec.pullbackHigh !== undefined && exec.pullbackLow !== undefined) {
      const inPullback = (exec.bias === "BEARISH" && current5m.close < exec.pullbackHigh) ||
                       (exec.bias === "BULLISH" && current5m.close > exec.pullbackLow);
      if (inPullback) {
        exec.phase = "PULLBACK_IN_PROGRESS";
        exec.expectedResolution = "CONTINUATION";
        shouldPublishEvent = true;
        console.log(
          `[PHASE_TRANSITION] ${previousPhase} -> PULLBACK_IN_PROGRESS | BIAS=${exec.bias}`
        );
      }
    }
  }
} else if (exec.bias === "NEUTRAL") {
  if (exec.phase !== "NEUTRAL_PHASE") {
    exec.phase = "NEUTRAL_PHASE";
    exec.waitReason = "waiting_for_bias";
    shouldPublishEvent = true;
    console.log(
      `[PHASE_TRANSITION] ${previousPhase} -> NEUTRAL_PHASE | BIAS=NEUTRAL`
    );
  }
}
```

**Key Change:**
- ✅ Added guard: `const stable = beState === "BULLISH" || beState === "BEARISH"`
- ✅ Only transition to `BIAS_ESTABLISHED` if `stable && ...`
- ✅ Prevents `REPAIR_BULL`/`REPAIR_BEAR` from becoming `BIAS_ESTABLISHED`

---

## 3. Gate Arming Analysis (Already Safe ✅)

**File:** `src/orchestrator/orchestrator.ts:647-875` (`tryArmPullbackGate()`)

**Current Logic:**
- Checks `exec.setup === "PULLBACK_CONTINUATION"` ✅
- Checks `exec.bias === "NEUTRAL"` ✅
- Checks `exec.biasConfidence >= 65` ✅
- Checks `exec.phase` (BIAS_ESTABLISHED or PULLBACK_IN_PROGRESS) ✅
- Checks pullback levels, turn signals, etc. ✅

**Does NOT check:**
- ❌ `exec.llmActionHint` (doesn't require LLM ARM)
- ❌ `exec.llmBiasHint` (uses engine-owned `exec.bias`)

**Conclusion:** Gate arming is already safe - it's purely deterministic based on engine-owned bias.

---

## 4. Entry Logic Analysis (Already Safe ✅)

**File:** `src/orchestrator/orchestrator.ts:3672-3768`

**Current Logic:**
```typescript
const gateReady = exec.resolutionGate?.status === "ARMED";
const readyToEvaluateEntry = oppReady || gateReady;

// Entry permission
const canEnter = entrySignalFires && exec.setup === "PULLBACK_CONTINUATION";
```

**Does NOT check:**
- ❌ `exec.llmActionHint` (doesn't require LLM ARM)
- ❌ `exec.llmBiasHint` (uses engine-owned `exec.bias`)

**Conclusion:** Entry logic is already safe - it uses engine-owned bias and deterministic setup/gate checks.

---

## 5. Optional: Use LLM Hints for Setup Quality Grading (Non-Blocking)

If you want to use LLM hints to **reduce confidence** or **add extra confirmation** (but not block), you can add this in `tryArmPullbackGate()`:

```typescript
// Optional: Use LLM maturity hint to reduce gate confidence (non-blocking)
// If LLM says "extended", maybe require one extra confirmation candle
if (exec.llmMaturityHint === "extended" || exec.llmMaturityHint === "exhausting") {
  // Maybe add extra confirmation requirement here
  // But don't block - just make it slightly harder
}

// Optional: Use LLM waiting_for hint to delay arming slightly
if (exec.llmWaitingForHint?.includes("pullback")) {
  // LLM thinks we need a pullback - maybe we're already in one, so this is fine
  // Or maybe require one more bar of confirmation
}
```

**But this is optional** - the system works fine without it.

---

## 6. Type Definitions to Add

**File:** `src/types.ts`

Add to `MinimalExecutionState`:

```typescript
export type MinimalExecutionState = {
  // ... existing fields ...
  
  // Bias Engine (deterministic, 1m-based)
  biasEngine?: BiasEngine;
  
  // LLM advisory hints (bias engine owns exec.bias now)
  llmBiasHint?: "bullish" | "bearish" | "neutral";
  llmActionHint?: "WAIT" | "ARM_LONG" | "ARM_SHORT" | "A+";
  llmMaturityHint?: "early" | "developing" | "mature" | "extended" | "unclear";
  llmWaitingForHint?: string;
  llmConfidenceHint?: number;
  
  // ... rest of fields ...
};
```

Add new types:

```typescript
export type BiasEngineState = 
  | "BEARISH"
  | "REPAIR_BULL"  // Neutralizing from bearish, moving toward bullish
  | "NEUTRAL"
  | "REPAIR_BEAR"  // Neutralizing from bullish, moving toward bearish
  | "BULLISH";

export type BiasEngine = {
  state: BiasEngineState;
  score: number;  // Signed regime score (positive = bullish, negative = bearish)
  lastFlipTs?: number;  // Timestamp of last full flip (for cooldown)
  repairStartTs?: number;  // When REPAIR state started
  acceptBullCount: number;  // Consecutive minutes of bull acceptance
  acceptBearCount: number;  // Consecutive minutes of bear acceptance
};
```

---

## 7. Constants to Add

**File:** `src/orchestrator/orchestrator.ts` (class-level)

```typescript
export class Orchestrator {
  // ... existing constants ...
  
  // Bias Engine constants
  private readonly BIAS_ENGINE_ENTER_ACCEPT = 6;  // Minutes to enter regime
  private readonly BIAS_ENGINE_EXIT_ACCEPT = 3;  // Minutes to exit regime (hysteresis)
  private readonly BIAS_ENGINE_REPAIR_CONFIRM_MIN = 2;  // Minimum minutes in REPAIR before finalizing (confirmation period)
  private readonly BIAS_ENGINE_COOLDOWN_MS = 5 * 60 * 1000;  // 5 minutes cooldown between full flips
  
  // ... rest of class ...
}
```

---

## Summary Checklist

- [ ] Replace STEP 1 with LLM hints-only version (no bias mutation)
- [ ] Add guard to STEP 2 (prevent REPAIR → BIAS_ESTABLISHED)
- [ ] Add type definitions (`BiasEngine`, `BiasEngineState`, LLM hint fields)
- [ ] Add constants (`BIAS_ENGINE_ENTER_ACCEPT`, etc.)
- [ ] Verify gate arming doesn't use LLM hints (already safe ✅)
- [ ] Verify entry logic doesn't use LLM hints (already safe ✅)
- [ ] Add `updateBiasEngine()` call after `[MICRO]` log in `handleMinimal1m()`
- [ ] Test that bias engine can flip without LLM overwriting it

---

## Expected Behavior After All Fixes

**Scenario: Bias engine flips to BULLISH at minute 6**

1. **Minute 6:** `updateBiasEngine()` sets `exec.bias = "BULLISH"`
2. **Next 5m close:** LLM says "WAIT bearish"
3. **STEP 1:** Stores `exec.llmBiasHint = "bearish"` (hint only)
4. **STEP 2:** Checks `stable = true` (BULLISH is stable) → `BIAS_ESTABLISHED` ✅
5. **STEP 3:** Setup detection uses `exec.bias = "BULLISH"` ✅
6. **STEP 5:** Gate arming uses `exec.bias = "BULLISH"` ✅
7. **Entry logic:** Uses `exec.bias = "BULLISH"` ✅

**Result:** Bias engine owns truth, LLM is advisory only. ✅

---

## Why This Is Safe

1. **Gate arming** (`tryArmPullbackGate`) doesn't check LLM hints - purely deterministic
2. **Entry logic** doesn't check LLM hints - uses engine-owned bias
3. **Setup detection** doesn't check LLM hints - uses engine-owned bias
4. **Phase transitions** now guarded against REPAIR states

The only place LLM hints are used is for **optional quality grading** (non-blocking).
