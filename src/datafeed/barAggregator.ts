// src/datafeed/barAggregator.ts
export type Bar = {
  ts: number;        // ms epoch at bar close
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export class BarAggregator {
  private bucketMinutes: number;
  private bucketStartTs: number | null = null;
  private cur: Bar | null = null;

  constructor(bucketMinutes: number = 5) {
    this.bucketMinutes = bucketMinutes;
  }

  private floorToBucket(ts: number): number {
    const ms = this.bucketMinutes * 60 * 1000;
    return Math.floor(ts / ms) * ms;
  }

  /** 
   * Push a CLOSED 1m bar; returns a CLOSED N-minute bar when bucket completes.
   * 
   * Bar timestamp represents the close time: bucketStart + N minutes - 1ms
   * This ensures stable, consistent timestamps for cache keys across WS/REST.
   */
  push1m(bar: Bar): Bar | null {
    const start = this.floorToBucket(bar.ts);
    // Bar close time: start of bucket + N minutes - 1ms
    const barCloseTs = start + this.bucketMinutes * 60 * 1000 - 1;

    if (this.bucketStartTs === null) {
      this.bucketStartTs = start;
      this.cur = { ...bar, ts: barCloseTs };
      return null;
    }

    if (start !== this.bucketStartTs) {
      const finished = this.cur!;
      // Update finished bar's timestamp to represent its close time
      finished.ts = this.bucketStartTs + this.bucketMinutes * 60 * 1000 - 1;
      this.bucketStartTs = start;
      this.cur = { ...bar, ts: barCloseTs };
      return finished;
    }

    const c = this.cur!;
    c.high = Math.max(c.high, bar.high);
    c.low = Math.min(c.low, bar.low);
    c.close = bar.close;
    c.volume += bar.volume;
    return null;
  }
}
