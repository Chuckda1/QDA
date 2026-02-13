# Breakdown Impulse Family – Trace, Fix, Invariants, Tests

## 1) Diff table: Successful breakdown entry vs missed breakdown impulse

| Field / Boolean | Successful (ENTRY_EXECUTED, BREAKDOWN_ENTRY) | Missed (TRIGGER_BLOCKED, gate_not_triggered) |
|-----------------|-----------------------------------------------|-----------------------------------------------|
| **opportunity.status** | TRIGGERED | TRIGGERED |
| **opportunity.trigger.type** | BREAK | BREAK |
| **resolutionGate** | Exists, status = TRIGGERED | **undefined** (gate never created) |
| **resolutionGate?.status** | TRIGGERED | **undefined** |
| **phase** | BIAS_ESTABLISHED or PULLBACK_IN_PROGRESS (or EXTENSION with impulse window) | BIAS_ESTABLISHED → then **EXTENSION** on next 5m close |
| **setup** | PULLBACK_CONTINUATION or IGNITION (after BREAK creates gate) | PULLBACK_CONTINUATION |
| **tryArmPullbackGate** | Not required (gate created on BREAK) or already ARMED | **Fails**: phase_disallows_arming (EXTENSION) |
| **canEnter** | true (gate TRIGGERED + ignitionSignal) | false (gate undefined → gateReady false; or phase EXTENSION blocks) |
| **entryBlocked** | false | true (blockReason = gate_not_triggered / phase_extended) |

**Root cause:** Opportunity becomes TRIGGERED (BREAK) while `resolutionGate` is undefined. Gate was only created when `trigger.type === "BREAK" && setup === "NONE"`. With `setup === "PULLBACK_CONTINUATION"` the gate was never created. Next 5m close sets phase to EXTENSION, so `tryArmPullbackGate` returns `phase_disallows_arming`, and entry requires `resolutionGate?.status === "TRIGGERED"` → permanent miss.

---

## 2) Trace (Task A) – Call path and dead-end

### 1) checkOpportunityTrigger() and [TRIGGER_DETECTED]
- **Where:** `handleMinimal1m`, inside the block gated by `(phase === PULLBACK_IN_PROGRESS || phase === BIAS_ESTABLISHED || breakImpulseInExtension)`.
- **Flow:** If `exec.opportunity.status === "LATCHED"`, `checkOpportunityTrigger(opportunity, current5m, previous5m, closed5mBars, atr)` runs. For `trigger.type === "BREAK"`, it returns `{ triggered: true }` when e.g. SHORT: `current5m.low < previous5m.low`.
- **Effect:** `exec.opportunity.status = "TRIGGERED"`; log `[TRIGGER_DETECTED]`.
- **Dead-end:** Gate creation only ran when `exec.setup === "NONE"`, so with `setup === PULLBACK_CONTINUATION` no gate was created.

### 2) Gate arming (tryArmPullbackGate + resolutionGate lifecycle + checkGateTrigger)
- **tryArmPullbackGate:** Called from (a) 5m close in `reduce5mClose` (STEP 5) when `setup === PULLBACK_CONTINUATION`, and (b) 1m arming when forming 5m bar and phase allows. **Returns** `phase_disallows_arming (${exec.phase})` when `exec.phase !== "BIAS_ESTABLISHED" && exec.phase !== "PULLBACK_IN_PROGRESS"` (so EXTENSION blocks arming).
- **resolutionGate lifecycle:** Created when `tryArmPullbackGate` returns `armed: true` and `!exec.resolutionGate`; or **now** when BREAK triggers and gate is missing (see fix).
- **checkGateTrigger:** Used when gate is ARMED to promote to TRIGGERED on price cross.

