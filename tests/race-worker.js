// Child process used by the concurrency test: opens the SAME database file as its own
// connection and tries to book. Real parallelism - several of these start at once.
import { openDb } from '../src/db.js';
import { bookClass } from '../src/services/bookings.js';

const [file, classId, userId, startAtMs] = process.argv.slice(2);
const db = openDb(file);
while (Date.now() < Number(startAtMs)) { /* spin until the shared start line so all workers collide */ }
try {
  const r = bookClass(db, {
    userId: Number(userId), classId: Number(classId),
    now: new Date('2030-06-10T10:00:00.000Z'), timeZone: 'Asia/Kolkata', cutoffMinutes: 120,
  });
  console.log(JSON.stringify({ ok: true, status: r.status }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.code || e.message }));
}
db.close();
