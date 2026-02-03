# Current Trade State Architecture

## Overview

The bot is currently **alerts-only** - it does NOT place actual orders. It tracks trade state internally and emits events.

---

## Trade State Transitions

### Entry Flow

**Location:** `handleMinimal1m()` around lines 3150-3270

**When entry conditions are met:**
```typescript
exec.phase = "IN_TRADE";
exec.entryPrice = current5m.close;
exec.entryTs = ts;
exec.entryType = "REJECTION_ENTRY" | "BREAKDOWN_ENTRY" | "REENTRY_AFTER_CONTINUATION";
exec.entryTrigger = "Bearish rejection at VWAP" | etc.;
exec.stopPrice = exec.opportunity?.stop.price ?? current5m.low/high;
exec.targets = [T1, T2, T3]; // Risk-unit targets
exec.targetZones = { rTargets, atrTargets, magnetLevels, expectedZone, ... };
exec.opportunity.status = "CONSUMED";
exec.entryBlocked = false;
exec.waitReason = "in_trade";
```

**Log:** `[ENTRY_EXECUTED] ${oldPhase} -> IN_TRADE | BIAS=${exec.bias} SETUP=${exec.setup} entry=${exec.entryPrice.toFixed(2)} type=${exec.entryType} trigger="${exec.entryTrigger}" stop=${exec.stopPrice.toFixed(2)}`

---

### Exit Flow

**Location:** `handleMinimal1m()` around lines 3294-3361

#### Stop Hit (Close-Based Only)

**LONG:**
```typescript
if (exec.thesisDirection === "long" && current5m.low <= exec.stopPrice) {
  exec.phase = exec.bias === "NEUTRAL" ? "NEUTRAL_PHASE" : "PULLBACK_IN_PROGRESS";
  exec.waitReason = exec.bias === "NEUTRAL" ? "waiting_for_bias" : "waiting_for_pullback";
  this.clearTradeState(exec);
  shouldPublishEvent = true;
}
```

**SHORT:**
```typescript
if (exec.thesisDirection === "short" && current5m.high >= exec.stopPrice) {
  exec.phase = exec.bias === "NEUTRAL" ? "NEUTRAL_PHASE" : "PULLBACK_IN_PROGRESS";
  exec.waitReason = exec.bias === "NEUTRAL" ? "waiting_for_bias" : "waiting_for_pullback";
  this.clearTradeState(exec);
  shouldPublishEvent = true;
}
```

**Note:** Uses `current5m.low/high` (wick-based check), but should be `current5m.close` for close-based logic per `STOP_LOGIC_FORMULAS.md`.

**Log:** `[STATE_TRANSITION] ${oldPhase} -> ${newPhase} | Stop hit at ${price} (stop=${exec.stopPrice.toFixed(2)})`

---

#### Target Hit

```typescript
if (exec.targets.some(target => 
  (exec.thesisDirection === "long" && current5m.high >= target) ||
  (exec.thesisDirection === "short" && current5m.low <= target)
)) {
  const hitTarget = exec.targets.find(target => ...);
  exec.phase = exec.bias === "NEUTRAL" ? "NEUTRAL_PHASE" : "PULLBACK_IN_PROGRESS";
  exec.waitReason = exec.bias === "NEUTRAL" ? "waiting_for_bias" : "waiting_for_pullback";
  this.clearTradeState(exec);
  shouldPublishEvent = true;
}
```

**Log:** `[STATE_TRANSITION] ${oldPhase} -> ${newPhase} | Target hit at ${hitTarget?.toFixed(2)}`

---

### clearTradeState() Function

**Location:** Line 1200

```typescript
private clearTradeState(exec: MinimalExecutionState): void {
  // Only clear pullback levels if we're not in PULLBACK_IN_PROGRESS (need them for failure detection)
  if (exec.phase !== "PULLBACK_IN_PROGRESS") {
    exec.pullbackHigh = undefined;
    exec.pullbackLow = undefined;
    exec.pullbackTs = undefined;
  }
  exec.entryPrice = undefined;
  exec.entryTs = undefined;
  exec.stopPrice = undefined;
  exec.targets = undefined;
  exec.entryType = undefined;
  exec.entryTrigger = undefined;
}
```

