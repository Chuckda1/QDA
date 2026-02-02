# Current Rules: detectSetup() and Entry Blockers

## When `detectSetup()` is Called

### Location 1: `reduce5mClose()` - STEP 3 (Primary, Authoritative)
**File:** `src/orchestrator/orchestrator.ts`  
**Line:** ~2522  
**When:** On every 5-minute bar close

**Conditions:**
1. **Only runs if:**
   - `exec.setup === "NONE"` OR
   - `exec.setup` is undefined OR
   - Setup TTL expired (`now >= setupTTLExpiry`) OR
   - Setup was invalidated (price broke stop)

2. **TTL Persistence:**
   - Setup TTL = 2 closed 5m bars = 10 minutes
   - If setup exists and TTL not expired, setup persists (no re-detection)
   - Setup invalidated if price breaks `setupStopPrice`

3. **Inputs:**
   - `lastClosed5m` (the just-closed 5m bar)
   - `previous5m` (the bar before that)
   - `closed5mBars` (all closed bars)
   - `atr` (calculated from closed bars)
   - `forming5mBar = null` (NEVER uses forming bar)

4. **Bias Check:**
   - If `exec.bias === "NEUTRAL"`, setup is forced to `"NONE"` (no detection run)

**Code:**
```typescript
// STEP 3: Run setup detection (closed bars only, with TTL persistence)
const setupTTLDuration = 2 * 5 * 60 * 1000; // 2 bars = 10 minutes
const setupTTLExpiry = (exec.setupDetectedAt ?? 0) + setupTTLDuration;
const now = ts;

// Check if current setup should persist (TTL not expired and not invalidated)
if (exec.setup && exec.setup !== "NONE" && now < setupTTLExpiry) {
  // Check for invalidation: price breaks setup stop
  const invalidated = (exec.bias === "BEARISH" && exec.setupStopPrice !== undefined && close > exec.setupStopPrice) ||
                     (exec.bias === "BULLISH" && exec.setupStopPrice !== undefined && close < exec.setupStopPrice);
  
  if (invalidated) {
    exec.setup = "NONE";
    // ... clear setup fields
  } else {
    // Setup persists - skip re-detection
    return; // Skip detectSetup() call
  }
}

// Only run setup detection if:
// - Setup is NONE, OR
// - Setup TTL expired, OR
// - Setup was invalidated above
if (exec.setup === "NONE" || !exec.setup || now >= setupTTLExpiry) {
  if (exec.bias === "NEUTRAL") {
    exec.setup = "NONE";
  } else if (lastClosed5m) {
    const previous5m = closed5mBars.length >= 2 ? closed5mBars[closed5mBars.length - 2] : undefined;
    const atr = this.calculateATR(closed5mBars);
    const setupResult = this.detectSetup(exec, lastClosed5m, previous5m, closed5mBars, atr, null); // Never use forming bar
    // ... update exec.setup
  }
}
```

### Location 2: `handleMinimal1m()` - Legacy/Secondary
**File:** `src/orchestrator/orchestrator.ts`  
**Line:** ~3187  
**When:** On every 1m tick (but this appears to be legacy code)

**Note:** This location may be redundant or used for different purposes. The primary setup detection happens in `reduce5mClose()`.

---

## Setup Detection Priority Order

When `detectSetup()` runs, it checks in this order:

1. **BREAKDOWN** (Structure Failure)
   - Phase: `CONSOLIDATION_AFTER_REJECTION` OR `BIAS_ESTABLISHED`
   - Price breaks known structural level

2. **EARLY_REJECTION** (Failed reclaim of EMA/VWAP)
   - Phase: `BIAS_ESTABLISHED`, `PULLBACK_IN_PROGRESS`, or `CONSOLIDATION_AFTER_REJECTION`
   - ExpectedResolution: `CONTINUATION`
   - Requires: EMA9, VWAP, volume SMA20

3. **REJECTION** (Primary Trend Continuation)
   - Phase: `PULLBACK_IN_PROGRESS`
   - ExpectedResolution: `CONTINUATION`
   - **PERSISTENT**: Once detected, persists until invalidated or max bars elapsed (5 bars)

4. **COMPRESSION_BREAK** (Energy Release)
   - Phase: `CONSOLIDATION_AFTER_REJECTION`
   - ATR compressing → expansion

5. **FAILED_BOUNCE** (Counter-Trend Failure)
   - ExpectedResolution: `FAILURE`
   - Bias: `BEARISH` or `BULLISH`

