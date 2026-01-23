import type { TelegramSnapshot, TelegramSnapshotType } from "./telegramNormalizer.js";

export type TelegramAlert = {
  type: TelegramSnapshotType;
  lines: string[];
  text: string;
};

const MAX_LINES: Record<TelegramSnapshotType, number> = {
  SIGNAL: 7,
  WATCH: 8,
  UPDATE: 3,
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
    if (input.fromSide === input.toSide) {
      return `UPDATE: ${input.symbol} ${input.fromSide} 🔁 | px ${px}`;
    }
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
  ts: string;
}): string => {
  const px = Number.isFinite(input.px) ? formatPrice(input.px) : "—";
  return `MANAGE: ${input.symbol} ${input.dir} 🛠️ | px ${px} | ${input.ts}`;
};

const enforceLineLimit = (type: TelegramSnapshotType, lines: string[]): string[] => {
  const trimmed = lines.filter(Boolean);
  return trimmed.slice(0, MAX_LINES[type]);
};

const nonEmpty = (line?: string): line is string => Boolean(line);

const formatWarnTags = (warnTags?: string[]): { label: string; value: string } | undefined => {
  if (!warnTags || warnTags.length === 0) return undefined;
  const cleaned = warnTags.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  if (cleaned.length === 0) return undefined;
  const hardTags = new Set(["DATA", "GUARDRAIL", "COOLDOWN"]);
  const hard: string[] = [];
  const soft: string[] = [];
  for (const tag of cleaned) {
    if (hardTags.has(tag)) {
      hard.push(tag);
    } else {
      soft.push(tag);
    }
  }
  const ordered = [...hard, ...soft];
  const shown = ordered.slice(0, 4);
  const extra = ordered.length - shown.length;
  const label = hard.length && soft.length ? "WARN(H/S)" : hard.length ? "WARN(H)" : "WARN(S)";
  const value = extra > 0 ? `${shown.join(",")},+${extra}` : shown.join(",");
  return { label, value };
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
    const px = Number.isFinite(snapshot.px) ? formatPrice(snapshot.px) : "—";
    const header = `${snapshot.symbol} ${snapshot.dir} ✅ ${snapshot.conf ?? "?"}% | SIGNAL | risk=${snapshot.risk} | px ${px} | ${snapshot.ts ?? "n/a"}`;
    const entryTf = snapshot.entryTriggerTf ? `${snapshot.entryTriggerTf} close` : "1m close";
    const chase = snapshot.chaseAllowed ? "YES" : "NO";
    const entry = `ENTRY: ${snapshot.entryTrigger ?? "n/a"} (${entryTf}) | CHASE: ${chase}`;
    const stop = `STOP: ${formatPrice(snapshot.stop)} | INVALID: ${snapshot.invalidation ?? "n/a"}`;
    const tp = `TP1: ${formatPrice(snapshot.tp1)} | TP2: ${formatPrice(snapshot.tp2)} | MGMT: SL→BE after TP1`;
    const size = `SIZE: ${(snapshot.sizeMultiplier ?? 1).toFixed(2)}x | MODE: ${snapshot.entryMode ?? "PULLBACK"}`;
    const vol = snapshot.volumeLine ? `VOL: ${snapshot.volumeLine}` : undefined;
    const warnTags = formatWarnTags(snapshot.warnTags);
    const why = warnTags
      ? `WHY: ${snapshot.why ?? "n/a"} | ${warnTags.label}: ${warnTags.value}`
      : `WHY: ${snapshot.why ?? "n/a"}`;
    const lines = enforceLineLimit("SIGNAL", [header, entry, stop, tp, size, vol, why].filter(nonEmpty));
    return { type: "SIGNAL", lines, text: lines.join("\n") };
  }

  if (snapshot.type === "WATCH") {
    if (snapshot.range) {
      const time = formatEtTimeShort(snapshot.range.ts ?? snapshot.ts);
      const timeSuffix = time ? ` | ${time}` : "";
      const modeLabel = snapshot.range.mode === "TIGHT" ? "CHOP" : "RANGE";
      const header = `${snapshot.symbol} ⚪ ${modeLabel} | WATCH | px ${formatPrice(snapshot.range.price)} | risk=${snapshot.risk}${timeSuffix}`;
      const contextLine = snapshot.range.contextRange
        ? `CONTEXT_RANGE: ${formatPrice(snapshot.range.contextRange.low)}-${formatPrice(snapshot.range.contextRange.high)} | VWAP ${formatPrice(snapshot.range.vwap)}`
        : `CONTEXT_RANGE: n/a | VWAP ${formatPrice(snapshot.range.vwap)}`;
      const bufferLine = Number.isFinite(snapshot.range.buffer)
        ? `BUFFER: ${formatPrice(snapshot.range.buffer)} (ATR1m=${formatPrice(snapshot.range.atr1m)})`
        : undefined;
      const microLine = snapshot.range.microBox
        ? `MICRO_BOX: ${formatPrice(snapshot.range.microBox.low)}-${formatPrice(snapshot.range.microBox.high)}`
        : "MICRO_BOX: n/a — using CONTEXT rails";
      const vol = snapshot.volumeLine ? `VOL: ${snapshot.volumeLine}` : undefined;
      const rangeBias = snapshot.rangeBias?.bias ?? snapshot.dir;
      const rangeConf = snapshot.rangeBias?.confidence ?? snapshot.conf;
      const status = snapshot.status ?? "WATCH";
      const statusLine = `STATUS: ${status}`;
      const bias = `BIAS: ${rangeBias} (${rangeConf ?? "?"}%)`;
      const location = snapshot.range.location
        ? `LOCATION: ${snapshot.range.location.zone} (pos=${snapshot.range.location.pos})`
        : undefined;
      const activeSide = snapshot.range.activeSide ?? "NONE";
      const activeLine = `ACTIVE_SIDE: ${activeSide}`;
      const planA =
        activeSide === "LONG_ONLY"
          ? `PLAN${status === "WATCH" ? " (IF/WHEN gates pass)" : ""}: ${snapshot.range.longEntry ?? "n/a"} → bias LONG`
          : "LONG disabled (not at range low)";
      const planB =
        activeSide === "SHORT_ONLY"
          ? `PLAN${status === "WATCH" ? " (IF/WHEN gates pass)" : ""}: ${snapshot.range.shortEntry ?? "n/a"} → bias SHORT`
          : activeSide === "NONE"
          ? "MID zone: wait for breakout confirmation"
          : "SHORT disabled (not at range high)";
      const arm =
        status === "SIGNAL" && snapshot.volumeRetestOk !== false
          ? "ARM: retest range (bot creates play)"
          : undefined;
      const stop = `STOP: ${snapshot.range.stopAnchor || "when armed"}`;
      const blockedBy = snapshot.blockedBy?.length ? `BLOCKED_BY: ${snapshot.blockedBy.join(" | ")}` : undefined;
      const gates = snapshot.gates;
      const note = snapshot.range.note ? `NOTE: ${snapshot.range.note}` : undefined;
      const warnTags = formatWarnTags(snapshot.warnTags);
      const warn = warnTags ? `${warnTags.label}: ${warnTags.value}` : undefined;
      const lines = [
        header,
        contextLine,
        bufferLine,
        microLine,
        vol,
        statusLine,
        location,
        bias,
        activeLine,
        planA,
        planB,
        blockedBy,
        gates,
        stop,
        arm,
        note,
        warn
      ].filter(nonEmpty);
      return { type: "WATCH", lines: lines.slice(0, 14), text: lines.slice(0, 14).join("\n") };
    }
    const px = Number.isFinite(snapshot.px) ? formatPrice(snapshot.px) : "—";
    const header = `${snapshot.symbol} ${snapshot.dir} 🟡 ${snapshot.conf ?? "?"}% | WATCH | risk=${snapshot.risk} | px ${px} | ${snapshot.ts ?? "n/a"}`;
    const arm = `ARM: ${snapshot.armCondition ?? "n/a"} (creates play)`;
    const entry = `ENTRY: ${snapshot.entryRule ?? "pullback only (NO chase)"}`;
    const planStop = `STOP PLAN: ${snapshot.planStop ?? "last swing (auto when armed)"}`;
    const vol = snapshot.volumeLine ? `VOL: ${snapshot.volumeLine}` : undefined;
    const blockedBy = snapshot.blockedBy?.length ? `BLOCKED_BY: ${snapshot.blockedBy.join(" | ")}` : undefined;
    const gates = snapshot.gates;
    const nextText = snapshot.next ?? "waiting on arm trigger";
    const next =
      blockedBy || gates
        ? undefined
        : nextText.startsWith("BLOCKED_BY:") || nextText.startsWith("NEXT:")
        ? nextText
        : `NEXT: ${nextText}`;
    const warnTags = formatWarnTags(snapshot.warnTags);
    const why = warnTags
      ? `WHY: ${snapshot.why ?? "n/a"} | ${warnTags.label}: ${warnTags.value}`
      : `WHY: ${snapshot.why ?? "n/a"}`;
    const lines = enforceLineLimit(
      "WATCH",
      [header, arm, entry, vol, planStop, blockedBy, gates, next, why].filter(nonEmpty)
    );
    return { type: "WATCH", lines, text: lines.join("\n") };
  }

  if (snapshot.type === "UPDATE" && snapshot.update) {
    const update = snapshot.update;
    const updatePx = Number.isFinite(update.price) ? update.price : snapshot.px;
    const isTimeCutoff = update.cause === "time cutoff";
    const header = isTimeCutoff
      ? `UPDATE: TIME CUTOFF ⏱️ | ${snapshot.symbol} | px ${Number.isFinite(updatePx) ? formatPrice(updatePx) : "—"}`
      : formatUpdateHeader({
      symbol: snapshot.symbol,
      fromSide: update.fromSide,
      toSide: update.toSide,
      px: updatePx,
    });
    const ts = snapshot.ts ?? update.ts;
    const headerWithTs = `${header} | ${ts}`;
    const last = update.lastSignal ? ` | last ${update.lastSignal}` : "";
    const cause = `CAUSE: ${update.cause}${last}`;
    const next = `NEXT: ${update.next}`;
    const lines = enforceLineLimit("UPDATE", [headerWithTs, cause, next]);
    return { type: "UPDATE", lines, text: lines.join("\n") };
  }

  if (snapshot.type === "MANAGE" && snapshot.update) {
    const update = snapshot.update;
    const header = formatManageHeader({
      symbol: snapshot.symbol,
      dir: snapshot.dir,
      px: update.price,
      ts: snapshot.ts ?? update.ts,
    });
    const cause = `ACTION: ${update.cause}`;
    const next = `NEXT: ${update.next}`;
    const warnTags = formatWarnTags(snapshot.warnTags);
    const warn = warnTags ? `${warnTags.label}: ${warnTags.value}` : undefined;
    const lines = enforceLineLimit("MANAGE", [header, cause, next, warn].filter(nonEmpty));
    return { type: "MANAGE", lines, text: lines.join("\n") };
  }

  return null;
}
