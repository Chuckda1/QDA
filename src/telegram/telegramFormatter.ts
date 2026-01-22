import type { TelegramSnapshot, TelegramSnapshotType } from "./telegramNormalizer.js";

export type TelegramAlert = {
  type: TelegramSnapshotType;
  lines: string[];
  text: string;
};

const MAX_LINES: Record<TelegramSnapshotType, number> = {
  SIGNAL: 7,
  WATCH: 9,
  UPDATE: 4,
  MANAGE: 4,
};

const formatPrice = (value?: number): string => (Number.isFinite(value) ? (value as number).toFixed(2) : "n/a");

const formatUpdateHeader = (input: {
  symbol: string;
  fromSide?: "LONG" | "SHORT";
  toSide?: "LONG" | "SHORT";
  px?: number;
}): string => {
  const px = Number.isFinite(input.px) ? formatPrice(input.px) : "—";
  if (input.fromSide && input.toSide) {
    return `UPDATE: ${input.symbol} ${input.fromSide} → ${input.toSide} 🔁 | px ${px}`;
  }
  const side = input.toSide ?? input.fromSide;
  if (side) {
    return `UPDATE: ${input.symbol} ${side} 🔁 | px ${px}`;
  }
  return `UPDATE: ${input.symbol} | px ${px}`;
};

const formatManageHeader = (input: {
  symbol: string;
  dir: "LONG" | "SHORT";
  px?: number;
  risk: string;
}): string => {
  const px = Number.isFinite(input.px) ? formatPrice(input.px) : "—";
  return `MANAGE: ${input.symbol} ${input.dir} 🛠️ | px ${px} | risk=${input.risk}`;
};

const enforceLineLimit = (type: TelegramSnapshotType, lines: string[]): string[] => {
  const trimmed = lines.filter(Boolean);
  return trimmed.slice(0, MAX_LINES[type]);
};

const nonEmpty = (line?: string): line is string => Boolean(line);

const formatWarnTags = (tags?: string[]): string | undefined => {
  if (!tags?.length) return undefined;
  const capped = tags.slice(0, 2);
  const extra = tags.length - capped.length;
  const suffix = extra > 0 ? ` (+${extra})` : "";
  return `WARN: ${capped.join(",")}${suffix}`;
};

const formatEtTimeShort = (ts?: string): string | undefined => {
  if (!ts) return undefined;
  const parts = ts.split(" ");
  const time = parts[1];
  if (!time) return ts;
  const hhmm = time.slice(0, 5);
  return `${hhmm} ET`;
};

export function buildTelegramAlert(snapshot: TelegramSnapshot): TelegramAlert | null {
  if (snapshot.type === "SIGNAL") {
    const header = `${snapshot.symbol} ${snapshot.dir} ✅ ${snapshot.conf ?? "?"}% | SIGNAL | risk=${snapshot.risk}`;
    const entryTf = snapshot.entryTriggerTf ? `${snapshot.entryTriggerTf} close` : "1m close";
    const entry = `ENTRY: ${snapshot.entryTrigger ?? "n/a"} (${entryTf})`;
    const stop = `STOP: ${formatPrice(snapshot.stop)} | INVALID: ${snapshot.invalidation ?? "n/a"}`;
    const tp = `TP1: ${formatPrice(snapshot.tp1)} | TP2: ${formatPrice(snapshot.tp2)} | MGMT: SL→BE after TP1`;
    const size = `SIZE: ${(snapshot.sizeMultiplier ?? 1).toFixed(2)}x`;
    const why = `WHY: ${snapshot.why ?? "n/a"}`;
    const warn = formatWarnTags(snapshot.warnTags);
    const lines = enforceLineLimit("SIGNAL", [header, entry, stop, tp, size, why, warn].filter(nonEmpty));
    return { type: "SIGNAL", lines, text: lines.join("\n") };
  }

  if (snapshot.type === "WATCH") {
    if (snapshot.range) {
      const time = formatEtTimeShort(snapshot.range.ts);
      const timeSuffix = time ? ` | ${time}` : "";
      const header = `${snapshot.symbol} ⚪ RANGE | WATCH | px ${formatPrice(snapshot.range.price)} | risk=${snapshot.risk}${timeSuffix}`;
      const rangeLine = `RANGE: ${formatPrice(snapshot.range.low)}-${formatPrice(snapshot.range.high)} | VWAP ${formatPrice(snapshot.range.vwap)}`;
      const longArm = `LONG ARM: ${snapshot.range.longArm}`;
      const longEntry = `LONG ENTRY: ${snapshot.range.longEntry}`;
      const shortArm = `SHORT ARM: ${snapshot.range.shortArm}`;
      const shortEntry = `SHORT ENTRY: ${snapshot.range.shortEntry}`;
      const stop = `STOP: ${snapshot.range.stopAnchor || "when armed"}`;
      const next = "NEXT: wait for ARM → bot creates play";
      const warn = formatWarnTags(snapshot.warnTags);
      const lines = enforceLineLimit(
        "WATCH",
        [header, rangeLine, longArm, longEntry, shortArm, shortEntry, stop, next, warn].filter(nonEmpty)
      );
      return { type: "WATCH", lines, text: lines.join("\n") };
    }
    const header = `${snapshot.symbol} ${snapshot.dir} 🟡 ${snapshot.conf ?? "?"}% | WATCH | risk=${snapshot.risk}`;
    const arm = `ARM: ${snapshot.armCondition ?? "n/a"} (creates play)`;
    const entry = `ENTRY: ${snapshot.entryRule ?? "pullback only (NO chase)"}`;
    const planStop = `PLAN STOP: ${snapshot.planStop ?? "last swing (auto when armed)"}`;
    const why = `WHY: ${snapshot.why ?? "n/a"}`;
    const warn = formatWarnTags(snapshot.warnTags);
    const lines = enforceLineLimit("WATCH", [header, arm, entry, planStop, why, warn].filter(nonEmpty));
    return { type: "WATCH", lines, text: lines.join("\n") };
  }

  if (snapshot.type === "UPDATE" && snapshot.update) {
    const update = snapshot.update;
    const header = formatUpdateHeader({
      symbol: snapshot.symbol,
      fromSide: update.fromSide,
      toSide: update.toSide,
      px: update.price,
    });
    const last = update.lastSignal ? ` | last ${update.lastSignal}` : "";
    const cause = `CAUSE: ${update.cause}${last}`;
    const next = `NEXT: ${update.next}`;
    const ts = `TS: ${update.ts}`;
    const lines = enforceLineLimit("UPDATE", [header, cause, next, ts]);
    return { type: "UPDATE", lines, text: lines.join("\n") };
  }

  if (snapshot.type === "MANAGE" && snapshot.update) {
    const update = snapshot.update;
    const header = formatManageHeader({
      symbol: snapshot.symbol,
      dir: snapshot.dir,
      px: update.price,
      risk: snapshot.risk,
    });
    const cause = `ACTION: ${update.cause}`;
    const next = `NEXT: ${update.next}`;
    const ts = `TS: ${update.ts}`;
    const lines = enforceLineLimit("MANAGE", [header, cause, next, ts]);
    return { type: "MANAGE", lines, text: lines.join("\n") };
  }

  return null;
}
