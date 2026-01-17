# QDA Bot - Conceptual Overview (Tightened Spec)

## 🎯 What This Bot Does

A **Telegram trading bot** for SPY ETF that:
1. **Detects trading setups** (plays)
2. **Coaches entry decisions** (rules detect → LLM validates/plans)
3. **Manages active trades** (rules compute + enforce hard stop → LLM recommends actions)
4. **Enforces strict daily schedule** (QUIET/ACTIVE modes with DST-aware ET time)
5. **Sends messages in strict order** (no interleaving, with idempotency)

---

## 🧠 Conceptual Flow (Candidates-First)

### Market State (slow context)
Computes regime, macro bias, and permissions (long/short + mode). Adds tactical bias + shock for faster directional context. This is the permission layer, not the entry trigger.

### Candidate Discovery (wide net)
`setupEngine` generates multiple candidates (not just one). Each candidate carries chart‑equivalent features (location, trend, timing, volatility, volume), structured score components, and **flags** (warnings only). **No hard blocking here**—candidates are surfaced for visibility.

> **Flags = descriptive warnings (never block).**

### LLM Evaluation (candidates-first)
LLM receives a candidate batch (rank set + optional “contrast” set of near‑misses). It ranks and selects the best candidate (`selectedCandidateId`, `rankedCandidateIds`) and returns confidence, risk notes, and preferred action.

### Execution Gate (strict, post-LLM)
Only after LLM selection, the bot applies **blockers** (execution-only hard stops):
- Direction gates (LOCKED/LEANING)
- Regime permission + CHOP/TRANSITION rules
- Risk/ATR caps, chase risk, timing thresholds
- Entry filters + guardrails  
This preserves strict execution while still surfacing ideas.

> **Blockers = execution-only (can block ARM/ENTER).**

### Timing Engine (microstructure)
Independent timing signals score entries (break/accept, retest quality, VWAP reaction, ATR normalization). Entry window opens only when timing is good; actual entry is gated by timing score. Timing is persisted as a state machine (IMPULSE → PULLBACK → ENTRY_WINDOW → IN_TRADE) to prevent “late flips.”

### Context Quality (LOW_CONTEXT / diversity)
When candidate count or diversity is low, mark **LOW_CONTEXT**. LLM still ranks; execution is tightened (scalp/pass caps, stricter thresholds) and messaging surfaces the limitation.

### Messaging (explainability first)
Every key event prints:
MARKET STATE (regime, permissions, tactical bias, plan status)
TIMING
TOP PLAY
CANDIDATES (when available)
BLOCKERS (if not armed)
This makes “why didn’t it enter?” unambiguous.

### Design Principles
- Separate what’s allowed vs. what’s seen.
- Permissions stay strict; candidate visibility is wide.
- LLM is a selector, not a gate.
- The LLM chooses; rules decide if execution is allowed.
- Timing is its own layer: regime says what; timing says when.
- Explainability is mandatory: every no‑entry ties to explicit blockers.

### In short
Your bot behaves like a pro trading assistant: it sees more setups, chooses deliberately, executes only when strictly permitted, and always explains why.

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    TELEGRAM BOT                          │
│  (Single entrypoint: src/index.ts)                      │
│  (Single publisher instance - startup assert)           │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
        ┌─────────────────────────────────┐
        │     MessageGovernor              │
        │  (Single choke point)            │
        │  - QUIET/ACTIVE mode gating      │
        │  - Dedupe key tracking           │
        │  - Rate limiting                 │
        └─────────────────────────────────┘
                          │
        ┌─────────────────┴─────────────────┐
        │                                   │
        ▼                                   ▼
