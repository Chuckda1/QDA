import type { Orchestrator } from "./orchestrator/orchestrator.js";
import type { MessageGovernor } from "./governor/messageGovernor.js";
import type { MessagePublisher } from "./telegram/messagePublisher.js";
import type { DomainEvent } from "./types.js";
import type { LLMService } from "./llm/llmService.js";

export class CommandHandler {
  private instanceId: string;

  constructor(
    private orch: Orchestrator,
    private governor: MessageGovernor,
    private publisher: MessagePublisher,
    instanceId: string,
    private llmService?: LLMService
  ) {
    this.instanceId = instanceId;
  }

  async status(): Promise<string> {
    const s = this.orch.getState();
    const fmt = (ts?: number) => (ts ? new Date(ts).toISOString() : "n/a");
    const counts = this.orch.getBarCounts();

    // Include basic uptime/mode info in status (but never as push message)
    const uptime = Math.floor((Date.now() - s.startedAt) / 1000);
    const uptimeInfo = `Uptime: ${uptime}s\nMode: ${s.mode}`;

    // STAGE 1: Show LLM warning in QUIET mode
    const llmWarning = (s.mode === "QUIET" && this.llmService && !this.llmService.isEnabled()) 
      ? "⚠️ LLM disabled: missing OPENAI_API_KEY"
      : null;

    const d = this.orch.getLastDiagnostics();
    const diagTail = d
      ? [
          "",
          "🧩 DIAG (latest):",
          `At: ${new Date(d.ts).toISOString()}  Price: ${d.close.toFixed(2)}`,
          `Regime: ${d.regime.regime}  |  Bias: ${d.macroBias ?? "N/A"}  |  Dir: ${d.directionInference.direction ?? "N/A"} (${d.directionInference.confidence}%)`,
          d.dataQuality?.status === "INSUFFICIENT_DATA"
            ? `Data: ${d.dataQuality.status} (${d.dataQuality.reason ?? "n/a"})`
            : null,
          d.candidate
            ? `Top candidate: ${d.candidate.direction} ${d.candidate.pattern} score=${d.candidate.score.total}`
            : `Top candidate: none (${d.setupReason ?? "n/a"})`,
        ].filter(Boolean).join("\n")
      : null;

    return [
      "=== Bot Status (Truthful) ===",
      "",
      "📊 PIPELINE:",
      `Last 1m: ${fmt(s.last1mTs)}`,
      `Last 5m: ${fmt(s.last5mTs)}`,
      `Last 15m: ${fmt(s.last15mTs)}`,
      `Last Tick: ${fmt(s.lastTickAt)}`,
      `Bar cache: 1m=${counts.bars1m} 5m=${counts.bars5m} 15m=${counts.bars15m}`,
      "",
      "📈 DATA:",
      `Session: ${s.session}`,
      `Price: ${s.price ?? "n/a"}`,
      `ActivePlay: ${s.activePlay ? s.activePlay.id : "None"}`,
      s.activePlay?.status === "ENTERED" ? `Entry Price: $${s.activePlay.entryPrice?.toFixed(2) ?? "n/a"}` : "",
      s.activePlay ? `Status: ${s.activePlay.status}` : "",
      "",
      "⚙️ SYSTEM:",
      uptimeInfo,
      llmWarning,
      diagTail,
    ].filter(Boolean).join("\n");
  }

