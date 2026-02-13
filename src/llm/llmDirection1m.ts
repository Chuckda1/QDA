// src/llm/llmDirection1m.ts
// LLM direction opinion loop (1m ingest path, publishes only on strong direction)

import type { MinimalExecutionState } from "../types.js";
import type { LLMService } from "./llmService.js";

type LlmDirection1mResponse = {
  direction: "LONG" | "SHORT" | "NEUTRAL";
  confidence: number;
  /** Short coaching line: what to do next / what's forming (e.g. "Wait for break above 450", "Setup forming; test 448 next") */
  coachLine?: string;
  /** Next level price is likely to test or hit in the next 30-60 min */
  nextLevel?: number;
  /** Likelihood (0-100) that price reaches nextLevel in that window */
  likelihoodHit?: number;
  /** Whether LLM allows bias flip (required field) */
  flipOk?: boolean;
};

type Closed5mBar = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type Forming5mBar = {
  startTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  progressMinutes?: number;
};

// Constants
const STRONG_CONF = 80;
const MIN_PUBLISH_GAP_MS = 3 * 60_000; // 3 minutes
const SAME_DIR_REFRESH_MS = 15 * 60_000; // 15 minutes
const CONF_JUMP = 12;
const THROTTLE_MS = 60_000; // 1 minute when bias established (BULLISH/BEARISH)
const THROTTLE_NEUTRAL_MS = 3 * 60_000; // 3 minutes when NEUTRAL so we still get LLM input for nudge without spamming
const BARS_WINDOW = 45; // 5m bars; room for botState + micro + bars1m
const BARS_1M_WINDOW = 20; // Last 20 1m bars (chart-like tape)
const MIN_BARS_FOR_LLM = 10; // Minimum closed 5m bars before calling LLM
const VWAP_DEADBAND_ATR_MULT = 0.2; // Skip LLM if price within 0.2*ATR of VWAP
const DEBOUNCE_HISTORY_SIZE = 5; // Track last 5 LLM directions
const DEBOUNCE_MIN_SAME_DIR = 3; // Require ≥3 of last 4 calls to be same direction
const DEBOUNCE_HIGH_CONF = 90; // Or confidence ≥90 to accept flip

/**
 * Maybe update LLM direction opinion (throttled, publishes only on strong direction)
 */
