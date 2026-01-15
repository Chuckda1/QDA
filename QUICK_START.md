# Quick Start Guide

## 🚀 Start Command

### Production (Railway/Deployment)
```bash
npm run build
npm start
```

### Development
```bash
npm run dev
```

---

## 📋 Required Environment Variables

### Required (Bot won't start without these)

```bash
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
TELEGRAM_CHAT_ID=your_telegram_chat_id_here
```

**How to get:**
- `TELEGRAM_BOT_TOKEN`: Create a bot with [@BotFather](https://t.me/botfather) on Telegram
- `TELEGRAM_CHAT_ID`: Send a message to your bot, then visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` to find your chat ID

---

## 🔧 Optional Environment Variables

### Bot Configuration
```bash
INSTANCE_ID=qda-bot-001          # Bot instance identifier (default: "qda-bot-001")
HEARTBEAT=1                      # Enable status pulse logs: "1" or "0" (default: "1")
```

### LLM Service (Optional - bot works without it)
```bash
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_BASE_URL=https://api.openai.com/v1  # Default if not set
OPENAI_MODEL=gpt-4o-mini                    # Default if not set
```

**Note:** If `OPENAI_API_KEY` is not set, the bot will run without LLM coaching (rules-only mode).

---

## ⚙️ Default Strategy Settings

These are built-in defaults (not env vars) aimed at stable behavior:

- Regime timeframe: 15m (bias + regime anchor)
- Entry timeframe: 5m (setup detection + entry permission)
- Extended-from-mean max: 1.0 * ATR (VWAP/EMA20 distance)
- Wait-for-pullback re-arm: distance_to_VWAP <= 0.8 * ATR
- GO_ALL_IN allowed only if distance_to_VWAP <= 0.8 * ATR and ATR slope not rising
- TRANSITION: ATR slope rising + impulse/counter-impulse within 3 bars OR mixed structure with mild VWAP slope
- Bias flips require 2 closes beyond VWAP+EMA20 plus structure confirmation on 15m

### Alpaca Market Data (Optional - for real-time data)
```bash
ALPACA_API_KEY=your_alpaca_api_key_here
ALPACA_API_SECRET=your_alpaca_api_secret_here
ALPACA_BASE_URL=https://paper-api.alpaca.markets  # Paper trading (default)
# OR
ALPACA_BASE_URL=https://api.alpaca.markets  # Live trading
ALPACA_FEED=iex                              # "iex" (free) or "sip" (paid)
```

### High-Probability Gate (Optional)
```bash
ENFORCE_HIGH_PROBABILITY_SETUPS=true  # Block low-prob setups
MIN_LLM_PROBABILITY=70                # Minimum LLM probability
MIN_LLM_AGREEMENT=70                  # Minimum LLM agreement
MIN_RULES_PROBABILITY=70              # Minimum rules probability (score or dir confidence)
AUTO_ALL_IN_ON_HIGH_PROB=true         # Promote SCALP -> GO_ALL_IN on high-prob
```

**How to get:**
- Sign up at [Alpaca](https://alpaca.markets/)
- Get API keys from your dashboard (Paper Trading or Live)
- Paper trading is recommended for testing (default URL)
- For SIP feed: Ensure your Alpaca account has SIP subscription

**Feed Types:**
- **IEX** (free): `ALPACA_FEED=iex` - Free feed, good for testing
- **SIP** (paid): `ALPACA_FEED=sip` - Paid feed with comprehensive market data from all U.S. exchanges

**Note:** 
- If Alpaca credentials are not set, the bot will run but won't receive real market data
- Bot connects via **WebSocket** for real-time bars (IEX or SIP)
- Falls back to REST API polling if WebSocket fails
- Paper trading URL is default (safer for testing)
- Bot automatically subscribes to 1-minute bars when credentials are provided

---

## 🏃 Running Locally

### 1. Install Dependencies
```bash
npm ci
```

### 2. Set Environment Variables
Create a `.env` file:
```bash
TELEGRAM_BOT_TOKEN=your_token_here
TELEGRAM_CHAT_ID=your_chat_id_here
INSTANCE_ID=qda-bot-001
```

Or export them:
```bash
export TELEGRAM_BOT_TOKEN=your_token_here
export TELEGRAM_CHAT_ID=your_chat_id_here
```

### 3. Build
```bash
npm run build
```

### 4. Start
```bash
npm start
```

Or for development (no build needed):
```bash
npm run dev
```

---

## 🚂 Railway Deployment

### Build Command
```bash
npm run build
```

### Start Command
```bash
npm start
```

### Environment Variables (in Railway dashboard)
```
TELEGRAM_BOT_TOKEN=your_token_here
TELEGRAM_CHAT_ID=your_chat_id_here
INSTANCE_ID=qda-bot-001
OPENAI_API_KEY=your_key_here (optional)
ALPACA_API_KEY=your_alpaca_key_here (optional - for market data)
ALPACA_API_SECRET=your_alpaca_secret_here (optional - for market data)
ALPACA_BASE_URL=https://paper-api.alpaca.markets (optional - paper trading)
SYMBOLS=SPY (optional - default: SPY)
```

---

## ✅ Verification

After starting, you should see:
- Bot sends startup message: `[qda-bot-001] ✅ Bot online. Mode: QUIET`
- `/status` command works
- Scheduler running (checks ET time every 30 seconds)

---

## 🧪 Testing

```bash
# Verify code quality
npm run verify

# Test stop logic formulas
npm run test:stop

# Test LLM scenarios (requires OPENAI_API_KEY)
npm run test:llm
```

---

## 📝 Environment Variable Summary

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ Yes | - | Telegram bot token |
| `TELEGRAM_CHAT_ID` | ✅ Yes | - | Telegram chat ID (number) |
| `INSTANCE_ID` | ❌ No | `qda-bot-001` | Bot instance identifier |
| `HEARTBEAT` | ❌ No | `1` | Enable status pulses (`1` or `0`) |
| `ENFORCE_HIGH_PROBABILITY_SETUPS` | ❌ No | `true` | Block low-prob setups |
| `MIN_LLM_PROBABILITY` | ❌ No | `70` | Minimum LLM probability threshold |
| `MIN_LLM_AGREEMENT` | ❌ No | `70` | Minimum LLM agreement threshold |
| `MIN_RULES_PROBABILITY` | ❌ No | `70` | Minimum rules confidence threshold |
| `AUTO_ALL_IN_ON_HIGH_PROB` | ❌ No | `true` | Promote SCALP -> GO_ALL_IN |
| `OPENAI_API_KEY` | ❌ No | - | OpenAI API key (for LLM) |
| `OPENAI_BASE_URL` | ❌ No | `https://api.openai.com/v1` | OpenAI API base URL |
| `OPENAI_MODEL` | ❌ No | `gpt-4o-mini` | OpenAI model to use |
| `ALPACA_API_KEY` | ❌ No | - | Alpaca API key (for market data) |
| `ALPACA_API_SECRET` | ❌ No | - | Alpaca API secret (for market data) |
| `ALPACA_BASE_URL` | ❌ No | `https://paper-api.alpaca.markets` | Alpaca base URL (paper/live) |
| `ALPACA_FEED` | ❌ No | `iex` | Alpaca data feed (`iex` or `sip`) |
| `SYMBOLS` | ❌ No | `SPY` | Comma-separated symbols to monitor |

---

## 🔍 Troubleshooting

### Bot won't start
- Check `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set
- Verify token is valid (test with BotFather)
- Check chat ID is a number

### LLM not working
- Check `OPENAI_API_KEY` is set
- Verify API key is valid
- Bot will run without LLM (rules-only mode)

### Alpaca not connecting
- Check `ALPACA_API_KEY` and `ALPACA_API_SECRET` are set
- Verify credentials are valid (test with Alpaca dashboard)
- Check `ALPACA_BASE_URL` matches your account type (paper vs live)
- Bot will run without Alpaca (no market data feed)

### Build fails
- Run `npm ci` to install dependencies
- Check Node.js version (requires Node 18+)
