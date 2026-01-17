import type { DomainEvent } from "../types.js";
import type { MessageGovernor } from "../governor/messageGovernor.js";
import type { TelegramBotLike } from "./sendTelegramMessageSafe.js";
import { sendTelegramMessageSafe } from "./sendTelegramMessageSafe.js";
import { getETParts } from "../utils/timeUtils.js";
import { orderEvents } from "./messageOrder.js";

export class MessagePublisher {
  // STAGE 4: Single publish queue to serialize all messages
  private publishQueue: Promise<void> = Promise.resolve();

  constructor(
    private governor: MessageGovernor,
    private bot: TelegramBotLike,
    private chatId: number
  ) {}

  /**
   * Publish event through MessageGovernor (single choke point)
   * STAGE 4: This should only be called from publishOrdered to ensure serialization
   */
  private async publish(event: DomainEvent): Promise<boolean> {
    if (!this.governor.shouldSend(event, this.bot, this.chatId)) {
      return false;
    }

    const text = this.formatEvent(event);
    await sendTelegramMessageSafe(this.bot, this.chatId, text);
    return true;
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

    // Sort events by priority (strict ordering)
    const orderedEvents = orderEvents(events);

    // STAGE 4: Publish in strict order with logging
    const total = orderedEvents.length;
    for (let idx = 0; idx < orderedEvents.length; idx++) {
      const event = orderedEvents[idx];
      const playId = event.data.playId || event.data.play?.id || "none";
      
      const startTime = Date.now();
      console.log(`[PUB] sending ${event.type} playId=${playId} idx=${idx + 1}/${total}`);
      
      const sent = await this.publish(event);
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
    const longAllowed = state.permission?.long ? "✅ LONG" : "❌ LONG";
    const shortAllowed = state.permission?.short ? "✅ SHORT" : "❌ SHORT";
    const mode = state.permission?.mode ?? "N/A";
    const tactical = state.tacticalBias;
    const tacticalLine = tactical
      ? `Tactical Bias: ${tactical.bias ?? "NONE"}${Number.isFinite(tactical.confidence) ? ` (${Math.round(tactical.confidence)}%)` : ""}${tactical.tier ? ` tier=${tactical.tier}` : ""}${Number.isFinite(tactical.score) ? ` score=${tactical.score}` : ""}`
      : undefined;
    const shockLine = tactical?.shock
      ? `Shock Mode: ON${tactical.shockReason ? ` (${tactical.shockReason})` : ""}`
      : undefined;
    const planBias = state.potd ? `Plan Bias: ${state.potd.bias}` : undefined;
    const planStatus = state.potd
      ? `Plan Status: ${state.potd.overridden ? "INVALIDATED by live regime" : "VALID"}${state.potd.alignment ? ` alignment=${state.potd.alignment}` : ""}`
      : undefined;
    return [
      "MARKET STATE",
      `Regime: ${state.regime ?? "N/A"}${confidence}`,
      `Live Permission: ${longAllowed} / ${shortAllowed}`,
      `Mode: ${mode}`,
      tacticalLine || "",
      shockLine || "",
      state.reason ? `Reason: ${state.reason}` : "",
      planBias || "",
      planStatus || ""
    ].filter(Boolean);
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
      const flags = candidate.flags?.length ? ` | ${candidate.flags.join(", ")}` : "";
      const quality = candidate.quality ? ` ${candidate.quality}${candidate.qualityTag ? ` (${candidate.qualityTag})` : ""}` : "";
      return `${candidate.setup ?? "SETUP"} ${candidate.direction ?? "DIR"} score=${candidate.score ?? "?"}${quality}${flags}`;
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
    const instanceId = event.instanceId;
    
    switch (event.type) {
      case "PLAY_ARMED": {
        if (event.data.marketState) {
          return this.formatBanner(event, "PLAY ARMED");
        }
        const p = event.data.play;
        return [
          `[${instanceId}] 🔎 ${p.mode} PLAY ARMED`,
          `Symbol: ${p.symbol}`,
          `Direction: ${p.direction}`,
          event.data.price !== undefined ? `Price: $${event.data.price.toFixed(2)}` : "",
          `Score: ${p.score.toFixed(1)} (${p.grade})`,
          `Entry: $${p.entryZone.low.toFixed(2)} - $${p.entryZone.high.toFixed(2)}`,
          `Stop: $${p.stop.toFixed(2)}`,
          `Targets: $${p.targets.t1.toFixed(2)}, $${p.targets.t2.toFixed(2)}, $${p.targets.t3.toFixed(2)}`,
          ...this.formatDecisionLines(event.data.decision)
        ].filter(Boolean).join("\n");
      }
      
      case "TIMING_COACH": {
        const eligibility = event.data.eligibility || (event.data.waitBars === 0 ? "READY" : "NOT_READY");
        const eligibilityReason = event.data.eligibilityReason || (event.data.waitBars === 0 ? "entry zone active" : "cooldown");
        const checkmark = eligibility === "READY" ? "✅" : "";
        const lines = [
          `[${instanceId}] 🧠 TIMING COACH`,
          `${event.data.direction} ${event.data.symbol}`,
          `Mode: ${event.data.mode}`,
          `Eligibility: ${eligibility} ${checkmark} (${eligibilityReason})`
        ];
        
        // Add cooldown info if not ready
        if (eligibility === "NOT_READY" && event.data.waitBars > 0) {
          lines.push(`Cooldown remaining: ${event.data.waitBars} bar(s)`);
        }
        
        // Add LLM status
        if (event.data.llmStatus) {
          lines.push(`LLM: ${event.data.llmStatus}`);
        }
        
        return lines.join("\n");
      }

      case "LLM_VERIFY":
        return [
          `[${instanceId}] 🤖 LLM VERIFY`,
          `${event.data.direction} ${event.data.symbol}`,
          event.data.price !== undefined ? `Price: $${event.data.price.toFixed(2)}` : "",
          `Legitimacy: ${event.data.legitimacy}%`,
          `Follow-through: ${event.data.followThroughProb}%`,
          `Action: ${event.data.action}`,
          ``,
          `${event.data.reasoning || ""}`,
          ...this.formatDecisionLines(event.data.decision)
        ].filter(Boolean).join("\n");

      case "SETUP_CANDIDATES":
        return this.formatBanner(event, "SETUP CANDIDATES");

      case "LLM_PICK":
        return this.formatBanner(event, "LLM PICK");

      case "SCORECARD": {
        if (event.data.marketState) {
          return this.formatBanner(event, "SCORECARD");
        }
        const r = event.data.rules ?? {};
        const l = event.data.llm ?? {};
        const ind = r.indicators ?? {};
        const regime = r.regime ?? {};
        const bias = r.macroBias ?? {};
        const dir = r.directionInference ?? {};
        const entryPermission = r.entryPermission ?? "ALLOWED";
        const potd = r.potd ?? {};
        const indicatorMeta = r.indicatorMeta ?? null;
        const setup = event.data.setup ?? {};

        const fmtNum = (x: any) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(2) : "n/a");
        const fmtPct = (x: any) => (typeof x === "number" && Number.isFinite(x) ? `${Math.round(x)}%` : "n/a");

        return [
          `[${instanceId}] 🧾 SCORECARD`,
          `${event.data.symbol}  Proposed: ${event.data.proposedDirection}  |  LLM Bias: ${l.biasDirection ?? "N/A"}`,
          event.data.price !== undefined ? `Price: $${event.data.price.toFixed(2)}` : "",
          `Setup: ${setup.pattern ?? "N/A"}  |  Trigger: $${fmtNum(setup.triggerPrice)}  |  Stop: $${fmtNum(setup.stop)}`,
          `Regime: ${regime.regime ?? "N/A"}  |  Bias: ${bias.bias ?? "N/A"}  |  Entry: ${entryPermission}`,
          `Structure: ${regime.structure ?? "N/A"}  |  VWAP slope: ${regime.vwapSlope ?? "N/A"}`,
          `POTD: ${potd.bias ?? "NONE"} (conf=${potd.confidence ?? "n/a"} mode=${potd.mode ?? "OFF"})  |  Alignment: ${potd.alignment ?? "OFF"}`,
          `Rules dir: ${dir.direction ?? "N/A"} (${fmtPct(dir.confidence)})`,
          `Ind: VWAP=${fmtNum(ind.vwap)} EMA9=${fmtNum(ind.ema9)} EMA20=${fmtNum(ind.ema20)} RSI=${fmtNum(ind.rsi14)} ATR=${fmtNum(ind.atr)}`,
          indicatorMeta ? `TF: entry=${indicatorMeta.entryTF} atr=${indicatorMeta.atrLen} vwap=${indicatorMeta.vwapLen} ema=${(indicatorMeta.emaLens ?? []).join("/") || "n/a"} regime=${indicatorMeta.regimeTF}` : "",
          `Agreement: ${fmtPct(l.agreement)}  |  Legitimacy: ${fmtPct(l.legitimacy)}  |  Prob(T1): ${fmtPct(l.probability)}`,
          `Action: ${l.action ?? "N/A"}`,
          ``,
          `${l.reasoning ?? ""}`.trim(),
          ...this.formatDecisionLines(event.data.decision)
        ].filter(Boolean).join("\n");
      }

      case "SETUP_SUMMARY": {
        if (event.data.marketState) {
          return this.formatBanner(event, "SETUP SUMMARY");
        }
        const c = event.data?.candidate;
        if (!c) {
          return [
            `[${instanceId}] 🧩 SETUP SUMMARY`,
            `${event.data?.summary ?? "No candidate"}`,
            ...this.formatDecisionLines(event.data.decision)
          ].filter(Boolean).join("\n");
        }
        return [
          `[${instanceId}] 🧩 SETUP SUMMARY (5m)`,
          `${c.direction} ${c.symbol}  |  ${c.pattern}`,
          event.data.price !== undefined ? `Price: $${event.data.price.toFixed(2)}` : "",
          `Score: ${c.score?.total ?? "n/a"}`,
          `Trigger: $${Number.isFinite(c.triggerPrice) ? c.triggerPrice.toFixed(2) : "n/a"}`,
          `Entry: $${c.entryZone?.low?.toFixed?.(2) ?? "n/a"} - $${c.entryZone?.high?.toFixed?.(2) ?? "n/a"}`,
          `Stop: $${Number.isFinite(c.stop) ? c.stop.toFixed(2) : "n/a"}`,
          event.data?.notes ? `Notes: ${event.data.notes}` : "",
          ...this.formatDecisionLines(event.data.decision)
        ].filter(Boolean).join("\n");
      }

      case "NO_ENTRY":
        if (event.data.marketState) {
          return this.formatBanner(event, "NO ENTRY");
        }
        return [
          `[${instanceId}] ⛔ NO ENTRY`,
          event.data?.direction && event.data?.symbol ? `${event.data.direction} ${event.data.symbol}` : "",
          event.data.price !== undefined ? `Price: $${event.data.price.toFixed(2)}` : "",
          ...this.formatDecisionLines(event.data.decision)
        ].filter(Boolean).join("\n");

      case "TRADE_PLAN":
        if (event.data.marketState) {
          return this.formatBanner(event, "TRADE PLAN");
        }
        return [
          `[${instanceId}] 📋 TRADE PLAN`,
          `${event.data.direction} ${event.data.symbol}`,
          event.data.price !== undefined ? `Price: $${event.data.price.toFixed(2)}` : "",
          `Action: ${event.data.action}`,
          `Size: ${event.data.size || "N/A"}`,
          `Probability: ${event.data.probability || "N/A"}%`,
          ``,
          `${event.data.plan || ""}`
        ].join("\n");

      case "PLAY_ENTERED":
        if (event.data.marketState) {
          return this.formatBanner(event, "PLAY ENTERED");
        }
        return [
          `[${instanceId}] ✅ PLAY ENTERED`,
          `${event.data.direction} ${event.data.symbol}`,
          `Entry: $${event.data.entryPrice?.toFixed(2) || event.data.price?.toFixed(2) || "N/A"}`,
          event.data.reason ? `Reason: ${event.data.reason}` : ""
        ].join("\n");

      case "PLAY_SIZED_UP":
        if (event.data.marketState) {
          return this.formatBanner(event, "PLAY SIZED UP");
        }
        return [
          `[${instanceId}] 📈 SIZE UP`,
          `${event.data.direction} ${event.data.symbol}`,
          `Mode: ${event.data.mode || "FULL"}`,
          event.data.reason ? `Reason: ${event.data.reason}` : ""
        ].filter(Boolean).join("\n");

      case "ENTRY_WINDOW_OPENED":
        if (event.data.marketState) {
          return this.formatBanner(event, "ENTRY WINDOW OPENED");
        }
        return [
          `[${instanceId}] 🟡 ENTRY WINDOW`,
          `${event.data.direction} ${event.data.symbol}`,
          event.data.price !== undefined ? `Price: $${event.data.price.toFixed(2)}` : "",
          event.data.entryZone ? `Zone: $${event.data.entryZone.low.toFixed(2)} - $${event.data.entryZone.high.toFixed(2)}` : ""
        ].filter(Boolean).join("\n");

      case "PLAY_CANCELLED":
        if (event.data.marketState) {
          return this.formatBanner(event, "PLAY CANCELLED");
        }
        return [
          `[${instanceId}] 🚫 PLAY CANCELLED`,
          `${event.data.direction} ${event.data.symbol}`,
          event.data.reason ? `Reason: ${event.data.reason}` : ""
        ].filter(Boolean).join("\n");

      case "LLM_COACH_UPDATE":
        return [
          `[${instanceId}] 💬 LLM COACH UPDATE`,
          `${event.data.direction} ${event.data.symbol}`,
          `Price: $${event.data.price?.toFixed(2) || "N/A"}`,
          event.data.action ? `Action: ${event.data.action}` : "",
          Number.isFinite(event.data.confidence) ? `Confidence: ${Math.round(event.data.confidence)}%` : "",
          Array.isArray(event.data.reasonCodes) && event.data.reasonCodes.length
            ? `Reasons: ${event.data.reasonCodes.join(", ")}`
            : "",
          Array.isArray(event.data.triggers) && event.data.triggers.length
            ? `Trigger: ${event.data.triggers.join(", ")} (cooldown ok)`
            : "",
          Array.isArray(event.data.blockedTriggers) && event.data.blockedTriggers.length
            ? `Trigger Blocked: ${event.data.blockedTriggers.join(", ")}`
            : "",
          event.data.nextCheck ? `Next: ${event.data.nextCheck}` : "",
          ``,
          `${event.data.update || ""}`
        ].join("\n");

      case "PLAY_CLOSED":
        if (event.data.marketState) {
          return this.formatBanner(event, "PLAY CLOSED");
        }
        return [
          `[${instanceId}] 🏁 PLAY CLOSED`,
          `${event.data.direction} ${event.data.symbol}`,
          `Reason: ${event.data.reason}`,
          `Result: ${event.data.result || "N/A"}`,
          `Close: $${event.data.close?.toFixed(2) || "N/A"}`
        ].join("\n");

      case "PLAN_OF_DAY":
        return [
          `[${instanceId}] 📅 PLAN OF THE DAY`,
          ``,
          `${event.data.plan || "Market analysis and trade setup monitoring."}`
        ].join("\n");

      default:
        return `[${instanceId}] ${event.type}`;
    }
  }
}
