# Orchestrator Audit Report: 8 Problem Categories

## Function Map: Key Orchestrator Functions

### Bar Close Handling
- `handleMinimal1m()` - Line 4275: Processes 1m ticks, detects 5m rollover, calls LLM 1m
- `handleMinimal5m()` - Line 6415: Processes closed 5m bars from BarAggregator, appends to `recentBars5m`
- `updateForming5mBar()` - Line 149: Tracks forming 5m bar state
- `reduce5mClose()` - Line 3773: **Authoritative 5m close reducer** - runs on every 5m close

### State Update / Consistency Check
- `reduce5mClose()` - Line 3773: Single source of truth for 5m close processing
- `getPhaseAwareReason()` - Line 3683: Generates human-readable wait reasons

### Bias Evaluation
- `updateBiasEngine()` - Line 1718: **1m-based bias engine** - updates bias engine state (BULLISH/BEARISH/REPAIR)
- `finalizeBiasFrom5m()` - Line 2104: **5m structure finalization** - only place that can finalize bias flips
- `maybeNudgeBiasFromLlm1m()` - Line 1926: **LLM 1m nudge** - can set bias from NEUTRAL when LLM + tape agree
- `shouldFlipBias()` - Line 2281: Checks if bias should flip on invalidation

### Setup Arming / Gating
- `detectSetup()` - Line 1609: Detects PULLBACK_CONTINUATION, IGNITION, EARLY_REJECTION setups
- `armResolutionGate()` - Line 545: Arms resolution gate with trigger/stop prices
- `checkGateTrigger()` - Line 600: Checks if gate trigger price is hit
- `latchOpportunity()` - Line 986: Creates OpportunityLatch (composite gate system)
- `checkOpportunityTrigger()` - Line 1242: Checks if opportunity trigger is hit

### Trigger Detection
- `checkGateTrigger()` - Line 600: Detects gate trigger hits
- `checkOpportunityTrigger()` - Line 1242: Detects opportunity trigger hits (ROLLOVER, BREAK, RECLAIM_FAIL, CROSS)
- Entry logic in `handleMinimal1m()` - Line 4746+: Checks triggers and executes entries

### Event Emission
- `handleMinimal1m()` - Line 5954-6084: Emits GATE_ARMED, OPPORTUNITY_TRIGGERED, TRADE_ENTRY, TRADE_EXIT, TRADING_ALERT
- TP alerts emitted at Line 6059-6084

### Coaching Formatting
- `generateTPCoaching()` - Line 3459: Generates coaching text for TP hits
- Coaching filtering at Line 6254, 6337: Filters contradictory coaching (e.g., long coaching when bias is BEARISH)

