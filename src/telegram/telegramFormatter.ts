import type { TelegramSnapshot } from "./telegramNormalizer.js";

export type TelegramAlert = {
  type: "MIND";
  lines: string[];
  text: string;
};

const formatPrice = (value?: number): string => (Number.isFinite(value) ? (value as number).toFixed(2) : "n/a");

export function buildTelegramAlert(snapshot: TelegramSnapshot): TelegramAlert | null {
  if (snapshot.type !== "MIND") return null;
  const price = formatPrice(snapshot.price);
  const conf = Number.isFinite(snapshot.confidence) ? `${snapshot.confidence}%` : "n/a";
  const waitFor = snapshot.trigger ?? snapshot.waitFor ?? "n/a";
  const invalidation = Number.isFinite(snapshot.invalidation)
    ? `INVALIDATION: ${formatPrice(snapshot.invalidation)}`
    : undefined;

  const lines = [
    `THESIS: ${snapshot.direction} (${conf}) | pr ${price}`,
    `STATE: ${snapshot.botState ?? "n/a"}`,
    `WAITING_FOR: ${waitFor}`,
    invalidation,
    snapshot.reason ? `REASON: ${snapshot.reason}` : undefined,
  ].filter(Boolean) as string[];

  return { type: "MIND", lines, text: lines.join("\n") };
}
