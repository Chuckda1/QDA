# Exact Code: detectSetup() Calls and Entry Blockers

## 1. When `detectSetup()` is Called

### Location 1: `reduce5mClose()` - STEP 3 (Primary, Authoritative)
**File:** `src/orchestrator/orchestrator.ts`  
**Lines:** 2481-2550

```typescript
// ============================================================================
// STEP 3: Run setup detection (closed bars only, with TTL persistence)
// ============================================================================
const setupTTLDuration = 2 * 5 * 60 * 1000; // 2 bars = 10 minutes
const setupTTLExpiry = (exec.setupDetectedAt ?? 0) + setupTTLDuration;
const now = ts;

// Check if current setup should persist (TTL not expired and not invalidated)
if (exec.setup && exec.setup !== "NONE" && now < setupTTLExpiry) {
  // Check for invalidation: price breaks setup stop
  const invalidated = (exec.bias === "BEARISH" && exec.setupStopPrice !== undefined && close > exec.setupStopPrice) ||
                     (exec.bias === "BULLISH" && exec.setupStopPrice !== undefined && close < exec.setupStopPrice);
  
  if (invalidated) {
    console.log(
      `[SETUP_INVALIDATED] ${exec.setup} -> NONE | Price broke stop - bias=${exec.bias} price=${close.toFixed(2)} stop=${exec.setupStopPrice?.toFixed(2) ?? "n/a"}`
    );
    exec.setup = "NONE";
    exec.setupTriggerPrice = undefined;
    exec.setupStopPrice = undefined;
    exec.setupDetectedAt = undefined;
  } else {
    // Setup persists - skip re-detection
    console.log(
      `[SETUP_PERSISTS] ${exec.setup} | TTL valid until ${new Date(setupTTLExpiry).toISOString()}`
    );
  }
}

// Only run setup detection if:
// - Setup is NONE, OR
// - Setup TTL expired, OR
// - Setup was invalidated above
if (exec.setup === "NONE" || !exec.setup || now >= setupTTLExpiry) {
  if (exec.bias === "NEUTRAL") {
    exec.setup = "NONE";
    exec.setupTriggerPrice = undefined;
    exec.setupStopPrice = undefined;
  } else if (lastClosed5m) {
    const previous5m = closed5mBars.length >= 2 ? closed5mBars[closed5mBars.length - 2] : undefined;
    const atr = this.calculateATR(closed5mBars);
    const setupResult = this.detectSetup(exec, lastClosed5m, previous5m, closed5mBars, atr, null); // Never use forming bar
    
    const oldSetup = exec.setup;
    exec.setup = setupResult.setup;
    exec.setupTriggerPrice = setupResult.triggerPrice;
    exec.setupStopPrice = setupResult.stopPrice;
    
    if (oldSetup !== setupResult.setup) {
      exec.setupDetectedAt = ts;
      
      // Store rejection candle info when REJECTION is first detected
      if (setupResult.setup === "REJECTION") {
        exec.rejectionCandleLow = setupResult.rejectionCandleLow;
        exec.rejectionCandleHigh = setupResult.rejectionCandleHigh;
        exec.rejectionBarsElapsed = 0;
      } else {
        exec.rejectionCandleLow = undefined;
        exec.rejectionCandleHigh = undefined;
        exec.rejectionBarsElapsed = undefined;
      }
      
      console.log(
        `[SETUP_DETECTED] ${oldSetup ?? "NONE"} -> ${setupResult.setup} | BIAS=${exec.bias} PHASE=${exec.phase} trigger=${setupResult.triggerPrice?.toFixed(2) ?? "n/a"} stop=${setupResult.stopPrice?.toFixed(2) ?? "n/a"}`
      );
    } else if (exec.setup === "REJECTION") {
      exec.rejectionBarsElapsed = (exec.rejectionBarsElapsed ?? 0) + 1;
    }
  }
}
```

**Key Points:**
- Called on **every 5m bar close** (inside `reduce5mClose()`)
- Only runs if `setup === "NONE"` OR TTL expired OR invalidated
- **NEVER uses forming bar** (`null` passed as last parameter)
- Setup TTL = 10 minutes (2 closed 5m bars)
- If bias is NEUTRAL, setup is forced to "NONE" (no detection)

---

### Location 2: `handleMinimal1m()` - Legacy/Secondary
**File:** `src/orchestrator/orchestrator.ts`  
**Lines:** 3175-3238

