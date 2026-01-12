export interface LLMCoachingContext {
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  currentPrice: number;
  stop: number;
  targets: { t1: number; t2: number; t3: number };
  positionSize?: string;
  unrealizedPnL?: number;
  timeInTrade?: number; // minutes
  priceAction?: string; // brief description of recent price action
  rulesContext?: {
    distanceToStop: number;
    distanceToStopDollars: number;
    distanceToT1: number;
    distanceToT1Dollars: number;
    distanceToT2: number;
    distanceToT2Dollars: number;
    distanceToT3: number;
    distanceToT3Dollars: number;
    stopThreatened: boolean;
    nearTarget: "T1" | "T2" | "T3" | null;
    targetHit: "T1" | "T2" | "T3" | null;
    risk: number; // |entry - stop| per share
    rewardT1: number; // reward to T1 per share
    rewardT2: number; // reward to T2 per share
    rewardT3: number; // reward to T3 per share
    rMultipleT1: number; // R-multiple to T1
    rMultipleT2: number; // R-multiple to T2
    rMultipleT3: number; // R-multiple to T3
    profitPercent: number;
  };
}

export interface LLMCoachingResponse {
  action: "HOLD" | "TAKE_PROFIT" | "TIGHTEN_STOP" | "STOP_OUT" | "SCALE_OUT";
  reasoning: string;
  urgency: "LOW" | "MEDIUM" | "HIGH";
  specificPrice?: number; // if action requires a price
}

export class LLMService {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private enabled: boolean;

  constructor() {
    // STAGE 1: Standardize to OPENAI_API_KEY only
    // Trim whitespace in case Railway adds it
    const rawKey = process.env.OPENAI_API_KEY || "";
    this.apiKey = rawKey.trim();
    this.baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    this.model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    this.enabled = !!this.apiKey;
    
    // Debug logging
    if (rawKey && !this.apiKey) {
      console.warn("[LLMService] OPENAI_API_KEY found but empty after trimming");
    } else if (!rawKey) {
      console.warn("[LLMService] OPENAI_API_KEY not found in environment");
    } else {
      console.log(`[LLMService] OPENAI_API_KEY found (length: ${this.apiKey.length}, starts with: ${this.apiKey.substring(0, 7)}...)`);
    }
  }

