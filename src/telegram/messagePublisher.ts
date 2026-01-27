import type { DomainEvent } from "../types.js";
import type { MessageGovernor } from "../governor/messageGovernor.js";
import type { TelegramBotLike } from "./sendTelegramMessageSafe.js";
import { sendTelegramMessageSafe } from "./sendTelegramMessageSafe.js";
import { buildTelegramAlert } from "./telegramFormatter.js";
import { normalizeTelegramSnapshot } from "./telegramNormalizer.js";

export class MessagePublisher {
  constructor(
    private governor: MessageGovernor,
    private bot: TelegramBotLike,
    private chatId: number
  ) {}

  async publishOrdered(events: DomainEvent[]): Promise<void> {
    for (const event of events) {
      if (!this.governor.shouldSend(event, this.bot, this.chatId)) continue;
      const snapshot = normalizeTelegramSnapshot(event);
      if (!snapshot) continue;
      const alert = buildTelegramAlert(snapshot);
      if (!alert || alert.lines.length === 0) continue;
      await sendTelegramMessageSafe(this.bot, this.chatId, alert.text);
    }
  }
}
