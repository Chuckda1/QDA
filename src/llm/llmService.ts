import type { MinimalLLMSnapshot, SnapshotContract } from "../types.js";

export interface IndicatorSnapshot {
  vwap?: number;
  ema9?: number;
  ema20?: number;
  atr?: number;
  rsi14?: number;
  vwapSlope?: "UP" | "DOWN" | "FLAT";
  structure?: "BULLISH" | "BEARISH" | "MIXED";
}

export interface RuleScores {
  tacticalSnapshot?: {
    activeDirection?: "LONG" | "SHORT" | "NEUTRAL";
    confidence?: number;
    reasons?: string[];
    tier?: string;
    indicatorTf?: string;
    confirm?: {
      tf?: string;
      bias?: "LONG" | "SHORT" | "NONE";
      confidence?: number;
      reasons?: string[];
    };
  };
  regime?: "TREND_UP" | "TREND_DOWN" | "CHOP" | "TRANSITION";
  macroBias?: "LONG" | "SHORT" | "NEUTRAL";
  entryPermission?: "ALLOWED" | "WAIT_FOR_PULLBACK" | "BLOCKED";
  potd?: {
    bias: "LONG" | "SHORT" | "NONE";
    confidence: number;
    mode: "OFF" | "PRIOR" | "HARD";
    alignment: "ALIGNED" | "COUNTERTREND" | "UNCONFIRMED" | "OFF";
    confirmed: boolean;
  };
  indicatorMeta?: {
    entryTF: string;
    atrLen: number;
    vwapLen: number;
    emaLens: number[];
    regimeTF: string;
  };
  directionInference?: {
    direction?: "LONG" | "SHORT";
    confidence?: number;
    reasons?: string[];
  };
  entryFilters?: {
    warnings?: string[];
  };
  warnings?: string[];
}

export interface LLMScorecardResponse {
  biasDirection: "LONG" | "SHORT" | "NEUTRAL";
  agreement: number; // 0-100: how much LLM agrees with rules direction
  legitimacy: number; // 0-100
  probability: number; // 0-100: probability of reaching T1
  action: "GO_ALL_IN" | "SCALP" | "WAIT" | "PASS";
  reasoning: string;
  plan: string;
  flags?: string[]; // Optional flags/warnings
  selectedCandidateId?: string;
  rankedCandidateIds?: string[];
}

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
  indicatorSnapshot?: IndicatorSnapshot;
  recentBars?: Array<{ ts: number; open?: number; high: number; low: number; close: number; volume?: number }>;
  ruleScores?: RuleScores;
  snapshot?: SnapshotContract;
  entrySnapshot?: SnapshotContract;
  playContext?: {
    playId: string;
    entryTime?: number;
    remainingSize?: number;
    realizedPnL?: number;
    lastAction?: string;
  };
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
    unrealizedR?: number;
    maxFavorableR?: number;
    maxAdverseR?: number;
    t1Hit?: boolean;
    stopAdjusted?: boolean;
    exhaustionSignals?: string[];
  };
}

export interface LLMCoachingResponse {
  action: "HOLD" | "TAKE_PROFIT" | "TIGHTEN_STOP" | "STOP_OUT" | "SCALE_OUT" | "REDUCE" | "MOVE_TO_BE" | "ADD";
  reasoning: string;
  urgency: "LOW" | "MEDIUM" | "HIGH";
  specificPrice?: number; // if action requires a price
  confidence?: number;
  reasonCodes?: string[];
  riskNotes?: string[];
  proposedStop?: number;
  proposedPartialPct?: number;
  nextCheck?: string;
}

export interface ArmedCoachingContext {
  symbol: string;
  direction: "LONG" | "SHORT";
  entryZone: { low: number; high: number };
  currentPrice: number;
  stop: number;
  targets: { t1: number; t2: number; t3: number };
  score: number;
  grade: string;
  confidence: number;
  legitimacy?: number;
  followThroughProb?: number;
  action?: "GO_ALL_IN" | "SCALP" | "WAIT" | "PASS";
  timeSinceArmed?: number; // minutes since play was armed
  indicatorSnapshot?: IndicatorSnapshot;
  recentBars?: Array<{ ts: number; open?: number; high: number; low: number; close: number; volume?: number }>;
  ruleScores?: RuleScores;
}

