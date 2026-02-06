# Bias State Debugging Guide

## 4) LLM Responsibility - One Line Answer

**The LLM outputs BOTH `action` (CONTROL) AND `bias` (BIAS), and we map `action + bias` → `execBias`.**

**Bias is NOT allowed to change without an LLM call** - bias only mutates in `reduce5mClose()` STEP 1, which requires `llmDecision !== null`.

---

## Detailed Answers

### What LLM Outputs

**File:** `src/llm/llmService.ts:224-232` (`parseControlSentence()`)

The LLM outputs a control sentence like:
```
CONTROL=WAIT | BIAS=bullish | MATURITY=developing | CONF=65
```

Which is parsed into:
```typescript
{
  action: "WAIT" | "ARM_LONG" | "ARM_SHORT" | "A+",
  bias: "bullish" | "bearish" | "neutral",  // ← LLM outputs this
  confidence: 65,
  maturity: "developing",
  because: "...",
  waiting_for: "..."
}
```

### How We Map to execBias

**File:** `src/orchestrator/orchestrator.ts:2439` (`reduce5mClose()` STEP 1)

```typescript
const newBias = this.llmActionToBias(
  llmDecision.action,  // "WAIT" | "ARM_LONG" | "ARM_SHORT" | "A+"
  llmDecision.bias      // "bullish" | "bearish" | "neutral" (from LLM)
);
```

**File:** `src/orchestrator/orchestrator.ts:1580-1590` (`llmActionToBias()`)

```typescript
private llmActionToBias(action: "ARM_LONG" | "ARM_SHORT" | "WAIT" | "A+", llmBias: "bullish" | "bearish" | "neutral"): "BEARISH" | "BULLISH" | "NEUTRAL" {
  if (action === "ARM_LONG" || (action === "A+" && llmBias === "bullish")) {
    return "BULLISH";
  } else if (action === "ARM_SHORT" || (action === "A+" && llmBias === "bearish")) {
    return "BEARISH";
  } else if (action === "WAIT") {
    // WAIT action: use llmBias directly (LLM can output WAIT with directional bias)
    return this.normalizeBias(llmBias);
  }
  return "NEUTRAL";
}
```

**Key Point:** For `WAIT` actions, we use `llmBias` directly. For `ARM_LONG`/`ARM_SHORT`, we ignore `llmBias` and derive from action.

### Can Bias Change Without LLM Call?

**NO.** Bias only mutates in one place:

**File:** `src/orchestrator/orchestrator.ts:2455` (`reduce5mClose()` STEP 1)

```typescript
if (llmDecision !== null) {
  // ... mapping logic ...
  if (shouldFlip || exec.bias === "NEUTRAL") {
    exec.bias = newBias;  // ← ONLY place bias is assigned
  }
}
```

**Guards:**
- `llmDecision !== null` (requires LLM call to succeed)
- `shouldFlip || exec.bias === "NEUTRAL"` (requires invalidation OR initial establishment)

**The 1m handler (`handleMinimal1m`) CANNOT update bias** - it only reads `exec.bias` for entry evaluation.

---

## 3) State Object / Snapshot at Decision Points

### Current Logging (What Exists)

#### 1. 5m Close Logging
**File:** `src/orchestrator/orchestrator.ts:4367`
```typescript
console.log(
  `[CLOSE5M] ts=${closedBar.ts} lenClosed=${this.recentBars5m.length} o=${closedBar.open.toFixed(2)} h=${closedBar.high.toFixed(2)} l=${closedBar.low.toFixed(2)} c=${closedBar.close.toFixed(2)} v=${closedBar.volume}`
);
```

#### 2. LLM Call Logging
**File:** `src/orchestrator/orchestrator.ts:3109-3111`
```typescript
console.log(
  `[LLM5M] bufferClosed5m=${closed5mBars.length} snapshotClosed5m=${snapshotBars.length} callingLLM=true (5m close detected) barsWindow=60 dailyContext=${dailyContextLite ? "yes" : "no"}${justClosedBar ? " [JUST_CLOSED_INCLUDED]" : ""}`
);
```

#### 3. Bias Application Logging
**File:** `src/orchestrator/orchestrator.ts:2440-2442, 2473-2475`
```typescript
console.log(
  `[LLM_BIAS_MAP] action=${llmDecision.action} llmBias=${llmDecision.bias} -> execBias=${newBias}`
);
console.log(
  `[LLM5M] action=${llmDecision.action} bias=${exec.bias} baseConf=${exec.baseBiasConfidence ?? llmDecision.confidence} derivedConf=${exec.biasConfidence ?? "n/a"}`
);
```

