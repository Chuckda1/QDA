import type { BotMode } from "../types.js";
import { getCurrentET } from "../utils/timeUtils.js";
import type { MessageGovernor } from "../governor/messageGovernor.js";

export class Scheduler {
  private checkInterval: NodeJS.Timeout | null = null;
  private lastTickTime: number = 0;

  constructor(
    private governor: MessageGovernor,
    private instanceId: string,
    private onModeChange?: (mode: BotMode) => void
  ) {}

  start(): void {
    this.checkInterval = setInterval(() => {
      this.tick();
    }, 30000);
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
    const now = Date.now();

    const isActiveHours = (hour === 9 && minute >= 30) || (hour >= 10 && hour < 16);
    const isQuietHours = hour >= 16 || hour < 9 || (hour === 9 && minute < 30);

    // Apply mode first so the status log shows the correct mode (avoids "Mode: QUIET" at 10:14 when we're about to go ACTIVE)
    if (isActiveHours) {
      if (this.governor.getMode() !== "ACTIVE") {
        console.log(
          `[${this.instanceId}] Switching to ACTIVE mode (ET: ${hour}:${minute.toString().padStart(2, "0")})`
        );
        this.governor.setMode("ACTIVE");
        this.onModeChange?.("ACTIVE");
      }
    } else if (isQuietHours) {
      if (this.governor.getMode() !== "QUIET") {
        console.log(
          `[${this.instanceId}] Switching to QUIET mode (ET: ${hour}:${minute.toString().padStart(2, "0")})`
        );
        this.governor.setMode("QUIET");
        this.onModeChange?.("QUIET");
      }
    }

    if (!this.lastTickTime || now - this.lastTickTime >= 60000) {
      console.log(
        `[Scheduler] Current ET: ${hour}:${minute.toString().padStart(2, "0")} | Mode: ${this.governor.getMode()}`
      );
      this.lastTickTime = now;
    }
  }
}
