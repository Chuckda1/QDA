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
  LLM_VERIFY: 4,
  SCORECARD: 5,
  SETUP_SUMMARY: 6,
  NO_ENTRY: 7,
  TRADE_PLAN: 8,
  PLAY_ENTERED: 9,
  PLAY_SIZED_UP: 10,
  ARMED_COACH: 11, // Pre-entry coaching (happens on 5m bars while waiting for entry)
  LLM_COACH_UPDATE: 12, // Position management coaching (after entry)
  PLAY_CANCELLED: 13,
  PLAY_CLOSED: 14,
  PLAN_OF_DAY: 0, // Highest priority (scheduled)
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
