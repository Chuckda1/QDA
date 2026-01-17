# QDA Bot - Step-by-Step Implementation Plan

## Overview

This plan breaks down the production-grade bot architecture into **5 phases**, ensuring the repo never becomes chaotic again.

**Principle:** Each phase is **complete and testable** before moving to the next.

---

## Phase 1: Core Foundation (State + Types)

### Goal
Establish the foundation: types, state management, and basic structure.

### Tasks

1. **Update Types** (`src/types.ts`)
   - Add `PlayState` enum (HUNTING, ARMED, ENTRY_WINDOW, ENTERED, MANAGING, CLOSED)
   - Add `EntryMode` type (MANUAL_CONFIRM, ASSUME_ON_TOUCH)
   - Add `PositionState` interface
   - Add `ENTRY_FOUND` to `DomainEventType`
   - Update `Play` interface with state fields

2. **Create State Manager** (`src/persistence/stateManager.ts`)
   - `loadState()` - Load from `state.json`
   - `saveState()` - Persist to `state.json`
   - `PersistedState` interface
   - Default state initialization

3. **Create Dedupe Store** (`src/governor/dedupeStore.ts`)
   - `DedupeStore` class
   - `generateKey()` - `${playId}_${eventType}_${barTs}`
   - `hasSent()` - Check if key exists
   - `markSent()` - Add key to store
   - `cleanup()` - Remove old keys (keep last 1000)

4. **Update Orchestrator** (`src/orchestrator/orchestrator.ts`)
   - Add `playState` field to `BotState`
   - Add `positionState` field to `BotState`
   - Initialize from persisted state on startup

### Acceptance Criteria
- ✅ Types compile without errors
- ✅ State loads/saves to `state.json`
- ✅ Dedupe keys generate correctly
- ✅ Play state transitions work

### Test
```bash
npm run test:state
```

---

## Phase 2: Hard Boundaries + Rules Engine

### Goal
Implement hard boundaries and deterministic rules engine.

### Tasks

1. **Update StopProfitRules** (`src/rules/stopProfitRules.ts`)
   - Add `checkHardStop()` - Returns true if close crosses stop
   - Add `checkMaxRisk()` - Returns true if risk exceeds limit
   - Add `checkMaxDailyLoss()` - Returns true if daily loss exceeded
   - Add `checkMaxTrades()` - Returns true if max trades reached
   - Update `getContext()` - Returns full telemetry packet

2. **Create Safety Constraints** (`src/rules/safetyConstraints.ts`)
   - `SafetyConstraints` class
   - `maxRiskPercent: number` (default: 2%)
   - `maxDailyLoss: number` (default: -5%)
   - `maxTradesPerDay: number` (default: 10)
   - `checkAll()` - Returns violations array

3. **Update Orchestrator** (`src/orchestrator/orchestrator.ts`)
   - Hard stop check FIRST (before LLM)
   - Safety constraints check (after hard stop)
   - Return early if hard boundaries violated

### Acceptance Criteria
- ✅ Hard stop triggers on close (not wick)
- ✅ Safety constraints prevent violations
- ✅ All metrics computed deterministically
- ✅ Telemetry packet matches schema

### Test
```bash
npm run test:stop
npm run test:boundaries
```

---

## Phase 3: LLM Integration + Telemetry

### Goal
Integrate LLM with structured telemetry packet and response schema.

### Tasks

1. **Update LLMService** (`src/llm/llmService.ts`)
   - Update `buildCoachingPrompt()` - Use telemetry packet schema
   - Parse LLM response to strict schema
   - Handle TAKE_PROFIT instruction parsing
   - Cache LLM calls per barTs

2. **Create Telemetry Builder** (`src/orchestrator/telemetryBuilder.ts`)
   - `buildTelemetryPacket()` - Assembles full packet
   - Includes: play, bar, position, context, eventsSinceLast
   - Validates all required fields

3. **Update Orchestrator** (`src/orchestrator/orchestrator.ts`)
   - Build telemetry packet before LLM call
   - Check LLM cache before calling
   - Process LLM response according to schema
   - Handle TAKE_PROFIT instructions (FULL, PARTIAL, SCALE_OUT)

4. **LLM Cadence Enforcement** (`src/orchestrator/orchestrator.ts`)
   - Check play state before LLM call
   - ARMED: no LLM calls
   - ENTRY_WINDOW: LLM verify once per entry
   - ENTERED/MANAGING: LLM coach update every 5m

### Acceptance Criteria
- ✅ Telemetry packet matches schema exactly
- ✅ LLM response parsed to strict schema
- ✅ LLM cadence enforced by state
- ✅ TAKE_PROFIT instructions parsed correctly

