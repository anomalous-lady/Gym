import { conflict, forbidden, notFound } from '../errors.js';

/**
 * Trainers mark attendance for their own classes (admins may mark any class).
 * Marking opens when the class starts, and only people who hold a place can be marked.
 * `records` is [{ userId, status: 'attended' | 'absent' }]; all-or-nothing in one transaction.
 */
export function markAttendance(db, { classId, records, actor, now }) {
  const run = db.transaction(() => {
    const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
    if (!cls) throw notFound('Class not found.');
    if (actor.role === 'trainer' && cls.trainer_id !== actor.id) {
      throw forbidden('You can only mark attendance for classes you lead.');
    }
    if (cls.cancelled_at) throw conflict('CLASS_CANCELLED', 'This class has been cancelled.');
    if (now.getTime() < Date.parse(cls.starts_at)) {
      throw conflict('CLASS_NOT_STARTED', 'Attendance can be marked once the class has begun.');
    }

    const find = db.prepare(
      `SELECT id FROM bookings WHERE class_id = ? AND user_id = ? AND status IN ('booked', 'attended', 'absent')`);
    const update = db.prepare(
      `UPDATE bookings SET status = ?, attendance_marked_by = ?, attendance_marked_at = ? WHERE id = ?`);

    for (const r of records) {
      const booking = find.get(classId, r.userId);
      if (!booking) throw notFound(`Member ${r.userId} does not hold a place in this class.`);
      update.run(r.status, actor.id, now.toISOString(), booking.id);
    }
    return records.length;
  });
  return { updated: run.immediate() };
}
