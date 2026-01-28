import type {
  MinimalLLMSnapshot,
  MinimalSetupCandidate,
  MinimalSetupSelectionResponse,
  MinimalSetupSelectionResult,
  ArmDecisionRaw5mResponse,
  ArmDecisionRaw5mResult,
} from "../types.js";
import { randomUUID } from "crypto";

export class LLMService {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private enabled: boolean;

  constructor() {
    const rawKey = process.env.OPENAI_API_KEY || "";
    this.apiKey = rawKey.trim();
    this.baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    this.model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    this.enabled = !!this.apiKey;

    if (!rawKey) {
      console.warn("[LLMService] OPENAI_API_KEY not found in environment");
    } else if (!this.apiKey) {
      console.warn("[LLMService] OPENAI_API_KEY found but empty after trimming");
    } else {
      console.log(`[LLMService] OPENAI_API_KEY found (length: ${this.apiKey.length}, starts with: ${this.apiKey.substring(0, 7)}...)`);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private normalizeMinimalSetupSelection(input: any): MinimalSetupSelectionResponse | null {
    if (!input || typeof input !== "object") return null;
    const selectedRaw = typeof input.selected === "string" ? input.selected.toUpperCase() : "";
    const selected =
      selectedRaw === "LONG" || selectedRaw === "SHORT" || selectedRaw === "PASS"
        ? (selectedRaw as "LONG" | "SHORT" | "PASS")
        : "PASS";
    const confidence = Number.isFinite(input.confidence) ? Number(input.confidence) : NaN;
    const reason = typeof input.reason === "string" ? input.reason : "";
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100 || !reason) {
      return null;
    }
    return { selected, confidence, reason };
  }

  async getMinimalSetupSelection(params: {
    snapshot: MinimalLLMSnapshot;
    candidates: MinimalSetupCandidate[];
  }): Promise<MinimalSetupSelectionResult> {
    const fallback: MinimalSetupSelectionResponse = {
      selected: "PASS",
      confidence: 0,
      reason: "LLM unavailable",
    };
    if (!this.enabled) {
      return { selection: fallback, valid: false };
    }

    const closed5mBars = params.snapshot.closed5mBars.map((bar) => ({
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    }));
    const forming5mBar = params.snapshot.forming5mBar
      ? {
          open: params.snapshot.forming5mBar.open,
          high: params.snapshot.forming5mBar.high,
          low: params.snapshot.forming5mBar.low,
          close: params.snapshot.forming5mBar.close,
          volume: params.snapshot.forming5mBar.volume,
        }
      : null;
    const llmInput = {
      closed5mBars,
      forming5mBar,
      candidates: params.candidates,
    };

    const hasCandidates = params.candidates && params.candidates.length >= 2;
    console.log(
      `[LLM_SERVICE] hasCandidates=${hasCandidates} candidatesCount=${params.candidates?.length ?? 0} barsCount=${closed5mBars.length}`
    );
    
    const prompt = hasCandidates
      ? `You are a trading assistant.
The bot has analyzed price action and produced 2 candidate setups (LONG and SHORT) with entry triggers and invalidation levels.
Your job: Review the raw bars AND the bot's candidates, then select the single best candidate RIGHT NOW, or PASS if neither is legitimate.

Bot's candidates:
${JSON.stringify(params.candidates, null, 2)}

Return JSON only:
{
  "selected": "LONG|SHORT|PASS",
  "confidence": 0,
  "reason": "brief reason referencing price behavior"
}

Rules:
- All fields above are REQUIRED in every response.
- "confidence" must be 0-100.
- Do NOT invent indicators.
- Do NOT add extra fields.

Raw data:
${JSON.stringify(llmInput)}`
      : `You are a trading assistant.
The bot has provided raw OHLCV bars. Analyze the price action and determine if you should take a LONG position, SHORT position, or PASS (wait).

Return JSON only:
{
  "selected": "LONG|SHORT|PASS",
  "confidence": 0,
  "reason": "brief reason referencing price behavior"
}

Rules:
- All fields above are REQUIRED in every response.
- "confidence" must be 0-100.
- Do NOT invent indicators.
- Do NOT add extra fields.

Raw data:
${JSON.stringify(llmInput)}`;

    const payload = {
      model: this.model,
      messages: [
        { role: "system", content: "Return JSON only. No markdown." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
    };

    const start = Date.now();
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    const duration = Date.now() - start;
    if (!response.ok) {
      const error = await response.text();
      console.error(`[LLM] SetupSelection error (${duration}ms):`, response.status, error);
      return { selection: { ...fallback, reason: "LLM error" }, valid: false };
    }
    const json = await response.json();
    const content = json?.choices?.[0]?.message?.content ?? "{}";
    try {
      const parsed = JSON.parse(content);
      const normalized = this.normalizeMinimalSetupSelection(parsed);
      if (!normalized) {
        console.error("[LLM] SetupSelection invalid schema:", content);
        return { selection: { ...fallback, reason: "LLM invalid schema" }, valid: false };
      }
      return { selection: normalized, valid: true };
    } catch (err) {
      console.error("[LLM] SetupSelection parse error:", err);
      return { selection: { ...fallback, reason: "LLM parse error" }, valid: false };
    }
  }

  private normalizeArmDecisionRaw5m(input: any): ArmDecisionRaw5mResponse | null {
    if (!input || typeof input !== "object") return null;
    const actionRaw = typeof input.action === "string" ? input.action.toUpperCase() : "";
    const action =
      actionRaw === "ARM_LONG" || actionRaw === "ARM_SHORT" || actionRaw === "WAIT"
        ? (actionRaw as "ARM_LONG" | "ARM_SHORT" | "WAIT")
        : "WAIT";
    const confidence = Number.isFinite(input.confidence) ? Number(input.confidence) : NaN;
    const because = typeof input.because === "string" ? input.because : "";
    const waiting_for = typeof input.waiting_for === "string" ? input.waiting_for : "";
    const mindId = typeof input.mindId === "string" ? input.mindId : randomUUID();
    
    // All fields are required, including waiting_for
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100 || !because || !waiting_for) {
      return null;
    }
    return { mindId, action, confidence, because, waiting_for };
  }

  async getArmDecisionRaw5m(params: {
    snapshot: MinimalLLMSnapshot;
  }): Promise<ArmDecisionRaw5mResult> {
    const fallback: ArmDecisionRaw5mResponse = {
      mindId: randomUUID(),
      action: "WAIT",
      confidence: 0,
      because: "LLM unavailable",
      waiting_for: "llm_unavailable",
    };
    if (!this.enabled) {
      return { decision: fallback, valid: false };
    }

    const closed5mBars = params.snapshot.closed5mBars.slice(-30).map((bar) => ({
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    }));
    const forming5mBar = params.snapshot.forming5mBar
      ? {
          open: params.snapshot.forming5mBar.open,
          high: params.snapshot.forming5mBar.high,
          low: params.snapshot.forming5mBar.low,
          close: params.snapshot.forming5mBar.close,
          volume: params.snapshot.forming5mBar.volume,
        }
      : null;

    const llmInput = {
      closed5mBars,
      forming5mBar,
    };

    const prompt = `You are a discretionary market analyst assisting an execution system.

You receive ONLY 5-minute OHLCV bars (closed + forming). Analyze price action and decide whether to ARM_LONG, ARM_SHORT, or WAIT.

**CRITICAL: Move Maturity Lens**

In addition to identifying direction (bullish, bearish, neutral), you must evaluate the *maturity* of the current move. Move maturity describes *where the market is in the lifecycle of a move*, not whether the move is "right" or "wrong."

When analyzing price action, always consider:
- Is this move **early**, **developing**, **extended**, or **exhausting**?
- Is price reacting **for the first time** to a level, or returning after prior tests?
- Has momentum **expanded recently**, or is it **stalling after expansion**?
- Is participation **increasing, stable, or fading** relative to the prior push?

Use this lens to *qualify confidence*, not to force a decision.

**Guidance (do not treat as rules):**
- Early/developing moves tend to have clean structure, space to targets, and improving participation.
- Mature or extended moves often show overlapping candles, wickiness, failed continuation, or divergence between price and momentum.
- A breakout attempt that occurs after a long consolidation or multiple failed pushes should be treated as lower quality unless participation clearly expands.

**Confidence Calculation:**
- You MUST compute confidence solely from the provided bars.
- Do NOT reduce confidence just because the sample is small.
- **Adjust confidence DOWN if the move appears mature or late** - this is part of your honest assessment.
- If you are uncertain, express that uncertainty in "because" and "waiting_for", but keep confidence as your honest estimate based on the available data.
- Do not apply any warmup multipliers or sample-size penalties to confidence.

**Prefer WAIT when direction is correct but maturity is unfavorable.**

Return JSON only:
{
  "mindId": "uuid-string",
  "action": "ARM_LONG|ARM_SHORT|WAIT",
  "confidence": 0,
  "because": "brief reason referencing price behavior and move maturity assessment",
  "waiting_for": "short text describing what you're waiting for (required for all actions)"
}

Rules:
- All fields above are REQUIRED in every response, including "waiting_for".
- "confidence" must be 0-100 and reflect your honest assessment, adjusted for move maturity.
- "action" must be ARM_LONG, ARM_SHORT, or WAIT.
- Do NOT invent indicators. Use only OHLCV data.
- Do NOT add invalidation levels, stop prices, buffers, or swing references.
- If uncertain, use "because" and "waiting_for" to explain, but keep confidence as your true estimate.

Raw 5m data:
${JSON.stringify(llmInput)}`;

    const payload = {
      model: this.model,
      messages: [
        { role: "system", content: "Return JSON only. No markdown." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
    };

    const start = Date.now();
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    const duration = Date.now() - start;
    if (!response.ok) {
      const error = await response.text();
      console.error(`[LLM] ArmDecisionRaw5m error (${duration}ms):`, response.status, error);
      return { decision: { ...fallback, because: "LLM error" }, valid: false };
    }
    const json = await response.json();
    const content = json?.choices?.[0]?.message?.content ?? "{}";
    try {
      const parsed = JSON.parse(content);
      const normalized = this.normalizeArmDecisionRaw5m(parsed);
      if (!normalized) {
        console.error("[LLM] ArmDecisionRaw5m invalid schema:", content);
        return { decision: { ...fallback, because: "LLM invalid schema" }, valid: false };
      }
      return { decision: normalized, valid: true };
    } catch (err) {
      console.error("[LLM] ArmDecisionRaw5m parse error:", err);
      return { decision: { ...fallback, because: "LLM parse error" }, valid: false };
    }
  }

  async testConnection(): Promise<{ success: boolean; latency: number; error?: string }> {
    if (!this.enabled) {
      return {
        success: false,
        latency: 0,
        error: "LLM disabled: missing OPENAI_API_KEY",
      };
    }

    const startTime = Date.now();
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: "reply with OK" }],
          temperature: 0.2,
          max_tokens: 10,
        }),
      });

      const latency = Date.now() - startTime;
      if (!response.ok) {
        const errorText = await response.text();
        const sanitized = errorText.replace(/sk-[a-zA-Z0-9]+/g, "sk-***");
        return {
          success: false,
          latency,
          error: `HTTP ${response.status}: ${sanitized.substring(0, 200)}`,
        };
      }

      return { success: true, latency };
    } catch (error: any) {
      const latency = Date.now() - startTime;
      const errorMsg = error.message || String(error);
      const sanitized = errorMsg.replace(/sk-[a-zA-Z0-9]+/g, "sk-***");
      return {
        success: false,
        latency,
        error: sanitized.substring(0, 200),
      };
    }
  }
}
