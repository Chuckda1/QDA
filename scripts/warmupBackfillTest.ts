import assert from "node:assert/strict";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { BarAggregator } from "../src/datafeed/barAggregator.js";
import type { OHLCVBar } from "../src/utils/indicators.js";

type TestBar = OHLCVBar & { symbol: string };

function make5mBars(count: number, startTs: number, startPrice: number, symbol: string): TestBar[] {
  const bars: TestBar[] = [];
  let ts = startTs;
  let price = startPrice;
  const step = 5 * 60 * 1000;

  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + 0.15;
    const high = Math.max(open, close) + 0.05;
    const low = Math.min(open, close) - 0.05;
    bars.push({ ts, open, high, low, close, volume: 1000, symbol });
    price = close;
    ts += step;
  }

  return bars;
}

function aggregate15mFrom5m(bars5m: TestBar[]): OHLCVBar[] {
  const agg15m = new BarAggregator(15);
  const out: OHLCVBar[] = [];
  for (const bar of bars5m) {
    const bar15m = agg15m.push1m(bar);
    if (bar15m) out.push(bar15m);
  }
  return out;
}

async function run(): Promise<void> {
  const orch = new Orchestrator("test-backfill");
  const symbol = "SPY";

  const firstTs = Date.now() - 60 * 60 * 1000;
  const initialBar = { ts: firstTs, symbol, close: 100, open: 100, high: 100.2, low: 99.8, volume: 1000 };
  await orch.processTick(initialBar, "5m");
  const diagBefore = orch.getLastDiagnostics();

  assert.ok(diagBefore, "Expected diagnostics after first 5m bar");
  assert.ok(
    diagBefore?.setupReason?.includes("INSUFFICIENT_DATA"),
    `Expected INSUFFICIENT_DATA before warmup, got: ${diagBefore?.setupReason}`
  );

  const bars5m = make5mBars(50, firstTs - 50 * 5 * 60 * 1000, 99, symbol);
  const bars15m = aggregate15mFrom5m(bars5m);

  orch.warmupHistory({ symbol, bars5m, bars15m, source: "test" });

  const nextBar = {
    ts: bars5m[bars5m.length - 1]!.ts + 5 * 60 * 1000,
    symbol,
    close: 108,
    open: 107.8,
    high: 108.2,
    low: 107.6,
    volume: 1200
  };
  await orch.processTick(nextBar, "5m");
  const diagAfter = orch.getLastDiagnostics();

  assert.ok(diagAfter, "Expected diagnostics after warmup");
  assert.notEqual(
    diagAfter?.setupReason?.includes("INSUFFICIENT_DATA"),
    true,
    `Expected to exit INSUFFICIENT_DATA after warmup, got: ${diagAfter?.setupReason}`
  );
}

run()
  .then(() => {
    console.log("✅ Warmup backfill test passed.");
  })
  .catch((err) => {
    console.error("❌ Warmup backfill test failed:", err.message);
    process.exit(1);
  });
