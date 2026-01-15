import { initTelegram } from "./telegram/telegram.js";
import { sendTelegramMessageSafe } from "./telegram/sendTelegramMessageSafe.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { MessageGovernor } from "./governor/messageGovernor.js";
import { MessagePublisher } from "./telegram/messagePublisher.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { CommandHandler } from "./commands.js";
import { yieldNow } from "./utils/yieldNow.js";
import { LLMService } from "./llm/llmService.js";
import { BarAggregator, type Bar as AggregatedBar } from "./datafeed/barAggregator.js";
import { announceStartupThrottled } from "./utils/startupAnnounce.js";
import type { AlpacaDataFeed } from "./datafeed/alpacaFeed.js";
import { StateStore } from "./persistence/stateStore.js";
import type { Play } from "./types.js";

const instanceId = process.env.INSTANCE_ID || "qda-bot-001";

// STAGE 0: BUILD_ID for proof of execution
const BUILD_ID = `QDAV1_STAGE0_${Date.now()}`;
const ENTRY_MODE = "production";
const NODE_ENV = process.env.NODE_ENV || "development";
const HAS_OPENAI_KEY = !!process.env.OPENAI_API_KEY;
const SYMBOLS = process.env.SYMBOLS || "SPY";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "not_set";

// Print startup inventory
console.log("=== STAGE 0 STARTUP INVENTORY ===");
console.log(`BUILD_ID: ${BUILD_ID}`);
console.log(`NODE_ENV: ${NODE_ENV}`);
console.log(`ENTRY_MODE: ${ENTRY_MODE}`);
console.log(`OPENAI_API_KEY: ${HAS_OPENAI_KEY}`);
console.log(`SYMBOLS: ${SYMBOLS}`);
console.log(`TELEGRAM_CHAT_ID: ${TELEGRAM_CHAT_ID}`);
console.log("=================================");

// STAGE 3: Structured pulse tracker
let bars1mCount = 0;
let bars5mCount = 0;
let bars15mCount = 0;

function getPlayState(play: Play | null | undefined): "NONE" | "ARMED" | "ENTERED" | "MANAGING" | "CLOSED" {
  if (!play) return "NONE";
  if (play.status === "CLOSED" || play.stopHit) return "CLOSED";
  if (play.status === "ENTERED") {
    // If entered and managing, it's MANAGING
    return "MANAGING";
  }
  if (play.status === "ARMED") return "ARMED";
  return "ARMED";
}

function logStructuredPulse(orch: Orchestrator, governor: MessageGovernor, symbol: string): void {
  const s = orch.getState();
  const mode = governor.getMode();
  const play = s.activePlay;
  const d = orch.getLastDiagnostics();
  
  const pulse = {
    mode,
    symbol,
    last1mTs: s.last1mTs || null,
    last5mTs: s.last5mTs || null,
    last15mTs: s.last15mTs || null,
    price: s.price ?? null,
    bars1mCount,
    bars5mCount,
    bars15mCount,
    activePlayId: play?.id || null,
    entered: play?.status === "ENTERED",
    state: getPlayState(play),
    lastLLMCallAt: s.lastLLMCallAt || null,
    lastLLMDecision: s.lastLLMDecision || null,
    diag: d ? {
      regime: d.regime?.regime ?? null,
      bias: d.macroBias ?? null,
      potd: d.potd ? {
        bias: d.potd.bias,
        mode: d.potd.mode,
        alignment: d.potd.alignment
      } : null,
      direction: d.directionInference?.direction ?? null,
      entryPermission: d.entryPermission ?? null
    } : null
  };
  
  // Log as single JSON line
  console.log(`[PULSE] ${JSON.stringify(pulse)}`);
  
  // Reset counters for next interval
  bars1mCount = 0;
  bars5mCount = 0;
  bars15mCount = 0;
}

function clampInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function normalizeBackfillBars(bars: AggregatedBar[], bucketMinutes: number): AggregatedBar[] {
  const bucketMs = bucketMinutes * 60 * 1000;
  const now = Date.now();
  const deduped = new Map<number, AggregatedBar>();
  let droppedInProgress = 0;
  let droppedInvalid = 0;

  for (const bar of bars) {
    if (!bar || !Number.isFinite(bar.ts)) {
      droppedInvalid++;
      continue;
    }
    const mod = ((bar.ts % bucketMs) + bucketMs) % bucketMs;
    const closeTs = mod >= bucketMs - 2000 ? bar.ts : bar.ts + bucketMs - 1;
    if (closeTs > now - 1000) {
      droppedInProgress++;
      continue;
    }
    deduped.set(closeTs, { ...bar, ts: closeTs });
  }

  if (droppedInvalid > 0 || droppedInProgress > 0) {
    console.log(`[Warmup] Dropped bars: invalid=${droppedInvalid} in_progress=${droppedInProgress}`);
  }

  return Array.from(deduped.values()).sort((a, b) => a.ts - b.ts);
}

function aggregateTo15m(bars5m: AggregatedBar[]): AggregatedBar[] {
  const agg15m = new BarAggregator(15);
  const out: AggregatedBar[] = [];
  for (const bar of bars5m) {
    const bar15m = agg15m.push1m(bar);
    if (bar15m) out.push(bar15m);
  }
  return out;
}

async function warmupFromAlpaca(alpacaFeed: AlpacaDataFeed, orch: Orchestrator, symbol: string): Promise<void> {
  const warmup5m = clampInt(process.env.WARMUP_5M_BARS, 50);
  const warmup1m = clampInt(process.env.WARMUP_1M_BARS, 0);
  if (warmup5m <= 0 && warmup1m <= 0) {
    return;
  }

  console.log(`[Warmup] Backfilling: 5m=${warmup5m} 1m=${warmup1m}`);

  const [bars5mRaw, bars1mRaw] = await Promise.all([
    warmup5m > 0 ? alpacaFeed.getBars(symbol, "5Min", warmup5m) : Promise.resolve([]),
    warmup1m > 0 ? alpacaFeed.getBars(symbol, "1Min", warmup1m) : Promise.resolve([]),
  ]);

  const bars5m = normalizeBackfillBars(bars5mRaw, 5);
  const bars1m = normalizeBackfillBars(bars1mRaw, 1);
  const bars15m = aggregateTo15m(bars5m);

  if (bars5m.length === 0 && bars1m.length === 0 && bars15m.length === 0) {
    console.warn("[Warmup] No bars returned for backfill.");
    return;
  }

  orch.warmupHistory({
    symbol,
    bars1m: bars1m.length ? bars1m : undefined,
    bars5m: bars5m.length ? bars5m : undefined,
    bars15m: bars15m.length ? bars15m : undefined,
    source: "alpaca_backfill",
  });
}

// Initialize Telegram
const { bot, chatId } = initTelegram();

// Load persisted state
const store = new StateStore(instanceId);
const persisted = await store.load();

// Initialize core components first (with persisted state)
const governor = new MessageGovernor(persisted?.governor);

// STAGE 1: Initialize LLM service (always create, but may be disabled)
let llmService: LLMService | undefined;
let llmErrorLogged = false;
try {
  // Debug: Check if env var exists before creating service
  const hasKey = !!process.env.OPENAI_API_KEY;
  const keyLength = process.env.OPENAI_API_KEY?.length || 0;
  console.log(`[STAGE 1] Checking OPENAI_API_KEY: exists=${hasKey}, length=${keyLength}`);
  
  llmService = new LLMService();
  if (!llmService.isEnabled()) {
    // Log warning at startup (will check mode later when switching to ACTIVE)
    console.warn("[STAGE 1] LLM service disabled: OPENAI_API_KEY missing or empty");
  } else {
    console.log("[STAGE 1] LLM service enabled");
  }
} catch (error: any) {
  console.warn("LLM service initialization error:", error.message);
}

const orch = new Orchestrator(instanceId, llmService, {
  activePlay: persisted?.activePlay ?? null,
  potd: persisted?.potd,
});
const publisher = new MessagePublisher(governor, bot, chatId);
const commands = new CommandHandler(orch, governor, publisher, instanceId, llmService);

