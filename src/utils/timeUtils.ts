/**
 * Convert ET (Eastern Time) to UTC timestamp
 * Handles EST (UTC-5) and EDT (UTC-4) automatically based on date
 */
export function etToUtcTimestamp(etHour: number, etMinute: number, date: Date = new Date()): number {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  
  // Create date in ET
  const etDate = new Date(year, month, day, etHour, etMinute, 0, 0);
  
  // Determine if DST is in effect (rough approximation: March-November)
  // More accurate: check if date is between 2nd Sunday in March and 1st Sunday in November
  const isDST = isDSTInEffect(etDate);
  const offsetHours = isDST ? 4 : 5; // EDT = UTC-4, EST = UTC-5
  
  // Convert to UTC
  const utcDate = new Date(etDate);
  utcDate.setUTCHours(etDate.getHours() + offsetHours, etDate.getMinutes(), 0, 0);
  
  return utcDate.getTime();
}

function isDSTInEffect(date: Date): boolean {
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  
  // DST: 2nd Sunday in March to 1st Sunday in November
  if (month < 2 || month > 10) return false; // Jan, Feb, Dec = EST
  if (month > 2 && month < 10) return true; // Apr-Oct = EDT
  
  if (month === 2) { // March
    // 2nd Sunday
    const secondSunday = getNthSunday(year, 2, 2);
    return day >= secondSunday;
  }
  
  if (month === 10) { // November
    // 1st Sunday
    const firstSunday = getNthSunday(year, 10, 1);
    return day < firstSunday;
  }
  
  return false;
}

function getNthSunday(year: number, month: number, n: number): number {
  // Find the nth Sunday of the month
  let count = 0;
  for (let day = 1; day <= 31; day++) {
    const date = new Date(year, month, day);
    if (date.getDay() === 0) {
      count++;
      if (count === n) return day;
    }
  }
  return 31;
}

/**
 * Get ET time parts from a date
 */
export function getETParts(date: Date): { hour: number; minute: number; weekday: number } {
  const etOffset = isDSTInEffect(date) ? 4 : 5;
  const etTime = new Date(date.getTime() - etOffset * 60 * 60 * 1000);
  return {
    hour: etTime.getUTCHours(),
    minute: etTime.getUTCMinutes(),
    weekday: date.getUTCDay() // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  };
}

/**
 * Get ET clock (alias for getETParts for consistency)
 */
export function getETClock(date: Date = new Date()): { hour: number; minute: number; weekday: number } {
  return getETParts(date);
}

/**
 * Get ET date string (YYYY-MM-DD) for a given date
 */
export function getETDateString(date: Date = new Date()): string {
  const etOffset = isDSTInEffect(date) ? 4 : 5;
  const etTime = new Date(date.getTime() - etOffset * 60 * 60 * 1000);
  
  // Get the ET date components (using UTC methods since we've already offset)
  const year = etTime.getUTCFullYear();
  const month = String(etTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(etTime.getUTCDate()).padStart(2, '0');
  
  return `${year}-${month}-${day}`;
}

/**
 * Get current ET time as hours:minutes
 */
export function getCurrentET(): { hour: number; minute: number; weekday: number } {
  return getETParts(new Date());
}

/**
 * Check if current time is within ET range
 */
export function isInETRange(startHour: number, startMinute: number, endHour: number, endMinute: number): boolean {
  const { hour, minute } = getCurrentET();
  const currentMinutes = hour * 60 + minute;
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;
  
  if (startMinutes <= endMinutes) {
    // Normal range (e.g., 09:30 to 15:59)
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Wraps midnight (e.g., 16:00 to 09:24)
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}

/**
 * RTH is used for the 09:30–16:00 ET session.
 * OFF_HOURS covers all other times (including weekends).
 */
export function getMarketSessionLabel(date: Date = new Date()): "RTH" | "OFF_HOURS" {
  const { hour, minute, weekday } = getETParts(date);
  const isWeekday = weekday >= 1 && weekday <= 5;
  const cur = hour * 60 + minute;
  const rthStart = 9 * 60 + 30;
  const rthEnd = 16 * 60;

  if (isWeekday && cur >= rthStart && cur < rthEnd) return "RTH";
  return "OFF_HOURS";
}

export function getMarketRegime(
  now: Date,
  tz: string = "America/New_York"
): {
  isRTH: boolean;
  isPremarket: boolean;
  isAfterHours: boolean;
  regime: "CLOSED" | "OPEN_WATCH" | "MORNING_TREND" | "LUNCH_CHOP" | "POWER_HOUR";
  nowEt: string;
  tz: string;
} {
  const { hour, minute, weekday } = getETParts(now);
  const isWeekday = weekday >= 1 && weekday <= 5;
  const cur = hour * 60 + minute;
  const nowEt = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

  const preStart = 4 * 60;
  const rthStart = 9 * 60 + 30;
  const openWatchEnd = 9 * 60 + 40;
  const lunchStart = 12 * 60;
  const lunchEnd = 13 * 60;
  const powerHourStart = 14 * 60;
  const rthEnd = 16 * 60;
  const afterEnd = 20 * 60;

  const isPremarket = isWeekday && cur >= preStart && cur < rthStart;
  const isRTH = isWeekday && cur >= rthStart && cur < rthEnd;
  const isAfterHours = isWeekday && cur >= rthEnd && cur < afterEnd;

  if (!isWeekday || cur < preStart || cur >= afterEnd) {
    return { isRTH, isPremarket, isAfterHours, regime: "CLOSED", nowEt, tz };
  }

  if (!isRTH) {
    return { isRTH, isPremarket, isAfterHours, regime: "CLOSED", nowEt, tz };
  }

  if (cur < openWatchEnd) {
    return { isRTH, isPremarket, isAfterHours, regime: "OPEN_WATCH", nowEt, tz };
  }
  if (cur >= lunchStart && cur < lunchEnd) {
    return { isRTH, isPremarket, isAfterHours, regime: "LUNCH_CHOP", nowEt, tz };
  }
  if (cur >= powerHourStart && cur < rthEnd) {
    return { isRTH, isPremarket, isAfterHours, regime: "POWER_HOUR", nowEt, tz };
  }
  return { isRTH, isPremarket, isAfterHours, regime: "MORNING_TREND", nowEt, tz };
}
