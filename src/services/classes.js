import { badRequest, conflict, notFound } from '../errors.js';
import { formatWhen } from '../dates.js';
import { notify } from './notifications.js';
import { promoteWaitlist } from './bookings.js';

const CLASS_SELECT = `
  SELECT c.id, c.title, c.category, c.description,
         c.trainer_id AS trainerId, t.name AS trainerName,
         c.starts_at AS startsAt, c.ends_at AS endsAt, c.duration_min AS durationMin,
         c.capacity, c.cancelled_at AS cancelledAt,
         (SELECT COUNT(*) FROM bookings b
           WHERE b.class_id = c.id AND b.status IN ('booked', 'attended', 'absent')) AS bookedCount,
         (SELECT COUNT(*) FROM bookings b
           WHERE b.class_id = c.id AND b.status = 'waitlisted') AS waitlistCount,
         mb.status AS myStatus,
         CASE WHEN mb.status = 'waitlisted' THEN
           (SELECT COUNT(*) FROM bookings w
             WHERE w.class_id = c.id AND w.status = 'waitlisted' AND w.id <= mb.id) END AS myPosition
    FROM classes c
    JOIN users t ON t.id = c.trainer_id
    LEFT JOIN bookings mb
           ON mb.class_id = c.id AND mb.user_id = @viewer AND mb.status <> 'cancelled'`;

/**
 * Turns a DB row into what the UI needs, including the derived `state`:
 *   open | full | closed (booking window shut) | in_progress | finished | cancelled
 */
function shape(row, { now, cutoffMinutes }) {
  const nowMs = now.getTime();
  const startMs = Date.parse(row.startsAt);
  const endMs = Date.parse(row.endsAt);
  const cutoffMs = startMs - cutoffMinutes * 60_000;

  let state;
  if (row.cancelledAt) state = 'cancelled';
  else if (nowMs >= endMs) state = 'finished';
  else if (nowMs >= startMs) state = 'in_progress';
  else if (nowMs > cutoffMs) state = 'closed';
  else state = row.bookedCount >= row.capacity ? 'full' : 'open';

  return {
    id: row.id,
    title: row.title,
    category: row.category,
    description: row.description,
    trainer: { id: row.trainerId, name: row.trainerName },
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    durationMin: row.durationMin,
    capacity: row.capacity,
    booked: row.bookedCount,
    seatsLeft: Math.max(0, row.capacity - row.bookedCount),
    waitlistCount: row.waitlistCount,
    state,
    cutoffAt: new Date(cutoffMs).toISOString(),
    my: row.myStatus ? { status: row.myStatus, position: row.myPosition ?? null } : null,
  };
}

export function listClasses(db, { from, to, viewerId = -1, trainerId = null, now, cutoffMinutes }) {
  const rows = db
    .prepare(`${CLASS_SELECT}
              WHERE c.starts_at >= @from AND c.starts_at < @to
                AND (@trainer IS NULL OR c.trainer_id = @trainer)
              ORDER BY c.starts_at, c.id`)
    .all({ from, to, viewer: viewerId, trainer: trainerId });
  return rows.map((r) => shape(r, { now, cutoffMinutes }));
}

export function getClass(db, id, { viewerId = -1, now, cutoffMinutes }) {
  const row = db.prepare(`${CLASS_SELECT} WHERE c.id = @id`).get({ id, viewer: viewerId });
  if (!row) throw notFound('Class not found.');
  return shape(row, { now, cutoffMinutes });
}

/** Everyone attached to a class: who holds a place, and the waitlist in queue order. */
export function getRoster(db, classId) {
  const cls = db.prepare('SELECT id FROM classes WHERE id = ?').get(classId);
  if (!cls) throw notFound('Class not found.');
  const rows = db
    .prepare(`SELECT b.id AS bookingId, b.user_id AS userId, u.name, u.email, b.status,
                     b.created_at AS bookedAt, b.promoted_at AS promotedAt,
                     b.attendance_marked_at AS markedAt
                FROM bookings b JOIN users u ON u.id = b.user_id
               WHERE b.class_id = ? AND b.status <> 'cancelled'
               ORDER BY b.id`)
    .all(classId);
  const attendees = rows.filter((r) => r.status !== 'waitlisted');
  const waitlist = rows
    .filter((r) => r.status === 'waitlisted')
    .map((r, i) => ({ ...r, position: i + 1 }));
  return { attendees, waitlist };
}

function assertTrainer(db, trainerId) {
  const t = db.prepare(`SELECT id FROM users WHERE id = ? AND role = 'trainer'`).get(trainerId);
  if (!t) throw badRequest('Choose a trainer.', { trainerId: 'Choose a valid trainer.' });
}

function assertTrainerFree(db, trainerId, startsAt, endsAt, ignoreClassId = -1) {
  const clash = db
    .prepare(`SELECT title, starts_at FROM classes
               WHERE trainer_id = ? AND cancelled_at IS NULL AND id <> ?
                 AND starts_at < ? AND ends_at > ? LIMIT 1`)
    .get(trainerId, ignoreClassId, endsAt, startsAt);
  if (clash) {
    throw conflict('TRAINER_BUSY', `That trainer already leads "${clash.title}" at an overlapping time.`);
  }
}