// Initialize scheduler
const scheduler = new Scheduler(governor, publisher, instanceId, (mode) => {
  orch.setMode(mode);
  // STAGE 1: Log error once when switching to ACTIVE mode if LLM disabled
  if (mode === "ACTIVE" && llmService && !llmService.isEnabled() && !llmErrorLogged) {
    console.error("[STAGE 1] LLM DISABLED: OPENAI_API_KEY missing. LLM calls will return fallback responses.");
    llmErrorLogged = true;
  }
}, () => orch.getLastDiagnostics(), (potd) => orch.setPotdState(potd));

// Start scheduler
scheduler.start();

// STAGE 3: Start structured pulse timer (every 60 seconds, runs in all modes)
const symbol = process.env.SYMBOLS?.split(",")[0]?.trim() || "SPY";
setInterval(() => {
  logStructuredPulse(orch, governor, symbol);
}, 60000); // 60 seconds

// Log initial pulse immediately
setTimeout(() => {
  logStructuredPulse(orch, governor, symbol);
}, 1000); // After 1 second to let everything initialize

// Register commands
bot.onText(/\/status/, async () => {
  await yieldNow();
  const msg = await commands.status();
  await sendTelegramMessageSafe(bot, chatId, msg);
});

bot.onText(/\/diag/, async () => {
  await yieldNow();
  const msg = await commands.diag();
  await sendTelegramMessageSafe(bot, chatId, msg);
});

bot.onText(/\/enter/, async () => {
  await yieldNow();
  const msg = await commands.enter();
  await sendTelegramMessageSafe(bot, chatId, msg);
});

bot.onText(/\/exit(?:\s+(.+))?/, async (msg, match) => {
  await yieldNow();
  const reason = match?.[1] || undefined;
  const response = await commands.exit(reason);
  await sendTelegramMessageSafe(bot, chatId, response);
});

bot.onText(/\/version/, async () => {
  await yieldNow();
  const msg = await commands.version(BUILD_ID);
  await sendTelegramMessageSafe(bot, chatId, msg);
});

bot.onText(/\/llmtest/, async () => {
  await yieldNow();
  const msg = await commands.llmtest();
  await sendTelegramMessageSafe(bot, chatId, msg);
});

bot.onText(/\/envdebug/, async () => {
  await yieldNow();
  const msg = await commands.envdebug();
  await sendTelegramMessageSafe(bot, chatId, msg);
});

// Startup message (throttled to prevent spam on restart loops)
await announceStartupThrottled({
  bot,
  chatId,
  instanceId,
  text: `[${instanceId}] ✅ Bot online. Mode: ${governor.getMode()}`,
});

// Periodic state persistence (every 15 seconds)
setInterval(() => {
  const state = {
    version: 1 as const,
    instanceId,
    savedAt: Date.now(),
    activePlay: orch.getState().activePlay ?? null,
    potd: orch.getPotdState(),
    governor: governor.exportState(),
  };
  store.save(state).catch((err) => {
    console.warn(`[persist] save failed: ${err?.message || String(err)}`);
  });
}, 15000);

// Main loop: process ticks (connect to your data feed)
// Option 1: Alpaca data feed (if credentials provided)
const alpacaKey = process.env.ALPACA_API_KEY;
const alpacaSecret = process.env.ALPACA_API_SECRET;

