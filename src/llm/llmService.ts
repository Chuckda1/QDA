import type {
  MinimalLLMSnapshot,
  MinimalSetupCandidate,
  MinimalSetupSelectionResponse,
  MinimalSetupSelectionResult,
} from "../types.js";

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

    const prompt = `You are a trading assistant.
You receive recent OHLCV bars and 2 candidate setups (LONG and SHORT).
Your job is to select the single best candidate RIGHT NOW, or PASS if neither is legitimate.

Return JSON only:
{
  "selected": "LONG|SHORT|PASS",
  "confidence": 0,
  "reason": "brief reason referencing price behavior"
}

Rules:
- All fields above are REQUIRED in every response.
- Do NOT invent indicators.
- Do NOT add extra fields.

LLM input:
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
