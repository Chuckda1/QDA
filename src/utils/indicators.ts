import { etToUtcTimestamp, getETParts } from "./timeUtils.js";

export type OHLCVBar = {
  ts: number;
  open?: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

/**
 * Compute Exponential Moving Average (EMA)
 */
export function computeEMA(closes: number[], period: number): number | undefined {
  if (closes.length < period) {
    return undefined;
  }

  // Start with SMA for first value
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += closes[i]!;
  }
  let ema = sum / period;

  // Apply EMA formula for remaining values
  const multiplier = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) {
    ema = (closes[i]! - ema) * multiplier + ema;
  }

  return ema;
}

/**
 * Compute Average True Range (ATR)
 */
export function computeATR(bars: OHLCVBar[], period: number): number | undefined {
  if (bars.length < period + 1) {
    return undefined;
  }

  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const current = bars[i]!;
    const previous = bars[i - 1]!;
    
    const tr1 = current.high - current.low;
    const tr2 = Math.abs(current.high - previous.close);
    const tr3 = Math.abs(current.low - previous.close);
    
    const tr = Math.max(tr1, tr2, tr3);
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) {
    return undefined;
  }

  // Calculate ATR as SMA of true ranges
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += trueRanges[trueRanges.length - period + i]!;
  }

  return sum / period;
}

/**
 * Compute Volume Weighted Average Price (VWAP)
 */
export function computeVWAP(bars: OHLCVBar[], period: number): number | undefined {
  if (bars.length < period) {
    return undefined;
  }

  const window = bars.slice(-period);
  let totalVolume = 0;
  let totalPriceVolume = 0;

  for (const bar of window) {
    const vol = bar.volume ?? 0;
    if (vol <= 0) continue;
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    totalVolume += vol;
    totalPriceVolume += typicalPrice * vol;
  }

  if (totalVolume === 0) {
    return undefined;
  }

  return totalPriceVolume / totalVolume;
}

export function computeSessionVWAP(bars: OHLCVBar[]): number | undefined {
  if (!bars.length) {
    return undefined;
  }
  const lastTs = bars[bars.length - 1]!.ts;
  const lastDate = new Date(lastTs);
  const sessionStartTs = etToUtcTimestamp(9, 30, lastDate);
  const sessionEndTs = etToUtcTimestamp(16, 0, lastDate);
  const { weekday } = getETParts(lastDate);
  if (weekday === 0 || weekday === 6) {
    return undefined;
  }

  let totalVolume = 0;
  let totalPriceVolume = 0;
  for (const bar of bars) {
    if (bar.ts < sessionStartTs || bar.ts >= sessionEndTs) continue;
    const vol = bar.volume ?? 0;
    if (vol <= 0) continue;
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    totalVolume += vol;
    totalPriceVolume += typicalPrice * vol;
  }

  if (totalVolume === 0) {
    return undefined;
  }
  return totalPriceVolume / totalVolume;
}

/**
 * Compute Relative Strength Index (RSI)
 */
export function computeRSI(closes: number[], period: number): number | undefined {
  if (closes.length < period + 1) {
    return undefined;
  }

  // Calculate price changes
  const changes: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i]! - closes[i - 1]!);
  }

  // Separate gains and losses
  const gains: number[] = [];
  const losses: number[] = [];
  for (const change of changes) {
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }

  if (gains.length < period) {
    return undefined;
  }

  // Calculate initial average gain and loss
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    avgGain += gains[gains.length - period + i]!;
    avgLoss += losses[losses.length - period + i]!;
  }
  avgGain /= period;
  avgLoss /= period;

  // Use Wilder's smoothing for subsequent calculations
  for (let i = gains.length - period + 1; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]!) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]!) / period;
  }

  if (avgLoss === 0) {
    return 100; // Avoid division by zero
  }

  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));

  return rsi;
}

/**
 * Compute Bollinger Bands (SMA +/- stdDev * sigma)
 */
export function computeBollingerBands(
  closes: number[],
  period: number,
  stdDev: number
): { middle: number; upper: number; lower: number } | undefined {
  if (closes.length < period) {
    return undefined;
  }

  const window = closes.slice(-period);
  const mean = window.reduce((sum, v) => sum + v, 0) / period;
  const variance = window.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / period;
  const sigma = Math.sqrt(variance);

  return {
    middle: mean,
    upper: mean + stdDev * sigma,
    lower: mean - stdDev * sigma,
  };
}