6. **TREND_REENTRY** (Late Continuation)
   - Phase: `BIAS_ESTABLISHED` or `REENTRY_WINDOW`

7. **PULLBACK_GENERIC** (Fallback)
   - Phase: `BIAS_ESTABLISHED` or `PULLBACK_IN_PROGRESS`
   - Bias: `BEARISH` or `BULLISH`
   - Requires: `pullbackHigh` and `pullbackLow` defined
   - **This ensures setup is never NONE when bias is strong and pullback is happening**

8. **NONE** (Explicit No-Trade State)

---

## Exact Entry Blockers (Current Rules)

### Entry Logic Location
**File:** `src/orchestrator/orchestrator.ts`  
**Line:** ~3271  
**Function:** `handleMinimal1m()`

### Pre-Conditions (Must ALL be true to even check entry)

1. **Bias Check:**
   ```typescript
   exec.bias !== "NEUTRAL"
   ```

2. **Phase Check:**
   ```typescript
   exec.phase === "PULLBACK_IN_PROGRESS" || exec.phase === "BIAS_ESTABLISHED"
   ```

3. **Current 5m Bar Exists:**
   ```typescript
   current5m !== null
   ```

### Entry Blockers (Priority Order)

#### BLOCKER 1: No Opportunity Latched
**Location:** Line ~3301-3310  
**Condition:**
```typescript
!exec.opportunity || exec.opportunity.status !== "LATCHED"
```
**Result:**
- `exec.waitReason = "no_opportunity_latched"`
- `exec.entryBlocked = true`
- `exec.entryBlockReason = "No tradable opportunity latched - waiting for pullback zone entry"`
- **Entry blocked** ❌

**Note:** Opportunity is latched when:
- Bias is BEARISH/BULLISH
- Phase is BIAS_ESTABLISHED or PULLBACK_IN_PROGRESS
- Price enters pullback zone (0.15-0.50 ATR from resistance/support)
- Pullback levels exist

---

#### BLOCKER 2: No Setup Detected
**Location:** Line ~3348-3355  
**Condition:**
```typescript
!exec.setup || exec.setup === "NONE"
```
**Result:**
- `exec.waitReason = "no_setup_detected"`
- `exec.entryBlocked = true`
- `exec.entryBlockReason = "No tradable setup detected - structure incomplete"`
- **Entry blocked** ❌

**Note:** With PULLBACK_GENERIC fallback, this should be rare when:
- Bias is strong
- Phase is BIAS_ESTABLISHED or PULLBACK_IN_PROGRESS
- Pullback levels exist

---

#### BLOCKER 3: Entry Signal Not Fired
**Location:** Line ~3319-3347  
**Condition:**
```typescript
const entrySignalFires = 
  (exec.bias === "BULLISH" && (isBearish || (previous5m && lowerLow))) ||
  (exec.bias === "BEARISH" && (isBullish || (previous5m && higherHigh)));

const canEnter = 
  (exec.setup && exec.setup !== "NONE") && // Setup must exist
  entrySignalFires && // Entry signal must fire
  (exec.opportunity?.status === "LATCHED" || exec.opportunity?.status === "TRIGGERED" || !exec.opportunity); // Opportunity can be LATCHED, TRIGGERED, or not exist

if (!canEnter && exec.setup && exec.setup !== "NONE" && !entrySignalFires) {
  // Setup exists but entry signal hasn't fired yet
  exec.waitReason = "waiting_for_entry_signal";
  exec.entryBlocked = false; // Not blocked, just waiting
}
```

**Entry Signal Definition:**
- **BULLISH bias:** Current bar is bearish (`isBearish`) OR makes a lower low (`lowerLow`)
- **BEARISH bias:** Current bar is bullish (`isBullish`) OR makes a higher high (`higherHigh`)

**Result if signal not fired:**
- `exec.waitReason = "waiting_for_entry_signal"`
- `exec.entryBlocked = false` (not blocked, just waiting)
- **Entry blocked** ❌ (but not marked as blocked)

---

#### BLOCKER 4: No-Chase Rules
**Location:** Line ~3360-3407  
**Function:** `shouldBlockEntry()`

**Conditions Checked:**
1. **Phase Check:**
   ```typescript
   phase !== "CONTINUATION_IN_PROGRESS" → not blocked
   ```
   Only blocks during continuation, not during pullback.

