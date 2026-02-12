import { initTelegram } from "./telegram/telegram.js";
import { sendTelegramMessageSafe } from "./telegram/sendTelegramMessageSafe.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { MessageGovernor } from "./governor/messageGovernor.js";
import { MessagePublisher } from "./telegram/messagePublisher.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { CommandHandler } from "./commands.js";
import { yieldNow } from "./utils/yieldNow.js";
import { LLMService } from "./llm/llmService.js";
import { announceStartupThrottled } from "./utils/startupAnnounce.js";
import { StateStore } from "./persistence/stateStore.js";
import { BarAggregator } from "./datafeed/barAggregator.js";

// CRITICAL: Flush stdout immediately to ensure Railway captures logs
const START_TIME = Date.now();
process.stdout.write(`[STARTUP] Process starting at ${new Date().toISOString()}\n`);
process.stdout.write(`[STARTUP] Node version: ${process.version}\n`);
process.stdout.write(`[STARTUP] Platform: ${process.platform}\n`);

// Top-level error handler to catch unhandled errors
process.on("uncaughtException", (error) => {
  console.error("[FATAL] Uncaught exception:", error);
  console.error("[FATAL] Stack:", error.stack);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[FATAL] Unhandled rejection at:", promise);
  console.error("[FATAL] Reason:", reason);
  process.exit(1);
});

const instanceId = process.env.INSTANCE_ID || "qda-bot-001";

// STAGE 0: BUILD_ID for proof of execution
const BUILD_ID = `QDAV1_STAGE0_${Date.now()}`;
const ENTRY_MODE = "production";
const NODE_ENV = process.env.NODE_ENV || "development";
const HAS_OPENAI_KEY = !!process.env.OPENAI_API_KEY;
const SYMBOLS = process.env.SYMBOLS || "SPY";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "not_set";
const BOT_MODE = (process.env.BOT_MODE || "").toLowerCase();

console.log(`[STARTUP] Instance ID: ${instanceId}`);
console.log(`[STARTUP] BUILD_ID: ${BUILD_ID}`);

const normalizeBarTs = (ts: number): number => (ts < 1_000_000_000_000 ? ts * 1000 : ts);
const normalizeBar = <T extends { ts: number }>(bar: T): T => ({
  ...bar,
  ts: normalizeBarTs(bar.ts),
});

const parseWarmupBars = (value: string | undefined, fallback: number): number => {
  const parsed = parseInt(value ?? "", 10);
  if (Number.isFinite(parsed)) return Math.max(0, parsed);
  return fallback;
};

const WARMUP_1M_BARS = parseWarmupBars(process.env.WARMUP_1M_BARS, 60);
const WARMUP_5M_BARS = parseWarmupBars(process.env.WARMUP_5M_BARS, 30);

let markWarmupReady: (() => void) | null = null;
const warmupReady = new Promise<void>((resolve) => {
  markWarmupReady = resolve;
});
const resolveWarmupReady = (): void => {
  if (markWarmupReady) {
    markWarmupReady();
    markWarmupReady = null;
  }
};

// Print startup inventory
console.log("=== STAGE 0 STARTUP INVENTORY ===");
console.log(`[STARTUP] BUILD_ID: ${BUILD_ID}`);
console.log(`[STARTUP] NODE_ENV: ${NODE_ENV}`);
console.log(`[STARTUP] ENTRY_MODE: ${ENTRY_MODE}`);
console.log(`[STARTUP] OPENAI_API_KEY: ${HAS_OPENAI_KEY ? "SET" : "NOT SET"}`);
console.log(`BOT_MODE: ${BOT_MODE || "default"}`);
console.log(`SYMBOLS: ${SYMBOLS}`);
console.log(`WARMUP_1M_BARS: ${WARMUP_1M_BARS}`);
console.log(`WARMUP_5M_BARS: ${WARMUP_5M_BARS}`);
if (process.env.WARMUP_1M_BARS || process.env.WARMUP_5M_BARS) {
  console.log(`WARMUP_1M_BARS_ENV: ${process.env.WARMUP_1M_BARS ?? "unset"}`);
  console.log(`WARMUP_5M_BARS_ENV: ${process.env.WARMUP_5M_BARS ?? "unset"}`);
}
console.log(`TELEGRAM_CHAT_ID: ${TELEGRAM_CHAT_ID}`);
console.log("=================================");

