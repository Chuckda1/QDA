# Execution Pipeline Fix Plan

## ✅ Validation: Core Execution is Working

**Confirmed from screenshot:**
- `PHASE: IN_TRADE` ✅
- `ENTRY: ACTIVE` ✅
- `SETUP: NONE` (bypass working) ✅
- Entry/stop/targets populated ✅

**This proves:**
- TRIGGERED acceptance flows correctly
- Setup NONE bypass for TRIGGERED is effective
- Entry path is no longer hard-blocked
- State machine advances correctly

**Remaining work:** Truthfulness + observability (not "why won't it enter")

---

## Key Refinements Applied

### 1. Structured Logging (Issue A)
- Changed from prose strings to structured objects
- Machine-parseable for future metrics
- Prevents semantic drift

### 2. hasOpportunity Guard First (Issue B)
- **Critical invariant:** If `hasOpportunity === true`, NEVER emit `"no_opportunity_latched"`
- Switch statement ensures specific status mapping
- Prevents regression to generic message

### 3. entryBlocked Priority (Issue D)
- `resolveEffectiveWaitReason()` checks `entryBlocked` BEFORE opportunity status
- Prevents Telegram from overwriting precise block reasons with generic opp state
- Ensures explicit blockers win over inferred states

---

## Current State Analysis

### ✅ What's Already Fixed
1. **TRIGGERED acceptance in readiness check** (line 3446-3454)
   - `oppReady` correctly checks for both `LATCHED` and `TRIGGERED`
   - `readyToEvaluateEntry = oppReady || gateReady` is correct

2. **Cross-based trigger logic** (lines 1182-1235)
   - Validates `armedAtPrice` to ensure actual cross occurred
   - Prevents instant triggers

3. **Re-latch prevention** (lines 1061-1066)
   - Checks if existing opportunity is `LATCHED` or `TRIGGERED` and still valid

4. **Telegram guardrails** (lines 3895-3908, 3981-3994)
   - Prevents `effectiveWaitReason = "no_opportunity_latched"` when `hasOpp === true`

5. **Setup = NONE bypass for TRIGGERED** (lines 3506-3509)
   - Allows entry if `oppReady && status === "TRIGGERED"` even when `setup === NONE`

### ❌ What's Still Broken

#### Issue A: Misleading Log Message (Line 3478-3480)
**Location:** `handleMinimal1m()` entry blocker (line 3478)

**Problem:**
```typescript
console.log(
  `[ENTRY_BLOCKED] Not ready - BIAS=${exec.bias} PHASE=${exec.phase} oppStatus=${oppStatus} gateStatus=${gateStatus} - Waiting for pullback zone`
);
```

**Why it's broken:**
- The log message says "Waiting for pullback zone" but the actual reason could be:
  - `oppStatus === "EXPIRED"` or `"CONSUMED"` or `"INVALIDATED"`
  - `gateStatus !== "ARMED"` and no opportunity exists
  - Opportunity exists but status is not LATCHED/TRIGGERED

**Fix needed:**
- Replace generic message with specific reason based on actual state
- Use `entryBlockReason` or derive from `oppStatus`/`gateStatus`

---

#### Issue B: waitReason Still Set to "no_opportunity_latched" (Line 3471-3472)
**Location:** `handleMinimal1m()` entry blocker (line 3471)

**Problem:**
```typescript
if (!exec.waitReason || exec.waitReason === "no_opportunity_latched") {
  exec.waitReason = "no_opportunity_latched";
}
```

**Why it's broken:**
- Even though `readyToEvaluateEntry` correctly checks TRIGGERED, if it's false, we still set `waitReason = "no_opportunity_latched"`
- This can be misleading if:
  - Opportunity exists but is `EXPIRED` → should be `"opportunity_expired"`
  - Opportunity exists but is `CONSUMED` → should be `"opportunity_consumed"`
  - Gate is ARMED but opportunity is missing → should be `"gate_armed_waiting_for_trigger"`

**Fix needed:**
- Set specific `waitReason` based on actual state:
  ```typescript
  if (!readyToEvaluateEntry) {
    if (oppStatus === "EXPIRED") {
      exec.waitReason = "opportunity_expired";
    } else if (oppStatus === "CONSUMED") {
      exec.waitReason = "opportunity_consumed";
    } else if (oppStatus === "INVALIDATED") {
      exec.waitReason = "opportunity_invalidated";
    } else if (gateReady && !hasOpportunity) {
      exec.waitReason = "gate_armed_waiting_for_trigger";
    } else {
      exec.waitReason = "no_opportunity_latched";
    }
  }
  ```

---

#### Issue C: Entry Signal Logic May Be Too Restrictive (Line 3498-3500)
**Location:** `handleMinimal1m()` entry signal detection (line 3498)

**Current logic:**
```typescript
const entrySignalFires =
  (exec.bias === "BULLISH" && (isBearish || (previous5m && lowerLow))) ||
  (exec.bias === "BEARISH" && (isBullish || (previous5m && higherHigh)));
```

