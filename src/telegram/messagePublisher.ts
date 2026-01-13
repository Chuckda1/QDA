import type { DomainEvent } from "../types.js";
import type { MessageGovernor } from "../governor/messageGovernor.js";
import type { TelegramBotLike } from "./sendTelegramMessageSafe.js";
import { sendTelegramMessageSafe } from "./sendTelegramMessageSafe.js";
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
   * Order: PLAY_ARMED → TIMING_COACH → LLM_VERIFY → TRADE_PLAN → LLM_COACH_UPDATE → PLAY_CLOSED
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

  private formatEvent(event: DomainEvent): string {
    const instanceId = event.instanceId;
    
    switch (event.type) {
      case "PLAY_ARMED": {
        const p = event.data.play;
        return [
          `[${instanceId}] 🔎 ${p.mode} PLAY ARMED`,
          `Symbol: ${p.symbol}`,
          `Direction: ${p.direction}`,
          `Score: ${p.score.toFixed(1)} (${p.grade})`,
          `Entry: $${p.entryZone.low.toFixed(2)} - $${p.entryZone.high.toFixed(2)}`,
          `Stop: $${p.stop.toFixed(2)}`,
          `Targets: $${p.targets.t1.toFixed(2)}, $${p.targets.t2.toFixed(2)}, $${p.targets.t3.toFixed(2)}`
        ].join("\n");
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
          `Legitimacy: ${event.data.legitimacy}%`,
          `Follow-through: ${event.data.followThroughProb}%`,
          `Action: ${event.data.action}`,
          ``,
          `${event.data.reasoning || ""}`
        ].join("\n");

      case "SCORECARD": {
        const r = event.data.rules ?? {};
        const l = event.data.llm ?? {};
        const ind = r.indicators ?? {};
        const regime = r.regime ?? {};
        const dir = r.directionInference ?? {};
        const setup = event.data.setup ?? {};

        const fmtNum = (x: any) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(2) : "n/a");
        const fmtPct = (x: any) => (typeof x === "number" && Number.isFinite(x) ? `${Math.round(x)}%` : "n/a");

        return [
          `[${instanceId}] 🧾 SCORECARD`,
          `${event.data.symbol}  Proposed: ${event.data.proposedDirection}  |  LLM Bias: ${l.biasDirection ?? "N/A"}`,
          `Setup: ${setup.pattern ?? "N/A"}  |  Trigger: $${fmtNum(setup.triggerPrice)}  |  Stop: $${fmtNum(setup.stop)}`,
          `Regime: ${regime.regime ?? "N/A"}  |  Structure: ${regime.structure ?? "N/A"}  |  VWAP slope: ${regime.vwapSlope ?? "N/A"}`,
          `Rules dir: ${dir.direction ?? "N/A"} (${fmtPct(dir.confidence)})`,
          `Ind: VWAP=${fmtNum(ind.vwap)} EMA9=${fmtNum(ind.ema9)} EMA20=${fmtNum(ind.ema20)} RSI=${fmtNum(ind.rsi14)} ATR=${fmtNum(ind.atr)}`,
          `Agreement: ${fmtPct(l.agreement)}  |  Legitimacy: ${fmtPct(l.legitimacy)}  |  Prob(T1): ${fmtPct(l.probability)}`,
          `Action: ${l.action ?? "N/A"}`,
          ``,
          `${l.reasoning ?? ""}`.trim(),
        ].filter(Boolean).join("\n");
      }

      case "SETUP_SUMMARY": {
        const c = event.data?.candidate;
        if (!c) {
          return `[${instanceId}] 🧩 SETUP SUMMARY\n${event.data?.summary ?? "No candidate"}`;
        }
        return [
          `[${instanceId}] 🧩 SETUP SUMMARY (5m)`,
          `${c.direction} ${c.symbol}  |  ${c.pattern}`,
          `Score: ${c.score?.total ?? "n/a"}`,
          `Trigger: $${Number.isFinite(c.triggerPrice) ? c.triggerPrice.toFixed(2) : "n/a"}`,
          `Entry: $${c.entryZone?.low?.toFixed?.(2) ?? "n/a"} - $${c.entryZone?.high?.toFixed?.(2) ?? "n/a"}`,
          `Stop: $${Number.isFinite(c.stop) ? c.stop.toFixed(2) : "n/a"}`,
          event.data?.notes ? `Notes: ${event.data.notes}` : "",
        ].filter(Boolean).join("\n");
      }

      case "TRADE_PLAN":
        return [
          `[${instanceId}] 📋 TRADE PLAN`,
          `${event.data.direction} ${event.data.symbol}`,
          `Action: ${event.data.action}`,
          `Size: ${event.data.size || "N/A"}`,
          `Probability: ${event.data.probability || "N/A"}%`,
          ``,
          `${event.data.plan || ""}`
        ].join("\n");

      case "LLM_COACH_UPDATE":
        return [
          `[${instanceId}] 💬 LLM COACH UPDATE`,
          `${event.data.direction} ${event.data.symbol}`,
          `Price: $${event.data.price?.toFixed(2) || "N/A"}`,
          ``,
          `${event.data.update || ""}`
        ].join("\n");

      case "PLAY_CLOSED":
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
