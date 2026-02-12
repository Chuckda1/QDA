# LLM Bias Authority: Architectural Proposal

## The Core Question

**Should LLM EVER be allowed to change canonical bias?**

Based on your observation: *"The bot can't establish bias as well without the LLM"*

This suggests the LLM is **necessary but not sufficient** for bias formation.

## Current Reality Check

### Why 5m Engine Struggles to Establish Bias

From your audit findings:

1. **Confidence Thresholds:** Requires `biasConfidence >= 65` (Line 3849)
2. **Stability Requirement:** Bias engine must be "BULLISH" or "BEARISH" (not REPAIR)
3. **Bar Count Gates:** Many functions require 6+ bars, 10+ bars, 30+ bars
4. **Setup Dependency:** Setup detection requires `bias !== NEUTRAL` (chicken-egg)
5. **Structure Requirement:** `finalizeBiasFrom5m` needs swingHigh5m/swingLow5m breaks

**Result:** 5m engine is **conservative by design** - it waits for clear structural confirmation.

### Why LLM Can Establish Bias Better

1. **Contextual Awareness:** Weighs pace, rejection, micro-structure that rules miss
2. **Earlier Signals:** Can detect regime shifts before 5m structure breaks
3. **Nuance:** Understands "messy tape" vs "clean trend"
4. **No Gates:** Not blocked by bar counts or confidence thresholds

**Result:** LLM can propose bias when deterministic engine is stuck in NEUTRAL.

### The Problem: Split-Brain Mutation

**Current State:**
- LLM directly sets `exec.bias` (Line 1992, 2027)
- LLM directly sets `exec.phase` (Line 2001, 2036)
- LLM directly sets `exec.setup` (Line 2004, 2039)
- 5m engine can also set all three
- No hierarchy or ratification

**Result:** Two systems fighting for control, VWAP chop causes flip-flops.

---

## Proposed Solution: Bias Proposer Model

### Architectural Principle

**"LLM proposes, Engine ratifies, Structure finalizes"**

### Three-Tier Bias Authority

```
┌─────────────────────────────────────────────────────────────┐
│  TIER 1: Canonical Bias (exec.bias_5m)                     │
│  Owner: 5m Structure Engine                                │
│  Authority: FINAL                                           │
│  Can Only Be Set By:                                        │
│    - finalizeBiasFrom5m() (structure breaks)                │
│    - Ratifier accepting LLM proposal                         │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ Ratification
                              │
┌─────────────────────────────────────────────────────────────┐
│  TIER 2: Bias Ratifier (deterministic)                     │
│  Owner: Orchestrator                                         │
│  Authority: PROMOTES provisional to canonical               │
│  Decision Logic:                                            │
│    - Is provisional bias consistent for N updates?         │
│    - Is price outside VWAP deadband?                        │
│    - Does provisional align with 5m structure hints?         │
│    - Is bias engine in compatible state?                    │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ Proposal
                              │
┌─────────────────────────────────────────────────────────────┐
│  TIER 3: Provisional Bias (exec.bias_llm_provisional)      │
│  Owner: LLM 1m                                              │
│  Authority: SUGGESTS direction                              │
│  Can Be Set By:                                             │
│    - maybeUpdateLlmDirection1m() (every 1m, throttled)       │
│  Properties:                                                │
│    - Direction: "LONG" | "SHORT" | null                     │
│    - Confidence: 0-100                                      │
│    - Consistency Count: how many updates in a row           │
│    - Last Update Ts: timestamp                              │
└─────────────────────────────────────────────────────────────┘
```

### State Schema Changes

```typescript
// MinimalExecutionState additions:
bias_5m: MarketBias;  // Canonical - only source for trading decisions
bias_llm_provisional?: {
  direction: "LONG" | "SHORT" | null;
  confidence: number;
  consistencyCount: number;  // How many consecutive updates
  lastUpdateTs: number;
  rationale?: string;  // Why LLM thinks this (for debugging)
};

// Legacy compatibility (for gradual migration):
// exec.bias becomes alias for exec.bias_5m
// All reads use exec.bias_5m
```

---

## Decision Framework: When LLM Can Influence Canonical Bias

### Option A: LLM Can Promote to Canonical (REVISED - Fast Promotion)

**Key Insight:** 5m structure is too slow. LLM needs to establish bias quickly, but we still need to prevent VWAP chop flip-flops.

**Conditions for Promotion (Fast Track):**

