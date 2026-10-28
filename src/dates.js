// Small date helpers. Membership dates are plain "YYYY-MM-DD" strings interpreted in the
// gym's timezone; class times are full UTC instants (ISO strings).

const pad = (n) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" for the given instant as seen in the given IANA timezone. */
export function dateInTz(instant, timeZone) {
  // en-CA formats dates as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(instant);
}

export function isValidDateString(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Calendar-month arithmetic that clamps (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const total = m - 1 + months;
  const ny = y + Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${pad(nm + 1)}-${pad(Math.min(d, lastDay))}`;
}

/** Whole days from a to b (b - a). */
export function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** e.g. "Thu 29 Oct, 6:30 pm" in the gym timezone (used in notification text). */
export function formatWhen(iso, timeZone) {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
  return `${day}, ${time}`;
}

export const toIso = (date) => new Date(date).toISOString();

/** The UTC instant (ISO) at which calendar day `dateStr` begins in `timeZone`. */
export function zonedDayStart(dateStr, timeZone) {
  // Find the UTC instant at which `dateStr` 00:00 begins in `timeZone` (no DST assumptions).
  const guess = Date.parse(`${dateStr}T00:00:00Z`);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return new Date(guess - (asIfUtc - guess)).toISOString();
}

/** UTC instant for a wall-clock time (HH:MM) on `dateStr` in `timeZone`. */
export function zonedTime(dateStr, hhmm, timeZone) {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.parse(zonedDayStart(dateStr, timeZone)) + (h * 60 + m) * 60_000).toISOString();
}
