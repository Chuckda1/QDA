# LONG Entry Failure Investigation Plan

## Trade Context
- **Entry:** LONG around 694.77
- **Behavior:** Brief move up (~695) then hard selloff
- **Question:** Was this (a) valid but low-expectancy, (b) VWAP/EMA mismatch, (c) phase/setup gating flaw, or (d) trade-state corruption?

## Investigation Plan

### Phase 1: Entry Path Identification
**Goal:** Map the exact execution path that led to this LONG entry

1. **Find all LONG entry execution points**
   - Search for `phase = "IN_TRADE"` assignments
   - Search for `entryType` assignments with "LONG" or direction="long"
   - Identify entry trigger types (PULLBACK_ENTRY, NUDGE_DIP, BIAS_FLIP_ENTRY, etc.)

2. **Trace entry conditions**
   - Bias requirements (must be BULLISH)
   - Phase requirements (BIAS_ESTABLISHED, PULLBACK_IN_PROGRESS, etc.)
   - Setup requirements (PULLBACK_CONTINUATION, IGNITION, etc.)
   - Gate requirements (resolutionGate.status === "TRIGGERED")
   - Momentum/VWAP/EMA checks

3. **Identify state mutations on entry**
   - entryPrice, stopPrice, targets, targetZones
   - waitReason, setup, opportunity.status, resolutionGate
   - phase transition

### Phase 2: Momentum Blocking Analysis
**Goal:** Understand why "momentum_below_vwap" can block entry later but not prevent initial entry

1. **Find momentum_below_vwap enforcement**
   - Search for "momentum_below_vwap" or "below_vwap" checks
   - Determine if checks are pre-entry or post-entry
   - Check 1m vs 5m processing order

2. **Identify sequencing issues**
   - When are VWAP/EMA computed (1m tick vs 5m close)?
   - When are momentum checks evaluated (pre-entry vs post-entry)?
   - Are there race conditions between 1m and 5m processing?

### Phase 3: Entry Quality Analysis
**Goal:** Determine if entry was reasonable or occurred in poor conditions

1. **Target computation analysis**
   - How are targets computed (ATR dependency, risk calculation)
   - What happens with partial window (few bars)?
   - Are targets reasonable at entry time?

2. **Entry trigger location analysis**
   - Can entry occur inside balance/transition regimes?
   - VWAP chop detection (price near VWAP)
   - EMA/VWAP proximity checks

3. **Expected zone analysis**
   - How is expected zone computed?
   - Does it account for VWAP/EMA proximity?
   - Can entry occur when expected zone is invalid?

### Phase 4: IN_TRADE Corruption Confirmation
**Goal:** Verify if trade-state corruption occurred during this trade

1. **Setup detection during IN_TRADE**
   - Find where detectSetup() is called
   - Check if it has IN_TRADE guards
   - List fields it can overwrite

2. **Gate reset during IN_TRADE**
   - Find where onSetupTransition() is called
   - Check if it resets gate while IN_TRADE
   - List fields it can overwrite

3. **Telegram snapshot corruption**
   - How is waitReason derived?
   - How is setup field derived?
   - Can they show contradictory state?

## Expected Findings

### Entry Path
- Likely entry types: PULLBACK_ENTRY, NUDGE_DIP, or BIAS_FLIP_ENTRY
- Entry requires: BULLISH bias, valid setup, TRIGGERED gate, momentum confirmation

### Momentum Blocking
- Momentum checks may be evaluated post-entry or inconsistently
- VWAP/EMA may be computed on different timeframes (1m vs 5m)
- Race condition: entry can occur before momentum check completes

### Entry Quality
- Entry may occur near VWAP/EMA (chop zone)
- Targets may be computed with insufficient bars (partial window)
- Expected zone may not account for VWAP proximity

### Corruption
- Setup detection likely runs during IN_TRADE
- Gate reset likely occurs during IN_TRADE
- Telegram snapshot shows contradictory state
