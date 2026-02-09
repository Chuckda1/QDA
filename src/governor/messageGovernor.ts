import type { BotMode, DomainEvent } from "../types.js";
import type { TelegramBotLike } from "../telegram/sendTelegramMessageSafe.js";
import { getETDateString } from "../utils/timeUtils.js";

export interface GovernorState {
  lastPlanDate: string;
  dedupeKeys: Record<string, number>;
}

export class MessageGovernor {
  private mode: BotMode = "QUIET";
  private lastPlanDate: string = "";
  private dedupeKeys: Map<string, number> = new Map();

  constructor(initialState?: GovernorState) {
    if (initialState) {
      this.lastPlanDate = initialState.lastPlanDate || "";
      for (const [key, timestamp] of Object.entries(initialState.dedupeKeys || {})) {
        this.dedupeKeys.set(key, timestamp);
      }
    }
  }

  setMode(mode: BotMode): void {
    this.mode = mode;
  }

  getMode(): BotMode {
    return this.mode;
  }

  resetPlanFlag(): void {
    this.lastPlanDate = getETDateString();
  }

  exportState(): GovernorState {
    const dedupeKeysObj: Record<string, number> = {};
    for (const [key, timestamp] of this.dedupeKeys.entries()) {
      dedupeKeysObj[key] = timestamp;
    }
    return {
      lastPlanDate: this.lastPlanDate,
      dedupeKeys: dedupeKeysObj,
    };
  }

  shouldSend(event: DomainEvent, _bot: TelegramBotLike, _chatId: number): boolean {
    const key = `${event.type}_${event.timestamp}`;
    if (this.dedupeKeys.has(key)) return false;
    if (event.type !== "MIND_STATE_UPDATED" && event.type !== "LLM_1M_OPINION") return false;
    this.dedupeKeys.set(key, event.timestamp);
    return true;
  }
}
