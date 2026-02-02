# NEUTRAL Bias Bug Diagnosis

## Most Likely Bug

**Root Cause: `llmActionToBias()` ignores `llmBias` parameter when `action === "WAIT"`**

The function `llmActionToBias()` at line 1552-1559 only checks the `action` parameter and returns `"NEUTRAL"` for any `WAIT` action, completely ignoring the `llmBias` field that contains the LLM's directional assessment.

---

## Evidence Chain (One LLM Cycle)

### Step 1: LLM Raw Output
**Location:** `src/llm/llmService.ts:407` (content from API response)
```
Raw string: "CONTROL=WAIT | BIAS=bullish | MATURITY=developing | CONF=65"
```

### Step 2: Parser Output
**Location:** `src/llm/llmService.ts:178-233` (`parseControlSentence()`)
```typescript
// Line 181: controlMatch = "WAIT"
// Line 182: biasMatch = "bullish"
// Line 204-206: bias = "bullish" (correctly parsed)
// Returns: {
//   action: "WAIT",
//   bias: "bullish",  // ✅ Correctly parsed
//   confidence: 65,
//   maturity: "developing"
// }
```

**Result:** Parser correctly extracts `bias: "bullish"` from LLM output.

### Step 3: Bias Conversion (BUG HERE)
**Location:** `src/orchestrator/orchestrator.ts:2403` → `llmActionToBias()`
```typescript
// Line 2403: Called with action="WAIT", llmBias="bullish"
const newBias = this.llmActionToBias("WAIT", "bullish");

// Line 1552-1559: llmActionToBias() implementation
private llmActionToBias(action: "ARM_LONG" | "ARM_SHORT" | "WAIT" | "A+", llmBias: "bullish" | "bearish" | "neutral"): "BEARISH" | "BULLISH" | "NEUTRAL" {
  if (action === "ARM_LONG" || (action === "A+" && llmBias === "bullish")) {
    return "BULLISH";
  } else if (action === "ARM_SHORT" || (action === "A+" && llmBias === "bearish")) {
    return "BEARISH";
  }
  return "NEUTRAL";  // ❌ BUG: Returns NEUTRAL for WAIT, ignoring llmBias="bullish"
}
```

**Result:** `newBias = "NEUTRAL"` (BUG - should be "BULLISH" based on llmBias)

### Step 4: Bias Application
**Location:** `src/orchestrator/orchestrator.ts:2404-2425` (`reduce5mClose()`)
```typescript
// Line 2404: shouldFlip = shouldFlipBias("NEUTRAL", "NEUTRAL", ...)
// Line 1563: shouldFlipBias returns false (currentBias === newBias)

// Line 2411: if (shouldFlip || exec.bias === "NEUTRAL")
//   - shouldFlip = false
//   - exec.bias = "NEUTRAL" (from previous cycle)
//   - Condition is TRUE, so bias is applied

// Line 2416: exec.bias = "NEUTRAL"  // ❌ Applied as NEUTRAL instead of BULLISH
```

**Result:** `exec.bias` remains `"NEUTRAL"` even though LLM said `BIAS=bullish`

---

## Exact File/Line References

### Primary Bug Location
**File:** `src/orchestrator/orchestrator.ts`  
**Lines:** 1552-1559 (`llmActionToBias()` method)

**Offending Code:**
```typescript
private llmActionToBias(action: "ARM_LONG" | "ARM_SHORT" | "WAIT" | "A+", llmBias: "bullish" | "bearish" | "neutral"): "BEARISH" | "BULLISH" | "NEUTRAL" {
  if (action === "ARM_LONG" || (action === "A+" && llmBias === "bullish")) {
    return "BULLISH";
  } else if (action === "ARM_SHORT" || (action === "A+" && llmBias === "bearish")) {
    return "BEARISH";
  }
  return "NEUTRAL";  // ❌ Line 1558: Ignores llmBias when action is WAIT
}
```

### Call Site
**File:** `src/orchestrator/orchestrator.ts`  
**Line:** 2403 (in `reduce5mClose()`)

```typescript
const newBias = this.llmActionToBias(llmDecision.action, llmDecision.bias);
```

### Parser (Working Correctly)
**File:** `src/llm/llmService.ts`  
**Lines:** 204-206 (`parseControlSentence()`)

```typescript
const bias = biasMatch 
  ? (biasMatch[1].toLowerCase() as "bullish" | "bearish" | "neutral")
  : (action === "ARM_LONG" ? "bullish" : action === "ARM_SHORT" ? "bearish" : "neutral");
```

**Note:** Parser correctly extracts bias from LLM output. The bug is in the conversion function.

---

## Root Cause Verdict (Ranked by Likelihood)

### ✅ (A) WAIT → NEUTRAL collapse in llmActionToBias (CONFIRMED - 100% confidence)

**Evidence:**
- `llmActionToBias()` explicitly returns `"NEUTRAL"` for any `WAIT` action (line 1558)
- Function signature accepts `llmBias` parameter but never uses it when `action === "WAIT"`
- This matches the observed behavior: `action=WAIT bias=NEUTRAL` in logs

**Impact:** Every LLM call with `CONTROL=WAIT` results in `exec.bias = "NEUTRAL"` regardless of LLM's `BIAS` field.

---

### (B) Parser defaulting to NEUTRAL (UNLIKELY - 0% confidence)

**Evidence:**
- Parser correctly extracts `bias` from LLM output (line 204-206)
- Parser only defaults to `"neutral"` if `biasMatch` is null AND `action === "WAIT"` (line 206)
- If LLM outputs `BIAS=bullish`, parser will extract it correctly

**Verdict:** Parser is working correctly. Not the bug.

---

