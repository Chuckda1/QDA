/**
 * Convert ET (Eastern Time) to UTC timestamp
 * Handles EST (UTC-5) and EDT (UTC-4) automatically based on date
 */
const ET_TIME_ZONE = "America/New_York";

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

function getETParts(date: Date): { hour: number; minute: number; weekday: number } {
  // Use IANA timezone to avoid DST/offset bugs on servers running in UTC.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });

  const parts = dtf.formatToParts(date);
  const hourStr = parts.find((p) => p.type === "hour")?.value;
  const minuteStr = parts.find((p) => p.type === "minute")?.value;
  const weekdayStr = parts.find((p) => p.type === "weekday")?.value;

  const hour = Number(hourStr);
  const minute = Number(minuteStr);

  // Map "Sun".."Sat" -> 0..6
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const weekday = weekdayStr ? (weekdayMap[weekdayStr] ?? new Date(date).getDay()) : new Date(date).getDay();

  return {
    hour: Number.isFinite(hour) ? hour : 0,
    minute: Number.isFinite(minute) ? minute : 0,
    weekday,
  };
}

export function getETDateString(date: Date = new Date()): string {
  // YYYY-MM-DD in America/New_York
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: ET_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return dtf.format(date); // en-CA yields YYYY-MM-DD
}

export function getETClock(date: Date = new Date()): { hour: number; minute: number; weekday: number } {
  return getETParts(date);
}

/**
 * Get current ET time as hours:minutes
 */
export function getCurrentET(): { hour: number; minute: number; weekday: number } {
  return getETParts(new Date());
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
