import type { BotMode, Direction, Regime, SetupCandidate } from "../types.js";
import { getCurrentET } from "../utils/timeUtils.js";
import type { MessageGovernor } from "../governor/messageGovernor.js";
import type { MessagePublisher } from "../telegram/messagePublisher.js";

type PlanDiagnosticsSnapshot = {
  ts: number;
  symbol: string;
  close: number;
  regime: {
    regime: Regime;
    reasons: string[];
    vwapSlope?: "UP" | "DOWN" | "FLAT";
    structure?: "BULLISH" | "BEARISH" | "MIXED";
  };
  directionInference: {
    direction: Direction | undefined;
    confidence: number;
    reasons: string[];
  };
  candidate?: SetupCandidate;
  setupReason?: string;
  entryFilterWarnings?: string[];
};

// STAGE 6: Helper to check if DST is in effect (simplified, matches timeUtils logic)
function isDSTInEffect(date: Date): boolean {
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  
  // DST: 2nd Sunday in March to 1st Sunday in November
  if (month < 2 || month > 10) return false; // Jan, Feb, Dec = EST
  if (month > 2 && month < 10) return true; // Apr-Oct = EDT
  
  if (month === 2) { // March
    const secondSunday = getNthSunday(year, 2, 2);
    return day >= secondSunday;
  }
  
  if (month === 10) { // November
    const firstSunday = getNthSunday(year, 10, 1);
    return day < firstSunday;
  }
  
  return false;
}

function getNthSunday(year: number, month: number, n: number): number {
  let count = 0;
  for (let day = 1; day <= 31; day++) {
    const date = new Date(year, month, day);
    if (date.getDay() === 0) {
      count++;
      if (count === n) return day;
    }
  }
  return 31;
}

export class Scheduler {
  private checkInterval: NodeJS.Timeout | null = null;
  private planSentToday: boolean = false;
  private lastTickTime: number = 0;
  private lastPlanOfDayDate: string = ""; // STAGE 6: Track date to prevent duplicates

  constructor(
    private governor: MessageGovernor,
    private publisher: MessagePublisher,
    private instanceId: string,
    private onModeChange?: (mode: BotMode) => void,
    private getLatestDiagnostics?: () => PlanDiagnosticsSnapshot | null
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
    
    // STAGE 6: Get ET date string (YYYY-MM-DD) for plan deduplication
    // Calculate ET date by getting current UTC and adjusting for ET offset
    const nowDate = new Date();
    const isDST = isDSTInEffect(nowDate);
    const etOffsetHours = isDST ? 4 : 5;
    const etTime = new Date(nowDate.getTime() - etOffsetHours * 60 * 60 * 1000);
    const todayET = etTime.toISOString().split('T')[0]; // YYYY-MM-DD format
    
    // STAGE 6: Log current ET time and next transitions (only once per minute to avoid spam)
    const now = Date.now();
    if (!this.lastTickTime || now - this.lastTickTime >= 60000) {
      const nextTransition = this.getNextTransition(hour, minute);
      console.log(`[Scheduler] Current ET: ${hour}:${minute.toString().padStart(2, '0')} | Mode: ${this.governor.getMode()} | Next: ${nextTransition} | lastPlanOfDayDate: ${this.lastPlanOfDayDate || "never"}`);
      this.lastTickTime = now;
    }
    
    // STAGE 6: Reset plan flag at midnight ET (date-based, not just time-based)
    if (this.lastPlanOfDayDate !== todayET) {
      if (this.planSentToday) {
        console.log(`[Scheduler] New ET day detected (${todayET}), resetting plan flag`);
      }
      this.planSentToday = false;
      this.lastPlanOfDayDate = todayET;
      this.governor.resetPlanFlag();
    }

    // STAGE 6: 09:25 ET: Send Plan of Day (once per day, date-checked)
    if (hour === 9 && minute >= 25 && minute < 30 && !this.planSentToday) {
      console.log(`[Scheduler] Sending Plan of Day (ET: ${hour}:${minute.toString().padStart(2, '0')}, date: ${todayET})`);
      this.sendPlanOfDay().catch(err => console.error("Failed to send Plan of Day:", err));
      this.planSentToday = true;
    }

    // STAGE 6: Determine mode based on time (explicit ranges)
    // ACTIVE: 09:30:00 ET - 15:59:59 ET → process bars + trading messages
    // QUIET: 16:00:00 ET - 09:24:59 ET → do NOT process trading decisions, but DO log heartbeats and accept /status
    const isActiveHours = (hour === 9 && minute >= 30) || (hour >= 10 && hour < 16);
    const isQuietHours = hour >= 16 || hour < 9 || (hour === 9 && minute < 30);

    if (isActiveHours) {
      if (this.governor.getMode() !== "ACTIVE") {
        console.log(`[Scheduler] Switching to ACTIVE mode (ET: ${hour}:${minute.toString().padStart(2, '0')}) - will process bars + trading messages`);
        this.governor.setMode("ACTIVE");
        this.onModeChange?.("ACTIVE");
      }
    } else if (isQuietHours) {
      if (this.governor.getMode() !== "QUIET") {
        console.log(`[Scheduler] Switching to QUIET mode (ET: ${hour}:${minute.toString().padStart(2, '0')}) - bars skipped, heartbeats continue, /status works`);
        this.governor.setMode("QUIET");
        this.onModeChange?.("QUIET");
      }
    }
  }

