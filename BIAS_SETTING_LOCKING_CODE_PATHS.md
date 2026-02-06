# Bias Setting/Locking Code Paths

## 1. execBias Assignment (Primary Location)

### File: `src/orchestrator/orchestrator.ts`
### Function: `reduce5mClose()` - STEP 1
### Lines: 2430-2476

```typescript
// ============================================================================
// STEP 1: Apply bias from LLM (if available)
// ============================================================================
if (llmDecision !== null) {
  const llmDirection: "long" | "short" | "none" = 
    llmDecision.action === "ARM_LONG" ? "long" :
    llmDecision.action === "ARM_SHORT" ? "short" :
    llmDecision.action === "A+" ? (llmDecision.bias === "bearish" ? "short" : "long") : "none";
  
  const newBias = this.llmActionToBias(llmDecision.action as "ARM_LONG" | "ARM_SHORT" | "WAIT" | "A+", llmDecision.bias as "bullish" | "bearish" | "neutral");
  console.log(
    `[LLM_BIAS_MAP] action=${llmDecision.action} llmBias=${llmDecision.bias} -> execBias=${newBias}`
  );
  const shouldFlip = this.shouldFlipBias(
    exec.bias,
    newBias,
    exec.biasInvalidationLevel,
    close
  );

  if (shouldFlip || exec.bias === "NEUTRAL") {
    // Deactivate gate if bias flips
    if (exec.bias !== newBias && exec.bias !== "NEUTRAL") {
      this.deactivateGate(exec);
    }
    exec.bias = newBias;  // ← PRIMARY ASSIGNMENT
    exec.baseBiasConfidence = llmDecision.confidence;
    exec.biasPrice = close;  // ← Sets biasPrice (used for "bias established" ref)
    exec.biasTs = ts;
    if (exec.activeCandidate) {
      exec.biasInvalidationLevel = exec.activeCandidate.invalidationLevel;
    }
    exec.biasConfidence = this.calculateDerivedConfidence(exec, close, closed5mBars, ts);
    shouldPublishEvent = true;
  }

  // Legacy compatibility
  exec.thesisDirection = exec.bias === "BULLISH" ? "long" : exec.bias === "BEARISH" ? "short" : "none";
  if (exec.bias !== "NEUTRAL") {
    exec.biasConfidence = this.calculateDerivedConfidence(exec, close, closed5mBars, ts);
    exec.thesisConfidence = exec.biasConfidence;
  }

  console.log(
    `[LLM5M] action=${llmDecision.action} bias=${exec.bias} baseConf=${exec.baseBiasConfidence ?? llmDecision.confidence} derivedConf=${exec.biasConfidence ?? "n/a"}`
  );
}
```

### Helper: `llmActionToBias()` - Converts LLM action to MarketBias
### Lines: 1580-1590

```typescript
private llmActionToBias(action: "ARM_LONG" | "ARM_SHORT" | "WAIT" | "A+", llmBias: "bullish" | "bearish" | "neutral"): "BEARISH" | "BULLISH" | "NEUTRAL" {
  if (action === "ARM_LONG" || (action === "A+" && llmBias === "bullish")) {
    return "BULLISH";
  } else if (action === "ARM_SHORT" || (action === "A+" && llmBias === "bearish")) {
    return "BEARISH";
  } else if (action === "WAIT") {
    // WAIT action: use llmBias directly (LLM can output WAIT with directional bias)
    return this.normalizeBias(llmBias);
  }
  return "NEUTRAL";
}
```

### Helper: `shouldFlipBias()` - Determines if bias should flip
### Lines: 1593-1610

```typescript
// Check if bias should flip (only on structural invalidation)
private shouldFlipBias(currentBias: MarketBias, newBias: MarketBias, invalidationLevel?: number, currentPrice?: number): boolean {
  if (currentBias === newBias || newBias === "NEUTRAL") {
    return false; // No flip needed
  }
  
  // Bias only flips if price crosses invalidation level
  if (invalidationLevel !== undefined && currentPrice !== undefined) {
    if (currentBias === "BULLISH" && currentPrice < invalidationLevel) {
      return true; // Bullish bias invalidated
    }
    if (currentBias === "BEARISH" && currentPrice > invalidationLevel) {
      return true; // Bearish bias invalidated
    }
  }
  
  // If no invalidation level set, allow flip (initial bias establishment)
  return invalidationLevel === undefined;
}
```

