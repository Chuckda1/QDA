import type { Orchestrator } from "./orchestrator/orchestrator.js";
import type { LLMService } from "./llm/llmService.js";

export class CommandHandler {
  private instanceId: string;

  constructor(
    private orch: Orchestrator,
    instanceId: string,
    private llmService?: LLMService
  ) {
    this.instanceId = instanceId;
  }

  async status(): Promise<string> {
    const s = this.orch.getState();
    const fmt = (ts?: number) => (ts ? new Date(ts).toISOString() : "n/a");
    const uptime = Math.floor((Date.now() - s.startedAt) / 1000);
    const exec = s.minimalExecution;

    return [
      "=== Bot Status ===",
      "",
      `Uptime: ${uptime}s`,
      `Mode: ${s.mode}`,
      "",
      "DATA:",
      `Last 5m close: ${fmt(s.last5mCloseTs)}`,
      `Last Tick: ${fmt(s.lastTickTs)}`,
      `Session: ${s.session}`,
      `Price: ${s.price ?? "n/a"}`,
      "",
      "BIAS:",
      `Bias: ${exec.bias}`,
      `Confidence: ${exec.biasConfidence ?? exec.thesisConfidence ?? 0}%`,
      `Phase: ${exec.phase}`,
      `Entry Status: ${exec.phase === "IN_TRADE" ? "active" : "inactive"}`,
      `Wait: ${exec.waitReason ?? "n/a"}`,
    ].join("\n");
  }

  async version(buildId: string): Promise<string> {
    const s = this.orch.getState();
    const gitSha =
      process.env.RAILWAY_GIT_COMMIT_SHA ||
      process.env.RAILWAY_GIT_COMMIT_REF ||
      process.env.GIT_COMMIT_SHA ||
      "unknown";
    return [
      "=== Version Info ===",
      `BUILD_ID: ${buildId}`,
      `Git SHA: ${gitSha}`,
      `Mode: ${s.mode}`,
      `Instance: ${this.instanceId}`,
    ].join("\n");
  }

  async llmtest(): Promise<string> {
    if (!this.llmService) {
      return "❌ LLM service not initialized";
    }
    const result = await this.llmService.testConnection();
    if (result.success) {
      return `✅ LLM test successful\nLatency: ${result.latency}ms`;
    }
    return `❌ LLM test failed\nLatency: ${result.latency}ms\nError: ${result.error || "Unknown error"}`;
  }

  async envdebug(): Promise<string> {
    const envVars = [
      "OPENAI_API_KEY",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_CHAT_ID",
      "ALPACA_API_KEY",
      "ALPACA_API_SECRET",
      "ALPACA_BASE_URL",
      "ALPACA_FEED",
      "SYMBOLS",
      "NODE_ENV",
      "INSTANCE_ID"
    ];

    const results = envVars.map((varName) => {
      const value = process.env[varName];
      if (!value) {
        return `${varName}: ❌ NOT SET`;
      }
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
    ].join("\n");
  }
}
