import { LLMService, type LLMCoachingContext } from "../src/llm/llmService.js";

// Note: Set OPENAI_API_KEY environment variable before running
// You can use a .env file with dotenv if you install it separately

/**
 * Mock script to test LLM coaching with fake numbers
 * Simulates profit-taking and stop-out scenarios
 * 
 * DECISION ORDER:
 * - Entry zone: Rules first → LLM second
 * - Stop/Take Profit: LLM first → Rules second
 */

interface Scenario {
  name: string;
  description: string;
  context: LLMCoachingContext;
  expectedLLMAction: "HOLD" | "TAKE_PROFIT" | "TIGHTEN_STOP" | "STOP_OUT" | "SCALE_OUT";
  notes?: string;
}

const scenarios: Scenario[] = [
  {
    name: "Profit Target Reached",
    description: "Price has reached T1, LLM should recommend TAKE_PROFIT, then rules validate",
    context: {
      symbol: "SPY",
      direction: "LONG",
      entryPrice: 480.00,
      currentPrice: 480.92, // T1 target
      stop: 479.28,
      targets: { t1: 480.92, t2: 481.88, t3: 482.85 },
      unrealizedPnL: 0.92,
      timeInTrade: 15,
      priceAction: "Price rallied strongly and hit T1 target"
    },
    expectedLLMAction: "TAKE_PROFIT",
    expectedRulesDecision: "EXIT",
    notes: "LLM first recommends TAKE_PROFIT, then rules validate target hit → EXIT"
  },
  {
    name: "Stop Threatened",
    description: "Price is very close to stop, LLM should recommend STOP_OUT, then rules validate",
    context: {
      symbol: "SPY",
      direction: "LONG",
      entryPrice: 480.00,
      currentPrice: 479.35, // Within 0.10 buffer of stop
      stop: 479.28,
      targets: { t1: 480.92, t2: 481.88, t3: 482.85 },
      unrealizedPnL: -0.65,
      timeInTrade: 8,
      priceAction: "Price dropped sharply, approaching stop"
    },
    expectedLLMAction: "STOP_OUT",
    expectedRulesDecision: "EXIT",
    notes: "LLM first recommends STOP_OUT, then rules validate stop threatened → EXIT"
  },
  {
    name: "Strong Profit - Scale Out",
    description: "Price is well above entry, LLM recommends SCALE_OUT, rules may allow partial",
    context: {
      symbol: "SPY",
      direction: "LONG",
      entryPrice: 480.00,
      currentPrice: 481.50, // Between T1 and T2
      stop: 479.28,
      targets: { t1: 480.92, t2: 481.88, t3: 482.85 },
      unrealizedPnL: 1.50,
      timeInTrade: 25,
      priceAction: "Strong momentum, price approaching T2"
    },
    expectedLLMAction: "SCALE_OUT",
    notes: "LLM recommends SCALE_OUT (decision is final). Rules provide context showing strong profit but not at target yet."
  },
  {
    name: "Breakeven Opportunity",
    description: "Price moved up, LLM recommends TIGHTEN_STOP, rules allow it",
    context: {
      symbol: "SPY",
      direction: "LONG",
      entryPrice: 480.00,
      currentPrice: 480.50, // Small profit
      stop: 479.28, // Original stop
      targets: { t1: 480.92, t2: 481.88, t3: 482.85 },
      unrealizedPnL: 0.50,
      timeInTrade: 12,
      priceAction: "Price moved up from entry, risk-free trade opportunity"
    },
    expectedLLMAction: "TIGHTEN_STOP",
    notes: "LLM recommends TIGHTEN_STOP (stop management). Rules provide context showing small profit opportunity."
  },
  {
    name: "Holding - Early Stage",
    description: "Price is in entry zone, LLM should recommend HOLD, rules allow it",
    context: {
      symbol: "SPY",
      direction: "LONG",
      entryPrice: 480.00,
      currentPrice: 480.10, // Just entered
      stop: 479.28,
      targets: { t1: 480.92, t2: 481.88, t3: 482.85 },
      unrealizedPnL: 0.10,
      timeInTrade: 2,
      priceAction: "Just entered trade, price consolidating"
    },
    expectedLLMAction: "HOLD",
    notes: "LLM recommends HOLD (decision is final - we hold). Rules provide context showing early stage."
  },
  {
    name: "SHORT - Stop Threatened",
    description: "SHORT trade approaching stop, LLM should recommend STOP_OUT, rules validate",
    context: {
      symbol: "SPY",
      direction: "SHORT",
      entryPrice: 480.00,
      currentPrice: 480.65, // Approaching stop (SHORT goes up)
      stop: 480.72,
      targets: { t1: 479.08, t2: 478.12, t3: 477.15 },
      unrealizedPnL: -0.65,
      timeInTrade: 10,
      priceAction: "Price rallied against short position"
    },
    expectedLLMAction: "STOP_OUT",
    notes: "LLM analyzes pattern (stop threatened on SHORT) and recommends STOP_OUT (decision is final). Rules provide context."
  },
  {
    name: "SHORT - Profit Target",
    description: "SHORT trade hit profit target, LLM should recommend TAKE_PROFIT, rules validate",
    context: {
      symbol: "SPY",
      direction: "SHORT",
      entryPrice: 480.00,
      currentPrice: 479.08, // T1 target for SHORT
      stop: 480.72,
      targets: { t1: 479.08, t2: 478.12, t3: 477.15 },
      unrealizedPnL: 0.92,
      timeInTrade: 18,
      priceAction: "Price dropped to T1 target"
    },
    expectedLLMAction: "TAKE_PROFIT",
    notes: "LLM analyzes pattern and recommends TAKE_PROFIT on SHORT (decision is final). Rules provide context showing target hit."
  }
];

