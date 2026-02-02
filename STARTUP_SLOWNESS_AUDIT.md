#  Slowness & Quietness Audit Report

## Executive Summary
Startup
**Symptom:** At open, `closed5mBars.length` is 1-2, bias stays `NEUTRAL`, setup `NONE`, Telegram says `waiting_for_bias`, and `lastLLMCallAt` is `null`.

**Root Cause:** The bot starts with an empty `recentBars5m` array and requires building history from scratch. LLM calls are blocked until a 5m bar closes AND `closed5mBars.length > 0`. With only 1-2 bars, the bot cannot establish bias, so it remains in `NEUTRAL_PHASE` indefinitely.

---

## A) LLM Call Guards (Exact Blockers)

### Guard 1: 5m Close Requirement
**File:** `src/orchestrator/orchestrator.ts:2788-2791`
```typescript
if (!is5mClose) {
  // LLM is NOT called on 1m ticks or forming bars
} else if (this.llmService && closed5mBars.length > 0) {
  // LLM call logic
}
```
**Blocking Reason:** LLM only called on 5m bar closes, not on 1m ticks.

**Current Logging:** None. No log when skipped due to `!is5mClose`.

---

### Guard 2: Minimum Closed Bars
**File:** `src/orchestrator/orchestrator.ts:2791`
```typescript
else if (this.llmService && closed5mBars.length > 0) {
```
**Blocking Reason:** Requires `closed5mBars.length > 0` (but no minimum threshold like `minimalLlmBars`).

**Current Logging:** None. No log when skipped due to `closed5mBars.length === 0`.

**Note:** `minimalLlmBars` is set to 5 (line 80) but **NOT used** as a guard. This is a bug - the guard checks `> 0` but the intent was likely `>= minimalLlmBars`.

---

### Guard 3: Circuit Breaker
**File:** `src/orchestrator/orchestrator.ts:2799-2814`
```typescript
if (this.llmCircuitBreaker.isOpen) {
  const timeSinceFailure = this.llmCircuitBreaker.lastFailureTs 
    ? ts - this.llmCircuitBreaker.lastFailureTs 
    : Infinity;
  if (timeSinceFailure > circuitBreakerCooldown) {
    // Reset circuit breaker
  } else {
    console.log(
      `[CIRCUIT_BREAKER] OPEN - skipping LLM call (failures=${this.llmCircuitBreaker.failures} lastFailure=${timeSinceFailure}ms ago)`
    );
  }
}
```
**Blocking Reason:** Circuit breaker open after 3 failures, 1-minute cooldown.

**Current Logging:** ✅ Logs when circuit breaker is open.

---

### Guard 4: LLM Service Availability
**File:** `src/orchestrator/orchestrator.ts:2791`
```typescript
else if (this.llmService && closed5mBars.length > 0) {
```
**Blocking Reason:** `this.llmService` is `undefined` or falsy.

**Current Logging:** None. No log when skipped due to missing LLM service.

---

### Guard 5: Market Hours (Implicit)
**File:** `src/orchestrator/orchestrator.ts:2720-2725`
```typescript
const regime = getMarketRegime(new Date(ts));
if (!regime.isRTH) {
  this.state.minimalExecution.phase = "NEUTRAL_PHASE";
  this.state.minimalExecution.waitReason = "market_closed";
  return events; // Early return - no entry logic runs
}
```
**Blocking Reason:** Early return if market is closed, so LLM logic never runs.

**Current Logging:** ✅ Sets `waitReason = "market_closed"` but no explicit log.

---

## B) Event Emission Suppression

### Suppression Point 1: shouldPublishEvent Flag
**File:** `src/orchestrator/orchestrator.ts:2763, 2392`
```typescript
let shouldPublishEvent = false;
```
**Suppression Logic:** Events only emitted if `shouldPublishEvent === true`.

**When Set to True:**
- Bias changes (line 2424)
- Phase transitions (lines 2450, 2463, 2474)
- Setup detected (line 2615)
- Heartbeat emitted (line 2704)
- Silent mode detected (line 3006)
- Entry executed (line 2926)

