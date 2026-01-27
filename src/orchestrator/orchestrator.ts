import { randomUUID } from "crypto";
import { getMarketRegime, getMarketSessionLabel } from "../utils/timeUtils.js";
import { extractSwings, lastSwings } from "../utils/swing.js";
import type {
  BotMode,
  BotState,
  DomainEvent,
  Forming5mBar,
  MinimalExecutionPhase,
  MinimalExecutionState,
  MinimalLLMSnapshot,
  MinimalSetupCandidate,
  RawBar,
} from "../types.js";
import type { LLMService } from "../llm/llmService.js";

type TickInput = {
  ts: number;
  symbol: string;
  close: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
};

type TickSnapshot = TickInput & { timeframe: "5m" | "1m" };

export class Orchestrator {
  private instanceId: string;
  private orchId: string;
  private llmService?: LLMService;
  private state: BotState;
  private recentBars5m: Array<{
    ts: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }> = [];
  private forming5mBar: Forming5mBar | null = null;
  private formingBucketStart: number | null = null;
  private readonly minimalLlmBars: number;

  constructor(instanceId: string, llmService?: LLMService) {
    this.instanceId = instanceId;
    this.orchId = randomUUID();
    this.llmService = llmService;
    this.minimalLlmBars = parseInt(process.env.MINIMAL_LLM_BARS || "5", 10);
    this.state = {
      startedAt: Date.now(),
      session: getMarketSessionLabel(),
      mode: "QUIET",
      minimalExecution: {
        phase: "WAITING_FOR_THESIS",
        waitReason: "waiting_for_thesis",
      },
    };
    console.log(
      `[MINIMAL] orchestrator_init id=${this.orchId} instance=${this.instanceId} minimalLlmBars=${this.minimalLlmBars}`
    );
  }

  setMode(mode: BotMode): void {
    this.state.mode = mode;
  }

  getState(): BotState {
    return this.state;
  }

  async processTick(input: TickInput, timeframe: "5m" | "1m" = "5m"): Promise<DomainEvent[]> {
    const snapshot: TickSnapshot = { ...input, timeframe };
    this.state.session = getMarketSessionLabel(new Date(input.ts));
    this.state.lastTickTs = input.ts;
    this.state.price = input.close;

    if (timeframe !== "5m") {
      return [];
    }

    return this.handleMinimal5m(snapshot);
  }

  private updateForming5mBar(snapshot: TickSnapshot): Forming5mBar | null {
    const bucketMs = 5 * 60 * 1000;
    const startTs = Math.floor(snapshot.ts / bucketMs) * bucketMs;
    const endTs = startTs + bucketMs;
    const progressMinutes = Math.min(5, Math.max(1, Math.floor((snapshot.ts - startTs) / 60000) + 1));
    const closeVal = snapshot.close;
    if (!Number.isFinite(closeVal)) return null;

    // Debug: log bucket math and timestamp progression
    const prevTs = this.forming5mBar?.endTs ?? null;
    console.log(
      `[BUCKET_DEBUG] ts=${snapshot.ts} startTs=${startTs} endTs=${endTs} formingBucketStart=${this.formingBucketStart ?? "null"} prevTs=${prevTs ?? "null"} tsDelta=${prevTs !== null ? snapshot.ts - prevTs : "n/a"}`
    );

    // Handle bucket rollover: push closed bar and start new bucket
    if (this.formingBucketStart !== null && startTs !== this.formingBucketStart) {
      if (this.forming5mBar) {
        const closedBar = {
          ts: this.forming5mBar.endTs,
          open: this.forming5mBar.open,
          high: this.forming5mBar.high,
          low: this.forming5mBar.low,
          close: this.forming5mBar.close,
          volume: this.forming5mBar.volume,
        };
        this.recentBars5m.push(closedBar);
        if (this.recentBars5m.length > 120) this.recentBars5m.shift();
        const lastTs = this.recentBars5m[this.recentBars5m.length - 1]?.ts;
        // Update last5mCloseTs only when a bar actually closes
        this.state.last5mCloseTs = closedBar.ts;
        console.log(
          `[MINIMAL][ROLLOVER] oldStart=${this.formingBucketStart} newStart=${startTs} closedBar o=${closedBar.open} h=${closedBar.high} l=${closedBar.low} c=${closedBar.close} v=${closedBar.volume}`
        );
        console.log(
          `[MINIMAL][5M_CLOSE] start=${this.forming5mBar.startTs} end=${this.forming5mBar.endTs} o=${closedBar.open} h=${closedBar.high} l=${closedBar.low} c=${closedBar.close} v=${closedBar.volume}`
        );
        console.log(
          `[MINIMAL][5M_PUSH] len=${this.recentBars5m.length} lastTs=${lastTs ?? "n/a"}`
        );
      }
      // Start new bucket with first tick's open
      this.formingBucketStart = startTs;
      this.forming5mBar = {
        startTs,
        endTs,
        progressMinutes,
        open: snapshot.open ?? closeVal,
        high: snapshot.high ?? closeVal,
        low: snapshot.low ?? closeVal,
        close: closeVal,
        volume: snapshot.volume ?? 0,
      };
      return this.forming5mBar;
    }

    // Same bucket: accumulate high/low/close/volume, keep first open
    if (this.forming5mBar && this.formingBucketStart === startTs) {
      this.forming5mBar.high = Math.max(this.forming5mBar.high, snapshot.high ?? closeVal);
      this.forming5mBar.low = Math.min(this.forming5mBar.low, snapshot.low ?? closeVal);
      this.forming5mBar.close = closeVal;
      this.forming5mBar.volume += snapshot.volume ?? 0;
      this.forming5mBar.progressMinutes = progressMinutes;
      return this.forming5mBar;
    }

    // First bucket initialization
    this.formingBucketStart = startTs;
    this.forming5mBar = {
      startTs,
      endTs,
      progressMinutes,
      open: snapshot.open ?? closeVal,
      high: snapshot.high ?? closeVal,
      low: snapshot.low ?? closeVal,
      close: closeVal,
      volume: snapshot.volume ?? 0,
    };
    return this.forming5mBar;
  }