  /**
   * STAGE 6: Calculate next scheduled transition
   */
  private getNextTransition(currentHour: number, currentMinute: number): string {
    const currentMinutes = currentHour * 60 + currentMinute;
    
    // If before 09:25, next is Plan of Day at 09:25
    if (currentMinutes < 9 * 60 + 25) {
      return "Plan of Day at 09:25 ET";
    }
    
    // If between 09:25 and 09:30, next is ACTIVE at 09:30
    if (currentMinutes < 9 * 60 + 30) {
      return "ACTIVE at 09:30 ET";
    }
    
    // If in ACTIVE hours, next is QUIET at 16:00
    if (currentMinutes < 16 * 60) {
      return "QUIET at 16:00 ET";
    }
    
    // If in QUIET hours (after 16:00), next is Plan of Day tomorrow at 09:25
    return "Plan of Day tomorrow at 09:25 ET";
  }

  private async sendPlanOfDay(): Promise<void> {
    const d = this.getLatestDiagnostics?.() ?? null;
    const now = Date.now();

    const fmtAge = (ts?: number) => {
      if (!ts) return "n/a";
      const ms = Math.max(0, now - ts);
      const min = Math.floor(ms / 60000);
      if (min < 1) return "<1m";
      if (min < 60) return `${min}m`;
      const hr = Math.floor(min / 60);
      const rem = min % 60;
      return `${hr}h${rem.toString().padStart(2, "0")}m`;
    };

    const fmtNum = (x: any) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(2) : "n/a");

    const planLines: string[] = [];
    planLines.push("MARKET MONITOR (pre-09:30):");

    if (!d) {
      planLines.push("- No monitoring snapshot yet (need live bars to populate).");
      planLines.push("- Plan: wait for first bars; confirm feed + regime at/after open.");
    } else {
      planLines.push(`- Symbol: ${d.symbol}  Last: $${fmtNum(d.close)}  Age: ${fmtAge(d.ts)}`);
      planLines.push(`- Regime: ${d.regime.regime} (VWAP slope=${d.regime.vwapSlope ?? "n/a"} structure=${d.regime.structure ?? "n/a"})`);
      planLines.push(`- Direction: ${d.directionInference.direction ?? "N/A"} (${Math.round(d.directionInference.confidence ?? 0)}%)`);

      if (d.candidate) {
        const c = d.candidate;
        planLines.push(`- Top setup: ${c.direction} ${c.pattern} score=${c.score.total}`);
        planLines.push(`  Entry: $${fmtNum(c.entryZone.low)}-$${fmtNum(c.entryZone.high)}  Stop: $${fmtNum(c.stop)}`);
      } else {
        planLines.push(`- Top setup: none (${d.setupReason ?? "n/a"})`);
      }

      if (d.entryFilterWarnings?.length) {
        planLines.push(`- Warnings: ${d.entryFilterWarnings.join(" | ")}`);
      }

      planLines.push("");
      planLines.push("PLAN:");
      planLines.push("- At 09:30, trade ONLY when setup + filters + LLM agree.");
      planLines.push("- If regime flips early, follow regime (don't force longs in BEAR / shorts in BULL).");
      planLines.push("- Use /diag at open if no plays are arming to see the exact blocker.");
    }

    const event = {
      type: "PLAN_OF_DAY" as const,
      timestamp: Date.now(),
      instanceId: this.instanceId,
      data: {
        plan: planLines.join("\n")
      }
    };
    // STAGE 4: All messages must go through publishOrdered for serialization
    await this.publisher.publishOrdered([event]);
  }
}