---

## 2. Phase Transitions (BIAS_ESTABLISHED → ...)

### File: `src/orchestrator/orchestrator.ts`
### Function: `reduce5mClose()` - STEP 2
### Lines: 2478-2518

```typescript
// ============================================================================
// STEP 2: Update phase deterministically (engine-owned, never from LLM)
// ============================================================================
// Phase transitions are based on bias, confidence, and market structure
// LLM never sets phase directly
if (exec.bias !== "NEUTRAL" && exec.biasConfidence !== undefined && exec.biasConfidence >= 65) {
  // Bias is established with sufficient confidence
  if (exec.phase === "NEUTRAL_PHASE") {
    exec.phase = "BIAS_ESTABLISHED";  // ← NEUTRAL_PHASE → BIAS_ESTABLISHED
    exec.expectedResolution = "CONTINUATION";
    exec.waitReason = "waiting_for_pullback";
    shouldPublishEvent = true;
    console.log(
      `[PHASE_TRANSITION] ${previousPhase} -> BIAS_ESTABLISHED | BIAS=${exec.bias} confidence=${exec.biasConfidence}`
    );
  } else if (exec.phase === "BIAS_ESTABLISHED" && lastClosed5m) {
    // Check if pullback is developing
    const current5m = forming5mBar ?? lastClosed5m;
    if (exec.pullbackHigh !== undefined && exec.pullbackLow !== undefined) {
      const inPullback = (exec.bias === "BEARISH" && current5m.close < exec.pullbackHigh) ||
                       (exec.bias === "BULLISH" && current5m.close > exec.pullbackLow);
      if (inPullback) {
        exec.phase = "PULLBACK_IN_PROGRESS";  // ← BIAS_ESTABLISHED → PULLBACK_IN_PROGRESS
        exec.expectedResolution = "CONTINUATION";
        shouldPublishEvent = true;
        console.log(
          `[PHASE_TRANSITION] ${previousPhase} -> PULLBACK_IN_PROGRESS | BIAS=${exec.bias}`
        );
      }
    }
  }
} else if (exec.bias === "NEUTRAL") {
  if (exec.phase !== "NEUTRAL_PHASE") {
    exec.phase = "NEUTRAL_PHASE";  // ← Any phase → NEUTRAL_PHASE (when bias becomes NEUTRAL)
    exec.waitReason = "waiting_for_bias";
    shouldPublishEvent = true;
    console.log(
      `[PHASE_TRANSITION] ${previousPhase} -> NEUTRAL_PHASE | BIAS=NEUTRAL`
    );
  }
}
```

**Key Conditions:**
- `BIAS_ESTABLISHED` requires: `bias !== "NEUTRAL"` AND `biasConfidence >= 65`
- `PULLBACK_IN_PROGRESS` requires: `phase === "BIAS_ESTABLISHED"` AND price in pullback zone
- `NEUTRAL_PHASE` when: `bias === "NEUTRAL"`

---

## 3. ref / "bias established" Logic

### File: `src/orchestrator/orchestrator.ts`
### Function: `handleMinimal1m()` - Reference price determination
### Lines: 4082-4118

```typescript
// Determine reference price and label based on phase/state
let refPrice: number | undefined = undefined;
let refLabel: string | undefined = undefined;

if (exec.phase === "IN_TRADE" && exec.entryPrice !== undefined) {
  refPrice = exec.entryPrice;
  refLabel = "entry";
} else if (exec.phase === "PULLBACK_IN_PROGRESS" || exec.phase === "CONTINUATION_IN_PROGRESS" || exec.phase === "REENTRY_WINDOW") {
  if (exec.bias === "BEARISH" && exec.pullbackHigh !== undefined) {
    refPrice = exec.pullbackHigh;
    if (exec.phase === "CONTINUATION_IN_PROGRESS") {
      refLabel = "pullback high (continuation)";
    } else if (exec.phase === "REENTRY_WINDOW") {
      refLabel = "pullback high (re-entry window)";
    } else {
      refLabel = "pullback high";
    }
  } else if (exec.bias === "BULLISH" && exec.pullbackLow !== undefined) {
    refPrice = exec.pullbackLow;
    if (exec.phase === "CONTINUATION_IN_PROGRESS") {
      refLabel = "pullback low (continuation)";
    } else if (exec.phase === "REENTRY_WINDOW") {
      refLabel = "pullback low (re-entry window)";
    } else {
      refLabel = "pullback low";
    }
  } else if (exec.biasPrice !== undefined) {
    refPrice = exec.biasPrice;  // ← "bias established" ref
    refLabel = "bias established";
  }
} else if (exec.biasPrice !== undefined) {
  refPrice = exec.biasPrice;  // ← "bias established" ref (fallback)
  refLabel = "bias established";
} else if (exec.thesisPrice !== undefined) {
  refPrice = exec.thesisPrice;  // ← Legacy "bias established" ref
  refLabel = "bias established";
}
```