```typescript
// Setup detection: only when bias is not NEUTRAL
if (exec.bias === "NEUTRAL") {
  // Clear setup when bias is neutral
  if (exec.setup && exec.setup !== "NONE") {
    console.log(`[SETUP_CLEARED] ${exec.setup} -> NONE | BIAS=NEUTRAL`);
  }
  exec.setup = "NONE";
  exec.setupTriggerPrice = undefined;
  exec.setupStopPrice = undefined;
} else if (current5m) {
  const atr = this.calculateATR(closed5mBars);
  const setupResult = this.detectSetup(exec, current5m, previous5m ?? undefined, closed5mBars, atr, forming5mBar);
  
  // Update setup state
  const oldSetup = exec.setup;
  exec.setup = setupResult.setup;
  exec.setupTriggerPrice = setupResult.triggerPrice;
  exec.setupStopPrice = setupResult.stopPrice;
  
  if (oldSetup !== setupResult.setup) {
    exec.setupDetectedAt = ts;
    
    // Store rejection candle info when REJECTION is first detected
    if (setupResult.setup === "REJECTION") {
      exec.rejectionCandleLow = setupResult.rejectionCandleLow;
      exec.rejectionCandleHigh = setupResult.rejectionCandleHigh;
      exec.rejectionBarsElapsed = 0;
      
      // Re-arm gate with REJECTION-specific trigger when REJECTION is first detected
      if (exec.expectedResolution === "CONTINUATION" && 
          exec.pullbackHigh !== undefined && 
          exec.pullbackLow !== undefined) {
        const atrForGate = this.calculateATR(closed5mBars);
        if (atrForGate > 0) {
          this.armResolutionGate(exec, exec.bias, exec.pullbackHigh, exec.pullbackLow, atrForGate, ts);
        }
      }
    } else {
      exec.rejectionCandleLow = undefined;
      exec.rejectionCandleHigh = undefined;
      exec.rejectionBarsElapsed = undefined;
    }
    
    console.log(
      `[SETUP_DETECTED] ${oldSetup ?? "NONE"} -> ${setupResult.setup} | BIAS=${exec.bias} PHASE=${exec.phase} trigger=${setupResult.triggerPrice?.toFixed(2) ?? "n/a"} stop=${setupResult.stopPrice?.toFixed(2) ?? "n/a"}`
    );
  } else if (exec.setup === "REJECTION") {
    exec.rejectionBarsElapsed = (exec.rejectionBarsElapsed ?? 0) + 1;
  }
}
```

**Note:** This location uses `forming5mBar` (unlike Location 1), which may cause flicker. The primary detection should be in `reduce5mClose()`.

---

## 2. Exact Entry Blockers (Setup/Gate/Phase)

### Entry Logic Entry Point
**File:** `src/orchestrator/orchestrator.ts`  
**Lines:** 3269-3480