┌───────────────┐                  ┌───────────────┐
│  Scheduler   │                  │ Orchestrator  │
│  (ET + DST)  │                  │ (Trade logic) │
│              │                  │               │
│ - 09:25 Plan │                  │ - Entry flow  │
│ - 09:30 ACTIVE│                  │ - Exit flow   │
│ - 16:00 QUIET│                  │ - State mgmt  │
└──────────────┘                  └───────────────┘
                                          │
                    ┌────────────────────┼────────────────────┐
                    │                    │                    │
                    ▼                    ▼                    ▼
            ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
            │   Rules      │    │     LLM      │    │  Persistence │
            │  (Math)      │    │  (Reasoning)│    │  (State)     │
            │              │    │              │    │              │
            │ - Distances  │    │ - Pattern    │    │ - Active play│
            │ - Risk/Reward│    │   analysis   │    │ - Dedupe keys│
            │ - Hard stops │    │ - Probability│    │ - Last plan  │
            │ - Boundaries │    │ - Coaching   │    │              │
            └──────────────┘    └──────────────┘    └──────────────┘
```

---

## 🔒 Hard Boundaries vs LLM Final Decision

### Rules Hard Boundaries (Non-Negotiable)

These **cannot** be violated by LLM:

1. **Hard Stop on Close**
   - LONG: `close <= stop` → immediate PLAY_CLOSED
   - SHORT: `close >= stop` → immediate PLAY_CLOSED
   - Bypasses LLM completely

2. **Market Hours Gating**
   - QUIET mode: blocks all trading messages
   - ACTIVE mode: allows trading messages
   - Enforced by MessageGovernor

3. **Max Risk %** (optional but recommended)
   - If position risk exceeds X% of account → force exit
   - Enforced before LLM call

4. **Max Daily Loss** (optional but recommended)
   - If daily P&L < -X → stop trading for day
   - Enforced before new play creation

5. **Max Trades/Day** (optional but recommended)
   - If trades today >= X → stop creating new plays
   - Enforced before play creation

6. **Cooldown Windows** (rate limiting)
   - After major alert → suppress low-priority messages for X seconds
   - LLM coach update max 1 per 5m bar
   - Enforced by MessageGovernor

### LLM Final Decision (Inside Safe Sandbox)

LLM can make final decisions **only** within hard boundaries:

- ✅ **HOLD** - continue holding (if not violating hard stop)
- ✅ **TAKE_PROFIT** - exit with profit (explicit instruction required)
- ✅ **STOP_OUT** - exit to avoid loss (if not already hit hard stop)
- ✅ **TIGHTEN_STOP** - move stop to breakeven
- ✅ **SCALE_OUT** - take partial profit (explicit instruction required)
- ✅ **REDUCE** - reduce position size
- ✅ **ADD** - add to position (if within max risk)

**LLM cannot:**
- ❌ Override hard stop on close
- ❌ Trade during QUIET mode
- ❌ Exceed max risk %
- ❌ Violate daily loss limits
- ❌ Create plays beyond max trades/day

---

## 🔄 Decision Flow: Two Paths (Clarified)

### Path 1: Entry (Rules Detect → LLM Validates/Plans)

```
1. Rules detect setup
   └─> PLAY_ARMED event
   └─> Play state: HUNTING → ARMED
   └─> LLM cadence: None (ARMED state)
   
2. Rules detect entry opportunity
   └─> ENTRY_FOUND event (entry signal triggered)
   └─> Play state: ARMED → ENTRY_WINDOW
   └─> LLM cadence: Verify once per entry
   
3. Rules provide timing
   └─> TIMING_COACH event
   
4. LLM validates setup (advisory, can veto)
   └─> LLM_VERIFY event
   └─> LLM checks: legitimacy, follow-through probability
   └─> LLM can: PASS (veto), WAIT (downgrade), or approve
   
5. LLM creates plan (if approved)
   └─> TRADE_PLAN event
   └─> Action: GO_ALL_IN | SCALP | WAIT | PASS
   └─> Position size: FULL | SCOUT | CUSTOM
```

**Event Ladder:**
- `PLAY_ARMED` = Setup identified
- `ENTRY_FOUND` = Entry opportunity now (rules trigger)
- `TIMING_COACH` = Rules-based timing guidance
- `LLM_VERIFY` = LLM validates legitimacy
- `TRADE_PLAN` = LLM provides action plan

**Key Point:** LLM is **advisory** but can veto or downgrade sizing. Rules detect, LLM validates/plans.

---

### Path 2: Management (Rules Compute + Enforce → LLM Recommends)

```
1. Rules compute telemetry (all metrics)
   └─> Distances, Risk/Reward, R-multiples
   └─> Stop threatened status
   └─> Target hit status
   
