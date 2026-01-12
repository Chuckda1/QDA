import type { Orchestrator } from "./orchestrator/orchestrator.js";
import type { MessageGovernor } from "./governor/messageGovernor.js";

export class CommandHandler {
  constructor(
    private orch: Orchestrator,
    private governor: MessageGovernor
  ) {}

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
      "",
      "⚙️ SYSTEM:",
      heartbeatInfo,
    ].filter(Boolean).join("\n");
  }
}
