// src/llm/llmDirection1m.ts
// LLM direction opinion loop (1m ingest path, publishes only on strong direction)

import type { MinimalExecutionState } from "../types.js";
import type { LLMService } from "./llmService.js";

type LlmDirection1mResponse = {
  direction: "LONG" | "SHORT" | "NEUTRAL";
  confidence: number;
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
const THROTTLE_MS = 60_000; // 1 minute

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
  symbol: string
): Promise<{ shouldPublish: boolean; direction?: "LONG" | "SHORT" | "NEUTRAL"; confidence?: number }> {
  // Throttle: max once per 60s
  if (exec.llm1mLastCallTs !== undefined && (ts - exec.llm1mLastCallTs) < THROTTLE_MS) {
    return { shouldPublish: false };
  }

  // Require LLM service
  if (!llmService || !llmService.isEnabled()) {
    return { shouldPublish: false };
  }

  // Require at least some closed bars
  if (closed5mBars.length === 0) {
    return { shouldPublish: false };
  }

  // Update last call timestamp
  exec.llm1mLastCallTs = ts;

  // Build raw snapshot (last 60 closed 5m bars only, no thesis fields)
  const barsToUse = closed5mBars.slice(-60);
  const rawSnapshot = {
    symbol,
    closed5mBars: barsToUse,
    forming5mBar: forming5mBar || undefined,
  };

  // Call LLM with strict JSON parsing
  let llmResponse: LlmDirection1mResponse | null = null;
  try {
    const prompt = buildPrompt(rawSnapshot);
    const response = await callLlmDirection(llmService, prompt);
    llmResponse = parseLlmResponse(response);
  } catch (error: any) {
    console.error(`[LLM_1M_DIRECTION] Error: ${error.message ?? error}`);
    llmResponse = { direction: "NEUTRAL", confidence: 0 };
  }

  // Store latest read on exec (NOT bias)
  if (llmResponse) {
    exec.llm1mDirection = llmResponse.direction;
    exec.llm1mConfidence = llmResponse.confidence;
    exec.llm1mTs = ts;
  } else {
    exec.llm1mDirection = "NEUTRAL";
    exec.llm1mConfidence = 0;
    exec.llm1mTs = ts;
  }

  // Decide whether to publish
  const strong = llmResponse.direction !== "NEUTRAL" && llmResponse.confidence >= STRONG_CONF;
  const gapOk = exec.llm1mLastPublishedTs === undefined || (ts - exec.llm1mLastPublishedTs) >= MIN_PUBLISH_GAP_MS;

  const shouldPublish =
    strong &&
    gapOk &&
    (llmResponse.direction !== exec.llm1mLastPublishedDir || // flip
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

/**
 * Build LLM prompt from raw snapshot
 */
function buildPrompt(snapshot: { symbol: string; closed5mBars: Closed5mBar[]; forming5mBar?: Forming5mBar }): string {
  const systemPrompt = `You are a short-horizon market direction classifier. Using ONLY the provided 5-minute OHLCV candles, decide the dominant price direction for the NEXT 30–60 minutes. Return STRICT JSON only.`;

  const userContent = {
    symbol: snapshot.symbol,
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

    return { direction, confidence };
  } catch (error: any) {
    console.error(`[LLM_1M_DIRECTION] Parse error: ${error.message ?? error}`);
    console.error(`[LLM_1M_DIRECTION] Raw content: ${content}`);
    return { direction: "NEUTRAL", confidence: 0 };
  }
}