#### 4. Micro State Logging (VWAP/EMA counters)
**File:** `src/orchestrator/orchestrator.ts:3019-3031`
```typescript
console.log("[MICRO]", {
  vwap1m: exec.micro.vwap1m?.toFixed(2),
  ema1m: exec.micro.emaFast1m?.toFixed(2),
  atr1m: exec.micro.atr1m?.toFixed(2),
  sh1m: exec.micro.lastSwingHigh1m?.toFixed(2),
  sl1m: exec.micro.lastSwingLow1m?.toFixed(2),
  aboveVwap: exec.micro.aboveVwapCount,      // ← aboveVwapCount
  aboveEma: exec.micro.aboveEmaCount,        // ← aboveEmaCount
  belowVwap: exec.micro.belowVwapCount,
  belowEma: exec.micro.belowEmaCount,
  pausedUntil: exec.deploymentPauseUntilTs ? new Date(exec.deploymentPauseUntilTs).toISOString() : undefined,
  pauseReason: exec.deploymentPauseReason,
});
```

### Missing: Full State Snapshots at Decision Points

**We need to add JSON dumps at these points:**

1. **Just before breakout (still bearish)** - Before VWAP+EMA acceptance
2. **Right after VWAP+EMA acceptance** - When counters reach threshold
3. **After the next 5m close** - After LLM call and bias update

### Recommended State Snapshot Format

Add this function to `orchestrator.ts`:

```typescript
private logStateSnapshot(
  label: string,
  exec: MinimalExecutionState,
  ts: number,
  close: number,
  closed5mBars: Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }>,
  llmDecision: { action: string; bias: string; confidence: number } | null,
  dailyContextLite: DailyContextLite | undefined
): void {
  const snapshot = {
    label,
    ts,
    timestampET: new Date(ts).toISOString(),
    price: close,
    // Bias fields
    bias: exec.bias,
    execBias: exec.bias,  // Same as bias
    llmBias: llmDecision?.bias ?? null,
    llmAction: llmDecision?.action ?? null,
    baseBiasConfidence: exec.baseBiasConfidence,
    biasConfidence: exec.biasConfidence,
    biasPrice: exec.biasPrice,
    biasTs: exec.biasTs,
    biasInvalidationLevel: exec.biasInvalidationLevel,
    // Phase
    phase: exec.phase,
    // Reference price
    ref: exec.biasPrice ?? exec.thesisPrice ?? null,
    refLabel: exec.biasPrice ? "bias established" : exec.thesisPrice ? "bias established (legacy)" : null,
    // VWAP/EMA counters
    aboveVwapCount: exec.micro?.aboveVwapCount ?? null,
    aboveEmaCount: exec.micro?.aboveEmaCount ?? null,
    belowVwapCount: exec.micro?.belowVwapCount ?? null,
    belowEmaCount: exec.micro?.belowEmaCount ?? null,
    vwap1m: exec.micro?.vwap1m ?? null,
    ema1m: exec.micro?.emaFast1m ?? null,
    // Bar counts
    last5mCloseTs: closed5mBars.length > 0 ? closed5mBars[closed5mBars.length - 1].ts : null,
    barsWindow: 60,
    snapshotClosed5m: closed5mBars.length,
    bufferClosed5m: this.recentBars5m.length,
    // Daily context
    dailyContext: dailyContextLite ? {
      prevClose: dailyContextLite.prevClose,
      prevHigh: dailyContextLite.prevHigh,
      prevLow: dailyContextLite.prevLow,
      overnightHigh: dailyContextLite.overnightHigh,
      overnightLow: dailyContextLite.overnightLow,
      vwapPrevSession: dailyContextLite.vwapPrevSession,
    } : null,
    // Setup/Entry state
    setup: exec.setup ?? null,
    opportunityStatus: exec.opportunity?.status ?? null,
    // Pullback levels
    pullbackHigh: exec.pullbackHigh ?? null,
    pullbackLow: exec.pullbackLow ?? null,
  };
  
  console.log(`[STATE_SNAPSHOT] ${JSON.stringify(snapshot, null, 2)}`);
}
```

### Where to Add State Snapshots

#### Snapshot 1: Just Before Breakout (Still Bearish)
**Location:** `src/orchestrator/orchestrator.ts:3019` (in `handleMinimal1m()`, before VWAP acceptance check)

```typescript
// Add before VWAP acceptance logic
if (exec.bias === "BEARISH" && exec.micro?.aboveVwapCount !== undefined && exec.micro.aboveVwapCount >= 2) {
  // Just before breakout - log state
  const dailyContextLite = this.buildDailyContextLite(exec, closed5mBars, getETDateString(new Date(ts)));
  this.logStateSnapshot("BEFORE_BREAKOUT", exec, ts, close, closed5mBars, null, dailyContextLite);
}
```

