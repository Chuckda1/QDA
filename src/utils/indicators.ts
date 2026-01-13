export type OHLCVBar = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function lastN<T>(arr: T[], n: number): T[] {
  if (n <= 0) return [];
  return arr.length <= n ? arr : arr.slice(arr.length - n);
}

export function computeEMA(closes: number[], period: number): number | undefined {
  if (!Number.isFinite(period) || period <= 1) return undefined;
  if (closes.length === 0) return undefined;

  const k = 2 / (period + 1);
  let ema = closes[0]!;
  for (let i = 1; i < closes.length; i++) {
    const c = closes[i]!;
    ema = c * k + ema * (1 - k);
  }
  return ema;
}

export function computeATR(bars: OHLCVBar[], period: number): number | undefined {
  if (!Number.isFinite(period) || period <= 1) return undefined;
  if (bars.length < 2) return undefined;

  const window = lastN(bars, Math.max(period + 1, 2));
  if (window.length < 2) return undefined;

  const trs: number[] = [];
  for (let i = 1; i < window.length; i++) {
    const prevClose = window[i - 1]!.close;
    const b = window[i]!;
    const tr = Math.max(
      b.high - b.low,
      Math.abs(b.high - prevClose),
      Math.abs(b.low - prevClose),
    );
    trs.push(tr);
  }

  const trWindow = lastN(trs, period);
  if (trWindow.length === 0) return undefined;
  const sum = trWindow.reduce((acc, v) => acc + v, 0);
  return sum / trWindow.length;
}

export function computeVWAP(bars: OHLCVBar[], period: number): number | undefined {
  if (!Number.isFinite(period) || period <= 1) return undefined;
  if (bars.length === 0) return undefined;

  const window = lastN(bars, period);
  let pv = 0;
  let v = 0;
  for (const b of window) {
    const typical = (b.high + b.low + b.close) / 3;
    pv += typical * b.volume;
    v += b.volume;
  }
  if (v <= 0) return undefined;
  return pv / v;
}

export function computeRSI(closes: number[], period: number): number | undefined {
  if (!Number.isFinite(period) || period <= 1) return undefined;
  if (closes.length < period + 1) return undefined;

  const window = lastN(closes, period + 1);
  let gains = 0;
  let losses = 0;

  for (let i = 1; i < window.length; i++) {
    const diff = window[i]! - window[i - 1]!;
    if (diff > 0) gains += diff;
    else losses += -diff;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

