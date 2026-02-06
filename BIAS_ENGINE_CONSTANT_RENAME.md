# Bias Engine Constant Rename

## Rename: `BIAS_ENGINE_FINALIZE_EXTRA` → `BIAS_ENGINE_REPAIR_CONFIRM_MIN`

**Reason:** Better semantic clarity - it's a confirmation period, not "extra" time.

---

## Updated Constant Definition

**File:** `src/orchestrator/orchestrator.ts` (class-level)

```typescript
export class Orchestrator {
  // ... existing constants ...
  
  // Bias Engine constants
  private readonly BIAS_ENGINE_ENTER_ACCEPT = 6;  // Minutes to enter regime
  private readonly BIAS_ENGINE_EXIT_ACCEPT = 3;  // Minutes to exit regime (hysteresis)
  private readonly BIAS_ENGINE_REPAIR_CONFIRM_MIN = 2;  // Minimum minutes in REPAIR before finalizing (confirmation period)
  private readonly BIAS_ENGINE_COOLDOWN_MS = 5 * 60 * 1000;  // 5 minutes cooldown between full flips
  
  // ... rest of class ...
}
```

---

## Usage in `updateBiasEngine()`

**File:** `src/orchestrator/orchestrator.ts` (in `updateBiasEngine()`)

**In the REPAIR state machine logic:**

```typescript
case "REPAIR_BULL": {
  // Track persistence while repairing
  if (bullAccept) be.acceptBullCount += 1;
  else be.acceptBullCount = 0;

  // If opposite exit evidence appears, repair failed
  if (bullExitEvidence) {
    // ... revert logic
    break;
  }

  // Finalize after enough time in repair (confirmation period)
  const repairAgeMs = be.repairStartTs ? (ts - be.repairStartTs) : 0;
  const enoughTime = repairAgeMs >= this.BIAS_ENGINE_REPAIR_CONFIRM_MIN * 60 * 1000;  // ✅ Updated

  if (bullAccept && enoughTime && !inCooldown) {
    finalizeFlip("BULLISH", "BULLISH");
  } else {
    exec.bias = "NEUTRAL";
  }
  break;
}

case "REPAIR_BEAR": {
  if (bearAccept) be.acceptBearCount += 1;
  else be.acceptBearCount = 0;

  if (bearExitEvidence) {
    // ... revert logic
    break;
  }

  const repairAgeMs = be.repairStartTs ? (ts - be.repairStartTs) : 0;
  const enoughTime = repairAgeMs >= this.BIAS_ENGINE_REPAIR_CONFIRM_MIN * 60 * 1000;  // ✅ Updated

  if (bearAccept && enoughTime && !inCooldown) {
    finalizeFlip("BEARISH", "BEARISH");
  } else {
    exec.bias = "NEUTRAL";
  }
  break;
}
```

---

## Summary

✅ **Old name:** `BIAS_ENGINE_FINALIZE_EXTRA`  
✅ **New name:** `BIAS_ENGINE_REPAIR_CONFIRM_MIN`  
✅ **Semantic improvement:** "confirmation period" is clearer than "extra time"  
✅ **Usage:** Used in REPAIR state machine to check if enough confirmation time has passed before finalizing flip

All documentation files have been updated with the new name.
