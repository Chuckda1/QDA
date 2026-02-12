# All Code Problems - Comprehensive List

This document lists all code problems identified during the audit, organized by category and severity.

---

## 🔴 CRITICAL ISSUES (Fix Immediately)

### Issue #1: `lastLLMCallAt` and `lastLLMDecision` Never Updated
**Location:** `src/orchestrator/orchestrator.ts:4487-4512`

**Problem:**
After calling `maybeUpdateLlmDirection1m`, the code doesn't update `this.state.lastLLMCallAt` or `this.state.lastLLMDecision`. These `BotState` fields remain `null`, so PULSE logs always show them as null.

**Code:**
```typescript
// Line 4488-4512: LLM 1m is called but state is never updated
const result = await maybeUpdateLlmDirection1m(...);
if (result.shouldPublish && result.direction && result.confidence !== undefined) {
  events.push({ type: "LLM_1M_OPINION", ... });
  // MISSING: this.state.lastLLMCallAt = ts;
  // MISSING: this.state.lastLLMDecision = `${result.direction} (${result.confidence}%)`;
}
```

**Fix:**
```typescript
if (result.direction && result.confidence !== undefined) {
  this.state.lastLLMCallAt = ts;
  this.state.lastLLMDecision = `${result.direction} (${result.confidence}%)`;
}
```

---

### Issue #2: LLM 1m Bias Overriding 5m Engine (Category A)
**Location:** `src/orchestrator/orchestrator.ts:1992, 2027`

**Problem:**
LLM 1m can directly set `exec.bias` when bias is NEUTRAL, potentially conflicting with 5m engine's canonical bias. This creates a split-brain situation where LLM and 5m structure compete for bias control.

**Code:**
```typescript
// Line 1992: Direct bias write from LLM
exec.bias = "BULLISH";
be.state = "BULLISH";  // Also sets bias engine state

// Line 2027: Direct bias write from LLM
exec.bias = "BEARISH";
be.state = "BEARISH";
```

**Impact:**
- LLM can set bias before 5m structure finalizes
- `finalizeBiasFrom5m()` may not run because bias is no longer NEUTRAL
- Trading decisions use conflicting bias sources

**Fix:**
Separate bias into two fields:
```typescript
// In MinimalExecutionState type:
bias_5m: MarketBias;  // Canonical, from 5m structure
tilt_1m?: "LONG" | "SHORT" | null;  // LLM 1m timing hint only

// Trading decisions use bias_5m
// LLM tilt only affects entry timing, not bias itself
```

---

### Issue #3: Trigger Detector Not Wired into Setup Arming (Category C)
**Location:** `src/orchestrator/orchestrator.ts:1242, 4992, 5985-6023`

**Problem:**
"TRIGGER HIT" alerts are emitted, but entry may be blocked. No mechanism to "remember" trigger hit for later consumption when entry becomes unblocked.

**Code Path:**
1. `checkOpportunityTrigger()` detects trigger (Line 1242)
2. `exec.opportunity.status = "TRIGGERED"` (Line 4992+)
3. `shouldBlockEntry()` may return `true` (Line 2845)
4. `TRIGGER_BLOCKED_ALERT` emitted (Line 5985-6023)
5. **Problem:** No `pendingTrigger` latch to remember trigger hit

**Fix:**
Add pendingTrigger latch:
```typescript
// In MinimalExecutionState:
pendingTrigger?: {
  timestamp: number;
  triggerPrice: number;
  side: "LONG" | "SHORT";
  reason: string;
};

// When trigger hits but entry blocked:
if (triggerCheck.triggered && entryBlocked) {
  exec.pendingTrigger = {
    timestamp: ts,
    triggerPrice: exec.opportunity.trigger.price,
    side: exec.opportunity.side,
    reason: triggerCheck.reason
  };
}
```

---

## 🟠 HIGH PRIORITY ISSUES

### Issue #4: Duplicate CLOSE5M Logs
**Locations:** 
- `src/index.ts:393-395` (when BarAggregator returns closed5m)
- `src/orchestrator/orchestrator.ts:6437-6439` (in `handleMinimal5m`)