### LLM Call Scheduler + Application
- `maybeUpdateLlmDirection1m()` - Called from `handleMinimal1m()` Line 4488: LLM 1m direction opinion
- `maybeNudgeBiasFromLlm1m()` - Line 1926: Applies LLM 1m nudge to bias (only when NEUTRAL)
- `reduce5mClose()` - Line 3790: Stores LLM hints (but doesn't set bias directly)

---

## A) LLM 1m Bias Overriding / Conflicting with 5m Engine

### Problem
LLM 1m can directly set `exec.bias` when bias is NEUTRAL, potentially conflicting with 5m engine's canonical bias.

### Write Sites to Bias

#### 1. `maybeNudgeBiasFromLlm1m()` - Line 1992, 2027
**File:** `src/orchestrator/orchestrator.ts:1992, 2027`

**Code:**
```typescript
exec.bias = "BULLISH";  // Line 1992
exec.bias = "BEARISH";  // Line 2027
```

**Why it matches symptom:**
- Directly sets `exec.bias` from LLM 1m direction
- Only runs when `exec.bias === "NEUTRAL"`, but can override 5m engine's intended bias
- Sets bias engine state directly: `be.state = "BULLISH"` (Line 1990) or `be.state = "BEARISH"` (Line 2025)
- Can conflict with `finalizeBiasFrom5m()` which is the canonical 5m authority

**Minimal Fix:**
Add flag to track LLM nudge vs 5m canonical:
```typescript
exec.biasSource = "LLM_NUDGE";  // Track source
```

**Robust Fix:**
Separate bias into two fields:
```typescript
// In MinimalExecutionState type:
bias_5m: MarketBias;  // Canonical, from 5m structure
tilt_1m?: "LONG" | "SHORT" | null;  // LLM 1m timing hint only

// Trading decisions use bias_5m
// LLM tilt only affects entry timing, not bias itself
```

#### 2. `finalizeBiasFrom5m()` - Line 2126, 2148, 2180, 2240
**File:** `src/orchestrator/orchestrator.ts:2126, 2148, 2180, 2240`

**Code:**
```typescript
exec.bias = "BULLISH";  // Lines 2126, 2180
exec.bias = "BEARISH";  // Lines 2148, 2240
```

**Why it matches symptom:**
- This is the **canonical** 5m bias authority
- But LLM nudge can set bias BEFORE 5m finalization
- If LLM nudge sets bias, then 5m finalization may not run (because bias is no longer NEUTRAL)

**Minimal Fix:**
Ensure 5m finalization can override LLM nudge:
```typescript
// In finalizeBiasFrom5m, allow override even if bias was set by LLM
if (exec.biasSource === "LLM_NUDGE" && be.state === "REPAIR_BULL") {
  // Override LLM nudge with 5m structure
  exec.bias = "BULLISH";
  exec.biasSource = "5M_STRUCTURE";
}
```

**Robust Fix:**
Use separate fields (see above) - 5m bias always wins, LLM tilt is advisory only.

### Tests/Logs to Add
```typescript
console.log(`[EVAL_BIAS_START] source=${source} currentBias=${exec.bias} engineState=${be.state}`);
console.log(`[EVAL_BIAS_SKIP] reason=${reason} llmNudge=${exec.llm1mDirection} engineState=${be.state}`);
console.log(`[EVAL_BIAS_DONE] newBias=${exec.bias} source=${exec.biasSource} confidence=${exec.biasConfidence}`);
```

---

## B) VWAP Chop / Whipsaw (Lack of Hysteresis)

### Problem
VWAP/EMA comparisons flip on single-candle moves, causing bias engine to flip-flop.

### VWAP/EMA Comparison Sites

#### 1. `updateBiasEngine()` - Line 1754-1773
**File:** `src/orchestrator/orchestrator.ts:1754-1773`

**Code:**
```typescript
const bullAccept =
  aboveVwap >= this.BIAS_ENGINE_ENTER_ACCEPT &&  // 4 bars
  aboveEma  >= this.BIAS_ENGINE_ENTER_ACCEPT &&
  farAbove;

const bearAccept =
  belowVwap >= this.BIAS_ENGINE_ENTER_ACCEPT &&
  belowEma  >= this.BIAS_ENGINE_ENTER_ACCEPT &&
  farBelow;
```

**Why it matches symptom:**
- Uses counters (`aboveVwap`, `aboveEma`) which provide SOME persistence
- But `farAbove`/`farBelow` check is single-candle: `close > vwap + minDist`
- No deadband - price can cross VWAP by 0.01 and flip
- `minDist` is only `0.10 * atr` (Line 1749) - very small

**Minimal Fix:**
Add deadband to `farAbove`/`farBelow`:
```typescript
const deadband = atr ? 0.15 * atr : 0.10;  // Wider deadband
const farAbove = close > vwap + minDist + deadband && close > ema + minDist + deadband;
const farBelow = close < vwap - minDist - deadband && close < ema - minDist - deadband;
```

**Robust Fix:**
Add persistence requirement (N consecutive closes) + cooldown:
```typescript
// Track consecutive closes above/below
exec.consecutiveAboveVwap = (close > vwap + deadband) ? (exec.consecutiveAboveVwap ?? 0) + 1 : 0;
exec.consecutiveBelowVwap = (close < vwap - deadband) ? (exec.consecutiveBelowVwap ?? 0) + 1 : 0;

// Require 3+ consecutive closes before accepting
const bullAccept = 
  exec.consecutiveAboveVwap >= 3 &&
  exec.consecutiveAboveEma >= 3 &&
  aboveVwap >= this.BIAS_ENGINE_ENTER_ACCEPT;

// Cooldown after flip
const inCooldown = be.lastFlipTs && (ts - be.lastFlipTs) < 5 * 60 * 1000;  // 5 min
if (inCooldown) return;  // Don't flip again too soon
```

#### 2. `maybeNudgeBiasFromLlm1m()` - Line 1954-1955
**File:** `src/orchestrator/orchestrator.ts:1954-1955`

**Code:**
```typescript
const farAbove = close > vwap + minDist && close > ema + minDist;
const farBelow = close < vwap - minDist && close < ema - minDist;
```

**Why it matches symptom:**
- Same single-candle check, no deadband
- Can nudge bias on tiny price moves

**Fix:** Same as above - add deadband + persistence.

### Exact Comparisons to Replace

| Line | Current | Replace With |
|------|---------|--------------|
| 1750 | `close > vwap + minDist` | `close > vwap + minDist + deadband` |
| 1751 | `close < vwap - minDist` | `close < vwap - minDist - deadband` |
| 1954 | `close > vwap + minDist` | `close > vwap + minDist + deadband` |
| 1955 | `close < vwap - minDist` | `close < vwap - minDist - deadband` |

### Tests/Logs to Add
```typescript
console.log(`[VWAP_COMPARISON] close=${close} vwap=${vwap} deadband=${deadband} farAbove=${farAbove} consecutive=${exec.consecutiveAboveVwap}`);
console.log(`[BIAS_FLIP_COOLDOWN] lastFlip=${be.lastFlipTs} cooldownRemaining=${cooldownRemaining}ms`);
```

---

## C) Trigger Detector Not Wired into Setup Arming

### Problem
"TRIGGER HIT" alerts are emitted, but entry may be blocked - trigger signal not consumed properly.

### Trigger Detection Sites

#### 1. `checkOpportunityTrigger()` - Line 1242
**File:** `src/orchestrator/orchestrator.ts:1242`

**Returns:** `{ triggered: boolean; reason?: string }`

**Why it matches symptom:**
- Detects trigger hits correctly
- But return value may not be consumed to arm setup

#### 2. Entry Logic in `handleMinimal1m()` - Line 4992
**File:** `src/orchestrator/orchestrator.ts:4992`

**Code:**
```typescript
const triggerCheck = this.checkOpportunityTrigger(
  exec.opportunity,
  current5m,
  previous5m,
  closed5mBars,
  atr
);
```

**Why it matches symptom:**
- Checks trigger, but entry may be blocked by other gates
- Line 5985-6023: Emits `TRIGGER_BLOCKED_ALERT` when trigger hits but entry blocked
- But no "pendingTrigger" latch to remember trigger hit for later consumption

**Minimal Fix:**
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
  console.log(`[TRIGGER_CONSUMED] Trigger hit but entry blocked - stored as pending`);
}

