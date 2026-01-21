import type { TelegramSnapshot } from "./telegramNormalizer.js";

const confBucket = (conf?: number): string => {
  if (!Number.isFinite(conf)) return "N/A";
  if ((conf as number) >= 100) return "100";
  if ((conf as number) >= 80) return "80+";
  return "<80";
};

export function buildTelegramSignature(snapshot: TelegramSnapshot): string {
  const base = [
    snapshot.type,
    snapshot.symbol,
    snapshot.dir,
    confBucket(snapshot.conf),
    snapshot.risk,
  ];

  if (snapshot.type === "SIGNAL") {
    return [
      ...base,
      snapshot.entryTrigger ?? "",
      snapshot.entryTriggerTf ?? "",
      snapshot.stop ?? "",
      snapshot.invalidation ?? "",
      snapshot.tp1 ?? "",
      snapshot.tp2 ?? "",
      snapshot.sizeMultiplier ?? "",
      (snapshot.warnTags ?? []).join(","),
    ].join("|");
  }

  if (snapshot.type === "WATCH") {
    return [
      ...base,
      snapshot.armCondition ?? "",
      snapshot.entryRule ?? "",
      snapshot.planStop ?? "",
      (snapshot.warnTags ?? []).join(","),
    ].join("|");
  }

  if (snapshot.type === "UPDATE" && snapshot.update) {
    return [
      ...base,
      snapshot.update.fromSide ?? "",
      snapshot.update.toSide ?? "",
      snapshot.update.cause ?? "",
      snapshot.update.next ?? "",
      snapshot.update.ts ?? "",
      snapshot.update.price ?? "",
      snapshot.update.lastSignal ?? "",
    ].join("|");
  }

  return base.join("|");
}