if (alpacaKey && alpacaSecret) {
  (async () => {
    try {
      const { AlpacaDataFeed } = await import("./datafeed/alpacaFeed.js");
      const feed = (process.env.ALPACA_FEED as "iex" | "sip") || "iex";
      const alpacaFeed = new AlpacaDataFeed({
        apiKey: alpacaKey,
        apiSecret: alpacaSecret,
        baseUrl: process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets",
        dataUrl: process.env.ALPACA_DATA_URL,
        feed: feed
      });
      
      const symbol = process.env.SYMBOLS?.split(",")[0]?.trim() || "SPY";
      const agg5m = new BarAggregator(5);
      const agg15m = new BarAggregator(15);
      
      console.log(`[${instanceId}] 📊 Alpaca ${feed.toUpperCase()} feed connecting for ${symbol}...`);

      await warmupFromAlpaca(alpacaFeed, orch, symbol);
      
      // Use WebSocket for real-time bars (preferred)
      try {
        console.log(`[${instanceId}] Starting bar processing loop...`);
        for await (const bar of alpacaFeed.subscribeBars(symbol)) {
          try {
            // 1m processing
            bars1mCount++;
            const events1m = await orch.processTick({
              ts: bar.ts,
              symbol: bar.symbol,
              close: bar.close,
              open: bar.open,
              high: bar.high,
              low: bar.low,
              volume: bar.volume
            }, "1m");
            await publisher.publishOrdered(events1m);

            // 5m aggregation + processing (only fires when a 5m bar closes)
            const bar5m = agg5m.push1m(bar);
            if (bar5m) {
              bars5mCount++;
              const events5m = await orch.processTick({
                ts: bar5m.ts,
                symbol: bar5m.symbol,
                close: bar5m.close,
                open: bar5m.open,
                high: bar5m.high,
                low: bar5m.low,
                volume: bar5m.volume
              }, "5m");
              await publisher.publishOrdered(events5m);
            }

            const bar15m = agg15m.push1m(bar);
            if (bar15m) {
              bars15mCount++;
              const events15m = await orch.processTick({
                ts: bar15m.ts,
                symbol: bar15m.symbol,
                close: bar15m.close,
                open: bar15m.open,
                high: bar15m.high,
                low: bar15m.low,
                volume: bar15m.volume
              }, "15m");
              await publisher.publishOrdered(events15m);
            }
          } catch (processError: any) {
            // Log processing errors but continue the loop
            console.error(`[${instanceId}] Error processing bar (ts=${bar.ts}):`, processError.message);
            console.error(processError.stack);
            // Continue to next bar instead of breaking the loop
          }
        }
      } catch (wsError: any) {
        console.warn(`[${instanceId}] WebSocket failed, falling back to polling:`, wsError.message);
        console.warn(`[${instanceId}] WebSocket error stack:`, wsError.stack);
        // Fallback to REST API polling
        console.log(`[${instanceId}] Starting polling fallback loop...`);
        for await (const bar of alpacaFeed.pollBars(symbol, 60000)) {
          try {
            bars1mCount++;
            const events1m = await orch.processTick({
              ts: bar.ts,
              symbol: bar.symbol,
              close: bar.close,
              open: bar.open,
              high: bar.high,
              low: bar.low,
              volume: bar.volume
            }, "1m");
            await publisher.publishOrdered(events1m);

            const bar5m = agg5m.push1m(bar);
            if (bar5m) {
              bars5mCount++;
              const events5m = await orch.processTick({
                ts: bar5m.ts,
                symbol: bar5m.symbol,
                close: bar5m.close,
                open: bar5m.open,
                high: bar5m.high,
                low: bar5m.low,
                volume: bar5m.volume
              }, "5m");
              await publisher.publishOrdered(events5m);
            }

            const bar15m = agg15m.push1m(bar);
            if (bar15m) {
              bars15mCount++;
              const events15m = await orch.processTick({
                ts: bar15m.ts,
                symbol: bar15m.symbol,
                close: bar15m.close,
                open: bar15m.open,
                high: bar15m.high,
                low: bar15m.low,
                volume: bar15m.volume
              }, "15m");
              await publisher.publishOrdered(events15m);
            }
          } catch (processError: any) {
            // Log processing errors but continue the loop
            console.error(`[${instanceId}] Error processing bar (ts=${bar.ts}):`, processError.message);
            console.error(processError.stack);
            // Continue to next bar instead of breaking the loop
          }
        }
      }
    } catch (error: any) {
      console.error("Alpaca feed error:", error.message);
    }
  })().catch(err => console.error("Alpaca feed initialization error:", err));
} else {
  console.log(`[${instanceId}] ⚠️  No Alpaca credentials - bot running without market data feed`);
  console.log(`[${instanceId}]    Wire your own data source or set ALPACA_API_KEY and ALPACA_API_SECRET`);
}

// Option 2: Wire your own data source here
// Example: when you receive a bar, call:
//   const events = await orch.processTick({ ts, symbol, close });
//   await publisher.publishOrdered(events);

// Keep process alive
process.on("SIGTERM", () => {
  scheduler.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  scheduler.stop();
  process.exit(0);
});
