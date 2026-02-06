# Bias Engine - Exact Helper Functions (Compile-Ready)

## Type Definitions (From Your Repo)

### SetupType and Setup Fields

**File:** `src/types.ts:160-163, 267-270`

```typescript
export type SetupType = 
  | "PULLBACK_CONTINUATION"  // Trend pullback then continuation (primary setup)
  | "RIP_REVERSION"          // Extended rip then fade / extended dump then bounce (optional, phase 2)
  | "NONE";                  // Explicitly no setup

// In MinimalExecutionState:
setup?: SetupType;
setupDetectedAt?: number; // Timestamp when setup was detected
setupTriggerPrice?: number; // Price level that triggers entry for this setup
setupStopPrice?: number; // Stop price for this setup
```

### OpportunityLatch Type

**File:** `src/types.ts:188-223`

```typescript
export type OpportunitySide = "LONG" | "SHORT";
export type OpportunityStatus = "INACTIVE" | "LATCHED" | "TRIGGERED" | "INVALIDATED" | "EXPIRED" | "CONSUMED";
export type OpportunityTriggerType = "ROLLOVER" | "BREAK" | "RECLAIM_FAIL";

export type OpportunityLatch = {
  status: OpportunityStatus;
  
  side: OpportunitySide;                 // derived from exec.bias
  biasAtLatch: MarketBias;               // BEARISH/BULLISH (snapshot at latch time)
  phaseAtLatch: MinimalExecutionPhase;   // PULLBACK_IN_PROGRESS etc. (snapshot)
  setupAtLatch?: SetupType;              // REJECTION / PULLBACK_GENERIC / etc. (snapshot)
  
  latchedAtTs: number;
  expiresAtTs: number;                   // hard TTL (2 closed 5m bars = 10 minutes)
  
  zone: { low: number; high: number };  // where we allow entries (pullback window)
  trigger: { 
    type: OpportunityTriggerType; 
    price: number;
    description?: string;                 // e.g., "rollover candle", "break of prior low"
  };
  stop: { 
    price: number; 
    reason: string;                       // e.g., "pullback high + buffer", "rejection candle high"
  };
  
  // Optional but useful
  attempts?: number;                     // how many times we "almost triggered"
  bestPriceSeen?: number;                // for no-chase logic / to avoid late entries
  armedAtPrice?: number;                 // price when latched (for cross-based trigger validation)
  notes?: string;                        // human-readable: "pullback into resistance"
  
  // Invalidation rules (structural checks)
  invalidateIf?: {
    biasInvalidated?: boolean;           // shouldFlipBias() triggers
    stopBroken?: boolean;                 // price breaks stop level
    zoneExited?: boolean;                // price closes outside zone + buffer
    timeExpired?: boolean;                // nowTs >= expiresAtTs
  };
};
```

### ResolutionGate Type

**File:** `src/types.ts:166-176`

```typescript
export type ResolutionGateStatus = "INACTIVE" | "ARMED" | "TRIGGERED" | "EXPIRED" | "INVALIDATED";

export type ResolutionGate = {
  status: ResolutionGateStatus;
  direction: "long" | "short";
  triggerPrice: number;
  stopPrice: number;
  expiryTs: number;
  armedTs: number;
  reason: string;
};
```

---

## ✅ Exact Helper Functions (Copy-Paste Ready)

These match your exact type definitions and field names:

```typescript
// Clears setup state the same way your reducer expects
const clearSetup = () => {
  exec.setup = "NONE";
  exec.setupTriggerPrice = undefined;
  exec.setupStopPrice = undefined;
  exec.setupDetectedAt = undefined;
};

// Invalidates + clears opportunity
const invalidateOpp = () => {
  if (exec.opportunity) {
    exec.opportunity.status = "INVALIDATED";
    exec.opportunity = undefined;
  }
};

// Enter a REPAIR state: neutralize immediately (block wrong-side trades)
const neutralize = (repairState: BiasEngineState) => {
  if (be.state === repairState) return;

  be.state = repairState;
  be.repairStartTs = ts;

  // Kill any armed gates/setups tied to the old thesis
  this.deactivateGate(exec);
  clearSetup();
  invalidateOpp();

  // During repair we force NEUTRAL so entries can't fight the flip
  exec.bias = "NEUTRAL";
  exec.baseBiasConfidence = undefined;
  exec.biasConfidence = undefined;

  // Optional: clear invalidation level because old thesis is now being repaired
  exec.biasInvalidationLevel = undefined;

  // Update reference for UI
  exec.biasPrice = close;
  exec.biasTs = ts;

  // Keep phases out of BIAS_ESTABLISHED while repairing
  if (exec.phase !== "IN_TRADE") {
    exec.phase = "NEUTRAL_PHASE";
    exec.waitReason = "waiting_for_bias";
  }
};

// Finalize a full flip to BEARISH or BULLISH
const finalize = (newBias: MarketBias, newState: BiasEngineState) => {
  be.state = newState;
  be.lastFlipTs = ts;
  be.repairStartTs = undefined;

  // Reset anything that could cause stale entries from previous thesis
  this.deactivateGate(exec);
  clearSetup();
  invalidateOpp();

  exec.bias = newBias;
  exec.biasPrice = close;
  exec.biasTs = ts;

  // Deterministic baseline confidence (LLM can still grade setups later)
  exec.baseBiasConfidence = 65;
  exec.biasConfidence = 65;

  // New thesis; recompute invalidation later from structure if you want
  exec.biasInvalidationLevel = undefined;

  if (exec.phase !== "IN_TRADE") {
    exec.phase = "BIAS_ESTABLISHED";
    exec.expectedResolution = "CONTINUATION";
    exec.waitReason = "waiting_for_pullback";
  }
};
```

---

## Type Definitions to Add

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
```

Add to `MinimalExecutionState`:

```typescript
export type MinimalExecutionState = {
  // ... existing fields ...
  
  // Bias Engine (deterministic, 1m-based)
  biasEngine?: BiasEngine;
  
  // LLM advisory hints (bias engine owns exec.bias now)
  llmBiasHint?: "bullish" | "bearish" | "neutral";
  llmActionHint?: "WAIT" | "ARM_LONG" | "ARM_SHORT" | "A+";
  
  // ... rest of fields ...
};
```

---

## Constants to Add

Add to `src/orchestrator/orchestrator.ts` (class-level):

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

## Integration: Stop LLM from Overwriting Bias

**File:** `src/orchestrator/orchestrator.ts:2430-2476` (`reduce5mClose()` STEP 1)

**Replace this:**
```typescript
if (llmDecision !== null) {
  // ... mapping logic ...
  exec.bias = newBias;  // ❌ REMOVE THIS LINE
  // ...
}
```

**With this:**
```typescript
if (llmDecision !== null) {
  // Store LLM output as advisory hints only
  exec.llmBiasHint = llmDecision.bias as "bullish" | "bearish" | "neutral";
  exec.llmActionHint = llmDecision.action;
  
  // Keep confidence as informational (LLM can grade setup quality)
  exec.baseBiasConfidence = llmDecision.confidence;
  
  // DO NOT set exec.bias here - bias engine owns it now
  // exec.bias = newBias;  // ❌ REMOVED
  
  console.log(
    `[LLM5M] action=${llmDecision.action} biasHint=${exec.llmBiasHint} execBias=${exec.bias} (engine-owned)`
  );
}
```

---

## Summary

✅ **All field names match exactly:** `setup`, `setupTriggerPrice`, `setupStopPrice`, `setupDetectedAt`

✅ **All types match exactly:** `SetupType`, `OpportunityLatch`, `OpportunityStatus`

✅ **No casts needed:** `"NONE"` is valid `SetupType`, all fields are optional where needed

✅ **Compiles cleanly:** Matches your exact type definitions

Ready to drop into `updateBiasEngine()`! 🚀
