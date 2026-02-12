# System Analysis and Improvement Plan

## STAGE 1: SYSTEM MAP

### Runtime Flow and Ownership

```
┌─────────────────────────────────────────────────────────────────┐
│                    DATA INGESTION LAYER                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Alpaca Feed (WebSocket/Polling)                                │
│  - Receives 1m bars from market data provider                   │
│  - Location: src/index.ts:358-420 (WebSocket) or 426-488 (Poll) │
│  - Output: normalizedBar { ts, open, high, low, close, volume } │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 1: Process 1m Tick (handleMinimal1m)                     │
│  Location: src/orchestrator/orchestrator.ts:4275               │
│  Owner: Orchestrator                                            │
│  State Objects:                                                 │
│    - this.forming5mBar (Orchestrator private)                  │
│    - this.formingBucketStart (Orchestrator private)            │
│    - this.state.price (BotState)                               │
│    - this.state.lastTickTs (BotState)                          │
│    - exec.micro (MinimalExecutionState)                        │
│  Actions:                                                       │
│    - Updates forming5mBar via updateForming5mBar()             │
│    - Detects 5m rollover (is5mClose flag)                      │
│    - Updates micro indicators (VWAP/EMA/ATR counters)           │
│    - Calls LLM 1m direction opinion                            │
│    - Updates bias engine (1m-based)                            │
│    - Checks entry triggers                                     │
│    - Returns events[] array                                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 2: Aggregate to 5m (BarAggregator)                       │
│  Location: src/index.ts:381 or 449                             │
│  Owner: BarAggregator (separate instance)                      │
│  State Objects:                                                 │
│    - this.bucketStartTs (BarAggregator private)                │
│    - this.cur (BarAggregator private)                         │
│  Actions:                                                       │
│    - Receives 1m bar                                            │
│    - Accumulates into 5m bucket                                 │
│    - Returns closed5m Bar | null when bucket completes      │
└─────────────────────────────────────────────────────────────────┘
                              │
                    ┌──────────┴──────────┐
                    │  closed5m !== null? │
                    └──────────┬──────────┘
                    YES        │        NO
                    │          │
                    ▼          ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 3A: Process Closed 5m Bar (handleMinimal5m)              │
│  Location: src/orchestrator/orchestrator.ts:6415                │
│  Owner: Orchestrator                                            │
│  State Objects:                                                 │
│    - this.recentBars5m[] (Orchestrator private)                │
│    - this.state.last5mCloseTs (BotState)                       │
│  Actions:                                                       │
│    - Appends closedBar to recentBars5m[]                        │
│    - Updates this.state.last5mCloseTs                          │
│    - Logs [CLOSE5M]                                            │
│    - Returns events[] (usually empty)                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 3B: Reduce 5m Close (reduce5mClose)                      │
│  Location: src/orchestrator/orchestrator.ts:3773                │
│  Owner: Orchestrator                                            │
│  Called From: handleMinimal1m() when is5mClose=true             │
│  State Objects:                                                 │
│    - exec.bias (MinimalExecutionState)                         │
│    - exec.phase (MinimalExecutionState)                        │
│    - exec.setup (MinimalExecutionState)                        │
│    - exec.biasEngine (MinimalExecutionState)                   │
│    - exec.opportunity (MinimalExecutionState)                  │
│  Actions (in order):                                           │
│    1. Store LLM hints (if llmDecision provided)                │
│    2. Compute derived confidence                               │
│    3. Update 5m structure anchors (swingHigh5m, swingLow5m)    │
│    4. Finalize bias from 5m structure (finalizeBiasFrom5m)      │
│    5. Update phase deterministically                           │
│    6. Detect setup (detectSetup)                               │
│    7. Latch opportunity (latchOpportunity)                     │
│    8. Check consistency                                        │
│    9. Generate diagnostics                                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  BIAS COMPUTATION SUBSYSTEMS                                    │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌──────────────────────┼──────────────────────┐
        │                      │                        │
        ▼                      ▼                        ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ Bias Engine (1m) │  │ LLM 1m Nudge     │  │ 5m Finalization  │
│ updateBiasEngine │  │ maybeNudgeBias   │  │ finalizeBiasFrom5m│
│ Line 1718        │  │ Line 1926        │  │ Line 2104        │
│                  │  │                  │  │                  │
│ Reads:           │  │ Reads:           │  │ Reads:           │
│ - exec.micro     │  │ - exec.llm1mDir  │  │ - exec.biasEngine│
│ - exec.bias      │  │ - exec.micro     │  │ - exec.swingHigh5m│
│                  │  │                  │  │ - exec.swingLow5m │
│ Writes:          │  │ Writes:          │  │ Writes:          │
│ - be.state       │  │ - exec.bias      │  │ - exec.bias      │
│ (BULLISH/BEARISH │  │ - exec.phase     │  │ - exec.phase     │
│ /REPAIR)         │  │ - exec.setup     │  │ - exec.pullback* │
│                  │  │ - exec.pullback* │  │                  │
│ Can only         │  │ Can set bias     │  │ Only place that  │
│ neutralize       │  │ from NEUTRAL     │  │ can finalize     │
│ (enter REPAIR)   │  │                  │  │ bias flips       │
└──────────────────┘  └──────────────────┘  └──────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  SETUP DETECTION & ARMING                                       │
│  Location: src/orchestrator/orchestrator.ts:1609                │
│  Owner: Orchestrator                                             │
│  State Objects:                                                 │
│    - exec.setup (MinimalExecutionState)                        │
│    - exec.setupTriggerPrice (MinimalExecutionState)            │
│    - exec.setupStopPrice (MinimalExecutionState)               │
│    - exec.resolutionGate (MinimalExecutionState)                │
│    - exec.opportunity (MinimalExecutionState)                   │
│  Actions:                                                       │
│    - detectSetup() - detects PULLBACK_CONTINUATION, IGNITION    │
│    - armResolutionGate() - arms gate with trigger/stop         │
│    - latchOpportunity() - creates OpportunityLatch             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  TRIGGER DETECTION & ENTRY                                      │
│  Location: src/orchestrator/orchestrator.ts:4746+               │
│  Owner: Orchestrator                                             │
│  State Objects:                                                 │
│    - exec.opportunity.status (MinimalExecutionState)            │
│    - exec.phase (MinimalExecutionState)                        │
│    - exec.entryPrice (MinimalExecutionState)                   │
│    - exec.stopPrice (MinimalExecutionState)                    │
│    - exec.targets (MinimalExecutionState)                      │
│  Actions:                                                       │
│    - checkOpportunityTrigger() - detects trigger hits           │
│    - checkGateTrigger() - detects gate trigger hits             │
│    - shouldBlockEntry() - checks entry blockers                 │
│    - Sets exec.phase = "IN_TRADE" on entry                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  TRADE MANAGEMENT (TP/Exit Detection)                           │
│  Location: src/orchestrator/orchestrator.ts:5800+               │
│  Owner: Orchestrator                                             │
│  State Objects:                                                 │
│    - exec.targetsHit (MinimalExecutionState)                   │
│    - exec.lastTargetHit (MinimalExecutionState)                │
│    - exec.phase (MinimalExecutionState)                        │
│  Actions:                                                       │
│    - Detects target hits (bar.high/low vs targets)              │
│    - Stores in exec.lastTargetHit                               │
│    - Moves stop to breakeven on 1R hit                          │
│    - Exits on 3R hit or momentum slow                           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  EVENT EMISSION                                                 │
│  Location: src/orchestrator/orchestrator.ts:5954-6084           │
│  Owner: Orchestrator                                             │
│  Event Types:                                                   │
│    - GATE_ARMED                                                 │
│    - OPPORTUNITY_TRIGGERED                                      │
│    - TRADE_ENTRY                                                │
│    - TRADE_EXIT                                                 │
│    - TRADING_ALERT (for TP hits, trigger blocked)               │
│    - MIND_STATE_UPDATED (main state snapshot)                   │
│  State Objects:                                                 │
│    - events[] array (returned from handleMinimal1m)            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  EVENT PUBLISHING                                               │
│  Location: src/index.ts:409, 413, 477, 481                     │
│  Owner: MessagePublisher                                         │
│  State Objects:                                                 │
│    - governor.dedupeKeys (MessageGovernor)                     │
│  Actions:                                                       │
│    - publisher.publishOrdered(events)                          │
│    - governor.shouldSend() - checks mode, deduplication        │
│    - normalizeTelegramSnapshot() - converts event to snapshot  │
│    - buildTelegramAlert() - formats for Telegram                │
│    - sendTelegramMessageSafe() - sends message                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  USER OUTPUT (Telegram)                                         │
│  Location: src/telegram/telegramFormatter.ts                     │
│  Owner: TelegramFormatter                                        │
│  Actions:                                                       │
│    - Formats coaching lines                                     │
│    - Formats bias/phase/setup status                           │
│    - Formats trigger/entry/exit alerts                         │
└─────────────────────────────────────────────────────────────────┘
```