2. Rules check hard stop on close (FIRST)
   └─> If close <= stop (LONG) → EXIT immediately (bypasses LLM)
   └─> If close >= stop (SHORT) → EXIT immediately (bypasses LLM)
   └─> If hit → PLAY_CLOSED, return
   
3. Rules enforce safety constraints
   └─> Check max risk %, max daily loss, cooldowns
   └─> If violated → force exit, return
   
4. LLM receives structured telemetry JSON
   └─> LLM analyzes pattern
   └─> LLM calculates probability of success
   └─> LLM makes decision: HOLD | TAKE_PROFIT | STOP_OUT | etc.
   └─> LLM_COACH_UPDATE event
   
5. LLM decision is final (within boundaries)
   └─> If HOLD → continue holding
   └─> If TAKE_PROFIT → exit (with explicit instruction)
   └─> If STOP_OUT → exit
   └─> If SCALE_OUT → partial exit (with explicit instruction)
   └─> PLAY_CLOSED event (if exit)
```

**Key Point:** Rules compute + enforce hard boundaries FIRST, then LLM recommends actions inside the safe sandbox.

---

## 📊 Play Lifecycle + Position State

### Play States

```typescript
type PlayState = 
  | "HUNTING"        // No active play, looking for setup
  | "ARMED"          // Setup detected, waiting for entry signal
  | "ENTRY_WINDOW"   // Entry signal found, evaluating entry
  | "ENTERED"        // Position opened (entered = true, entryMode dependent)
  | "MANAGING"       // Active position, managing trade
  | "CLOSED"         // Trade closed
```

### Entry Mode (Alerts-Only vs Execution)

```typescript
type EntryMode = 
  | "MANUAL_CONFIRM"  // Default: Bot never assumes fills, requires manual confirmation
  | "ASSUME_ON_TOUCH" // Optional: Bot assumes entry when price touches entry zone
