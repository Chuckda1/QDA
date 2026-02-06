# Bias Engine Type Definitions

## Current MinimalExecutionState Fields (Relevant to Bias Engine)

### File: `src/types.ts`

```typescript
export type MarketBias = "BEARISH" | "BULLISH" | "NEUTRAL";

export type MinimalExecutionPhase =
  | "NEUTRAL_PHASE"
  | "BIAS_ESTABLISHED"
  | "PULLBACK_IN_PROGRESS"
  | "PULLBACK_REJECTION"
  | "PULLBACK_BREAKDOWN"
  | "CONTINUATION_IN_PROGRESS"
  | "REENTRY_WINDOW"
  | "IN_TRADE"
  | "CONSOLIDATION_AFTER_REJECTION";

export type MinimalExecutionState = {
  // Market Bias (sticky)
  bias: MarketBias;  // "BEARISH" | "BULLISH" | "NEUTRAL"
  baseBiasConfidence?: number;
  biasConfidence?: number;
  biasPrice?: number;
  biasTs?: number;
  biasInvalidationLevel?: number;
  
  // Trade Phase (fast)
  phase: MinimalExecutionPhase;
  
  // ... (other fields)
  
  // Micro indicators (1m timeframe for countertrend detection)
  micro?: {
    vwap1m?: number; // Session VWAP on 1m bars
    emaFast1m?: number; // Fast EMA on 1m bars
    atr1m?: number; // ATR(14) on 1m bars
    lastSwingHigh1m?: number; // Max high of last 10 1m bars
    lastSwingLow1m?: number; // Min low of last 10 1m bars
    aboveVwapCount?: number; // Consecutive closes above VWAP
    belowVwapCount?: number; // Consecutive closes below VWAP
    aboveEmaCount?: number; // Consecutive closes above EMA
    belowEmaCount?: number; // Consecutive closes below EMA
  };
  
  // ... (other fields)
};
```

## Proposed New Fields for Bias Engine

Add to `MinimalExecutionState`:

```typescript
export type BiasEngineState = 
  | "BEARISH"
  | "REPAIR_BULL"  // Neutralizing from bearish, moving toward bullish
  | "NEUTRAL"
  | "REPAIR_BEAR"  // Neutralizing from bullish, moving toward bearish
  | "BULLISH";

export type BiasEngine = {
  state: BiasEngineState;
  score: number;  // Signed regime score (positive = bullish, negative = bearish)
  lastFlipTs?: number;  // Timestamp of last full flip (for cooldown)
  repairStartTs?: number;  // When REPAIR state started
  acceptBullCount: number;  // Consecutive minutes of bull acceptance
  acceptBearCount: number;  // Consecutive minutes of bear acceptance
};

// Add to MinimalExecutionState:
export type MinimalExecutionState = {
  // ... existing fields ...
  
  // Bias Engine (deterministic, 1m-based)
  biasEngine?: BiasEngine;
  
  // ... rest of fields ...
};
```

## Current Micro Counter Update Logic

### File: `src/orchestrator/orchestrator.ts:3009-3015`

```typescript
// In handleMinimal1m(), after micro indicators are calculated:

if (vwap) {
  exec.micro.aboveVwapCount = close > vwap ? (exec.micro.aboveVwapCount ?? 0) + 1 : 0;
  exec.micro.belowVwapCount = close < vwap ? (exec.micro.belowVwapCount ?? 0) + 1 : 0;
}

if (ema1m) {
  exec.micro.aboveEmaCount = close > ema1m ? (exec.micro.aboveEmaCount ?? 0) + 1 : 0;
  exec.micro.belowEmaCount = close < ema1m ? (exec.micro.belowEmaCount ?? 0) + 1 : 0;
}
```

## Where to Call updateBiasEngine()

### File: `src/orchestrator/orchestrator.ts:3019-3031`

After the `[MICRO]` log, add:

```typescript
// Log micro state for observability
console.log("[MICRO]", {
  vwap1m: exec.micro.vwap1m?.toFixed(2),
  ema1m: exec.micro.emaFast1m?.toFixed(2),
  atr1m: exec.micro.atr1m?.toFixed(2),
  sh1m: exec.micro.lastSwingHigh1m?.toFixed(2),
  sl1m: exec.micro.lastSwingLow1m?.toFixed(2),
  aboveVwap: exec.micro.aboveVwapCount,
  aboveEma: exec.micro.aboveEmaCount,
  belowVwap: exec.micro.belowVwapCount,
  belowEma: exec.micro.belowEmaCount,
  pausedUntil: exec.deploymentPauseUntilTs ? new Date(exec.deploymentPauseUntilTs).toISOString() : undefined,
  pauseReason: exec.deploymentPauseReason,
});

// NEW: Update bias engine (deterministic, 1m-based)
this.updateBiasEngine(exec, ts, close);
```

## Function Signature Template

```typescript
private updateBiasEngine(
  exec: MinimalExecutionState,
  ts: number,
  close: number
): void {
  // Initialize biasEngine if it doesn't exist
  if (!exec.biasEngine) {
    exec.biasEngine = {
      state: exec.bias === "BULLISH" ? "BULLISH" : exec.bias === "BEARISH" ? "BEARISH" : "NEUTRAL",
      score: 0,
      acceptBullCount: 0,
      acceptBearCount: 0,
    };
  }

  const micro = exec.micro;
  if (!micro) return; // Need micro indicators

  const vwap = micro.vwap1m;
  const ema = micro.emaFast1m;
  
  // ... your implementation here ...
}
```

## Constants to Define (Class-level)

```typescript
// In Orchestrator class, add:
private readonly BIAS_ENGINE_ENTER_ACCEPT = 6;  // Minutes to enter regime
private readonly BIAS_ENGINE_EXIT_ACCEPT = 3;  // Minutes to exit regime (hysteresis)
private readonly BIAS_ENGINE_REPAIR_CONFIRM_MIN = 2;  // Minimum minutes in REPAIR before finalizing (confirmation period)
private readonly BIAS_ENGINE_COOLDOWN_MS = 5 * 60 * 1000;  // 5 minutes cooldown between full flips
```

## Acceptance Logic (What You Already Have)

```typescript
// Bull acceptance
const bullAccept = 
  (micro.aboveVwapCount ?? 0) >= this.BIAS_ENGINE_ENTER_ACCEPT &&
  (micro.aboveEmaCount ?? 0) >= this.BIAS_ENGINE_ENTER_ACCEPT &&
  vwap !== undefined && close > vwap &&
  ema !== undefined && close > ema;

// Bear acceptance
const bearAccept = 
  (micro.belowVwapCount ?? 0) >= this.BIAS_ENGINE_ENTER_ACCEPT &&
  (micro.belowEmaCount ?? 0) >= this.BIAS_ENGINE_ENTER_ACCEPT &&
  vwap !== undefined && close < vwap &&
  ema !== undefined && close < ema;
```

## Integration Point: Where Bias Gets Set

### Current: `reduce5mClose()` STEP 1 (line 2455)
```typescript
exec.bias = newBias;  // From LLM
```

### New: `updateBiasEngine()` will set:
```typescript
exec.bias = exec.biasEngine.state === "BULLISH" ? "BULLISH" 
          : exec.biasEngine.state === "BEARISH" ? "BEARISH" 
          : "NEUTRAL";
```

**Important:** You'll need to decide:
1. **Option A:** Bias engine completely replaces LLM bias (LLM becomes advisory only)
2. **Option B:** Bias engine can override LLM bias when acceptance is strong
3. **Option C:** Hybrid - LLM sets initial bias, engine can flip it on acceptance

---

## Summary

- **Current bias field:** `exec.bias: MarketBias`
- **Current phase field:** `exec.phase: MinimalExecutionPhase`
- **Current micro counters:** `exec.micro.aboveVwapCount`, `exec.micro.aboveEmaCount`, etc.
- **Call location:** After `[MICRO]` log in `handleMinimal1m()`
- **Function signature:** `updateBiasEngine(exec: MinimalExecutionState, ts: number, close: number): void`

Ready for you to write the exact `updateBiasEngine()` implementation! 🚀