**Where `biasPrice` is set:**
- Line 2457: `exec.biasPrice = close;` (when bias is applied in `reduce5mClose()`)

---

## 4. lockedBias, biasLatched, cooldown, minHold, ttl, oppLatched

### 4a. Bias Flip Cooldown & TTL

### File: `src/orchestrator/orchestrator.ts`
### Constants: Lines 77-80

```typescript
// BiasFlipEntry constants
private readonly BIAS_FLIP_MIN_CONF = 60;
private readonly BIAS_FLIP_TTL_MS = 12 * 60 * 1000;       // 12 minutes
private readonly BIAS_FLIP_COOLDOWN_MS = 10 * 60 * 1000;  // 10 minutes
private readonly BIAS_FLIP_MIN_RANGE_ATR = 0.20;          // avoid micro candles
```

### Function: `maybeArmBiasFlipGate()` - Bias flip gating with cooldown
### Lines: 1307-1393

```typescript
private maybeArmBiasFlipGate(
  exec: MinimalExecutionState,
  prevBias: MarketBias,
  closed5m: { ts: number; open: number; high: number; low: number; close: number; volume: number },
  atr: number,
  vwap: number | undefined,
  ts: number
): void {
  // Don't arm if already in trade
  if (exec.phase === "IN_TRADE") return;

  // Must be a flip
  if (!this.didBiasFlip(prevBias, exec.bias)) return;

  // Confidence gate
  if ((exec.biasConfidence ?? 0) < this.BIAS_FLIP_MIN_CONF) {
    console.log(
      `[BIAS_FLIP_BLOCKED] reason=conf_too_low conf=${exec.biasConfidence ?? 0} prev=${prevBias} next=${exec.bias}`
    );
    return;
  }

  // Cooldown to avoid flip-flop spam
  if (exec.lastBiasFlipArmTs && (ts - exec.lastBiasFlipArmTs) < this.BIAS_FLIP_COOLDOWN_MS) {
    const dtMs = ts - exec.lastBiasFlipArmTs;
    console.log(
      `[BIAS_FLIP_BLOCKED] reason=cooldown dtMs=${dtMs} cooldownMs=${this.BIAS_FLIP_COOLDOWN_MS}`
    );
    return;
  }

  // ... (other checks: ATR, range, VWAP distance)

  exec.biasFlipGate = {
    state: "ARMED",
    direction: dir,
    armedAtTs: closed5m.ts,
    expiresAtTs: closed5m.ts + this.BIAS_FLIP_TTL_MS,  // ← TTL: 12 minutes
    trigger,
    stop,
    basis5m: { ... },
    conf: exec.biasConfidence ?? 0,
    reason: "bias_flip",
  };

  exec.lastBiasFlipArmTs = ts;  // ← Cooldown tracking
}
```

### 4b. Setup TTL

