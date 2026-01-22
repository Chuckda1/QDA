import type { DomainEvent, DomainEventType } from "../types.js";

export type DecisionState = "SIGNAL" | "WATCH" | "UPDATE" | "MANAGE";

const DECISION_STATES = new Set<DecisionState>(["SIGNAL", "WATCH", "UPDATE", "MANAGE"]);

const INTERNAL_EVENT_TYPES = new Set<DomainEventType>([
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
  if (isInternalEventType(event.type)) return false;
  return isActionableDecisionState(getDecisionState(event));
};
