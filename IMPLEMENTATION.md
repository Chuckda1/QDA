# QDA Bot Implementation Summary

## Single Entrypoint
- **`src/index.ts`** - The ONLY entrypoint used by Railway
- All other entrypoints have been removed

## What Was Removed
- ❌ `src/index_prod.ts` (old entrypoint)
- ❌ `src/mock/mockRunner.ts` (mock runner - not needed)
- ❌ All heartbeat push messages (removed from all code)
- ❌ Legacy setup pipelines
- ❌ Duplicate message publishers
- ❌ Old orchestrator patterns

## Architecture

### Core Components

1. **MessageGovernor** (`src/governor/messageGovernor.ts`)
   - Single choke point for ALL Telegram messages
   - Enforces QUIET/ACTIVE mode gating
   - Blocks heartbeats in ACTIVE mode
   - Allows Plan of Day at 09:25 ET

2. **Scheduler** (`src/scheduler/scheduler.ts`)
   - Manages ET time-based mode transitions
   - Sends Plan of Day at 09:25 ET (once per day)
   - Switches to ACTIVE at 09:30 ET
   - Switches to QUIET at 16:00 ET

3. **MessagePublisher** (`src/telegram/messagePublisher.ts`)
   - All outbound messages go through MessageGovernor
   - Handles ordered message publishing (same-tick ordering)
   - Formats all event types

4. **Orchestrator** (`src/orchestrator/orchestrator.ts`)
   - Processes ticks and generates events
   - Enforces strict message ordering:
     - PLAY_ARMED → TIMING_COACH → LLM_VERIFY → TRADE_PLAN
   - Sends LLM_COACH_UPDATE every 5 minutes
   - Handles PLAY_CLOSED events

## Message Flow

### On Play Trigger (Same Tick)
1. PLAY_ARMED
2. TIMING_COACH
3. LLM_VERIFY
4. TRADE_PLAN

### During Active Play
- LLM_COACH_UPDATE every 5 minutes (on 5m close)

### On Play Close
- PLAY_CLOSED
- Return to hunting

## Time-Based Gating

### QUIET Mode (16:00 ET → 09:24:59 ET)
- Blocks all trading messages
- Allows `/status` replies
- Allows Plan of Day at 09:25 ET

### ACTIVE Mode (09:30 ET → 15:59:59 ET)
- Allows all trading messages
- **NO heartbeats** (ever)
- Strict message ordering enforced

## Verification

Run `npm run verify` to check for:
- Forbidden patterns (heartbeat strings, legacy code)
- Duplicate entrypoints
- Single entrypoint enforcement

## Railway Configuration

- **Start Command**: `npm start`
- **Build Command**: `npm run build`
- **Entrypoint**: `dist/index.js` (compiled from `src/index.ts`)

## Environment Variables

- `TELEGRAM_BOT_TOKEN` (required)
- `TELEGRAM_CHAT_ID` (required)
- `INSTANCE_ID` (optional, defaults to "qda-bot-001")
