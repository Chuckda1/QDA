# Alpaca Market Data Integration

## Overview

The bot supports **real-time market data** from Alpaca via WebSocket, with support for both **IEX** (free) and **SIP** (paid) feeds.

---

## Environment Variables

```bash
ALPACA_API_KEY=your_alpaca_api_key_here
ALPACA_API_SECRET=your_alpaca_api_secret_here
ALPACA_BASE_URL=https://paper-api.alpaca.markets  # Paper (default)
# OR
ALPACA_BASE_URL=https://api.alpaca.markets  # Live
ALPACA_FEED=iex  # "iex" (free) or "sip" (paid)
SYMBOLS=SPY      # Comma-separated symbols (default: SPY)
```

---

## Feed Types

### IEX Feed (Free)
- **URL**: `wss://stream.data.alpaca.markets/v2/iex`
- **Cost**: Free
- **Data**: IEX exchange data
- **Use case**: Testing, development

### SIP Feed (Paid)
- **URL**: `wss://stream.data.alpaca.markets/v2/sip`
- **Cost**: Requires Alpaca SIP subscription
- **Data**: Comprehensive market data from all U.S. exchanges
- **Use case**: Production trading

---

## How It Works

### 1. WebSocket Connection (Primary)
- Connects to Alpaca WebSocket stream
- Authenticates with API credentials
- Subscribes to 1-minute bars for symbol(s)
- Receives real-time bar updates
- Yields bars to orchestrator for processing

### 2. REST API Polling (Fallback)
- If WebSocket fails, falls back to REST API
- Polls `/v2/stocks/{symbol}/bars/latest` every 60 seconds
- Less efficient but more reliable

---

## Connection Flow

```
1. Initialize AlpacaDataFeed
   └─> Config: apiKey, apiSecret, baseUrl, feed

2. Connect WebSocket
   └─> wss://stream.data.alpaca.markets/v2/{feed}
   └─> feed = "iex" or "sip"

3. Authenticate
   └─> Send auth message with credentials
   └─> Wait for "authenticated" response

4. Subscribe to Bars
   └─> Send subscribe message: { action: "subscribe", bars: ["SPY"] }
   └─> Receives 1-minute bar updates

5. Process Bars
   └─> For each bar received:
       └─> Check if ACTIVE mode
       └─> Call orchestrator.processTick()
       └─> Publish events to Telegram
```

---

## Bar Message Format

Alpaca WebSocket sends bars in this format:
```json
[
  {
    "T": "b",        // Type: bar
    "S": "SPY",      // Symbol
    "t": "2025-01-15T14:30:00Z",  // Timestamp
    "o": 504.71,     // Open
    "h": 504.85,     // High
    "l": 504.65,     // Low
    "c": 504.80,     // Close
    "v": 1234567     // Volume
  }
]
```

Bot converts to internal `Bar` format:
```typescript
{
  ts: 1705336200000,    // Timestamp (ms)
  symbol: "SPY",
  open: 504.71,
  high: 504.85,
  low: 504.65,
  close: 504.80,
  volume: 1234567
}
```

---

## Error Handling

### WebSocket Errors
- **Connection lost**: Automatically reconnects after 5 seconds
- **Authentication failed**: Logs error, falls back to REST polling
- **Subscription failed**: Logs error, continues trying

### REST API Errors
- **API error**: Logs error, retries on next poll
- **Rate limit**: Waits and retries

---

## Usage

### With IEX (Free)
```bash
ALPACA_API_KEY=your_key
ALPACA_API_SECRET=your_secret
ALPACA_FEED=iex
```

### With SIP (Paid)
```bash
ALPACA_API_KEY=your_key
ALPACA_API_SECRET=your_secret
ALPACA_FEED=sip
```

### Without Alpaca
- Bot runs normally (Telegram works)
- No market data feed
- You can wire your own data source

---

## Dependencies

- `ws`: WebSocket client for Node.js
- `@types/ws`: TypeScript types

---

## Testing

The bot will automatically:
1. Try WebSocket connection first
2. Fall back to REST polling if WebSocket fails
3. Log connection status on startup

Check logs for:
- `[Alpaca] WebSocket connected to IEX feed` (or SIP)
- `[Alpaca] Authenticated successfully`
- `[Alpaca] Subscribed to bars for SPY`

---

## Notes

- **SIP requires subscription**: Make sure your Alpaca account has SIP access
- **Paper vs Live**: Use paper trading URL for testing
- **Symbols**: Default is SPY, can be changed via `SYMBOLS` env var
- **Real-time**: WebSocket provides real-time bars (not delayed)
- **Fallback**: REST polling is slower but more reliable