1. **NEUTRAL Fast Track (Immediate Promotion):**
   - If canonical bias is NEUTRAL, LLM can promote immediately (no consistency wait)
   - **BUT** requires strong deadband + confidence checks
   - This solves "bot can't get out of NEUTRAL" problem

2. **Deadband Requirement (Stronger When NEUTRAL):**
   - Price must be outside VWAP deadband (0.20 * ATR when NEUTRAL, 0.15 * ATR otherwise)
   - Prevents promotion during choppy VWAP hugging
   - Stronger deadband when NEUTRAL prevents false starts

3. **Confidence Threshold (Higher When NEUTRAL):**
   - When NEUTRAL: Provisional confidence must be >= 75 (very strong signal)
   - When non-NEUTRAL: Provisional confidence must be >= 70
   - Prevents weak signals from establishing bias

4. **Structure Alignment (Softer When NEUTRAL):**
   - If 5m structure exists and contradicts, reject (even when NEUTRAL)
   - If no 5m structure yet (cold start), allow promotion if deadband + confidence met
   - This allows LLM to establish bias before 5m structure forms

5. **Bias Engine Compatibility:**
   - If bias engine is in REPAIR state, provisional can promote immediately (helps exit REPAIR fast)
   - If bias engine is stable and contradicts provisional, require 2 updates (not 5)

6. **Consistency Requirement (Only When Non-NEUTRAL):**
   - If canonical is NEUTRAL: No consistency wait (immediate if conditions met)
   - If canonical is non-NEUTRAL: Require 2 consecutive updates (5-10 minutes, not 15)
   - Prevents flip-flops when bias already established

**Promotion Logic (REVISED):**
```typescript
function shouldPromoteProvisionalToCanonical(
  provisional: BiasProvisional,
  currentCanonical: MarketBias,
  biasEngine: BiasEngine,
  price: number,
  vwap: number,
  atr: number,
  swingHigh5m?: number,
  swingLow5m?: number
): boolean {
  const isNeutral = currentCanonical === "NEUTRAL";
  
  // 1. Confidence check (higher threshold when NEUTRAL)
  const minConfidence = isNeutral ? 75 : 70;
  if (provisional.confidence < minConfidence) return false;
  
  // 2. Deadband check (stronger when NEUTRAL)
  const deadband = isNeutral ? 0.20 * atr : 0.15 * atr;
  const farAbove = price > vwap + deadband;
  const farBelow = price < vwap - deadband;
  if (!farAbove && !farBelow) return false;  // Too choppy
  
  // 3. Structure alignment (strict even when NEUTRAL)
  if (swingHigh5m && swingLow5m) {
    if (provisional.direction === "LONG" && price < swingLow5m) return false;
    if (provisional.direction === "SHORT" && price > swingHigh5m) return false;
  }
  
  // 4. Bias engine compatibility
  const beState = biasEngine.state;
  if (beState === "REPAIR_BULL" && provisional.direction === "SHORT") {
    // Contradicts repair - allow if high confidence
    if (provisional.confidence < 80) return false;
  }
  if (beState === "REPAIR_BEAR" && provisional.direction === "LONG") {
    if (provisional.confidence < 80) return false;
  }
  
  // 5. Consistency check (FAST TRACK when NEUTRAL)
  if (isNeutral) {
    // No consistency wait - promote immediately if conditions met
    return true;
  } else {
    // When bias already established, require 2 updates (5-10 min, not 15)
    if (provisional.consistencyCount < 2) return false;
  }
  
  return true;
}
```

### Option B: LLM Only Influences Timing (Conservative)

**LLM Never Sets Canonical Bias:**
- Provisional bias exists only for:
  - Coaching/alerting ("LLM suggests LONG but waiting for 5m confirmation")
  - Entry timing hints (enter earlier if provisional aligns)
  - Risk sizing (smaller size if provisional contradicts canonical)

**Canonical bias only set by:**
- 5m structure breaks (finalizeBiasFrom5m)
- Bias engine finalization (after REPAIR)

**Trade-off:** Preserves stability but loses LLM's bias formation strength.

### Option C: LLM Can Set Canonical Only When NEUTRAL (Hybrid)

**LLM Can Promote Only If:**
- Current canonical bias is NEUTRAL
- All promotion conditions met (consistency, deadband, etc.)

**Once Canonical is Set:**
- Only 5m structure can change it
- LLM provisional becomes "tilt" only (timing/coaching)

**Trade-off:** LLM helps establish initial bias, then hands off to structure.

---

## Recommended Approach: Option A with Scout Mode

### Why Option A

