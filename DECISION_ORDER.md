# Decision Order Architecture

## Overview

The bot uses a **two-phase decision system** with different ordering for entry vs. exit decisions:

## Entry Zone Decisions: **Rules First → LLM Second**

When a new play is detected and price enters the entry zone:

1. **Rules-Based (First)**
   - `PLAY_ARMED` - Setup detected by rules
   - `TIMING_COACH` - Rules-based timing guidance

2. **LLM Verification (Second)**
   - `LLM_VERIFY` - LLM validates legitimacy and follow-through probability
   - `TRADE_PLAN` - LLM provides action plan (GO_ALL_IN, SCALP, WAIT, PASS)

**Rationale**: Rules identify setups quickly, then LLM adds context and validation.

## Stop Loss / Take Profit Decisions: **LLM First → Rules Second**

When managing an active trade (stop loss or take profit):

1. **LLM Coaching (First)**
   - `LLM_COACH_UPDATE` - LLM analyzes current price action and recommends:
     - HOLD
     - TAKE_PROFIT
     - TIGHTEN_STOP
     - STOP_OUT
     - SCALE_OUT

2. **Rules Validation (Second)**
   - `StopProfitRules.validateDecision()` - Rules validate LLM recommendation:
     - Hard stop hit → Always exit (overrides LLM)
     - Target hit → Validate LLM TAKE_PROFIT
     - Stop threatened → Validate LLM STOP_OUT
     - If LLM says HOLD but stop threatened → Rules override

3. **Final Decision**
   - `PLAY_CLOSED` - If rules validate exit, close the trade

**Rationale**: LLM provides nuanced coaching based on price action, then rules enforce hard boundaries and validate targets.

## Implementation

### Entry Flow (Orchestrator)
```typescript
// Rules first
events.push(PLAY_ARMED)      // Rules detect setup
events.push(TIMING_COACH)    // Rules timing

// LLM second
events.push(LLM_VERIFY)      // LLM validates
events.push(TRADE_PLAN)      // LLM plan
```

### Exit Flow (Orchestrator)
```typescript
// LLM first
const llmResponse = await llmService.getCoachingUpdate(context);
events.push(LLM_COACH_UPDATE)  // LLM recommendation

// Rules second
const rulesDecision = stopProfitRules.validateDecision(play, price, llmAction);
if (rulesDecision.shouldExit) {
  events.push(PLAY_CLOSED)     // Rules validated exit
}
```

## LLM Decision is Final

**Important**: LLM decision is FINAL. Rules do NOT override LLM decisions.

1. **Hard Stop on Close**: Only exit trigger - if close price crosses stop, exit (regardless of LLM)
2. **LLM HOLD**: If LLM says HOLD, we hold - rules don't override
3. **LLM TAKE_PROFIT/STOP_OUT**: If LLM recommends exit, we exit
4. **Rules Provide Context**: Rules provide pattern analysis data (distances, risk/reward, probabilities) to LLM for decision-making

## Testing

Run `npm run test:llm` to test the LLM-first → Rules-second flow for stop/take profit scenarios.

The test script validates:
- LLM recommends appropriate action
- Rules validate or override LLM recommendation
- Final decision matches expected outcome