  async diag(): Promise<string> {
    const d = this.orch.getLastDiagnostics();
    if (!d) return "No diagnostics yet (waiting for enough bars).";

    const guardrailStatus = this.orch.getGuardrailStatus();
    const counts = d.barCounts ?? this.orch.getBarCounts();

    const lines: string[] = [];
    lines.push("=== Diagnostics (/diag) ===");
    lines.push(`Time: ${new Date(d.ts).toISOString()}`);
    lines.push(`Symbol: ${d.symbol}`);
    lines.push(`Price: ${d.close.toFixed(2)}`);
    lines.push("");
    lines.push("📦 BAR COUNTS:");
    lines.push(`- 1m: ${counts.bars1m}`);
    lines.push(`- 5m: ${counts.bars5m} (min=${counts.minBars5m})`);
    lines.push(`- 15m: ${counts.bars15m} (min=${counts.minBars15m})`);
    lines.push(`- Regime min bars: ${counts.minBarsRegime}`);
    if (d.dataQuality) {
      lines.push(`- Data quality: ${d.dataQuality.status}${d.dataQuality.reason ? ` (${d.dataQuality.reason})` : ""}`);
      if (d.dataQuality.status === "INSUFFICIENT_DATA") {
        lines.push(`- Sources: regime=${d.dataQuality.regimeSource ?? "UNKNOWN"} bias=${d.dataQuality.biasSource ?? "UNKNOWN"} dir=${d.dataQuality.directionSource ?? "UNKNOWN"}`);
      }
    }
    lines.push("");
    lines.push("🛡️ GUARDRAILS:");
    lines.push(`- Plays today: ${guardrailStatus.playsToday}/${guardrailStatus.maxPlaysPerETDay} (ET day: ${guardrailStatus.currentETDay})`);
    if (guardrailStatus.cooldownAfterStop.active) {
      lines.push(`- Cooldown after stop: ${guardrailStatus.cooldownAfterStop.remainingMin} min remaining`);
    }
    if (guardrailStatus.cooldownAfterLLMPass.active) {
      lines.push(`- Cooldown after LLM PASS: ${guardrailStatus.cooldownAfterLLMPass.remainingMin} min remaining`);
    }
    if (guardrailStatus.cooldownAfterPlayClosed.active) {
      lines.push(`- Cooldown after play closed: ${guardrailStatus.cooldownAfterPlayClosed.remainingMin} min remaining`);
    }
    if (!guardrailStatus.cooldownAfterStop.active && !guardrailStatus.cooldownAfterLLMPass.active && !guardrailStatus.cooldownAfterPlayClosed.active) {
      lines.push(`- No active cooldowns`);
    }
    lines.push("");
    lines.push("REGIME:");
    lines.push(`- ${d.regime.regime}`);
    if (d.macroBias) {
      lines.push(`- Macro bias: ${d.macroBias}`);
    }
    if (d.regimeEvidence) {
      lines.push(`- Evidence scores: bull=${d.regimeEvidence.bullScore}/3 bear=${d.regimeEvidence.bearScore}/3`);
    }
    lines.push(`- ${d.regime.reasons.join(" | ")}`);
    lines.push("");
    lines.push("DIRECTION:");
    lines.push(`- ${d.directionInference.direction ?? "N/A"} (confidence=${d.directionInference.confidence}%)`);
    lines.push(`- ${d.directionInference.reasons.join(" | ")}`);
    lines.push("");
    lines.push("SETUP:");
    if (d.candidate) {
      lines.push(`- Top: ${d.candidate.direction} ${d.candidate.pattern} score=${d.candidate.score.total}`);
      lines.push(`- Entry: ${d.candidate.entryZone.low.toFixed(2)} - ${d.candidate.entryZone.high.toFixed(2)}  Stop: ${d.candidate.stop.toFixed(2)}`);
      lines.push(`- Targets: ${d.candidate.targets.t1.toFixed(2)}, ${d.candidate.targets.t2.toFixed(2)}, ${d.candidate.targets.t3.toFixed(2)}`);
    } else {
      lines.push(`- None`);
    }
    lines.push("");
    lines.push("🚫 BLOCK REASON:");
    if (d.datafeedIssue) {
      lines.push(`- Datafeed: ${d.datafeedIssue}`);
    }
    if (d.guardrailBlock) {
      lines.push(`- Guardrail: ${d.guardrailBlock}`);
    }
    if (d.setupReason && !d.datafeedIssue) {
      lines.push(`- ${d.setupReason}`);
    }
    if (!d.datafeedIssue && !d.guardrailBlock && !d.setupReason) {
      lines.push(`- No block (setup found)`);
    }
    if (d.entryFilterWarnings?.length) {
      lines.push("");
      lines.push("FILTER WARNINGS:");
      lines.push(`- ${d.entryFilterWarnings.join(" | ")}`);
    }
    if (d.entryPermission) {
      lines.push("");
      lines.push("ENTRY PERMISSION:");
      lines.push(`- ${d.entryPermission}`);
    }
    if (d.setupDebug) {
      lines.push("");
      lines.push("DEBUG:");
      lines.push(`- ${JSON.stringify(d.setupDebug, null, 2)}`);
    }
    return lines.join("\n");
  }

