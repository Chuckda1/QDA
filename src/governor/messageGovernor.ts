import type { BotMode, DomainEvent, DomainEventType } from "../types.js";
import type { TelegramBotLike } from "../telegram/sendTelegramMessageSafe.js";

export class MessageGovernor {
  private mode: BotMode = "QUIET";
  private sentPlanToday: boolean = false;
  private lastPlanDate: string = "";

  setMode(mode: BotMode): void {
    this.mode = mode;
  }

  getMode(): BotMode {
    return this.mode;
  }

  resetPlanFlag(): void {
    const today = new Date().toISOString().split("T")[0];
    if (this.lastPlanDate !== today) {
      this.sentPlanToday = false;
      this.lastPlanDate = today;
    }
  }

  markPlanSent(): void {
    this.sentPlanToday = true;
  }

  /**
   * Single choke point for all Telegram messages
   * Returns true if message should be sent, false if blocked
   */
  shouldSend(event: DomainEvent, bot: TelegramBotLike, chatId: number): boolean {
    // Always allow /status replies (handled separately, not through events)
    
    // Always allow fatal errors (optional, but we'll allow them)
    if (event.type === "PLAN_OF_DAY") {
      // Plan of Day: only at 09:25, once per day
      if (!this.sentPlanToday) {
        this.markPlanSent();
        return true;
      }
      return false;
    }

    // In QUIET mode: block everything except plan (already handled above)
    if (this.mode === "QUIET") {
      return false;
    }

    // In ACTIVE mode: allow all trading events, but NEVER any internal periodic telemetry
    if (this.mode === "ACTIVE") {
      return true;
    }

    return false;
  }
}