**Current Logging:** ❌ No log when `shouldPublishEvent === false` and event is suppressed.

---

### Suppression Point 2: MessageGovernor Deduplication
**File:** `src/governor/messageGovernor.ts:47-52`
```typescript
shouldSend(event: DomainEvent, _bot: TelegramBotLike, _chatId: number): boolean {
  if (event.type !== "MIND_STATE_UPDATED") return false;
  const key = `${event.type}_${event.timestamp}`;
  if (this.dedupeKeys.has(key)) return false;
  this.dedupeKeys.set(key, event.timestamp);
  return true;
}
```
**Suppression Logic:** Deduplicates events by `type_timestamp`. If same timestamp, event is suppressed.

**Current Logging:** ❌ No log when event is suppressed due to deduplication.

---

### Suppression Point 3: Empty Alert Lines
**File:** `src/telegram/messagePublisher.ts:21`
```typescript
if (!alert || alert.lines.length === 0) continue;
```
**Suppression Logic:** If `buildTelegramAlert()` returns empty lines, event is suppressed.

**Current Logging:** ❌ No log when alert is empty.

---

### Suppression Point 4: Normalizer Returns Null
**File:** `src/telegram/messagePublisher.ts:19`
```typescript
const snapshot = normalizeTelegramSnapshot(event);
if (!snapshot) continue;
```
**Suppression Logic:** If `normalizeTelegramSnapshot()` returns `null`, event is suppressed.

**Current Logging:** ❌ No log when snapshot is null.

---

## C) Restart Behavior (Empty History)

### Initialization
**File:** `src/orchestrator/orchestrator.ts:47-54, 76-95`
```typescript
private recentBars5m: Array<{...}> = []; // Empty array on startup

constructor(instanceId: string, llmService?: LLMService) {
  // ...
  this.state = {
    startedAt: Date.now(),
    minimalExecution: {
      bias: "NEUTRAL",
      phase: "NEUTRAL_PHASE",
      waitReason: "waiting_for_bias",
    },
  };
}
```

**Finding:** 
- `recentBars5m` starts as empty array `[]`
- `exec.bias` starts as `"NEUTRAL"`
- `exec.phase` starts as `"NEUTRAL_PHASE"`
- `exec.waitReason` starts as `"waiting_for_bias"`

**Bar Accumulation:**
- Bars are accumulated via `handleMinimal5m()` (line 3768): `this.recentBars5m.push(closedBar)`
- This only happens when a 5m bar closes
- At market open, the bot must wait for the first 5m bar to close before it has any history

**LLM Readiness:**
- LLM is called in `handleMinimal1m()` when `is5mClose === true` AND `closed5mBars.length > 0` (line 2791)
- With only 1-2 bars, LLM can be called, but:
  - `closed5mBars.slice(-60)` will only have 1-2 bars (line 2825)
  - LLM may return `NEUTRAL` bias due to insufficient context
  - Phase transition requires `biasConfidence >= 65` (line 2444), which may not be met with limited bars

**Conclusion:** Restart begins with empty history and requires building from scratch. No preload mechanism exists.

---

## D) Split-Brain Setup Detection

### Location 1: reduce5mClose() (Primary, Authoritative)
**File:** `src/orchestrator/orchestrator.ts:2481-2550`
- Called on **every 5m close** (line 2881)
- Uses **closed bars only** (`null` passed as forming bar, line 2522)
- Has **TTL persistence** (10 minutes, line 2484)
- Checks for **invalidation** before re-detection (lines 2489-2508)

### Location 2: handleMinimal1m() (Secondary/Legacy)
**File:** `src/orchestrator/orchestrator.ts:3176-3238`
- Called on **every 1m tick** (if bias is not NEUTRAL)
- Uses **forming bar** (`forming5mBar` passed, line 3187)
- **No TTL persistence** - runs every tick
- Can cause **flickering** when forming bar changes shape