**Potential issue:**
- For BULLISH bias, requires bearish candle OR lower low
- For BEARISH bias, requires bullish candle OR higher high
- This might miss "continuation" entries where price breaks structure without a reversal candle

**Consideration:**
- This might be intentional (pullback continuation requires reversal)
- But for TRIGGERED opportunities (fresh breaks), might want different signal

---

#### Issue D: No Centralized `resolveEffectiveWaitReason()` Function
**Location:** Multiple places (lines 3898, 3983)

**Problem:**
- `effectiveWaitReason` logic is duplicated in two places
- No single source of truth for "what should Telegram show"

**Fix needed:**
- Create `resolveEffectiveWaitReason(exec: MinimalExecutionState): string` function
- Use it in both Telegram publish locations

---

## Step-by-Step Fix Plan

### Step 1: Fix Misleading Log Message and waitReason Assignment
**Priority:** CRITICAL  
**Location:** `handleMinimal1m()` lines 3466-3480

**Actions:**
1. Replace generic log message with state-specific message
2. Set specific `waitReason` based on actual `oppStatus` and `gateStatus`
3. Add `[ENTRY_GUARD]` log before blocker with full context

**Code location:**
```typescript
// Line ~3466
if (!readyToEvaluateEntry) {
  // Determine specific reason - GUARD: check hasOpportunity FIRST to prevent regressing to "no_opportunity_latched"
  let blockReason: string;
  if (hasOpportunity) {
    // If opportunity exists, NEVER emit "no_opportunity_latched"
    switch (oppStatus) {
      case "EXPIRED":
        blockReason = "opportunity_expired";
        exec.waitReason = "opportunity_expired";
        break;
      case "CONSUMED":
        blockReason = "opportunity_consumed";
        exec.waitReason = "opportunity_consumed";
        break;
      case "INVALIDATED":
        blockReason = "opportunity_invalidated";
        exec.waitReason = "opportunity_invalidated";
        break;
      default:
        blockReason = "opportunity_not_ready";
        exec.waitReason = `opportunity_${oppStatus?.toLowerCase() ?? "unknown"}`;
    }
  } else if (gateReady) {
    blockReason = "gate_armed_no_opportunity";
    exec.waitReason = "gate_armed_waiting_for_trigger";
  } else {
    blockReason = "no_opportunity_ready";
    exec.waitReason = "no_opportunity_latched";
  }
  
  exec.entryBlocked = true;
  exec.entryBlockReason = blockReason;
  shouldPublishEvent = true;
  
  // Structured logging for machine parsing + metrics
  console.log("[ENTRY_GUARD]", {
    oppExists: hasOpportunity,
    oppStatus,
    gateStatus,
    setup: exec.setup,
    phase: exec.phase,
    blockReason,
    waitReason: exec.waitReason,
  });
  console.log("[ENTRY_BLOCKED]", {
    blockReason,
    bias: exec.bias,
    phase: exec.phase,
    oppStatus,
    gateStatus,
  });
}
```

---

### Step 2: Create Centralized `resolveEffectiveWaitReason()` Function
**Priority:** HIGH  
**Location:** New private method in `Orchestrator` class

**Actions:**
1. Create function that takes `exec` and returns canonical wait reason
2. Replace duplicated logic in Telegram publish locations
3. Ensure it never returns `"no_opportunity_latched"` when `hasOpp === true`

**Function signature:**
```typescript
private resolveEffectiveWaitReason(exec: MinimalExecutionState): string {
  // Priority order (CRITICAL: entryBlocked must win over generic opp state):
  // 1. In trade
  // 2. entryBlocked (explicit) - MUST come before opportunity status
  // 3. Opportunity status-based
  // 4. Setup-based
  // 5. Gate-based
  // 6. Phase-based
  // 7. Fallback
  
  if (exec.phase === "IN_TRADE") {
    return "in_trade";
  }
  
  // Priority 2: If entry is explicitly blocked, that reason wins
  // This prevents Telegram from overwriting a precise block with generic opp state
  if (exec.entryBlocked && exec.entryBlockReason) {
    return exec.entryBlockReason;
  }
  
  const hasOpp = !!exec.opportunity;
  const oppStatus = exec.opportunity?.status;
  
  if (hasOpp) {
    // GUARDRAIL: If opportunity exists, NEVER return "no_opportunity_latched"
    if (oppStatus === "LATCHED") {
      return exec.setup === "NONE" ? "waiting_for_pullback" : "waiting_for_trigger";
    }
    if (oppStatus === "TRIGGERED") {
      return exec.setup === "NONE" ? "waiting_for_entry_signal" : "waiting_for_entry_signal";
    }
    if (oppStatus === "EXPIRED") {
      return "opportunity_expired";
    }
    if (oppStatus === "CONSUMED") {
      return "opportunity_consumed";
    }
    if (oppStatus === "INVALIDATED") {
      return "opportunity_invalidated";
    }
    return `opportunity_${oppStatus?.toLowerCase() ?? "unknown"}`;
  }
  
  if (exec.resolutionGate?.status === "ARMED") {
    return "gate_armed_waiting_for_trigger";
  }
  
  if (!exec.setup || exec.setup === "NONE") {
    return "setup_none";
  }
  
  if (exec.waitReason && !exec.waitReason.includes("no_opportunity_latched")) {
    return exec.waitReason;
  }
  
  return exec.bias === "NEUTRAL" ? "waiting_for_bias" : "waiting_for_pullback";
}
```

