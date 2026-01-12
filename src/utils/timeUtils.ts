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
 * Get current ET time as hours:minutes
 */
export function getCurrentET(): { hour: number; minute: number } {
  const now = new Date();
  const etOffset = isDSTInEffect(now) ? 4 : 5;
  const etTime = new Date(now.getTime() - etOffset * 60 * 60 * 1000);
  return { hour: etTime.getUTCHours(), minute: etTime.getUTCMinutes() };
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