```typescript
// Check for pullback entry every 1m (responsive, not just on 5m close)
// Skip entry attempts during CONTINUATION_IN_PROGRESS (no-chase rule)
if (exec.bias !== "NEUTRAL" && (exec.phase === "PULLBACK_IN_PROGRESS" || exec.phase === "BIAS_ESTABLISHED")) {
  if (current5m) {
    // Check if opportunity exists and is latched
    if (exec.opportunity && exec.opportunity.status === "LATCHED") {
      // Check for trigger (LATCHED → TRIGGERED)
      const previous5m = closed5mBars.length >= 2 ? closed5mBars[closed5mBars.length - 2] : undefined;
      const triggerCheck = this.checkOpportunityTrigger(
        exec.opportunity,
        current5m,
        previous5m,
        closed5mBars,
        this.calculateATR(closed5mBars)
      );
      
      if (triggerCheck.triggered) {
        exec.opportunity.status = "TRIGGERED";
        console.log(
          `[OPPORTUNITY_TRIGGERED] ${exec.opportunity.side} reason=${triggerCheck.reason} price=${current5m.close.toFixed(2)}`
        );
        shouldPublishEvent = true;
      } else {
        // Opportunity latched but not triggered yet
        exec.waitReason = `waiting_for_${exec.opportunity.trigger.type.toLowerCase()}_trigger`;
        const priceVsTrigger = exec.opportunity.side === "SHORT"
          ? current5m.close - exec.opportunity.trigger.price
          : exec.opportunity.trigger.price - current5m.close;
        console.log(
          `[OPPORTUNITY_LATCHED] ${exec.opportunity.side} price=${current5m.close.toFixed(2)} trigger=${exec.opportunity.trigger.price.toFixed(2)} distance=${priceVsTrigger.toFixed(2)}`
        );
      }
    } else if (!exec.opportunity || exec.opportunity.status !== "LATCHED") {
      // BLOCKER 1: No opportunity latched
      exec.waitReason = "no_opportunity_latched";
      exec.entryBlocked = true;
      exec.entryBlockReason = "No tradable opportunity latched - waiting for pullback zone entry";
      shouldPublishEvent = true;
      console.log(
        `[ENTRY_BLOCKED] No opportunity latched - BIAS=${exec.bias} PHASE=${exec.phase} - Waiting for pullback zone`
      );
    }
    
    // ============================================================================
    // FIX #1: Collapse "Gate TRIGGERED" into "Entry Signal"
    // ============================================================================
    // New rule: setup != NONE + entrySignal == true => entry allowed
    // Gate is now just a time-box + pricing guide, not a hard blocker
    // ============================================================================
    
    // Entry signal detection
    const open = current5m.open ?? current5m.close;
    const isBearish = current5m.close < open;
    const isBullish = current5m.close > open;
    
    let lowerLow = false;
    let higherHigh = false;
    if (previous5m) {
      lowerLow = current5m.low < previous5m.low;
      higherHigh = current5m.high > previous5m.high;
    }

    // Check if entry signal fires
    const entrySignalFires = 
      (exec.bias === "BULLISH" && (isBearish || (previous5m && lowerLow))) ||
      (exec.bias === "BEARISH" && (isBullish || (previous5m && higherHigh)));

    // FIX #1: Allow entry if setup exists and signal fires, even if opportunity is only LATCHED
    // (Previously required TRIGGERED, which was too strict)
    const canEnter = 
      (exec.setup && exec.setup !== "NONE") && // BLOCKER 2: Setup must exist
      entrySignalFires && // BLOCKER 3: Entry signal must fire
      (exec.opportunity?.status === "LATCHED" || exec.opportunity?.status === "TRIGGERED" || !exec.opportunity); // Opportunity can be LATCHED, TRIGGERED, or not exist

    if (canEnter) {
      // Enter ON pullback for BULLISH bias
      if (exec.bias === "BULLISH" && (isBearish || (previous5m && lowerLow))) {
        // BLOCKER 4: No-chase rules (final check before entry)
        const atrForBlock = this.calculateATR(closed5mBars);
        const blockCheck = this.shouldBlockEntry(
          exec.bias,
          exec.phase,
          current5m.close,
          exec.pullbackHigh,
          exec.pullbackLow,
          atrForBlock,
          exec.targetZones
        );
        
        if (blockCheck.blocked) {
          exec.entryBlocked = true;
          exec.entryBlockReason = blockCheck.reason;
          exec.waitReason = blockCheck.reason ?? "entry_blocked";
          shouldPublishEvent = true;
          console.log(
            `[ENTRY_BLOCKED] BIAS=${exec.bias} phase=${exec.phase} reason=${blockCheck.reason} - No-chase rule triggered`
          );
        } else {
          // ENTRY EXECUTED
          // ... entry execution code ...
        }
      }

      // Enter ON pullback for BEARISH bias
      if (exec.bias === "BEARISH" && (isBullish || (previous5m && higherHigh))) {
        // Same no-chase check and entry execution...
      }
    } else if (exec.setup && exec.setup !== "NONE" && !entrySignalFires) {
      // BLOCKER 3: Setup exists but entry signal hasn't fired yet
      exec.waitReason = "waiting_for_entry_signal";
      exec.entryBlocked = false; // Not blocked, just waiting
      console.log(
        `[ENTRY_WAITING] Setup=${exec.setup} exists but entry signal not yet fired - BIAS=${exec.bias}`
      );
    } else if (!exec.setup || exec.setup === "NONE") {
      // BLOCKER 2: No setup detected (should be rare with PULLBACK_GENERIC)
      exec.waitReason = "no_setup_detected";
      exec.entryBlocked = true;
      exec.entryBlockReason = "No tradable setup detected - structure incomplete";
      console.log(
        `[ENTRY_BLOCKED] No setup detected - BIAS=${exec.bias} PHASE=${exec.phase}`
      );
    }
  }
}
```

---

### Pre-Conditions (Must ALL be true to even check entry)

```typescript
// Line 3271: Phase blocker
if (exec.bias !== "NEUTRAL" && (exec.phase === "PULLBACK_IN_PROGRESS" || exec.phase === "BIAS_ESTABLISHED")) {
  // Entry logic runs here
}
```

**If these fail, entry logic doesn't run at all:**
- `exec.bias === "NEUTRAL"` → Entry logic skipped
- `exec.phase !== "PULLBACK_IN_PROGRESS" && exec.phase !== "BIAS_ESTABLISHED"` → Entry logic skipped
- `current5m === null` → Entry logic skipped

---