### File: `src/orchestrator/orchestrator.ts`
### Function: `reduce5mClose()` - STEP 3
### Lines: 2520-2594

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
    exec.setup = "NONE";
    // ... clear setup fields
  } else {
    // Setup persists - skip re-detection
    console.log(
      `[SETUP_PERSISTS] ${exec.setup} | TTL valid until ${new Date(setupTTLExpiry).toISOString()}`
    );
  }
}
```

### 4c. oppLatched (Opportunity Latch)

### File: `src/orchestrator/orchestrator.ts`
### Function: `ensureOpportunityLatch()` - Automatic opportunity latching
### Lines: 1051-1139

```typescript
private ensureOpportunityLatch(
  exec: MinimalExecutionState,
  ts: number,
  close: number,
  atr: number
): boolean {
  // Don't relatch if existing opportunity is still valid (LATCHED or TRIGGERED)
  if (exec.opportunity && 
      (exec.opportunity.status === "LATCHED" || exec.opportunity.status === "TRIGGERED") &&
      ts < exec.opportunity.expiresAtTs) {
    return false; // Already latched and valid
  }

  // Only latch if bias is established and phase allows
  if (exec.bias === "NEUTRAL" || exec.phase === "NEUTRAL_PHASE") {
    return false;
  }

  // ... (latch creation logic)

  exec.opportunity = {
    side: exec.bias === "BULLISH" ? "LONG" : "SHORT",
    status: "LATCHED",  // ← oppLatched
    latchedAtTs: ts,  // ← oppLatchedAt timestamp
    expiresAtTs: expiresAtTs,
    // ... (other fields)
  };

  return true; // Latch was created
}
```

### Called from: `reduce5mClose()` - STEP 4
### Lines: 2636-2649

```typescript
// ============================================================================
// OPPORTUNITYLATCH: Make optional/automatic when bias is established
// ============================================================================
const latchCreated = this.ensureOpportunityLatch(exec, ts, close, atr);
if (latchCreated) {
  shouldPublishEvent = true;
  console.log(
    `[OPP_LATCHED_EVENT] Forcing state snapshot after opportunity latch - bias=${exec.bias} phase=${exec.phase}`
  );
}
```

### Type Definition: `src/types.ts`
### Lines: 125, 185

```typescript
oppLatchedAt?: number; // Timestamp when opportunity was latched