### Test
```bash
npm run test:llm
npm run test:telemetry
```

---

## Addendum: Candidates-First LLM Visibility (Chart-Equivalent Features)

### Goal
Ensure the LLM sees the same chart context a human uses by sending a rich candidates list,
while keeping execution gates strict and separate from candidate discovery.

### Architecture Rule
**Tier A (hard safety only) → Tier B (candidate generation) → Tier C (execution gates after LLM)**

### Candidate Payload Requirements
Send **3–12 candidates** per evaluation, each including:
1. **Identity + Levels**
   - `setupType`, `direction`, `timeframe`, `anchorTimeframe`
   - `trigger`, `entryZone`, `stop`, `targets`
2. **Score + Components**
   - `score.total`
   - `score.components` (structure, momentum, location, volatility, pattern quality, risk)
3. **Feature Bundle (chart representation)**
   - Location: `priceVsVWAP.atR`, `priceVsEMA20.atR`, `inValueZone`, `extendedFromMean`
   - Trend/structure: `structure`, `vwapSlopeAtr`, `ema9SlopeAtr`, `ema20SlopeAtr`, `emaAlignment`
   - Impulse/pullback: `impulseAtr`, `pullbackDepthAtr`, `reclaimSignal`, `barsSinceImpulse`, `barsInPullback`
   - Volatility/regime: `atr`, `atrSlope`, `regime15m`, `regime5mProvisional`, `confidence`, `tacticalBias`
   - Volume: `relVolume`, `impulseVolVsPullbackVol`
4. **Flags (warnings, not blockers)**
   - `EXTENDED`, `WEAK_RECLAIM`, `LOW_RVOL`, `LATE_ENTRY`, `CHOP_RISK`, `WICKY`, `COUNTER_ANCHOR`

### LLM Flow
1. **Always build candidates** (no pruning for score below floor).
2. **Run LLM** on the candidates list even if some are low quality.
3. **Apply execution gates after LLM**:
   - permissions/regime
   - entry filters
   - sizing rules
   - timing confirmation

### Messaging Expectations
- **SETUP_CANDIDATES** (quiet, frequent): top 3–5 candidates with score + flags.
- **LLM_PICK**: ranked picks with short rationale.
- **EXECUTION_DECISION**: ARM/PASS with explicit blockers after LLM selection.

### Acceptance Criteria
- ✅ LLM receives multi-candidate payload with chart-equivalent features
- ✅ Hard blockers only applied after LLM selection
- ✅ Telegram shows candidate visibility even when no trade is armed

---

## Phase 4: Message Pipeline + Idempotency

### Goal
Implement message pipeline with idempotency, cooldowns, and single publisher guard.

### Tasks

1. **Update MessageGovernor** (`src/governor/messageGovernor.ts`)
   - Integrate `DedupeStore`
   - Check dedupe key before sending
   - Enforce cooldown windows
   - Track last sent keys

2. **Create Cooldown Manager** (`src/governor/cooldownManager.ts`)
   - `CooldownManager` class
   - `setCooldown(playId, eventType, duration)`
   - `isInCooldown(playId, eventType)` - Returns boolean
   - Cooldown rules:
     - After major alert: 30 seconds
     - LLM coach update: 5 minutes
     - Stop threatened: 1 minute
     - Entry eligible: 5 minutes

3. **Update MessagePublisher** (`src/telegram/messagePublisher.ts`)
   - Add singleton guard (global check)
   - Integrate with MessageGovernor
   - Format events with dedupe keys
   - Handle TAKE_PROFIT instruction formatting

4. **Update Orchestrator** (`src/orchestrator/orchestrator.ts`)
   - Generate dedupe keys for all events
   - Check cooldowns before emitting events
   - Update play state transitions
   - Emit ENTRY_FOUND event (not ENTRY_ELIGIBLE)

5. **Plan-of-Day Idempotency** (`src/scheduler/scheduler.ts`)
   - Check `lastPlanOfDayDate` (ET date)
   - Skip if already sent today
   - Update date after sending
   - Persist to state file

### Acceptance Criteria
- ✅ Single publisher guard throws on duplicate
- ✅ Dedupe keys prevent duplicate messages
- ✅ Cooldowns prevent spam
- ✅ Plan-of-day sent once per day (ET date)
- ✅ ENTRY_FOUND event emitted correctly

### Test
```bash
npm run test:dedupe
npm run test:cooldowns
npm run test:publisher
```

---

## Phase 5: Entry Flow + State Transitions

### Goal
Complete entry flow with proper state transitions and entry mode handling.

### Tasks