export async function maybeUpdateLlmDirection1m(
  exec: MinimalExecutionState,
  ts: number,
  price: number,
  closed5mBars: Closed5mBar[],
  forming5mBar: Forming5mBar | null | undefined,
  llmService: LLMService | undefined,
  symbol: string,
  biasEngineState?: string,
  micro?: { vwap1m?: number; atr1m?: number }
): Promise<{ shouldPublish: boolean; direction?: "LONG" | "SHORT" | "NEUTRAL"; confidence?: number }> {
  // Require LLM service
  if (!llmService || !llmService.isEnabled()) {
    return { shouldPublish: false };
  }

  // LLM call gating: Skip if insufficient bars
  if (closed5mBars.length < MIN_BARS_FOR_LLM) {
    console.log(`[LLM_GATE] Skipping LLM call: closed5mBars.length=${closed5mBars.length} < ${MIN_BARS_FOR_LLM}`);
    return { shouldPublish: false };
  }

  const beState = biasEngineState ?? exec.biasEngine?.state;
  const stable = beState === "BULLISH" || beState === "BEARISH";

  // LLM call gating: Skip only when in REPAIR (let 5m structure finalize; avoid LLM noise during repair)
  if (beState?.startsWith("REPAIR_")) {
    console.log(`[LLM_GATE] Skipping LLM call: beState=${beState} (REPAIR - wait for 5m structure)`);
    return { shouldPublish: false };
  }

  // Throttle: when NEUTRAL use 3 min so we get LLM input for nudge without spamming; when stable use 1 min
  const throttleMs = stable ? THROTTLE_MS : THROTTLE_NEUTRAL_MS;
  if (exec.llm1mLastCallTs !== undefined && (ts - exec.llm1mLastCallTs) < throttleMs) {
    return { shouldPublish: false };
  }

  // LLM call gating: Skip if price too close to VWAP (chop detection)
  if (micro?.vwap1m !== undefined && micro?.atr1m !== undefined) {
    const vwap = micro.vwap1m;
    const atr = micro.atr1m;
    const distanceFromVwap = Math.abs(price - vwap);
    const deadband = VWAP_DEADBAND_ATR_MULT * atr;
    if (distanceFromVwap < deadband) {
      console.log(`[LLM_GATE] Skipping LLM call: price=${price.toFixed(2)} vwap=${vwap.toFixed(2)} distance=${distanceFromVwap.toFixed(2)} < deadband=${deadband.toFixed(2)} (chop/near VWAP)`);
      return { shouldPublish: false };
    }
  }

  // Update last call timestamp
  exec.llm1mLastCallTs = ts;

  // Build snapshot: bars (last N for token efficiency) + current price + bot state + micro tape
  const barsToUse = closed5mBars.slice(-BARS_WINDOW);
  const rawSnapshot = buildLlmSnapshot(exec, price, symbol, barsToUse, forming5mBar || undefined);

  // Call LLM with strict JSON parsing
  let llmResponse: LlmDirection1mResponse | null = null;
  try {
    const prompt = buildPrompt(rawSnapshot);
    const response = await callLlmDirection(llmService, prompt);
    llmResponse = parseLlmResponse(response);
  } catch (error: any) {
    console.error(`[LLM_1M_DIRECTION] Error: ${error.message ?? error}`);
    llmResponse = { direction: "NEUTRAL", confidence: 0, flipOk: false };
  }

  // LLM direction debounce: Track history and check if flip is allowed
  if (!exec.llmDirectionHistory) {
    exec.llmDirectionHistory = [];
  }
  
  // Add current response to history
  exec.llmDirectionHistory.push({
    direction: llmResponse.direction,
    confidence: llmResponse.confidence,
    ts,
  });
  
  // Keep only last N entries
  if (exec.llmDirectionHistory.length > DEBOUNCE_HISTORY_SIZE) {
    exec.llmDirectionHistory = exec.llmDirectionHistory.slice(-DEBOUNCE_HISTORY_SIZE);
  }

  // Debounce check will be done in shouldPublish logic below

  // Store latest read on exec (NOT bias), including coaching
  // Also store as proposal (separate from canonical bias - bias engine owns exec.bias)
  if (llmResponse) {
    exec.llm1mDirection = llmResponse.direction;
    exec.llm1mConfidence = llmResponse.confidence;
    exec.llm1mTs = ts;
    exec.llm1mCoachLine = llmResponse.coachLine;
    exec.llm1mNextLevel = llmResponse.nextLevel;
    exec.llm1mLikelihoodHit = llmResponse.likelihoodHit;
    
    // Store as proposal (separate from canonical bias)
    exec.llmProposal = {
      direction: llmResponse.direction,
      confidence: llmResponse.confidence,
      ts,
      flipOk: llmResponse.flipOk,
    };
  } else {
    exec.llm1mDirection = "NEUTRAL";
    exec.llm1mConfidence = 0;
    exec.llm1mTs = ts;
    exec.llm1mCoachLine = undefined;
    exec.llm1mNextLevel = undefined;
    exec.llm1mLikelihoodHit = undefined;
    exec.llmProposal = undefined;
  }

  // Decide whether to publish (respect debounce for flips)
  const strong = llmResponse.direction !== "NEUTRAL" && llmResponse.confidence >= STRONG_CONF;
  const gapOk = exec.llm1mLastPublishedTs === undefined || (ts - exec.llm1mLastPublishedTs) >= MIN_PUBLISH_GAP_MS;
  
  // Check if flip is debounced
  const lastPublishedDir = exec.llm1mLastPublishedDir;
  const isFlip = lastPublishedDir !== undefined && lastPublishedDir !== "NEUTRAL" && 
                 llmResponse.direction !== "NEUTRAL" && 
                 llmResponse.direction !== lastPublishedDir;
  
  let flipAllowed = true;
  if (isFlip) {
    // Check last 4 calls (including current one we just added)
    const recentHistory = exec.llmDirectionHistory?.slice(-4) ?? [];
    const sameDirCount = recentHistory.filter(h => h.direction === llmResponse.direction).length;
    const highConf = llmResponse.confidence >= DEBOUNCE_HIGH_CONF;
    flipAllowed = sameDirCount >= DEBOUNCE_MIN_SAME_DIR || highConf || llmResponse.flipOk === true;
    
    if (!flipAllowed) {
      console.log(
        `[LLM_DEBOUNCE] Blocking flip: ${lastPublishedDir} -> ${llmResponse.direction} | ` +
        `sameDirCount=${sameDirCount}/${recentHistory.length} (need ${DEBOUNCE_MIN_SAME_DIR}) highConf=${highConf} flipOk=${llmResponse.flipOk}`
      );
    } else {
      console.log(
        `[LLM_DEBOUNCE] Allowing flip: ${lastPublishedDir} -> ${llmResponse.direction} | ` +
        `sameDirCount=${sameDirCount}/${recentHistory.length} highConf=${highConf} flipOk=${llmResponse.flipOk}`
      );
    }
  }

  const shouldPublish =
    strong &&
    gapOk &&
    flipAllowed &&
    (llmResponse.direction !== exec.llm1mLastPublishedDir || // flip (now debounced)
      (exec.llm1mLastPublishedTs !== undefined && ts - exec.llm1mLastPublishedTs >= SAME_DIR_REFRESH_MS) || // refresh same strong direction
      (exec.llm1mLastPublishedDir === llmResponse.direction &&
        exec.llm1mLastPublishedConf !== undefined &&
        llmResponse.confidence - exec.llm1mLastPublishedConf >= CONF_JUMP)); // confidence jump

  if (shouldPublish) {
    exec.llm1mLastPublishedDir = llmResponse.direction;
    exec.llm1mLastPublishedConf = llmResponse.confidence;
    exec.llm1mLastPublishedTs = ts;
  }

  return {
    shouldPublish,
    direction: llmResponse.direction,
    confidence: llmResponse.confidence,
  };
}

