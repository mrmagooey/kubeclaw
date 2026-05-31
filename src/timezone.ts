/**
 * Convert a UTC ISO timestamp to a localized display string.
 * Uses the Intl API (no external dependencies).
 */
export function formatLocalTime(utcIso: string, timezone: string): string {
  const date = new Date(utcIso);
  return date.toLocaleString('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Return the current wall-clock time as an ISO-8601 string with the UTC
 * offset for the given IANA timezone, e.g. "2026-05-28T19:34:00+10:00".
 *
 * The optional `now` parameter exists solely for deterministic testing;
 * callers should omit it in production.
 */
export function formatCurrentTime(
  timezone: string,
  now: Date = new Date(),
): string {
  // Extract the numeric offset in minutes from the Intl API.
  // We use a known-stable trick: format parts include a 'timeZoneName'
  // of style 'shortOffset' (e.g. "GMT+10" or "GMT-5").
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'shortOffset',
  });

  const parts = formatter.formatToParts(now);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? '00';

  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour').padStart(2, '0').replace('24', '00');
  const minute = get('minute');
  const second = get('second');

  // timeZoneName part looks like "GMT+10:30", "GMT-5", or "GMT"
  const tzName = get('timeZoneName'); // e.g. "GMT+10:30" or "GMT-5"
  let offsetStr = '+00:00';
  const match = tzName.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (match) {
    const sign = match[1];
    const hh = match[2].padStart(2, '0');
    const mm = (match[3] ?? '00').padStart(2, '0');
    offsetStr = `${sign}${hh}:${mm}`;
  }

  return `${year}-${month}-${day}T${hour}:${minute}:${second}${offsetStr}`;
}
