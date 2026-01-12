import { initTelegram } from "./telegram/telegram.js";
import { sendTelegramMessageSafe } from "./telegram/sendTelegramMessageSafe.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { orderEvents } from "./orchestrator/messageOrder.js";
import { CommandHandler } from "./commands.js";
import { yieldNow } from "./utils/yieldNow.js";

const instanceId = process.env.INSTANCE_ID || "golden-bot-001";
const HEARTBEAT = (process.env.HEARTBEAT ?? "1") !== "0";

const { bot, chatId } = initTelegram();
const orch = new Orchestrator(instanceId);
const commands = new CommandHandler(orch);

bot.onText(/\/status/, async () => {
  await yieldNow();
  const msg = await commands.status();
  await sendTelegramMessageSafe(bot, chatId, msg);
});

// simple "online"
await sendTelegramMessageSafe(bot, chatId, `[${instanceId}] ✅ Bot online (REAL mode).`);

if (HEARTBEAT) {
  setInterval(async () => {
    const e = orch.heartbeat(Date.now());
    const text = `[${instanceId}] 💗 Heartbeat\nSession: ${e.data.session}\nPrice: ${e.data.price ?? "n/a"}\nActivePlay: ${e.data.activePlay ?? "None"}`;
    await sendTelegramMessageSafe(bot, chatId, text);
  }, 15000);
}

// REAL mode does nothing unless you wire a data feed later.
// Keeping it intentionally empty to avoid Alpaca hard dependency.
