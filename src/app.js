import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AppError, badRequest, forbidden, notFound, unauthorized, wrap } from './errors.js';
import { authenticate, burnPasswordTime, checkPassword, hashPassword, rateLimit, requireRole, signToken } from './auth.js';
import { parse, schemas } from './validation.js';
import { addDays, dateInTz, isValidDateString, zonedDayStart } from './dates.js';
import { cancelMembership, createMembership, expiringMemberships, listMemberships, listPlans } from './services/memberships.js';
import { cancelClass, createClass, getClass, getRoster, listClasses, updateClass } from './services/classes.js';
import { bookClass, cancelBooking, listMyBookings } from './services/bookings.js';
import { markAttendance } from './services/attendance.js';
import { attendanceReport, memberRecord } from './services/reports.js';
import { listNotifications, markAllRead, runExpiryReminders } from './services/notifications.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * Builds the Express app. Everything it needs is passed in, so tests can use an in-memory
 * database and a fake clock (`now`), and the real server just passes the real ones.
 */
export function createApp({ db, config, now = () => new Date(), quiet = false }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '50kb' }));

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'",
    });
    next();
  });

  const auth = authenticate(db, config);
  const ctx = () => ({ now: now(), timeZone: config.timezone, cutoffMinutes: config.cutoffMinutes });
  const router = express.Router();

  // ───────────────────────── public ─────────────────────────
  router.get('/config', (_req, res) => {
    res.json({
      gymName: config.gymName,
      currency: config.currency,
      timezone: config.timezone,
      cutoffMinutes: config.cutoffMinutes,
      now: now().toISOString(),
    });
  });
  router.get('/plans', (_req, res) => res.json({ plans: listPlans(db) }));

  const loginLimiter = rateLimit({ windowMs: 60_000, max: config.loginRateMax ?? 10 });

  router.post('/auth/login', loginLimiter, wrap((req, res) => {
    const { email, password } = parse(schemas.login, req.body);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      burnPasswordTime(password);
      throw unauthorized('That email and password do not match.');
    }
    if (!checkPassword(password, user.password_hash)) throw unauthorized('That email and password do not match.');
    res.json({ token: signToken(user, config), user: publicUser(user) });
  }));

  router.post('/auth/register', loginLimiter, wrap((req, res) => {
    const { name, email, password } = parse(schemas.register, req.body);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw new AppError(409, 'EMAIL_TAKEN', 'An account with that email already exists.', { email: 'Already registered.' });
    }
    const info = db
      .prepare(`INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'member')`)
      .run(name, email, hashPassword(password));
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ token: signToken(user, config), user: publicUser(user) });
  }));

  // ───────────────────────── everything below needs a login ─────────────────────────
  router.use(auth);
  const member = requireRole('member');
  const admin = requireRole('admin');
  const staff = requireRole('admin', 'trainer');

  router.get('/auth/me', (req, res) => res.json({ user: req.user }));

  // Classes -------------------------------------------------------
  router.get('/classes', wrap((req, res) => {
    const { from, to } = dateWindow(req.query, config, now());
    const c = ctx();
    res.json({
      classes: listClasses(db, {
        from, to, viewerId: req.user.id, now: c.now, cutoffMinutes: c.cutoffMinutes,
        trainerId: req.query.mine === '1' && req.user.role === 'trainer' ? req.user.id : null,
      }),
    });
  }));

  router.get('/classes/:id', wrap((req, res) => {
    const c = ctx();
    res.json({ class: getClass(db, idParam(req.params.id), { viewerId: req.user.id, now: c.now, cutoffMinutes: c.cutoffMinutes }) });
  }));

  router.get('/classes/:id/roster', staff, wrap((req, res) => {
    const classId = idParam(req.params.id);
    assertOwnsClass(db, req.user, classId);
    res.json(getRoster(db, classId));
  }));

  router.post('/classes', admin, wrap((req, res) => {
    const input = parse(schemas.classCreate, req.body);
    res.status(201).json({ class: createClass(db, input, ctx()) });
  }));

  router.patch('/classes/:id', admin, wrap((req, res) => {
    const patch = parse(schemas.classUpdate, req.body);
    res.json(updateClass(db, idParam(req.params.id), patch, ctx()));
  }));

  router.post('/classes/:id/cancel', admin, wrap((req, res) => {
    res.json(cancelClass(db, idParam(req.params.id), ctx()));
  }));

  // Booking -------------------------------------------------------
  router.post('/classes/:id/book', member, wrap((req, res) => {
    const c = ctx();
    const result = bookClass(db, { userId: req.user.id, classId: idParam(req.params.id), ...c });
    res.status(201).json(result);
  }));

  router.delete('/classes/:id/book', member, wrap((req, res) => {
    const c = ctx();
    res.json(cancelBooking(db, { userId: req.user.id, classId: idParam(req.params.id), ...c }));
  }));

  // Staff can remove someone (ignores the 2-hour window); the waitlist still advances.
  router.delete('/classes/:id/bookings/:userId', admin, wrap((req, res) => {
    const c = ctx();
    res.json(cancelBooking(db, {
      userId: idParam(req.params.userId), classId: idParam(req.params.id), ...c, force: true, reason: 'removed_by_staff',
    }));
  }));

  router.post('/classes/:id/attendance', staff, wrap((req, res) => {
    const classId = idParam(req.params.id);
    const { records } = parse(schemas.attendance, req.body);
    res.json(markAttendance(db, { classId, records, actor: req.user, now: now() }));
  }));

  // "Me" ----------------------------------------------------------
  router.get('/me/bookings', member, wrap((req, res) => {
    const c = ctx();
    res.json(listMyBookings(db, req.user.id, { now: c.now, cutoffMinutes: c.cutoffMinutes }));
  }));
  router.get('/me/memberships', member, (req, res) => {
    res.json({ memberships: listMemberships(db, req.user.id, ctx()) });
  });
  router.post('/me/memberships', member, wrap((req, res) => {
    const { planId } = parse(schemas.membershipCreate, req.body);
    const c = ctx();
    res.status(201).json({ membership: createMembership(db, { userId: req.user.id, planId, now: c.now, timeZone: c.timeZone }) });
  }));
  router.get('/me/attendance', member, wrap((req, res) => {
    const { from, to } = recordWindow(req.query, config, now());
    res.json(memberRecord(db, req.user.id, { from, to, now: now() }));
  }));
  router.get('/me/notifications', (req, res) => res.json(listNotifications(db, req.user.id)));
  router.post('/me/notifications/read', (req, res) => {
    markAllRead(db, req.user.id, now());
    res.json({ ok: true });
  });

  // Admin ---------------------------------------------------------
  router.get('/admin/trainers', admin, (_req, res) => {
    res.json({ trainers: db.prepare(`SELECT id, name, email FROM users WHERE role = 'trainer' ORDER BY name`).all() });
  });

  router.get('/admin/members', admin, (_req, res) => {
    const c = ctx();
    const today = dateInTz(c.now, c.timeZone);
    const members = db.prepare(`SELECT id, name, email FROM users WHERE role = 'member' ORDER BY name`).all()
      .map((m) => {
        const ms = listMemberships(db, m.id, c);
        const active = ms.find((x) => x.status === 'active');
        const next = ms.filter((x) => x.status === 'upcoming').sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
        return {
          ...m,
          status: active ? 'active' : next ? 'upcoming' : 'inactive',
          planName: (active ?? next)?.planName ?? null,
          endDate: active?.endDate ?? null,
          memberships: ms,
        };
      });
    res.json({ today, members });
  });

  router.post('/admin/memberships', admin, wrap((req, res) => {
    const { userId, planId, startDate } = parse(schemas.membershipAdmin, req.body);
    const c = ctx();
    res.status(201).json({
      membership: createMembership(db, { userId, planId, startDate, byAdmin: true, now: c.now, timeZone: c.timeZone }),
    });
  }));

  router.delete('/admin/memberships/:id', admin, wrap((req, res) => {
    cancelMembership(db, idParam(req.params.id), { now: now() });
    res.json({ ok: true });
  }));

  router.get('/admin/expiring', admin, (req, res) => {
    const c = ctx();
    res.json({ expiring: expiringMemberships(db, { now: c.now, timeZone: c.timeZone, days: 14 }) });
  });

  router.post('/admin/reminders/run', admin, (_req, res) => {
    const c = ctx();
    res.json(runExpiryReminders(db, { now: c.now, timeZone: c.timeZone, reminderDays: config.reminderDays, log: logger(quiet) }));
  });

  router.get('/admin/reports/attendance', admin, wrap((req, res) => {
    const { from, to } = recordWindow(req.query, config, now());
    res.json({ from, to, rows: attendanceReport(db, { from, to, now: now() }) });
  }));

  router.get('/admin/reports/members/:id', admin, wrap((req, res) => {
    const { from, to } = recordWindow(req.query, config, now());
    res.json(memberRecord(db, idParam(req.params.id), { from, to, now: now() }));
  }));

  // Trainer: classes they lead (with rosters fetched on demand)
  router.get('/trainer/classes', requireRole('trainer'), wrap((req, res) => {
    const { from, to } = recordWindow(req.query, config, now());
    const c = ctx();
    res.json({ classes: listClasses(db, { from, to, trainerId: req.user.id, viewerId: -1, now: c.now, cutoffMinutes: c.cutoffMinutes }) });
  }));

  router.use((_req, _res, next) => next(notFound('No such endpoint.')));
  app.use('/api', router);

  // ───────────────────────── static frontend ─────────────────────────
  app.use(express.static(publicDir, { extensions: ['html'], maxAge: 0 }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  // ───────────────────────── errors ─────────────────────────
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, fields: err.fields } });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'BAD_JSON', message: 'The request body is not valid JSON.' } });
    }
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'The request is too large.' } });
    }
    const msg = String(err?.message ?? '');
    if (msg.includes('CAPACITY_EXCEEDED')) {
      return res.status(409).json({ error: { code: 'CAPACITY_EXCEEDED', message: 'That class has just filled up.' } });
    }
    if (msg.includes('CAPACITY_BELOW_BOOKINGS')) {
      return res.status(409).json({ error: { code: 'CAPACITY_BELOW_BOOKINGS', message: 'Capacity cannot go below the places already taken.' } });
    }
    if (err?.code === 'SQLITE_BUSY') {
      res.set('Retry-After', '1');
      return res.status(503).json({ error: { code: 'BUSY', message: 'The studio is busy. Please try again in a moment.' } });
    }
    if (!quiet) console.error('[error]', err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.' } });
  });

  return app;
}

