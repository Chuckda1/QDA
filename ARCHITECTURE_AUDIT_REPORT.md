# Architecture Audit Report: Over-Containment Analysis
## Why the New Bot Misses Trades the Old Bot Would Have Fired

**Date:** 2024-12-19  
**Context:** New bot has richer architecture (Bias, Phase, Setup, Gate) but misses trades that old simpler bot would have captured.  
**Objective:** Identify over-containment, split-brain ownership, and gating order issues.

---

## 1) How the Old Bot Likely Worked (Inferred from Code)

### Minimum Entry Conditions (Old Bot)

Based on `src/utils/swing.ts` functions `entrySignalUptrend()` and `entrySignalDowntrend()`, the old bot used a **minimal 3-condition check**:

```
OLD BOT ENTRY LOGIC:
1. Direction (LONG or SHORT) - from trend/structure
2. Pullback detection:
   - LONG: price near support (forming.low <= lastSwingLow * 1.001)
   - SHORT: price near resistance (forming.high >= lastSwingHigh * 0.999)
3. Trigger signal:
   - LONG: strong bullish candle (body/range >= 0.5) at support
   - SHORT: strong bearish candle (body/range >= 0.5) at resistance

IF (nearSupport && strongCandle) → ENTER
IF (nearResistance && strongCandle) → ENTER
```

