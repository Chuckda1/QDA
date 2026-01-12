import type { Orchestrator } from "./orchestrator/orchestrator.js";
import type { MessageGovernor } from "./governor/messageGovernor.js";
import type { MessagePublisher } from "./telegram/messagePublisher.js";
import type { DomainEvent } from "./types.js";

export class CommandHandler {
  private instanceId: string;

  constructor(
    private orch: Orchestrator,
    private governor: MessageGovernor,
    private publisher: MessagePublisher,
    instanceId: string
  ) {
    this.instanceId = instanceId;
  }

  async status(): Promise<string> {
    const s = this.orch.getState();
    const fmt = (ts?: number) => (ts ? new Date(ts).toISOString() : "n/a");

    // Include heartbeat info in status (but never as push message)
    const uptime = Math.floor((Date.now() - s.startedAt) / 1000);
    const heartbeatInfo = `Uptime: ${uptime}s\nMode: ${s.mode}`;

    return [
      "=== Bot Status (Truthful) ===",
      "",
      "📊 PIPELINE:",
      `Last 1m: ${fmt(s.last1mTs)}`,
      `Last 5m: ${fmt(s.last5mTs)}`,
      `Last Tick: ${fmt(s.lastTickAt)}`,
      "",
      "📈 DATA:",
      `Session: ${s.session}`,
      `Price: ${s.price ?? "n/a"}`,
      `ActivePlay: ${s.activePlay ? s.activePlay.id : "None"}`,
      s.activePlay?.entered ? `Entry Price: $${s.activePlay.entryPrice?.toFixed(2) ?? "n/a"}` : "",
      s.activePlay ? `Entered: ${s.activePlay.entered ? "Yes" : "No"}` : "",
      "",
      "⚙️ SYSTEM:",
      heartbeatInfo,
    ].filter(Boolean).join("\n");
  }

  /**
   * Manually mark play as entered (when you actually enter the trade)
   */
  async enter(): Promise<string> {
    const s = this.orch.getState();
    if (!s.activePlay) {
      return "❌ No active play to enter. Wait for a play to be armed first.";
    }
    
    if (s.activePlay.entered) {
      return `✅ Play ${s.activePlay.id} already marked as entered at $${s.activePlay.entryPrice?.toFixed(2) ?? "unknown"}`;
    }

    // Mark as entered with current price
    const entryPrice = s.price || (s.activePlay.entryZone.low + s.activePlay.entryZone.high) / 2;
    s.activePlay.entered = true;
    s.activePlay.entryPrice = entryPrice;
    s.activePlay.entryTimestamp = Date.now();

    return `✅ Play ${s.activePlay.id} marked as ENTERED\nEntry Price: $${entryPrice.toFixed(2)}\nSymbol: ${s.activePlay.symbol} ${s.activePlay.direction}`;
  }

  /**
   * Manually close the active play (when you exit the trade)
   */
  async exit(reason?: string): Promise<string> {
    const s = this.orch.getState();
    if (!s.activePlay) {
      return "❌ No active play to exit.";
    }

    const play = s.activePlay;
    const currentPrice = s.price || play.entryPrice || (play.entryZone.low + play.entryZone.high) / 2;
    const entryPrice = play.entryPrice || (play.entryZone.low + play.entryZone.high) / 2;
    
    // Calculate result
    const profit = play.direction === "LONG" 
      ? currentPrice - entryPrice 
      : entryPrice - currentPrice;
    const profitPct = entryPrice > 0 ? (profit / entryPrice) * 100 : 0;
    const result = profit > 0 ? "WIN" : profit < 0 ? "LOSS" : "BREAKEVEN";

    // Create PLAY_CLOSED event
    const event: DomainEvent = {
      type: "PLAY_CLOSED",
      timestamp: Date.now(),
      instanceId: this.instanceId,
      data: {
        playId: play.id,
        symbol: play.symbol,
        direction: play.direction,
        close: currentPrice,
        stop: play.stop,
        reason: reason || "Manual exit via /exit command",
        result,
        exitType: "MANUAL",
        profit: profit.toFixed(2),
        profitPercent: profitPct.toFixed(2),
        llmAction: "MANUAL_EXIT"
      }
    };

    // Publish the event
    await this.publisher.publishOrdered([event]);

    // Clear the play
    s.activePlay = null;

    return `✅ Play ${play.id} CLOSED\nReason: ${reason || "Manual exit"}\nResult: ${result}\nEntry: $${entryPrice.toFixed(2)}\nExit: $${currentPrice.toFixed(2)}\nP&L: $${profit.toFixed(2)} (${profitPct > 0 ? "+" : ""}${profitPct.toFixed(2)}%)`;
  }
}