// ───────────────────────── helpers ─────────────────────────
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });
const logger = (quiet) => (quiet ? () => {} : console.log);

function idParam(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('That id is not valid.');
  return n;
}

function assertOwnsClass(db, user, classId) {
  const cls = db.prepare('SELECT trainer_id FROM classes WHERE id = ?').get(classId);
  if (!cls) throw notFound('Class not found.');
  if (user.role === 'trainer' && cls.trainer_id !== user.id) throw forbidden('You can only see classes you lead.');
}

function readDate(value, label) {
  if (value === undefined || value === '') return undefined;
  if (!isValidDateString(value)) throw badRequest(`${label} must be a date like 2026-10-29.`, { [label.toLowerCase()]: 'Use YYYY-MM-DD.' });
  return value;
}

/** Schedule window: defaults to today .. +14 days; at most 62 days wide. */
function dateWindow(query, config, nowDate) {
  const today = dateInTz(nowDate, config.timezone);
  const from = readDate(query.from, 'From') ?? today;
  const to = readDate(query.to, 'To') ?? addDays(from, 14);
  if (to < from) throw badRequest('"To" must not be before "From".');
  if (Date.parse(to) - Date.parse(from) > 62 * 86_400_000) throw badRequest('Choose a range of at most 62 days.');
  return { from: zonedDayStart(from, config.timezone), to: zonedDayStart(addDays(to, 1), config.timezone) };
}

/** Reports / history window: defaults to the last 90 days. */
function recordWindow(query, config, nowDate) {
  const today = dateInTz(nowDate, config.timezone);
  const from = readDate(query.from, 'From') ?? addDays(today, -90);
  const to = readDate(query.to, 'To') ?? addDays(today, 30);
  if (to < from) throw badRequest('"To" must not be before "From".');
  return { from: zonedDayStart(from, config.timezone), to: zonedDayStart(addDays(to, 1), config.timezone) };
}