type Bar1m = { ts: number; o: number; h: number; l: number; c: number; v: number };

/** Snapshot passed to the LLM: candles + current price + bot state + micro tape + 1m bars */
type LlmSnapshot = {
  symbol: string;
  currentPrice: number;
  closed5mBars: Closed5mBar[];
  forming5mBar?: Forming5mBar;
  /** Last N 1m bars (chart-like) for LLM to use its own structure read */
  bars1m?: Bar1m[];
  botState: {
    bias: string;
    phase: string;
    setup?: string;
    setupTriggerPrice?: number;
    setupStopPrice?: number;
    entryPrice?: number;
    stopPrice?: number;
    targets?: number[];
  };
  micro?: {
    vwap1m?: number;
    emaFast1m?: number;
    atr1m?: number;
    lastSwingHigh1m?: number;
    lastSwingLow1m?: number;
    aboveVwapCount?: number;
    belowVwapCount?: number;
    aboveEmaCount?: number;
    belowEmaCount?: number;
  };
};

function buildLlmSnapshot(
  exec: MinimalExecutionState,
  price: number,
  symbol: string,
  closed5mBars: Closed5mBar[],
  forming5mBar: Forming5mBar | undefined
): LlmSnapshot {
  const inTrade = exec.phase === "IN_TRADE";
  const botState: LlmSnapshot["botState"] = {
    bias: exec.bias ?? "NEUTRAL",
    phase: exec.phase ?? "NEUTRAL_PHASE",
    setup: exec.setup,
    setupTriggerPrice: exec.setupTriggerPrice,
    setupStopPrice: exec.setupStopPrice,
    ...(inTrade && {
      entryPrice: exec.entryPrice,
      stopPrice: exec.stopPrice,
      targets: exec.targets?.slice(0, 3),
    }),
  };
  const micro = exec.micro
    ? {
        vwap1m: exec.micro.vwap1m,
        emaFast1m: exec.micro.emaFast1m,
        atr1m: exec.micro.atr1m,
        lastSwingHigh1m: exec.micro.lastSwingHigh1m,
        lastSwingLow1m: exec.micro.lastSwingLow1m,
        aboveVwapCount: exec.micro.aboveVwapCount,
        belowVwapCount: exec.micro.belowVwapCount,
        aboveEmaCount: exec.micro.aboveEmaCount,
        belowEmaCount: exec.micro.belowEmaCount,
      }
    : undefined;
  const bars1m = exec.microBars1m?.slice(-BARS_1M_WINDOW).map((b) => ({
    ts: b.ts,
    o: b.open,
    h: b.high,
    l: b.low,
    c: b.close,
    v: b.volume,
  }));

  return {
    symbol,
    currentPrice: price,
    closed5mBars,
    forming5mBar,
    bars1m: bars1m?.length ? bars1m : undefined,
    botState,
    micro,
  };
}

/**
 * Build LLM prompt from snapshot (candles + current price + bot state + micro)
 */
