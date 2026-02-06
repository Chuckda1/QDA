# Current Entry Evaluation Logic Summary

## Current Setup Support in Entry Evaluation

**Location:** `src/orchestrator/orchestrator.ts` lines ~4067-4085

### Supported Setups:
1. **PULLBACK_CONTINUATION** (existing)
   - Uses 5m-based entry signal
   - Signal: `entrySignalFires` = bearish/bullish bar OR lower low/higher high
   
2. **IGNITION** (newly added)
   - Uses 1m-based trigger break
   - Signal: `ignitionSignal` = price breaks `setupTriggerPrice`

### Current Entry Signal Logic:

```typescript
// Entry signal for pullback continuation (5m-based)
const entrySignalFires =
  (exec.bias === "BULLISH" && (isBearish || (previous5m && lowerLow))) ||
  (exec.bias === "BEARISH" && (isBullish || (previous5m && higherHigh)));

// Ignition signal (1m-based, immediate after flip)
const ignitionSignal =
  exec.setup === "IGNITION" &&
  exec.setupTriggerPrice !== undefined &&
  ((exec.bias === "BULLISH" && close > exec.setupTriggerPrice) ||
   (exec.bias === "BEARISH" && close < exec.setupTriggerPrice));

// Entry permission
const isPullback = exec.setup === "PULLBACK_CONTINUATION";
const isIgnition = exec.setup === "IGNITION";
const canEnter = 
  (isPullback && entrySignalFires) ||
  (isIgnition && ignitionSignal);
```

### Current EntryType Support:
- `REJECTION_ENTRY`
- `BREAKDOWN_ENTRY`
- `REENTRY_AFTER_CONTINUATION`
- `BIAS_FLIP_ENTRY`
- `PULLBACK_ENTRY` (default fallback)

**Missing:** `IGNITION_ENTRY`

---

## What Needs to Be Added:

1. Add `IGNITION_ENTRY` to `EntryType`
2. Set `entryType = "IGNITION_ENTRY"` when IGNITION setup fires
3. Enhance Telegram formatter to show actionable IGNITION info:
   - Window time remaining
   - Trigger price
   - Invalidation/stop price
   - Reason (acceptance counters, distance)