### Key State Objects and Ownership

| State Object | Owner | Write Locations | Read Locations |
|--------------|-------|----------------|----------------|
| `BotState.last5mCloseTs` | Orchestrator | `handleMinimal5m:6436` | `logStructuredPulse:105`, `telegramFormatter:313` |
| `BotState.lastLLMCallAt` | Orchestrator | **NEVER SET** | `logStructuredPulse:108` |
| `BotState.lastLLMDecision` | Orchestrator | **NEVER SET** | `logStructuredPulse:109` |
| `BotState.price` | Orchestrator | `processTick:140` | `logStructuredPulse:106` |
| `MinimalExecutionState.bias` | **SPLIT** | `maybeNudgeBiasFromLlm1m:1992,2027`, `finalizeBiasFrom5m:2126,2148,2180,2240` | Everywhere |
| `MinimalExecutionState.phase` | Orchestrator | `reduce5mClose:3852,3869,3878,3901`, `maybeNudgeBiasFromLlm1m:2001,2036` | Everywhere |
| `MinimalExecutionState.setup` | Orchestrator | `detectSetup:1609+`, `maybeNudgeBiasFromLlm1m:2004,2039` | Everywhere |
| `MinimalExecutionState.opportunity` | Orchestrator | `latchOpportunity:986`, `checkOpportunityTrigger:1242+` | Entry logic, event emission |
| `BarAggregator.bucketStartTs` | BarAggregator | `push1m:37,47` | `push1m:43` |
| `Orchestrator.formingBucketStart` | Orchestrator | `updateForming5mBar:174,199` | `handleMinimal1m:4310,4318` |
| `Orchestrator.recentBars5m[]` | Orchestrator | `handleMinimal5m:6434`, `preloadHistory:6381+` | Everywhere (bias, setup, triggers) |

