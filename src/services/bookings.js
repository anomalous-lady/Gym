import { AppError, conflict, notFound } from '../errors.js';
import { formatWhen } from '../dates.js';
import { canHoldPlace } from './memberships.js';
import { notify } from './notifications.js';

/*
 * ──────────────────────────────────────────────────────────────────────────────
 *  HOW CAPACITY IS PROTECTED
 *
 *  Every operation that changes who holds a place (book, cancel, promote, capacity
 *  change) runs inside `db.transaction(fn).immediate()`, which issues BEGIN IMMEDIATE.
 *  That takes SQLite's write lock BEFORE the first read, so two requests racing for the
 *  last place cannot both read "1 place free": the second one waits (busy_timeout) until
 *  the first has committed, then sees "0 free" and is put on the waitlist instead.
 *
 *  A database trigger (schema.sql) is the backstop: if a bug ever tried to exceed
 *  capacity, the INSERT/UPDATE would be rejected with CAPACITY_EXCEEDED.
 *
 *  The waitlist is promoted INSIDE the same transaction as the cancellation, so there is
 *  no window in which a place is free but unassigned, and no way for a new booker to
 *  "jump the queue". Queue order is the booking row id (AUTOINCREMENT = join order).
 * ──────────────────────────────────────────────────────────────────────────────
 */

const OCCUPYING = `('booked', 'attended', 'absent')`;

const loadClass = (db, id) => db.prepare('SELECT * FROM classes WHERE id = ?').get(id);

const occupiedCount = (db, classId) =>
  db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE class_id = ? AND status IN ${OCCUPYING}`).get(classId).n;

const waitlistCount = (db, classId) =>
  db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE class_id = ? AND status = 'waitlisted'`).get(classId).n;

const queuePosition = (db, classId, bookingId) =>
  db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE class_id = ? AND status = 'waitlisted' AND id <= ?`)
    .get(classId, bookingId).n;

const hoursLabel = (minutes) =>
  minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} minutes`;

/**
 * Fill any free places from the head of the waitlist, strictly in order.
 * Must be called inside a transaction. A waitlisted member whose membership has lapsed
 * is dropped (and told why) rather than blocking everyone behind them.
 */