// On next tick, check if pendingTrigger can be consumed:
if (exec.pendingTrigger && !entryBlocked) {
  // Consume pending trigger
  exec.opportunity.status = "TRIGGERED";
  exec.pendingTrigger = undefined;
}
```

**Robust Fix:**
Add "blocked reason" to alert payload:
```typescript
const alertPayload: TradingAlertPayload = {
  direction: exec.opportunity.side,
  triggerPrice,
  reason: `Trigger hit but entry blocked: ${blockReason}`,
  blockedReason: blockReason,  // NEW
  retestPlan: retestPlan,      // NEW
};
```

### Code Path Showing Issue

1. **Trigger Detection:** `checkOpportunityTrigger()` returns `{ triggered: true }` (Line 1242)
2. **Opportunity Status Update:** `exec.opportunity.status = "TRIGGERED"` (Line 4992+)
3. **Entry Check:** `shouldBlockEntry()` may return `true` (Line 2845)
4. **Alert Emitted:** `TRIGGER_BLOCKED_ALERT` emitted (Line 5985-6023)
5. **Problem:** No mechanism to "remember" trigger hit for later consumption

### Tests/Logs to Add
```typescript
console.log(`[TRIGGER_CONSUMED] trigger=${triggerPrice} side=${side} entryBlocked=${entryBlocked} pendingTrigger=${exec.pendingTrigger ? "stored" : "none"}`);
console.log(`[TRIGGER_BLOCKED] reason=${blockReason} retestPlan=${retestPlan}`);
```

---

## D) Trade Management Alerts Missing (TP Hit Not Visible)

### Problem
TP hits are detected but may not emit discrete `TRADING_ALERT` events.

### TP Hit Detection

#### 1. Target Hit Detection - Line 5808-5816
**File:** `src/orchestrator/orchestrator.ts:5808-5816`

**Code:**
```typescript
const targetHit = exec.targets.find((target, index) => {
  const hit = (direction === "long" && current5m.high >= target) ||
              (direction === "short" && current5m.low <= target);
  return hit;
});
```

**Why it matches symptom:**
- Detects TP hits correctly
- Stores in `exec.lastTargetHit` (Line 5852)
- But alert emission happens later (Line 6059)

#### 2. TP Alert Emission - Line 6059-6084
**File:** `src/orchestrator/orchestrator.ts:6059-6084`

**Code:**
```typescript
if (exec.lastTargetHit && exec.lastTargetHit.timestamp === ts) {
  // Emit TRADING_ALERT
  events.push({
    type: "TRADING_ALERT",
    ...
  });
}
```

**Why it matches symptom:**
- Alert IS emitted, but only if `exec.lastTargetHit.timestamp === ts`
- If timestamp doesn't match exactly, alert is lost
- Alert is emitted OUTSIDE trade management block, which is good (bypasses entry gating)

**Minimal Fix:**
Ensure timestamp matching is robust:
```typescript
// Use <= instead of === to catch same-bar hits
if (exec.lastTargetHit && exec.lastTargetHit.timestamp <= ts && exec.lastTargetHit.timestamp >= ts - 60000) {
  // Emit alert
}
```

**Robust Fix:**
Emit alert immediately when target hit:
```typescript
// In trade management block (Line 5818+), emit immediately:
if (targetHit !== undefined) {
  // ... store in exec.lastTargetHit ...
  
  // Emit alert immediately (don't wait for later)
  const payload: TradingAlertPayload = {
    direction: direction === "long" ? "LONG" : "SHORT",
    targetKey,
    targetPrice: targetHit,
    reason: `Take profit ${targetKey.toUpperCase()} hit`,
  };
  events.push({
    type: "TRADING_ALERT",
    timestamp: ts,
    instanceId: this.instanceId,
    data: { timestamp: ts, symbol, price: close, alertPayload: payload },
  });
}
```

### Tests/Logs to Add
```typescript
console.log(`[TP_ALERT_EMIT] target=${targetKey} price=${targetHit} timestamp=${ts} emitted=${emitted}`);
console.log(`[TP_ALERT_MISSED] target=${targetKey} timestamp=${exec.lastTargetHit.timestamp} currentTs=${ts} delta=${ts - exec.lastTargetHit.timestamp}`);
```

---

## E) Coaching Gating and Contradictions

### Problem
Coaching can recommend longs when bias is bearish + no long setup.

### Coaching Generation Sites

#### 1. Coaching Filtering - Line 6254, 6337
**File:** `src/orchestrator/orchestrator.ts:6254, 6337`

**Code:**
```typescript
coachLine: (exec.bias === "BEARISH" && exec.setup !== "PULLBACK_CONTINUATION" && exec.setup !== "IGNITION" && exec.llm1mCoachLine?.toLowerCase().includes("long")) 
  ? undefined 
  : exec.llm1mCoachLine,