#### Snapshot 2: Right After VWAP+EMA Acceptance
**Location:** `src/orchestrator/orchestrator.ts:3009` (after VWAP counter update)

```typescript
exec.micro.aboveVwapCount = close > vwap ? (exec.micro.aboveVwapCount ?? 0) + 1 : 0;
if ((exec.micro.aboveVwapCount ?? 0) >= 2) {
  // Right after VWAP acceptance - log state
  const dailyContextLite = this.buildDailyContextLite(exec, closed5mBars, getETDateString(new Date(ts)));
  this.logStateSnapshot("AFTER_VWAP_ACCEPTANCE", exec, ts, close, closed5mBars, null, dailyContextLite);
}
```

#### Snapshot 3: After Next 5m Close (After LLM Call)
**Location:** `src/orchestrator/orchestrator.ts:2476` (end of STEP 1 in `reduce5mClose()`)

```typescript
console.log(
  `[LLM5M] action=${llmDecision.action} bias=${exec.bias} baseConf=${exec.baseBiasConfidence ?? llmDecision.confidence} derivedConf=${exec.biasConfidence ?? "n/a"}`
);

// Add state snapshot after bias update
if (llmDecision !== null) {
  const currentETDate = getETDateString(new Date(ts));
  const dailyContextLite = this.buildDailyContextLite(exec, closed5mBars, currentETDate);
  this.logStateSnapshot("AFTER_5M_CLOSE", exec, ts, close, closed5mBars, llmDecision, dailyContextLite);
}
```

---

## 5) Chart/Time Anchor

### Current Timestamp Logging

**File:** `src/orchestrator/orchestrator.ts:4367`
```typescript
console.log(
  `[CLOSE5M] ts=${closedBar.ts} lenClosed=${this.recentBars5m.length} o=${closedBar.open.toFixed(2)} h=${closedBar.high.toFixed(2)} l=${closedBar.low.toFixed(2)} c=${closedBar.close.toFixed(2)} v=${closedBar.volume}`
);
```

**File:** `src/index.ts:393`
```typescript
console.log(
  `[CLOSE5M] ts=${closed5m.ts} o=${closed5m.open} h=${closed5m.high} l=${closed5m.low} c=${closed5m.close} v=${closed5m.volume}`
);
```

### To Find Breakout Candle Timestamp

Look for `[CLOSE5M]` logs where:
- `c > o` (bullish close) AND
- Previous bar was bearish (`c < o`)
- This is the breakout candle

The `ts=` value is the timestamp (Unix milliseconds). Convert to ET:
```typescript
new Date(ts).toISOString()  // UTC
// Or use getETDateString() for ET date
```

---

## 2) Bias Update/State Machine Code (Complete)

### The Complete Bias Update Function

**File:** `src/orchestrator/orchestrator.ts:2430-2476` (`reduce5mClose()` STEP 1)

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
    exec.bias = newBias;  // ← PRIMARY BIAS ASSIGNMENT
    exec.baseBiasConfidence = llmDecision.confidence;
    exec.biasPrice = close;  // ← Sets ref "bias established"
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

### Helper: `llmActionToBias()` - Maps LLM output to execBias

**File:** `src/orchestrator/orchestrator.ts:1580-1590`

```typescript
private llmActionToBias(action: "ARM_LONG" | "ARM_SHORT" | "WAIT" | "A+", llmBias: "bullish" | "bearish" | "neutral"): "BEARISH" | "BULLISH" | "NEUTRAL" {
  if (action === "ARM_LONG" || (action === "A+" && llmBias === "bullish")) {
    return "BULLISH";
  } else if (action === "ARM_SHORT" || (action === "A+" && llmBias === "bearish")) {
    return "BEARISH";
  } else if (action === "WAIT") {
    // WAIT action: use llmBias directly (LLM can output WAIT with directional bias)
    return this.normalizeBias(llmBias);
  }
  return "NEUTRAL";
}
```

### Helper: `shouldFlipBias()` - Determines if bias should flip

**File:** `src/orchestrator/orchestrator.ts:1593-1610`

```typescript
// Check if bias should flip (only on structural invalidation)
private shouldFlipBias(currentBias: MarketBias, newBias: MarketBias, invalidationLevel?: number, currentPrice?: number): boolean {
  if (currentBias === newBias || newBias === "NEUTRAL") {
    return false; // No flip needed
  }
  
  // Bias only flips if price crosses invalidation level
  if (invalidationLevel !== undefined && currentPrice !== undefined) {
    if (currentBias === "BULLISH" && currentPrice < invalidationLevel) {
      return true; // Bullish bias invalidated
    }
    if (currentBias === "BEARISH" && currentPrice > invalidationLevel) {
      return true; // Bearish bias invalidated
    }
  }
  
  // If no invalidation level set, allow flip (initial bias establishment)
  return invalidationLevel === undefined;
}
```

