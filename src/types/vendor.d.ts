// TypeScript shim for node-telegram-bot-api
// Fixes TS7016/TS2709 errors when importing from node-telegram-bot-api
// Explicit default export ensures TS doesn't treat it as a namespace type
declare module "node-telegram-bot-api" {
  const TelegramBot: any;
  export default TelegramBot;
}