```

**Why it matches symptom:**
- Filters long coaching when bias is BEARISH
- But only checks for "long" in lowercase
- Doesn't check for SHORT coaching when bias is BULLISH
- Doesn't check phase/setup state comprehensively

**Minimal Fix:**
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

coachLine: shouldFilterCoaching(exec.llm1mCoachLine, exec.bias, exec.setup) ? undefined : exec.llm1mCoachLine,
```

**Robust Fix:**
Add "observer mode" coaching when blocked:
```typescript
// When entry is blocked, provide observer-mode coaching
if (exec.entryBlocked) {
  coachLine: `Observer: ${exec.entryBlockReason}. ${exec.llm1mCoachLine ?? "Waiting for setup."}`;
} else {
  coachLine: exec.llm1mCoachLine;
}
```

### Gating Rules to Add

1. **Phase Gating:** Only show coaching when phase allows entry
2. **Setup Gating:** Only show coaching matching current setup direction
3. **Blocked Gating:** Show "observer mode" coaching when entry blocked

### Tests/Logs to Add
```typescript
console.log(`[COACHING_FILTER] coachLine="${coachLine}" bias=${bias} setup=${setup} filtered=${filtered}`);
console.log(`[COACHING_OBSERVER] entryBlocked=${entryBlocked} reason=${exec.entryBlockReason} coachLine="${coachLine}"`);
```

---

## F) Phase vs Setup Conflation (Extension Mis-labeled as Pullback)

### Problem
PHASE may be inferred from desired setup (pullback_continuation) instead of actual price behavior.

### Phase Computation

#### 1. Phase Transition Logic - Line 3858-3909
**File:** `src/orchestrator/orchestrator.ts:3858-3909`

**Code:**
```typescript
if (inZone) {
  exec.phase = "PULLBACK_IN_PROGRESS";
} else if (extended) {
  exec.phase = "EXTENSION";
} else {
  exec.phase = "BIAS_ESTABLISHED";
}
```