  /**
   * Manually mark play as entered (when you actually enter the trade)
   */
  async enter(): Promise<string> {
    const s = this.orch.getState();
    if (!s.activePlay) {
      return "❌ No active play to enter. Wait for a play to be armed first.";
    }
    
    if (s.activePlay.status === "ENTERED") {
      return `✅ Play ${s.activePlay.id} already marked as entered at $${s.activePlay.entryPrice?.toFixed(2) ?? "unknown"}`;
    }

    // Mark as entered with current price
    const entryPrice = s.price || (s.activePlay.entryZone.low + s.activePlay.entryZone.high) / 2;
    const enteredAt = Date.now();
    s.activePlay.status = "ENTERED";
    s.activePlay.entered = true;
    s.activePlay.entryPrice = entryPrice;
    s.activePlay.entryTimestamp = enteredAt;

    const event: DomainEvent = {
      type: "PLAY_ENTERED",
      timestamp: enteredAt,
      instanceId: this.instanceId,
      data: {
        playId: s.activePlay.id,
        symbol: s.activePlay.symbol,
        direction: s.activePlay.direction,
        price: entryPrice,
        entryPrice
      }
    };

    await this.publisher.publishOrdered([event]);

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
    play.status = "CLOSED";

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

  /**
   * STAGE 0: Version command with BUILD_ID and git SHA
   */
  async version(buildId: string): Promise<string> {
    const s = this.orch.getState();
    const gitSha = process.env.RAILWAY_GIT_COMMIT_SHA || 
                   process.env.RAILWAY_GIT_COMMIT_REF || 
                   process.env.GIT_COMMIT_SHA || 
                   "unknown";
    
    return [
      "=== Version Info ===",
      `BUILD_ID: ${buildId}`,
      `Git SHA: ${gitSha}`,
      `Mode: ${s.mode}`,
      `Instance: ${this.instanceId}`,
      `Uptime: ${Math.floor((Date.now() - s.startedAt) / 1000)}s`
    ].join("\n");
  }

  /**
   * STAGE 1: Test LLM connection
   */
  async llmtest(): Promise<string> {
    if (!this.llmService) {
      return "❌ LLM service not initialized";
    }

    const result = await this.llmService.testConnection();
    
    if (result.success) {
      return `✅ LLM test successful\nLatency: ${result.latency}ms`;
    } else {
      return `❌ LLM test failed\nLatency: ${result.latency}ms\nError: ${result.error || "Unknown error"}`;
    }
  }

  /**
   * STAGE 1: Debug environment variables (for troubleshooting)
   */
  async envdebug(): Promise<string> {
    const envVars = [
      "OPENAI_API_KEY",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_CHAT_ID",
      "ALPACA_API_KEY",
      "ALPACA_API_SECRET",
      "ALPACA_BASE_URL",
      "ALPACA_DATA_URL",
      "ALPACA_FEED",
      "WARMUP_5M_BARS",
      "WARMUP_1M_BARS",
      "SYMBOLS",
      "NODE_ENV",
      "INSTANCE_ID"
    ];

    const results = envVars.map(varName => {
      const value = process.env[varName];
      if (!value) {
        return `${varName}: ❌ NOT SET`;
      }
      // Show first 10 chars and length for sensitive vars
      if (varName.includes("KEY") || varName.includes("SECRET") || varName.includes("TOKEN")) {
        const preview = value.substring(0, 10);
        return `${varName}: ✅ SET (length: ${value.length}, starts: ${preview}...)`;
      }
      return `${varName}: ✅ SET (${value})`;
    });

    return [
      "=== Environment Variables Debug ===",
      "",
      ...results,
      "",
      "Note: If OPENAI_API_KEY shows NOT SET but you set it in Railway:",
      "1. Check variable is saved in Railway Variables",
      "2. Redeploy the service",
      "3. Check if variable is set at service level (not just project level)"
    ].join("\n");
  }
}