### BLOCKER 1: No Opportunity Latched
**Lines:** 3301-3310

```typescript
else if (!exec.opportunity || exec.opportunity.status !== "LATCHED") {
  // No opportunity latched - this is the new "waiting" state
  exec.waitReason = "no_opportunity_latched";
  exec.entryBlocked = true;
  exec.entryBlockReason = "No tradable opportunity latched - waiting for pullback zone entry";
  shouldPublishEvent = true;
  console.log(
    `[ENTRY_BLOCKED] No opportunity latched - BIAS=${exec.bias} PHASE=${exec.phase} - Waiting for pullback zone`
  );
}
```

**Blocks entry if:**
- `exec.opportunity` is undefined/null
- `exec.opportunity.status !== "LATCHED"` (could be INACTIVE, TRIGGERED, EXPIRED, etc.)

---

### BLOCKER 2: No Setup Detected
**Lines:** 3473-3480

```typescript
} else if (!exec.setup || exec.setup === "NONE") {
  // No setup detected (should be rare with PULLBACK_GENERIC)
  exec.waitReason = "no_setup_detected";
  exec.entryBlocked = true;
  exec.entryBlockReason = "No tradable setup detected - structure incomplete";
  console.log(
    `[ENTRY_BLOCKED] No setup detected - BIAS=${exec.bias} PHASE=${exec.phase}`
  );
}
```

**Blocks entry if:**
- `exec.setup` is undefined/null
- `exec.setup === "NONE"`

**Note:** With PULLBACK_GENERIC fallback, this should be rare when bias is strong and pullback is happening.

---

### BLOCKER 3: Entry Signal Not Fired
**Lines:** 3331-3341, 3473-3477

```typescript
// Check if entry signal fires
const entrySignalFires = 
  (exec.bias === "BULLISH" && (isBearish || (previous5m && lowerLow))) ||
  (exec.bias === "BEARISH" && (isBullish || (previous5m && higherHigh)));

const canEnter = 
  (exec.setup && exec.setup !== "NONE") && // Setup must exist
  entrySignalFires && // Entry signal must fire
  (exec.opportunity?.status === "LATCHED" || exec.opportunity?.status === "TRIGGERED" || !exec.opportunity);

// ... later ...

} else if (exec.setup && exec.setup !== "NONE" && !entrySignalFires) {
  // Setup exists but entry signal hasn't fired yet
  exec.waitReason = "waiting_for_entry_signal";
  exec.entryBlocked = false; // Not blocked, just waiting
  console.log(
    `[ENTRY_WAITING] Setup=${exec.setup} exists but entry signal not yet fired - BIAS=${exec.bias}`
  );
}
```

**Entry Signal Definition:**
- **BULLISH bias:** `isBearish` (current bar close < open) OR `lowerLow` (current bar low < previous bar low)
- **BEARISH bias:** `isBullish` (current bar close > open) OR `higherHigh` (current bar high > previous bar high)

**Blocks entry if:**
- `entrySignalFires === false`
- But `exec.entryBlocked = false` (not marked as blocked, just waiting)

---

### BLOCKER 4: No-Chase Rules
**Lines:** 2076-2132 (shouldBlockEntry function), 3348-3365 (entry logic)