export function promoteWaitlist(db, classId, { now, timeZone }) {
  const cls = loadClass(db, classId);
  const promoted = [];
  const dropped = [];
  if (!cls || cls.cancelled_at) return { promoted, dropped };

  const nowIso = now.toISOString();
  const when = formatWhen(cls.starts_at, timeZone);

  for (;;) {
    if (occupiedCount(db, classId) >= cls.capacity) break; // full again: stop
    const next = db
      .prepare(`SELECT id, user_id FROM bookings WHERE class_id = ? AND status = 'waitlisted' ORDER BY id LIMIT 1`)
      .get(classId);
    if (!next) break; // nobody waiting

    if (canHoldPlace(db, next.user_id, { now, timeZone, classStartsAt: cls.starts_at })) {
      db.prepare(`UPDATE bookings SET status = 'booked', promoted_at = ? WHERE id = ?`).run(nowIso, next.id);
      notify(db, next.user_id, 'waitlist_promoted',
        `A place opened up. You are now booked into ${cls.title}, ${when}.`, classId, now);
      promoted.push(next.user_id);
    } else {
      db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancel_reason = 'membership_inactive' WHERE id = ?`)
        .run(nowIso, next.id);
      notify(db, next.user_id, 'waitlist_dropped',
        `You were removed from the waitlist for ${cls.title}, ${when}, because your membership is not active.`, classId, now);
      dropped.push(next.user_id);
    }
  }
  return { promoted, dropped };
}

/** Reserve a place, or join the waitlist if the class is full. */
export function bookClass(db, { userId, classId, now, timeZone, cutoffMinutes }) {
  const run = db.transaction(() => {
    const cls = loadClass(db, classId);
    if (!cls) throw notFound('Class not found.');
    if (cls.cancelled_at) throw conflict('CLASS_CANCELLED', 'This class has been cancelled.');

    const closesAt = Date.parse(cls.starts_at) - cutoffMinutes * 60_000;
    if (now.getTime() > closesAt) {
      throw conflict('BOOKING_CLOSED',
        `Booking closes ${hoursLabel(cutoffMinutes)} before the class begins.`);
    }

    if (!canHoldPlace(db, userId, { now, timeZone, classStartsAt: cls.starts_at })) {
      throw new AppError(403, 'MEMBERSHIP_INACTIVE',
        'An active membership is required to reserve a class. Yours is not active on the day of this class.');
    }

    const existing = db
      .prepare(`SELECT status FROM bookings WHERE class_id = ? AND user_id = ? AND status <> 'cancelled'`)
      .get(classId, userId);
    if (existing) {
      throw conflict('ALREADY_BOOKED',
        existing.status === 'waitlisted' ? 'You are already on the waitlist for this class.'
                                          : 'You already hold a place in this class.');
    }

    // Safety net: places free while people are queued should be impossible (we promote on
    // every cancellation), but if it ever happens, settle the queue first so nobody jumps it.
    if (occupiedCount(db, classId) < cls.capacity && waitlistCount(db, classId) > 0) {
      promoteWaitlist(db, classId, { now, timeZone });
    }

    const free = cls.capacity - occupiedCount(db, classId);
    const status = free > 0 && waitlistCount(db, classId) === 0 ? 'booked' : 'waitlisted';

    const info = db
      .prepare(`INSERT INTO bookings (class_id, user_id, status, created_at) VALUES (?, ?, ?, ?)`)
      .run(classId, userId, status, now.toISOString());

    return {
      bookingId: Number(info.lastInsertRowid),
      status,
      position: status === 'waitlisted' ? queuePosition(db, classId, info.lastInsertRowid) : null,
    };
  });
  return run.immediate();
}

/**
 * Cancel a reserved place or leave the waitlist.
 *  - A reserved place can be released up to `cutoffMinutes` before the start.
 *  - Leaving a waitlist is allowed until the class starts.
 *  - `force` is for staff removing someone (ignores the window).
 * If a reserved place is released, the waitlist is promoted in the same transaction.
 */
export function cancelBooking(db, { userId, classId, now, timeZone, cutoffMinutes, force = false, reason = 'member' }) {
  const run = db.transaction(() => {
    const cls = loadClass(db, classId);
    if (!cls) throw notFound('Class not found.');

    const booking = db
      .prepare(`SELECT id, status FROM bookings
                 WHERE class_id = ? AND user_id = ? AND status IN ('booked', 'waitlisted')`)
      .get(classId, userId);
    if (!booking) throw notFound('There is no active booking for this class.');

    const startMs = Date.parse(cls.starts_at);
    if (!force) {
      if (booking.status === 'booked' && now.getTime() > startMs - cutoffMinutes * 60_000) {
        throw conflict('CANCEL_WINDOW_CLOSED',
          `A place can be released up to ${hoursLabel(cutoffMinutes)} before the class begins. That window has closed.`);
      }
      if (booking.status === 'waitlisted' && now.getTime() >= startMs) {
        throw conflict('CLASS_STARTED', 'This class has already started.');
      }
    }

    db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancel_reason = ? WHERE id = ?`)
      .run(now.toISOString(), reason, booking.id);

    let outcome = { promoted: [], dropped: [] };
    if (booking.status === 'booked') {
      outcome = promoteWaitlist(db, classId, { now, timeZone }); // same transaction
    }
    return { status: 'cancelled', wasStatus: booking.status, ...outcome };
  });
  return run.immediate();
}

/** A member's own bookings, split into upcoming and past, with what they can still do. */
export function listMyBookings(db, userId, { now, cutoffMinutes }) {
  const rows = db
    .prepare(`SELECT b.id AS bookingId, b.status, b.promoted_at AS promotedAt,
                     c.id AS classId, c.title, c.category, c.starts_at AS startsAt, c.ends_at AS endsAt,
                     c.duration_min AS durationMin, c.capacity, t.name AS trainerName,
                     CASE WHEN b.status = 'waitlisted' THEN
                       (SELECT COUNT(*) FROM bookings w
                         WHERE w.class_id = b.class_id AND w.status = 'waitlisted' AND w.id <= b.id) END AS position
                FROM bookings b
                JOIN classes c ON c.id = b.class_id
                JOIN users t ON t.id = c.trainer_id
               WHERE b.user_id = ? AND b.status <> 'cancelled'
               ORDER BY c.starts_at`)
    .all(userId);

  const nowMs = now.getTime();
  const shaped = rows.map((r) => {
    const startMs = Date.parse(r.startsAt);
    const cutoffAt = new Date(startMs - cutoffMinutes * 60_000).toISOString();
    const upcoming = nowMs < startMs;
    const canCancel =
      r.status === 'booked' ? nowMs <= startMs - cutoffMinutes * 60_000
      : r.status === 'waitlisted' ? upcoming
      : false;
    return { ...r, cutoffAt, upcoming, canCancel };
  });
  return {
    upcoming: shaped.filter((r) => r.upcoming),
    past: shaped.filter((r) => !r.upcoming).reverse(),
  };
}
