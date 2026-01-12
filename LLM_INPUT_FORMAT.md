# LLM Input Format - Structured Data

## ✅ All Numbers Computed in Code

**LLM never calculates** - it only reasons using provided metrics.

---

## Structured JSON Object Sent to LLM

Every LLM call receives a structured JSON object with all computed metrics:

```json
{
  // Raw inputs (for reference only)
  "close": 504.71,
  "entry": 504.70,
  "stop": 504.06,
  "t1": 505.14,
  "t2": 505.58,
  "t3": 506.02,
  
  // Computed metrics (deterministic, no LLM calculation)
  "risk": 0.64,                    // |entry - stop| per share
  "rewardT1": 0.44,                // reward to T1 per share
  "rewardT2": 0.88,                // reward to T2 per share
  "rewardT3": 1.32,                // reward to T3 per share
  "rr_t1": 0.69,                   // R-multiple to T1
  "rr_t2": 1.38,                   // R-multiple to T2
  "rr_t3": 2.06,                   // R-multiple to T3
  
  // Distance metrics (dollar and percent)
  "distanceToStopDollar": 0.65,    // close - stop (LONG) or stop - close (SHORT)
  "distanceToStopPct": 0.13,       // 100 * (distanceToStopDollar / close)
  "distanceToT1Dollar": 0.43,      // T1 - close (LONG) or close - T1 (SHORT)
  "distanceToT1Pct": 0.09,         // 100 * (distanceToT1Dollar / close)
  "distanceToT2Dollar": 0.87,
  "distanceToT2Pct": 0.17,
  "distanceToT3Dollar": 1.31,
  "distanceToT3Pct": 0.26,
  
  // Status booleans (computed in code)
  "stopThreatened": false,         // within 0.25R of stop (warning only)
  "targetHit": null,               // "T1" | "T2" | "T3" | null (close-based)
  "nearTarget": "T1",              // "T1" | "T2" | "T3" | null (within $0.03)
  "profitPercent": 0.00            // 100 * (close - entry) / entry (LONG)
}
```

---

## Inputs Always Provided

✅ **Raw price inputs**:
- `close` - latest 1m candle close price
- `entry` - actual entry fill price
- `stop` - stop price
- `t1`, `t2`, `t3` - target prices

---

## Metrics Computed Deterministically

All metrics are computed in `StopProfitRules.getContext()` using exact formulas:

### Distance Metrics
- ✅ `distanceToStopDollar` - Dollar distance to stop
- ✅ `distanceToStopPct` - Percent distance to stop (using close as denominator)
- ✅ `distanceToT1Dollar`, `distanceToT1Pct` - Distance to T1
- ✅ `distanceToT2Dollar`, `distanceToT2Pct` - Distance to T2
- ✅ `distanceToT3Dollar`, `distanceToT3Pct` - Distance to T3

### Risk/Reward Metrics
- ✅ `risk` - |entry - stop| per share
- ✅ `rewardT1`, `rewardT2`, `rewardT3` - Reward to each target per share
- ✅ `rr_t1`, `rr_t2`, `rr_t3` - R-multiples to each target

### Status Metrics
- ✅ `profitPercent` - Profit percentage (if entered)
- ✅ `stopThreatened` - Boolean (within 0.25R of stop, warning only)
- ✅ `targetHit` - "T1" | "T2" | "T3" | null (close-based)
- ✅ `nearTarget` - "T1" | "T2" | "T3" | null (within $0.03)

---

## LLM Prompt Structure

The LLM receives:

1. **Structured JSON** with all computed metrics (shown above)
2. **Rules explanation** (in words, but referencing the JSON values)
3. **Coaching request** (what action to recommend)

**Key instruction to LLM**:
> "CRITICAL: All numbers below are computed deterministically in code. You MUST NOT calculate any metrics yourself - use the provided exact values."

---

## Verification

✅ **No calculation drift** - LLM never calculates, only reasons
✅ **No hallucinated numbers** - All values come from code
✅ **Consistent decisions** - Same inputs always produce same metrics
✅ **Real tangible numbers** - All values are computed deterministically

---

## Example LLM Call

```typescript
const rulesContext = stopProfitRules.getContext(play, close, entryPrice);

const llmResponse = await llmService.getCoachingUpdate({
  symbol: "SPY",
  direction: "LONG",
  entryPrice: 504.70,
  currentPrice: 504.71,
  stop: 504.06,
  targets: { t1: 505.14, t2: 505.58, t3: 506.02 },
  timeInTrade: 15,
  priceAction: "Price consolidating",
  rulesContext: {
    // All metrics computed in code
    risk: 0.64,
    rewardT1: 0.44,
    rr_t1: 0.69,
    distanceToStopDollar: 0.65,
    distanceToStopPct: 0.13,
    stopThreatened: false,
    // ... etc
  }
});
```

---

## Implementation Files

- `src/rules/stopProfitRules.ts` - Computes all metrics deterministically
- `src/orchestrator/orchestrator.ts` - Passes computed metrics to LLM
- `src/llm/llmService.ts` - Formats structured JSON for LLM prompt