1. **Preserves LLM Strength:** Keeps LLM's bias formation capability
2. **Maintains Stability:** Ratification prevents flip-flops
3. **Handles Edge Cases:** Can exit REPAIR states when 5m structure is slow
4. **Gradual Handoff:** LLM establishes, structure confirms/refines

### Scout Mode for LLM-Led Trades

When canonical bias is set by LLM promotion (not 5m structure):

1. **Smaller Position Size:** 50% of normal size
2. **Tighter Stops:** 0.75x normal stop distance
3. **Earlier Exits:** Take profit at 1.5R instead of 2R
4. **Coaching Tag:** "LLM-led bias - waiting for 5m confirmation"

**Rationale:** LLM bias is provisional until 5m structure confirms. Trade it, but with reduced risk.

### When 5m Structure Confirms LLM Bias

If LLM promotes to canonical, then 5m structure breaks in same direction:

1. **Upgrade to Full Size:** Normal position sizing
2. **Normal Stops:** Full stop distance
3. **Full Targets:** Normal take profit levels
4. **Coaching Update:** "5m structure confirms LLM bias - full confidence"

---

## Implementation Phases

### Phase 1: Add Provisional Bias (No Promotion Yet)

**Goal:** Introduce provisional bias without changing canonical behavior

**Changes:**
- Add `bias_llm_provisional` to state
- LLM sets provisional, never touches canonical
- Canonical remains 5m-only
- Log provisional vs canonical for observability

**Validation:**
- Verify provisional updates correctly
- Verify canonical unchanged by LLM
- Verify logs show both

**Risk:** Low (additive only)

### Phase 2: Add Ratifier Logic (Promotion Enabled - FAST TRACK)

**Goal:** Allow provisional to promote to canonical quickly when NEUTRAL, prevent flip-flops when established

**Changes:**
- Implement `shouldPromoteProvisionalToCanonical()` with fast-track for NEUTRAL
- Call ratifier in `handleMinimal1m()` after LLM updates (not just on 5m close)
- If promotion succeeds, set `bias_5m` from provisional immediately
- Log promotion events with "FAST_TRACK" tag when NEUTRAL

**Key Behavior:**
- **When NEUTRAL:** LLM can promote immediately (no wait) if confidence >= 75 and deadband met
- **When non-NEUTRAL:** Require 2 updates (5-10 min) to prevent flip-flops
- **Deadband:** Stronger (0.20 * ATR) when NEUTRAL to prevent false starts

**Validation:**
- Verify fast-track promotion works when NEUTRAL
- Verify consistency requirement (2 updates) when non-NEUTRAL
- Verify deadband prevents choppy promotions
- Verify structure alignment works
- Verify bias establishes quickly (within 1-2 minutes, not 15)

**Risk:** Medium (affects bias establishment, but fast-track reduces risk of missing moves)

### Phase 3: Add Scout Mode (Risk Management)

**Goal:** Reduce risk when trading LLM-led bias

**Changes:**
- Detect when canonical bias was set by LLM (not 5m structure)
- Apply scout mode sizing/stops/targets
- Update coaching to indicate LLM-led
- Upgrade to full mode when 5m structure confirms

**Validation:**
- Verify scout mode applies correctly
- Verify upgrade to full mode works
- Verify position sizing reflects mode

**Risk:** Medium (affects trade execution)

### Phase 4: Migrate All Reads to bias_5m

**Goal:** Complete separation, remove legacy `bias` field

**Changes:**
- Update all `exec.bias` reads to `exec.bias_5m`
- Remove legacy `bias` field
- Update type definitions

**Validation:**
- Verify all reads use canonical
- Verify no legacy references remain

**Risk:** Low (mechanical change)

---

## Authority Contract (Formal Definition)

### State Authority Matrix

| State Field | Owner | Can Write | Can Read | Promotion Path |
|-------------|-------|-----------|----------|----------------|
| `bias_5m` | 5m Structure | `finalizeBiasFrom5m()`, Ratifier | All trading logic | N/A (canonical) |
| `bias_llm_provisional` | LLM 1m | `maybeUpdateLlmDirection1m()` | Ratifier, Coaching | Ratifier → `bias_5m` |
| `phase` | Orchestrator | `reduce5mClose()` only | All logic | Deterministic (price-based) |
| `setup` | Orchestrator | `detectSetup()` only | All logic | 5m-based detection |
| `biasEngine.state` | Bias Engine | `updateBiasEngine()` | Ratifier, Finalization | Can enter REPAIR, 5m finalizes |

### Mutation Rules