```typescript
// Function: shouldBlockEntry()
private shouldBlockEntry(
  bias: MarketBias,
  phase: MinimalExecutionPhase,
  currentPrice: number,
  pullbackHigh?: number,
  pullbackLow?: number,
  atr?: number,
  targetZones?: {
    expectedZone: { lower: number; upper: number };
    expectedEnd: number;
  }
): { blocked: boolean; reason?: string } {
  // Only check blocking during continuation
  if (phase !== "CONTINUATION_IN_PROGRESS") {
    return { blocked: false };
  }

  if (pullbackHigh === undefined && pullbackLow === undefined) {
    return { blocked: false };
  }

  // Rule 1: Extended Distance
  let continuationExtension = 0;
  let pullbackRange = 0;
  
  if (bias === "BULLISH" && pullbackHigh !== undefined) {
    continuationExtension = currentPrice - pullbackHigh;
    pullbackRange = pullbackHigh - (pullbackLow ?? pullbackHigh * 0.998);
  } else if (bias === "BEARISH" && pullbackLow !== undefined) {
    continuationExtension = pullbackLow - currentPrice;
    pullbackRange = (pullbackHigh ?? pullbackLow * 1.002) - pullbackLow;
  }

  if (pullbackRange > 0 && continuationExtension > pullbackRange * 1.25) {
    return { blocked: true, reason: "continuation_extended" };
  }

  // Don't-chase rule: if price is already > 0.8*ATR below ideal trigger (for shorts)
  // or > 0.8*ATR above ideal trigger (for longs), don't enter
  if (atr !== undefined && atr > 0) {
    if (bias === "BEARISH" && pullbackLow !== undefined) {
      const idealTrigger = pullbackLow;
      const distanceBelow = idealTrigger - currentPrice;
      if (distanceBelow > 0.8 * atr) {
        return { blocked: true, reason: "continuation_extended" };
      }
    } else if (bias === "BULLISH" && pullbackHigh !== undefined) {
      const idealTrigger = pullbackHigh;
      const distanceAbove = currentPrice - idealTrigger;
      if (distanceAbove > 0.8 * atr) {
        return { blocked: true, reason: "continuation_extended" };
      }
    }
  }

  // Don't-chase rule: if price is already past expected zone, don't enter
  if (targetZones !== undefined) {
    if (bias === "BEARISH" && currentPrice < targetZones.expectedZone.lower) {
      return { blocked: true, reason: "price_past_expected_zone" };
    } else if (bias === "BULLISH" && currentPrice > targetZones.expectedZone.upper) {
      return { blocked: true, reason: "price_past_expected_zone" };
    }
  }

  return { blocked: false };
}

// Called in entry logic (line 3348):
const blockCheck = this.shouldBlockEntry(
  exec.bias,
  exec.phase,
  current5m.close,
  exec.pullbackHigh,
  exec.pullbackLow,
  atrForBlock,
  exec.targetZones
);

if (blockCheck.blocked) {
  exec.entryBlocked = true;
  exec.entryBlockReason = blockCheck.reason;
  exec.waitReason = blockCheck.reason ?? "entry_blocked";
  shouldPublishEvent = true;
  console.log(
    `[ENTRY_BLOCKED] BIAS=${exec.bias} phase=${exec.phase} reason=${blockCheck.reason} - No-chase rule triggered`
  );
}
```

**Blocks entry if:**
- `phase === "CONTINUATION_IN_PROGRESS"` AND any of:
  - `continuationExtension > 1.25 * pullbackRange`
  - Distance from ideal trigger > `0.8 * ATR`
  - Price past expected zone (`currentPrice < expectedZone.lower` for bearish, `currentPrice > expectedZone.upper` for bullish)

---

### BLOCKER 5: Market Closed
**Lines:** 2720-2725

```typescript
const regime = getMarketRegime(new Date(ts));
if (!regime.isRTH) {
  this.state.minimalExecution.phase = "NEUTRAL_PHASE";
  this.state.minimalExecution.waitReason = "market_closed";
  return events; // Early return - no entry logic runs
}
```

**Blocks entry if:**
- `regime.isRTH === false`
- **Early return** - entry logic never runs

---

## Summary: Entry Blocker Flow

```
1. Market closed check (line 2720)
   └─> if (!regime.isRTH) return events; // Early exit

2. Pre-conditions (line 3271)
   └─> if (bias === "NEUTRAL" || phase not in [PULLBACK_IN_PROGRESS, BIAS_ESTABLISHED]) 
       → Entry logic skipped

3. Opportunity check (line 3274)
   └─> if (!opportunity || opportunity.status !== "LATCHED")
       → BLOCKER 1: entryBlocked = true, waitReason = "no_opportunity_latched"

4. Entry signal + setup check (line 3338)
   └─> canEnter = (setup !== "NONE") && entrySignalFires && (opportunity is LATCHED/TRIGGERED or doesn't exist)
   
5. If canEnter:
   └─> No-chase check (line 3348)
       └─> if (shouldBlockEntry() returns blocked)
           → BLOCKER 4: entryBlocked = true, reason = "continuation_extended" or "price_past_expected_zone"
       └─> else
           → ENTRY EXECUTED

6. If !canEnter:
   └─> if (setup === "NONE")
       → BLOCKER 2: entryBlocked = true, waitReason = "no_setup_detected"
   └─> if (setup !== "NONE" && !entrySignalFires)
       → BLOCKER 3: entryBlocked = false, waitReason = "waiting_for_entry_signal"
```

---

## Key Entry Condition (After FIX #1)

```typescript
// Line 3338-3341
const canEnter = 
  (exec.setup && exec.setup !== "NONE") && // Setup must exist
  entrySignalFires && // Entry signal must fire
  (exec.opportunity?.status === "LATCHED" || exec.opportunity?.status === "TRIGGERED" || !exec.opportunity);
```

**This means:**
- Setup can be LATCHED (not just TRIGGERED) - this is the key fix
- Opportunity can be missing entirely (fallback)
- But setup must exist and signal must fire
