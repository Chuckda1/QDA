export type OHLCV = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type SwingPoint = {
  ts: number;
  price: number;
  kind: "HIGH" | "LOW";
  index: number;
};

export type StructureTrend = "up" | "down" | "range";
export type StructureState = "intact" | "weakening" | "broken";

export type StructureResult = {
  trend: StructureTrend;
  state: StructureState;
};

export type EntrySignal = {
  verdict: "ENTER" | "WAIT";
  direction: "LONG" | "SHORT" | "NONE";
  entryPrice?: number;
  stop?: number;
  targets?: number[];
  because: string;
};

export function extractSwings(
  bars: OHLCV[],
  lookback: number = 2,
  useClose: boolean = false
): SwingPoint[] {
  if (bars.length < lookback * 2 + 1) return [];

  const swings: SwingPoint[] = [];
  const getHigh = (i: number) => (useClose ? bars[i].close : bars[i].high);
  const getLow = (i: number) => (useClose ? bars[i].close : bars[i].low);

  for (let i = lookback; i < bars.length - lookback; i++) {
    const hi = getHigh(i);
    const lo = getLow(i);

    let isSwingHigh = true;
    let isSwingLow = true;

    for (let k = 1; k <= lookback; k++) {
      if (!(hi > getHigh(i - k) && hi > getHigh(i + k))) isSwingHigh = false;
      if (!(lo < getLow(i - k) && lo < getLow(i + k))) isSwingLow = false;
      if (!isSwingHigh && !isSwingLow) break;
    }

    if (isSwingHigh) {
      swings.push({ ts: bars[i].ts, price: hi, kind: "HIGH", index: i });
    }
    if (isSwingLow) {
      swings.push({ ts: bars[i].ts, price: lo, kind: "LOW", index: i });
    }
  }

  swings.sort((a, b) => a.index - b.index);
  return compressSameKind(swings);
}

export function compressSameKind(swings: SwingPoint[]): SwingPoint[] {
  if (swings.length <= 1) return swings;
  const out: SwingPoint[] = [swings[0]];

  for (let i = 1; i < swings.length; i++) {
    const prev = out[out.length - 1];
    const cur = swings[i];

    if (cur.kind !== prev.kind) {
      out.push(cur);
      continue;
    }

    if (cur.kind === "HIGH") {
      if (cur.price >= prev.price) out[out.length - 1] = cur;
    } else {
      if (cur.price <= prev.price) out[out.length - 1] = cur;
    }
  }
  return out;
}

export function lastSwings(swings: SwingPoint[]) {
  const highs = swings.filter((s) => s.kind === "HIGH");
  const lows = swings.filter((s) => s.kind === "LOW");
  const lastHigh = highs[highs.length - 1];
  const prevHigh = highs[highs.length - 2];
  const lastLow = lows[lows.length - 1];
  const prevLow = lows[lows.length - 2];
  return { lastHigh, prevHigh, lastLow, prevLow };
}

export function determineStructure(swings: SwingPoint[]): StructureResult {
  const { lastHigh, prevHigh, lastLow, prevLow } = lastSwings(swings);

  if (lastHigh && prevHigh && lastLow && prevLow) {
    const hh = lastHigh.price > prevHigh.price;
    const hl = lastLow.price > prevLow.price;
    const ll = lastLow.price < prevLow.price;
    const lh = lastHigh.price < prevHigh.price;

    if (hh && hl) return { trend: "up", state: "intact" };
    if (ll && lh) return { trend: "down", state: "intact" };

    if (hh && !hl) return { trend: "up", state: "weakening" };
    if (ll && !lh) return { trend: "down", state: "weakening" };
  }

  return { trend: "range", state: "intact" };
}

export function detectBreak(
  trend: StructureTrend,
  swings: SwingPoint[],
  lastClose: number
): { broken: boolean; breakLevel?: number; direction?: "up" | "down" } {
  const { lastHigh, prevHigh, lastLow, prevLow } = lastSwings(swings);

  if (!lastHigh || !prevHigh || !lastLow || !prevLow) return { broken: false };

  if (trend === "up") {
    const lh = lastHigh.price < prevHigh.price;
    const broke = lastClose < lastLow.price;
    return { broken: lh && broke, breakLevel: lastLow.price, direction: "down" };
  }

  if (trend === "down") {
    const hl = lastLow.price > prevLow.price;
    const broke = lastClose > lastHigh.price;
    return { broken: hl && broke, breakLevel: lastHigh.price, direction: "up" };
  }

  return { broken: false };
}

export function entrySignalUptrend(forming: OHLCV, lastSwingLow: number): EntrySignal {
  const range = forming.high - forming.low;
  const body = Math.abs(forming.close - forming.open);
  const bullish = forming.close > forming.open;

  const nearSupport = forming.low <= lastSwingLow * 1.001;
  const strongCandle = bullish && range > 0 && body / range >= 0.5;

  if (nearSupport && strongCandle) {
    return {
      verdict: "ENTER",
      direction: "LONG",
      entryPrice: forming.close,
      stop: Math.min(forming.low, lastSwingLow) - 0.02,
      because: "Pullback tagged support and reclaimed with strong bullish candle.",
    };
  }

  return { verdict: "WAIT", direction: "LONG", because: "No clean pullback+reclaim yet." };
}

export function entrySignalDowntrend(forming: OHLCV, lastSwingHigh: number): EntrySignal {
  const range = forming.high - forming.low;
  const body = Math.abs(forming.close - forming.open);
  const bearish = forming.close < forming.open;

  const nearResistance = forming.high >= lastSwingHigh * 0.999;
  const strongCandle = bearish && range > 0 && body / range >= 0.5;

  if (nearResistance && strongCandle) {
    return {
      verdict: "ENTER",
      direction: "SHORT",
      entryPrice: forming.close,
      stop: Math.max(forming.high, lastSwingHigh) + 0.02,
      because: "Pullback tagged resistance and rejected with strong bearish candle.",
    };
  }

  return { verdict: "WAIT", direction: "SHORT", because: "No clean pullback+rejection yet." };
}

export function evaluateEntry(
  trend: StructureTrend,
  forming: OHLCV,
  swings: SwingPoint[]
): EntrySignal {
  const { lastLow, lastHigh } = lastSwings(swings);

  if (trend === "up" && lastLow) {
    return entrySignalUptrend(forming, lastLow.price);
  }

  if (trend === "down" && lastHigh) {
    return entrySignalDowntrend(forming, lastHigh.price);
  }

  return { verdict: "WAIT", direction: "NONE", because: "No directional structure." };
}