  /**
   * Check if LLM service is enabled (has API key)
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Verify a new play setup and create trade plan
   * Called when a new play is detected (before entry)
   */
  async verifyPlaySetup(context: {
    symbol: string;
    direction: "LONG" | "SHORT";
    entryZone: { low: number; high: number };
    stop: number;
    targets: { t1: number; t2: number; t3: number };
    score: number;
    grade: string;
    confidence: number;
    currentPrice: number;
  }): Promise<{
    legitimacy: number; // 0-100
    followThroughProb: number; // 0-100
    action: "GO_ALL_IN" | "SCALP" | "WAIT" | "PASS";
    reasoning: string;
    plan: string;
  }> {
    // STAGE 1: Return fallback if LLM not enabled
    if (!this.enabled) {
      return {
        legitimacy: 70,
        followThroughProb: 60,
        action: "SCALP",
        reasoning: "LLM disabled: missing OPENAI_API_KEY. Using default values.",
        plan: "Enter on pullback to entry zone. Tight stop. Target T1."
      };
    }
    const { symbol, direction, entryZone, stop, targets, score, grade, confidence, currentPrice } = context;
    
    // Calculate risk/reward for LLM
    const entryMid = (entryZone.low + entryZone.high) / 2;
    const risk = Math.abs(entryMid - stop);
    const rewardT1 = direction === "LONG" ? targets.t1 - entryMid : entryMid - targets.t1;
    const rrT1 = risk > 0 ? rewardT1 / risk : 0;
    
    const prompt = `You are analyzing a new ${direction} trading setup on ${symbol}.

SETUP DETAILS:
- Score: ${score} (Grade: ${grade})
- Confidence: ${confidence}%
- Entry Zone: $${entryZone.low.toFixed(2)} - $${entryZone.high.toFixed(2)}
- Stop: $${stop.toFixed(2)}
- Targets: T1=$${targets.t1.toFixed(2)}, T2=$${targets.t2.toFixed(2)}, T3=$${targets.t3.toFixed(2)}
- Current Price: $${currentPrice.toFixed(2)}
- Risk: $${risk.toFixed(2)} per share
- Reward to T1: $${rewardT1.toFixed(2)} per share
- R-multiple to T1: ${rrT1.toFixed(2)}R

YOUR TASK:
1. Assess legitimacy (0-100): How valid is this setup?
2. Assess follow-through probability (0-100): Likelihood price reaches T1?
3. Recommend action: GO_ALL_IN | SCALP | WAIT | PASS
4. Provide brief reasoning (2-3 sentences)
5. Create a trade plan (entry strategy, position sizing, exit strategy)

Respond in EXACT JSON format:
{
  "legitimacy": 0-100,
  "followThroughProb": 0-100,
  "action": "GO_ALL_IN|SCALP|WAIT|PASS",
  "reasoning": "Brief explanation",
  "plan": "Entry strategy, position size, exit strategy"
}`;

    try {
      console.log(`[LLM] Calling OpenAI API for play verification: ${symbol} ${direction}`);
      const startTime = Date.now();
      
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: "system",
              content: `You are a professional day trading analyst. Analyze trading setups and provide clear, actionable recommendations.`
            },
            {
              role: "user",
              content: prompt
            }
          ],
          temperature: 0.7,
          max_tokens: 400
        })
      });

      const duration = Date.now() - startTime;

      if (!response.ok) {
        const error = await response.text();
        console.error(`[LLM] API error (${duration}ms):`, response.status, error);
        throw new Error(`OpenAI API error: ${response.status} - ${error}`);
      }

      const data = await response.json();
      const content = data.choices[0]?.message?.content || "";
      console.log(`[LLM] API call successful (${duration}ms): ${content.substring(0, 100)}...`);
      
      // Parse response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          return {
            legitimacy: Math.max(0, Math.min(100, parsed.legitimacy || 70)),
            followThroughProb: Math.max(0, Math.min(100, parsed.followThroughProb || 60)),
            action: parsed.action || "SCALP",
            reasoning: parsed.reasoning || "Setup analyzed",
            plan: parsed.plan || "Enter on pullback to entry zone. Tight stop. Target T1."
          };
        } catch (e) {
          console.error("[LLM] Failed to parse JSON response:", e);
        }
      }
      
      // Fallback
      return {
        legitimacy: 70,
        followThroughProb: 60,
        action: "SCALP",
        reasoning: "Setup analyzed with moderate confidence",
        plan: "Enter on pullback to entry zone. Tight stop. Target T1."
      };
    } catch (error: any) {
      console.error(`[LLM] Verification error:`, error.message);
      // Fallback response
      return {
        legitimacy: 70,
        followThroughProb: 60,
        action: "SCALP",
        reasoning: `Error calling LLM: ${error.message}. Using default values.`,
        plan: "Enter on pullback to entry zone. Tight stop. Target T1."
      };
    }
  }

  async getCoachingUpdate(context: LLMCoachingContext): Promise<LLMCoachingResponse> {
    // STAGE 1: Return fallback if LLM not enabled
    if (!this.enabled) {
      return {
        action: "HOLD",
        reasoning: "LLM disabled: missing OPENAI_API_KEY. Defaulting to HOLD.",
        urgency: "LOW"
      };
    }
    
    const prompt = this.buildCoachingPrompt(context);
    
    try {
      console.log(`[LLM] Calling OpenAI API for coaching update: ${context.symbol} ${context.direction}`);
      const startTime = Date.now();
      
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: "system",
              content: `You are a professional day trading coach. Your job is to provide clear, actionable coaching on when to take profit and when to exit trades. Be decisive and specific.`
            },
            {
              role: "user",
              content: prompt
            }
          ],
          temperature: 0.7,
          max_tokens: 300
        })
      });

      const duration = Date.now() - startTime;

      if (!response.ok) {
        const error = await response.text();
        console.error(`[LLM] API error (${duration}ms):`, response.status, error);
        throw new Error(`OpenAI API error: ${response.status} - ${error}`);
      }

      const data = await response.json();
      const content = data.choices[0]?.message?.content || "";
      console.log(`[LLM] API call successful (${duration}ms): action=${this.parseLLMResponse(content, context).action}`);
      
      return this.parseLLMResponse(content, context);
    } catch (error: any) {
      console.error(`[LLM] Coaching error:`, error.message);
      // Fallback response
      return {
        action: "HOLD",
        reasoning: `Error calling LLM: ${error.message}. Defaulting to HOLD.`,
        urgency: "LOW"
      };
    }
  }

  /**
   * STAGE 1: Test LLM connection with simple prompt
   */
  async testConnection(): Promise<{ success: boolean; latency: number; error?: string }> {
    if (!this.enabled) {
      return {
        success: false,
        latency: 0,
        error: "LLM disabled: missing OPENAI_API_KEY"
      };
    }

    const startTime = Date.now();
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: "user",
              content: "reply with OK"
            }
          ],
          temperature: 0.7,
          max_tokens: 10
        })
      });

      const latency = Date.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text();
        // Sanitize error (remove API key if accidentally included)
        const sanitized = errorText.replace(/sk-[a-zA-Z0-9]+/g, "sk-***");
        return {
          success: false,
          latency,
          error: `HTTP ${response.status}: ${sanitized.substring(0, 200)}`
        };
      }

      const data = await response.json();
      const content = data.choices[0]?.message?.content || "";
      
      return {
        success: true,
        latency
      };
    } catch (error: any) {
      const latency = Date.now() - startTime;
      // Sanitize error message
      const errorMsg = error.message || String(error);
      const sanitized = errorMsg.replace(/sk-[a-zA-Z0-9]+/g, "sk-***");
      
      return {
        success: false,
        latency,
        error: sanitized.substring(0, 200)
      };
    }
  }

  private buildCoachingPrompt(context: LLMCoachingContext): string {
    const { symbol, direction, entryPrice, currentPrice, stop, targets, timeInTrade, priceAction, rulesContext } = context;
    
    // All numbers MUST be computed in code - LLM never calculates
    if (!rulesContext) {
      throw new Error("rulesContext is required - all metrics must be computed deterministically in code");
    }

    // Build structured JSON object with all computed metrics
    // This ensures LLM receives real tangible numbers, not vague descriptions
    const metricsJson = JSON.stringify({
      // Raw inputs (for reference only)
      close: Number(currentPrice.toFixed(2)),
      entry: Number(entryPrice.toFixed(2)),
      stop: Number(stop.toFixed(2)),
      t1: Number(targets.t1.toFixed(2)),
      t2: Number(targets.t2.toFixed(2)),
      t3: Number(targets.t3.toFixed(2)),
      
      // Computed metrics (deterministic, no LLM calculation)
      risk: Number(rulesContext.risk.toFixed(2)), // |entry - stop| per share
      rewardT1: Number(rulesContext.rewardT1.toFixed(2)), // reward to T1 per share
      rewardT2: Number(rulesContext.rewardT2.toFixed(2)), // reward to T2 per share
      rewardT3: Number(rulesContext.rewardT3.toFixed(2)), // reward to T3 per share
      rr_t1: Number(rulesContext.rMultipleT1.toFixed(2)), // R-multiple to T1
      rr_t2: Number(rulesContext.rMultipleT2.toFixed(2)), // R-multiple to T2
      rr_t3: Number(rulesContext.rMultipleT3.toFixed(2)), // R-multiple to T3
      
      // Distance metrics (dollar and percent)
      distanceToStopDollar: Number(rulesContext.distanceToStopDollars.toFixed(2)),
      distanceToStopPct: Number(rulesContext.distanceToStop.toFixed(2)),
      distanceToT1Dollar: Number(rulesContext.distanceToT1Dollars.toFixed(2)),
      distanceToT1Pct: Number(rulesContext.distanceToT1.toFixed(2)),
      distanceToT2Dollar: Number(rulesContext.distanceToT2Dollars.toFixed(2)),
      distanceToT2Pct: Number(rulesContext.distanceToT2.toFixed(2)),
      distanceToT3Dollar: Number(rulesContext.distanceToT3Dollars.toFixed(2)),
      distanceToT3Pct: Number(rulesContext.distanceToT3.toFixed(2)),
      
      // Status booleans (computed in code)
      stopThreatened: rulesContext.stopThreatened, // within 0.25R of stop (warning only)
      targetHit: rulesContext.targetHit, // close-based target hit
      nearTarget: rulesContext.nearTarget, // within $0.03 of target
      profitPercent: Number(rulesContext.profitPercent.toFixed(2)) // if entered
    }, null, 2);

    let prompt = `You are coaching a ${direction} trade on ${symbol}.

CRITICAL: All numbers below are computed deterministically in code. You MUST NOT calculate any metrics yourself - use the provided exact values. Do not recalculate risk, reward, R-multiples, or distances.

TRADE CONTEXT:
- Symbol: ${symbol}
- Direction: ${direction}
- Time in trade: ${timeInTrade || 0} minutes
- Price action: ${priceAction || "Monitoring"}

COMPUTED METRICS (use these exact values - do not recalculate):
\`\`\`json
${metricsJson}
\`\`\`

RULES (for your reasoning):
1. Stop loss triggers ONLY on candle close (not wicks)
   - LONG: if close <= stop → exit (hard rule, bypasses LLM)
   - SHORT: if close >= stop → exit (hard rule, bypasses LLM)
2. Stop threatened is a WARNING only (within 0.25R of stop) - not an exit trigger
3. Target hit is close-based (close >= T1 for LONG, close <= T1 for SHORT)
4. All distances use close price as denominator for percentages
5. Risk = |entry - stop|, Reward = T1 - entry (LONG) or entry - T1 (SHORT)
6. R-multiple = Reward / Risk

COACHING REQUEST:
Analyze this trade using the provided metrics for pattern analysis and probability calculations. Your decision is FINAL - if you say HOLD, we hold (unless hard stop on close). Should the trader:
1. HOLD - continue holding (your decision is final)
2. TAKE_PROFIT - take profit now (specify which target or partial)
3. TIGHTEN_STOP - move stop to breakeven or better
4. STOP_OUT - exit immediately (you see risk)
5. SCALE_OUT - take partial profit

Respond in this EXACT JSON format:
{
  "action": "HOLD|TAKE_PROFIT|TIGHTEN_STOP|STOP_OUT|SCALE_OUT",
  "reasoning": "Brief explanation using the provided metrics for pattern analysis and probability reasoning (2-3 sentences max)",
  "urgency": "LOW|MEDIUM|HIGH",
  "specificPrice": null or number (if action requires a price)
}`;

    return prompt;
  }

  private parseLLMResponse(content: string, context: LLMCoachingContext): LLMCoachingResponse {
    // Try to extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          action: parsed.action || "HOLD",
          reasoning: parsed.reasoning || "No reasoning provided",
          urgency: parsed.urgency || "LOW",
          specificPrice: parsed.specificPrice || undefined
        };
      } catch (e) {
        // Fall through to text parsing
      }
    }

    // Fallback: parse from text
    const upperContent = content.toUpperCase();
    let action: LLMCoachingResponse["action"] = "HOLD";
    let urgency: LLMCoachingResponse["urgency"] = "LOW";

    if (upperContent.includes("TAKE PROFIT") || upperContent.includes("TAKE_PROFIT")) {
      action = "TAKE_PROFIT";
      urgency = upperContent.includes("NOW") || upperContent.includes("IMMEDIATELY") ? "HIGH" : "MEDIUM";
    } else if (upperContent.includes("STOP OUT") || upperContent.includes("STOP_OUT") || upperContent.includes("EXIT NOW")) {
      action = "STOP_OUT";
      urgency = "HIGH";
    } else if (upperContent.includes("TIGHTEN") || upperContent.includes("BREAKEVEN")) {
      action = "TIGHTEN_STOP";
      urgency = "MEDIUM";
    } else if (upperContent.includes("SCALE") || upperContent.includes("PARTIAL")) {
      action = "SCALE_OUT";
      urgency = "MEDIUM";
    }

    return {
      action,
      reasoning: content.substring(0, 200),
      urgency
    };
  }
}