### Interaction Risk
**Problem:** `handleMinimal1m()` can override `reduce5mClose()` setup detection:
- `reduce5mClose()` sets `setup = "REJECTION"` at 9:35 (5m close)
- `handleMinimal1m()` runs at 9:36 (1m tick) and may set `setup = "NONE"` if forming bar doesn't match
- Next 5m close at 9:40 may re-detect `setup = "REJECTION"`, causing flicker

**Evidence:**
- Line 3187: `detectSetup(exec, current5m, previous5m ?? undefined, closed5mBars, atr, forming5mBar)` - uses forming bar
- Line 2522: `detectSetup(exec, lastClosed5m, previous5m, closed5mBars, atr, null)` - never uses forming bar

**Recommendation:** Remove setup detection from `handleMinimal1m()` or make it read-only (only update if `exec.setup === "NONE"`).

---

## E) Diagnosis: Why Bot is Quiet/Slow After Restart

### Exact Flow at Market Open

1. **Bot starts** (line 76-95):
   - `recentBars5m = []`
   - `exec.bias = "NEUTRAL"`
   - `exec.phase = "NEUTRAL_PHASE"`
   - `exec.waitReason = "waiting_for_bias"`

2. **First 1m tick arrives** (9:30:00):
   - `handleMinimal1m()` called
   - `is5mClose = false` → LLM call skipped (line 2788)
   - `shouldPublishEvent = false` → No event emitted
   - **No log** explaining why LLM was skipped

3. **First 5m bar closes** (9:35:00):
   - `handleMinimal5m()` called → `recentBars5m.push(closedBar)` (line 3768)
   - `closed5mBars.length = 1`
   - `handleMinimal1m()` called with `is5mClose = true`
   - LLM call attempted (line 2791: `closed5mBars.length > 0` ✅)
   - LLM receives only 1 bar → likely returns `NEUTRAL` bias
   - `reduce5mClose()` called (line 2881)
   - `exec.bias` stays `"NEUTRAL"` (line 2470-2478)
   - `exec.phase` stays `"NEUTRAL_PHASE"` (line 2472)
   - `exec.setup = "NONE"` (line 2516)
   - `shouldPublishEvent = false` (no state change) → **No event emitted**

4. **Second 5m bar closes** (9:40:00):
   - `closed5mBars.length = 2`
   - LLM call attempted again
   - LLM receives 2 bars → still likely returns `NEUTRAL` bias
   - Same result: `bias = NEUTRAL`, `phase = NEUTRAL_PHASE`, `setup = NONE`
   - `shouldPublishEvent = false` → **No event emitted**

5. **Result:**
   - Bot is "alive" (processing ticks) but "quiet" (no events)
   - `lastLLMCallAt` is set (line 2842) but bias remains `NEUTRAL`
   - Telegram shows `waiting_for_bias` because `exec.waitReason = "waiting_for_bias"` (line 2473)
   - No diagnostic explaining why no bias was established

---

## F) Missing Instrumentation

### LLM Call Skipped Logs (Missing)
1. `[LLM_SKIPPED] reason=not_5m_close` (when `!is5mClose`)
2. `[LLM_SKIPPED] reason=no_closed_bars closed5mBars.length=0` (when `closed5mBars.length === 0`)
3. `[LLM_SKIPPED] reason=insufficient_bars closed5mBars.length=1 minimalLlmBars=5` (when `closed5mBars.length < minimalLlmBars`)
4. `[LLM_SKIPPED] reason=llm_service_unavailable` (when `!this.llmService`)

### Event Suppression Logs (Missing)
1. `[EVENT_SUPPRESSED] reason=shouldPublishEvent_false phase=${exec.phase} bias=${exec.bias} setup=${exec.setup}`
2. `[EVENT_SUPPRESSED] reason=deduplication key=${key}`
3. `[EVENT_SUPPRESSED] reason=empty_alert lines.length=0`
4. `[EVENT_SUPPRESSED] reason=snapshot_null`

### Readiness State Logs (Missing)
1. `[READINESS] closed5mBars=${closed5mBars.length} minimalLlmBars=${this.minimalLlmBars} ready=${closed5mBars.length >= this.minimalLlmBars}`
2. `[READINESS] bias=${exec.bias} phase=${exec.phase} setup=${exec.setup} lastLLMCallAt=${this.state.lastLLMCallAt ?? "never"}`