function buildPrompt(snapshot: LlmSnapshot): string {
  const systemPrompt = `You are a short-horizon market direction classifier and trading coach. You receive:
- currentPrice: the latest 1m close (use this as "price right now").
- closed5mBars + forming5mBar: recent 5m OHLCV candles.
- bars1m: last 20 1m OHLCV bars (chart-like tape). You may use bar data and your own structure read in addition to botState and micro.
- botState: the execution system's current state (bias, phase, setup, trigger/stop; if in trade, entry/stop/targets). Use these levels when coaching when they exist.
- micro: 1m tape (VWAP, EMA, ATR, swing high/low, consecutive bars above/below VWAP/EMA). Align your nextLevel and coachLine with these levels when relevant.

You may use your own read from the bars (momentum, structure, levels) as well as botState/micro. Prefer botState trigger/targets when they exist for coachLine; for nextLevel you may use micro levels or levels you infer from bars1m/closed5mBars.

IMPORTANT: NEUTRAL Preference
- When price is in chop/near VWAP (oscillating around mean), STRONGLY prefer NEUTRAL direction.
- Only choose LONG or SHORT when there is clear directional structure or displacement.
- If price is mean-reverting or balanced, choose NEUTRAL even if there's a slight directional drift.

Output:
1. direction: dominant price direction for the NEXT 30–60 minutes (LONG, SHORT, or NEUTRAL).
2. confidence: 0-100 confidence in that direction.
3. coachLine: one short sentence coaching the trader. Reference botState levels when they exist. Keep under 80 chars.
4. nextLevel: one price level price is likely to test or hit in the next 30-60 min (number, or null if unclear).
5. likelihoodHit: 0-100 likelihood that price reaches nextLevel in that window (omit if nextLevel is null).
6. flipOk: boolean indicating whether you allow a bias flip if this direction differs from the current published direction. Set to true only when you have high conviction that the direction change is warranted. Default to false if uncertain.

Return STRICT JSON only. No markdown. No explanation. Include all six keys every time.`;

  const userContent = {
    symbol: snapshot.symbol,
    currentPrice: snapshot.currentPrice,
    closed5mBars: snapshot.closed5mBars.map((b) => ({
      ts: b.ts,
      o: b.open,
      h: b.high,
      l: b.low,
      c: b.close,
      v: b.volume,
    })),
    forming5mBar: snapshot.forming5mBar
      ? {
          ts: snapshot.forming5mBar.startTs,
          o: snapshot.forming5mBar.open,
          h: snapshot.forming5mBar.high,
          l: snapshot.forming5mBar.low,
          c: snapshot.forming5mBar.close,
          v: snapshot.forming5mBar.volume,
        }
      : undefined,
    botState: snapshot.botState,
    micro: snapshot.micro,
    bars1m: snapshot.bars1m,
  };

  return `${systemPrompt}\n\n${JSON.stringify(userContent, null, 2)}`;
}

/**
 * Call LLM service for direction opinion
 */
async function callLlmDirection(llmService: LLMService, prompt: string): Promise<string> {
  const apiKey = (llmService as any).apiKey;
  const baseUrl = (llmService as any).baseUrl || "https://api.openai.com/v1";
  const model = (llmService as any).model || "gpt-4o-mini";

  const payload = {
    model,
    messages: [
      { role: "system", content: "Return STRICT JSON only. No markdown. No explanation." },
      { role: "user", content: prompt },
    ],
    temperature: 0.2,
    response_format: { type: "json_object" },
  };

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`LLM API error: ${response.status} ${error}`);
  }

  const json = await response.json();
  return json?.choices?.[0]?.message?.content ?? "";
}

/**
 * Parse LLM response (strict JSON)
 */
function parseLlmResponse(content: string): LlmDirection1mResponse {
  try {
    const parsed = JSON.parse(content);
    const direction = parsed.direction;
    const confidence = Number(parsed.confidence);

    if (direction !== "LONG" && direction !== "SHORT" && direction !== "NEUTRAL") {
      throw new Error(`Invalid direction: ${direction}`);
    }

    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
      throw new Error(`Invalid confidence: ${confidence}`);
    }

    const coachLine = typeof parsed.coachLine === "string" && parsed.coachLine.trim().length > 0
      ? parsed.coachLine.trim().slice(0, 120)
      : undefined;
    const nextLevel = typeof parsed.nextLevel === "number" && Number.isFinite(parsed.nextLevel)
      ? parsed.nextLevel
      : parsed.nextLevel === null ? undefined : undefined;
    const likelihoodHit = typeof parsed.likelihoodHit === "number" && Number.isFinite(parsed.likelihoodHit)
      ? Math.max(0, Math.min(100, Math.round(parsed.likelihoodHit)))
      : undefined;
    
    const flipOk = typeof parsed.flipOk === "boolean" ? parsed.flipOk : false;

    return { direction, confidence, coachLine, nextLevel, likelihoodHit, flipOk };
  } catch (error: any) {
    console.error(`[LLM_1M_DIRECTION] Parse error: ${error.message ?? error}`);
    console.error(`[LLM_1M_DIRECTION] Raw content: ${content}`);
    return { direction: "NEUTRAL", confidence: 0 };
  }
}
