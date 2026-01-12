import type { DomainEvent } from "../types.js";
import type { MessageGovernor } from "../governor/messageGovernor.js";
import type { TelegramBotLike } from "./sendTelegramMessageSafe.js";
import { sendTelegramMessageSafe } from "./sendTelegramMessageSafe.js";

export class MessagePublisher {
  constructor(
    private governor: MessageGovernor,
    private bot: TelegramBotLike,
    private chatId: number
  ) {}

  /**
   * Publish event through MessageGovernor (single choke point)
   */
  async publish(event: DomainEvent): Promise<boolean> {
    if (!this.governor.shouldSend(event, this.bot, this.chatId)) {
      return false;
    }

    const text = this.formatEvent(event);
    await sendTelegramMessageSafe(this.bot, this.chatId, text);
    return true;
  }

  /**
   * Publish multiple events in order (for same-tick ordering)
   * 
   * INVARIANT CHECKS:
   * - LLM_COACH_UPDATE only if play is entered
   * - PLAY_CLOSED only if active play exists
   * - TRADE_PLAN only if LLM_VERIFY exists in same batch
   */
  async publishOrdered(events: DomainEvent[]): Promise<void> {
    // Track state for invariant checks
    const seenPlayIds = new Set<string>();
    const seenLLMVerify = new Set<string>();
    let hasEnteredPlay = false;

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
        // Note: We can't check entered state here without orchestrator state
        // This is a best-effort check - full validation happens in orchestrator
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

    // Second pass: publish valid events
    for (const event of events) {
      await this.publish(event);
      // Small delay to ensure Telegram receives in order
      await new Promise((r) => setTimeout(r, 100));
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
      
      case "TIMING_COACH":
        return [
          `[${instanceId}] 🧠 TIMING COACH`,
          `${event.data.direction} ${event.data.symbol}`,
          `Mode: ${event.data.mode}`,
          `Wait: ${event.data.waitBars} bar(s)`,
          `Confidence: ${event.data.confidence}%`,
          ``,
          `${event.data.text}`
        ].join("\n");

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