**Note:** Does NOT clear:
- `exec.phase` (caller sets this)
- `exec.waitReason` (caller sets this)
- `exec.pullbackHigh/Low` (if phase is PULLBACK_IN_PROGRESS)

---

## Current State: No Order Execution

**There is NO `placeOrder()` function.**

The bot:
- ✅ Tracks trade state internally (`exec.phase = "IN_TRADE"`)
- ✅ Emits `MIND_STATE_UPDATED` events with trade info
- ✅ Detects stop/target hits and transitions state
- ❌ Does NOT place actual orders with broker
- ❌ Does NOT track broker position state
- ❌ Does NOT handle fills, slippage, or partial fills

---

## Trade State Fields (MinimalExecutionState)

**Entry Tracking:**
- `entryPrice?: number` - Entry price
- `entryTs?: number` - Entry timestamp
- `entryType?: EntryType` - Type of entry (REJECTION_ENTRY, BREAKDOWN_ENTRY, etc.)
- `entryTrigger?: string` - What triggered entry

**Risk Management:**
- `stopPrice?: number` - Stop loss price
- `targets?: number[]` - Legacy array of targets [T1, T2, T3]
- `targetZones?: {...}` - Comprehensive target zones (R-targets, ATR-targets, magnets, etc.)

**Position State:**
- `phase: MinimalExecutionPhase` - Current phase (IN_TRADE when position active)
- `thesisDirection?: "long" | "short" | "none"` - Direction of trade

---

## Phase Transitions

```
NEUTRAL_PHASE
  ↓ (bias established)
BIAS_ESTABLISHED
  ↓ (pullback detected)
PULLBACK_IN_PROGRESS
  ↓ (entry signal)
IN_TRADE
  ↓ (stop hit OR target hit)
PULLBACK_IN_PROGRESS | NEUTRAL_PHASE
```

---

## Issues / Gaps

1. **Stop check uses wick, not close:**
   - Current: `current5m.low <= exec.stopPrice` (wick-based)
   - Should be: `current5m.close <= exec.stopPrice` (close-based per `STOP_LOGIC_FORMULAS.md`)

2. **No broker integration:**
   - No `placeOrder()` function
   - No position tracking from broker
   - No fill confirmation
   - No order status management

3. **No exit reason tracking:**
   - Exits don't store why they exited (STOP_HIT, TARGET_HIT, etc.)
   - No P&L calculation
   - No exit price stored

4. **Target hit doesn't specify which target:**
   - Finds first target hit but doesn't store which one
   - Could be T1, T2, or T3

---

## Recommended Next Steps

If adding actual order execution:

1. **Add `placeOrder()` interface:**
   ```typescript
   async placeOrder(params: {
     side: "long" | "short";
     entryPrice: number;
     stopPrice: number;
     quantity: number;
     orderType: "MARKET" | "LIMIT";
   }): Promise<OrderResult>
   ```

2. **Add exit tracking:**
   ```typescript
   exec.exitPrice?: number;
   exec.exitTs?: number;
   exec.exitReason?: "STOP_HIT" | "TARGET_HIT" | "MANUAL" | "TIME_EXIT";
   exec.exitTarget?: "T1" | "T2" | "T3";
   exec.pnl?: number;
   exec.rMultiple?: number;
   ```

3. **Fix stop check to use close:**
   - Change `current5m.low <= exec.stopPrice` to `current5m.close <= exec.stopPrice`
   - Change `current5m.high >= exec.stopPrice` to `current5m.close >= exec.stopPrice`

4. **Add broker position sync:**
   - Query broker for actual position
   - Sync `exec.phase` with broker position state
   - Handle position not found (already closed externally)
