import type { Orchestrator } from "./orchestrator/orchestrator.js";

export class CommandHandler {
  constructor(private orch: Orchestrator) {}

  async status(): Promise<string> {
    const s = this.orch.getState();
    const fmt = (ts?: number) => (ts ? new Date(ts).toISOString() : "n/a");

    return [
      "=== Bot Status (Truthful) ===",
      "",
      "📊 PIPELINE:",
      `Last Tick: ${fmt(s.lastTickAt)}`,
      "",
      "📈 DATA:",
      `Session: ${s.session}`,
      `Price: ${s.price ?? "n/a"}`,
      `ActivePlay: ${s.activePlay ? s.activePlay.id : "None"}`,
      "",
      "⚙️ SYSTEM:",
      `Uptime: ${Math.floor((Date.now() - s.startedAt) / 1000)}s`,
    ].join("\n");
  }
}
