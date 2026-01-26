import type { DomainEvent, DomainEventType } from "../types.js";

/**
 * Message priority order (lower number = higher priority, sent first)
 * Enforces strict ordering: PLAY_ARMED → TIMING_COACH → LLM_VERIFY → SCORECARD → NO_ENTRY → TRADE_PLAN → PLAY_ENTERED
 * Then during trade: LLM_COACH_UPDATE (every 5m)
 * On exit: PLAY_CLOSED
 */
const PRIORITY: Record<DomainEventType, number> = {
  PLAY_ARMED: 1,
  ENTRY_WINDOW_OPENED: 2,
  TIMING_COACH: 3,
  SETUP_CANDIDATES: 4,
  LLM_PICK: 5,
  LLM_VERIFY: 6,
  SCORECARD: 7,
  SETUP_SUMMARY: 8,
  NO_ENTRY: 9,
  TRADE_PLAN: 10,
  PLAY_ENTERED: 11,
  PLAY_SIZED_UP: 12,
  ARMED_COACH: 13, // Pre-entry coaching (happens on 5m bars while waiting for entry)
  LLM_COACH_UPDATE: 14, // Position management coaching (after entry)
  PLAY_CANCELLED: 15,
  PLAY_CLOSED: 16,
  PREMARKET_UPDATE: 17,
  VOLUME_UPDATE: 18,
  PLAN_OF_DAY: 0, // Highest priority (scheduled)
  MIND_STATE_UPDATED: 2,
  SESSION_UPDATE: 19,
};

/**
 * Sort events by priority, then by timestamp
 * Ensures strict message ordering
 */
export function orderEvents(events: DomainEvent[]): DomainEvent[] {
  return [...events].sort((a, b) => {
    const priorityA = PRIORITY[a.type] ?? 99;
    const priorityB = PRIORITY[b.type] ?? 99;
    
    // First sort by priority
    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }
    
    // Then by timestamp
    if (a.timestamp !== b.timestamp) {
      return a.timestamp - b.timestamp;
    }
    
    // Finally by type name (for same priority + timestamp)
    return a.type.localeCompare(b.type);
  });
}
