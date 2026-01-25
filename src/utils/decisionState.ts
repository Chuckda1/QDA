import type { DomainEvent } from "../types.js";
import type { LegacyDecisionState, LegacyDomainEventType } from "../legacy/legacyTypes.js";

export type DecisionState = LegacyDecisionState;

const DECISION_STATES = new Set<DecisionState>(["SIGNAL", "WATCH", "UPDATE", "MANAGE"]);

const INTERNAL_EVENT_TYPES = new Set<LegacyDomainEventType>([
  "SETUP_CANDIDATES",
  "LLM_VERIFY",
  "LLM_PICK",
  "SCORECARD",
  "SETUP_SUMMARY",
  "TIMING_COACH",
  "ENTRY_WINDOW_OPENED",
  "TRADE_PLAN",
  "ARMED_COACH"
]);

const DECISION_ALERT_EVENT_TYPES = new Set<LegacyDomainEventType>([
  "PLAY_ARMED",
  "PLAY_ENTERED",
  "PLAY_SIZED_UP",
  "PLAY_CANCELLED",
  "PLAY_CLOSED",
  "NO_ENTRY",
  "LLM_COACH_UPDATE",
  "PREMARKET_UPDATE",
  "VOLUME_UPDATE",
  "PLAN_OF_DAY",
  "MIND_STATE_UPDATED"
]);

export const getDecisionState = (event: DomainEvent): DecisionState | undefined => {
  const raw =
    event.data?.decisionState ??
    event.data?.decision?.decisionState ??
    event.data?.decision?.state;
  return DECISION_STATES.has(raw) ? (raw as DecisionState) : undefined;
};

export const isActionableDecisionState = (state?: string): state is DecisionState =>
  !!state && DECISION_STATES.has(state as DecisionState);

export const isInternalEventType = (type: DomainEventType): boolean => INTERNAL_EVENT_TYPES.has(type);

export const isDecisionAlertEvent = (event: DomainEvent): boolean => {
  if (event.type === "PLAN_OF_DAY") return true;
  if (event.type === "MIND_STATE_UPDATED") return true;
  if (isInternalEventType(event.type)) return false;
  return isActionableDecisionState(getDecisionState(event));
};

export const requiresDecisionState = (type: DomainEventType): boolean =>
  DECISION_ALERT_EVENT_TYPES.has(type) && type !== "PLAN_OF_DAY";