**Usage:**
- Replace lines 3898-3908 with: `const effectiveWaitReason = this.resolveEffectiveWaitReason(exec);`
- Replace lines 3983-3994 with: `const effectiveWaitReason = this.resolveEffectiveWaitReason(exec);`

---

### Step 3: Enhance Entry Signal Detection for TRIGGERED Opportunities
**Priority:** MEDIUM  
**Location:** `handleMinimal1m()` lines 3498-3500

**Consideration:**
- Current logic requires reversal candle for pullback continuation
- For TRIGGERED opportunities (fresh breaks), might want to allow continuation signals

**Option A (Keep as-is):**
- Current logic is fine for pullback continuation
- TRIGGERED opportunities still need entry signal (reversal or structure break)

**Option B (Enhance for TRIGGERED):**
```typescript
const entrySignalFires = 
  // Standard pullback continuation signal
  ((exec.bias === "BULLISH" && (isBearish || (previous5m && lowerLow))) ||
   (exec.bias === "BEARISH" && (isBullish || (previous5m && higherHigh)))) ||
  // OR: TRIGGERED opportunity with continuation signal (break of structure)
  (oppReady && exec.opportunity?.status === "TRIGGERED" &&
   ((exec.bias === "BULLISH" && (isBullish || (previous5m && higherHigh))) ||
    (exec.bias === "BEARISH" && (isBearish || (previous5m && lowerLow)))));
```

**Recommendation:** Keep Option A for now, add Option B later if needed

---

### Step 4: Add Comprehensive `[ENTRY_GUARD]` Logging
**Priority:** MEDIUM  
**Location:** `handleMinimal1m()` before entry evaluation

**Actions:**
1. Add detailed log before any entry decision
2. Include all relevant state: opp, gate, setup, phase, signal

**Code location:**
```typescript
// Line ~3483 (after else block starts, before entry signal detection)
console.log("[ENTRY_GUARD]", {
  oppExists: hasOpportunity,
  oppStatus,
  oppReady,
  gateStatus,
  gateReady,
  setup: exec.setup,
  phase: exec.phase,
  bias: exec.bias,
  confidence: exec.confidence,
  // entrySignalFires and canEnter will be logged after they're computed
});
```

---

### Step 5: Verify Telegram State Sync Timing
**Priority:** LOW (likely already fixed)  
**Location:** Telegram publish locations

**Verification:**
- Ensure `resolveEffectiveWaitReason()` is called AFTER all state updates
- Ensure Telegram snapshot reads from final `exec` state (not cached)

---

## Implementation Order

1. **Step 1** (CRITICAL) - Fix misleading logs and waitReason
2. **Step 2** (HIGH) - Centralize effectiveWaitReason resolution
3. **Step 4** (MEDIUM) - Add comprehensive logging
4. **Step 3** (MEDIUM) - Enhance entry signals (optional, can defer)
5. **Step 5** (LOW) - Verify timing (likely already correct)

---

## Success Criteria

After fixes:
- ✅ No more `[ENTRY_BLOCKED]` with generic "Waiting for pullback zone" when specific reason exists
- ✅ `waitReason` always reflects actual blocking state
- ✅ Telegram never shows `"no_opportunity_latched"` when `hasOpp === true`
- ✅ `[ENTRY_GUARD]` logs provide complete context for debugging
- ✅ Single source of truth for `effectiveWaitReason`
- ✅ UI contradiction resolved: `IN_TRADE` + `ENTRY ACTIVE` will no longer show "NO TRADE — structure incomplete"

## Known UI Contradiction (Will be Fixed)

**Current state (from screenshot):**
```
PHASE: IN_TRADE
ENTRY: ACTIVE
WAITING FOR: in_trade
SETUP: NONE
NO TRADE — structure incomplete  ← Contradiction
```

**Root cause:**
- Legacy "no trade" messaging still fires
- `resolveEffectiveWaitReason()` not centralized yet
- Multiple code paths setting conflicting messages

**Fix:**
- Step 2 (centralize `resolveEffectiveWaitReason`) will eliminate this
- Once `effectiveWaitReason` is authoritative, legacy messages will be removed

---

## Next Steps After Core Fixes

Once Steps 1-2 are stable:
- Add BiasFlipEntry module (separate, feature-flagged)
- Consider entry signal enhancements for TRIGGERED opportunities
- Add more granular wait reasons for better diagnostics
