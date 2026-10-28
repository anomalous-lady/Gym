import { notFound } from '../errors.js';

const rate = (attended, held) => (held > 0 ? Math.round((attended / held) * 100) : null);

/**
 * Attendance per member (stretch goal), over classes that start in [from, to).
 *   attended  trainer marked present
 *   absent    trainer marked absent
 *   unmarked  held a place in a class that has finished/started but nobody marked it
 *   upcoming  holds a place in a future class (not counted in the rate)
 * rate = attended / (attended + absent + unmarked)
 */
export function attendanceReport(db, { from, to, now }) {
  const rows = db
    .prepare(`SELECT u.id, u.name, u.email,
                     COALESCE(SUM(x.status = 'attended'), 0) AS attended,
                     COALESCE(SUM(x.status = 'absent'), 0) AS absent,
                     COALESCE(SUM(x.status = 'booked' AND x.starts_at <= @now), 0) AS unmarked,
                     COALESCE(SUM(x.status = 'booked' AND x.starts_at > @now), 0) AS upcoming,
                     MAX(CASE WHEN x.status = 'attended' THEN x.starts_at END) AS lastAttended
                FROM users u
                LEFT JOIN (
                  SELECT b.user_id, b.status, c.starts_at
                    FROM bookings b JOIN classes c ON c.id = b.class_id
                   WHERE b.status IN ('booked', 'attended', 'absent')
                     AND c.starts_at >= @from AND c.starts_at < @to
                ) x ON x.user_id = u.id
               WHERE u.role = 'member'
               GROUP BY u.id
               ORDER BY attended DESC, u.name`)
    .all({ from, to, now: now.toISOString() });

  return rows.map((r) => ({
    ...r,
    held: r.attended + r.absent + r.unmarked,
    rate: rate(r.attended, r.attended + r.absent + r.unmarked),
  }));
}

/** One member's record: summary plus the list of classes (newest first). */
export function memberRecord(db, userId, { from, to, now }) {
  const member = db.prepare(`SELECT id, name, email FROM users WHERE id = ? AND role = 'member'`).get(userId);
  if (!member) throw notFound('Member not found.');

  const sessions = db
    .prepare(`SELECT b.status, c.id AS classId, c.title, c.category, c.starts_at AS startsAt, t.name AS trainerName
                FROM bookings b
                JOIN classes c ON c.id = b.class_id
                JOIN users t ON t.id = c.trainer_id
               WHERE b.user_id = ? AND b.status IN ('booked', 'attended', 'absent')
                 AND c.starts_at >= ? AND c.starts_at < ?
               ORDER BY c.starts_at DESC`)
    .all(userId, from, to);

  const nowIso = now.toISOString();
  const attended = sessions.filter((s) => s.status === 'attended').length;
  const absent = sessions.filter((s) => s.status === 'absent').length;
  const unmarked = sessions.filter((s) => s.status === 'booked' && s.startsAt <= nowIso).length;
  const upcoming = sessions.filter((s) => s.status === 'booked' && s.startsAt > nowIso).length;
  const held = attended + absent + unmarked;

  return {
    member,
    summary: { attended, absent, unmarked, upcoming, held, rate: rate(attended, held) },
    sessions: sessions.map((s) => ({
      ...s,
      status: s.status === 'booked' ? (s.startsAt <= nowIso ? 'unmarked' : 'upcoming') : s.status,
    })),
  };
}
