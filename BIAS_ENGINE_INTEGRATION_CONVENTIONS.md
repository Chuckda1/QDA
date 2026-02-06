# Bias Engine Integration - Exact Conventions

## 1. `deactivateGate()` Function

**File:** `src/orchestrator/orchestrator.ts:596-600`

```typescript
private deactivateGate(exec: MinimalExecutionState): void {
  if (exec.resolutionGate && exec.resolutionGate.status !== "TRIGGERED") {
    exec.resolutionGate.status = "INACTIVE";
  }
}
```

**Note:** Only deactivates if gate is not already `TRIGGERED` (preserves triggered state).

---

## 2. Setup Clearing Convention

**File:** `src/types.ts:160-163`

```typescript
export type SetupType = 
  | "PULLBACK_CONTINUATION"
  | "RIP_REVERSION"
  | "NONE";  // ✅ "NONE" is a valid SetupType value
```

**Standard clearing pattern** (from `reduce5mClose()` line 2537-2540):

```typescript
exec.setup = "NONE";  // ✅ No cast needed - "NONE" is valid
exec.setupTriggerPrice = undefined;
exec.setupStopPrice = undefined;
exec.setupDetectedAt = undefined;
```

**Alternative:** Use `onSetupTransition()` helper (line 603-643) if you want full cleanup:

```typescript
this.onSetupTransition(exec, exec.setup, "NONE", ts);
```

This also:
- Clears `resolutionGate` (sets to `undefined`)
- Clears entry fields (if not in trade)
- Updates `waitReason`

---

## 3. Opportunity Invalidation Convention

**File:** `src/types.ts:185`

```typescript
export type OpportunityStatus = "INACTIVE" | "LATCHED" | "TRIGGERED" | "INVALIDATED" | "EXPIRED" | "CONSUMED";
```

**Standard invalidation pattern** (from `reduce5mClose()` line 2615-2620):

```typescript
if (exec.opportunity) {
  exec.opportunity.status = "INVALIDATED";
  console.log(
    `[OPPORTUNITY_INVALIDATED] ${exec.opportunity.side} reason=${reason}`
  );
  exec.opportunity = undefined;  // Clear after invalidating
}
```

**Note:** Set status first (for logging), then clear the whole object.

---

## 4. Corrected `updateBiasEngine()` Helper Functions

Here are the corrected `neutralize()` and `finalize()` helpers using your exact conventions:

```typescript
// helper: immediately neutralize wrong-side trades without committing full flip
const neutralize = (repairState: BiasEngineState) => {
  if (be.state !== repairState) {
    be.state = repairState;
    be.repairStartTs = ts;

    // IMPORTANT: if we are invalidating a prior thesis, disable any gate/setup side effects
    this.deactivateGate(exec);
    
    // Clear setup using standard pattern
    exec.setup = "NONE";
    exec.setupTriggerPrice = undefined;
    exec.setupStopPrice = undefined;
    exec.setupDetectedAt = undefined;
    
    // Invalidate opportunity if it exists
    if (exec.opportunity) {
      exec.opportunity.status = "INVALIDATED";
      exec.opportunity = undefined;
    }

    // Bias becomes NEUTRAL during repair (prevents shorts fighting a bull flip)
    exec.bias = "NEUTRAL";
    exec.baseBiasConfidence = undefined;
    exec.biasConfidence = undefined;
    exec.biasInvalidationLevel = undefined;
    exec.biasPrice = close;
    exec.biasTs = ts;

    // Phase handling: keep you out of "BIAS_ESTABLISHED" when thesis is being repaired
    if (exec.phase !== "IN_TRADE") {
      exec.phase = "NEUTRAL_PHASE";
    }
  }
};

// helper: finalize bias flip
const finalize = (newBias: MarketBias, newState: BiasEngineState) => {
  be.state = newState;
  be.lastFlipTs = ts;
  be.repairStartTs = undefined;

  exec.bias = newBias;
  exec.biasPrice = close;
  exec.biasTs = ts;

  // Confidence: deterministic baseline (LLM can later grade quality, but bias is now true-state)
  exec.baseBiasConfidence = 65;
  exec.biasConfidence = 65;

  // Reset any stale thesis structures tied to the old side
  exec.biasInvalidationLevel = undefined;
  this.deactivateGate(exec);
  
  // Clear setup using standard pattern
  exec.setup = "NONE";
  exec.setupTriggerPrice = undefined;
  exec.setupStopPrice = undefined;
  exec.setupDetectedAt = undefined;
  
  // Invalidate opportunity if it exists
  if (exec.opportunity) {
    exec.opportunity.status = "INVALIDATED";
    exec.opportunity = undefined;
  }

  if (exec.phase !== "IN_TRADE") {
    exec.phase = "BIAS_ESTABLISHED";
    exec.expectedResolution = "CONTINUATION";
    exec.waitReason = "waiting_for_pullback";
  }
};
```

---

## 5. Type Definitions to Add

Add to `src/types.ts`:

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

// Add to MinimalExecutionState:
export type MinimalExecutionState = {
  // ... existing fields ...
  
  // Bias Engine (deterministic, 1m-based)
  biasEngine?: BiasEngine;
  
  // ... rest of fields ...
};
```

---

## 6. Constants to Add to Orchestrator Class

Add to `src/orchestrator/orchestrator.ts` (class-level constants):

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

## 7. Integration Point: Stop LLM from Overwriting Bias

**File:** `src/orchestrator/orchestrator.ts:2430-2476` (`reduce5mClose()` STEP 1)

**Current code (line 2455):**
```typescript
exec.bias = newBias;  // ❌ This overwrites bias engine
```

**Change to:**
```typescript
// Store LLM bias as advisory hint (for setup/maturity/waiting_for logic)
exec.llmBiasHint = llmDecision.bias as "bullish" | "bearish" | "neutral";
exec.llmActionHint = llmDecision.action;

// DO NOT overwrite exec.bias - bias engine owns it now
// exec.bias = newBias;  // ❌ REMOVED
```

**Add to `MinimalExecutionState` type:**
```typescript
// LLM advisory hints (bias engine owns exec.bias now)
llmBiasHint?: "bullish" | "bearish" | "neutral";
llmActionHint?: string;
```

---

## Summary

✅ **`deactivateGate()`:** Sets `status = "INACTIVE"` (if not TRIGGERED)

✅ **Setup clearing:** `exec.setup = "NONE"` + clear `setupTriggerPrice`, `setupStopPrice`, `setupDetectedAt`

✅ **Opportunity invalidation:** Set `status = "INVALIDATED"`, then `exec.opportunity = undefined`

✅ **No casts needed:** `"NONE"` is a valid `SetupType` value

The corrected helpers above use your exact conventions and will compile cleanly! 🚀
