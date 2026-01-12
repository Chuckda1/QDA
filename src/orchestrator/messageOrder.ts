import type { DomainEvent, DomainEventType } from "../types.js";

const priority: Record<DomainEventType, number> = {
  PLAY_ARMED: 1,
  TIMING_COACH: 2,
  ENTRY_ELIGIBLE: 3,
  STOP_THREATENED: 4,
  STOP_HIT: 5,
  HEARTBEAT: 9
};

export function orderEvents(events: DomainEvent[]): DomainEvent[] {
  return [...events].sort((a, b) => {
    const pa = priority[a.type] ?? 99;
    const pb = priority[b.type] ?? 99;
    if (pa !== pb) return pa - pb;
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return a.type.localeCompare(b.type);
  });
}