### Helper: `normalizeBias()` - Normalizes LLM bias string

**File:** `src/orchestrator/orchestrator.ts:1572-1578`

```typescript
private normalizeBias(llmBias: string | undefined): "BEARISH" | "BULLISH" | "NEUTRAL" {
  if (!llmBias) return "NEUTRAL";
  const normalized = llmBias.toLowerCase();
  if (normalized === "bullish") return "BULLISH";
  if (normalized === "bearish") return "BEARISH";
  return "NEUTRAL";
}
```

---

## Common Bug Patterns (From Your List)

### 1. Bias Only Mutates in 5m LLM Handler ✅ CONFIRMED
- **True:** Bias only mutates in `reduce5mClose()` STEP 1
- **Location:** Line 2455 (`exec.bias = newBias`)
- **Requires:** `llmDecision !== null` (LLM call must succeed)

### 2. Bias is Latched for OPP TTL ❌ NOT THE CASE
- **False:** Bias is NOT latched by opportunity TTL
- **Opportunity TTL** (10 minutes) only affects `exec.opportunity.status`
- **Bias** can change on any 5m close if LLM call succeeds and `shouldFlip` is true

### 3. Invalidation Logic Behind Phase Gate ⚠️ PARTIALLY TRUE
- **Location:** `shouldFlipBias()` (line 1593)
- **Issue:** Invalidation only checks if `invalidationLevel` is set
- **If `invalidationLevel === undefined`:** Bias can flip freely (initial establishment)
- **If `invalidationLevel` is set:** Bias only flips if price crosses it
- **Problem:** `invalidationLevel` is only set if `exec.activeCandidate` exists (line 2460)
- **If no active candidate:** `invalidationLevel` stays `undefined`, allowing free flips

### 4. Counters Reset/Rollover Bug ⚠️ POSSIBLE
- **Location:** `src/orchestrator/orchestrator.ts:3009`
- **Code:** `exec.micro.aboveVwapCount = close > vwap ? (exec.micro.aboveVwapCount ?? 0) + 1 : 0;`
- **Issue:** Counter resets to 0 if `close <= vwap`
- **If price oscillates:** Counter can reset before reaching threshold
- **Check:** Log `[MICRO]` to see if counters persist correctly

### 5. Ref Anchoring Bug ⚠️ POSSIBLE
- **Location:** `src/orchestrator/orchestrator.ts:4108-4114` (ref determination)
- **Issue:** `ref` uses `exec.biasPrice` which is set when bias is applied (line 2457)
- **If bias doesn't update:** `biasPrice` stays old, `ref` stays old
- **Check:** Log `ref` and `biasPrice` in state snapshots

---

## Recommended Fixes (Based on Common Bugs)

### Fix 1: Ensure Invalidation Level is Always Set

**Problem:** If `exec.activeCandidate` is undefined, `invalidationLevel` stays undefined, allowing free bias flips.

**Fix:** Set a default invalidation level based on recent structure:

```typescript
if (exec.activeCandidate) {
  exec.biasInvalidationLevel = exec.activeCandidate.invalidationLevel;
} else {
  // Set default invalidation based on recent swing
  const recentSwing = this.findRecentSwing(closed5mBars, exec.bias);
  if (recentSwing) {
    exec.biasInvalidationLevel = recentSwing.invalidationLevel;
  }
}
```

### Fix 2: Add State Snapshots at Decision Points

Add the `logStateSnapshot()` function and call it at the three decision points listed above.

### Fix 3: Log Continuous State Across Flip

Add logging in `reduce5mClose()` to show state before/after bias update:

```typescript
const previousBias = exec.bias;
const previousPhase = exec.phase;

// ... (bias update logic) ...

if (previousBias !== exec.bias) {
  console.log(`[BIAS_FLIP] ${previousBias} -> ${exec.bias} | price=${close.toFixed(2)} invalidationLevel=${exec.biasInvalidationLevel ?? "none"} shouldFlip=${shouldFlip}`);
}
```

---

## Summary

1. **LLM outputs:** Both `action` (CONTROL) and `bias` (BIAS)
2. **Bias mapping:** `action + bias` → `execBias` via `llmActionToBias()`
3. **Bias mutation:** ONLY in `reduce5mClose()` STEP 1, requires LLM call
4. **State snapshots:** Need to add at 3 decision points (before breakout, after VWAP acceptance, after 5m close)
5. **Timestamp anchor:** Use `[CLOSE5M] ts=...` logs to find breakout candle

The most likely bug is **#3 (Invalidation Logic)** - if `invalidationLevel` is undefined, bias can flip freely even when it shouldn't.