### 3) Entry evaluation / execution (canEnter and BREAKDOWN_ENTRY)
- **Readiness:** `readyToEvaluateEntry = oppReady || gateReady` (opp LATCHED/TRIGGERED or gate ARMED/TRIGGERED). Entry block runs only when `phase === PULLBACK_IN_PROGRESS || phase === BIAS_ESTABLISHED || breakImpulseInExtension`.
- **canEnter:** `(isPullback && (entrySignalFires || nudge momentum)) || (isIgnition && ignitionSignal)`. For BREAK we now set setup to IGNITION and gate to TRIGGERED, so `ignitionSignal = gateAlreadyTriggered` allows entry.
- **Block:** `entryBlocked = exec.entryBlocked || exec.setup === "NONE" || exec.resolutionGate?.status !== "TRIGGERED"` → if gate is undefined, entry is blocked.
- **EXTENSION:** Inside `if (canEnter)`, when `phase === EXTENSION` we now allow entry only if `breakImpulseInExtension` and chase check passes; else we set `entryBlocked` and log `[IMPULSE_DROP]` or `[ENTRY_BLOCKED] phase=EXTENSION`.

### 4) Phase classification (BIAS_ESTABLISHED → EXTENSION) and veto
- **Where:** `reduce5mClose` STEP 2, when `lastClosed5m` and phase in [BIAS_ESTABLISHED, PULLBACK_IN_PROGRESS, EXTENSION]. Uses `current5m.close` vs `pullbackLow/pullbackHigh ± buffer` (ATR-scaled). If `extended` (price past zone), `exec.phase = "EXTENSION"`.
- **Order:** On a 5m close tick, `reduce5mClose` runs first → phase can flip to EXTENSION before the 1m entry block runs. So the entry block can see phase already EXTENSION and (before fix) would not run because the condition was only `phase === PULLBACK_IN_PROGRESS || phase === BIAS_ESTABLISHED`.
- **Veto:** `tryArmPullbackGate` returns `phase_disallows_arming (EXTENSION)`; and previously the entry flow did not run in EXTENSION at all, so a BREAK impulse detected on the prior tick was never consumed.

---

## 3) Minimal patch plan (implemented)

- **Option 1 (implemented):** When `opportunity.status` transitions to TRIGGERED and `trigger.type === "BREAK"`, **always** create `resolutionGate` if missing: set status TRIGGERED, trigger = actual broken level (previous5m.low/high), stop = pullbackHigh/Low ± ATR buffer. If setup is NONE or PULLBACK_CONTINUATION, set setup to IGNITION and setupTriggerPrice/setupStopPrice. Log `[IMPULSE_GATE_CREATED]`.
- **Option 2 (partial):** Bounded impulse window and chase limit implemented: `BREAK_IMPULSE_WINDOW_MS` (5 min), `BREAK_IMPULSE_CHASE_ATR` (0.8). Entry in EXTENSION allowed only when `isBreakImpulseEligible(exec, ts)` and `checkBreakImpulseChase` allows; otherwise log `[IMPULSE_DROP] reason=chased|impulse_window_expired`.

---

## 4) Entry paths and feature-flagging (Breakdown Impulse dominant)

| Entry path | Condition | How to feature-flag off |
|------------|-----------|---------------------------|
| **Breakdown Impulse (BREAK)** | opportunity.trigger.type === "BREAK", gate TRIGGERED, setup IGNITION (or PULLBACK_CONTINUATION with gate), within impulse window; chase ≤ k×ATR | Don’t create gate on BREAK; or require a “breakdownImpulseOnly” flag and skip all other entry branches when true |
| **Pullback continuation** | setup === PULLBACK_CONTINUATION, entrySignalFires (e.g. bearish candle or higher high for BEARISH) | Skip when e.g. `entryPaths.pullbackContinuation === false` |
| **Nudge momentum** | isNudgeMomentumWindow, gateIsNudgeMomentum, momentumBreakLong/Short | Skip when e.g. `entryPaths.nudgeMomentum === false` |
| **Ignition (non-BREAK)** | setup === IGNITION, ignitionSignal (trigger level break or gateAlreadyTriggered) | Ignition is used for BREAK; other ignition sources can be gated by a flag |
| **BULLISH/BEARISH pullback** | bias + (isBearish \|\| lowerLow) / (isBullish \|\| higherHigh), shouldBlockEntry/pullbackValidity/momentumConfirmationGate | Skip with entry path flags |