```

**Critical:** Bot is **alerts-only** by default:
- ✅ Bot **never places orders**
- ✅ Bot **never assumes fills** (unless ASSUME_ON_TOUCH enabled)
- ✅ `ENTERED` state only when:
  - Manual confirmation received, OR
  - `entryMode = ASSUME_ON_TOUCH` and price touches entry zone

**Why:** Prevents fake coaching on positions that don't exist.

### Position State Fields

```typescript
interface PositionState {
  entered: boolean;              // Has position been entered? (entryMode dependent)
  entryPrice: number | null;      // Actual entry fill price (or assumed if ASSUME_ON_TOUCH)
  entryMode: "MANUAL_CONFIRM" | "ASSUME_ON_TOUCH";
  positionSize: "SCOUT" | "FULL" | "CUSTOM";
  customSize?: number;            // If CUSTOM, actual size
  lastDecisionAt: number;         // Timestamp of last LLM decision
  lastCoachUpdateAt: number;     // Timestamp of last coach update
  unrealizedR: number;           // Unrealized P&L in R-multiples
  timeInTrade: number;           // Minutes since entry
}
```

### LLM Cadence by State

```typescript
const LLM_CADENCE = {
  HUNTING: "none",              // No LLM calls
  ARMED: "none",                // No LLM calls (waiting for entry signal)
  ENTRY_WINDOW: "once_per_entry", // LLM verify only once per entry opportunity
  ENTERED: "every_5m_close",     // LLM coach update every 5m bar close
  MANAGING: "every_5m_close",   // LLM coach update every 5m bar close
  CLOSED: "none"                // No LLM calls
};
```

**Prevents spam and confusion:**
- ✅ No coaching loop in ARMED state
- ✅ LLM verify only once per entry opportunity
- ✅ Regular coaching only when position exists (ENTERED/MANAGING)

### State Transitions

```
HUNTING → ARMED (setup detected)
ARMED → ENTERED (entry triggered, entered = true)
ENTERED → MANAGING (actively managing position)
MANAGING → CLOSED (exit triggered)
CLOSED → HUNTING (return to hunting)
```

**Critical:** Coaching only triggers when `entered = true` (position exists).

---

## 🔑 Idempotency + Dedupe Keys

### Universal Dedupe Key Format

```typescript
dedupeKey = `${playId}_${eventType}_${barTs}`
```

**Examples:**
- `play_1234567890_PLAY_ARMED_1234567890`
- `play_1234567890_STOP_THREATENED_1234568000`
- `plan_of_day_2025-01-15`

### Dedupe Storage

```typescript
interface DedupeStore {
  sentKeys: Set<string>;           // In-memory (last N keys)
  lastPlanOfDayDate: string;       // "YYYY-MM-DD" (ET date, not UTC)
  persistedKeys?: string[];         // Optional: persist to file/DB
}
```

**Plan-of-Day Idempotency:**
- ✅ `lastPlanOfDayDate` must be **date-only ET** (not UTC)
- ✅ Check: `if (lastPlanOfDayDate === todayET) → skip`
- ✅ Prevents resend on Railway restart at 9:26 ET
- ✅ Persisted to state file

### What Gets Deduped

- ✅ `PLAY_ARMED` - only once per play
- ✅ `ENTRY_ELIGIBLE` - only once per play
- ✅ `STOP_THREATENED` - only once per play (idempotent flag)
- ✅ `LLM_COACH_UPDATE` - max 1 per 5m bar (cooldown)
- ✅ `PLAN_OF_DAY` - once per day (date check)

### Implementation

```typescript
function shouldSend(event: DomainEvent, dedupeStore: DedupeStore): boolean {
  const key = `${event.instanceId}_${event.type}_${event.timestamp}`;
  
  if (dedupeStore.sentKeys.has(key)) {
    return false; // Already sent
  }
  
  dedupeStore.sentKeys.add(key);
  return true;
}
```

---

## ⏱️ Rate Limits & Cooldown Windows

### Micro-Cooldowns

```typescript
interface CooldownRules {
  afterMajorAlert: number;        // 30 seconds - suppress low-priority after major alert
  llmCoachUpdate: number;         // 5 minutes - max 1 per 5m bar
  stopThreatened: number;         // 1 minute - don't spam if already threatened
  entryEligible: number;          // 5 minutes - don't re-trigger if still in zone
}
```

### LLM Call Caching

```typescript
interface LLMCache {
  lastCallBarTs: number;          // Last bar timestamp LLM was called
  lastCallResult: LLMResponse;    // Cached result
  cacheValidUntil: number;        // Cache expires on next bar
}
```

**Rule:** Don't call LLM repeatedly while conditions haven't changed (same barTs).

---

## 📦 Telemetry Packet Schema (Contract)

### Input to LLM (Structured JSON)

```typescript
interface TelemetryPacket {
  // Play metadata
  play: {
    id: string;
    direction: "LONG" | "SHORT";
    mode: "FULL" | "SCOUT";
    score: number;
    grade: string;
  };
  
  // Bar data
  bar: {
    ts: number;                   // Bar timestamp
    close: number;                // 1m close
    open?: number;                // Optional: 1m OHLCV
    high?: number;
    low?: number;
    volume?: number;
    last5mClose?: number;         // Last 5m close (for context)
  };
  
  // Position state
  position: {
    entered: boolean;
    entryPrice: number | null;
    positionSize: "SCOUT" | "FULL" | "CUSTOM";
    unrealizedR: number;          // P&L in R-multiples
    timeInTrade: number;           // Minutes
  };
  