---

## STAGE 2: FAILURE MODE ANALYSIS

### A) Split-Brain Bias Ownership

**Problem:** More than one subsystem can write "canonical" bias or phase.

#### Finding A1: LLM 1m Can Set Bias Directly
**Location:** `src/orchestrator/orchestrator.ts:1992, 2027`

**Code:**
```typescript
// Line 1992: Direct bias write from LLM
exec.bias = "BULLISH";
be.state = "BULLISH";

// Line 2027: Direct bias write from LLM
exec.bias = "BEARISH";
be.state = "BEARISH";
```

**Severity:** 🔴 **CRITICAL - Risk to Live Trading**
- LLM can set bias before 5m structure finalizes
- Creates conflicting bias sources
- Trading decisions may use wrong bias

**Subsystem Ownership:** LLM Adapter (via `maybeNudgeBiasFromLlm1m`)
**Production Symptom:** "LLM 1m opinions sometimes appear to set or influence bias, creating confusing bias flips around VWAP"

**How It Produces Symptom:**
1. LLM sees price above VWAP, sets bias BULLISH
2. Price dips below VWAP (normal pullback)
3. Bias engine sees below VWAP, enters REPAIR_BULL
4. User sees conflicting signals: bias says BULLISH but engine says REPAIR
5. VWAP chop causes rapid flip-flop

#### Finding A2: Phase Can Be Set by LLM Nudge
**Location:** `src/orchestrator/orchestrator.ts:2001, 2036`

**Code:**
```typescript
// Line 2001: Phase set when LLM nudge sets bias
exec.phase = "BIAS_ESTABLISHED";

// Line 2036: Phase set when LLM nudge sets bias
exec.phase = "BIAS_ESTABLISHED";
```

**Severity:** 🟠 **HIGH - Observability/Usability**
- Phase set before 5m structure confirms
- May conflict with `reduce5mClose` phase logic

**Subsystem Ownership:** LLM Adapter
**Production Symptom:** "Bias/phase can remain NEUTRAL even with repeated 5m closes" (if LLM nudge fails, phase stays NEUTRAL)

#### Finding A3: Setup Can Be Set by LLM Nudge
**Location:** `src/orchestrator/orchestrator.ts:2004, 2039`

**Code:**
```typescript
// Line 2004: Setup set when LLM nudge sets bias
exec.setup = "PULLBACK_CONTINUATION";

// Line 2039: Setup set when LLM nudge sets bias
exec.setup = "PULLBACK_CONTINUATION";
```

**Severity:** 🟠 **HIGH - Observability/Usability**
- Setup set before `detectSetup()` runs
- May conflict with 5m-based setup detection

**Subsystem Ownership:** LLM Adapter
**Production Symptom:** "Trigger detector can emit 'TRIGGER HIT' alerts while main orchestrator remains in setup=NONE" (if LLM sets setup but orchestrator clears it)

---

### B) Sequencing/State-Commit Issues

