import { addDays, daysBetween, dateInTz, formatWhen } from '../dates.js';

/** Stores an in-app notification. Called inside the same transaction as the event it describes. */
export function notify(db, userId, kind, message, refId = null, now = new Date()) {
  return db
    .prepare(`INSERT OR IGNORE INTO notifications (user_id, kind, message, ref_id, created_at)
              VALUES (?, ?, ?, ?, ?)`)
    .run(userId, kind, message, refId, now.toISOString());
}

export function listNotifications(db, userId, limit = 30) {
  const items = db
    .prepare(`SELECT id, kind, message, created_at AS createdAt, read_at AS readAt
                FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?`)
    .all(userId, limit);
  const unread = db
    .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .get(userId).n;
  return { unread, items };
}

export function markAllRead(db, userId, now = new Date()) {
  db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
    .run(now.toISOString(), userId);
}

/**
 * Membership expiry reminders (stretch goal).
 *
 * For every membership that ends within `reminderDays` and has no renewal queued behind it,
 * store ONE in-app notification (and log a simulated e-mail). The tightest applicable
 * threshold wins: <= 1 day => "expiry_1d", otherwise "expiry_7d". A unique index on
 * (kind, ref_id) makes the job idempotent, so running it every hour is harmless.
 */
export function runExpiryReminders(db, { now = new Date(), timeZone, reminderDays = 7, log = console.log } = {}) {
  const today = dateInTz(now, timeZone);
  const horizon = addDays(today, reminderDays);

  const due = db
    .prepare(`SELECT m.id, m.end_date AS endDate, u.id AS userId, u.name, u.email, p.name AS planName
                FROM memberships m
                JOIN users u ON u.id = m.user_id
                JOIN plans p ON p.id = m.plan_id
               WHERE m.cancelled_at IS NULL
                 AND u.role = 'member'
                 AND m.start_date <= ?        -- already running
                 AND m.end_date >= ? AND m.end_date <= ?
                 AND NOT EXISTS (             -- no renewal queued behind it
                       SELECT 1 FROM memberships r
                        WHERE r.user_id = m.user_id AND r.cancelled_at IS NULL
                          AND r.start_date > m.end_date)`)
    .all(today, today, horizon);

  let sent = 0;
  for (const m of due) {
    const daysLeft = daysBetween(today, m.endDate);
    const kind = daysLeft <= 1 ? 'expiry_1d' : 'expiry_7d';
    const when = daysLeft === 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;
    const message = `Your ${m.planName} membership ends ${when} (${m.endDate}). Renew to keep reserving classes.`;
    const res = notify(db, m.userId, kind, message, m.id, now);
    if (res.changes > 0) {
      sent += 1;
      log(`[reminder] e-mail (simulated) to ${m.email}: ${message}`);
    }
  }
  return { checked: due.length, sent };
}

export { formatWhen };
