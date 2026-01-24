import type { DomainEvent } from "../types.js";
import type { MessageGovernor } from "../governor/messageGovernor.js";
import type { TelegramBotLike } from "./sendTelegramMessageSafe.js";
import { sendTelegramMessageSafe } from "./sendTelegramMessageSafe.js";
import { buildTelegramAlert } from "./telegramFormatter.js";
import { normalizeTelegramSnapshot } from "./telegramNormalizer.js";
import { buildTelegramSignature } from "./telegramSignature.js";
import { getETParts } from "../utils/timeUtils.js";
import { orderEvents } from "./messageOrder.js";
import { isDecisionAlertEvent } from "../utils/decisionState.js";

export class MessagePublisher {
  // STAGE 4: Single publish queue to serialize all messages
  private publishQueue: Promise<void> = Promise.resolve();
  private publishState = new Map<string, { lastSentAt: number; lastSignature?: string }>();
  private suppressCounters = {
    suppressedByDedupe: 0,
    suppressedByThrottle: 0,
    publishedByException: 0,
  };
  private readonly botMode: string;

  constructor(
    private governor: MessageGovernor,
    private bot: TelegramBotLike,
    private chatId: number
  ) {
    this.botMode = (process.env.BOT_MODE || "").toLowerCase();
  }

  /**
   * Publish event through MessageGovernor (single choke point)
   * STAGE 4: This should only be called from publishOrdered to ensure serialization
   */
  private async publish(event: DomainEvent): Promise<boolean> {
    const snapshot = normalizeTelegramSnapshot(event);
    if (!snapshot) return false;
    const alert = buildTelegramAlert(snapshot);
    if (!alert || alert.lines.length === 0) {
      return false;
    }
    if (!this.governor.shouldSend(event, this.bot, this.chatId)) {
      return false;
    }

    const text = alert.text;
    await sendTelegramMessageSafe(this.bot, this.chatId, text);
    return true;
  }

  private async publishWithControls(event: DomainEvent): Promise<boolean> {
    const decision = this.shouldSuppressEvent(event);
    if (decision.suppress) {
      return false;
    }
    const sent = await this.publish(event);
    if (sent) {
      this.updatePublishState(event, decision.signature);
    }
    return sent;
  }

  private shouldSuppressEvent(event: DomainEvent): {
    suppress: boolean;
    signature?: string;
  } {
    const snapshot = normalizeTelegramSnapshot(event);
    if (!snapshot) return { suppress: true };
    const symbol = snapshot.symbol;
    const key = symbol;
    const now = Date.now();
    const state = this.publishState.get(key);
    const signature = buildTelegramSignature(snapshot);

    if (state?.lastSignature && state.lastSignature === signature) {
      this.suppressCounters.suppressedByDedupe += 1;
      return { suppress: true };
    }

    return { suppress: false, signature };
  }

  private updatePublishState(
    event: DomainEvent,
    signature?: string
  ): void {
    const snapshot = normalizeTelegramSnapshot(event);
    const symbol = snapshot?.symbol ?? event.data.symbol ?? event.data.play?.symbol ?? event.data.candidate?.symbol ?? "UNKNOWN";
    const key = symbol;
    this.publishState.set(key, {
      lastSentAt: Date.now(),
      lastSignature: signature,
    });
  }

  private mapScoreTag(quality?: string, qualityTag?: string): string {
    const tag = (qualityTag ?? "").toUpperCase();
    if (quality === "A+" || quality === "A") return "A";
    if (quality === "B") return "B";
    if (quality === "C") return "C";
    if (quality === "D") return "LOW";
    if (tag.includes("HIGH")) return "A";
    if (tag.includes("LOW")) return "LOW";
    if (tag.includes("OK")) return "OK";
    return "OK";
  }

  private shortenHoldReason(reason?: string): string | undefined {
    if (!reason) return undefined;
    const upper = reason.toUpperCase();
    if (upper.includes("WAIT_FOR_PULLBACK") || upper.includes("PULLBACK")) return "wait_pullback";
    if (upper.includes("WARMUP") || upper.includes("MISSING")) return "warmup";
    if (upper.includes("TIMING")) return "wait_timing";
    return reason.split(".")[0]?.slice(0, 24);
  }