**Problem:** Logs/events happen before state commit; PULSE reads stale state.

#### Finding B1: CLOSE5M Logged Before State Commit
**Location:** `src/index.ts:393-395` (logs) vs `src/orchestrator/orchestrator.ts:6436` (state update)

**Code Flow:**
```
1. index.ts:393 - Logs [CLOSE5M] when BarAggregator returns closed5m
2. index.ts:397 - Calls orch.processTick(..., "5m")
3. orchestrator.ts:6436 - Updates this.state.last5mCloseTs
```

**Severity:** 🟡 **MEDIUM - Observability**
- Log appears before state is committed
- If pulse logger runs between steps 1-3, reads stale `last5mCloseTs`

**Subsystem Ownership:** Bar Building (index.ts) and Orchestrator
**Production Symptom:** "Logs show ordering mismatch where CLOSE5M appears before last5mCloseTs and downstream state reflect it"

#### Finding B2: ROLLOVER Logged Before State Commit
**Location:** `src/orchestrator/orchestrator.ts:170` (logs) vs `src/orchestrator/orchestrator.ts:6436` (state update)

**Code Flow:**
```
1. handleMinimal1m:4318 - Detects is5mClose, logs [MINIMAL][ROLLOVER]
2. handleMinimal1m:4586 - Calls reduce5mClose (if is5mClose && lastClosed5m)
3. handleMinimal5m:6436 - Updates this.state.last5mCloseTs (called separately)
```

**Severity:** 🟡 **MEDIUM - Observability**
- ROLLOVER logged before `last5mCloseTs` updated
- Pulse logger may read stale state

**Subsystem Ownership:** Orchestrator
**Production Symptom:** Same as B1

#### Finding B3: PULSE Reads Stale State
**Location:** `src/index.ts:99-112`

**Code:**
```typescript
function logStructuredPulse(...) {
  const s = orch.getState();  // Reads state at this moment
  const pulse = {
    last5mCloseTs: s.last5mCloseTs || null,  // May be stale
    ...
  };
}
```

**Severity:** 🟡 **MEDIUM - Observability**
- Pulse runs every 60s, may catch state mid-update
- `lastLLMCallAt` and `lastLLMDecision` always null (never set)

**Subsystem Ownership:** Pulse Logger (index.ts)
**Production Symptom:** "PULSE logs show stale or missing data"

---

### C) Gating Deadlocks

**Problem:** Bias required for setup detection, setup required to establish bias, or thresholds block progression.

#### Finding C1: Setup Detection Requires Bias !== NEUTRAL
**Location:** `src/orchestrator/orchestrator.ts:2584` (in `detectSetup`)

**Code:**
```typescript
// From SETUP_AND_ENTRY_RULES.md:
// If exec.bias === "NEUTRAL", setup is forced to "NONE" (no detection run)
```

**Severity:** 🟠 **HIGH - Risk to Live Trading**
- Chicken-egg: need bias to detect setup, need setup to establish bias
- Bot can stall in NEUTRAL forever if bias never establishes

**Subsystem Ownership:** Orchestrator (setup detection)
**Production Symptom:** "Bias/phase can remain NEUTRAL even with repeated 5m closes; 'bot alive' but state machine not progressing"

**How It Produces Symptom:**
1. Bot starts with bias NEUTRAL
2. `detectSetup()` returns early (bias is NEUTRAL)
3. No setup detected, so no opportunity latched
4. Bias engine needs more bars/time to establish
5. Bot waits indefinitely

#### Finding C2: Phase Transition Requires Multiple Conditions
**Location:** `src/orchestrator/orchestrator.ts:3849`

**Code:**
```typescript
if (stable && exec.bias !== "NEUTRAL" && exec.biasConfidence !== undefined && exec.biasConfidence >= 65) {
  // Only then transition to BIAS_ESTABLISHED
}
```

**Severity:** 🟠 **HIGH - Risk to Live Trading**
- Requires: stable engine + non-NEUTRAL bias + confidence >= 65
- If any condition fails, phase stays NEUTRAL_PHASE

**Subsystem Ownership:** Orchestrator (phase management)
**Production Symptom:** "Bias/phase can remain NEUTRAL even with repeated 5m closes"

