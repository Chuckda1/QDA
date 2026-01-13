import type { BotMode } from "../types.js";
import { getCurrentET } from "../utils/timeUtils.js";
import type { MessageGovernor } from "../governor/messageGovernor.js";
import type { MessagePublisher } from "../telegram/messagePublisher.js";

export class Scheduler {
  private checkInterval: NodeJS.Timeout | null = null;
  private lastTickTime: number = 0;

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
    
    // Debug: Log current ET time (only once per minute to avoid spam)
    const now = Date.now();
    if (!this.lastTickTime || now - this.lastTickTime >= 60000) {
      console.log(`[Scheduler] Current ET time: ${hour}:${minute.toString().padStart(2, '0')} (UTC: ${new Date().toISOString()})`);
      this.lastTickTime = now;
    }
    
    // 09:25 ET: Send Plan of Day (once per day)
    if (hour === 9 && minute >= 25 && minute < 30 && !this.governor.hasSentPlanToday()) {
      this.sendPlanOfDay().catch(err => console.error("Failed to send Plan of Day:", err));
    }

    // Determine mode based on time
    // ACTIVE: 09:30 ET - 15:59 ET (market hours)
    // QUIET: 16:00 ET - 09:29 ET (outside market hours)
    const isActiveHours = (hour === 9 && minute >= 30) || (hour >= 10 && hour < 16);
    const isQuietHours = hour >= 16 || hour < 9 || (hour === 9 && minute < 30);

    if (isActiveHours) {
      if (this.governor.getMode() !== "ACTIVE") {
        console.log(`[Scheduler] Switching to ACTIVE mode (ET: ${hour}:${minute.toString().padStart(2, '0')})`);
        this.governor.setMode("ACTIVE");
        this.onModeChange?.("ACTIVE");
      }
    } else if (isQuietHours) {
      if (this.governor.getMode() !== "QUIET") {
        console.log(`[Scheduler] Switching to QUIET mode (ET: ${hour}:${minute.toString().padStart(2, '0')})`);
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
    // STAGE 4: All messages must go through publishOrdered for serialization
    await this.publisher.publishOrdered([event]);
  }
}