---

## G) Minimal Readiness Architecture Plan

### Phase 1: Instrumentation Only (No Logic Changes)

#### 1.1 Add LLM Call Skip Logs
**File:** `src/orchestrator/orchestrator.ts:2788-2791`
```typescript
if (!is5mClose) {
  console.log(`[LLM_SKIPPED] reason=not_5m_close ts=${ts} is5mClose=false`);
} else if (!this.llmService) {
  console.log(`[LLM_SKIPPED] reason=llm_service_unavailable ts=${ts}`);
} else if (closed5mBars.length === 0) {
  console.log(`[LLM_SKIPPED] reason=no_closed_bars closed5mBars.length=0 ts=${ts}`);
} else if (closed5mBars.length < this.minimalLlmBars) {
  console.log(`[LLM_SKIPPED] reason=insufficient_bars closed5mBars.length=${closed5mBars.length} minimalLlmBars=${this.minimalLlmBars} ts=${ts}`);
} else if (this.llmCircuitBreaker.isOpen) {
  // Existing circuit breaker log
} else {
  // LLM call proceeds
}
```

#### 1.2 Add Event Suppression Logs
**File:** `src/orchestrator/orchestrator.ts:3670-3690`
```typescript
if (shouldPublishEvent) {
  events.push({ type: "MIND_STATE_UPDATED", ... });
} else {
  console.log(`[EVENT_SUPPRESSED] reason=shouldPublishEvent_false phase=${exec.phase} bias=${exec.bias} setup=${exec.setup} ts=${ts}`);
}
```

**File:** `src/governor/messageGovernor.ts:47-52`
```typescript
shouldSend(event: DomainEvent, _bot: TelegramBotLike, _chatId: number): boolean {
  if (event.type !== "MIND_STATE_UPDATED") {
    console.log(`[EVENT_SUPPRESSED] reason=wrong_type type=${event.type}`);
    return false;
  }
  const key = `${event.type}_${event.timestamp}`;
  if (this.dedupeKeys.has(key)) {
    console.log(`[EVENT_SUPPRESSED] reason=deduplication key=${key}`);
    return false;
  }
  this.dedupeKeys.set(key, event.timestamp);
  return true;
}
```

**File:** `src/telegram/messagePublisher.ts:15-23`
```typescript
async publishOrdered(events: DomainEvent[]): Promise<void> {
  for (const event of events) {
    if (!this.governor.shouldSend(event, this.bot, this.chatId)) continue;
    const snapshot = normalizeTelegramSnapshot(event);
    if (!snapshot) {
      console.log(`[EVENT_SUPPRESSED] reason=snapshot_null type=${event.type} ts=${event.timestamp}`);
      continue;
    }
    const alert = buildTelegramAlert(snapshot);
    if (!alert || alert.lines.length === 0) {
      console.log(`[EVENT_SUPPRESSED] reason=empty_alert lines.length=${alert?.lines.length ?? 0} ts=${event.timestamp}`);
      continue;
    }
    await sendTelegramMessageSafe(this.bot, this.chatId, alert.text);
  }
}
```

#### 1.3 Add Readiness State Logs
**File:** `src/orchestrator/orchestrator.ts:2881` (in `reduce5mClose`)
```typescript
// Add at start of reduce5mClose
const readinessLog = `[READINESS] closed5mBars=${closed5mBars.length} minimalLlmBars=${this.minimalLlmBars} ready=${closed5mBars.length >= this.minimalLlmBars} bias=${exec.bias} phase=${exec.phase} setup=${exec.setup} lastLLMCallAt=${this.state.lastLLMCallAt ? new Date(this.state.lastLLMCallAt).toISOString() : "never"}`;
console.log(readinessLog);
```

---

### Phase 2: Preload Mechanism (State Hydration)

