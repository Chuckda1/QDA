import TelegramBot from "node-telegram-bot-api";

export function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

export function initTelegram(): { bot: TelegramBot; chatId: number } {
  const token = requireEnv("TELEGRAM_BOT_TOKEN");
  const chatIdStr = requireEnv("TELEGRAM_CHAT_ID");
  const chatId = Number(chatIdStr);
  if (!Number.isFinite(chatId)) throw new Error("TELEGRAM_CHAT_ID must be a number");

  const bot = new TelegramBot(token, { polling: true });
  return { bot, chatId };
}