**Key Characteristics:**
- **No setup taxonomy** - just "pullback + strong candle"
- **No phase maturity** - no BIAS_ESTABLISHED → PULLBACK_IN_PROGRESS transitions
- **No multi-confirmation** - no EMA/VWAP reclaim checks, no volume tiers
- **No gate system** - direct entry on signal
- **No confidence thresholds** - direction was binary (trend exists or doesn't)
- **Forming bar allowed** - could enter on current forming candle

**What it DIDN'T require:**
- ❌ Setup type (REJECTION, BREAKDOWN, etc.)
- ❌ Phase state machine (BIAS_ESTABLISHED, PULLBACK_IN_PROGRESS)
- ❌ ExpectedResolution (CONTINUATION, FAILURE)
- ❌ ResolutionGate (ARMED, TRIGGERED)
- ❌ Bias confidence >= 65
- ❌ Pullback levels to be pre-defined
- ❌ Closed bars only (could use forming bar)

**Entry was essentially:** `direction + pullback + trigger` → **immediate entry**

---

## 2) Current Bot Decision Chain (Step-by-Step Flow)

### ASCII Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. TICK INGESTION (handleMinimal1m)                           │
│    ├─ Out-of-order check (stale tick → ignore)                 │
│    ├─ Market hours check (isRTH → continue, else return)        │
│    └─ Forming 5m bar update                                     │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. 5M CLOSE DETECTION                                           │
│    └─ is5mClose = (previousBucketStart !== formingBucketStart)  │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼ (if is5mClose)
┌─────────────────────────────────────────────────────────────────┐
│ 3. LLM CALL (if circuit breaker OK)                            │
│    ├─ Build snapshot (60 closed bars + dailyContextLite)       │
│    ├─ Call llmService.getArmDecisionRaw5m()                    │
│    └─ Parse decision: { action, bias, confidence, maturity }   │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. REDUCE5MCLOSE (Single Authoritative Reducer)                │
│    │                                                             │
│    ├─ STEP 1: Apply Bias from LLM                              │
│    │   ├─ llmActionToBias(action, bias) → newBias              │
│    │   ├─ shouldFlipBias() check                               │
│    │   ├─ If flip: exec.bias = newBias                         │
│    │   ├─ exec.baseBiasConfidence = decision.confidence        │
│    │   └─ calculateDerivedConfidence() → exec.biasConfidence   │
│    │                                                             │
│    ├─ STEP 2: Update Phase (Engine-Owned)                       │
│    │   ├─ IF bias != NEUTRAL && confidence >= 65:              │
│    │   │   ├─ IF phase == NEUTRAL_PHASE:                       │
│    │   │   │   └─ phase = BIAS_ESTABLISHED                     │
│    │   │   └─ IF phase == BIAS_ESTABLISHED:                    │
│    │   │       └─ IF pullbackHigh/Low exist && inPullback:      │
│    │   │           └─ phase = PULLBACK_IN_PROGRESS              │
│    │   └─ IF bias == NEUTRAL:                                   │
│    │       └─ phase = NEUTRAL_PHASE                             │
│    │                                                             │
│    ├─ STEP 3: Setup Detection (Closed Bars Only)                │
│    │   ├─ Check setup TTL (2 bars = 10 min)                     │
│    │   ├─ IF setup exists && TTL valid:                        │
│    │   │   └─ Check invalidation (price breaks stop)           │
│    │   └─ IF setup == NONE || TTL expired:                     │
│    │       ├─ detectSetup(exec, lastClosed5m, previous5m, ...) │
│    │       │   Priority: BREAKDOWN > EARLY_REJECTION >          │
│    │       │            REJECTION > COMPRESSION > FAILED_BOUNCE │
│    │       └─ exec.setup = result.setup                        │
│    │                                                             │
│    ├─ STEP 4: Gate Management                                   │
│    │   ├─ IF setup == NONE:                                     │
│    │   │   └─ deactivateGate() (disarm)                        │
│    │   └─ IF setup != NONE && expectedResolution == CONTINUATION│
│    │       && pullbackHigh/Low exist:                           │
│    │       └─ armResolutionGate()                               │
│    │                                                             │
│    ├─ STEP 5: Consistency Checks                                │
│    │   ├─ Check: bias != NEUTRAL && phase == NEUTRAL_PHASE?    │
│    │   ├─ Check: gate == ARMED && setup == NONE?                │
│    │   └─ Log: [CONSISTENCY_CHECK] ...                         │
│    │                                                             │
│    └─ STEP 6: Generate No-Trade Diagnostic                      │
│        └─ Priority reasons: confidence < 65, phase not ready,    │
│          setup == NONE, gate not armed, price didn't cross      │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼ (every 1m tick)
┌─────────────────────────────────────────────────────────────────┐
│ 5. ENTRY LOGIC (handleMinimal1m, lines 2895-3117)              │
│    │                                                             │
│    ├─ Precondition Check:                                       │
│    │   └─ IF bias != NEUTRAL &&                                 │
│    │      (phase == PULLBACK_IN_PROGRESS ||                     │
│    │       phase == BIAS_ESTABLISHED):                          │
│    │                                                             │
│    ├─ BLOCKER 1: Setup Check                                    │
│    │   └─ IF setup == NONE:                                     │
│    │       ├─ exec.entryBlocked = true                          │
│    │       ├─ exec.waitReason = "no_setup_detected"            │
│    │       └─ RETURN (skip entry logic)                         │
│    │                                                             │
│    ├─ BLOCKER 2: Gate Check                                     │
│    │   └─ gateAllowsEntry = (!gate ||                           │
│    │                         gate.status == TRIGGERED ||         │
│    │                         gate.status == INACTIVE)           │
│    │   └─ IF !gateAllowsEntry:                                  │
│    │       ├─ exec.waitReason = "waiting_for_gate_trigger"      │
│    │       └─ Continue (don't return)                          │
│    │                                                             │
│    ├─ Phase Transitions (Pullback Failure/Continuation)         │
│    │   ├─ detectPullbackFailure() → phase = CONSOLIDATION       │
│    │   └─ detectContinuation() → phase = CONTINUATION_IN_PROGRESS│
│    │                                                             │
│    ├─ Entry Signal Detection                                    │
│    │   ├─ BULLISH: isBearish || lowerLow → entry check         │
│    │   └─ BEARISH: isBullish || higherHigh → entry check       │
│    │                                                             │
│    ├─ BLOCKER 3: No-Chase Rules                                 │
│    │   └─ shouldBlockEntry() check:                             │
│    │       ├─ IF phase == CONTINUATION_IN_PROGRESS:              │
│    │       │   ├─ continuationExtension > 1.25 * pullbackRange │
│    │       │   ├─ distance > 0.8 * ATR from ideal trigger       │
│    │       │   └─ price past expectedZone                       │
│    │       └─ IF blocked: exec.entryBlocked = true             │
│    │                                                             │
│    └─ Entry Execution (if all checks pass)                      │
│        ├─ exec.entryPrice = current5m.close                     │
│        ├─ exec.stopPrice = pullbackLow/High                     │
│        ├─ computeTargets() → exec.targets, exec.targetZones    │
│        └─ exec.phase = IN_TRADE                                 │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ 6. EVENT PUBLISHING                                             │
│    ├─ IF shouldPublishEvent || phase changed || bias changed:   │
│    │   └─ Push MIND_STATE_UPDATED event                         │
│    └─ IF silent > 10min && blocked:                             │
│        └─ Force heartbeat emission                              │
└─────────────────────────────────────────────────────────────────┘
```

### Key State Fields Involved

**Bias Layer:**
- `exec.bias` (BEARISH | BULLISH | NEUTRAL)
- `exec.biasConfidence` (derived, must be >= 65)
- `exec.baseBiasConfidence` (from LLM)
- `exec.biasInvalidationLevel`

**Phase Layer:**
- `exec.phase` (NEUTRAL_PHASE | BIAS_ESTABLISHED | PULLBACK_IN_PROGRESS | ...)
- `exec.expectedResolution` (CONTINUATION | FAILURE | UNDECIDED)

**Setup Layer:**
- `exec.setup` (REJECTION | EARLY_REJECTION | BREAKDOWN | ... | NONE)
- `exec.setupDetectedAt` (for TTL)
- `exec.setupTriggerPrice`
- `exec.setupStopPrice`

**Gate Layer:**
- `exec.resolutionGate.status` (INACTIVE | ARMED | TRIGGERED | EXPIRED | INVALIDATED)
- `exec.resolutionGate.triggerPrice`
- `exec.resolutionGate.expiryTs`

**Pullback Layer:**
- `exec.pullbackHigh`
- `exec.pullbackLow`
- `exec.pullbackTs`

**Entry Layer:**
- `exec.entryBlocked` (boolean)
- `exec.entryBlockReason` (string)
- `exec.entryPrice`
- `exec.stopPrice`

---

## 3) Over-Containment Audit (All Blockers by Layer)

### Table: Entry Blockers and Over-Containment Risk

| Layer | Blocker | Location | Essential? | Over-Containment Risk | Why It Exists |
|-------|---------|----------|------------|----------------------|---------------|
| **Market Hours** | `!regime.isRTH` | Line 2373 | ✅ Essential | Low | Prevents trading outside market hours |
| **Bar Availability** | `closed5mBars.length == 0` | Line 2422 | ✅ Essential | Low | Need bars for LLM analysis |
| **Bar Availability** | `closed5mBars.length < 3` | Various setup detectors | ⚠️ Optional | **HIGH** | Some setups require 3+ bars, blocks early entries |
| **Bar Availability** | `closed5mBars.length < 10` | Compression detector | ⚠️ Optional | **HIGH** | Blocks compression detection early in session |
| **Bias Confidence** | `biasConfidence < 65` | Line 2146 | ⚠️ Optional | **MEDIUM** | Prevents phase transition even with valid bias |
| **Bias Confidence** | `biasConfidence === undefined` | Line 2325 | ⚠️ Optional | **MEDIUM** | Blocks if confidence not yet calculated |
| **Phase Gating** | `phase !== PULLBACK_IN_PROGRESS && phase !== BIAS_ESTABLISHED` | Line 2895 | ⚠️ Optional | **HIGH** | Entry only allowed in 2 phases, blocks others |
| **Phase Gating** | `phase == NEUTRAL_PHASE` (when bias != NEUTRAL) | Line 2328 | ❌ Bug | **HIGH** | Contradictory state - should not occur |
| **Pullback Levels** | `pullbackHigh === undefined || pullbackLow === undefined` | Line 2159, 2266 | ⚠️ Optional | **HIGH** | Phase can't transition to PULLBACK_IN_PROGRESS without levels |
| **Pullback Levels** | `pullbackHigh/Low undefined` (gate arming) | Line 2266 | ⚠️ Optional | **HIGH** | Gate can't arm without pullback levels |
| **Setup Gating** | `setup === NONE` | Line 2898 | ⚠️ Optional | **CRITICAL** | **PRIMARY BLOCKER** - no setup = no trade |
| **Setup Detection** | `phase !== PULLBACK_IN_PROGRESS` (for REJECTION) | Line 728 | ⚠️ Optional | **HIGH** | REJECTION only detected in PULLBACK_IN_PROGRESS |
| **Setup Detection** | `expectedResolution !== CONTINUATION` | Line 727 | ⚠️ Optional | **HIGH** | REJECTION requires CONTINUATION expectation |
| **Setup Detection** | `ema9 == 0 || vwap == 0 || volSMA20 == 0` | Line 688 | ⚠️ Optional | **MEDIUM** | EARLY_REJECTION requires indicators |
| **Setup Detection** | Strict candle geometry (wick/body ratios) | Lines 900-1000 | ⚠️ Optional | **HIGH** | Very specific patterns required |
| **Setup Detection** | Volume confirmation (relVol >= 1.10) | Line 926 | ⚠️ Optional | **MEDIUM** | Blocks low-volume setups |
| **Setup Detection** | Cross attempt required (was below, tried above) | Line 904 | ⚠️ Optional | **MEDIUM** | Prevents false positives but may miss valid setups |
| **Setup TTL** | Setup TTL expired but not re-detected | Line 2216 | ⚠️ Optional | **MEDIUM** | Setup can expire and not be re-detected if conditions changed |
| **Gate Gating** | `gate.status == ARMED` (blocks entry) | Line 2913 | ⚠️ Optional | **CRITICAL** | **PRIMARY BLOCKER** - gate must be TRIGGERED, not just ARMED |
| **Gate Gating** | `gate.status == EXPIRED` | Line 1646 | ⚠️ Optional | **MEDIUM** | Gate expires after 2 timeframes (10 min) |
| **Gate Gating** | `gate.status == INVALIDATED` | Line 1649 | ⚠️ Optional | **LOW** | Valid - structure broke |
| **Gate Trigger** | `price > triggerPrice + tolerance` (for REJECTION) | Line 518 | ⚠️ Optional | **HIGH** | Tolerance only 0.08, may miss near-misses |
| **Gate Trigger** | Momentum not aligned (for REJECTION tolerance) | Line 526 | ⚠️ Optional | **MEDIUM** | Requires red candle for bearish, green for bullish |
| **No-Chase Rules** | `continuationExtension > 1.25 * pullbackRange` | Line 1802 | ⚠️ Optional | **LOW** | Valid risk management |
| **No-Chase Rules** | `distance > 0.8 * ATR` from ideal trigger | Line 1812 | ⚠️ Optional | **MEDIUM** | May block valid entries if ATR is large |
| **No-Chase Rules** | `price past expectedZone` | Line 1826 | ⚠️ Optional | **MEDIUM** | May block if target calculation is off |
| **Phase Transition** | `pullbackHigh/Low undefined` (blocks PULLBACK_IN_PROGRESS) | Line 2159 | ⚠️ Optional | **HIGH** | **CHICKEN-EGG**: Need phase for setup, need pullback for phase |
| **Emission Gating** | `shouldPublishEvent == false && phase unchanged && bias unchanged` | Line 3204 | ⚠️ Optional | **MEDIUM** | Blocks messages when stuck in same state |

### Critical Over-Containment Issues

**1. Setup == NONE is a Hard Blocker (CRITICAL)**
- **Location:** Line 2898
- **Impact:** Even if bias is BEARISH, phase is PULLBACK_IN_PROGRESS, and price action is perfect, entry is blocked if `setup === NONE`
- **Why it's over-contained:** Old bot didn't need explicit setup taxonomy - it just needed "pullback + trigger"
- **Risk:** **CRITICAL** - This is the #1 reason trades don't fire

**2. Gate Must Be TRIGGERED, Not Just ARMED (CRITICAL)**
- **Location:** Line 2913
- **Impact:** Gate can be ARMED (setup exists, conditions met) but entry still blocked until price crosses trigger
- **Why it's over-contained:** Old bot entered immediately on signal, didn't wait for price to cross a pre-defined trigger
- **Risk:** **CRITICAL** - Gate arming is independent of entry signal, causing delay

**3. Phase Transition Requires Pullback Levels (HIGH)**
- **Location:** Line 2159
- **Impact:** Can't transition to PULLBACK_IN_PROGRESS without `pullbackHigh` and `pullbackLow` already set
- **Why it's over-contained:** Old bot didn't need pre-defined pullback levels - it detected pullback in real-time
- **Risk:** **HIGH** - Creates chicken-egg: need phase for setup detection, need pullback levels for phase

**4. Setup Detection Only on Closed Bars (HIGH)**
- **Location:** Line 2224 (`forming5mBar = null`)
- **Impact:** Setup detection only runs on 5m close, not on forming bars
- **Why it's over-contained:** Old bot could detect and enter on forming bar
- **Risk:** **HIGH** - Delays setup detection by up to 5 minutes

**5. Strict Setup Pattern Requirements (HIGH)**
- **Location:** Lines 900-1000 (EARLY_REJECTION), 1020+ (REJECTION)
- **Impact:** Requires very specific candle geometry, volume confirmation, EMA/VWAP reclaim
- **Why it's over-contained:** Old bot just needed "strong candle at support/resistance"
- **Risk:** **HIGH** - Many valid pullbacks don't meet strict pattern requirements

**6. Bias Confidence Threshold >= 65 (MEDIUM)**
- **Location:** Line 2146
- **Impact:** Phase won't transition from NEUTRAL_PHASE if confidence < 65
- **Why it's over-contained:** Old bot didn't have confidence thresholds
- **Risk:** **MEDIUM** - Can block valid entries if confidence calculation is conservative

---

## 4) Invariants + Contradictions

### Invariants That SHOULD Hold

| Invariant | Expected State | Where Checked | Status |
|-----------|---------------|---------------|--------|
| **I1:** If `bias != NEUTRAL` and `biasConfidence >= 65`, then `phase != NEUTRAL_PHASE` | `phase == BIAS_ESTABLISHED` or `PULLBACK_IN_PROGRESS` | Line 2293 | ✅ Checked (but may still occur) |
| **I2:** If `gate.status == ARMED`, then `setup != NONE` | `setup` must be active | Line 2298 | ✅ Checked (but may still occur) |
| **I3:** If `entryStatus == active`, then `setup != NONE` | Setup must exist for active trade | Line 2304 | ✅ Checked |
| **I4:** If `phase == PULLBACK_IN_PROGRESS`, then `pullbackHigh` and `pullbackLow` are defined | Pullback levels must exist | Line 2159 | ❌ **NOT ENFORCED** |
| **I5:** If `setup == REJECTION`, then `phase == PULLBACK_IN_PROGRESS` | REJECTION only in pullback | Line 728 | ✅ Enforced in detection |
| **I6:** If `gate.status == ARMED`, then `expectedResolution == CONTINUATION` | Gate only arms for continuation | Line 2265 | ✅ Enforced |
| **I7:** LLM never sets `phase` directly | Phase is engine-owned | N/A | ✅ Enforced (LLM doesn't output phase) |
| **I8:** Setup detection only uses closed bars | Never uses `forming5mBar` | Line 2224 | ✅ Enforced |

### Contradictions Found in Code

**C1: Phase Stuck in NEUTRAL_PHASE When Bias is BEARISH**
- **Location:** Line 2146-2181
- **Issue:** If `biasConfidence` is undefined or < 65, phase stays NEUTRAL_PHASE even if bias is BEARISH/BULLISH
- **Example:** `bias=BEARISH, biasConfidence=undefined, phase=NEUTRAL_PHASE` → entry blocked
- **Root Cause:** Confidence calculation may not run on every tick, or may be delayed

**C2: Gate ARMED But Setup NONE (Should Not Occur)**
- **Location:** Line 2257-2285
- **Issue:** Gate can be ARMED from previous setup, then setup becomes NONE, but gate not immediately disarmed
- **Example:** Setup expires → setup = NONE, but gate still ARMED until next 5m close
- **Root Cause:** Gate disarming only happens in `reduce5mClose`, not on every tick

**C3: Pullback Levels Undefined But Phase is PULLBACK_IN_PROGRESS**
- **Location:** Line 2159
- **Issue:** Phase can be PULLBACK_IN_PROGRESS but `pullbackHigh/Low` undefined if they were cleared
- **Example:** `clearTradeState()` clears pullback levels, but phase persists
- **Root Cause:** `clearTradeState()` preserves levels only if `phase == PULLBACK_IN_PROGRESS`, but phase may change after clearing

**C4: waitReason "waiting_for_bias" When Bias is Already BEARISH**
- **Location:** Line 2175
- **Issue:** If bias is BEARISH but phase transitions to NEUTRAL_PHASE, waitReason says "waiting_for_bias"
- **Example:** `bias=BEARISH, phase=NEUTRAL_PHASE, waitReason=waiting_for_bias` → contradictory
- **Root Cause:** Phase transition logic doesn't check if bias already exists

**C5: Entry Blocked But Gate is TRIGGERED**
- **Location:** Line 2913-2930
- **Issue:** Gate can be TRIGGERED but entry still blocked by other conditions (setup, no-chase, etc.)
- **Example:** `gate.status=TRIGGERED, setup=NONE` → entry blocked by setup check
- **Root Cause:** Multiple independent blockers, no priority ordering

---

## 5) Likely "Missing Bridge" Root Causes

### Candidate #1: Phase Not Transitioning Out of NEUTRAL_PHASE (HIGH PROBABILITY)

**Evidence:**
- Logs show: `bias=BEARISH, phase=NEUTRAL_PHASE` (from user description)
- Code: Line 2146 requires `biasConfidence >= 65` for phase transition
- Code: Line 2146 also requires `biasConfidence !== undefined`

**Why It Matches Observed Behavior:**
- LLM outputs `action=ARM_SHORT, bias=bearish` → bias becomes BEARISH
- But `biasConfidence` may be undefined or < 65 initially
- Phase stays NEUTRAL_PHASE → entry logic never runs (line 2895 checks phase)
- Result: Bot is "alive" (bias is BEARISH) but "quiet" (no entries, no phase transitions)

**Missing Bridge:**
- Phase transition should happen immediately when bias is set, not wait for confidence calculation
- OR: Confidence should be calculated synchronously when bias is set

**Confirmation Questions:**
1. In logs, when `bias=BEARISH` first appears, what is `biasConfidence`?
2. How many 5m closes pass before `phase` transitions from `NEUTRAL_PHASE`?
3. Is there a `[PHASE_TRANSITION]` log when bias is first set?

---

### Candidate #2: Setup Detection Too Strict / Never Detects (HIGH PROBABILITY)

**Evidence:**
- Logs show: `setup=NONE` persistently
- Code: Line 2898 blocks entry if `setup === NONE`
- Code: Setup detection requires very specific patterns (lines 900-1000)

**Why It Matches Observed Behavior:**
- Bias is BEARISH, phase is PULLBACK_IN_PROGRESS
- But setup detection requires:
  - Specific candle geometry (wick/body ratios)
  - Volume confirmation (relVol >= 1.10)
  - EMA/VWAP reclaim attempts
  - Structure checks (higher-high, tagged pullback resistance)
- Many valid pullbacks don't meet all these criteria
- Result: `setup=NONE` → entry blocked → "quiet but evaluating"

**Missing Bridge:**
- Old bot didn't need explicit setup taxonomy - it just needed "pullback + trigger"
- New bot needs a "universal pullback setup" that fires when:
  - Bias is BEARISH/BULLISH
  - Phase is PULLBACK_IN_PROGRESS
  - Price makes a pullback move (bearish candle for bullish bias, etc.)
- This would be a fallback when no specific setup is detected

**Confirmation Questions:**
1. In logs, when `phase=PULLBACK_IN_PROGRESS`, what does `detectSetup()` return?
2. Are there `[SETUP_DETECTED]` logs showing REJECTION → NONE flickering?
3. What are the candle characteristics (wick/body ratios, volume) when setup=NONE?

---

### Candidate #3: Pullback Levels Not Set Early Enough (MEDIUM PROBABILITY)

**Evidence:**
- Code: Line 2159 requires `pullbackHigh` and `pullbackLow` to exist for phase transition
- Code: Line 2266 requires pullback levels for gate arming
- Code: Pullback levels are set in various places, but may not be set when bias is first established

**Why It Matches Observed Behavior:**
- Bias becomes BEARISH → phase should transition to BIAS_ESTABLISHED
- But to transition to PULLBACK_IN_PROGRESS, pullback levels must exist (line 2159)
- Pullback levels may not be set until a pullback actually occurs
- Result: Phase stuck in BIAS_ESTABLISHED → setup detection may not run (some setups require PULLBACK_IN_PROGRESS)

**Missing Bridge:**
- Pullback levels should be initialized when bias is established:
  - BEARISH: `pullbackHigh = currentPrice` (or recent high)
  - BULLISH: `pullbackLow = currentPrice` (or recent low)
- OR: Phase transition to PULLBACK_IN_PROGRESS should set pullback levels if they don't exist

**Confirmation Questions:**
1. When `bias=BEARISH` is first set, are `pullbackHigh` and `pullbackLow` defined?
2. How many bars pass before pullback levels are set?
3. Is phase stuck in `BIAS_ESTABLISHED` because pullback levels are undefined?

---

### Candidate #4: Gate Arming Independent of Entry Signal (MEDIUM PROBABILITY)

**Evidence:**
- Code: Line 2265-2285 arms gate when setup exists and conditions are met
- Code: Line 2913 requires gate to be TRIGGERED (not just ARMED) for entry
- Code: Gate trigger requires price to cross `triggerPrice` (line 498-545)

**Why It Matches Observed Behavior:**
- Setup is detected → gate is ARMED
- But entry signal (bearish candle, higher high) occurs
- Gate is still ARMED (not TRIGGERED) because price hasn't crossed trigger
- Entry is blocked (line 2917) → "waiting_for_gate_trigger"
- Result: Bot sees entry signal but can't enter because gate isn't triggered

**Missing Bridge:**
- Old bot entered immediately on signal, didn't wait for price to cross a pre-defined trigger
- New bot should allow entry when:
  - Setup exists
  - Entry signal occurs (bearish candle, etc.)
  - Gate is ARMED (or no gate exists)
- Gate trigger should be checked on every tick, not just on 5m close

**Confirmation Questions:**
1. When entry signal occurs (bearish candle), what is `gate.status`?
2. What is the distance between `currentPrice` and `gate.triggerPrice`?
3. Are there `[ENTRY_BLOCKED_BY_GATE]` logs showing gate is ARMED but not triggered?

---

## 6) Minimal Delta Plan (No Code Changes)

### Priority 1: Add Universal Pullback Setup (CRITICAL)

**What:** Create a fallback setup type `PULLBACK_GENERIC` that fires when:
- Bias is BEARISH/BULLISH
- Phase is PULLBACK_IN_PROGRESS or BIAS_ESTABLISHED
- Price makes a pullback move (bearish candle for bullish bias, bullish candle for bearish bias)
- No other specific setup is detected

**Why:** This restores the old bot's "pullback + trigger" behavior while keeping the new architecture

**Where:** In `detectSetup()`, add as last priority (after all other setups, before NONE)

**Risk:** Low - only fires when no other setup is detected, so it's a fallback

---

### Priority 2: Initialize Pullback Levels on Bias Establishment (HIGH)

**What:** When bias is first set (in `reduce5mClose` STEP 1), immediately set:
- BEARISH: `pullbackHigh = close` (or recent high from last 3-5 bars)
- BULLISH: `pullbackLow = close` (or recent low from last 3-5 bars)

**Why:** Removes chicken-egg: phase can transition to PULLBACK_IN_PROGRESS immediately

**Where:** In `reduce5mClose` STEP 1, after `exec.bias = newBias`

**Risk:** Low - pullback levels can be updated later when actual pullback occurs

---

### Priority 3: Allow Entry When Gate is ARMED + Entry Signal (HIGH)

**What:** Modify entry logic to allow entry when:
- Setup exists (not NONE)
- Gate is ARMED (not just TRIGGERED)
- Entry signal occurs (bearish candle, higher high, etc.)
- Check gate trigger on entry signal, not wait for price to cross

**Why:** Restores immediate entry on signal, like old bot

**Where:** In entry logic (line 2913), change `gateAllowsEntry` to include ARMED status, and check trigger on entry signal

**Risk:** Medium - need to ensure gate trigger logic is correct

---

### Priority 4: Remove Confidence Threshold for Phase Transition (MEDIUM)

**What:** Allow phase transition from NEUTRAL_PHASE to BIAS_ESTABLISHED when bias is set, regardless of confidence

**Why:** Confidence can be calculated later, but phase should transition immediately

**Where:** In `reduce5mClose` STEP 2, remove `biasConfidence >= 65` check for initial phase transition

**Risk:** Low - confidence is still calculated and used for other purposes

---

### Priority 5: Make Setup Detection Less Strict (MEDIUM)

**What:** Relax setup detection requirements:
- Lower volume threshold (relVol >= 0.90 instead of 1.10)
- Allow setup detection on forming bars (with progress adjustment)
- Reduce candle geometry requirements (lower wick/body ratio thresholds)

**Why:** More setups will be detected, reducing "setup=NONE" blocks

**Where:** In `detectEarlyRejection()` and `detectRejectionSetup()`, adjust thresholds

**Risk:** Medium - may increase false positives, but can be filtered by other rules

---

### Priority 6: Add Setup TTL Latching (LOW)

**What:** When setup is detected, latch it for 2-3 bars even if detection conditions temporarily fail

**Why:** Prevents setup flickering (REJECTION → NONE → REJECTION)

**Where:** Already implemented (line 2186-2250), but may need tuning

**Risk:** Low - already implemented, just needs tuning

---

### Priority 7: Remove Gate Requirement for Entry (LOW)

**What:** Allow entry even if gate is not ARMED, as long as setup exists and entry signal occurs

**Why:** Gate is an optimization, not a requirement - old bot didn't have gates

**Where:** In entry logic, make gate optional (only use if it exists and is ARMED)

**Risk:** Medium - gate provides time-boxing and structure validation

---

## 7) Five Concrete Questions to Answer from Logs

### Question 1: Phase Transition Timing
**Query:** When `bias=BEARISH` first appears in logs, how many 5m closes pass before `phase` transitions from `NEUTRAL_PHASE` to `BIAS_ESTABLISHED`?

**What It Reveals:**
- If phase never transitions → Candidate #1 confirmed (confidence threshold blocking)
- If phase transitions immediately → Candidate #1 ruled out

**Log Pattern to Search:**
```
[LLM5M] action=ARM_SHORT bias=BEARISH ...
[PHASE_TRANSITION] NEUTRAL_PHASE -> BIAS_ESTABLISHED
```

---

### Question 2: Setup Detection Results
**Query:** When `phase=PULLBACK_IN_PROGRESS` and `bias=BEARISH`, what does `[SETUP_DETECTED]` show? Is it consistently `NONE`, or does it flicker between `REJECTION` and `NONE`?

**What It Reveals:**
- If consistently `NONE` → Candidate #2 confirmed (setup detection too strict)
- If flickers `REJECTION → NONE` → Setup TTL issue or forming bar problem
- If `REJECTION` persists → Candidate #2 ruled out, look at gate/trigger

**Log Pattern to Search:**
```
[SETUP_DETECTED] NONE -> REJECTION
[SETUP_DETECTED] REJECTION -> NONE
[CONSISTENCY_CHECK] ... setup=...
```

---

### Question 3: Pullback Levels Availability
**Query:** When `bias=BEARISH` is first set, are `pullbackHigh` and `pullbackLow` defined? If not, when are they first set?

**What It Reveals:**
- If undefined when bias is set → Candidate #3 confirmed (chicken-egg problem)
- If defined immediately → Candidate #3 ruled out

**Log Pattern to Search:**
```
[LLM5M] ... bias=BEARISH ...
[PHASE_TRANSITION] ... -> BIAS_ESTABLISHED
(Check if pullbackHigh/pullbackLow are logged in subsequent entries)
```

---

### Question 4: Gate Status vs Entry Signal
**Query:** When entry signal occurs (bearish candle, higher high), what is `gate.status`? Is it `ARMED`, `TRIGGERED`, or `INACTIVE`? What is the distance between `currentPrice` and `gate.triggerPrice`?

**What It Reveals:**
- If `ARMED` and price is near trigger → Candidate #4 confirmed (gate blocking entry)
- If `TRIGGERED` → Candidate #4 ruled out, look at other blockers
- If `INACTIVE` → Gate not arming, look at setup/conditions

**Log Pattern to Search:**
```
[ENTRY_CHECK] BEARISH bias - Entry condition met: ...
[ENTRY_BLOCKED_BY_GATE] ... gate=ARMED ... trigger=... distance=...
[GATE_ARMED] ... trigger=...
```

---

### Question 5: Consistency Check Violations
**Query:** How often do `[CONSISTENCY_CHECK] ERROR` logs appear? What are the most common violations?

**What It Reveals:**
- If `bias != NEUTRAL && phase == NEUTRAL_PHASE` → Candidate #1 confirmed
- If `gate == ARMED && setup == NONE` → Gate/setup synchronization issue
- If no errors → System is consistent but over-contained

**Log Pattern to Search:**
```
[CONSISTENCY_CHECK] ERROR: ...
```

---

## Summary

The new bot has **7 layers of gating** compared to the old bot's **3 conditions**:

**Old Bot:** `direction + pullback + trigger` → **immediate entry**

**New Bot:** `bias + confidence + phase + pullbackLevels + setup + gate + entrySignal + noChase` → **entry (if all pass)**

The **primary blockers** are:
1. **Setup == NONE** (hard blocker, no fallback)
2. **Gate must be TRIGGERED** (not just ARMED)
3. **Phase transition requires pullback levels** (chicken-egg)
4. **Confidence threshold >= 65** (blocks phase transition)

The **most likely root cause** is **Candidate #2** (setup detection too strict) combined with **Candidate #1** (phase not transitioning), creating a cascade where:
- Bias is BEARISH but phase stays NEUTRAL_PHASE (confidence issue)
- OR phase is PULLBACK_IN_PROGRESS but setup stays NONE (detection too strict)
- Result: Entry blocked → "quiet but evaluating"

**Recommended fix order:**
1. Add universal pullback setup (Priority 1)
2. Initialize pullback levels on bias (Priority 2)
3. Allow entry when gate ARMED + signal (Priority 3)
4. Remove confidence threshold for phase (Priority 4)

This would restore the old bot's "pullback fires" behavior while keeping the new architecture's benefits.
