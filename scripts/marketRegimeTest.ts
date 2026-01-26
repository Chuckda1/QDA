import { etToUtcTimestamp, getMarketRegime } from "../src/utils/timeUtils.js";

type Case = {
  label: string;
  hour: number;
  minute: number;
  expect: {
    isRTH: boolean;
    regime: "CLOSED" | "OPEN_WATCH" | "MORNING_TREND" | "LUNCH_CHOP" | "POWER_HOUR";
  };
};

const date = new Date(Date.UTC(2025, 5, 3, 0, 0, 0, 0)); // 2025-06-03 (Tue)

const cases: Case[] = [
  { label: "09:29", hour: 9, minute: 29, expect: { isRTH: false, regime: "CLOSED" } },
  { label: "09:30", hour: 9, minute: 30, expect: { isRTH: true, regime: "OPEN_WATCH" } },
  { label: "09:40", hour: 9, minute: 40, expect: { isRTH: true, regime: "MORNING_TREND" } },
  { label: "12:00", hour: 12, minute: 0, expect: { isRTH: true, regime: "LUNCH_CHOP" } },
  { label: "13:00", hour: 13, minute: 0, expect: { isRTH: true, regime: "MORNING_TREND" } },
  { label: "14:00", hour: 14, minute: 0, expect: { isRTH: true, regime: "POWER_HOUR" } },
  { label: "16:00", hour: 16, minute: 0, expect: { isRTH: false, regime: "CLOSED" } },
];

const errors: string[] = [];

for (const test of cases) {
  const ts = etToUtcTimestamp(test.hour, test.minute, date);
  const regime = getMarketRegime(new Date(ts));
  if (regime.isRTH !== test.expect.isRTH || regime.regime !== test.expect.regime) {
    errors.push(
      `${test.label}: expected isRTH=${test.expect.isRTH} regime=${test.expect.regime}, got isRTH=${regime.isRTH} regime=${regime.regime}`
    );
  }
}

if (errors.length) {
  console.error("❌ Market regime tests failed:");
  errors.forEach((err) => console.error(`  - ${err}`));
  process.exit(1);
}

console.log("✅ Market regime tests passed.");
