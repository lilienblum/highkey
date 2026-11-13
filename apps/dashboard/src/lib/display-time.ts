export function validTimeZone(value: string | null): string {
  if (!value) return "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return value;
  } catch {
    return "UTC";
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Every displayed time reads the same way in the Settings timezone, UTC included; raw JSON keeps
 * ISO. The string is assembled from parts because ICU builds join date and time differently
 * ("13 Nov 2026, 15:03" in Chrome, "13 Nov 2026 at 15:03" in Bun), and server and browser
 * renders must match.
 */
export function displayTimestamp(timestamp: number, timeZone: string): string {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      hourCycle: "h23",
    });
    formatters.set(timeZone, format);
  }
  const part = Object.fromEntries(
    format.formatToParts(timestamp).map(({ type, value }) => [type, value]),
  );
  return `${part.day} ${part.month} ${part.year}, ${part.hour}:${part.minute}:${part.second}.${part.fractionalSecond}`;
}

/** Minute precision for range labels, in the same runtime-independent shape. */
export function displayMinute(timestamp: number, timeZone: string): string {
  return displayTimestamp(timestamp, timeZone).slice(0, -7);
}
