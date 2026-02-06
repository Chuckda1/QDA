# reduce5mClose() STEP 1 Refactor - LLM Hints Only

## Current Code (Lines 2430-2476)

**Problem:** LLM overwrites `exec.bias`, which will fight the bias engine.

```typescript
// ============================================================================
// STEP 1: Apply bias from LLM (if available)
// ============================================================================
if (llmDecision !== null) {
  const llmDirection: "long" | "short" | "none" = 
    llmDecision.action === "ARM_LONG" ? "long" :
    llmDecision.action === "ARM_SHORT" ? "short" :
    llmDecision.action === "A+" ? (llmDecision.bias === "bearish" ? "short" : "long") : "none";
  
  const newBias = this.llmActionToBias(llmDecision.action as "ARM_LONG" | "ARM_SHORT" | "WAIT" | "A+", llmDecision.bias as "bullish" | "bearish" | "neutral");
  console.log(
    `[LLM_BIAS_MAP] action=${llmDecision.action} llmBias=${llmDecision.bias} -> execBias=${newBias}`
  );
  const shouldFlip = this.shouldFlipBias(
    exec.bias,
    newBias,
    exec.biasInvalidationLevel,
    close
  );

  if (shouldFlip || exec.bias === "NEUTRAL") {
    // Deactivate gate if bias flips
    if (exec.bias !== newBias && exec.bias !== "NEUTRAL") {
      this.deactivateGate(exec);
    }
    exec.bias = newBias;  // ❌ REMOVE THIS - bias engine owns it now
    exec.baseBiasConfidence = llmDecision.confidence;
    exec.biasPrice = close;
    exec.biasTs = ts;
    if (exec.activeCandidate) {
      exec.biasInvalidationLevel = exec.activeCandidate.invalidationLevel;
    }
    exec.biasConfidence = this.calculateDerivedConfidence(exec, close, closed5mBars, ts);
    shouldPublishEvent = true;
  }

  // Legacy compatibility
  exec.thesisDirection = exec.bias === "BULLISH" ? "long" : exec.bias === "BEARISH" ? "short" : "none";
  if (exec.bias !== "NEUTRAL") {
    exec.biasConfidence = this.calculateDerivedConfidence(exec, close, closed5mBars, ts);
    exec.thesisConfidence = exec.biasConfidence;
  }

  console.log(
    `[LLM5M] action=${llmDecision.action} bias=${exec.bias} baseConf=${exec.baseBiasConfidence ?? llmDecision.confidence} derivedConf=${exec.biasConfidence ?? "n/a"}`
  );
}
```

---

## ✅ Refactored Code (LLM Hints Only)

**Key Changes:**
1. Store LLM output as hints (advisory only)
2. Do NOT overwrite `exec.bias` (bias engine owns it)
3. Keep confidence/legacy fields for informational purposes
4. LLM can still influence setup quality via `maturity`/`waiting_for`

```typescript
// ============================================================================
// STEP 1: Store LLM advisory hints (bias engine owns exec.bias now)
// ============================================================================
if (llmDecision !== null) {
  // Store LLM output as hints (for setup quality, waiting_for, maturity)
  exec.llmBiasHint = llmDecision.bias as "bullish" | "bearish" | "neutral";
  exec.llmActionHint = llmDecision.action;
  exec.llmMaturityHint = llmDecision.maturity;
  exec.llmWaitingForHint = llmDecision.waiting_for;
  
  // Keep confidence as informational (LLM can grade setup quality)
  // Note: bias engine sets exec.baseBiasConfidence = 65 on finalize
  // This LLM confidence can be used for setup quality grading later
  exec.llmConfidenceHint = llmDecision.confidence;
  
  // DO NOT set exec.bias here - bias engine owns it now
  // exec.bias = newBias;  // ❌ REMOVED
  
  // Legacy compatibility: update thesisDirection from engine-owned bias
  exec.thesisDirection = exec.bias === "BULLISH" ? "long" : exec.bias === "BEARISH" ? "short" : "none";
  
  // Update derived confidence from engine-owned bias (if not NEUTRAL)
  if (exec.bias !== "NEUTRAL") {
    exec.biasConfidence = this.calculateDerivedConfidence(exec, close, closed5mBars, ts);
    exec.thesisConfidence = exec.biasConfidence;
  }

  console.log(
    `[LLM5M] action=${llmDecision.action} biasHint=${exec.llmBiasHint} execBias=${exec.bias} (engine-owned) ` +
    `maturity=${exec.llmMaturityHint ?? "n/a"} waiting_for=${exec.llmWaitingForHint ?? "n/a"} ` +
    `llmConf=${exec.llmConfidenceHint} derivedConf=${exec.biasConfidence ?? "n/a"}`
  );
}
```