1. **Update Orchestrator Entry Flow** (`src/orchestrator/orchestrator.ts`)
   - Detect setup → `PLAY_ARMED` → state: ARMED
   - Detect entry signal → `ENTRY_FOUND` → state: ENTRY_WINDOW
   - LLM verify → `LLM_VERIFY` (once per entry)
   - LLM plan → `TRADE_PLAN`
   - Handle entry mode:
     - MANUAL_CONFIRM: wait for confirmation
     - ASSUME_ON_TOUCH: auto-enter when price touches zone

2. **Create Entry Handler** (`src/orchestrator/entryHandler.ts`)
   - `handleEntryFound()` - Process entry signal
   - `handleManualConfirm()` - Process manual confirmation
   - `handleAssumeOnTouch()` - Auto-enter logic
   - Update position state on entry

3. **Update State Transitions** (`src/orchestrator/orchestrator.ts`)
   - HUNTING → ARMED (setup detected)
   - ARMED → ENTRY_WINDOW (entry found)
   - ENTRY_WINDOW → ENTERED (entry confirmed)
   - ENTERED → MANAGING (actively managing)
   - MANAGING → CLOSED (exit triggered)
   - CLOSED → HUNTING (return to hunting)

4. **Update Management Flow** (`src/orchestrator/orchestrator.ts`)
   - Only coach when `entered = true`
   - Check play state before LLM call
   - Process LLM decision according to state
   - Update position state on exit

5. **Persistence Integration** (`src/orchestrator/orchestrator.ts`)
   - Save state after every significant change
   - Load state on startup
   - Restore active play and position state
   - Preserve dedupe keys across restarts

### Acceptance Criteria
- ✅ Entry flow works end-to-end
- ✅ State transitions correct
- ✅ Entry mode respected (MANUAL_CONFIRM default)
- ✅ Coaching only when entered = true
- ✅ State persists across restarts

### Test
```bash
npm run test:entry
npm run test:state-transitions
npm run test:persistence
```

---

## Phase 6: Polish + Verification

### Goal
Final polish, verification, and production readiness.

### Tasks

1. **Time Correctness** (`src/scheduler/scheduler.ts`)
   - Use `date-fns-tz` with `America/New_York`
   - DST-aware ET time calculations
   - Accurate schedule enforcement

2. **Error Handling**
   - LLM API failures (fallback to HOLD)
   - State file corruption (recover gracefully)
   - Telegram API rate limits (retry logic)

3. **Logging & Auditability**
   - Log all state transitions
   - Log all LLM decisions
   - Log all hard boundary violations
   - Log all message sends (with dedupe keys)

4. **Verification Scripts**
   - `npm run test:stop` - Stop logic formulas
   - `npm run test:llm` - LLM scenarios
   - `npm run test:state` - State management
   - `npm run test:dedupe` - Idempotency
   - `npm run test:cooldowns` - Rate limiting
   - `npm run verify` - Code quality

5. **Documentation**
   - Update README with architecture
   - Document all event types
   - Document state transitions
   - Document telemetry packet schema

### Acceptance Criteria
- ✅ All tests pass
- ✅ DST handled correctly
- ✅ Error handling robust
- ✅ Logging comprehensive
- ✅ Documentation complete

### Test
```bash
npm run test:all
npm run verify
```

---

## Implementation Order

```
Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6
```

**Why this order:**
1. **Phase 1** establishes foundation (types, state)
2. **Phase 2** adds safety (hard boundaries)
3. **Phase 3** adds intelligence (LLM)
4. **Phase 4** adds reliability (idempotency, cooldowns)
5. **Phase 5** completes flow (entry, state transitions)
6. **Phase 6** polishes (time, errors, docs)

---

## Key Principles

### 1. Complete Before Moving On
Each phase must be **complete and testable** before starting the next.

### 2. Test-Driven
Write tests for each phase before implementation.

### 3. State First
State management is the foundation - get it right early.

### 4. Hard Boundaries First
Safety constraints must be in place before LLM integration.

### 5. Idempotency Everywhere
Every event must have a dedupe key.

### 6. Single Source of Truth
State file is the single source of truth.

---

## Success Criteria

After all phases:

✅ **No duplicate messages**
✅ **No coaching before setup**
✅ **No phantom old logic**
✅ **No spammy heartbeats**
✅ **Bot remembers play on restart**
✅ **Hard boundaries enforced**
✅ **LLM decisions within safe sandbox**
✅ **State transitions correct**
✅ **Idempotency everywhere**
✅ **Production-ready**

---

## Next Steps

1. Start with **Phase 1**
2. Complete all tasks in phase
3. Run tests
4. Move to next phase
5. Repeat until all phases complete

**This plan ensures the repo never becomes chaotic again.**
