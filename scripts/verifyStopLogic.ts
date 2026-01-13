import { StopProfitRules } from "../src/rules/stopProfitRules.js";
import type { Play } from "../src/types.js";

/**
 * Verification checklist for stop loss logic
 * Tests exact formulas against expected results
 */

const rules = new StopProfitRules();

interface TestCase {
  name: string;
  play: Play;
  close: number;
  entry?: number;
  expected: {
    stopHitOnClose: boolean;
    stopThreatened: boolean;
    distanceToStopDollars: number;
    distanceToStopPercent: number;
    risk: number;
    rMultipleT1: number;
  };
}

const testCases: TestCase[] = [
  {
    name: "A) Wick does NOT stop you out (LONG)",
    play: {
      id: "test1",
      symbol: "SPY",
      direction: "LONG",
      score: 50,
      grade: "C",
      entryZone: { low: 100, high: 101 },
      stop: 100, // stop at 100
      targets: { t1: 102, t2: 103, t3: 104 },
      mode: "SCOUT",
      confidence: 50
    },
    close: 100.05, // close above stop (even if wick went to 99.80)
    entry: 100.50,
    expected: {
      stopHitOnClose: false, // Wick doesn't matter, only close
      // Within 0.25R of stop is a warning-only condition (close-based).
      // risk = |entry - stop| = 0.50 → threshold = stop + 0.25 * 0.50 = 100.125
      // close (100.05) <= 100.125 → threatened
      stopThreatened: true,
      distanceToStopDollars: 0.05, // close - stop = 100.05 - 100
      distanceToStopPercent: 100 * (0.05 / 100.05), // ~0.05%
      risk: 0.50, // |100.50 - 100| = 0.50
      rMultipleT1: (102 - 100.50) / 0.50 // (T1 - entry) / risk = 1.5 / 0.5 = 3.0
    }
  },
  {
    name: "B) Close triggers stop (LONG)",
    play: {
      id: "test2",
      symbol: "SPY",
      direction: "LONG",
      score: 50,
      grade: "C",
      entryZone: { low: 100, high: 101 },
      stop: 100,
      targets: { t1: 102, t2: 103, t3: 104 },
      mode: "SCOUT",
      confidence: 50
    },
    close: 99.99, // close below stop
    entry: 100.50,
    expected: {
      stopHitOnClose: true, // close <= stop
      stopThreatened: true, // within 0.25R = 0.125, so 99.99 <= 100.125
      distanceToStopDollars: -0.01, // close - stop = 99.99 - 100
      distanceToStopPercent: 100 * (-0.01 / 99.99), // ~-0.01%
      risk: 0.50,
      rMultipleT1: (102 - 100.50) / 0.50 // 3.0
    }
  },
  {
    name: "C) Stop threatened triggers warning only (LONG)",
    play: {
      id: "test3",
      symbol: "SPY",
      direction: "LONG",
      score: 50,
      grade: "C",
      entryZone: { low: 100, high: 101 },
      stop: 100,
      targets: { t1: 102, t2: 103, t3: 104 },
      mode: "SCOUT",
      confidence: 50
    },
    close: 100.22, // close = 100.22
    entry: 101, // entry = 101
    // risk = |101 - 100| = 1.00
    // threatR = 0.25
    // threshold = stop + 0.25 * 1 = 100.25
    // close (100.22) <= 100.25 → threatened
    expected: {
      stopHitOnClose: false, // 100.22 > 100, so not hit
      stopThreatened: true, // 100.22 <= 100.25
      distanceToStopDollars: 0.22, // 100.22 - 100
      distanceToStopPercent: 100 * (0.22 / 100.22), // ~0.22%
      risk: 1.00, // |101 - 100|
      rMultipleT1: (102 - 101) / 1.00 // 1.0
    }
  },
  {
    name: "D) SHORT stop hit on close",
    play: {
      id: "test4",
      symbol: "SPY",
      direction: "SHORT",
      score: 50,
      grade: "C",
      entryZone: { low: 100, high: 101 },
      stop: 102, // SHORT stop above entry
      targets: { t1: 99, t2: 98, t3: 97 },
      mode: "SCOUT",
      confidence: 50
    },
    close: 102.01, // close above stop
    entry: 101,
    expected: {
      stopHitOnClose: true, // close >= stop for SHORT
      stopThreatened: true,
      distanceToStopDollars: -0.01, // stop - close = 102 - 102.01
      distanceToStopPercent: 100 * (-0.01 / 102.01),
      risk: 1.00, // |101 - 102|
      rMultipleT1: (101 - 99) / 1.00 // (entry - T1) / risk = 2.0
    }
  }
];

function runVerification() {
  console.log("🔍 Stop Loss Logic Verification Checklist\n");
  console.log("=".repeat(60) + "\n");

  let passed = 0;
  let failed = 0;

  for (const test of testCases) {
    console.log(`\n[${test.name}]`);
    console.log(`Direction: ${test.play.direction}`);
    console.log(`Entry: $${test.entry?.toFixed(2) || "N/A"}`);
    console.log(`Stop: $${test.play.stop.toFixed(2)}`);
    console.log(`Close: $${test.close.toFixed(2)}`);
    console.log(`\nCalculating...\n`);

    const context = rules.getContext(test.play, test.close, test.entry);

    // Verify each expected value
    const checks = [
      {
        name: "stopHitOnClose",
        expected: test.expected.stopHitOnClose,
        actual: context.stopHitOnClose,
        pass: context.stopHitOnClose === test.expected.stopHitOnClose
      },
      {
        name: "stopThreatened",
        expected: test.expected.stopThreatened,
        actual: context.stopThreatened,
        pass: context.stopThreatened === test.expected.stopThreatened
      },
      {
        name: "distanceToStopDollars",
        expected: test.expected.distanceToStopDollars,
        actual: context.distanceToStopDollars,
        pass: Math.abs(context.distanceToStopDollars - test.expected.distanceToStopDollars) < 0.01
      },
      {
        name: "distanceToStopPercent",
        expected: test.expected.distanceToStopPercent,
        actual: context.distanceToStop,
        pass: Math.abs(context.distanceToStop - test.expected.distanceToStopPercent) < 0.01
      },
      {
        name: "risk",
        expected: test.expected.risk,
        actual: context.risk,
        pass: Math.abs(context.risk - test.expected.risk) < 0.01
      },
      {
        name: "rMultipleT1",
        expected: test.expected.rMultipleT1,
        actual: context.rMultipleT1,
        pass: Math.abs(context.rMultipleT1 - test.expected.rMultipleT1) < 0.01
      }
    ];

    let testPassed = true;
    for (const check of checks) {
      const status = check.pass ? "✅" : "❌";
      console.log(`${status} ${check.name}:`);
      console.log(`   Expected: ${check.expected}`);
      console.log(`   Actual: ${check.actual}`);
      if (!check.pass) {
        testPassed = false;
      }
    }

    if (testPassed) {
      console.log(`\n✅ TEST PASSED`);
      passed++;
    } else {
      console.log(`\n❌ TEST FAILED`);
      failed++;
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  console.log(`Success Rate: ${((passed / testCases.length) * 100).toFixed(1)}%\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runVerification();
