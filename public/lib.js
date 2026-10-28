// Small helpers: DOM builder (never parses HTML, so user text cannot inject markup), API client, formatting.

const SVG_TAGS = new Set(['svg', 'path', 'circle', 'g']);
export function h(tag, props, ...kids) {
  const isSvg = SVG_TAGS.has(tag);
  const el = isSvg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (isSvg) el.setAttribute(k === 'class' ? 'class' : k, v === true ? '' : v);
    else if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k.startsWith('aria-') || k.startsWith('data-') || k === 'role' || k === 'for' || k === 'list') el.setAttribute(k, v === true ? '' : v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}
export const clear = (el) => { el.replaceChildren(); return el; };

// ── session ────────────────────────────────────────────────
const TOKEN_KEY = 'aurelian.token';
export const session = {
  get() { try { return localStorage.getItem(TOKEN_KEY); } catch { return memoryToken; } },
  set(t) { memoryToken = t; try { localStorage.setItem(TOKEN_KEY, t); } catch { /* private mode */ } },
  clear() { memoryToken = null; try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
};
let memoryToken = null;

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || 'Something went wrong. Please try again.');
    this.status = status;
    this.code = body?.error?.code;
    this.fields = body?.error?.fields || {};
  }
}
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(path, { method = 'GET', body } = {}) {
  const token = session.get();
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { error: { message: 'Cannot reach the server. Check your connection and try again.' } });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(res.status, json);
    if (res.status === 401 && token && path !== '/auth/login') { err.handled = true; onUnauthorized(); }
    throw err;
  }
  return json;
}

// ── formatting (always in the gym's timezone) ──────────────
let TZ = 'Asia/Kolkata';
let CURRENCY = 'INR';
export const setLocale = ({ timezone, currency }) => { TZ = timezone; CURRENCY = currency; };
export const tz = () => TZ;

export function timeParts(iso) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(iso));
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return { clock: `${get('hour')}:${get('minute')}`, meridiem: get('dayPeriod').toLowerCase() };
}
export const fmtTime = (iso) => { const t = timeParts(iso); return `${t.clock} ${t.meridiem}`; };
export const fmtDay = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso));
export const fmtDayLong = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
export const fmtDate = (ymd) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${ymd}T00:00:00Z`));
export const dayKey = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
export const money = (cents) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: CURRENCY, maximumFractionDigits: 0 }).format(cents / 100);
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function addDaysKey(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const weekdayShort = (ymd) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' }).format(new Date(`${ymd}T00:00:00Z`));
export const dayNum = (ymd) => Number(ymd.slice(8));

/** Wall-clock date + time in the gym timezone -> UTC ISO string (no DST assumptions). */
export function zonedToIso(ymd, hhmm) {
  const guess = Date.parse(`${ymd}T${hhmm}:00Z`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return new Date(guess - (asIfUtc - guess)).toISOString();
}
export const isoToLocalParts = (iso) => ({ date: dayKey(iso), time: new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)) });