1. **Canonical Bias (`bias_5m`):**
   - ✅ Can be set by: `finalizeBiasFrom5m()`, Ratifier
   - ❌ Cannot be set by: LLM directly, Bias engine directly
   - ✅ Can be read by: All trading logic, entry decisions, TP management

2. **Provisional Bias (`bias_llm_provisional`):**
   - ✅ Can be set by: `maybeUpdateLlmDirection1m()`
   - ❌ Cannot be set by: Any other system
   - ✅ Can be read by: Ratifier, Coaching formatter, Alerts

3. **Phase:**
   - ✅ Can be set by: `reduce5mClose()` only
   - ❌ Cannot be set by: LLM, Bias engine, Setup detection
   - ✅ Based on: Price behavior relative to pullback zones

4. **Setup:**
   - ✅ Can be set by: `detectSetup()` only
   - ❌ Cannot be set by: LLM, Bias engine
   - ✅ Based on: 5m structure, bias, pullback zones

---

## Answer to Your Question (REVISED)

**"Should LLM EVER be allowed to change canonical bias?"**

**Answer: Yes, with FAST-TRACK ratification when NEUTRAL.**

**Specific Conditions (REVISED for Speed):**

**When Canonical is NEUTRAL (Fast Track):**
1. LLM proposes provisional bias (every 1m, throttled)
2. **No consistency wait** - promote immediately if:
   - Confidence >= 75 (very strong signal)
   - Price outside VWAP deadband (0.20 * ATR - stronger to prevent false starts)
   - No 5m structure contradiction
3. Ratifier promotes provisional → canonical **immediately**
4. Scout mode applies until 5m structure confirms

**When Canonical is Non-NEUTRAL (Stability Mode):**
1. LLM proposes provisional bias
2. **Require 2 updates** (5-10 minutes, not 15) if:
   - Confidence >= 70
   - Price outside VWAP deadband (0.15 * ATR)
   - Aligns with bias engine state
3. Ratifier promotes only if consistent
4. Prevents flip-flops when bias already established

**This preserves:**
- ✅ LLM's bias formation strength (can establish quickly)
- ✅ System stability (stronger deadband when NEUTRAL prevents false starts)
- ✅ Fast bias establishment (1-2 minutes, not 15)
- ✅ Flip-flop prevention (consistency required when bias exists)

**This prevents:**
- ❌ Direct LLM mutation of canonical bias (still goes through ratifier)
- ❌ VWAP chop flip-flops (deadband + consistency when non-NEUTRAL)
- ❌ Split-brain conflicts (clear ownership hierarchy)
- ❌ Slow bias establishment (fast-track when NEUTRAL)

---

## Next Steps

1. **Decide on promotion conditions:** Review the `shouldPromoteProvisionalToCanonical()` logic
2. **Decide on scout mode:** Confirm risk reduction approach for LLM-led trades
3. **Approve phased implementation:** Start with Phase 1 (observability + provisional state)
4. **Define success metrics:** How will we know this is working?

**Questions for You:**
1. **Fast-track timing:** Immediate promotion when NEUTRAL (if confidence >= 75, deadband met) - does this feel right?
2. **Deadband strength:** 0.20 * ATR when NEUTRAL (stronger) vs 0.15 * ATR when established - is this enough to prevent false starts?
3. **Confidence thresholds:** 75 when NEUTRAL, 70 when established - should these be different?
4. **Scout mode:** 50% size when LLM-led, upgrade to full when 5m confirms - does this risk profile work?
5. **Consistency when established:** 2 updates (5-10 min) to prevent flip-flops - is this acceptable?
6. Should we log provisional vs canonical separately for debugging?
7. Do you want to test this in a branch first, or implement directly?

**Key Changes from Original:**
- ✅ **No 15-minute wait** - immediate promotion when NEUTRAL
- ✅ **Stronger deadband when NEUTRAL** (0.20 vs 0.15) to prevent false starts
- ✅ **Higher confidence when NEUTRAL** (75 vs 70) to ensure strong signals
- ✅ **2-update consistency when established** (5-10 min, not 15) to prevent flip-flops
- ✅ **Ratifier called on 1m updates** (not just 5m close) for faster response

---

## Philosophical Note

Your insight is correct: **"The bot can't establish bias as well without the LLM"**

This proposal doesn't remove LLM's strength - it **channels it through a ratification layer** that:
- Preserves LLM's contextual awareness
- Prevents LLM's noise sensitivity
- Maintains system determinism
- Allows gradual handoff to structure

The LLM becomes the **"smart proposer"** and the ratifier becomes the **"careful gatekeeper"**.

This is how you get both: **LLM's edge + system stability**.