To make **Breakdown Impulse Family dominant**: set a single “breakdownImpulseOnly” (or “breakdownImpulseDominant”) flag: when score ≥ threshold for the impulse family, set a state that forces entry evaluation only for the BREAK path (gate TRIGGERED, trigger type BREAK, within window, chase ok) and skip or down-rank other entry paths (e.g. don’t arm pullback gate for rollover-only, or don’t allow nudge momentum when a BREAK impulse is active).

---

## 5) Invariants (Task D)

1. **If BREAK triggers then resolutionGate must exist OR a pendingImpulse latch exists.**  
   Implemented: on BREAK trigger we create `resolutionGate` if missing (Option 1).

2. **BREAK impulse must not be dropped solely because phase flips to EXTENSION within the impulse window.**  
   Implemented: entry flow runs when `breakImpulseInExtension`; in EXTENSION we allow entry if eligible and not chased.

3. **One-shot lifecycle:** Impulse ends as Consumed (entry), Expired (logged), or Rejected (chased, logged).  
   Implemented: `[IMPULSE_DROP] reason=chased|impulse_window_expired`; consumption via ENTRY_EXECUTED and opportunity/gate CONSUMED.

---

## 6) Breakdown Impulse Family signature (Task B)

- **Invariants (ATR-scaled):** Bias alignment; trigger type BREAK; VWAP/EMA displacement via ATR bands; max distance from trigger = k×ATR (no chase); must not be dropped solely by phase transition to EXTENSION within impulse window.
- **Soft (scoring):** Wick vs body quality, impulse speed, volume/ATR expansion, compression before break, consecutive below/above VWAP. Score = structure + momentum + volatility + timing; trade when score ≥ threshold.
- **Constants (orchestrator):** `BREAK_IMPULSE_WINDOW_MS`, `BREAK_IMPULSE_CHASE_ATR`; long/short symmetric; no hardcoded candle index.

---

## 7) Logging plan (Task F)

- **Opportunity TRIGGERED:** Log gateStatus + pendingImpulse state (e.g. in `[TRIGGER_DETECTED]` and `[TRIGGER_NOT_CONSUMED]`: `gateStatus=… pendingImpulse=eligible|none`).
- **Phase EXTENSION transition:** Log whether an impulse is pending/eligible (`breakImpulseEligible`, `gate=…`).
- **Impulse drop:** `[IMPULSE_DROP] reason=chased|impulse_window_expired`; `[ENTRY_BLOCKED]` and `[IMPULSE_DROP]` for chase.
- **Gate creation on BREAK:** `[IMPULSE_GATE_CREATED]` when gate was missing and BREAK fired.

---

## 8) Tests (Task E) – scenarios to add

1. **Trigger hit with gate undefined:** After BREAK trigger, `resolutionGate` exists and status is TRIGGERED; entry can execute (or latch then execute).
2. **Trigger hit then phase flips to EXTENSION:** Within `BREAK_IMPULSE_WINDOW_MS`, entry is not prevented solely by EXTENSION; either entry executes or chase/expiry is logged.
3. **Chase protection:** If price runs beyond trigger + k×ATR, block with explicit reason and log `[IMPULSE_DROP] reason=chased`.
4. **Mirror for longs:** Same logic for LONG (breakout above prior high); gate created, IGNITION, entry in EXTENSION within window.

Suggested location: `scripts/breakdownImpulseTest.ts` or similar, constructing minimal `MinimalExecutionState` and calling orchestrator helpers / reducer paths to assert gate creation and entry eligibility.