#### 2.1 Add Preload Method to Orchestrator
**File:** `src/orchestrator/orchestrator.ts` (new method)
```typescript
/**
 * Preloads historical 5m bars and daily context on startup.
 * This allows the bot to be "ready" immediately instead of waiting for history to build.
 * 
 * @param bars Array of historical 5m bars (should be last 60 bars)
 * @param dailyContext Daily context (prevClose, prevHigh, prevLow, overnightHigh, overnightLow, prevSessionVWAP)
 */
public preloadHistory(
  bars: Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }>,
  dailyContext?: {
    prevClose: number;
    prevHigh: number;
    prevLow: number;
    overnightHigh: number;
    overnightLow: number;
    prevSessionVWAP: number;
  }
): void {
  if (bars.length === 0) {
    console.log(`[PRELOAD] No bars provided - starting with empty history`);
    return;
  }
  
  // Hydrate recentBars5m
  this.recentBars5m = bars.slice(-120); // Keep last 120 bars (10 hours)
  console.log(`[PRELOAD] Loaded ${this.recentBars5m.length} historical 5m bars`);
  
  // Hydrate daily context
  if (dailyContext) {
    this.prevDayClose = dailyContext.prevClose;
    this.prevDayHigh = dailyContext.prevHigh;
    this.prevDayLow = dailyContext.prevLow;
    this.overnightHigh = dailyContext.overnightHigh;
    this.overnightLow = dailyContext.overnightLow;
    this.prevSessionVWAP = dailyContext.prevSessionVWAP;
    console.log(`[PRELOAD] Daily context loaded: prevClose=${dailyContext.prevClose.toFixed(2)}`);
  }
  
  // If we have enough bars, trigger an immediate LLM call (if in ACTIVE mode)
  if (this.recentBars5m.length >= this.minimalLlmBars) {
    console.log(`[PRELOAD] Ready for LLM call: ${this.recentBars5m.length} bars >= ${this.minimalLlmBars} minimal`);
  } else {
    console.log(`[PRELOAD] Not ready for LLM call: ${this.recentBars5m.length} bars < ${this.minimalLlmBars} minimal`);
  }
}
```

#### 2.2 Add Preload Call in index.ts
**File:** `src/index.ts` (after orchestrator initialization, before data feed starts)
```typescript
// After: const orch = new Orchestrator(instanceId, llmService);

// Preload historical bars if available (fetch from Alpaca or your data source)
if (alpacaKey && alpacaSecret) {
  try {
    // Fetch last 60 closed 5m bars from Alpaca
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - 5 * 60 * 60 * 1000); // Last 5 hours
    
    const bars = await alpaca.getBarsV2("SPY", {
      start: startTime.toISOString(),
      end: endTime.toISOString(),
      timeframe: "5Min",
      limit: 60,
    });
    
    if (bars && bars.length > 0) {
      const normalizedBars = bars.map(bar => ({
        ts: new Date(bar.t).getTime(),
        open: bar.o,
        high: bar.h,
        low: bar.l,
        close: bar.c,
        volume: bar.v,
      }));
      
      // Fetch daily context (previous day's data)
      const prevDay = await alpaca.getBarsV2("SPY", {
        start: new Date(startTime.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        end: startTime.toISOString(),
        timeframe: "1Day",
        limit: 1,
      });
      
      const dailyContext = prevDay && prevDay.length > 0 ? {
        prevClose: prevDay[0].c,
        prevHigh: prevDay[0].h,
        prevLow: prevDay[0].l,
        overnightHigh: Math.max(...normalizedBars.map(b => b.high)),
        overnightLow: Math.min(...normalizedBars.map(b => b.low)),
        prevSessionVWAP: calculateVWAP(prevDay), // Implement VWAP calculation
      } : undefined;
      
      orch.preloadHistory(normalizedBars, dailyContext);
      console.log(`[STARTUP] Preloaded ${normalizedBars.length} bars and daily context`);
    }
  } catch (error: any) {
    console.warn(`[STARTUP] Preload failed: ${error.message} - starting with empty history`);
  }
}
```