### (C) shouldFlipBias blocking (SECONDARY ISSUE - 20% confidence)

**Evidence:**
- `shouldFlipBias()` returns `false` if `newBias === "NEUTRAL"` (line 1563)
- However, `reduce5mClose()` applies bias if `exec.bias === "NEUTRAL"` (line 2411)
- So even if `shouldFlip = false`, bias will be applied when transitioning from NEUTRAL

**Verdict:** Not the primary bug, but could prevent transitions if bias was already directional. The main issue is that `newBias` is always `"NEUTRAL"` when action is WAIT.

---

### (D) Prompt not in effect (UNLIKELY - 5% confidence)

**Evidence:**
- Prompt is correctly defined in `src/llm/llmService.ts:315-410`
- Prompt includes "Separate BIAS from CONTROL" rules
- Prompt is passed to LLM API (line 386)
- Recent commit shows prompt was updated

**Verdict:** Prompt is in effect. LLM is likely outputting `BIAS=bullish` or `BIAS=bearish`, but the parser result is being discarded by `llmActionToBias()`.

---

## Minimal Fix Proposal

### Fix 1: Update `llmActionToBias()` to respect `llmBias` for WAIT actions

**File:** `src/orchestrator/orchestrator.ts`  
**Lines:** 1552-1559

**Current Code:**
```typescript
private llmActionToBias(action: "ARM_LONG" | "ARM_SHORT" | "WAIT" | "A+", llmBias: "bullish" | "bearish" | "neutral"): "BEARISH" | "BULLISH" | "NEUTRAL" {
  if (action === "ARM_LONG" || (action === "A+" && llmBias === "bullish")) {
    return "BULLISH";
  } else if (action === "ARM_SHORT" || (action === "A+" && llmBias === "bearish")) {
    return "BEARISH";
  }
  return "NEUTRAL";  // ❌ BUG
}
```

**Fixed Code:**
```typescript
private llmActionToBias(action: "ARM_LONG" | "ARM_SHORT" | "WAIT" | "A+", llmBias: "bullish" | "bearish" | "neutral"): "BEARISH" | "BULLISH" | "NEUTRAL" {
  if (action === "ARM_LONG" || (action === "A+" && llmBias === "bullish")) {
    return "BULLISH";
  } else if (action === "ARM_SHORT" || (action === "A+" && llmBias === "bearish")) {
    return "BEARISH";
  } else if (action === "WAIT") {
    // WAIT action: use llmBias directly (LLM can output WAIT with directional bias)
    return llmBias === "bullish" ? "BULLISH" : llmBias === "bearish" ? "BEARISH" : "NEUTRAL";
  }
  return "NEUTRAL";
}
```

**Change:** Add explicit handling for `action === "WAIT"` that respects `llmBias` parameter.

---

## Logging/Instrumentation Plan

Add detailed logging at each step of the LLM decision pipeline:

### 1. Log Raw LLM Output
**Location:** `src/llm/llmService.ts:407` (after receiving API response)
```typescript
console.log(`[LLM_RAW] content="${content.trim()}"`);
```

### 2. Log Parsed Decision
**Location:** `src/llm/llmService.ts:410` (after normalization)
```typescript
if (normalized) {
  console.log(`[LLM_PARSED] action=${normalized.action} bias=${normalized.bias} conf=${normalized.confidence} maturity=${normalized.maturity}`);
  return { decision: normalized, valid: true };
}
```

### 3. Log Bias Conversion
**Location:** `src/orchestrator/orchestrator.ts:2403` (after llmActionToBias call)
```typescript
const newBias = this.llmActionToBias(llmDecision.action, llmDecision.bias);
console.log(`[BIAS_CONVERSION] llmAction=${llmDecision.action} llmBias=${llmDecision.bias} -> newBias=${newBias}`);
```

### 4. Log Final Applied State
**Location:** `src/orchestrator/orchestrator.ts:2416` (after bias assignment)
```typescript
exec.bias = newBias;
console.log(`[BIAS_APPLIED] oldBias=${previousBias} newBias=${newBias} shouldFlip=${shouldFlip} execBiasWasNeutral=${exec.bias === "NEUTRAL"} baseConf=${exec.baseBiasConfidence} derivedConf=${exec.biasConfidence}`);
```

### 5. Log Phase Transition
**Location:** `src/orchestrator/orchestrator.ts:2444-2478` (in phase update logic)
```typescript
if (exec.bias !== "NEUTRAL" && exec.biasConfidence !== undefined && exec.biasConfidence >= 65) {
  if (exec.phase === "NEUTRAL_PHASE") {
    console.log(`[PHASE_TRANSITION] NEUTRAL_PHASE -> BIAS_ESTABLISHED | bias=${exec.bias} conf=${exec.biasConfidence} (threshold=65)`);
    exec.phase = "BIAS_ESTABLISHED";
    // ...
  }
} else if (exec.bias === "NEUTRAL") {
  if (exec.phase !== "NEUTRAL_PHASE") {
    console.log(`[PHASE_TRANSITION] ${previousPhase} -> NEUTRAL_PHASE | bias=NEUTRAL conf=${exec.biasConfidence}`);
    exec.phase = "NEUTRAL_PHASE";
    // ...
  }
}
```

---

## Summary

**Bug:** `llmActionToBias()` returns `"NEUTRAL"` for all `WAIT` actions, ignoring the `llmBias` parameter that contains the LLM's directional assessment.

**Fix:** Add explicit handling for `action === "WAIT"` that converts `llmBias` to the corresponding `MarketBias` enum value.

**Impact:** This single-line logic change will allow the bot to establish directional bias (`BULLISH`/`BEARISH`) even when `CONTROL=WAIT`, matching the intended "Separate BIAS from CONTROL" architecture.
