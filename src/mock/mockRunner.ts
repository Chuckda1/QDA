import { initTelegram } from "../telegram/telegram.js";
import { sendTelegramMessageSafe } from "../telegram/sendTelegramMessageSafe.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { orderEvents } from "../orchestrator/messageOrder.js";

const instanceId = process.env.INSTANCE_ID || "golden-bot-001";
const { bot, chatId } = initTelegram();

const orch = new Orchestrator(instanceId);

await sendTelegramMessageSafe(bot, chatId, `🤖 MOCK runner online`);

const symbol = (process.env.SYMBOLS || "SPY").split(",")[0]!.trim() || "SPY";

// deterministic bar sequence
// 1) create play + coach
// 2) enter zone once
// 3) threatened (close within buffer of stop)
// 4) stop hit (close through stop)

const start = 481.25;
const bars = [
  { close: start },                 // arms + coach
  { close: start + 0.05 },          // likely inside entry zone -> ENTRY_ELIGIBLE
  { close: start - 0.62 },          // near stop (buffer) -> STOP_THREATENED
  { close: start - 0.80 },          // through stop -> STOP_HIT and clears play
];

for (let i = 0; i < bars.length; i++) {
  const ts = Date.now() + i * 60_000;
  const events = orch.processTick({ ts, symbol, close: bars[i]!.close });
  for (const e of orderEvents(events)) {
    const text = formatEvent(instanceId, e);
    await sendTelegramMessageSafe(bot, chatId, text);
  }
  await new Promise((r) => setTimeout(r, 150));
}

await sendTelegramMessageSafe(
  bot,
  chatId,
  `✅ Mock bar feed complete (${bars.length} x 1m). Keeping bot alive 60s for /status.`
);

setTimeout(() => process.exit(0), 60_000);

function formatEvent(instanceId: string, e: any): string {
  switch (e.type) {
    case "PLAY_ARMED": {
      const p = e.data.play;
      return [
        `[${instanceId}] 🔎 ${p.mode} PLAY ARMED`,
        `Symbol: ${p.symbol}`,
        `Direction: ${p.direction}`,
        `Score: ${p.score.toFixed(1)} (${p.grade})`,
        `Entry: $${p.entryZone.low.toFixed(2)} - $${p.entryZone.high.toFixed(2)}`,
        `Stop: $${p.stop.toFixed(2)}`,
        `Targets: $${p.targets.t1.toFixed(2)}, $${p.targets.t2.toFixed(2)}, $${p.targets.t3.toFixed(2)}`
      ].join("\n");
    }
    case "TIMING_COACH":
      return [
        `[${instanceId}] 🧠 TIMING COACH`,
        `${e.data.direction} ${e.data.symbol}`,
        `Mode: ${e.data.mode}`,
        `Wait: ${e.data.waitBars} bar(s)`,
        `Confidence: ${e.data.confidence}%`,
        ``,
        `${e.data.text}`
      ].join("\n");

    case "ENTRY_ELIGIBLE":
      return [
        `[${instanceId}] ✅ ENTRY ELIGIBLE`,
        `${e.data.direction} ${e.data.symbol} @ $${e.data.close.toFixed(2)}`,
        `Entry zone: $${e.data.entryZone.low.toFixed(2)} - $${e.data.entryZone.high.toFixed(2)}`
      ].join("\n");

    case "STOP_THREATENED":
      return [
        `[${instanceId}] ⚠️ Stop threatened (close near stop).`,
        `Close=$${e.data.close.toFixed(2)}`,
        `Stop=$${e.data.stop.toFixed(2)}`
      ].join("\n");

    case "STOP_HIT":
      return [
        `[${instanceId}] 🛑 STOP HIT (close through stop).`,
        `Close=$${e.data.close.toFixed(2)}`,
        `Stop=$${e.data.stop.toFixed(2)}`
      ].join("\n");

    default:
      return `[${instanceId}] ${e.type}`;
  }
}
