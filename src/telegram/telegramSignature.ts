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
      snapshot.px ?? "",
      snapshot.entryTrigger ?? "",
      snapshot.entryTriggerTf ?? "",
      snapshot.stop ?? "",
      snapshot.invalidation ?? "",
      snapshot.tp1 ?? "",
      snapshot.tp2 ?? "",
      snapshot.sizeMultiplier ?? "",
      snapshot.entryMode ?? "",
      snapshot.chaseAllowed ?? "",
      (snapshot.warnTags ?? []).join(","),
    ].join("|");
  }

  if (snapshot.type === "WATCH") {
    if (snapshot.range) {
      const rangeBase = [
        snapshot.type,
        snapshot.symbol,
        snapshot.risk,
        snapshot.modeState ?? "",
        snapshot.volumeLine ?? "",
      ];
      return [
        ...rangeBase,
        snapshot.range.low ?? "",
        snapshot.range.high ?? "",
        snapshot.range.vwap ?? "",
        snapshot.range.contextRange?.low ?? "",
        snapshot.range.contextRange?.high ?? "",
        snapshot.range.microBox?.low ?? "",
        snapshot.range.microBox?.high ?? "",
        snapshot.range.longArm ?? "",
        snapshot.range.longEntry ?? "",
        snapshot.range.shortArm ?? "",
        snapshot.range.shortEntry ?? "",
        snapshot.range.stopAnchor ?? "",
        snapshot.range.mode ?? "",
        snapshot.range.note ?? "",
        (snapshot.warnTags ?? []).join(","),
      ].join("|");
    }
    return [
      ...base,
      snapshot.px ?? "",
      snapshot.armCondition ?? "",
      snapshot.entryRule ?? "",
      snapshot.planStop ?? "",
      snapshot.next ?? "",
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

  if (snapshot.type === "MANAGE" && snapshot.update) {
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