**Why it matches symptom:**
- Phase is based on price position relative to `pullbackHigh`/`pullbackLow`
- But `pullbackHigh`/`pullbackLow` are set based on setup detection (Line 1998-1999, 2033-2034)
- If setup is "PULLBACK_CONTINUATION", phase may be forced to "PULLBACK_IN_PROGRESS" even if price is extended

**Minimal Fix:**
Ensure phase reflects actual price behavior, not setup intent:
```typescript
// Phase should be based on price behavior, not setup
const inZone = current5m.close > exec.pullbackLow && current5m.close < exec.pullbackHigh;
const extendedBull = exec.bias === "BULLISH" && current5m.close > exec.pullbackHigh + buffer;
const extendedBear = exec.bias === "BEARISH" && current5m.close < exec.pullbackLow - buffer;
const extended = extendedBull || extendedBear;

// Phase is price behavior, setup is strategy intent
if (extended) {
  exec.phase = "EXTENSION";  // Price is extended, regardless of setup
} else if (inZone) {
  exec.phase = "PULLBACK_IN_PROGRESS";  // Price is in pullback zone
} else {
  exec.phase = "BIAS_ESTABLISHED";  // Price is between zone and extension
}
```

**Robust Fix:**
Separate phase (market behavior) from setup (strategy intent):
```typescript
// Phase: Market behavior (where is price?)
type MarketPhase = "NEUTRAL_PHASE" | "BIAS_ESTABLISHED" | "PULLBACK_IN_PROGRESS" | "EXTENSION" | "IN_TRADE";

// Setup: Strategy intent (what are we waiting for?)
type Setup = "NONE" | "PULLBACK_CONTINUATION" | "IGNITION" | "EARLY_REJECTION";

// Phase is computed from price behavior
// Setup is computed from market structure + bias
// They are independent
```

### Where Phase is Set Based on Setup

| Line | Current Logic | Issue |
|------|---------------|-------|
| 2001 | `exec.phase = "BIAS_ESTABLISHED"` when LLM nudge | Phase set when setup is armed |
| 2036 | `exec.phase = "BIAS_ESTABLISHED"` when LLM nudge | Phase set when setup is armed |
| 3869 | `exec.phase = "PULLBACK_IN_PROGRESS"` when `inZone` | OK - based on price |
| 3878 | `exec.phase = "EXTENSION"` when `extended` | OK - based on price |

### Tests/Logs to Add
```typescript
console.log(`[PHASE_COMPUTE] price=${current5m.close} pullbackZone=[${exec.pullbackLow}, ${exec.pullbackHigh}] inZone=${inZone} extended=${extended} phase=${exec.phase}`);
console.log(`[SETUP_PHASE_SPLIT] setup=${exec.setup} phase=${exec.phase} priceBehavior=${priceBehavior}`);
```

---

## Summary: All Write Sites to Bias

| Line | Function | What It Does | Can Override 5m? |
|------|----------|--------------|------------------|
| 1992 | `maybeNudgeBiasFromLlm1m()` | Sets bias from LLM 1m when NEUTRAL | **YES** - Direct write |
| 2027 | `maybeNudgeBiasFromLlm1m()` | Sets bias from LLM 1m when NEUTRAL | **YES** - Direct write |
| 2126 | `finalizeBiasFrom5m()` | Cold start: sets bias from 5m structure | **NO** - Canonical |
| 2148 | `finalizeBiasFrom5m()` | Cold start: sets bias from 5m structure | **NO** - Canonical |
| 2180 | `finalizeBiasFrom5m()` | Finalizes bias from REPAIR_BULL | **NO** - Canonical |
| 2240 | `finalizeBiasFrom5m()` | Finalizes bias from REPAIR_BEAR | **NO** - Canonical |

**Recommendation:** Make `finalizeBiasFrom5m()` the ONLY place that can set bias after initial nudge. LLM nudge should only work when bias is NEUTRAL and no 5m structure exists yet.

---

## Recommended Fix Priority

1. **HIGH:** Fix LLM 1m bias override (Category A) - Separate `bias_5m` from `tilt_1m`
2. **HIGH:** Fix trigger consumption (Category C) - Add `pendingTrigger` latch
3. **MEDIUM:** Fix VWAP whipsaw (Category B) - Add deadband + persistence
4. **MEDIUM:** Fix TP alerts (Category D) - Emit immediately on hit
5. **LOW:** Fix coaching contradictions (Category E) - Expand filtering
6. **LOW:** Fix phase/setup conflation (Category F) - Separate concerns
