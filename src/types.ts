export type Direction = "LONG" | "SHORT";

export type DomainEventType =
  | "PLAY_ARMED"
  | "TIMING_COACH"
  | "ENTRY_ELIGIBLE"
  | "STOP_THREATENED"
  | "STOP_HIT"
  | "HEARTBEAT";

export interface DomainEvent {
  type: DomainEventType;
  timestamp: number;
  instanceId: string;
  data: Record<string, any>;
}

export interface Play {
  id: string;
  symbol: string;
  direction: Direction;
  score: number;
  grade: string;
  entryZone: { low: number; high: number };
  stop: number;
  targets: { t1: number; t2: number; t3: number };
  mode: "FULL" | "SCOUT";
  confidence: number;

  // idempotency
  inEntryZone?: boolean;
  stopThreatened?: boolean;
  stopHit?: boolean;
}

export interface BotState {
  startedAt: number;
  lastTickAt?: number;
  session: string;
  price?: number;
  activePlay?: Play | null;
}
