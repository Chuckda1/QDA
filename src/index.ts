import { initTelegram } from "./telegram/telegram.js";
import { sendTelegramMessageSafe } from "./telegram/sendTelegramMessageSafe.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { MessageGovernor } from "./governor/messageGovernor.js";
import { MessagePublisher } from "./telegram/messagePublisher.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { CommandHandler } from "./commands.js";
import { yieldNow } from "./utils/yieldNow.js";
import { LLMService } from "./llm/llmService.js";
import { BarAggregator } from "./datafeed/barAggregator.js";

const instanceId = process.env.INSTANCE_ID || "qda-bot-001";

// Initialize Telegram
const { bot, chatId } = initTelegram();

// Initialize LLM service (optional - will work without it)
let llmService: LLMService | undefined;
try {
  llmService = new LLMService();
} catch (error: any) {
  console.warn("LLM service not available:", error.message);
}

// Initialize core components
const governor = new MessageGovernor();
const orch = new Orchestrator(instanceId, llmService);
const publisher = new MessagePublisher(governor, bot, chatId);
const commands = new CommandHandler(orch, governor, publisher, instanceId);

// Initialize scheduler
const scheduler = new Scheduler(governor, publisher, instanceId, (mode) => {
  orch.setMode(mode);
});

// Start scheduler
scheduler.start();

// Register commands
bot.onText(/\/status/, async () => {
  await yieldNow();
  const msg = await commands.status();
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

// Startup message
await sendTelegramMessageSafe(bot, chatId, `[${instanceId}] ✅ Bot online. Mode: ${governor.getMode()}`);

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
        feed: feed
      });
      
      const symbol = process.env.SYMBOLS?.split(",")[0]?.trim() || "SPY";
      const agg = new BarAggregator();
      
      console.log(`[${instanceId}] 📊 Alpaca ${feed.toUpperCase()} feed connecting for ${symbol}...`);
      
      // Use WebSocket for real-time bars (preferred)
      try {
        console.log(`[${instanceId}] Starting bar processing loop...`);
        for await (const bar of alpacaFeed.subscribeBars(symbol)) {
          if (governor.getMode() !== "ACTIVE") {
            console.log(`[${instanceId}] Skipping bar - mode is ${governor.getMode()}, not ACTIVE`);
            continue;
          }

          try {
            // 1m processing
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
            const bar5m = agg.push1m(bar);
            if (bar5m) {
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
          if (governor.getMode() !== "ACTIVE") {
            console.log(`[${instanceId}] Skipping bar - mode is ${governor.getMode()}, not ACTIVE`);
            continue;
          }

          try {
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

            const bar5m = agg.push1m(bar);
            if (bar5m) {
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
