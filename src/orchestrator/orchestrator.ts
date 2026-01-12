import type { BotState, DomainEvent, Play } from "../types.js";

export class Orchestrator {
  private state: BotState;
  private instanceId: string;

  constructor(instanceId: string) {
    this.instanceId = instanceId;
    this.state = {
      startedAt: Date.now(),
      session: "RTH",
      activePlay: null
    };
  }

  getState(): BotState {
    return this.state;
  }

  // call this per 1m bar
  processTick(input: { ts: number; symbol: string; close: number }): DomainEvent[] {
    const events: DomainEvent[] = [];
    this.state.lastTickAt = input.ts;
    this.state.price = input.close;

    // if no active play, create one deterministically
    if (!this.state.activePlay) {
      const play: Play = {
        id: `play_${input.ts}`,
        symbol: input.symbol,
        direction: "LONG",
        score: 53,
        grade: "C",
        mode: "SCOUT",
        confidence: 53,
        entryZone: { low: input.close - 0.28, high: input.close + 0.20 },
        stop: input.close - 0.72,
        targets: { t1: input.close + 0.92, t2: input.close + 1.88, t3: input.close + 2.85 }
      };
      this.state.activePlay = play;

      events.push(this.ev("PLAY_ARMED", input.ts, {
        play,
        headline: `${play.mode} PLAY ARMED`,
      }));

      events.push(this.ev("TIMING_COACH", input.ts, {
        playId: play.id,
        symbol: play.symbol,
        direction: play.direction,
        mode: play.mode,
        confidence: play.confidence,
        text: `Entry zone active. Ready to enter now.`,
        waitBars: 0
      }));
    }

    const play = this.state.activePlay!;
    const close = input.close;

    // close-based stop logic
    const buffer = 0.10;
    if (!play.stopHit) {
      const threatened =
        play.direction === "LONG"
          ? close <= play.stop + buffer
          : close >= play.stop - buffer;

      const hit =
        play.direction === "LONG"
          ? close <= play.stop
          : close >= play.stop;

      if (threatened && !play.stopThreatened) {
        play.stopThreatened = true;
        events.push(this.ev("STOP_THREATENED", input.ts, {
          playId: play.id,
          symbol: play.symbol,
          direction: play.direction,
          close,
          stop: play.stop,
          buffer,
          rule: "1m_close_near_stop"
        }));
      }

      if (hit && !play.stopHit) {
        play.stopHit = true;
        events.push(this.ev("STOP_HIT", input.ts, {
          playId: play.id,
          symbol: play.symbol,
          direction: play.direction,
          close,
          stop: play.stop,
          rule: "1m_close_through_stop"
        }));
        // clear play after stop hit
        this.state.activePlay = null;
        return events;
      }
    }

    // entry eligible: first touch inside zone
    const inZone = close >= play.entryZone.low && close <= play.entryZone.high;
    if (inZone && !play.inEntryZone) {
      play.inEntryZone = true;
      events.push(this.ev("ENTRY_ELIGIBLE", input.ts, {
        playId: play.id,
        symbol: play.symbol,
        direction: play.direction,
        close,
        entryZone: play.entryZone
      }));
    }
    if (!inZone) play.inEntryZone = false;

    return events;
  }

  heartbeat(ts: number): DomainEvent {
    return this.ev("HEARTBEAT", ts, {
      session: this.state.session,
      price: this.state.price ?? null,
      activePlay: this.state.activePlay ? this.state.activePlay.id : null,
      startedAt: this.state.startedAt,
      instanceId: this.instanceId
    });
  }

  private ev(type: DomainEvent["type"], timestamp: number, data: Record<string, any>): DomainEvent {
    return { type, timestamp, instanceId: this.instanceId, data };
  }
}