async function runScenarios() {
  console.log("🤖 LLM Coaching Test - Profit Taking & Stop Out Scenarios\n");
  console.log("=" .repeat(60) + "\n");

  const llm = new LLMService();

  let passed = 0;
  let failed = 0;

  for (let i = 0; i < scenarios.length; i++) {
    const scenario = scenarios[i]!;
    console.log(`\n[Scenario ${i + 1}/${scenarios.length}] ${scenario.name}`);
    console.log(`Description: ${scenario.description}`);
    console.log(`\nTrade Context:`);
    console.log(`  ${scenario.context.direction} ${scenario.context.symbol}`);
    console.log(`  Entry: $${scenario.context.entryPrice.toFixed(2)}`);
    console.log(`  Current: $${scenario.context.currentPrice.toFixed(2)}`);
    console.log(`  Stop: $${scenario.context.stop.toFixed(2)}`);
    console.log(`  T1: $${scenario.context.targets.t1.toFixed(2)}`);
    console.log(`  P&L: $${scenario.context.unrealizedPnL?.toFixed(2) || "N/A"}`);
    console.log(`\nExpected LLM Action: ${scenario.expectedLLMAction}`);
    if (scenario.notes) {
      console.log(`Notes: ${scenario.notes}`);
    }
    console.log(`\n[STEP 1] Calling LLM (FIRST for stop/take profit)...\n`);

    try {
      const startTime = Date.now();
      const response = await llm.getCoachingUpdate(scenario.context);
      const duration = Date.now() - startTime;

      console.log(`✅ LLM Response (${duration}ms):`);
      console.log(`  Action: ${response.action}`);
      console.log(`  Urgency: ${response.urgency}`);
      console.log(`  Reasoning: ${response.reasoning}`);
      if (response.specificPrice) {
        console.log(`  Specific Price: $${response.specificPrice.toFixed(2)}`);
      }

      // Check if LLM action matches expected
      const llmActionMatch = response.action === scenario.expectedLLMAction;
      
      console.log(`\n[STEP 2] Rules Provide Context (for LLM pattern analysis)...\n`);
      
      // Simulate rules providing context (not validation)
      const { StopProfitRules } = await import("../src/rules/stopProfitRules.js");
      const rules = new StopProfitRules();
      
      // Create a mock play for rules context
      const mockPlay = {
        id: "test",
        symbol: scenario.context.symbol,
        direction: scenario.context.direction,
        score: 50,
        grade: "C",
        entryZone: { 
          low: scenario.context.entryPrice - 0.28, 
          high: scenario.context.entryPrice + 0.20 
        },
        stop: scenario.context.stop,
        targets: scenario.context.targets,
        mode: "SCOUT" as const,
        confidence: 50
      };
      
      const rulesContext = rules.getContext(mockPlay, scenario.context.currentPrice);
      
      console.log(`✅ Rules Context (provided to LLM for pattern analysis):`);
      console.log(`  Distance to stop: ${rulesContext.distanceToStop.toFixed(2)}% ($${rulesContext.distanceToStopDollars.toFixed(2)})`);
      console.log(`  Distance to T1: ${rulesContext.distanceToT1.toFixed(2)}% ($${rulesContext.distanceToT1Dollars.toFixed(2)})`);
      console.log(`  Stop threatened: ${rulesContext.stopThreatened ? "YES" : "NO"}`);
      console.log(`  Target hit: ${rulesContext.targetHit || "NONE"}`);
      console.log(`  Risk/Reward: ${rulesContext.riskRewardRatio.toFixed(2)}`);
      console.log(`  Profit %: ${rulesContext.profitPercent.toFixed(2)}%`);
      console.log(`  Hard stop on close: ${rulesContext.stopHitOnClose ? "YES (would exit)" : "NO"}`);

      // LLM decision is FINAL - check if LLM action matches expected
      // Rules only provide context, they don't override LLM
      if (llmActionMatch) {
        console.log(`\n✅ PASS: LLM action (${scenario.expectedLLMAction}) matches expected`);
        console.log(`   Note: LLM decision is FINAL - if LLM says HOLD, we hold`);
        console.log(`   Rules only provide context for pattern analysis`);
        passed++;
      } else {
        console.log(`\n❌ FAIL: Expected LLM action ${scenario.expectedLLMAction}, got ${response.action}`);
        console.log(`   Note: LLM decision is FINAL - rules don't override`);
        failed++;
      }
      
      // Check hard stop on close (only exit trigger)
      if (rulesContext.stopHitOnClose) {
        console.log(`\n⚠️  WARNING: Hard stop hit on close - would exit regardless of LLM`);
      }
    } catch (error: any) {
      console.error(`\n❌ ERROR: ${error.message}`);
      failed++;
    }

    // Small delay between calls to avoid rate limits
    if (i < scenarios.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  console.log(`Success Rate: ${((passed / scenarios.length) * 100).toFixed(1)}%\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

// Run if called directly
runScenarios().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});

export { runScenarios, scenarios };
