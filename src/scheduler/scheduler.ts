import type { BotMode } from "../types.js";
import { getCurrentET } from "../utils/timeUtils.js";
import type { MessageGovernor } from "../governor/messageGovernor.js";
import type { MessagePublisher } from "../telegram/messagePublisher.js";

export class Scheduler {
  private checkInterval: NodeJS.Timeout | null = null;
  private planSentToday: boolean = false;

  constructor(
    private governor: MessageGovernor,
    private publisher: MessagePublisher,
    private instanceId: string,
    private onModeChange?: (mode: BotMode) => void
  ) {}

  start(): void {
    // Check every 30 seconds for mode changes and plan time
    this.checkInterval = setInterval(() => {
      this.tick();
    }, 30000);
    
    // Initial tick
    this.tick();
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  private tick(): void {
    const { hour, minute } = getCurrentET();
    const currentMinutes = hour * 60 + minute;
    
    // Reset plan flag at midnight ET
    if (hour === 0 && minute < 5) {
      this.planSentToday = false;
      this.governor.resetPlanFlag();
    }

    // 09:25 ET: Send Plan of Day (once per day)
    if (hour === 9 && minute >= 25 && minute < 30 && !this.planSentToday) {
      this.sendPlanOfDay().catch(err => console.error("Failed to send Plan of Day:", err));
      this.planSentToday = true;
    }

    // 09:30 ET: Switch to ACTIVE
    if (hour === 9 && minute >= 30) {
      if (this.governor.getMode() !== "ACTIVE") {
        this.governor.setMode("ACTIVE");
        this.onModeChange?.("ACTIVE");
      }
    }

    // 16:00 ET: Switch to QUIET
    if (hour >= 16) {
      if (this.governor.getMode() !== "QUIET") {
        this.governor.setMode("QUIET");
        this.onModeChange?.("QUIET");
      }
    }

    // Before 09:30: QUIET
    if (hour < 9 || (hour === 9 && minute < 30)) {
      if (this.governor.getMode() !== "QUIET") {
        this.governor.setMode("QUIET");
        this.onModeChange?.("QUIET");
      }
    }
  }

  private async sendPlanOfDay(): Promise<void> {
    const event = {
      type: "PLAN_OF_DAY" as const,
      timestamp: Date.now(),
      instanceId: this.instanceId,
      data: {
        plan: "Market analysis and trade setup monitoring. Ready for active trading session."
      }
    };
    await this.publisher.publish(event);
  }
}