**Problem:**
The same 5m bar close is logged twice, causing duplicate log entries and confusion.

**Fix:**
Remove duplicate log in `index.ts:393-395` (keep the one in orchestrator.ts since it's closer to state update).

---

### Issue #5: Dual 5m Bar Builders (Separate State Objects)
**Locations:**
- `src/datafeed/barAggregator.ts` - Maintains `bucketStartTs`, `cur`
- `src/orchestrator/orchestrator.ts` - Maintains `formingBucketStart`, `forming5mBar`

**Problem:**
Two independent 5m bar aggregation systems maintain separate state. They can desync if:
- One initializes before the other
- One receives bars the other doesn't
- Timing differences cause different bucket calculations

**Evidence:**
Logs show `[MINIMAL][ROLLOVER]` before `[CLOSE5M]`, indicating different detection points.

**Fix:**
Unify to single source of truth - remove Orchestrator's `forming5mBar`, use only BarAggregator.

---

### Issue #6: Race Condition - CLOSE5M Logged Before State Commit
**Location:** `src/index.ts:360-413`

**Problem:**
`last5mCloseTs` is updated AFTER rollover is detected and logged.

**Order of Operations:**
```
1. handleMinimal1m() called
   → Detects rollover
   → Logs [MINIMAL][ROLLOVER]  ← ROLLOVER logged HERE
   → Does NOT update last5mCloseTs yet

2. BarAggregator.push1m() called
   → Returns closed5m if bucket completed

3. handleMinimal5m() called (if closed5m !== null)
   → Updates this.state.last5mCloseTs = closedBar.ts  ← State updated HERE
   → Logs [CLOSE5M]
```

**Impact:**
- If pulse logger runs between steps 1 and 3, it reads stale `last5mCloseTs`
- Pulse logger runs every 60 seconds

**Fix:**
Update `last5mCloseTs` before logging rollover:
```typescript
// In handleMinimal1m, when rollover detected:
if (is5mClose && justClosedBar) {
  // Update state FIRST
  this.state.last5mCloseTs = justClosedBar.ts;
  // Then log
  console.log(`[MINIMAL][ROLLOVER] ...`);
}
```

---

### Issue #7: VWAP Chop / Whipsaw (Lack of Hysteresis) - Category B
**Location:** `src/orchestrator/orchestrator.ts:1750-1751, 1954-1955`

**Problem:**
VWAP/EMA comparisons flip on single-candle moves, causing bias engine to flip-flop.

**Code:**
```typescript
// Line 1750-1751: Single-candle check, no deadband
const farAbove = close > vwap + minDist && close > ema + minDist;
const farBelow = close < vwap - minDist && close < ema - minDist;

// minDist is only 0.10 * atr - very small
```

**Fix:**
Add deadband + persistence + cooldown:
```typescript
const deadband = atr ? 0.15 * atr : 0.10;  // Wider deadband
const farAbove = close > vwap + minDist + deadband && close > ema + minDist + deadband;
const farBelow = close < vwap - minDist - deadband && close < ema - minDist - deadband;

// Require 3+ consecutive closes before accepting
exec.consecutiveAboveVwap = (close > vwap + deadband) ? (exec.consecutiveAboveVwap ?? 0) + 1 : 0;
const bullAccept = exec.consecutiveAboveVwap >= 3 && aboveVwap >= this.BIAS_ENGINE_ENTER_ACCEPT;
```

---

### Issue #8: Phase Transition Gated by Multiple Conditions
**Location:** `src/orchestrator/orchestrator.ts:3849`

**Problem:**
Phase stays `NEUTRAL_PHASE` forever if any condition fails:
1. `stable` = bias engine state is "BULLISH" or "BEARISH" (not "REPAIR")
2. `exec.bias !== "NEUTRAL"`
3. `exec.biasConfidence >= 65`

**Code:**
```typescript
if (stable && exec.bias !== "NEUTRAL" && exec.biasConfidence !== undefined && exec.biasConfidence >= 65) {
  // Only then transition to BIAS_ESTABLISHED
}
```

**Fix:**
Lower confidence threshold for initial establishment:
```typescript
const minConfidence = exec.phase === "NEUTRAL_PHASE" ? 50 : 65;  // Lower for initial
if (stable && exec.bias !== "NEUTRAL" && exec.biasConfidence !== undefined && exec.biasConfidence >= minConfidence) {
  // ...
}
```

---

## 🟡 MEDIUM PRIORITY ISSUES

### Issue #9: `bars5mCount` Reset to 0 After Pulse Log
**Location:** `src/index.ts:97-112`

**Problem:**
`bars5mCount` is reset to 0 after each pulse log, so it's not a reliable indicator of new bars. It only shows bars closed since the last pulse (60 seconds).

**Code:**
```typescript
function logStructuredPulse(...) {
  const pulse = {
    bars5mCount,  // ← Shows count since last pulse
    ...
  };
  console.log(`[PULSE] ${JSON.stringify(pulse)}`);
  bars5mCount = 0;  // ← RESET HERE - loses information
}
```

**Fix:**
Remove `bars5mCount` from pulse or make it cumulative:
```typescript
// Option: Remove it
// Option: Make cumulative in orchestrator state
this.state.totalBars5mClosed++;
```

---

### Issue #10: LLM 1m Throttled to Max Once Per 60 Seconds
**Location:** `src/llm/llmDirection1m.ts:58-61`

**Problem:**
If a 5m bar closes within 60s of the last LLM call, the LLM call is skipped. This is intentional throttling, but may cause missed opportunities.

**Code:**
```typescript
if (exec.llm1mLastCallTs !== undefined && (ts - exec.llm1mLastCallTs) < THROTTLE_MS) {
  return { shouldPublish: false };
}
```

**Note:** This is intentional, not a bug. But consider reducing throttle to 30s for faster response.

---

### Issue #11: `reduce5mClose` Only Called If `is5mClose && lastClosed5m`
**Location:** `src/orchestrator/orchestrator.ts:4586`

**Problem:**
If `lastClosed5m` is null (no closed bars yet), `reduce5mClose` never runs, so:
- No setup detection
- No phase transitions
- No opportunity latching

**Fix:**
Ensure `reduce5mClose` runs even with minimal bars (with appropriate guards).

---

### Issue #12: Setup Detection Gated by `exec.bias !== "NEUTRAL"`
**Location:** `src/orchestrator/orchestrator.ts:2584` (in `detectSetup`)

**Problem:**
If bias is NEUTRAL, setup is forced to NONE, so no setups are detected.

**Code:**
```typescript
// Bias Check:
// If exec.bias === "NEUTRAL", setup is forced to "NONE" (no detection run)
```

**Impact:**
Chicken-egg problem: need bias to detect setup, need setup to establish bias.

**Fix:**
Allow setup detection with weak bias or LLM tilt.

---

### Issue #13: Multiple Functions Gated by `closed5mBars.length` Thresholds
**Locations:** Various (see table below)

**Problem:**
With insufficient bars, many features are disabled, keeping bot in NEUTRAL.

| Function | Threshold | Location | Impact |
|----------|-----------|----------|--------|
| `calculateDerivedConfidence` | `>= 6` | Line 2440 | Confidence undefined if < 6 bars |
| `detectSetup` | `>= 2` | Line 2584 | No setup detection if < 2 bars |
| `calculateATR` | `>= 3` | Line 2810 | ATR = 0 if < 3 bars |
| `detectLateEntry` | `>= 30` | Line 3079, 3182 | Late entry detection disabled |
| `checkMomentumFailure` | `>= 36` | Line 3098, 3383 | Momentum checks disabled |
| `finalizeBiasFrom5m` | `>= 3` | Line 3838 | No bias finalization if < 3 bars |

**Fix:**
Allow partial-window processing with logging:
```typescript
if (closed5mBars.length < this.minimalLlmBars) {
  console.log(`[PARTIAL_WINDOW] Using ${closed5mBars.length} bars (less than ${this.minimalLlmBars}) - context may be limited`);
  // Still allow processing, but with reduced confidence
}
```

---

### Issue #14: Trade Management Alerts Missing (TP Hit Not Visible) - Category D
**Location:** `src/orchestrator/orchestrator.ts:5808-5816, 6059-6084`

**Problem:**
TP hits are detected but alert emission has timestamp matching issue. Alert only emitted if `exec.lastTargetHit.timestamp === ts` exactly.

**Code:**
```typescript
// Line 6059: Strict timestamp matching
if (exec.lastTargetHit && exec.lastTargetHit.timestamp === ts) {
  // Emit alert
}
```

**Fix:**
Emit alert immediately when target hit:
```typescript
// In trade management block (Line 5818+), emit immediately:
if (targetHit !== undefined) {
  // ... store in exec.lastTargetHit ...
  
  // Emit alert immediately (don't wait for later)
  events.push({
    type: "TRADING_ALERT",
    timestamp: ts,
    data: { ... }
  });
}
```

---

## 🟢 LOW PRIORITY ISSUES

### Issue #15: Coaching Gating and Contradictions - Category E
**Location:** `src/orchestrator/orchestrator.ts:6254, 6337`

**Problem:**
Coaching filtering only checks BEARISH + long coaching. Doesn't check BULLISH + short coaching, incomplete filtering.

**Code:**
```typescript
coachLine: (exec.bias === "BEARISH" && exec.setup !== "PULLBACK_CONTINUATION" && exec.setup !== "IGNITION" && exec.llm1mCoachLine?.toLowerCase().includes("long")) 
  ? undefined 
  : exec.llm1mCoachLine,
```

**Fix:**
Expand filtering:
```typescript
const shouldFilterCoaching = (coachLine: string | undefined, bias: MarketBias, setup: string | undefined): boolean => {
  if (!coachLine) return false;
  const lower = coachLine.toLowerCase();
  const isLong = lower.includes("long") || lower.includes("buy") || lower.includes("bull");
  const isShort = lower.includes("short") || lower.includes("sell") || lower.includes("bear");
  
  if (bias === "BEARISH" && isLong && setup !== "PULLBACK_CONTINUATION" && setup !== "IGNITION") return true;
  if (bias === "BULLISH" && isShort && setup !== "PULLBACK_CONTINUATION" && setup !== "IGNITION") return true;
  return false;
};
```

---

### Issue #16: Phase vs Setup Conflation - Category F
**Location:** `src/orchestrator/orchestrator.ts:3858-3909`

**Problem:**
Phase may be inferred from setup intent instead of actual price behavior. Phase transitions are price-based (good), but setup can influence phase.

**Code:**
```typescript
// Phase is based on price position relative to pullbackHigh/pullbackLow
// But pullbackHigh/pullbackLow are set based on setup detection
if (inZone) {
  exec.phase = "PULLBACK_IN_PROGRESS";
} else if (extended) {
  exec.phase = "EXTENSION";
}
```

**Fix:**
Ensure phase reflects actual price behavior, not setup intent:
```typescript
// Phase: Market behavior (where is price?)
// Setup: Strategy intent (what are we waiting for?)
// They are independent
```

---

## 📊 Summary Table

| Issue # | Category | Severity | Location | Status |
|---------|----------|----------|----------|--------|
| 1 | State Update | 🔴 Critical | `orchestrator.ts:4487-4512` | Not Fixed |
| 2 | LLM Bias Override | 🔴 Critical | `orchestrator.ts:1992, 2027` | Not Fixed |
| 3 | Trigger Consumption | 🔴 Critical | `orchestrator.ts:1242, 4992` | Not Fixed |
| 4 | Duplicate Logs | 🟠 High | `index.ts:393-395` | Not Fixed |
| 5 | Dual Bar Builders | 🟠 High | `barAggregator.ts` + `orchestrator.ts` | Not Fixed |
| 6 | Race Condition | 🟠 High | `index.ts:360-413` | Not Fixed |
| 7 | VWAP Whipsaw | 🟠 High | `orchestrator.ts:1750-1751` | Not Fixed |
| 8 | Phase Transition Gates | 🟠 High | `orchestrator.ts:3849` | Not Fixed |
| 9 | bars5mCount Reset | 🟡 Medium | `index.ts:97-112` | Not Fixed |
| 10 | LLM Throttle | 🟡 Medium | `llmDirection1m.ts:58-61` | Intentional |
| 11 | reduce5mClose Gate | 🟡 Medium | `orchestrator.ts:4586` | Not Fixed |
| 12 | Setup Detection Gate | 🟡 Medium | `orchestrator.ts:2584` | Not Fixed |
| 13 | Length Thresholds | 🟡 Medium | Various | Not Fixed |
| 14 | TP Alerts | 🟡 Medium | `orchestrator.ts:5808-6084` | Not Fixed |
| 15 | Coaching Contradictions | 🟢 Low | `orchestrator.ts:6254` | Not Fixed |
| 16 | Phase/Setup Conflation | 🟢 Low | `orchestrator.ts:3858-3909` | Not Fixed |

---

## 🎯 Recommended Fix Order

### Phase 1: Critical Fixes (Do First)
1. ✅ Fix `lastLLMCallAt` / `lastLLMDecision` update (Issue #1)
2. ✅ Fix LLM 1m bias override - separate `bias_5m` from `tilt_1m` (Issue #2)
3. ✅ Fix trigger consumption - add `pendingTrigger` latch (Issue #3)

### Phase 2: High Priority (Do Next)
4. ✅ Remove duplicate CLOSE5M log (Issue #4)
5. ✅ Unify bar builders - remove dual state (Issue #5)
6. ✅ Fix race condition - update state before logging (Issue #6)
7. ✅ Add VWAP deadband + persistence (Issue #7)
8. ✅ Lower initial confidence threshold (Issue #8)

### Phase 3: Medium Priority (Do When Time Permits)
9. ✅ Fix `bars5mCount` reset (Issue #9)
10. ✅ Allow `reduce5mClose` with minimal bars (Issue #11)
11. ✅ Allow setup detection with weak bias (Issue #12)
12. ✅ Allow partial-window processing (Issue #13)
13. ✅ Fix TP alert emission timing (Issue #14)

### Phase 4: Low Priority (Polish)
14. ✅ Expand coaching filtering (Issue #15)
15. ✅ Separate phase from setup concerns (Issue #16)

---

## 📝 Testing & Logging Recommendations

For each fix, add appropriate logging:

```typescript
// Issue #1
console.log(`[LLM_STATE_UPDATE] lastLLMCallAt=${this.state.lastLLMCallAt} lastLLMDecision="${this.state.lastLLMDecision}"`);

// Issue #2
console.log(`[EVAL_BIAS_START] source=${source} currentBias=${exec.bias} engineState=${be.state}`);
console.log(`[EVAL_BIAS_DONE] newBias=${exec.bias} source=${exec.biasSource} confidence=${exec.biasConfidence}`);

// Issue #3
console.log(`[TRIGGER_CONSUMED] trigger=${triggerPrice} side=${side} entryBlocked=${entryBlocked} pendingTrigger=${exec.pendingTrigger ? "stored" : "none"}`);

// Issue #7
console.log(`[VWAP_COMPARISON] close=${close} vwap=${vwap} deadband=${deadband} farAbove=${farAbove} consecutive=${exec.consecutiveAboveVwap}`);

// Issue #14
console.log(`[TP_ALERT_EMIT] target=${targetKey} price=${targetHit} timestamp=${ts} emitted=${emitted}`);
```

---

## 🔍 Additional Notes

- **Root Cause Analysis:** Many issues stem from state synchronization problems between 1m and 5m processing paths
- **Architecture Recommendation:** Consider event-driven architecture where 5m close events trigger all downstream processing
- **Testing Strategy:** Add integration tests for each fix to prevent regressions
- **Monitoring:** Add metrics for bias flips, trigger hits, TP alerts to track fix effectiveness