export interface ArmedCoachingResponse {
  commentary: string; // Commentary on setup quality and entry timing
  entryReadiness: "WAIT" | "READY" | "CAUTION"; // Entry readiness assessment
  reasoning: string;
  urgency: "LOW" | "MEDIUM" | "HIGH";
}

export interface MinimalMindStateResponse {
  mindId?: string;
  direction: "long" | "short" | "none";
  confidence: number;
  reason: string;
}

export type MinimalMindStateResult = {
  mindState: MinimalMindStateResponse;
  valid: boolean;
};

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

  private normalizeMinimalMindState(input: any): MinimalMindStateResponse | null {
    if (!input || typeof input !== "object") return null;
    const mindId = typeof input.mindId === "string" ? input.mindId : undefined;
    const directionRaw = typeof input.direction === "string" ? input.direction.toLowerCase() : "";
    const direction =
      directionRaw === "long" || directionRaw === "short" || directionRaw === "none"
        ? directionRaw
        : "none";
    const confidence = Number.isFinite(input.confidence) ? Number(input.confidence) : NaN;
    const reason = typeof input.reason === "string" ? input.reason : "";
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100 || !reason) {
      return null;
    }
    return {
      mindId,
      reason,
      direction,
      confidence,
    };
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
    warnings?: string[]; // Filter warnings that should inform probability/legitimacy
    indicatorSnapshot?: IndicatorSnapshot;
    recentBars?: Array<{ ts: number; open?: number; high: number; low: number; close: number; volume?: number }>;
    ruleScores?: RuleScores;
    setupCandidate?: import("../types.js").SetupCandidate;
    candidates?: Array<import("../types.js").SetupCandidate>;
  }): Promise<LLMScorecardResponse & { followThroughProb: number }> {
    // STAGE 1: Return fallback if LLM not enabled
    if (!this.enabled) {
      return {
        biasDirection: "NEUTRAL",
        agreement: 50,
        legitimacy: 70,
        probability: 60,
        followThroughProb: 60,
        action: "SCALP",
        reasoning: "LLM disabled: missing OPENAI_API_KEY. Using default values.",
        plan: "Enter on pullback to entry zone. Tight stop. Target T1.",
        flags: []
      };
    }
    const { symbol, direction, entryZone, stop, targets, score, grade, confidence, currentPrice, warnings, indicatorSnapshot, recentBars, ruleScores, setupCandidate, candidates } = context;
    const volume = setupCandidate?.featureBundle?.volume;
    const relVol = volume?.relVolume;
    const volumeFlags = Array.from(
      new Set(
        [
          ...(setupCandidate?.warningFlags ?? []),
          ...(setupCandidate?.flags ?? [])
        ].filter((flag) => ["LOW_VOL", "THIN_TAPE", "VOL_SPIKE", "CLIMAX_VOL"].includes(flag))
      )
    );
    const volumeLine = `- Volume: relVol=${relVol !== undefined ? relVol.toFixed(2) : "n/a"}${
      volumeFlags.length ? ` (${volumeFlags.join(", ")})` : ""
    }`;
    
    // Calculate risk/reward for LLM
    const entryMid = (entryZone.low + entryZone.high) / 2;
    const risk = Math.abs(entryMid - stop);
    const rewardT1 = direction === "LONG" ? targets.t1 - entryMid : entryMid - targets.t1;
    const rrT1 = risk > 0 ? rewardT1 / risk : 0;
    
    // Build warnings section if present
    const warningsSection = warnings && warnings.length > 0
      ? `\n\n⚠️ FILTER WARNINGS (Consider these when assessing probability/legitimacy):\n${warnings.map(w => `- ${w}`).join("\n")}`
      : "";

    // Build JSON snapshot for LLM
    const snapshotJson = JSON.stringify({
      recentBars: (recentBars ?? []).slice(-20).map(b => ({ 
        ts: b.ts, 
        o: b.open, 
        h: b.high, 
        l: b.low, 
        c: b.close, 
        v: b.volume 
      })),
      indicators: indicatorSnapshot ?? null,
      ruleScores: ruleScores ?? null,
      setupCandidate: setupCandidate ?? null,
      candidates: candidates ?? null
    }, null, 2);
    
    const prompt = `You are creating a SCORECARD for a new ${direction} trading setup on ${symbol}.

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
${volumeLine}${warningsSection}

MARKET SNAPSHOT + RULE OUTPUTS (JSON):
\`\`\`json
${snapshotJson}
\`\`\`

YOUR TASK:
Step 1) Determine biasDirection from the Tactical Snapshot (ruleScores.tacticalSnapshot). This is the authoritative direction signal for the system. If it is NEUTRAL, you may keep biasDirection=NEUTRAL.

Step 2) Use ruleScores.regime and ruleScores.macroBias as CONTEXT ONLY. They must not veto direction or suppress candidates.

Step 3) Compute agreement (0-100): how aligned your bias is with the Tactical Snapshot.

Step 3b) Validate the setupCandidate: do the proposed levels/pattern make sense given the snapshot? You MUST set action=PASS if invalid.
  - If intent is FADE (countertrend), be STRICT: default to WAIT or PASS unless the snapshot clearly shows a reversal trigger.

Step 4) Assess legitimacy (0-100): How valid is this setup overall? Consider all factors: indicators, structure, context, warnings.

Step 5) Assess probability (0-100): Likelihood price reaches T1? Use the indicators and recent price action to inform this.

Step 5b) Volume rule (mandatory):
  - If relVol < 0.70, never output probability=100. Cap probability <= 85.
  - If relVol < 0.45 (THIN_TAPE), cap probability <= 70.
  - If CLIMAX_VOL and structure is not aligned, cap probability <= 90.
  - Only allow probability=100 when relVol >= 0.90 OR VOL_SPIKE confirms impulse direction.

Step 6) Recommend action: GO_ALL_IN | SCALP | WAIT | PASS
  - If the best candidate is counter to the Tactical Snapshot, prefer WAIT/PASS and call it out explicitly.

Step 7) Provide reasoning (2-3 sentences): Explain your biasDirection, agreement level, and action choice. If you disagree with the proposed direction, say so explicitly.

Step 8) Create a trade plan (entry strategy, position sizing, exit strategy)

Step 9) Optional flags: List any warnings or concerns (e.g., ["high RSI", "countertrend risk"])

If multiple candidates are provided in the snapshot, rank them and select the best. Prefer candidates aligned with the Tactical Snapshot. Use:
- selectedCandidateId: the chosen candidate id
- rankedCandidateIds: ordered list best → worst

Respond in EXACT JSON format:
{
  "biasDirection": "LONG|SHORT|NEUTRAL",
  "agreement": 0-100,
  "legitimacy": 0-100,
  "probability": 0-100,
  "action": "GO_ALL_IN|SCALP|WAIT|PASS",
  "reasoning": "Brief explanation",
  "plan": "Entry strategy, position size, exit strategy",
  "flags": ["flag1", "flag2"] or [],
  "selectedCandidateId": "candidate_id_or_null",
  "rankedCandidateIds": ["id1","id2", "..."] or []
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
          // Map probability to followThroughProb for backward compatibility
          let probability = parsed.probability ?? parsed.followThroughProb ?? 60;
          let followThroughProb = parsed.followThroughProb ?? probability;
          const allowHundred =
            relVol === undefined ? true : relVol >= 0.9 || volumeFlags.includes("VOL_SPIKE");
          const structure = indicatorSnapshot?.structure;
          const structureAligned =
            (direction === "LONG" && structure === "BULLISH") || (direction === "SHORT" && structure === "BEARISH");
          const maxProb =
            relVol !== undefined && relVol < 0.45
              ? 70
              : relVol !== undefined && relVol < 0.7
              ? 85
              : volumeFlags.includes("CLIMAX_VOL") && !structureAligned
              ? 90
              : undefined;
          if (maxProb !== undefined) {
            probability = Math.min(probability, maxProb);
            followThroughProb = Math.min(followThroughProb, maxProb);
          } else if (!allowHundred) {
            if (probability >= 100) probability = 95;
            if (followThroughProb >= 100) followThroughProb = 95;
          }
          return {
            biasDirection: parsed.biasDirection || "NEUTRAL",
            agreement: Math.max(0, Math.min(100, parsed.agreement ?? 50)),
            legitimacy: Math.max(0, Math.min(100, parsed.legitimacy || 70)),
            probability: Math.max(0, Math.min(100, probability)),
            followThroughProb: Math.max(0, Math.min(100, followThroughProb)), // Backward compatibility
            action: parsed.action || "SCALP",
            reasoning: parsed.reasoning || "Setup analyzed",
            plan: parsed.plan || "Enter on pullback to entry zone. Tight stop. Target T1.",
            flags: Array.isArray(parsed.flags) ? parsed.flags : [],
            selectedCandidateId: typeof parsed.selectedCandidateId === "string" ? parsed.selectedCandidateId : undefined,
            rankedCandidateIds: Array.isArray(parsed.rankedCandidateIds) ? parsed.rankedCandidateIds.filter((id: any) => typeof id === "string") : []
          };
        } catch (e) {
          console.error("[LLM] Failed to parse JSON response:", e);
        }
      }
      
      // Fallback
      return {
        biasDirection: "NEUTRAL",
        agreement: 50,
        legitimacy: 70,
        probability: 60,
        followThroughProb: 60,
        action: "SCALP",
        reasoning: "Setup analyzed with moderate confidence",
        plan: "Enter on pullback to entry zone. Tight stop. Target T1.",
        flags: []
      };
    } catch (error: any) {
      console.error(`[LLM] Verification error:`, error.message);
      // Fallback response
      return {
        biasDirection: "NEUTRAL",
        agreement: 50,
        legitimacy: 70,
        probability: 60,
        followThroughProb: 60,
        action: "SCALP",
        reasoning: `Error calling LLM: ${error.message}. Using default values.`,
        plan: "Enter on pullback to entry zone. Tight stop. Target T1.",
        flags: []
      };
    }
  }

  /**
   * Get coaching for ARMED play (before entry)
   * Provides commentary on setup quality and entry timing without pretending we're in a position
   */
  async getArmedCoaching(context: ArmedCoachingContext): Promise<ArmedCoachingResponse> {
    // Return fallback if LLM not enabled
    if (!this.enabled) {
      return {
        commentary: "LLM disabled: missing OPENAI_API_KEY. Setup looks reasonable.",
        entryReadiness: "READY",
        reasoning: "LLM not available - using default assessment",
        urgency: "LOW"
      };
    }

    const { symbol, direction, entryZone, currentPrice, stop, targets, score, grade, confidence, legitimacy, followThroughProb, action, timeSinceArmed } = context;
    
    // Calculate distances for context
    const entryMid = (entryZone.low + entryZone.high) / 2;
    const distanceToEntryZone = currentPrice < entryZone.low 
      ? entryZone.low - currentPrice 
      : currentPrice > entryZone.high 
      ? currentPrice - entryZone.high 
      : 0;
    const inEntryZone = currentPrice >= entryZone.low && currentPrice <= entryZone.high;
    
    const risk = Math.abs(entryMid - stop);
    const rewardT1 = direction === "LONG" ? targets.t1 - entryMid : entryMid - targets.t1;
    const rrT1 = risk > 0 ? rewardT1 / risk : 0;

    const prompt = `You are analyzing a ${direction} trading setup on ${symbol} that is ARMED but NOT YET ENTERED.

SETUP DETAILS:
- Score: ${score} (Grade: ${grade})
- Confidence: ${confidence}%
- Legitimacy: ${legitimacy ?? "N/A"}%
- Follow-through probability: ${followThroughProb ?? "N/A"}%
- Recommended action: ${action ?? "N/A"}
- Entry Zone: $${entryZone.low.toFixed(2)} - $${entryZone.high.toFixed(2)}
- Current Price: $${currentPrice.toFixed(2)}
- Stop: $${stop.toFixed(2)}
- Targets: T1=$${targets.t1.toFixed(2)}, T2=$${targets.t2.toFixed(2)}, T3=$${targets.t3.toFixed(2)}
- Risk: $${risk.toFixed(2)} per share
- Reward to T1: $${rewardT1.toFixed(2)} per share
- R-multiple to T1: ${rrT1.toFixed(2)}R
- Time since armed: ${timeSinceArmed ?? 0} minutes
- Price position: ${inEntryZone ? "IN entry zone" : currentPrice < entryZone.low ? `${distanceToEntryZone.toFixed(2)} below entry zone` : `${distanceToEntryZone.toFixed(2)} above entry zone`}

YOUR TASK (You are NOT in a position yet - this is pre-entry coaching):
0. If direction looks wrong for current conditions, explicitly call it out (e.g., "market favors SHORT") and set entryReadiness to WAIT or CAUTION.
1. Provide commentary on setup quality and current market conditions
2. Assess entry readiness: WAIT | READY | CAUTION
3. Provide brief reasoning (2-3 sentences)
4. Assess urgency: LOW | MEDIUM | HIGH

Respond in EXACT JSON format:
{
  "commentary": "Your commentary on the setup and market conditions",
  "entryReadiness": "WAIT|READY|CAUTION",
  "reasoning": "Brief explanation of your assessment",
  "urgency": "LOW|MEDIUM|HIGH"
}`;

    try {
      console.log(`[LLM] Calling OpenAI API for ARMED coaching: ${symbol} ${direction}`);
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
              content: `You are a professional day trading coach. You provide pre-entry commentary on trading setups. You are NOT managing a position - you are assessing whether to enter.`
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
      console.log(`[LLM] ARMED coaching call successful (${duration}ms)`);
      
      // Parse JSON response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          return {
            commentary: parsed.commentary || "Setup looks reasonable",
            entryReadiness: parsed.entryReadiness || "READY",
            reasoning: parsed.reasoning || "No reasoning provided",
            urgency: parsed.urgency || "LOW"
          };
        } catch (e) {
          console.error("[LLM] Failed to parse ARMED coaching JSON:", e);
        }
      }
      
      // Fallback
      return {
        commentary: "Setup analyzed. Waiting for entry signal.",
        entryReadiness: "READY",
        reasoning: "Setup looks reasonable based on available data",
        urgency: "LOW"
      };
    } catch (error: any) {
      console.error(`[LLM] ARMED coaching error:`, error.message);
      return {
        commentary: "Setup analyzed with moderate confidence",
        entryReadiness: "READY",
        reasoning: `Error calling LLM: ${error.message}. Using default assessment.`,
        urgency: "LOW"
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
    const { symbol, direction, entryPrice, currentPrice, stop, targets, timeInTrade, priceAction, rulesContext, snapshot, entrySnapshot, playContext } = context;
    
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
      profitPercent: Number(rulesContext.profitPercent.toFixed(2)), // if entered
      unrealizedR: rulesContext.unrealizedR !== undefined ? Number(rulesContext.unrealizedR.toFixed(2)) : undefined,
      maxFavorableR: rulesContext.maxFavorableR !== undefined ? Number(rulesContext.maxFavorableR.toFixed(2)) : undefined,
      maxAdverseR: rulesContext.maxAdverseR !== undefined ? Number(rulesContext.maxAdverseR.toFixed(2)) : undefined,
      t1Hit: rulesContext.t1Hit ?? false,
      stopAdjusted: rulesContext.stopAdjusted ?? false,
      exhaustionSignals: rulesContext.exhaustionSignals ?? []
    }, null, 2);

    const entrySnapshotJson = entrySnapshot ? JSON.stringify(entrySnapshot, null, 2) : undefined;
    const snapshotJson = snapshot ? JSON.stringify(snapshot, null, 2) : undefined;
    const playContextJson = playContext ? JSON.stringify(playContext, null, 2) : undefined;

    let prompt = `You are coaching a ${direction} trade on ${symbol}.

CRITICAL: All numbers below are computed deterministically in code. You MUST NOT calculate any metrics yourself - use the provided exact values. Do not recalculate risk, reward, R-multiples, or distances.

TRADE CONTEXT:
- Symbol: ${symbol}
- Direction: ${direction}
- Time in trade: ${timeInTrade || 0} minutes
- Price action: ${priceAction || "Monitoring"}
${playContextJson ? `\nPLAY CONTEXT:\n\`\`\`json\n${playContextJson}\n\`\`\`` : ""}
${entrySnapshotJson ? `\nENTRY SNAPSHOT (selector contract at entry):\n\`\`\`json\n${entrySnapshotJson}\n\`\`\`` : ""}
${snapshotJson ? `\nCURRENT SNAPSHOT (latest contract):\n\`\`\`json\n${snapshotJson}\n\`\`\`` : ""}

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
7. If exhaustionSignals are present, treat them as exit warnings

CONSTRAINTS:
- You manage ONLY the active play. Do not select a different candidate.
- Do NOT flip direction.
- Do NOT override hard risk rules or hard stop on close.

COACHING REQUEST:
Analyze this trade using the provided metrics and snapshots. Your decision is FINAL - if you say HOLD, we hold (unless hard stop on close).
If the tape is clearly moving against the trade direction (e.g., repeated lower closes for LONG), you should say so explicitly and consider STOP_OUT or TIGHTEN_STOP with HIGH urgency.
Should the trader:
1. HOLD - continue holding (your decision is final)
2. TAKE_PROFIT - take profit now (specify which target or partial)
3. TIGHTEN_STOP - move stop to breakeven or better
4. STOP_OUT - exit immediately (you see risk)
5. SCALE_OUT - take partial profit
6. REDUCE - reduce size
7. MOVE_TO_BE - move stop to breakeven
8. ADD - add only if already in profit and risk allows (rare)

Respond in this EXACT JSON format:
{
  "action": "HOLD|TAKE_PROFIT|TIGHTEN_STOP|STOP_OUT|SCALE_OUT|REDUCE|MOVE_TO_BE|ADD",
  "confidence": 0-100,
  "reasonCodes": ["VWAP_RECLAIM","TIMING_WEAKEN","TARGET_TAG","REGIME_FLIP"],
  "riskNotes": ["..."],
  "proposedStop": null or number,
  "proposedPartialPct": null or number,
  "nextCheck": "ON_T1|ON_VWAP_LOSS|IN_10M",
  "reasoning": "Brief explanation using the provided metrics (2-3 sentences max)",
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
          specificPrice: parsed.specificPrice || undefined,
          confidence: typeof parsed.confidence === "number" ? parsed.confidence : undefined,
          reasonCodes: Array.isArray(parsed.reasonCodes) ? parsed.reasonCodes : undefined,
          riskNotes: Array.isArray(parsed.riskNotes) ? parsed.riskNotes : undefined,
          proposedStop: typeof parsed.proposedStop === "number" ? parsed.proposedStop : undefined,
          proposedPartialPct: typeof parsed.proposedPartialPct === "number" ? parsed.proposedPartialPct : undefined,
          nextCheck: typeof parsed.nextCheck === "string" ? parsed.nextCheck : undefined
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

  async getMinimalMindState(snapshot: MinimalLLMSnapshot): Promise<MinimalMindStateResult> {
    const fallback: MinimalMindStateResponse = {
      mindId: undefined,
      direction: "none",
      confidence: 0,
      reason: "LLM unavailable",
    };
    if (!this.enabled) {
      return { mindState: fallback, valid: false };
    }
    const closed5mBars = snapshot.closed5mBars.map(
      (bar: { open: number; high: number; low: number; close: number; volume: number }) => ({
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      })
    );
    const forming5mBar = snapshot.forming5mBar
      ? {
          open: snapshot.forming5mBar.open,
          high: snapshot.forming5mBar.high,
          low: snapshot.forming5mBar.low,
          close: snapshot.forming5mBar.close,
          volume: snapshot.forming5mBar.volume,
        }
      : null;
    const recent1mBars = snapshot.recent1mBars?.length
      ? snapshot.recent1mBars.slice(-10).map((bar) => ({
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
        }))
      : undefined;
    const llmInput = {
      closed5mBars,
      forming5mBar,
      ...(recent1mBars ? { recent1mBars } : {}),
    };
    const prompt = `You are a trading assistant.
You receive only recent OHLCV bars.
Your job is to infer short-term directional bias from price action alone.

Return JSON only:
{
  "direction": "long|short|none",
  "confidence": 0,
  "reason": "brief reason referencing price behavior"
}

Rules:
- All fields above are REQUIRED in every response.
- Do NOT classify structure or label ranges.
- Do NOT suggest entries, targets, or stops.
- Do NOT invent indicators.
- If direction is unclear, return "none".

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
      console.error(`[LLM] MindState error (${duration}ms):`, response.status, error);
      return { mindState: { ...fallback, reason: "LLM error" }, valid: false };
    }
    const json = await response.json();
    const content = json?.choices?.[0]?.message?.content ?? "{}";
    try {
      const parsed = JSON.parse(content);
      const normalized = this.normalizeMinimalMindState(parsed);
      if (!normalized) {
        console.error("[LLM] MindState invalid schema:", content);
        return { mindState: { ...fallback, reason: "LLM invalid schema" }, valid: false };
      }
      return { mindState: normalized, valid: true };
    } catch (err) {
      console.error("[LLM] MindState parse error:", err);
      return { mindState: { ...fallback, reason: "LLM parse error" }, valid: false };
    }
  }
}
