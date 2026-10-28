import { AppError, conflict, notFound, badRequest } from '../errors.js';
import { addDays, addMonths, dateInTz, isValidDateString } from '../dates.js';

/** active | upcoming | expired | cancelled  (derived from dates, never stored) */
export function membershipStatus(m, today) {
  if (m.cancelledAt ?? m.cancelled_at) return 'cancelled';
  const start = m.startDate ?? m.start_date;
  const end = m.endDate ?? m.end_date;
  if (today < start) return 'upcoming';
  if (today > end) return 'expired';
  return 'active';
}

const SELECT_MEMBERSHIP = `
  SELECT m.id, m.user_id AS userId, m.plan_id AS planId, m.start_date AS startDate,
         m.end_date AS endDate, m.cancelled_at AS cancelledAt, m.created_at AS createdAt,
         p.code AS planCode, p.name AS planName, p.price_cents AS priceCents
    FROM memberships m JOIN plans p ON p.id = m.plan_id`;

export function listPlans(db) {
  return db
    .prepare('SELECT id, code, name, months, price_cents AS priceCents, blurb FROM plans ORDER BY months')
    .all();
}

export function listMemberships(db, userId, { now, timeZone }) {
  const today = dateInTz(now, timeZone);
  return db
    .prepare(`${SELECT_MEMBERSHIP} WHERE m.user_id = ? ORDER BY m.start_date DESC, m.id DESC`)
    .all(userId)
    .map((m) => ({ ...m, status: membershipStatus(m, today) }));
}

/** Is the member covered by a (non-cancelled) membership on the given calendar day? */
export function isActiveOn(db, userId, dateStr) {
  return !!db
    .prepare(`SELECT 1 FROM memberships
               WHERE user_id = ? AND cancelled_at IS NULL AND start_date <= ? AND end_date >= ? LIMIT 1`)
    .get(userId, dateStr, dateStr);
}

/**
 * The rule behind "only active members can book":
 * the member must be active TODAY and still be covered on the day of the class.
 */
export function canHoldPlace(db, userId, { now, timeZone, classStartsAt }) {
  const today = dateInTz(now, timeZone);
  const classDay = dateInTz(new Date(classStartsAt), timeZone);
  return isActiveOn(db, userId, today) && isActiveOn(db, userId, classDay);
}

/**
 * Buy / grant a membership.
 *  - Members buying for themselves: starts today, or the day after their latest
 *    membership ends (a renewal queues behind the current one).
 *  - Admins may pass an explicit startDate; overlapping an existing membership is refused.
 */
export function createMembership(db, { userId, planId, startDate, byAdmin = false, now, timeZone }) {
  const run = db.transaction(() => {
    const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
    if (!user) throw notFound('Member not found.');
    if (user.role !== 'member') throw badRequest('Only members hold memberships.');

    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
    if (!plan) throw badRequest('Unknown plan.', { planId: 'Choose a valid plan.' });

    const today = dateInTz(now, timeZone);
    const latest = db
      .prepare(`SELECT MAX(end_date) AS e FROM memberships WHERE user_id = ? AND cancelled_at IS NULL`)
      .get(userId).e;

    let start;
    if (startDate) {
      if (!byAdmin) throw badRequest('Members cannot choose a start date.');
      if (!isValidDateString(startDate)) throw badRequest('Invalid start date.', { startDate: 'Use YYYY-MM-DD.' });
      if (startDate < addDays(today, -365) || startDate > addDays(today, 365)) {
        throw badRequest('Start date must be within a year of today.', { startDate: 'Within a year of today, please.' });
      }
      start = startDate;
    } else {
      start = latest && latest >= today ? addDays(latest, 1) : today;
    }
    const end = addDays(addMonths(start, plan.months), -1);

    if (!byAdmin) {
      // Stop accidental double purchases: at most one renewal queued behind the current plan.
      const live = db
        .prepare(`SELECT COUNT(*) AS n FROM memberships
                   WHERE user_id = ? AND cancelled_at IS NULL AND end_date >= ?`)
        .get(userId, today).n;
      if (live >= 2) {
        throw conflict('MEMBERSHIP_LIMIT', 'A renewal is already scheduled behind your current membership.');
      }
    }

    const overlap = db
      .prepare(`SELECT start_date AS s, end_date AS e FROM memberships
                 WHERE user_id = ? AND cancelled_at IS NULL AND start_date <= ? AND end_date >= ? LIMIT 1`)
      .get(userId, end, start);
    if (overlap) {
      throw conflict('MEMBERSHIP_OVERLAP', `That period overlaps an existing membership (${overlap.s} to ${overlap.e}).`);
    }

    const info = db
      .prepare('INSERT INTO memberships (user_id, plan_id, start_date, end_date) VALUES (?, ?, ?, ?)')
      .run(userId, planId, start, end);
    const row = db.prepare(`${SELECT_MEMBERSHIP} WHERE m.id = ?`).get(info.lastInsertRowid);
    return { ...row, status: membershipStatus(row, today) };
  });
  return run.immediate();
}

export function cancelMembership(db, membershipId, { now }) {
  const info = db
    .prepare('UPDATE memberships SET cancelled_at = ? WHERE id = ? AND cancelled_at IS NULL')
    .run(now.toISOString(), membershipId);
  if (info.changes === 0) throw new AppError(404, 'NOT_FOUND', 'Membership not found or already cancelled.');
}

/** Active memberships ending within `days` days (admin dashboard + reminders). */
export function expiringMemberships(db, { now, timeZone, days = 14 }) {
  const today = dateInTz(now, timeZone);
  return db
    .prepare(`SELECT m.id, m.end_date AS endDate, u.id AS userId, u.name, u.email, p.name AS planName,
                     EXISTS (SELECT 1 FROM memberships r
                              WHERE r.user_id = m.user_id AND r.cancelled_at IS NULL
                                AND r.start_date > m.end_date) AS renewed
                FROM memberships m
                JOIN users u ON u.id = m.user_id
                JOIN plans p ON p.id = m.plan_id
               WHERE m.cancelled_at IS NULL AND m.start_date <= ? AND m.end_date >= ? AND m.end_date <= ?
               ORDER BY m.end_date, u.name`)
    .all(today, today, addDays(today, days))
    .map((r) => ({ ...r, renewed: !!r.renewed }));
}
