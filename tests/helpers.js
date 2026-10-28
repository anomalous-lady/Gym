import { once } from 'node:events';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { addDays, addMonths, dateInTz } from '../src/dates.js';

export const PASSWORD = 'Testing123';
const hash = hashPassword(PASSWORD);

/** A fixed "now" the tests can move: 2030-06-10 10:00 UTC = 15:30 in Asia/Kolkata. */
export function makeClock(iso = '2030-06-10T10:00:00.000Z') {
  let t = new Date(iso).getTime();
  return { now: () => new Date(t), set: (v) => { t = new Date(v).getTime(); }, advanceMin: (m) => { t += m * 60_000; } };
}

/** An isolated app + database + HTTP server on a random port. Pass `file` to use a real file DB. */
export async function makeEnv({ file = ':memory:', clock = makeClock() } = {}) {
  const config = loadConfig({ jwtSecret: 'test-secret', nodeEnv: 'test', timezone: 'Asia/Kolkata', cutoffMinutes: 120, loginRateMax: 1000 });
  const db = openDb(file);
  const app = createApp({ db, config, now: clock.now, quiet: true });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api`;

  const tokens = new Map();
  async function http(method, path, { token, body } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
  }
  async function login(email) {
    if (!tokens.has(email)) {
      const r = await http('POST', '/auth/login', { body: { email, password: PASSWORD } });
      if (r.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(r.body)}`);
      tokens.set(email, r.body.token);
    }
    return tokens.get(email);
  }

  const today = () => dateInTz(clock.now(), config.timezone);
  const planId = (code) => db.prepare('SELECT id FROM plans WHERE code = ?').get(code).id;

  function addUser(name, role = 'member', { membership = 'active' } = {}) {
    const email = `${name.toLowerCase().replace(/\W+/g, '.')}@test.club`;
    const id = Number(db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(name, email, hash, role).lastInsertRowid);
    if (role === 'member' && membership) {
      const t = today();
      const [start, end] = membership === 'active' ? [addDays(t, -3), addDays(addMonths(addDays(t, -3), 1), -1)]
        : membership === 'expired' ? [addDays(t, -40), addDays(t, -10)]
        : [addDays(t, 1), addDays(t, 30)]; // 'future'
      db.prepare('INSERT INTO memberships (user_id, plan_id, start_date, end_date) VALUES (?, ?, ?, ?)')
        .run(id, planId('monthly'), start, end);
    }
    return { id, email, name };
  }

  /** Insert a class directly (bypasses the "must be in the future" check so tests can set any time). */
  function addClass({ trainerId, startsInMin = 600, capacity = 2, title = 'Test Class', durationMin = 60 }) {
    const start = new Date(clock.now().getTime() + startsInMin * 60_000);
    const end = new Date(start.getTime() + durationMin * 60_000);
    return Number(db.prepare(`INSERT INTO classes (title, category, trainer_id, starts_at, ends_at, duration_min, capacity)
                              VALUES (?, 'Yoga', ?, ?, ?, ?, ?)`)
      .run(title, trainerId, start.toISOString(), end.toISOString(), durationMin, capacity).lastInsertRowid);
  }

  const close = async () => { server.close(); server.closeAllConnections?.(); db.close(); };
  return { db, config, clock, http, login, addUser, addClass, close, base, today };
}

export const counts = (db, classId) => ({
  booked: db.prepare(`SELECT COUNT(*) n FROM bookings WHERE class_id = ? AND status IN ('booked','attended','absent')`).get(classId).n,
  waitlisted: db.prepare(`SELECT COUNT(*) n FROM bookings WHERE class_id = ? AND status = 'waitlisted'`).get(classId).n,
});
