import type {
  MinimalLLMSnapshot,
  MinimalSetupCandidate,
  MinimalSetupSelectionResponse,
  MinimalSetupSelectionResult,
  ArmDecisionRaw5mResponse,
  ArmDecisionRaw5mResult,
  PostTradeIntrospection,
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

    // Build fresh messages array - NO prior context or assistant responses
    // LLM calls are stateless by design. No prior context is reused.
    const SYSTEM_PROMPT = "Return JSON only. No markdown."; // Fixed constant system prompt
    const payload = {
      model: this.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
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

  private parseControlSentence(text: string): ArmDecisionRaw5mResponse | null {
    // Parse: CONTROL=<LONG|SHORT|WAIT|A+> | BIAS=<bullish|bearish|neutral> | MATURITY=<early|developing|mature|extended|unclear> | CONF=<0-100>
    // More flexible parsing - allow variations in format
    const controlMatch = text.match(/CONTROL[=:]?\s*(\w+)/i);
    const biasMatch = text.match(/BIAS[=:]?\s*(bullish|bearish|neutral)/i);
    const maturityMatch = text.match(/MATURITY[=:]?\s*(early|developing|mature|extended|unclear)/i);
    const confMatch = text.match(/CONF[=:]?\s*(\d+)/i);

    // CONTROL is required, others have defaults
    if (!controlMatch) {
      return null;
    }

    const controlRaw = controlMatch[1].toUpperCase();
    let action: "ARM_LONG" | "ARM_SHORT" | "WAIT" | "A+";
    if (controlRaw === "LONG") {
      action = "ARM_LONG";
    } else if (controlRaw === "SHORT") {
      action = "ARM_SHORT";
    } else if (controlRaw === "A+" || controlRaw === "A_PLUS" || controlRaw === "APLUS") {
      action = "A+";
    } else {
      action = "WAIT";
    }

    // Defaults for missing fields (graceful degradation)
    const bias = biasMatch 
      ? (biasMatch[1].toLowerCase() as "bullish" | "bearish" | "neutral")
      : (action === "ARM_LONG" ? "bullish" : action === "ARM_SHORT" ? "bearish" : "neutral");
    
    const maturity = maturityMatch
      ? (maturityMatch[1].toLowerCase() as "early" | "developing" | "mature" | "extended" | "unclear")
      : "unclear";
    
    const confidence = confMatch 
      ? parseInt(confMatch[1], 10)
      : (action === "WAIT" ? 0 : 50); // Default confidence if missing

    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
      return null;
    }

    // Generate because and waiting_for from parsed data
    const because = `${bias} bias, ${maturity} move maturity`;
    const waiting_for = action === "WAIT" ? `waiting_for_${maturity}_move_to_develop` : `ready_for_${action.toLowerCase()}`;

    return {
      mindId: randomUUID(),
      action,
      confidence,
      bias,
      maturity,
      because,
      waiting_for,
    };
  }

  private normalizeArmDecisionRaw5m(input: any): ArmDecisionRaw5mResponse | null {
    // Try parsing as control sentence first
    if (typeof input === "string") {
      const parsed = this.parseControlSentence(input);
      if (parsed) return parsed;
    }

    // Fallback to JSON format (backward compatibility)
    if (!input || typeof input !== "object") return null;
    
    const actionRaw = typeof input.action === "string" ? input.action.toUpperCase() : "";
    const action =
      actionRaw === "ARM_LONG" || actionRaw === "ARM_SHORT" || actionRaw === "WAIT" || actionRaw === "A+" || actionRaw === "A_PLUS"
        ? (actionRaw === "A_PLUS" ? "A+" : actionRaw) as "ARM_LONG" | "ARM_SHORT" | "WAIT" | "A+"
        : "WAIT";
    const confidence = Number.isFinite(input.confidence) ? Number(input.confidence) : NaN;
    const bias = typeof input.bias === "string" 
      ? (input.bias.toLowerCase() as "bullish" | "bearish" | "neutral")
      : (action === "ARM_LONG" ? "bullish" : action === "ARM_SHORT" ? "bearish" : "neutral");
    const maturity = typeof input.maturity === "string"
      ? (input.maturity.toLowerCase() as "early" | "developing" | "mature" | "extended" | "unclear")
      : "unclear";
    const because = typeof input.because === "string" ? input.because : "";
    const waiting_for = typeof input.waiting_for === "string" ? input.waiting_for : "";
    const mindId = typeof input.mindId === "string" ? input.mindId : randomUUID();
    
    // All fields are required, including waiting_for
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100 || !because || !waiting_for) {
      return null;
    }
    return { mindId, action, confidence, bias, maturity, because, waiting_for };
  }

  async getArmDecisionRaw5m(params: {
    snapshot: MinimalLLMSnapshot;
  }): Promise<ArmDecisionRaw5mResult> {
    // ============================================================================
    // LLM calls are stateless by design. No prior context is reused.
    // Each call contains ONLY:
    // - A fixed system prompt (constant)
    // - The current snapshot (closed5mBars + forming5mBar + dailyContextLite)
    // Previous assistant replies are NEVER included in subsequent requests.
    // ============================================================================
    
    const fallback: ArmDecisionRaw5mResponse = {
      mindId: randomUUID(),
      action: "WAIT",
      confidence: 0,
      bias: "neutral",
      maturity: "unclear",
      because: "LLM unavailable",
      waiting_for: "llm_unavailable",
    };
    if (!this.enabled) {
      return { decision: fallback, valid: false };
    }

    const closed5mBars = params.snapshot.closed5mBars.slice(-60).map((bar) => ({
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
      dailyContextLite: params.snapshot.dailyContextLite,
    };

    const prompt = `You are a senior discretionary market analyst assisting an automated execution system.
You will receive structured market data (OHLCV bars).

You must internally perform full market reasoning, including:
- Structure
- Momentum
- Participation
- Context
- Move maturity

However, you must NOT output your reasoning.

Your task is to compress your full analysis into ONE control sentence that the execution system will act on.

---
## Key Rule: Separate BIAS from CONTROL
BIAS answers: "Which side is structurally favored right now?"
CONTROL answers: "Do we act now, or wait for a better moment?"

IMPORTANT:
- You are allowed to output CONTROL=WAIT while still outputting a directional BIAS (bullish or bearish).
- Do NOT set BIAS=neutral just because maturity is unclear or you want to wait.
- Reserve BIAS=neutral ONLY for true chop / balanced auction / no edge conditions.

---
## CONF Semantics (Hard rule)
CONF is confidence in BIAS (directional edge), not confidence in CONTROL (timing).
- You may output CONTROL=WAIT with high CONF if bias is clear but timing is bad.
- If you output BIAS=neutral, CONF must be <= 55. Neutral means no edge.

---
## Neutral Escape Hatch (Restricted)
BIAS=neutral is allowed ONLY when price action is truly balanced/mean-reverting.
If there is a directional drift (higher closes/lower closes) or sustained hold on one side of the recent range,
you MUST choose bullish or bearish bias and express caution via CONTROL=WAIT and/or reduced CONF.

Examples of when you MUST choose directional bias:
- Price making higher highs and higher lows → BIAS=bullish (even if CONF is 60-65)
- Price making lower highs and lower lows → BIAS=bearish (even if CONF is 60-65)
- Price holding above/below key levels (VWAP, EMA, prior close) for multiple bars → BIAS=bullish/bearish
- Clear gap direction with follow-through → BIAS=bullish/bearish

Only choose BIAS=neutral when:
- Price is truly mean-reverting (oscillating around a center)
- Both sides are winning/losing equally
- No sustained directional drift exists

---
## Required Internal Lens (do not output explicitly)
Always evaluate MOVE MATURITY:
- Is the current move early, developing, mature, extended, exhausting, or unclear?
- Has momentum expanded recently, or is it stalling after expansion?
- Is price discovering new value, or revisiting crowded levels?
- Is risk-reward improving or degrading right now?

Maturity influences CONTROL and CONF, but must NOT erase structural bias.

---
## Bias Commitment Rule (non-negotiable)
You MUST choose bullish or bearish bias whenever any of the following are true:
- There is directional structure (HH/HL or LH/LL), OR
- There is clear displacement + follow-through in one direction, OR
- There is a clear gap-and-go / gap-and-fade context, OR
- Price is persistently holding above/below key anchors (e.g., VWAP/EMA zone) across multiple bars.

Only choose BIAS=neutral if:
- Both sides are winning/losing equally (mean-reverting chop),
- Price is trapped in a tight range with no displacement,
- Or signals conflict so strongly that there is no directional favor.

If data is limited early in session:
- Still pick a directional BIAS if evidence exists,
- But reduce CONF and prefer CONTROL=WAIT if entry quality is not ready.

---
## A+ Action Context (Maturity Flip Archetypes)
A+ shorts come from bullish ideas failing late, not from bearish signals:
1) Late Breakout Failure
2) VWAP Reclaim → Immediate Rejection
3) Momentum Divergence at Highs
4) Expansion → Compression → Failure
A+ longs are the mirror image.

---
## Behavioral Guidance (soft, not rules)
- CONTROL=WAIT is valid when bias is clear but entry timing / maturity / RR is not ready.
- Prefer A+ only when maturity flips in your favor and RR improves sharply.
- Do not chase late breakouts.
- Do not anticipate reversals without evidence.
- Confidence should decrease as moves become crowded or extended.

---
## Output Format (STRICT)
You MUST output exactly one line in the following format and nothing else:
CONTROL=<LONG|SHORT|WAIT|A+> | BIAS=<bullish|bearish|neutral> | MATURITY=<early|developing|mature|extended|unclear> | CONF=<0-100>

---
You are judged on alignment with live price behavior, not prediction.

Raw 5m data (60 bars ≈ 5 hours):
${JSON.stringify(llmInput)}`;

    // Build fresh messages array - NO prior context or assistant responses
    // This ensures each call is stateless and bounded in size
    const SYSTEM_PROMPT = "Return JSON only. No markdown."; // Fixed constant system prompt
    const payload = {
      model: this.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
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
    const content = json?.choices?.[0]?.message?.content ?? "";
    
    // Try parsing as control sentence first
    const normalized = this.normalizeArmDecisionRaw5m(content.trim());
    if (normalized) {
      return { decision: normalized, valid: true };
    }
    
    // Fallback: try JSON parsing (backward compatibility)
    try {
      const parsed = JSON.parse(content);
      const normalizedJson = this.normalizeArmDecisionRaw5m(parsed);
      if (!normalizedJson) {
        console.error("[LLM] ArmDecisionRaw5m invalid schema:", content);
        return { decision: { ...fallback, because: "LLM invalid schema" }, valid: false };
      }
      return { decision: normalizedJson, valid: true };
    } catch (err) {
      console.error("[LLM] ArmDecisionRaw5m parse error:", err);
      console.error("[LLM] Raw content:", content);
      return { decision: { ...fallback, because: "LLM parse error" }, valid: false };
    }
  }

  async getPostTradeIntrospection(params: {
    snapshot: MinimalLLMSnapshot;
    action: "ARM_LONG" | "ARM_SHORT" | "WAIT" | "A+";
    entryPrice?: number;
    exitPrice?: number;
    entryTs?: number;
    exitTs?: number;
    outcome: "profit" | "loss" | "breakeven" | "wait_expired";
  }): Promise<PostTradeIntrospection | null> {
    if (!this.enabled) {
      return null;
    }

    const closed5mBars = params.snapshot.closed5mBars.slice(-60).map((bar) => ({
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    }));

    const prompt = `You are reviewing a completed market decision.

You are NOT allowed to suggest trades.
You are NOT allowed to change past actions.

Your task is to reflect on:
- Whether move maturity was assessed correctly
- Whether the chosen action (${params.action}) matched the context
- What early signals mattered most in hindsight
- What signals were misleading

Do NOT output rules.
Do NOT output advice.

Context:
- Action taken: ${params.action}
- Outcome: ${params.outcome}
${params.entryPrice ? `- Entry: ${params.entryPrice}` : ""}
${params.exitPrice ? `- Exit: ${params.exitPrice}` : ""}

Market data:
${JSON.stringify(closed5mBars)}

Summarize in 3 fields:

ASSESSMENT=<aligned|early|late|unclear>
KEY_SIGNAL=<one short phrase>
MISREAD=<none|structure|momentum|participation|context|timing>

Output exactly this format.`;

    // Build fresh messages array - NO prior context or assistant responses
    // LLM calls are stateless by design. No prior context is reused.
    const SYSTEM_PROMPT = "Output exactly the required format. No markdown. No explanation."; // Fixed constant system prompt
    const payload = {
      model: this.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
    };

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        console.error("[LLM] PostTradeIntrospection error:", response.status);
        return null;
      }

      const json = await response.json();
      const content = json?.choices?.[0]?.message?.content ?? "";
      
      const assessmentMatch = content.match(/ASSESSMENT=(aligned|early|late|unclear)/i);
      const keySignalMatch = content.match(/KEY_SIGNAL=(.+?)(?:\s|$)/i);
      const misreadMatch = content.match(/MISREAD=(none|structure|momentum|participation|context|timing)/i);

      if (!assessmentMatch || !keySignalMatch || !misreadMatch) {
        console.error("[LLM] PostTradeIntrospection invalid format:", content);
        return null;
      }

      return {
        assessment: assessmentMatch[1].toLowerCase() as "aligned" | "early" | "late" | "unclear",
        keySignal: keySignalMatch[1].trim(),
        misread: misreadMatch[1].toLowerCase() as "none" | "structure" | "momentum" | "participation" | "context" | "timing",
      };
    } catch (err) {
      console.error("[LLM] PostTradeIntrospection error:", err);
      return null;
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