#### Finding C3: Multiple Functions Gated by Bar Length Thresholds
**Locations:** Various (see table in ALL_CODE_PROBLEMS.md Issue #13)

**Severity:** 🟡 **MEDIUM - Observability**
- Functions disabled with insufficient bars
- Bot may appear "stuck" when actually waiting for more data

**Subsystem Ownership:** Orchestrator (various functions)
**Production Symptom:** "Bot alive but state machine not progressing"

---

### D) VWAP Chop Sensitivity

**Problem:** Bias flipping on single-candle or tiny distance, especially with 1m LLM influence.

#### Finding D1: Single-Candle VWAP Comparison
**Location:** `src/orchestrator/orchestrator.ts:1750-1751`

**Code:**
```typescript
const minDist = atr ? Math.max(0.05, 0.10 * atr) : 0.05;
const farAbove = close > vwap + minDist && close > ema + minDist;
const farBelow = close < vwap - minDist && close < ema - minDist;
```

**Severity:** 🔴 **CRITICAL - Risk to Live Trading**
- No deadband - price can cross VWAP by 0.01 and flip
- `minDist` is only 0.10 * atr (very small)
- Single-candle flips cause bias engine to enter REPAIR

**Subsystem Ownership:** Bias Engine (1m-based)
**Production Symptom:** "VWAP chop flip-flops" and "LLM 1m opinions sometimes appear to set or influence bias, creating confusing bias flips around VWAP"

**How It Produces Symptom:**
1. Price at 692.50, VWAP at 692.45 (above VWAP)
2. Next 1m bar closes at 692.44 (below VWAP by 0.01)
3. Bias engine sees below VWAP, enters REPAIR
4. LLM sees flip, may nudge bias
5. Next bar back above VWAP, engine flips again
6. Rapid flip-flop creates confusion

#### Finding D2: LLM Nudge Uses Same Single-Candle Check
**Location:** `src/orchestrator/orchestrator.ts:1954-1955`

**Code:**
```typescript
const farAbove = close > vwap + minDist && close > ema + minDist;
const farBelow = close < vwap - minDist && close < ema - minDist;
```

**Severity:** 🔴 **CRITICAL - Risk to Live Trading**
- Same issue as D1, but LLM can set bias directly
- Amplifies VWAP chop effects

**Subsystem Ownership:** LLM Adapter
**Production Symptom:** Same as D1

---

### E) Trigger Not Consumed

**Problem:** Trigger alert emitted but no persistent latch or consumption in orchestrator.

#### Finding E1: Trigger Detected But Entry Blocked
**Location:** `src/orchestrator/orchestrator.ts:1242, 4992, 5985-6023`

**Code Flow:**
```
1. checkOpportunityTrigger() returns { triggered: true }
2. exec.opportunity.status = "TRIGGERED"
3. shouldBlockEntry() returns true
4. TRIGGER_BLOCKED_ALERT emitted
5. **Problem:** No pendingTrigger latch to remember trigger hit
```

**Severity:** 🟠 **HIGH - Observability/Usability**
- Trigger hit is detected and logged, but not consumed
- If entry becomes unblocked later, trigger is lost
- User sees "TRIGGER HIT" but bot doesn't enter

**Subsystem Ownership:** Orchestrator (trigger detection and entry logic)
**Production Symptom:** "Trigger detector can emit 'TRIGGER HIT' alerts while main orchestrator remains in setup=NONE / entry blocked"

**How It Produces Symptom:**
1. Trigger hits, `checkOpportunityTrigger()` returns `{ triggered: true }`
2. Entry blocked (e.g., setup=NONE, gate not triggered, risk management)
3. Alert emitted: "TRIGGER HIT but entry blocked"
4. Next tick, entry still blocked, trigger is "forgotten"
5. User sees alert but no entry happens

---

### F) Alert Routing Mismatch

**Problem:** TP/trigger detected but not emitted as a discrete user-visible event.

#### Finding F1: TP Alert Emission Has Timestamp Matching Issue
**Location:** `src/orchestrator/orchestrator.ts:6059-6084`

**Code:**
```typescript
// Line 6059: Strict timestamp matching
if (exec.lastTargetHit && exec.lastTargetHit.timestamp === ts) {
  // Emit TRADING_ALERT
}
```

**Severity:** 🟡 **MEDIUM - Observability/Usability**
- Alert only emitted if `timestamp === ts` exactly
- If timestamp doesn't match (e.g., detected on 5m close, emitted on next 1m tick), alert is lost
- Alert is emitted OUTSIDE trade management block (good - bypasses entry gating)

**Subsystem Ownership:** Orchestrator (event emission)
**Production Symptom:** "TP targets are detected but user doesn't receive a clear 'take profit hit' coaching/alert"

**How It Produces Symptom:**
1. Target hit detected on 5m close (ts=1770836099999)
2. Stored in `exec.lastTargetHit.timestamp = 1770836099999`
3. Next 1m tick arrives (ts=1770836100000)
4. Alert emission checks `exec.lastTargetHit.timestamp === ts` (1770836099999 !== 1770836100000)
5. Alert not emitted, user doesn't see TP hit

#### Finding F2: TRADING_ALERT Not in SENDABLE_TYPES
**Location:** `src/governor/messageGovernor.ts:47-54`

**Code:**
```typescript
private static readonly SENDABLE_TYPES: Set<string> = new Set([
  "MIND_STATE_UPDATED",
  "LLM_1M_OPINION",
  "GATE_ARMED",
  "OPPORTUNITY_TRIGGERED",
  "TRADE_ENTRY",
  "TRADE_EXIT",
  // TRADING_ALERT is NOT in this list!
]);
```

**Severity:** 🔴 **CRITICAL - Observability**
- `TRADING_ALERT` events are filtered out by MessageGovernor
- TP alerts never reach user

**Subsystem Ownership:** MessageGovernor
**Production Symptom:** "TP targets are detected but user doesn't receive a clear 'take profit hit' coaching/alert"

**How It Produces Symptom:**
1. TP hit detected, `TRADING_ALERT` event emitted
2. Event reaches `MessagePublisher.publishOrdered()`
3. `governor.shouldSend()` checks if event type is in SENDABLE_TYPES
4. `TRADING_ALERT` not in list, returns false
5. Event filtered out, user never sees alert

---

### G) Coaching Contradictions

**Problem:** Coaching generation not gated by bias/setup/phase.

#### Finding G1: Coaching Filtering Only Checks BEARISH + Long
**Location:** `src/orchestrator/orchestrator.ts:6254, 6337`

**Code:**
```typescript
coachLine: (exec.bias === "BEARISH" && exec.setup !== "PULLBACK_CONTINUATION" && exec.setup !== "IGNITION" && exec.llm1mCoachLine?.toLowerCase().includes("long")) 
  ? undefined 
  : exec.llm1mCoachLine,
```

**Severity:** 🟡 **MEDIUM - Observability/Usability**
- Only filters long coaching when bias is BEARISH
- Doesn't filter short coaching when bias is BULLISH
- Doesn't check phase/setup comprehensively

**Subsystem Ownership:** Orchestrator (coaching formatting)
**Production Symptom:** "Coaching can contradict bias (e.g., bias BEARISH but coaching suggests long breakout)"

**How It Produces Symptom:**
1. Bias is BEARISH, setup is NONE
2. LLM generates coaching: "Watch for long breakout above 693.45"
3. Filtering checks: bias BEARISH + setup NONE + coaching includes "long"
4. Filtering should remove it, but only checks lowercase "long"
5. If coaching says "LONG" (uppercase), it passes through
6. User sees contradictory coaching

---

### H) Phase/Setup Coupling

**Problem:** Phase classification depends on setup-derived boundaries, causing cascades.

#### Finding H1: Phase Uses Pullback Boundaries Set by Setup
**Location:** `src/orchestrator/orchestrator.ts:3858-3909`

**Code:**
```typescript
// Phase is based on price position relative to pullbackHigh/pullbackLow
// But pullbackHigh/pullbackLow are set based on setup detection
if (inZone) {
  exec.phase = "PULLBACK_IN_PROGRESS";
} else if (extended) {
  exec.phase = "EXTENSION";
}
```

**Severity:** 🟡 **MEDIUM - Observability**
- Phase depends on `pullbackHigh`/`pullbackLow` which are set by setup detection
- If setup is cleared, phase may become inconsistent
- Phase should reflect actual price behavior, not setup intent

**Subsystem Ownership:** Orchestrator (phase management)
**Production Symptom:** "Extension mis-labeled as pullback" (if setup boundaries are stale)

**How It Produces Symptom:**
1. Setup detected, `pullbackHigh`/`pullbackLow` set
2. Price moves beyond boundaries (extended)
3. Phase should be EXTENSION, but boundaries are stale
4. Phase may still show PULLBACK_IN_PROGRESS
5. User sees incorrect phase

---

## STAGE 3: PLANNING FOR STABLE IMPROVEMENTS

### Objectives and Invariants

**Must Preserve:**
1. ✅ Valid setup detection continues to work
2. ✅ Entry logic remains deterministic
3. ✅ Trade management (TP/exit) continues to function
4. ✅ Existing working behavior is not destabilized

**Must Improve:**
1. ✅ Bias stability (reduce VWAP chop flip-flops)
2. ✅ Trigger consumption (remember trigger hits when entry blocked)
3. ✅ Alert visibility (TP alerts reach user)
4. ✅ Coaching consistency (no contradictions)
5. ✅ State synchronization (logs reflect committed state)

### Architectural Implications

#### State Ownership Model

**Current (Problematic):**
- Bias: Split between LLM nudge, bias engine, 5m finalization
- Phase: Can be set by LLM nudge or reduce5mClose
- Setup: Can be set by LLM nudge or detectSetup
- State commit: Logs before state update

**Proposed (Stable):**
- Bias: Single canonical source (5m structure), LLM provides "tilt" hint only
- Phase: Only set by reduce5mClose (deterministic, price-based)
- Setup: Only set by detectSetup (5m-based)
- State commit: Update state before logging

#### Event Ordering Model

**Current (Problematic):**
- Events emitted before state commit
- Pulse logger may read stale state
- TP alerts have timestamp matching issues

**Proposed (Stable):**
- State updated synchronously before event emission
- Pulse logger reads committed state
- TP alerts emitted immediately on detection (no timestamp matching)

#### Coupling Reduction

**Current (Problematic):**
- LLM nudge directly sets bias/phase/setup
- Phase depends on setup-derived boundaries
- Coaching not fully gated

**Proposed (Stable):**
- LLM nudge only sets "tilt" hint, doesn't touch canonical bias
- Phase computed from price behavior, independent of setup
- Coaching fully gated by bias/setup/phase

### Migration Strategy

#### Phase 1: Observability (Zero Risk)
**Goal:** Add logging to understand current behavior
**Changes:**
- Add `[BIAS_SOURCE]` logs when bias is set
- Add `[STATE_COMMIT]` logs when state is updated
- Add `[TRIGGER_CONSUMED]` logs when trigger is consumed
- Add `[TP_ALERT_EMIT]` logs when TP alert is emitted
**Risk:** None (logging only)
**Validation:** Verify logs appear in production
**Rollback:** Remove logging statements

#### Phase 2: Alert Routing Fix (Low Risk)
**Goal:** Ensure TP alerts reach user
**Changes:**
- Add `TRADING_ALERT` to `MessageGovernor.SENDABLE_TYPES`
- Fix TP alert timestamp matching (use range check instead of exact match)
**Risk:** Low (only affects alert visibility)
**Validation:** Verify TP alerts appear in Telegram
**Rollback:** Remove from SENDABLE_TYPES, revert timestamp check

#### Phase 3: State Commit Ordering (Low Risk)
**Goal:** Ensure logs reflect committed state
**Changes:**
- Move `this.state.last5mCloseTs` update before `[CLOSE5M]` log
- Update `this.state.lastLLMCallAt` and `this.state.lastLLMDecision` after LLM call
**Risk:** Low (only affects log ordering)
**Validation:** Verify logs show correct state
**Rollback:** Revert order changes

#### Phase 4: Trigger Consumption (Medium Risk)
**Goal:** Remember trigger hits when entry blocked
**Changes:**
- Add `pendingTrigger` state to `MinimalExecutionState`
- Store trigger hit when entry blocked
- Consume pending trigger when entry becomes unblocked
**Risk:** Medium (affects entry logic)
**Validation:** Verify pending triggers are consumed correctly
**Rollback:** Remove `pendingTrigger` logic

#### Phase 5: VWAP Deadband (Medium Risk)
**Goal:** Reduce VWAP chop flip-flops
**Changes:**
- Add deadband to VWAP/EMA comparisons (0.15 * ATR)
- Add persistence requirement (3+ consecutive closes)
- Add cooldown after bias flip (5 minutes)
**Risk:** Medium (affects bias engine behavior)
**Validation:** Verify bias flips are more stable
**Rollback:** Revert deadband/persistence/cooldown

#### Phase 6: Bias Ownership Separation (High Risk)
**Goal:** Separate canonical bias from LLM tilt
**Changes:**
- Add `bias_5m` (canonical) and `tilt_1m` (LLM hint) to state
- Update all bias reads to use `bias_5m`
- LLM nudge only sets `tilt_1m`, doesn't touch `bias_5m`
**Risk:** High (affects core trading logic)
**Validation:** Extensive testing, verify bias stability
**Rollback:** Revert to single `bias` field

#### Phase 7: Coaching Gating (Low Risk)
**Goal:** Prevent coaching contradictions
**Changes:**
- Expand coaching filtering to check BULLISH + short
- Add phase/setup gating
- Add "observer mode" coaching when entry blocked
**Risk:** Low (only affects coaching display)
**Validation:** Verify no contradictory coaching
**Rollback:** Revert filtering logic

### Validation Strategy

#### For Each Phase:
1. **Unit Tests:** Test individual functions with known inputs
2. **Integration Tests:** Test full flow with mock data
3. **Production Logs:** Monitor logs for expected behavior
4. **Telegram Output:** Verify user-visible alerts/coaching
5. **State Consistency:** Verify state objects remain consistent

#### Specific Validation Checks:

**Phase 1 (Observability):**
- [ ] `[BIAS_SOURCE]` logs appear when bias is set
- [ ] `[STATE_COMMIT]` logs appear when state is updated
- [ ] `[TRIGGER_CONSUMED]` logs appear when trigger is consumed
- [ ] `[TP_ALERT_EMIT]` logs appear when TP alert is emitted

**Phase 2 (Alert Routing):**
- [ ] TP alerts appear in Telegram
- [ ] `TRADING_ALERT` events are not filtered by MessageGovernor
- [ ] TP alerts have correct target key, price, momentum, coaching

**Phase 3 (State Commit):**
- [ ] `[CLOSE5M]` log appears after `last5mCloseTs` is updated
- [ ] `[PULSE]` shows correct `last5mCloseTs`
- [ ] `[PULSE]` shows correct `lastLLMCallAt` and `lastLLMDecision`

**Phase 4 (Trigger Consumption):**
- [ ] Pending triggers are stored when entry blocked
- [ ] Pending triggers are consumed when entry unblocked
- [ ] No trigger hits are lost

**Phase 5 (VWAP Deadband):**
- [ ] Bias flips are less frequent
- [ ] Bias engine doesn't enter REPAIR on single-candle VWAP crosses
- [ ] Cooldown prevents rapid flip-flops

**Phase 6 (Bias Ownership):**
- [ ] `bias_5m` is canonical source for trading decisions
- [ ] `tilt_1m` only affects entry timing, not bias
- [ ] No conflicting bias sources

**Phase 7 (Coaching Gating):**
- [ ] No long coaching when bias is BEARISH (unless setup allows)
- [ ] No short coaching when bias is BULLISH (unless setup allows)
- [ ] Observer mode coaching appears when entry blocked

### Rollback Strategy

#### For Each Phase:
1. **Code Revert:** Git revert the changes
2. **State Migration:** If state schema changed, migrate back
3. **Log Monitoring:** Verify behavior returns to baseline
4. **User Communication:** Notify if user-visible behavior changes

#### Specific Rollback Procedures:

**Phase 1 (Observability):**
- Remove logging statements
- No state migration needed

**Phase 2 (Alert Routing):**
- Remove `TRADING_ALERT` from SENDABLE_TYPES
- Revert timestamp matching fix
- No state migration needed

**Phase 3 (State Commit):**
- Revert order changes
- No state migration needed

**Phase 4 (Trigger Consumption):**
- Remove `pendingTrigger` from state
- Revert consumption logic
- State migration: Remove `pendingTrigger` field

**Phase 5 (VWAP Deadband):**
- Revert deadband/persistence/cooldown
- No state migration needed

**Phase 6 (Bias Ownership):**
- Revert to single `bias` field
- State migration: Map `bias_5m` back to `bias`

**Phase 7 (Coaching Gating):**
- Revert filtering logic
- No state migration needed

---

## Summary

### Critical Findings (Must Fix)
1. **F2:** `TRADING_ALERT` not in SENDABLE_TYPES - TP alerts never reach user
2. **A1:** LLM 1m can set bias directly - creates conflicting bias sources
3. **D1/D2:** VWAP chop sensitivity - single-candle flips cause bias instability

### High Priority Findings (Should Fix)
4. **E1:** Trigger not consumed - trigger hits lost when entry blocked
5. **C1:** Setup detection requires bias - chicken-egg deadlock
6. **C2:** Phase transition requires multiple conditions - can stall in NEUTRAL

### Medium Priority Findings (Nice to Have)
7. **B1/B2:** State commit ordering - logs before state update
8. **F1:** TP alert timestamp matching - alerts may be lost
9. **G1:** Coaching contradictions - incomplete filtering
10. **H1:** Phase/setup coupling - phase depends on setup boundaries

### Recommended Implementation Order
1. Phase 1: Observability (understand current behavior)
2. Phase 2: Alert Routing Fix (critical - TP alerts)
3. Phase 3: State Commit Ordering (low risk, high value)
4. Phase 4: Trigger Consumption (medium risk, high value)
5. Phase 5: VWAP Deadband (medium risk, high value)
6. Phase 6: Bias Ownership Separation (high risk, requires careful testing)
7. Phase 7: Coaching Gating (low risk, polish)

---

**Next Steps:** Review this plan and approve phases before implementation begins.