  private formatFlags(event: DomainEvent, candidate?: any): string | undefined {
    const flags: string[] = [];
    const warningFlags = candidate?.warningFlags?.length ? candidate.warningFlags : candidate?.flags;
    if (Array.isArray(warningFlags)) {
      if (warningFlags.includes("EXTENDED")) {
        const atr = candidate?.extendedFromMeanAtr;
        flags.push(`EXTENDED${Number.isFinite(atr) ? `(${atr.toFixed(1)}ATR)` : ""}`);
      }
    }
    const entryPermission = event.data.decision?.permission ?? event.data.entryPermission ?? event.data.rules?.entryPermission;
    if (entryPermission === "WAIT_FOR_PULLBACK") {
      flags.push("PULLBACK_REQUIRED");
    }
    return flags.length ? `Flags: ${flags.join(" • ")}` : undefined;
  }

  private buildIdeasBlock(event: DomainEvent): string[] {
    const candidates = event.data.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) return [];
    const lines = candidates.slice(0, 3).map((candidate: any, idx: number) => {
      const intent = candidate.intentBucket ?? candidate.setup ?? "SETUP";
      const stage = candidate.stage ?? "READY";
      const score = Number.isFinite(candidate.score) ? candidate.score : candidate.score?.total;
      const quality = this.mapScoreTag(candidate.quality, candidate.qualityTag);
      const hold = this.shortenHoldReason(candidate.holdReason);
      const holdSuffix = hold ? ` — hold: ${hold}` : "";
      return `${idx + 1}) ${intent} ${candidate.direction ?? "DIR"} — ${stage} — score ${Math.round(score ?? 0)} (${quality})${holdSuffix}`;
    });
    return ["Ideas:", ...lines];
  }

  /**
   * Publish multiple events in strict priority order
   * 
   * STAGE 4: All messages must go through this method to ensure serialization
   * Order: PLAY_ARMED → TIMING_COACH → LLM_VERIFY → SCORECARD → NO_ENTRY → TRADE_PLAN → PLAY_ENTERED → LLM_COACH_UPDATE → PLAY_CLOSED
   * 
   * INVARIANT CHECKS:
   * - LLM_COACH_UPDATE only if play is entered
   * - PLAY_CLOSED only if active play exists
   * - TRADE_PLAN only if LLM_VERIFY exists in same batch
   */
  async publishOrdered(events: DomainEvent[]): Promise<void> {
    if (events.length === 0) return;

    // STAGE 4: Queue this batch to ensure no interleaving
    this.publishQueue = this.publishQueue.then(async () => {
      await this._publishOrderedInternal(events);
    });

    await this.publishQueue;
  }

  /**
   * Internal publish method (called from queue)
   */
  private async _publishOrderedInternal(events: DomainEvent[]): Promise<void> {
    if (this.botMode === "minimal") {
      const minimalEvents = events.filter((event) => event.type === "MIND_STATE_UPDATED");
      if (minimalEvents.length === 0) {
        console.log("[PUB] skipped batch: no MIND_STATE_UPDATED");
        return;
      }
      for (const event of minimalEvents) {
        const sent = await this.publishWithControls(event);
        if (!sent) {
          console.log("[PUB] skipped MIND_STATE_UPDATED (blocked by governor)");
        }
      }
      return;
    }
    // Track state for invariant checks
    const seenPlayIds = new Set<string>();
    const seenLLMVerify = new Set<string>();

    // First pass: validate invariants
    for (const event of events) {
      const playId = event.data.playId || event.data.play?.id;
      
      if (playId) {
        seenPlayIds.add(playId);
      }

      // Check: LLM_COACH_UPDATE should only fire if play is entered
      if (event.type === "LLM_COACH_UPDATE") {
        if (!playId) {
          console.warn(`[INVARIANT] LLM_COACH_UPDATE missing playId, skipping`);
          continue;
        }
      }

      // Check: PLAY_CLOSED should have matching playId
      if (event.type === "PLAY_CLOSED") {
        if (!playId) {
          console.warn(`[INVARIANT] PLAY_CLOSED missing playId, skipping`);
          continue;
        }
      }

      // Check: TRADE_PLAN should follow LLM_VERIFY in same batch
      if (event.type === "TRADE_PLAN") {
        if (!playId) {
          console.warn(`[INVARIANT] TRADE_PLAN missing playId, skipping`);
          continue;
        }
        // Check if LLM_VERIFY exists in this batch
        const hasLLMVerify = events.some(
          e => e.type === "LLM_VERIFY" && (e.data.playId || e.data.play?.id) === playId
        );
        if (!hasLLMVerify) {
          console.warn(`[INVARIANT] TRADE_PLAN without LLM_VERIFY for ${playId}, but continuing (may be from previous tick)`);
        }
      }

      if (event.type === "LLM_VERIFY" && playId) {
        seenLLMVerify.add(playId);
      }
    }

    const rangeModes = new Set(["CHOP", "RANGE", "RANGE_ARMED", "RANGE_EXIT_WATCH"]);
    const hasRangeMode = events.some((event) => rangeModes.has(event.data?.modeState));
    const decisionEvents = events.filter((event) => {
      if (!isDecisionAlertEvent(event)) return false;
      if (hasRangeMode) {
        return event.type === "NO_ENTRY" && event.data?.range;
      }
      return true;
    });
    if (decisionEvents.length === 0) {
      console.log("[PUB] skipped batch: no decision alerts");
      return;
    }
    // Sort events by priority (strict ordering)
    const orderedEvents = orderEvents(decisionEvents);

    // STAGE 4: Publish in strict order with logging
    const total = orderedEvents.length;
    for (let idx = 0; idx < orderedEvents.length; idx++) {
      const event = orderedEvents[idx];
      const playId = event.data.playId || event.data.play?.id || "none";
      
      const startTime = Date.now();
      console.log(`[PUB] sending ${event.type} playId=${playId} idx=${idx + 1}/${total}`);
      
      const sent = await this.publishWithControls(event);
      const duration = Date.now() - startTime;
      
      if (sent) {
        console.log(`[PUB] done ${event.type} durationMs=${duration}`);
        // Small delay to ensure Telegram receives in order
        await new Promise((r) => setTimeout(r, 100));
      } else {
        console.log(`[PUB] skipped ${event.type} (blocked by governor)`);
      }
    }
  }

  private formatDecisionLines(decision?: {
    status?: string;
    blockers?: string[];
    blockerReasons?: string[];
  }): string[] {
    if (!decision?.status) return [];
    const lines = [`Decision: ${decision.status}`];
    if (decision.status !== "ARMED") {
      const blockers = decision.blockers?.length ? decision.blockers : ["arming_failed"];
      lines.push(`Blocker: ${blockers.join(", ")}`);
      if (decision.blockerReasons?.length) {
        lines.push(`Reason: ${decision.blockerReasons.join(" | ")}`);
      }
    }
    return lines;
  }

  private formatMarketStateBlock(state?: any): string[] {
    if (!state) return [];
    const confidence = Number.isFinite(state.confidence) ? ` (Confidence: ${Math.round(state.confidence)}%)` : "";
    const mode = state.permission?.mode ?? "N/A";
    const shockLine = state.tacticalBias?.shock
      ? `Shock Mode: ON${state.tacticalBias?.shockReason ? ` (${state.tacticalBias.shockReason})` : ""}`
      : undefined;
    const planBias = state.potd ? `Plan Bias: ${state.potd.bias}` : undefined;
    const planStatus = state.potd
      ? `Plan Status: ${state.potd.overridden ? "INVALIDATED by live regime" : "VALID"}${state.potd.alignment ? ` alignment=${state.potd.alignment}` : ""}`
      : undefined;
    const dataLine = state.dataReadiness
      ? state.dataReadiness.ready
        ? `DATA: OK (bars=${state.dataReadiness.bars ?? "?"})`
        : `DATA: WARMUP (missing: ${(state.dataReadiness.missing ?? []).join(", ") || "unknown"})`
      : undefined;
    return [
      "CONTEXT / RISK MODE",
      `Context Regime: ${state.regime ?? "N/A"}${confidence}`,
      `Risk Mode: ${mode}`,
      dataLine || "",
      shockLine || "",
      state.reason ? `Reason: ${state.reason}` : "",
      planBias || "",
      planStatus || ""
    ].filter(Boolean);
  }

  private formatTacticalHeadline(state?: any): string | undefined {
    if (!state) return undefined;
    const tactical = state.tacticalSnapshot ?? state.tacticalBias;
    if (!tactical) return undefined;
    const direction = tactical.activeDirection ?? tactical.bias ?? "NEUTRAL";
    const confidence = Number.isFinite(tactical.confidence) ? `${Math.round(tactical.confidence)}%` : "N/A";
    const reasons = Array.isArray(tactical.reasons) ? tactical.reasons.slice(0, 2).join(" | ") : undefined;
    const tier = tactical.tier ? ` ${tactical.tier}` : "";
    const reasonSuffix = reasons ? ` [${reasons}]` : "";
    return `ACTIVE: ${direction}${tier} (${confidence})${reasonSuffix}`;
  }

  private formatPlayStateBlock(event: DomainEvent): string[] {
    const state = event.data.playState;
    const decisionKind = event.data.decision?.kind ? `Decision: ${event.data.decision.kind}` : "";
    if (!state) return [];
    const armReason = event.data.armReason ? `Arm Reason: ${event.data.armReason}` : "";
    const notArmed = event.data.notArmedReason ? `Not Armed Because: ${event.data.notArmedReason}` : "";
    return ["PLAY STATE", `Play State: ${state}`, decisionKind, armReason, notArmed].filter(Boolean);
  }

  private formatTopPlayBlock(event: DomainEvent): string[] {
    const top = event.data.topPlay ?? {};
    const setup = top.setup ?? event.data.setup?.pattern ?? event.data.candidate?.pattern ?? "N/A";
    const direction = top.direction ?? event.data.direction ?? event.data.candidate?.direction ?? event.data.play?.direction;
    const entryZone = top.entryZone ?? event.data.play?.entryZone ?? event.data.setup?.entryZone ?? event.data.candidate?.entryZone;
    const stop = top.stop ?? event.data.play?.stop ?? event.data.setup?.stop ?? event.data.candidate?.stop;
    const probability = top.probability ?? event.data.probability ?? event.data.llm?.probability;
    const action = top.action ?? event.data.action ?? event.data.llm?.action ?? event.data.play?.action;
    const score = top.score ?? event.data.candidate?.score?.total;
    const quality = top.quality;
    const qualityTag = top.qualityTag;
    const armStatus = top.armStatus;

    const entryLine = entryZone
      ? `Entry: $${entryZone.low.toFixed(2)} - $${entryZone.high.toFixed(2)}`
      : "Entry: N/A";
    const stopLine = Number.isFinite(stop) ? `Stop: $${stop.toFixed(2)}` : "Stop: N/A";
    const probLine = Number.isFinite(probability) ? `Prob(T1): ${Math.round(probability)}%` : "Prob(T1): N/A";
    const scoreLine = Number.isFinite(score)
      ? `Score: ${Math.round(score)}${quality ? ` (${quality}${qualityTag ? ` • ${qualityTag}` : ""})` : ""}`
      : "Score: N/A";
    const armLine = armStatus ? `Arm: ${armStatus}` : "";

    return [
      "TOP PLAY",
      `Setup: ${setup}${direction ? ` ${direction}` : ""}`,
      scoreLine,
      armLine,
      entryLine,
      stopLine,
      probLine,
      `Action: ${action ?? "N/A"}`
    ];
  }

  private formatCandidatesBlock(event: DomainEvent): string[] {
    const candidates = event.data.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) return [];
    const title = event.data.candidatesTitle ?? "CANDIDATES";
    const lines = candidates.slice(0, 5).map((candidate: any) => {
      const warningFlags = candidate.warningFlags?.length
        ? candidate.warningFlags
        : candidate.flags;
      const flags = warningFlags?.length ? ` | ${warningFlags.join(", ")}` : "";
      const quality = candidate.quality ? ` ${candidate.quality}${candidate.qualityTag ? ` (${candidate.qualityTag})` : ""}` : "";
      const stage = candidate.stage ? ` [${candidate.stage}]` : "";
      const hold = candidate.holdReason ? ` | hold=${candidate.holdReason}` : "";
      const intent = candidate.intentBucket ?? candidate.setup ?? "SETUP";
      return `${intent} ${candidate.direction ?? "DIR"}${stage} score=${candidate.score ?? "?"}${quality}${flags}${hold}`;
    });
    return [title, ...lines].filter(Boolean);
  }

  private formatBlockersBlock(params: {
    reasons?: string[];
    tags?: string[];
    decisionReasons?: string[];
    decisionTags?: string[];
  }): string[] {
    const reasons = params.decisionReasons?.length ? params.decisionReasons : params.reasons ?? [];
    const tags = params.tags?.length ? params.tags : params.decisionTags ?? [];
    if (!reasons.length && !tags.length) return [];
    const lines = ["BLOCKERS"];
    if (reasons.length) {
      lines.push(...reasons.map((b) => `- ${b}`));
    }
    if (tags.length) {
      lines.push(`Tags: ${tags.join(", ")}`);
    }
    return lines;
  }

  private formatRationaleBlock(event: DomainEvent): string[] {
    const rationale: string[] | undefined = event.data.decision?.rationale;
    if (!rationale?.length) return [];
    const kind = event.data.decision?.kind;
    const maxLines = kind === "GATE" ? 2 : 3;
    const trimmed = rationale.slice(0, maxLines);
    return ["RATIONALE", ...trimmed.map((line) => `- ${line}`)];
  }

  private formatTimingBlock(event: DomainEvent): string[] {
    const timing = event.data.timing;
    if (!timing) return [];
    const reasons = timing.reasons?.length ? `Trigger: ${timing.reasons.join(" | ")}` : undefined;
    const phase = timing.phase ?? timing.state ?? "N/A";
    const dir = timing.dir ? `Dir: ${timing.dir}` : undefined;
    const raw = timing.rawState && timing.rawState !== phase ? `Raw: ${timing.rawState}` : undefined;
    const since = Number.isFinite(timing.phaseSinceTs)
      ? (() => {
          const { hour, minute } = getETParts(new Date(timing.phaseSinceTs));
          const hh = String(hour).padStart(2, "0");
          const mm = String(minute).padStart(2, "0");
          return `Since: ${hh}:${mm} ET`;
        })()
      : undefined;
    return [
      "TIMING",
      `Phase: ${phase}`,
      dir || "",
      raw || "",
      since || "",
      Number.isFinite(timing.score) ? `TimingScore: ${Math.round(timing.score)}` : "",
      reasons || ""
    ].filter(Boolean);
  }

  private formatBanner(event: DomainEvent, title: string): string {
    const marketState = this.formatMarketStateBlock(event.data.marketState);
    const tacticalHeadline = this.formatTacticalHeadline(event.data.marketState);
    const timing = this.formatTimingBlock(event);
    const playState = this.formatPlayStateBlock(event);
    const topPlay = this.formatTopPlayBlock(event);
    const candidates = this.formatCandidatesBlock(event);
    const rationale = this.formatRationaleBlock(event);
    const blockers = this.formatBlockersBlock({
      reasons: event.data.blockerReasons,
      tags: event.data.blockerTags,
      decisionReasons: event.data.decision?.blockerReasons,
      decisionTags: event.data.decision?.blockers
    });
    const decisionKind = event.data.decision?.kind;
    const sections = [
      `[${event.instanceId}] ${title}`,
      ...(tacticalHeadline ? [tacticalHeadline] : []),
      ...marketState,
      ...(timing.length ? ["", ...timing] : []),
      ...(playState.length ? ["", ...playState] : []),
      "",
      ...topPlay,
      ...(candidates.length ? ["", ...candidates] : []),
      ...(decisionKind === "GATE" ? (blockers.length ? ["", ...blockers] : []) : []),
      ...(decisionKind === "GATE" ? (rationale.length ? ["", ...rationale] : []) : []),
      ...(decisionKind !== "GATE" ? (rationale.length ? ["", ...rationale] : []) : []),
      ...(decisionKind !== "GATE" ? (blockers.length ? ["", ...blockers] : []) : [])
    ];
    return sections.join("\n");
  }

  private formatEvent(event: DomainEvent): string {
    const snapshot = normalizeTelegramSnapshot(event);
    if (!snapshot) return "";
    const alert = buildTelegramAlert(snapshot);
    if (!alert || alert.lines.length === 0) return "";
    return alert.text;
  }
}
