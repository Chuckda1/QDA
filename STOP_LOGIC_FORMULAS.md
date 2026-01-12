# Stop Loss Logic - Exact Formulas (SPY ETF)

## ✅ Implemented Formulas

All calculations are **100% mechanical and verifiable** for SPY ETF.

---

## 1) Stop Loss Only On Close (Hard Rule)

### LONG
```
STOP_HIT = (close <= stop)
```
- ✅ Only candle close matters
- ✅ Wicks below stop do NOT trigger exit
- ✅ Implemented in `StopProfitRules.isStopHitOnClose()`

### SHORT
```
STOP_HIT = (close >= stop)
```
- ✅ Only candle close matters
- ✅ Wicks above stop do NOT trigger exit

---

## 2) Stop Threatened (Warning Only)

Uses **Option B: R-based threshold** (scales across different stop sizes).

### Parameters
- `threatR = 0.25` (stop threatened within 0.25R of stop)
- `risk = |entry - stop|`

### LONG
```
stopThreatened = close <= stop + threatR * risk
```

### SHORT
```
stopThreatened = close >= stop - threatR * risk
```

**Note**: This is a **warning only**, not an exit trigger. LLM decision is final.

---

## 3) Dollar Distances (Exact Formulas)

### LONG
```
dStop = close - stop
dT1 = T1 - close
dT2 = T2 - close
dT3 = T3 - close
```

### SHORT
```
dStop = stop - close
dT1 = close - T1
dT2 = close - T2
dT3 = close - T3
```

---

## 4) Percent Distances (Exact Formula)

**Formula**: `pct(x) = 100 * (x / close)`

### Examples
```
dStopPct = 100 * (dStop / close)
dT1Pct = 100 * (dT1 / close)
```

**Note**: Uses `close` as denominator (not entry), as specified.

---

## 5) Risk (Exact Formula)

```
risk = |entry - stop|
```

- Non-negotiable
- Per share basis
- Always positive (absolute value)

---

## 6) Reward (Exact Formulas)

### LONG
```
reward_T1 = T1 - entry
reward_T2 = T2 - entry
reward_T3 = T3 - entry
```

### SHORT
```
reward_T1 = entry - T1
reward_T2 = entry - T2
reward_T3 = entry - T3
```

---

## 7) R-Multiple (Exact Formula)

```
R_T1 = reward_T1 / risk
R_T2 = reward_T2 / risk
R_T3 = reward_T3 / risk
```

---

## 8) Profit Percent (If Entered)

### LONG
```
profitPct = 100 * (close - entry) / entry
```

### SHORT
```
profitPct = 100 * (entry - close) / entry
```

---

## 9) Target Hit (Close-Based)

### LONG
```
T1Hit = (close >= T1)
T2Hit = (close >= T2)
T3Hit = (close >= T3)
```

### SHORT
```
T1Hit = (close <= T1)
T2Hit = (close <= T2)
T3Hit = (close <= T3)
```

**Note**: Consistent with close-based stop logic (not wick-based).

---

## 10) Near Target (Optional)

Uses dollar threshold: `nearDollar = 0.03`

### LONG
```
nearT1 = close >= T1 - nearDollar
```

### SHORT
```
nearT1 = close <= T1 + nearDollar
```

---

## 11) Hard Stop Bypasses LLM

**Implementation**:
```typescript
if (stopHitOnClose) {
  emit("STOP_HIT");
  closePlay();
  return; // bypass LLM entirely
}
```

LLM can never veto or delay hard stop on close.

---

## Verification Checklist

Run `npm run test:stop` to verify all formulas against test cases:

1. ✅ **Wick does NOT stop you out** - Only close matters
2. ✅ **Close triggers stop** - When close crosses stop
3. ✅ **Stop threatened triggers warning only** - Within 0.25R, no exit
4. ✅ **All distances calculated correctly** - Dollar and percent
5. ✅ **Risk/Reward/R-multiples correct** - Exact formulas
6. ✅ **Target hit detection** - Close-based only

---

## Current Implementation

All formulas are implemented in:
- `src/rules/stopProfitRules.ts` - Main calculation logic
- `src/orchestrator/orchestrator.ts` - Uses rules context
- `scripts/verifyStopLogic.ts` - Verification tests

---

## Stop Selection

Currently uses `play.stop` directly. If you have a `stopZone {low, high}`, ensure:
- **LONG**: `stop = stopZone.low` (stop must be below entry)
- **SHORT**: `stop = stopZone.high` (stop must be above entry)

The `validateStop()` method checks this constraint.