---

## Type Definitions to Add

Add to `MinimalExecutionState` in `src/types.ts`:

```typescript
export type MinimalExecutionState = {
  // ... existing fields ...
  
  // LLM advisory hints (bias engine owns exec.bias now)
  llmBiasHint?: "bullish" | "bearish" | "neutral";
  llmActionHint?: "WAIT" | "ARM_LONG" | "ARM_SHORT" | "A+";
  llmMaturityHint?: "early" | "developing" | "mature" | "extended" | "unclear";
  llmWaitingForHint?: string;
  llmConfidenceHint?: number;
  
  // ... rest of fields ...
};
```

---

## How Setup Detection Still Works

**STEP 3 (lines 2520-2594)** uses `exec.bias` (which is now engine-owned):

```typescript
// STEP 3: Run setup detection (closed bars only, with TTL persistence)
// ...

// This check still works - uses engine-owned bias
if (exec.bias === "NEUTRAL") {
  exec.setup = "NONE";
  // ...
} else if (lastClosed5m) {
  // detectSetup() uses exec.bias internally
  const setupResult = this.detectSetup(exec, lastClosed5m, previous5m, closed5mBars, atr, null);
  // ...
}
```

**Setup detection doesn't need changes** - it reads `exec.bias` which is now owned by the bias engine.

---

## Optional: Use LLM Hints for Setup Quality Grading

You can optionally use LLM hints to influence setup quality (without changing bias):

```typescript
// In detectSetup() or setup quality checks, you can use:
if (exec.llmMaturityHint === "mature" || exec.llmMaturityHint === "extended") {
  // Maybe reduce setup confidence or skip certain setups
}

if (exec.llmWaitingForHint?.includes("pullback")) {
  // LLM thinks we need a pullback - maybe prioritize PULLBACK_CONTINUATION
}
```

But this is **optional** - setup detection will work fine without it.

---

## Summary of Changes

### ✅ What Changes
1. **STEP 1:** Store LLM output as hints instead of overwriting `exec.bias`
2. **Add fields:** `llmBiasHint`, `llmActionHint`, `llmMaturityHint`, `llmWaitingForHint`, `llmConfidenceHint`

### ✅ What Stays the Same
1. **STEP 3 (Setup Detection):** Still uses `exec.bias` (now engine-owned)
2. **STEP 2 (Phase Transitions):** Still uses `exec.bias` (now engine-owned)
3. **Legacy fields:** `thesisDirection`, `thesisConfidence` still updated from engine-owned bias

### ✅ What LLM Can Still Do
1. **Setup quality grading:** Via `maturity`/`waiting_for` hints
2. **Advisory signals:** Store what LLM thinks, but don't enforce it
3. **Entry timing:** `action` hint can influence when to enter (but not bias direction)

### ❌ What LLM Can No Longer Do
1. **Overwrite bias:** `exec.bias` is now owned by bias engine only
2. **Force bias flips:** Bias engine controls all bias changes

---

## Integration Checklist

- [ ] Add LLM hint fields to `MinimalExecutionState` type
- [ ] Replace STEP 1 code with refactored version (store hints, don't set bias)
- [ ] Remove `exec.bias = newBias` line
- [ ] Update logging to show `biasHint` vs `execBias`
- [ ] Verify STEP 3 (setup detection) still works (it should - it reads `exec.bias`)
- [ ] Verify STEP 2 (phase transitions) still works (it should - it reads `exec.bias`)
- [ ] Test that bias engine can flip bias without LLM overwriting it

---

## Expected Behavior After Refactor

**Before (broken):**
- Bias engine flips to BULLISH at minute 6
- Next 5m close: LLM says "WAIT bearish"
- `exec.bias` gets overwritten back to BEARISH ❌

**After (fixed):**
- Bias engine flips to BULLISH at minute 6
- Next 5m close: LLM says "WAIT bearish"
- `exec.llmBiasHint = "bearish"` (stored as hint)
- `exec.bias` stays BULLISH (engine-owned) ✅
- Setup detection uses BULLISH bias ✅
- LLM can still influence setup quality via hints ✅

---

This refactor ensures the bias engine owns truth, while LLM remains advisory for setup quality and timing.