export type OpportunityStatus = "INACTIVE" | "LATCHED" | "TRIGGERED" | "INVALIDATED" | "EXPIRED" | "CONSUMED";
```

---

## 5. The 5m-Close Gate: callingLLM=true and Bias Update Permissions

### 5a. Where callingLLM=true is Decided

### File: `src/orchestrator/orchestrator.ts`
### Function: `handleMinimal1m()`
### Lines: 3050-3111

```typescript
// Explicit guard: LLM is ONLY called on 5m bar closes
if (!is5mClose) {
  // LLM is NOT called on 1m ticks or forming bars - this prevents request storms
  // All processing continues normally, just without LLM input
} else if (this.llmService && closed5mBars.length >= this.minimalLlmBars) {
  // ============================================================================
  // RULE 3: LLM errors must be NON-FATAL (graceful degradation)
  // ============================================================================
  // Circuit breaker: if too many failures, skip LLM calls temporarily
  const circuitBreakerCooldown = 60 * 1000; // 1 minute cooldown
  const maxFailures = 3;
  
  if (this.llmCircuitBreaker.isOpen) {
    // ... (circuit breaker logic)
  }
  
  if (!this.llmCircuitBreaker.isOpen) {
    // Build daily context
    const currentETDate = getETDateString(new Date(ts));
    const exec = this.state.minimalExecution;
    const dailyContextLite = this.buildDailyContextLite(exec, closed5mBars, currentETDate);
    
    // ... (build LLM snapshot)

    console.log(
      `[LLM5M] bufferClosed5m=${closed5mBars.length} snapshotClosed5m=${snapshotBars.length} callingLLM=true (5m close detected) barsWindow=60 dailyContext=${dailyContextLite ? "yes" : "no"}${justClosedBar ? " [JUST_CLOSED_INCLUDED]" : ""}`
    );
    
    try {
      const result = await this.llmService.getArmDecisionRaw5m({
        snapshot: llmSnapshot,
      });
      llmDecision = result.decision;
      // ... (store result, reset circuit breaker)
    } catch (error: any) {
      // ... (circuit breaker on error)
    }
  }
}
```

**Key Guards:**
1. `is5mClose === true` (only on 5m bar closes)
2. `this.llmService` exists
3. `closed5mBars.length >= this.minimalLlmBars` (default: 5 bars)
4. Circuit breaker not open (max 3 failures, 1-minute cooldown)

### 5b. Who Can Update Bias vs Only Setup/Entry

### File: `src/orchestrator/orchestrator.ts`
### Function: `reduce5mClose()` - The Authoritative Reducer
### Lines: 2405-2424

```typescript
// ============================================================================
// SINGLE AUTHORITATIVE 5M CLOSE REDUCER
// ============================================================================
// This function runs in strict order on every 5m close:
// 1. Apply bias from LLM (if available)
// 2. Update phase deterministically (engine-owned, never from LLM)
// 3. Run setup detection (closed bars only)
// 4. Update gate (disarm if setup is NONE, arm if setup exists)
// 5. Check consistency
// 6. Generate diagnostics
// ============================================================================
private reduce5mClose(
  exec: MinimalExecutionState,
  ts: number,
  close: number,
  closed5mBars: Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }>,
  lastClosed5m: { ts: number; open: number; high: number; low: number; close: number; volume: number } | null,
  forming5mBar: Forming5mBar | null,
  llmDecision: { action: string; bias: string; confidence: number; maturity?: string; waiting_for?: string } | null
): { shouldPublishEvent: boolean; noTradeReason?: string } {
```

**Bias Update Rules:**
- **ONLY LLM can update bias** (via `llmDecision` parameter)
- Bias is applied in STEP 1 (lines 2430-2476)
- **1m handler (`handleMinimal1m`) CANNOT update bias** - it only:
  - Updates opportunity status (LATCHED → TRIGGERED)
  - Detects entry signals
  - Updates setup persistence (rejection bars elapsed)
  - Does NOT call `reduce5mClose()` (only called on 5m close)

**Setup/Entry Update Rules:**
- **Setup detection** runs in STEP 3 (lines 2520-2594) - only on 5m close
- **Entry logic** runs in `handleMinimal1m()` (lines 3271+) - on every 1m tick
- **Opportunity latch** runs in STEP 4 (lines 2636-2649) - only on 5m close
- **Gate arming** runs in STEP 5 (lines 2651-2699) - only on 5m close

### 5c. Entry Logic (1m Handler) - Cannot Update Bias

### File: `src/orchestrator/orchestrator.ts`
### Function: `handleMinimal1m()` - Entry evaluation
### Lines: 3271-3300

```typescript
// Entry logic only runs if:
// 1. Bias is not NEUTRAL
// 2. Phase allows entry (PULLBACK_IN_PROGRESS or BIAS_ESTABLISHED)
// 3. Current 5m bar exists
if (exec.bias !== "NEUTRAL" && (exec.phase === "PULLBACK_IN_PROGRESS" || exec.phase === "BIAS_ESTABLISHED")) {
  const current5m = this.getCurrent5mBar(closed5mBars, forming5mBar);
  
  if (current5m) {
    // Entry evaluation logic here
    // CANNOT update bias - only reads exec.bias
    // CAN update: opportunity status, entry signals, waitReason
  }
}
```

**Summary:**
- **Bias updates:** ONLY in `reduce5mClose()` STEP 1, ONLY from LLM, ONLY on 5m close
- **Setup updates:** ONLY in `reduce5mClose()` STEP 3, ONLY on 5m close
- **Entry evaluation:** In `handleMinimal1m()`, on every 1m tick, but CANNOT update bias

---

## Summary Table

| Concept | Location | When | Who Can Update |
|---------|----------|------|----------------|
| **exec.bias** | `reduce5mClose()` STEP 1 (line 2455) | 5m close only | LLM only (via `llmDecision`) |
| **Phase transition** | `reduce5mClose()` STEP 2 (lines 2483-2518) | 5m close only | Engine (deterministic, never from LLM) |
| **biasPrice** | `reduce5mClose()` STEP 1 (line 2457) | When bias is applied | LLM only |
| **ref "bias established"** | `handleMinimal1m()` (lines 4108-4114) | Every 1m tick | Read-only (uses `exec.biasPrice`) |
| **Bias flip cooldown** | `maybeArmBiasFlipGate()` (line 1330) | 5m close, on bias flip | Engine (10 min cooldown) |
| **Bias flip TTL** | `maybeArmBiasFlipGate()` (line 1373) | 5m close, on bias flip | Engine (12 min TTL) |
| **Setup TTL** | `reduce5mClose()` STEP 3 (line 2523) | 5m close only | Engine (10 min TTL) |
| **oppLatched** | `ensureOpportunityLatch()` (line 1051) | 5m close only | Engine (automatic when bias established) |
| **callingLLM=true** | `handleMinimal1m()` (line 3054) | 5m close only | Engine (guards: is5mClose, min bars, circuit breaker) |

---

## Key Invariants

1. **Bias is sticky:** Only flips on structural invalidation (price crosses `biasInvalidationLevel`)
2. **Phase is engine-owned:** LLM never sets phase directly
3. **Bias updates are exclusive:** Only `reduce5mClose()` STEP 1 can update `exec.bias`
4. **5m close is authoritative:** All bias/setup/gate updates happen on 5m close
5. **1m handler is read-only for bias:** Can only read `exec.bias`, cannot modify it
