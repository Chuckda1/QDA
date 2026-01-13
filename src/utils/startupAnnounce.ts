import { promises as fs } from "node:fs";
import path from "node:path";
import type { TelegramBotLike } from "../telegram/sendTelegramMessageSafe.js";
import { sendTelegramMessageSafe } from "../telegram/sendTelegramMessageSafe.js";

type StartupAnnounceResult =
  | { sent: true; skipped: false; reason: "sent" }
  | { sent: false; skipped: true; reason: "cooldown" }
  | { sent: false; skipped: true; reason: "state_read_error" }
  | { sent: false; skipped: true; reason: "send_failed" };

function getDefaultStateFile(instanceId: string): string {
  // /tmp is typically available on Linux containers and survives many "restart loop"
  // scenarios on the same host, reducing chat spam.
  return `/tmp/qda-startup-${instanceId}.json`;
}

export async function announceStartupThrottled(opts: {
  bot: TelegramBotLike;
  chatId: number;
  instanceId: string;
  text: string;
  cooldownMs?: number;
  stateFile?: string;
}): Promise<StartupAnnounceResult> {
  const cooldownMs = opts.cooldownMs ?? 10 * 60 * 1000; // 10 minutes
  const stateFile = (opts.stateFile || process.env.STARTUP_ANNOUNCE_STATE_FILE || getDefaultStateFile(opts.instanceId)).trim();

  const now = Date.now();

  try {
    const raw = await fs.readFile(stateFile, "utf8");
    const parsed = JSON.parse(raw) as { lastSentAt?: number } | null;
    const lastSentAt = typeof parsed?.lastSentAt === "number" ? parsed.lastSentAt : 0;
    if (lastSentAt > 0 && now - lastSentAt < cooldownMs) {
      return { sent: false, skipped: true, reason: "cooldown" };
    }
  } catch (err: any) {
    // If the file doesn't exist, that's fine. If it's unreadable/corrupt, skip announcing
    // to avoid making a restart loop even noisier.
    if (err?.code !== "ENOENT") {
      console.warn(`[startup] startup announce state read failed: ${err?.message || String(err)}`);
      return { sent: false, skipped: true, reason: "state_read_error" };
    }
  }

  try {
    await sendTelegramMessageSafe(opts.bot, opts.chatId, opts.text);
  } catch (err: any) {
    console.warn(`[startup] startup announce send failed: ${err?.message || String(err)}`);
    return { sent: false, skipped: true, reason: "send_failed" };
  }

  try {
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify({ lastSentAt: now }) + "\n", "utf8");
  } catch (err: any) {
    // Non-fatal: we still sent; just log.
    console.warn(`[startup] startup announce state write failed: ${err?.message || String(err)}`);
  }

  return { sent: true, skipped: false, reason: "sent" };
}