2. **Continuation Extension:**
   ```typescript
   continuationExtension > 1.25 * pullbackRange → blocked
   ```
   If continuation has extended too far beyond pullback range.

3. **Distance from Ideal Trigger:**
   ```typescript
   distance > 0.8 * ATR from ideal trigger → blocked
   ```
   If price is too far from ideal entry point.

4. **Price Past Expected Zone:**
   ```typescript
   currentPrice < targetZones.expectedZone.lower (bearish) OR
   currentPrice > targetZones.expectedZone.upper (bullish) → blocked
   ```
   If price has already moved past expected target zone.

**Result if blocked:**
- `exec.entryBlocked = true`
- `exec.entryBlockReason = blockCheck.reason` (e.g., "continuation_extended", "price_past_expected_zone")
- `exec.waitReason = blockCheck.reason ?? "entry_blocked"`
- **Entry blocked** ❌

---

#### BLOCKER 5: Market Closed
**Location:** Line ~2720-2725  
**Condition:**
```typescript
const regime = getMarketRegime(new Date(ts));
if (!regime.isRTH) {
  this.state.minimalExecution.phase = "NEUTRAL_PHASE";
  this.state.minimalExecution.waitReason = "market_closed";
  return events; // Early return - no entry logic runs
}
```
**Result:**
- Early return from `handleMinimal1m()`
- Entry logic never runs
- **Entry blocked** ❌

---

#### BLOCKER 6: In Trade / Cooldown
**Location:** Implicit  
**Condition:**
```typescript
exec.phase === "IN_TRADE"
```
**Result:**
- Entry logic doesn't run (only runs when phase is PULLBACK_IN_PROGRESS or BIAS_ESTABLISHED)
- **Entry blocked** ❌

---

## Entry Execution Flow (When All Blockers Pass)

**Location:** Line ~3320-3445

1. **Entry Signal Detected:**
   - BULLISH: bearish candle or lower low
   - BEARISH: bullish candle or higher high

2. **No-Chase Check:**
   - `shouldBlockEntry()` returns `{ blocked: false }`

3. **Entry Executed:**
   - `exec.entryPrice = current5m.close`
   - `exec.stopPrice = exec.opportunity?.stop.price ?? current5m.low/high`
   - `exec.phase = "IN_TRADE"`
   - `exec.opportunity.status = "CONSUMED"`
   - Targets computed and stored

---

## Summary: Entry Blocker Priority Order

1. **Market closed** (`!regime.isRTH`) → Early return
2. **In trade** (`exec.phase === "IN_TRADE"`) → Entry logic doesn't run
3. **Bias neutral** (`exec.bias === "NEUTRAL"`) → Entry logic doesn't run
4. **Phase not ready** (`exec.phase !== "PULLBACK_IN_PROGRESS" && exec.phase !== "BIAS_ESTABLISHED"`) → Entry logic doesn't run
   - **Note:** Entry logic explicitly skips `CONTINUATION_IN_PROGRESS` (no-chase rule)
5. **No opportunity latched** (`!exec.opportunity || exec.opportunity.status !== "LATCHED"`) → Entry blocked
6. **No setup** (`exec.setup === "NONE"`) → Entry blocked (should be rare with PULLBACK_GENERIC)
7. **No entry signal** (`!entrySignalFires`) → Waiting (not blocked, but no entry)
8. **No-chase rules** (`shouldBlockEntry()` returns blocked) → Entry blocked
9. **Risk invalid** (stop distance too small/large) → Not explicitly checked (would be in shouldBlockEntry if needed)

---

## Key Changes from Recent Fixes

### FIX #1: Collapse "Gate TRIGGERED" into "Entry Signal"
- **Before:** Required `exec.opportunity.status === "TRIGGERED"`
- **After:** Allows entry when `exec.setup !== "NONE"` + `entrySignalFires` + opportunity is `LATCHED` or `TRIGGERED` or doesn't exist
- **Impact:** Entry can fire immediately on signal, not waiting for gate trigger

### FIX #2: Setup TTL Persistence
- **Before:** Setup could flicker `REJECTION → NONE → REJECTION` on next tick
- **After:** Setup persists for 2 closed 5m bars (10 minutes) unless invalidated
- **Impact:** Prevents flicker from killing entries

### FIX #3: PULLBACK_GENERIC Fallback
- **Before:** `setup === "NONE"` was common when no specific pattern matched
- **After:** Generic pullback setup fires when bias is strong and pullback is happening
- **Impact:** Makes "No setup detected" rare