const endOf = (startsAt, durationMin) => new Date(Date.parse(startsAt) + durationMin * 60_000).toISOString();

export function createClass(db, input, ctx) {
  const run = db.transaction(() => {
    assertTrainer(db, input.trainerId);
    if (Date.parse(input.startsAt) <= ctx.now.getTime()) {
      throw badRequest('A class must start in the future.', { startsAt: 'Pick a time in the future.' });
    }
    const endsAt = endOf(input.startsAt, input.durationMin);
    assertTrainerFree(db, input.trainerId, input.startsAt, endsAt);
    const info = db
      .prepare(`INSERT INTO classes (title, category, description, trainer_id, starts_at, ends_at, duration_min, capacity)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.title, input.category, input.description ?? '', input.trainerId,
           input.startsAt, endsAt, input.durationMin, input.capacity);
    return Number(info.lastInsertRowid);
  });
  const id = run.immediate();
  return getClass(db, id, ctx);
}

export function updateClass(db, id, patch, ctx) {
  const run = db.transaction(() => {
    const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(id);
    if (!cls) throw notFound('Class not found.');
    if (cls.cancelled_at) throw conflict('CLASS_CANCELLED', 'This class has been cancelled.');
    if (Date.parse(cls.starts_at) <= ctx.now.getTime()) {
      throw conflict('CLASS_STARTED', 'A class that has started can no longer be edited.');
    }

    const next = {
      title: patch.title ?? cls.title,
      category: patch.category ?? cls.category,
      description: patch.description ?? cls.description,
      trainerId: patch.trainerId ?? cls.trainer_id,
      startsAt: patch.startsAt ?? cls.starts_at,
      durationMin: patch.durationMin ?? cls.duration_min,
      capacity: patch.capacity ?? cls.capacity,
    };

    const timeChanged = next.startsAt !== cls.starts_at || next.durationMin !== cls.duration_min;
    if (timeChanged) {
      const people = db
        .prepare(`SELECT COUNT(*) AS n FROM bookings WHERE class_id = ? AND status IN ('booked', 'waitlisted')`)
        .get(id).n;
      if (people > 0) {
        throw conflict('HAS_BOOKINGS',
          'This class already has bookings, so its time cannot move. Cancel it and create a new one instead.');
      }
      if (Date.parse(next.startsAt) <= ctx.now.getTime()) {
        throw badRequest('A class must start in the future.', { startsAt: 'Pick a time in the future.' });
      }
    }

    if (next.trainerId !== cls.trainer_id) assertTrainer(db, next.trainerId);
    const endsAt = endOf(next.startsAt, next.durationMin);
    // Only re-check clashes when who or when actually changed (a capacity edit must always work).
    if (timeChanged || next.trainerId !== cls.trainer_id) {
      assertTrainerFree(db, next.trainerId, next.startsAt, endsAt, id);
    }

    const taken = db
      .prepare(`SELECT COUNT(*) AS n FROM bookings WHERE class_id = ? AND status IN ('booked', 'attended', 'absent')`)
      .get(id).n;
    if (next.capacity < taken) {
      throw conflict('CAPACITY_BELOW_BOOKINGS',
        `${taken} places are already taken, so capacity cannot go below ${taken}.`);
    }

    db.prepare(`UPDATE classes SET title = ?, category = ?, description = ?, trainer_id = ?,
                                   starts_at = ?, ends_at = ?, duration_min = ?, capacity = ? WHERE id = ?`)
      .run(next.title, next.category, next.description, next.trainerId,
           next.startsAt, endsAt, next.durationMin, next.capacity, id);

    // More places than before? Let the waitlist fill them, in order.
    let promoted = [];
    if (next.capacity > cls.capacity) {
      promoted = promoteWaitlist(db, id, ctx).promoted;
    }
    return promoted.length;
  });
  const promoted = run.immediate();
  return { class: getClass(db, id, ctx), promoted };
}

/** Cancel a future class: everyone holding a place or waiting is released and told. */
export function cancelClass(db, id, ctx) {
  const run = db.transaction(() => {
    const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(id);
    if (!cls) throw notFound('Class not found.');
    if (cls.cancelled_at) throw conflict('CLASS_CANCELLED', 'This class is already cancelled.');
    if (Date.parse(cls.starts_at) <= ctx.now.getTime()) {
      throw conflict('CLASS_STARTED', 'A class that has started cannot be cancelled.');
    }

    const nowIso = ctx.now.toISOString();
    db.prepare('UPDATE classes SET cancelled_at = ? WHERE id = ?').run(nowIso, id);

    const people = db
      .prepare(`SELECT id, user_id FROM bookings WHERE class_id = ? AND status IN ('booked', 'waitlisted')`)
      .all(id);
    const when = formatWhen(cls.starts_at, ctx.timeZone);
    for (const p of people) {
      db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancel_reason = 'class_cancelled' WHERE id = ?`)
        .run(nowIso, p.id);
      notify(db, p.user_id, 'class_cancelled', `${cls.title} on ${when} has been cancelled.`, id, ctx.now);
    }
    return people.length;
  });
  return { released: run.immediate() };
}
