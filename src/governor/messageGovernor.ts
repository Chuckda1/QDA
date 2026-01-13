import type { BotMode, DomainEvent, DomainEventType } from "../types.js";
import type { TelegramBotLike } from "../telegram/sendTelegramMessageSafe.js";
import { getETDateString } from "../utils/timeUtils.js";
import type { GovernorPersistedState } from "../persistence/persistedState.js";

export class MessageGovernor {
  private mode: BotMode = "QUIET";
  private lastPlanDate: string = "";
  private dedupe: Map<string, number> = new Map();
  private readonly dedupeMaxKeys: number;
  private readonly dedupeTtlMs: number;

  constructor(initial?: GovernorPersistedState) {
    this.dedupeMaxKeys = Number(process.env.DEDUPE_MAX_KEYS || 2500);
    this.dedupeTtlMs = Number(process.env.DEDUPE_TTL_MS || 48 * 60 * 60 * 1000); // 48h

    if (initial?.lastPlanDate) this.lastPlanDate = initial.lastPlanDate;
    if (initial?.dedupe) {
      for (const [k, v] of Object.entries(initial.dedupe)) {
        if (typeof v === "number" && Number.isFinite(v)) this.dedupe.set(k, v);
      }
      this.pruneDedupe(Date.now());
    }
  }

  setMode(mode: BotMode): void {
    this.mode = mode;
  }

  getMode(): BotMode {
    return this.mode;
  }

  hasSentPlanToday(now: Date = new Date()): boolean {
    const today = getETDateString(now);
    return this.lastPlanDate === today;
  }

  markPlanSent(now: Date = new Date()): void {
    this.lastPlanDate = getETDateString(now);
    // Also mark a dedupe key to protect against restart/retry races.
    const k = `PLAN_OF_DAY_${this.lastPlanDate}`;
    this.markDedupe(k, Date.now());
  }

  exportState(): GovernorPersistedState {
    const dedupe: Record<string, number> = {};
    for (const [k, v] of this.dedupe.entries()) dedupe[k] = v;
    return {
      lastPlanDate: this.lastPlanDate || undefined,
      dedupe: Object.keys(dedupe).length ? dedupe : undefined,
    };
  }

  private pruneDedupe(nowMs: number): void {
    // TTL prune
    for (const [k, v] of this.dedupe.entries()) {
      if (nowMs - v > this.dedupeTtlMs) this.dedupe.delete(k);
    }

    // Size prune (remove oldest)
    if (this.dedupe.size <= this.dedupeMaxKeys) return;
    const entries = [...this.dedupe.entries()].sort((a, b) => a[1] - b[1]);
    const toRemove = this.dedupe.size - this.dedupeMaxKeys;
    for (let i = 0; i < toRemove; i++) this.dedupe.delete(entries[i]![0]);
  }

  private hasDedupe(key: string): boolean {
    const v = this.dedupe.get(key);
    if (typeof v !== "number") return false;
    if (Date.now() - v > this.dedupeTtlMs) {
      this.dedupe.delete(key);
      return false;
    }
    return true;
  }

  private markDedupe(key: string, atMs: number): void {
    this.dedupe.set(key, atMs);
    this.pruneDedupe(atMs);
  }

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

  /**
   * Single choke point for all Telegram messages
   * Returns true if message should be sent, false if blocked
   */
  shouldSend(event: DomainEvent, bot: TelegramBotLike, chatId: number): boolean {
    // Always allow /status replies (handled separately, not through events)
    
    // Always allow fatal errors (optional, but we'll allow them)
    if (event.type === "PLAN_OF_DAY") {
      // Plan of Day: only at 09:25, once per day
      const key = this.getDedupeKey(event);
      if (this.hasDedupe(key) || this.hasSentPlanToday(new Date(event.timestamp))) return false;
      this.markPlanSent(new Date(event.timestamp));
      return true;
    }

    // In QUIET mode: block everything except plan (already handled above)
    if (this.mode === "QUIET") {
      return false;
    }

    // In ACTIVE mode: allow all trading events, but NEVER any internal periodic telemetry
    if (this.mode === "ACTIVE") {
      const key = this.getDedupeKey(event);
      if (this.hasDedupe(key)) return false;
      this.markDedupe(key, Date.now());
      return true;
    }

    return false;
  }
}