  // Rules-computed metrics
  context: {
    // Prices
    stop: number;
    targets: { t1: number; t2: number; t3: number };
    
    // Distances (dollar and percent)
    distanceToStopDollar: number;
    distanceToStopPct: number;
    distanceToT1Dollar: number;
    distanceToT1Pct: number;
    distanceToT2Dollar: number;
    distanceToT2Pct: number;
    distanceToT3Dollar: number;
    distanceToT3Pct: number;
    
    // Risk/Reward
    risk: number;                  // |entry - stop|
    rewardT1: number;
    rewardT2: number;
    rewardT3: number;
    rr_t1: number;                 // R-multiple to T1
    rr_t2: number;
    rr_t3: number;
    
    // Status booleans
    stopThreatened: boolean;       // Within 0.25R of stop
    targetHit: "T1" | "T2" | "T3" | null;
    nearTarget: "T1" | "T2" | "T3" | null;
    profitPercent: number;
    
    // Market context (optional)
    vwap?: number;
    ema20?: number;
    ema50?: number;
    atr?: number;
    volatilityRegime?: "LOW" | "MEDIUM" | "HIGH";
    sessionTime?: number;          // Minutes since 09:30 ET
  };
  
  // Events since last update
  eventsSinceLast: {
    t1Hit?: boolean;
    stopThreatened?: boolean;
    nearTarget?: boolean;
  };
}
```

### LLM Output Schema (Strict)

```typescript
interface LLMResponse {
  action: "HOLD" | "TAKE_PROFIT" | "STOP_OUT" | "REDUCE" | "ADD" | "WAIT";
  confidence: number;              // 0-100
  probability_followthrough: number; // 0-100
  notes: string[];                 // Array of reasoning notes
  invalid_if?: string;             // Optional: rule that would invalidate this
  specificPrice?: number;          // If action requires a price
  instruction?: string;            // Explicit instruction (e.g., "Take partial at T1, move stop to X")
}
```

---

## 🔄 Per-Bar Loop (Exact Pseudocode)

### 1m Bar Processing

```typescript
async function processTick(bar: { ts: number; close: number; ... }) {
  // 1. Rules compute telemetry
  const telemetry = rules.computeTelemetry(play, bar, position);
  
  // 2. Hard stop check (FIRST - bypasses everything)
  if (rules.isStopHitOnClose(play, bar.close)) {
    emit("PLAY_CLOSED", {
      reason: "Hard stop hit on close",
      result: "LOSS",
      exitType: "STOP_HIT"
    });
    return; // No LLM call
  }
  
  // 3. Rules enforce safety constraints
  if (rules.violatesMaxRisk(position, telemetry)) {
    emit("PLAY_CLOSED", {
      reason: "Max risk exceeded",
      result: "LOSS",
      exitType: "RISK_LIMIT"
    });
    return; // No LLM call
  }
  
  if (rules.violatesMaxDailyLoss(dailyPnL)) {
    // Stop trading for day, but don't exit current position
    setMode("QUIET");
    return;
  }
  
  // 4. Check cooldowns
  if (cooldownManager.isInCooldown(play.id, "LLM_COACH_UPDATE")) {
    return; // Skip LLM call
  }
  
  // 5. Check LLM cache
  if (llmCache.isValid(bar.ts)) {
    // Use cached result
    const cached = llmCache.get();
    processLLMDecision(cached);
    return;
  }
  
  // 6. Call LLM with telemetry
  const llmResponse = await llmService.getCoachingUpdate(telemetry);
  
  // 7. Cache LLM result
  llmCache.set(bar.ts, llmResponse);
  
  // 8. Process LLM decision
  processLLMDecision(llmResponse);
  
  // 9. Emit events
  emit("LLM_COACH_UPDATE", llmResponse);
  
  if (llmResponse.action === "TAKE_PROFIT" || llmResponse.action === "STOP_OUT") {
    emit("PLAY_CLOSED", {
      reason: llmResponse.instruction || llmResponse.action,
      result: llmResponse.action === "TAKE_PROFIT" ? "WIN" : "LOSS",
      exitType: llmResponse.action
    });
  }
}
```

### 5m Bar Processing (LLM Coach Update)

```typescript
async function process5mBar(bar: { ts: number; close: number; ... }) {
  // Only trigger if:
  // 1. Position is entered
  // 2. Not in cooldown
  // 3. Bar timestamp is 5m mark
  
  if (!position.entered) return;
  if (cooldownManager.isInCooldown(play.id, "LLM_COACH_UPDATE")) return;
  if (bar.ts % 300000 !== 0) return; // Not 5m mark
  
  const telemetry = rules.computeTelemetry(play, bar, position);
  const llmResponse = await llmService.getCoachingUpdate(telemetry);
  
  emit("LLM_COACH_UPDATE", llmResponse);
  cooldownManager.setCooldown(play.id, "LLM_COACH_UPDATE", 300000); // 5 minutes
}
```

---

## 💾 Persistence (Minimal)

### State File Schema

```typescript
interface PersistedState {
  activePlay: Play | null;
  positionState: PositionState | null;
  sentDedupKeys: string[];         // Last N keys (e.g., 1000)
  lastPlanOfDayDate: string;       // "YYYY-MM-DD"
  dailyPnL: number;                // Daily P&L tracking
  tradesToday: number;              // Trade count
  lastTickAt: number;               // Last processed bar timestamp
}
```

### Persistence Strategy

```typescript
// On state change:
function persistState(state: PersistedState) {
  const file = "state.json";
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

// On startup:
function loadState(): PersistedState {
  if (fs.existsSync("state.json")) {
    return JSON.parse(fs.readFileSync("state.json", "utf-8"));
  }
  return defaultState();
}
```

**Benefits:**
- ✅ No duplicate plan-of-day on restart
- ✅ Remembers active play
- ✅ Preserves dedupe memory
- ✅ Tracks daily P&L across restarts

---

## 📋 TAKE_PROFIT Definition (Explicit)

### TAKE_PROFIT Action Schema

```typescript
interface TakeProfitInstruction {
  action: "TAKE_PROFIT";
  type: "FULL" | "PARTIAL" | "SCALE_OUT";
  
  // If PARTIAL or SCALE_OUT:
  partialAmount?: number;          // Percentage or dollar amount
  target?: "T1" | "T2" | "T3";    // Which target to take
  
  // If SCALE_OUT:
  newStop?: number;                // Move stop to X after scaling
  trailStop?: boolean;             // Trail stop after partial
  
  instruction: string;              // Explicit: "Take partial at T1, move stop to breakeven"
}
```

### Examples

```typescript
// Full exit
{
  action: "TAKE_PROFIT",
  type: "FULL",
  instruction: "Exit full position now at current price"
}

// Partial at T1
{
  action: "TAKE_PROFIT",
  type: "PARTIAL",
  partialAmount: 0.5,              // 50%
  target: "T1",
  instruction: "Take 50% at T1, hold runner to T2"
}

// Scale out with stop management
{
  action: "TAKE_PROFIT",
  type: "SCALE_OUT",
  partialAmount: 0.33,             // 33%
  target: "T1",
  newStop: 504.50,                 // Move stop to breakeven
  instruction: "Take 1/3 at T1, move stop to $504.50, hold 2/3 to T2"
}
```

---

## ⏰ Time Correctness (ET + DST)

### DST-Aware ET Time

```typescript
import { zonedTimeToUtc, utcToZonedTime } from 'date-fns-tz';

const ET_TIMEZONE = 'America/New_York';

function getCurrentET(): Date {
  return utcToZonedTime(new Date(), ET_TIMEZONE);
}

function isInETRange(startHour: number, startMinute: number, 
                     endHour: number, endMinute: number): boolean {
  const now = getCurrentET();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;
  
  // Handle wrap-around (e.g., 16:00 to 09:24)
  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}
```

**Benefits:**
- ✅ Automatically handles DST shifts
- ✅ No manual updates twice a year
- ✅ Accurate ET time regardless of server timezone

---

## 🛡️ Single Publisher Guard (Enforceable)

### Runtime Guard (Global)

```typescript
// Enforce singleton at runtime
if ((globalThis as any).__publisherInitialized) {
  throw new Error("Duplicate MessagePublisher instance detected. Only one instance allowed.");
}
(globalThis as any).__publisherInitialized = true;

class MessagePublisher {
  constructor(...) {
    // Guard already checked at module level
  }
}
```

### Architecture Enforcement

```typescript
// In index.ts (single entrypoint):
const publisher = new MessagePublisher(...); // Only one instance

// All message sending goes through this single instance
// Any attempt to create second instance will throw at startup
```

**Benefits:**
- ✅ **Real anti-relapse weapon** - crashes on duplicate
- ✅ Prevents accidental duplicate publishers
- ✅ Single point of control
- ✅ Easier to debug message issues
- ✅ Enforced at runtime, not just convention

---

## 📨 Event Types & Schemas

### Event Type Enum

```typescript
type DomainEventType =
  | "PLAY_ARMED"           // Setup detected
  | "ENTRY_FOUND"          // Entry signal triggered (rules)
  | "TIMING_COACH"         // Rules-based timing
  | "LLM_VERIFY"           // LLM validates setup
  | "TRADE_PLAN"           // LLM creates plan
  | "LLM_COACH_UPDATE"     // LLM coaching during trade
  | "STOP_THREATENED"      // Warning (not exit)
  | "PLAY_CLOSED"          // Trade closed
  | "PLAN_OF_DAY";         // Daily plan
```

**Event Ladder (Entry Flow):**
1. `PLAY_ARMED` - Setup identified
2. `ENTRY_FOUND` - Entry opportunity now (rules trigger)
3. `TIMING_COACH` - Rules-based timing guidance
4. `LLM_VERIFY` - LLM validates legitimacy
5. `TRADE_PLAN` - LLM provides action plan

### Event Schema

```typescript
interface DomainEvent {
  type: DomainEventType;
  timestamp: number;
  instanceId: string;
  dedupeKey: string;              // Universal dedupe key
  data: {
    play?: Play;
    position?: PositionState;
    telemetry?: TelemetryPacket;
    llmResponse?: LLMResponse;
    reason?: string;
    result?: "WIN" | "LOSS";
    exitType?: "STOP_HIT" | "TAKE_PROFIT" | "STOP_OUT" | "RISK_LIMIT";
  };
}
```

---

## 🎯 Key Principles (Updated)

### 1. Hard Boundaries First, LLM Second

- ✅ Rules enforce hard boundaries (non-negotiable)
- ✅ LLM makes final decisions inside safe sandbox
- ✅ LLM cannot violate hard boundaries

### 2. State Management

- ✅ Play lifecycle tracked explicitly
- ✅ Position state (entered, entryPrice, size)
- ✅ Idempotency flags prevent duplicate events

### 3. Idempotency Everywhere

- ✅ Dedupe keys for all events
- ✅ Cooldown windows prevent spam
- ✅ LLM call caching prevents redundant calls

### 4. Structured Contracts

- ✅ Telemetry packet schema (input to LLM)
- ✅ LLM response schema (output from LLM)
- ✅ Event schemas (all events)

### 5. Persistence

- ✅ State persisted to file
- ✅ Survives restarts
- ✅ Prevents duplicate messages

### 6. Time Correctness

- ✅ DST-aware ET time
- ✅ Accurate schedule enforcement

### 7. Single Publisher

- ✅ Only one publisher instance
- ✅ Startup assert prevents duplicates

---

## 📁 File Structure (Updated)

```
src/
├── index.ts                 # Single entrypoint (startup assert)
├── types.ts                 # Type definitions (with PositionState)
├── orchestrator/
│   └── orchestrator.ts     # Main trade logic (per-bar loop)
├── rules/
│   └── stopProfitRules.ts  # Deterministic math + hard boundaries
├── llm/
│   └── llmService.ts       # LLM API calls (telemetry packet)
├── governor/
│   └── messageGovernor.ts  # Message gating + dedupe + rate limits
├── scheduler/
│   └── scheduler.ts        # ET time management (DST-aware)
├── persistence/
│   └── stateManager.ts     # State persistence (file-based)
├── telegram/
│   ├── telegram.ts        # Bot initialization
│   └── messagePublisher.ts # Message formatting (single instance)
└── commands.ts             # /status command
```

---

## 🚀 Complete Flow Example (Updated)

### Scenario: New Play Detected

```
1. Price enters entry zone
   └─> Orchestrator detects setup
   └─> Play state: HUNTING → ARMED
   
2. Rules compute play parameters
   └─> Entry zone, stop, targets
   
3. Generate dedupe key
   └─> dedupeKey = `${playId}_PLAY_ARMED_${barTs}`
   
4. Check dedupe store
   └─> If already sent → skip
   └─> If not sent → continue
   
5. Events generated (same tick):
   └─> PLAY_ARMED (with dedupe key)
   └─> TIMING_COACH
   └─> LLM_VERIFY
   └─> TRADE_PLAN
   
6. MessageGovernor checks:
   └─> Mode (QUIET/ACTIVE)
   └─> Dedupe key
   └─> Cooldown windows
   
7. MessagePublisher sends in order
   └─> All 4 messages sent sequentially
   └─> Store dedupe keys
   
8. Persist state
   └─> Save activePlay to file
```

### Scenario: Active Trade Management

```
1. New 1m candle closes
   └─> Orchestrator.processTick() called
   
2. Load persisted state
   └─> Restore activePlay, positionState
   
3. Rules compute telemetry
   └─> All metrics pre-computed
   
4. Hard stop check (FIRST)
   └─> If hit → exit immediately (bypass LLM)
   └─> Persist state, return
   
5. Safety constraints check
   └─> Max risk, max daily loss
   └─> If violated → exit, return
   
6. Check cooldowns
   └─> If in cooldown → skip LLM, return
   
7. Check LLM cache
   └─> If valid → use cached result
   └─> If invalid → call LLM
   
8. LLM receives telemetry packet
   └─> Structured JSON with all metrics
   └─> LLM analyzes and decides
   
9. Cache LLM result
   └─> Store for this barTs
   
10. Process LLM decision
    └─> If TAKE_PROFIT → explicit instruction required
    └─> If STOP_OUT → exit
    └─> If HOLD → continue
    
11. Emit events
    └─> LLM_COACH_UPDATE (with dedupe key)
    └─> PLAY_CLOSED (if exit)
    
12. Persist state
    └─> Update activePlay, positionState
    └─> Update dedupe keys
```

---

## 🧪 Testing & Verification

### Verification Tests

```bash
npm run test:stop    # Verify stop logic formulas
npm run test:llm     # Test LLM coaching scenarios
npm run verify       # Check for forbidden patterns
npm run test:state   # Test state persistence
```

### What Gets Tested

1. **Stop Logic**
   - Wick doesn't trigger stop
   - Close triggers stop correctly
   - Stop threatened warning (no exit)

2. **LLM Scenarios**
   - Profit target reached
   - Stop threatened
   - Strong profit (scale out)
   - Breakeven opportunity

3. **State Management**
   - Play lifecycle transitions
   - Position state tracking
   - Idempotency (no duplicate events)

4. **Persistence**
   - State survives restart
   - Dedupe keys preserved
   - No duplicate plan-of-day

5. **Code Quality**
   - No legacy patterns
   - No heartbeat messages
   - Single entrypoint
   - Single publisher instance

---

## 📝 Summary

This bot is **mechanical, verifiable, and auditable**:

- ✅ **Hard boundaries** enforced first (non-negotiable)
- ✅ **LLM decisions** final within safe sandbox
- ✅ **State management** explicit (play lifecycle, position state)
- ✅ **Idempotency** everywhere (dedupe keys, cooldowns)
- ✅ **Structured contracts** (telemetry packet, LLM response)
- ✅ **Persistence** (survives restarts)
- ✅ **Time correctness** (DST-aware ET time)
- ✅ **Single publisher** (startup assert)

All components work together to create a **robust, production-ready trading bot** that uses LLM for coaching but enforces hard rules for safety and prevents chaos through state management, idempotency, and auditability.
