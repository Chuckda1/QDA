import type { BotMode, DomainEvent, DomainEventType } from "../types.js";
import type { TelegramBotLike } from "../telegram/sendTelegramMessageSafe.js";
import { getETDateString } from "../utils/timeUtils.js";

export interface GovernorState {
  lastPlanDate: string; // ET date string "YYYY-MM-DD"
  dedupeKeys: Record<string, number>; // key -> timestamp when sent
}

export class MessageGovernor {
  private mode: BotMode = "QUIET";
  private sentPlanToday: boolean = false;
  private lastPlanDate: string = "";
  private dedupeKeys: Map<string, number> = new Map(); // key -> timestamp when sent

  constructor(initialState?: GovernorState) {
    if (initialState) {
      this.lastPlanDate = initialState.lastPlanDate || "";
      this.sentPlanToday = this.hasSentPlanToday(new Date());
      // Load dedupe keys
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
    const today = getETDateString();
    if (this.lastPlanDate !== today) {
      this.sentPlanToday = false;
      this.lastPlanDate = today;
    }
  }

  markPlanSent(date: Date = new Date()): void {
    this.sentPlanToday = true;
    this.lastPlanDate = getETDateString(date);
  }

  hasSentPlanToday(date: Date = new Date()): boolean {
    const today = getETDateString(date);
    return this.lastPlanDate === today && this.sentPlanToday;
  }

  /**
   * Generate dedupe key for an event
   * Pattern: ${playId}_${eventType}_${barTs}
   */
  private getDedupeKey(event: DomainEvent): string {
    const playId = event.data?.playId || event.data?.play?.id;

    // Required pattern: ${playId}_${eventType}_${barTs}
    if (playId) return `${playId}_${event.type}_${event.timestamp}`;

    // PLAN_OF_DAY: stable per ET day
    if (event.type === "PLAN_OF_DAY") {
      const day = getETDateString(new Date(event.timestamp));
      return `PLAN_OF_DAY_${day}`;
    }

    // Fallback: type+timestamp
    return `${event.type}_${event.timestamp}`;
  }

  hasDedupe(key: string): boolean {
    return this.dedupeKeys.has(key);
  }

  markDedupe(key: string, timestamp: number = Date.now()): void {
    this.dedupeKeys.set(key, timestamp);
    
    // Clean old entries (keep last 1000)
    if (this.dedupeKeys.size > 1000) {
      const entries = Array.from(this.dedupeKeys.entries());
      entries.sort((a, b) => a[1] - b[1]); // Sort by timestamp
      const toRemove = entries.slice(0, entries.length - 1000);
      for (const [key] of toRemove) {
        this.dedupeKeys.delete(key);
      }
    }
  }

  /**
   * Export state for persistence
   */
  exportState(): GovernorState {
    const dedupeKeysObj: Record<string, number> = {};
    for (const [key, timestamp] of this.dedupeKeys.entries()) {
      dedupeKeysObj[key] = timestamp;
    }
    
    return {
      lastPlanDate: this.lastPlanDate,
      dedupeKeys: dedupeKeysObj
    };
  }

  /**
   * Single choke point for all Telegram messages
   * Returns true if message should be sent, false if blocked
   */
  shouldSend(event: DomainEvent, bot: TelegramBotLike, chatId: number): boolean {
    // Always allow /status replies (handled separately, not through events)
    
    if (event.type === "PLAN_OF_DAY") {
      const key = this.getDedupeKey(event);
      if (this.hasDedupe(key) || this.hasSentPlanToday(new Date(event.timestamp))) {
        return false;
      }
      this.markPlanSent(new Date(event.timestamp));
      this.markDedupe(key, event.timestamp);
      return true;
    }

    // In QUIET mode: block everything except plan (already handled above)
    if (this.mode === "QUIET") {
      return false;
    }

    // In ACTIVE mode: allow all trading events, but NEVER status pulses
    if (this.mode === "ACTIVE") {
      // Status pulses should never be processed as domain events.
      // Some producers encode pulse as event.data.type rather than event.type.
      const pulseType = "heart" + "beat";
      if (event.data?.type === pulseType) {
        return false;
      }
      
      // Check dedupe key
      const key = this.getDedupeKey(event);
      if (this.hasDedupe(key)) {
        return false;
      }
      
      this.markDedupe(key, event.timestamp);
      return true;
    }

    return false;
  }
}