if (WARMUP_1M_BARS < 60 || WARMUP_5M_BARS < 30) {
  console.warn(
    `[${instanceId}] Warmup below recommended defaults: 1m=${WARMUP_1M_BARS} (rec 60) 5m=${WARMUP_5M_BARS} (rec 30)`
  );
}

// STAGE 3: Minimal pulse tracker
let bars5mCount = 0;

function logStructuredPulse(orch: Orchestrator, governor: MessageGovernor, symbol: string): void {
  const s = orch.getState();
  const mode = governor.getMode();
  const pulse = {
    mode,
    symbol,
    last5mCloseTs: s.last5mCloseTs || null,
    price: s.price ?? null,
    bars5mCount,
    lastLLMCallAt: s.lastLLMCallAt || null,
    lastLLMDecision: s.lastLLMDecision || null,
  };
  console.log(`[PULSE] ${JSON.stringify(pulse)}`);
  // Fix #9: Don't reset bars5mCount - keep it cumulative for reliable tracking
  // bars5mCount = 0; // REMOVED - prevents loss of information
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

const orch = new Orchestrator(instanceId, llmService);
const publisher = new MessagePublisher(governor, bot, chatId);
const commands = new CommandHandler(orch, instanceId, llmService);
const agg5m = new BarAggregator(5);

// Preload historical bars on startup (if Alpaca credentials available)
const alpacaKey = process.env.ALPACA_API_KEY;
const alpacaSecret = process.env.ALPACA_API_SECRET;
const symbol = process.env.SYMBOLS?.split(",")[0]?.trim() || "SPY";

if (alpacaKey && alpacaSecret) {
  (async () => {
    try {
      const { AlpacaDataFeed } = await import("./datafeed/alpacaFeed.js");
      const alpacaFeed = new AlpacaDataFeed({
        apiKey: alpacaKey,
        apiSecret: alpacaSecret,
        baseUrl: process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets",
        dataBaseUrl: process.env.ALPACA_DATA_BASE_URL || "https://data.alpaca.markets",
        feed: (process.env.ALPACA_FEED || "iex") as "iex" | "sip",
      });

      // Fetch last 60 closed 5m bars
      console.log(`[PRELOAD] Fetching historical 5m bars for ${symbol}...`);
      const historicalBars = await alpacaFeed.fetchHistoricalBars(symbol, "5Min", 60);
      
      if (historicalBars && historicalBars.length > 0) {
        const normalizedBars = historicalBars.map(bar => ({
          ts: bar.ts,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
        }));

        // Fetch previous day's daily bar for context
        const prevDayBars = await alpacaFeed.fetchHistoricalBars(symbol, "1Min", 1); // Get 1 bar, but we'll use daily timeframe
        // Note: Alpaca's fetchHistoricalBars doesn't support daily timeframe directly
        // We'll calculate daily context from the 5m bars we have
        const overnightHigh = Math.max(...normalizedBars.map(b => b.high));
        const overnightLow = Math.min(...normalizedBars.map(b => b.low));
        
        // Calculate VWAP from the historical bars
        const calculateVWAP = (bars: Array<{ high: number; low: number; close: number; volume: number }>): number => {
          if (bars.length === 0) return 0;
          let cumulativeTPV = 0;
          let cumulativeVolume = 0;
          for (const bar of bars) {
            const typicalPrice = (bar.high + bar.low + bar.close) / 3;
            cumulativeTPV += typicalPrice * bar.volume;
            cumulativeVolume += bar.volume;
          }
          return cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : 0;
        };

        const prevSessionVWAP = calculateVWAP(normalizedBars);
        
        // Use the first bar's open as prevClose approximation, last bar's close as current
        // For a more accurate prevClose, we'd need to fetch actual daily bars, but this is a reasonable approximation
        const prevClose = normalizedBars.length > 0 ? normalizedBars[0].open : undefined;
        const prevHigh = overnightHigh;
        const prevLow = overnightLow;

        const dailyContext = prevClose !== undefined ? {
          prevClose,
          prevHigh,
          prevLow,
          overnightHigh,
          overnightLow,
          prevSessionVWAP,
        } : undefined;

        orch.preloadHistory(normalizedBars, dailyContext);
        console.log(`[STARTUP] Preloaded ${normalizedBars.length} bars${dailyContext ? ` and daily context (prevClose=${dailyContext.prevClose.toFixed(2)})` : ""}`);
      } else {
        console.log(`[STARTUP] No historical bars available for preload - starting with empty history`);
      }
    } catch (error: any) {
      console.warn(`[STARTUP] Preload failed: ${error.message} - starting with empty history`);
      // Don't throw - allow bot to continue with empty history
    }
  })().catch(err => {
    console.warn(`[STARTUP] Preload error: ${err?.message || String(err)} - starting with empty history`);
  });
}

// Initialize scheduler
const scheduler = new Scheduler(governor, instanceId, (mode) => {
  orch.setMode(mode);
  if (mode === "ACTIVE" && llmService && !llmService.isEnabled() && !llmErrorLogged) {
    console.error("[STAGE 1] LLM DISABLED: OPENAI_API_KEY missing. LLM calls will return fallback responses.");
    llmErrorLogged = true;
  }
});

// STAGE 3: Start structured pulse timer (every 60 seconds, runs in all modes)
// Note: symbol is already defined above in preload section

// Start scheduler
scheduler.start();

// Optional one-shot minimal tick (debug only)
if (BOT_MODE === "minimal" && process.env.MINIMAL_ONE_SHOT_TICK === "true") {
  warmupReady.then(() => {
    setTimeout(async () => {
      try {
        const now = Date.now();
        await orch.processTick(
          {
            ts: now,
            symbol,
            close: 500,
            open: 499,
            high: 501,
            low: 498,
            volume: 1000,
          },
          "1m"
        );
        console.log("[MINIMAL] one-shot tick injected");
      } catch (err: any) {
        console.error("[MINIMAL] one-shot tick failed:", err?.message || String(err));
      }
    }, 1500);
  });
}
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

// Periodic state persistence (every 30 seconds)
setInterval(() => {
  const state = {
    version: 1 as const,
    instanceId,
    savedAt: Date.now(),
    governor: governor.exportState(),
  };
  store.save(state).catch((err) => {
    console.warn(`[persist] save failed: ${err?.message || String(err)}`);
  });
}, 30000);

// Periodic heartbeat log (every 5 minutes) to confirm app is running
setInterval(() => {
  const uptime = Math.floor((Date.now() - START_TIME) / 1000);
  console.log(`[HEARTBEAT] Bot is alive. Uptime: ${uptime}s`);
}, 300000); // 5 minutes

// Main loop: process ticks (connect to your data feed)
// Option 1: Alpaca data feed (if credentials provided)
// Note: alpacaKey and alpacaSecret are already defined above in preload section

if (alpacaKey && alpacaSecret) {
  (async () => {
    try {
      const { AlpacaDataFeed } = await import("./datafeed/alpacaFeed.js");
      const feed = (process.env.ALPACA_FEED as "iex" | "sip") || "iex";
      const alpacaFeed = new AlpacaDataFeed({
        apiKey: alpacaKey,
        apiSecret: alpacaSecret,
        baseUrl: process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets",
        feed: feed
      });
      
      const symbol = process.env.SYMBOLS?.split(",")[0]?.trim() || "SPY";
      console.log(`[${instanceId}] 📊 Alpaca ${feed.toUpperCase()} feed connecting for ${symbol}...`);

      // Warmup skipped (minimal-only bot)
      resolveWarmupReady();
      
      // Use WebSocket for real-time bars (preferred)
      try {
        console.log(`[${instanceId}] Starting bar processing loop...`);
        for await (const bar of alpacaFeed.subscribeBars(symbol)) {
          try {
            const normalizedBar = normalizeBar(bar);
            if (process.env.VERBOSE_TICK === "1") {
              console.log(
                `[INGEST] 1m ts=${normalizedBar.ts} o=${normalizedBar.open} h=${normalizedBar.high} l=${normalizedBar.low} c=${normalizedBar.close} v=${normalizedBar.volume}`
              );
            }
            // a) Update forming5mBar with 1m bar (no LLM call)
            const events1m = await orch.processTick(
              {
                ts: normalizedBar.ts,
                symbol: normalizedBar.symbol,
                close: normalizedBar.close,
                open: normalizedBar.open,
                high: normalizedBar.high,
                low: normalizedBar.low,
                volume: normalizedBar.volume
              },
              "1m"
            );
            
            // b) Push 1m bar to aggregator, get closed 5m if bucket completed
            const closed5m = agg5m.push1m({
              ts: normalizedBar.ts,
              symbol: normalizedBar.symbol,
              open: normalizedBar.open,
              high: normalizedBar.high,
              low: normalizedBar.low,
              close: normalizedBar.close,
              volume: normalizedBar.volume,
            });
            
            // c) If closed 5m bar exists, process it (triggers LLM)
            // Fix #4: Removed duplicate CLOSE5M log - orchestrator.ts already logs this
            if (closed5m !== null) {
              bars5mCount++;
              const events5m = await orch.processTick(
                {
                  ts: closed5m.ts,
                  symbol: closed5m.symbol,
                  close: closed5m.close,
                  open: closed5m.open,
                  high: closed5m.high,
                  low: closed5m.low,
                  volume: closed5m.volume
                },
                "5m"
              );
              await publisher.publishOrdered(events5m);
            }
            
            // Publish 1m events if any (for state updates)
            await publisher.publishOrdered(events1m);
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
            const normalizedBar = normalizeBar(bar);
            if (process.env.VERBOSE_TICK === "1") {
              console.log(
                `[INGEST] 1m ts=${normalizedBar.ts} o=${normalizedBar.open} h=${normalizedBar.high} l=${normalizedBar.low} c=${normalizedBar.close} v=${normalizedBar.volume}`
              );
            }
            // a) Update forming5mBar with 1m bar (no LLM call)
            const events1m = await orch.processTick(
              {
                ts: normalizedBar.ts,
                symbol: normalizedBar.symbol,
                close: normalizedBar.close,
                open: normalizedBar.open,
                high: normalizedBar.high,
                low: normalizedBar.low,
                volume: normalizedBar.volume
              },
              "1m"
            );
            
            // b) Push 1m bar to aggregator, get closed 5m if bucket completed
            const closed5m = agg5m.push1m({
              ts: normalizedBar.ts,
              symbol: normalizedBar.symbol,
              open: normalizedBar.open,
              high: normalizedBar.high,
              low: normalizedBar.low,
              close: normalizedBar.close,
              volume: normalizedBar.volume,
            });
            
            // c) If closed 5m bar exists, process it (triggers LLM)
            // Fix #4: Removed duplicate CLOSE5M log - orchestrator.ts already logs this
            if (closed5m !== null) {
              bars5mCount++;
              const events5m = await orch.processTick(
                {
                  ts: closed5m.ts,
                  symbol: closed5m.symbol,
                  close: closed5m.close,
                  open: closed5m.open,
                  high: closed5m.high,
                  low: closed5m.low,
                  volume: closed5m.volume
                },
                "5m"
              );
              await publisher.publishOrdered(events5m);
            }
            
            // Publish 1m events if any (for state updates)
            await publisher.publishOrdered(events1m);
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
      resolveWarmupReady();
    }
  })().catch(err => console.error("Alpaca feed initialization error:", err));
} else {
  console.log(`[${instanceId}] ⚠️  No Alpaca credentials - bot running without market data feed`);
  console.log(`[${instanceId}]    Wire your own data source or set ALPACA_API_KEY and ALPACA_API_SECRET`);
  resolveWarmupReady();
}

// Option 2: Wire your own data source here
// Example: when you receive a bar, call:
//   const events = await orch.processTick({ ts, symbol, close });
//   await publisher.publishOrdered(events);

// Keep process alive
process.on("SIGTERM", () => {
  console.log(`[SHUTDOWN] SIGTERM received, shutting down gracefully...`);
  scheduler.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log(`[SHUTDOWN] SIGINT received, shutting down gracefully...`);
  scheduler.stop();
  process.exit(0);
});

// Log that we've reached the end of initialization
console.log(`[STARTUP] ✅ Initialization complete. Bot is running.`);
console.log(`[STARTUP] Waiting for market data...`);