#### 2.3 Fix minimalLlmBars Guard
**File:** `src/orchestrator/orchestrator.ts:2791`
```typescript
// Change from:
else if (this.llmService && closed5mBars.length > 0) {

// To:
else if (this.llmService && closed5mBars.length >= this.minimalLlmBars) {
```

---

### Phase 3: Partial-Window LLM (Optional, Future Enhancement)

If preload is not available, allow LLM to be called with fewer bars (but log the limitation):

```typescript
// In handleMinimal1m, after checking minimalLlmBars:
if (closed5mBars.length < this.minimalLlmBars) {
  console.log(`[LLM_PARTIAL] Calling LLM with ${closed5mBars.length} bars (less than ${this.minimalLlmBars} minimal) - context may be limited`);
  // Still allow LLM call, but LLM should be aware of limited context
}
```

---

## H) Follow-Up Plan: OpportunityLatch Integration

### Current State
- `OpportunityLatch` is already implemented (lines 2558-2618)
- It's used as the primary execution gate (lines 3274-3310)
- But it's only created in `reduce5mClose()` (line 2602)

### Issue
- `OpportunityLatch` creation depends on `exec.bias !== "NEUTRAL"` (line 2583)
- If bias stays `NEUTRAL` due to insufficient bars, no opportunity is latched
- This creates a chicken-egg problem: need bias to latch, need LLM to get bias, need bars for LLM

### Solution (Future)
1. **Allow partial-window LLM calls** (with logging) to establish bias earlier
2. **Create "weak" opportunity latches** even with `NEUTRAL` bias if structure suggests direction
3. **Preload mechanism** (Phase 2 above) solves this by providing history immediately

---

## I) Summary: Exact Blockers Causing Slowness/Quietness

### Primary Blockers
1. **Empty history on restart** → No bars for LLM → No bias → No phase transition → No setup → No events
2. **minimalLlmBars guard not enforced** → LLM called with 1-2 bars → Returns NEUTRAL → Bot stays quiet
3. **No preload mechanism** → Must wait 5-10 minutes for history to build
4. **No instrumentation** → Can't see why LLM was skipped or events were suppressed

### Secondary Blockers
5. **Split-brain setup detection** → `handleMinimal1m()` can override `reduce5mClose()` setup
6. **Event suppression not logged** → Can't see why Telegram messages aren't sent
7. **shouldPublishEvent logic** → Events only emitted on state changes, not on "still waiting" states

### Fix Priority
1. **Immediate:** Add instrumentation (Phase 1) - reveals exact blockers
2. **Short-term:** Fix `minimalLlmBars` guard (line 2791) - prevents premature LLM calls
3. **Short-term:** Add preload mechanism (Phase 2) - solves startup slowness
4. **Medium-term:** Remove split-brain setup detection (make `handleMinimal1m()` read-only)
5. **Medium-term:** Add heartbeat/silent mode detection (already partially implemented, lines 2695-2707)

---

## J) File/Line References

| Issue | File | Line(s) |
|-------|------|---------|
| LLM guard: 5m close | `src/orchestrator/orchestrator.ts` | 2788 |
| LLM guard: closed5mBars.length | `src/orchestrator/orchestrator.ts` | 2791 |
| LLM guard: minimalLlmBars (not enforced) | `src/orchestrator/orchestrator.ts` | 80, 2791 |
| LLM guard: circuit breaker | `src/orchestrator/orchestrator.ts` | 2799-2814 |
| Event suppression: shouldPublishEvent | `src/orchestrator/orchestrator.ts` | 2763, 2392 |
| Event suppression: MessageGovernor | `src/governor/messageGovernor.ts` | 47-52 |
| Event suppression: empty alert | `src/telegram/messagePublisher.ts` | 21 |
| Restart: empty recentBars5m | `src/orchestrator/orchestrator.ts` | 47 |
| Restart: initial state | `src/orchestrator/orchestrator.ts` | 76-95 |
| Split-brain: reduce5mClose setup | `src/orchestrator/orchestrator.ts` | 2481-2550 |
| Split-brain: handleMinimal1m setup | `src/orchestrator/orchestrator.ts` | 3176-3238 |
