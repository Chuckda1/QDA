# LLM Coaching Test Script

This script tests real LLM API calls with fake trading scenarios to verify the LLM can properly coach profit-taking and stop-out decisions.

## Setup

1. **Install dependencies:**
   ```bash
   npm ci
   ```

2. **Set OpenAI API key:**
   ```bash
   export OPENAI_API_KEY="your-api-key-here"
   ```
   
   Or create a `.env` file:
   ```
   OPENAI_API_KEY=your-api-key-here
   ```

3. **Optional: Configure model:**
   ```bash
   export OPENAI_MODEL="gpt-4o-mini"  # default
   export OPENAI_BASE_URL="https://api.openai.com/v1"  # default
   ```

## Run Tests

```bash
npm run test:llm
```

## Test Scenarios

The script tests 7 scenarios:

1. **Profit Target Reached** - Price hits T1, should recommend TAKE_PROFIT
2. **Stop Threatened** - Price near stop, should recommend STOP_OUT
3. **Strong Profit - Scale Out** - Price between T1/T2, should recommend SCALE_OUT
4. **Breakeven Opportunity** - Small profit, should recommend TIGHTEN_STOP
5. **Holding - Early Stage** - Just entered, should recommend HOLD
6. **SHORT - Stop Threatened** - SHORT trade near stop
7. **SHORT - Profit Target** - SHORT trade hits target

## Expected Output

Each scenario will:
- Show the trade context (entry, current, stop, targets)
- Call the LLM API with coaching prompt
- Display the LLM's response (action, reasoning, urgency)
- Check if action matches expected behavior
- Report pass/fail for each scenario

## LLM Response Format

The LLM should respond with JSON:
```json
{
  "action": "HOLD|TAKE_PROFIT|TIGHTEN_STOP|STOP_OUT|SCALE_OUT",
  "reasoning": "Brief explanation",
  "urgency": "LOW|MEDIUM|HIGH",
  "specificPrice": null or number
}
```

## Integration

The `LLMService` class in `src/llm/llmService.ts` can be integrated into the main orchestrator to provide real-time coaching updates during active trades.