  private buildMinimalSetupCandidates(params: {
    closed5mBars: RawBar[];
    activeDirection?: "long" | "short" | "none";
  }): MinimalSetupCandidate[] {
    const { closed5mBars, activeDirection } = params;
    const lastClosed = closed5mBars[closed5mBars.length - 1];
    if (!lastClosed) return [];
    const swings = extractSwings(closed5mBars, 2, false);
    const { lastHigh, lastLow } = lastSwings(swings);
    const lastSwingHigh = lastHigh?.price;
    const lastSwingLow = lastLow?.price;

    if (!Number.isFinite(lastSwingLow) || !Number.isFinite(lastSwingHigh)) return [];

    const priceRef = lastClosed.close;
    const buffer = Math.max(0.2, priceRef * 0.0003);
    const longInvalidation = (lastSwingLow as number) - buffer;
    const shortInvalidation = (lastSwingHigh as number) + buffer;

    if (activeDirection === "long") {
      const longDist = Math.abs(priceRef - longInvalidation);
      const longPct = priceRef ? (longDist / priceRef) * 100 : 0;
      console.log(
        `[INV_DEBUG] dir=LONG inv=${longInvalidation.toFixed(2)} ref=thesisSwingLow price=${priceRef.toFixed(2)} dist=${longDist.toFixed(2)} (${longPct.toFixed(3)}%) buffer=${buffer.toFixed(2)} atr5m=n/a dist/atr=n/a`
      );
    }
    if (activeDirection === "short") {
      const shortDist = Math.abs(priceRef - shortInvalidation);
      const shortPct = priceRef ? (shortDist / priceRef) * 100 : 0;
      console.log(
        `[INV_DEBUG] dir=SHORT inv=${shortInvalidation.toFixed(2)} ref=thesisSwingHigh price=${priceRef.toFixed(2)} dist=${shortDist.toFixed(2)} (${shortPct.toFixed(3)}%) buffer=${buffer.toFixed(2)} atr5m=n/a dist/atr=n/a`
      );
    }

    const baseId = lastClosed.ts;
    return [
      {
        id: `MIN_LONG_${baseId}`,
        direction: "LONG",
        entryTrigger: "Enter on break above pullback high after a pullback down.",
        invalidationLevel: longInvalidation,
        pullbackRule: "Pullback = last closed 5m bar closes down or makes a lower low.",
        referenceLevels: {
          lastSwingHigh,
          lastSwingLow,
        },
        rationale: "Recent pullback provides a defined trigger and invalidation.",
      },
      {
        id: `MIN_SHORT_${baseId}`,
        direction: "SHORT",
        entryTrigger: "Enter on break below pullback low after a pullback up.",
        invalidationLevel: shortInvalidation,
        pullbackRule: "Pullback = last closed 5m bar closes up or makes a higher high.",
        referenceLevels: {
          lastSwingHigh,
          lastSwingLow,
        },
        rationale: "Recent pullback provides a defined trigger and invalidation.",
      },
    ];
  }

