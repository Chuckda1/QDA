# One-Engine Compliance Checklist

## Definition
One engine = one resolver + one state machine + one output narrative.
Multiple timeframes are allowed only as features, not as competing decision-makers.

## Non-negotiables
1. Single resolved fields
   - Only one `directionState` is used downstream.
   - Only one `marketState` is used downstream.
   - Telegram never shows `dir1m` and `dir5m` as separate answers.

2. 5m is contextual only
   - 5m cannot create a hard veto unless it is a hardStop/hardWait
     (data readiness, time cutoff, invalid stop, feed stale).
   - 5m may only modify constraints: size, chase, confirmation count, RANGE mode.

3. Hard blocks are data validity only
   - Pre-LLM: only stale/missing bars, warmup incomplete, invalid indicators, time cutoff, feed errors.
   - Everything else is soft and must remain visible to LLM as warnings/constraints.

4. LLM is selector, rules are executor
   - LLM ranks/selects from candidates.
   - Execution gates decide ARM/SIGNAL based on constraints + timing.
   - LLM cannot flip direction unless resolver allows BOTH/RANGE.

5. State machine is unified
   - One play lifecycle: ARMED → ENTRY_WINDOW → ENTERED → MANAGING → CLOSED.
   - No parallel 5m play vs 1m play. Only one play object.

6. RANGE is a first-class mode
   - If range mode is active, output is one combined RANGE WATCH.
   - No alternating LONG/SHORT WATCH spam inside range mode.

7. Deterministic decision routing
   - Telegram eligibility uses only `decisionState`.
   - Internal events may be emitted (SETUP_CANDIDATES, LLM_VERIFY, SCORECARD), but they must never pass Publisher→Governor.

## Review checklist
- Does 5m ever veto 1m outside hardStop/hardWait?
- Is there exactly one resolved `directionState` used for Telegram and execution?
- In range mode, are we emitting a combined card instead of alternating WATCH?
 - Do soft blockers only downgrade to WATCH (never suppress messaging, never hard-block)?

## Blocker classification
- HARD_STOP: time cutoff, invalid stop, feed/LLM fatal failure → UPDATE (no new trades).
- HARD_WAIT: warmup, missing VWAP/ATR/EMA, stale bars → WATCH with readiness ARM rule.
- SOFT: extended, risk ATR high, TF conflict, transition/shock, low density → WATCH + constraints.
- TIMING HOLDS (not blockers): reclaim not met, pullback depth not met, break&hold not confirmed.

## Direction stability
- Direction flips require 2 consecutive 1m confirmations.
- After a flip, apply a 4-minute cooldown before allowing the opposite flip.
- In range mode, emit a combined RANGE WATCH (no alternating LONG/SHORT WATCH).

## Card contract (Normalizer)
- WATCH must include ARM or range payload.
- SIGNAL must include ENTRY + STOP + INVALIDATION.
- If missing, emit UPDATE with CONTRACT_VIOLATION + log.
