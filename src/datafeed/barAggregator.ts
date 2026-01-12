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

function floorTo5m(ts: number): number {
  const ms = 5 * 60 * 1000;
  return Math.floor(ts / ms) * ms;
}

export class BarAggregator {
  private bucketStartTs: number | null = null;
  private cur: Bar | null = null;

  /** 
   * Push a CLOSED 1m bar; returns a CLOSED 5m bar when bucket completes.
   * 
   * 5m bar timestamp represents the close time: bucketStart + 5min - 1ms
   * This ensures stable, consistent timestamps for cache keys across WS/REST.
   */
  push1m(bar: Bar): Bar | null {
    const start = floorTo5m(bar.ts);
    // 5m bar close time: start of bucket + 5 minutes - 1ms
    // This represents the last millisecond of the 5m bar (stable across WS/REST)
    const bar5mCloseTs = start + 5 * 60 * 1000 - 1;

    if (this.bucketStartTs === null) {
      this.bucketStartTs = start;
      this.cur = { ...bar, ts: bar5mCloseTs };
      return null;
    }

    if (start !== this.bucketStartTs) {
      const finished = this.cur!;
      // Update finished bar's timestamp to represent its close time
      finished.ts = this.bucketStartTs + 5 * 60 * 1000 - 1;
      this.bucketStartTs = start;
      this.cur = { ...bar, ts: bar5mCloseTs };
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