  private clearTradeState(exec: MinimalExecutionState): void {
    exec.pullbackHigh = undefined;
    exec.pullbackLow = undefined;
    exec.pullbackTs = undefined;
    exec.entryPrice = undefined;
    exec.entryTs = undefined;
    exec.stopPrice = undefined;
    exec.targets = undefined;
  }

  private computeTargets(direction: "long" | "short", entry: number, stop: number): number[] {
    const risk = Math.abs(entry - stop);
    if (!Number.isFinite(risk) || risk <= 0) return [];
    return direction === "long"
      ? [entry + risk, entry + risk * 2]
      : [entry - risk, entry - risk * 2];
  }

  private async handleMinimal5m(snapshot: TickSnapshot): Promise<DomainEvent[]> {
    const { ts, symbol, close } = snapshot;
    const events: DomainEvent[] = [];
    const regime = getMarketRegime(new Date(ts));
    if (!regime.isRTH) {
      this.state.minimalExecution.phase = "WAITING_FOR_THESIS";
      this.state.minimalExecution.waitReason = "market_closed";
      return events;
    }

    const forming5mBar = this.updateForming5mBar(snapshot);
    const closed5mBars = this.recentBars5m;
    const lastClosed5m = closed5mBars[closed5mBars.length - 1] ?? null;
    const exec = this.state.minimalExecution;

    const formingAsClosed = forming5mBar
      ? {
          ts: forming5mBar.endTs,
          open: forming5mBar.open,
          high: forming5mBar.high,
          low: forming5mBar.low,
          close: forming5mBar.close,
          volume: forming5mBar.volume,
        }
      : null;
    const barsForCandidates = closed5mBars.length
      ? closed5mBars
      : formingAsClosed
      ? [formingAsClosed]
      : [];
    const warmupNote =
      closed5mBars.length < this.minimalLlmBars
        ? `warmup_${closed5mBars.length}/${this.minimalLlmBars}`
        : undefined;
    if (warmupNote) {
      console.log(
        `[MINIMAL][THESIS_GATE] len=${closed5mBars.length} required=${this.minimalLlmBars} last5mCloseTs=${this.state.last5mCloseTs ?? "n/a"} forming=${forming5mBar ? "yes" : "no"}`
      );
    }
    if (this.llmService) {
      const candidates = this.buildMinimalSetupCandidates({
        closed5mBars: barsForCandidates,
        activeDirection: exec.thesisDirection,
      });
      if (candidates.length < 2) {
        if (warmupNote && exec.phase === "WAITING_FOR_THESIS") {
          exec.waitReason = warmupNote;
        }
      } else {
        const llmSnapshot: MinimalLLMSnapshot = {
          symbol,
          nowTs: ts,
          closed5mBars: barsForCandidates,
          forming5mBar,
        };
        const result = await this.llmService.getMinimalSetupSelection({
          snapshot: llmSnapshot,
          candidates,
        });
        const selection = result.selection;
        this.state.lastLLMCallAt = ts;
        this.state.lastLLMDecision = selection.reason ?? selection.selected;

        exec.thesisPrice = lastClosed5m?.close ?? close;
        exec.thesisTs = ts;
        if (selection.selected === "PASS") {
          exec.thesisDirection = "none";
          exec.thesisConfidence = selection.confidence;
          exec.activeCandidate = undefined;
          exec.phase = "WAITING_FOR_THESIS";
          exec.waitReason = "llm_pass";
          this.clearTradeState(exec);
        } else {
          exec.thesisDirection = selection.selected === "LONG" ? "long" : "short";
          exec.thesisConfidence = selection.confidence;
          exec.activeCandidate = candidates.find((c) => c.direction === selection.selected);
          exec.phase = "WAITING_FOR_PULLBACK";
          exec.waitReason = "waiting_for_pullback";
          this.clearTradeState(exec);
        }
      }
    } else {
      exec.waitReason = "llm_unavailable";
    }

    const canEnter = closed5mBars.length >= 2 || (closed5mBars.length >= 1 && !!forming5mBar);
    exec.canEnter = canEnter;
    if (!canEnter && exec.phase !== "IN_TRADE") {
      exec.waitReason = warmupNote ?? "entry_warmup";
    }

    const current5m = forming5mBar ?? lastClosed5m ?? null;
    const previous5m = closed5mBars.length >= 2 ? closed5mBars[closed5mBars.length - 2] : null;

    if (canEnter && current5m && exec.thesisDirection && exec.thesisDirection !== "none") {
      if (exec.phase === "WAITING_FOR_PULLBACK" && previous5m) {
        const open = current5m.open ?? current5m.close;
        const isBearish = current5m.close < open;
        const isBullish = current5m.close > open;
        const lowerLow = current5m.low < previous5m.low;
        const higherHigh = current5m.high > previous5m.high;

        if (exec.thesisDirection === "long" && (isBearish || lowerLow)) {
          exec.pullbackHigh = current5m.high;
          exec.pullbackLow = current5m.low;
          exec.pullbackTs = ts;
          exec.phase = "WAITING_FOR_ENTRY";
          exec.waitReason = "waiting_for_break_above_pullback_high";
        }

        if (exec.thesisDirection === "short" && (isBullish || higherHigh)) {
          exec.pullbackHigh = current5m.high;
          exec.pullbackLow = current5m.low;
          exec.pullbackTs = ts;
          exec.phase = "WAITING_FOR_ENTRY";
          exec.waitReason = "waiting_for_break_below_pullback_low";
        }
      } else if (exec.phase === "WAITING_FOR_ENTRY") {
        if (exec.thesisDirection === "long" && exec.pullbackHigh !== undefined && exec.pullbackLow !== undefined) {
          if (current5m.close > exec.pullbackHigh) {
            exec.entryPrice = current5m.close;
            exec.entryTs = ts;
            exec.stopPrice = exec.pullbackLow;
            exec.targets = this.computeTargets(exec.thesisDirection, exec.entryPrice, exec.stopPrice);
            exec.phase = "IN_TRADE";
            exec.waitReason = "in_trade";
          }
        } else if (
          exec.thesisDirection === "short" &&
          exec.pullbackHigh !== undefined &&
          exec.pullbackLow !== undefined
        ) {
          if (current5m.close < exec.pullbackLow) {
            exec.entryPrice = current5m.close;
            exec.entryTs = ts;
            exec.stopPrice = exec.pullbackHigh;
            exec.targets = this.computeTargets(exec.thesisDirection, exec.entryPrice, exec.stopPrice);
            exec.phase = "IN_TRADE";
            exec.waitReason = "in_trade";
          }
        } else {
          exec.phase = "WAITING_FOR_PULLBACK";
          exec.waitReason = "waiting_for_pullback";
        }
      } else if (exec.phase === "IN_TRADE") {
        if (exec.stopPrice === undefined || !exec.targets || exec.targets.length === 0) {
          exec.phase = "WAITING_FOR_THESIS";
          exec.waitReason = "invalid_trade_state";
          this.clearTradeState(exec);
        } else if (exec.thesisDirection === "long") {
          if (current5m.low <= exec.stopPrice) {
            exec.phase = "WAITING_FOR_THESIS";
            exec.waitReason = "stopped_out";
            this.clearTradeState(exec);
          } else if (current5m.high >= exec.targets[0]!) {
            exec.phase = "WAITING_FOR_THESIS";
            exec.waitReason = "target_hit";
            this.clearTradeState(exec);
          }
        } else if (exec.thesisDirection === "short") {
          if (current5m.high >= exec.stopPrice) {
            exec.phase = "WAITING_FOR_THESIS";
            exec.waitReason = "stopped_out";
            this.clearTradeState(exec);
          } else if (current5m.low <= exec.targets[0]!) {
            exec.phase = "WAITING_FOR_THESIS";
            exec.waitReason = "target_hit";
            this.clearTradeState(exec);
          }
        }
      }
    }

    const mindState = {
      mindId: randomUUID(),
      direction: exec.thesisDirection ?? "none",
      confidence: exec.thesisConfidence ?? 0,
      reason: exec.waitReason ?? "waiting",
    };

    return [
      ...events,
      {
        type: "MIND_STATE_UPDATED",
        timestamp: ts,
        instanceId: this.instanceId,
        data: {
          timestamp: ts,
          symbol,
          price: close,
          mindState,
          thesis: {
            direction: exec.thesisDirection ?? null,
            confidence: exec.thesisConfidence ?? null,
            price: exec.thesisPrice ?? null,
            ts: exec.thesisTs ?? null,
          },
          candidate: exec.activeCandidate ?? null,
          botState: exec.phase,
          waitFor: exec.waitReason ?? null,
        },
      },
    ];
  }
}
