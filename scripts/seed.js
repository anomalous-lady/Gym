// Loads demo data so the app can be tried straight away.
//   npm run seed
// WARNING: wipes users, memberships, classes, bookings and notifications first.
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { addDays, addMonths, dateInTz, zonedTime } from '../src/dates.js';

export const DEMO_PASSWORD = 'Aurelian2026';

export const DEMO_USERS = [
  { name: 'Lady Arabella Ashworth', email: 'admin@aurelian.club', role: 'admin' },
  { name: 'Sebastian Hale', email: 'sebastian@aurelian.club', role: 'trainer' },
  { name: 'Isolde Varga', email: 'isolde@aurelian.club', role: 'trainer' },
  { name: 'Dorian Okafor', email: 'dorian@aurelian.club', role: 'trainer' },
  { name: 'Pritama Patra', email: 'priti@aurelian.club', role: 'member' },       // active, quarterly
  { name: 'Cassius Mehta', email: 'cassius@aurelian.club', role: 'member' },     // active, monthly
  { name: 'Octavia Rao', email: 'octavia@aurelian.club', role: 'member' },       // active, expires in 3 days (reminder)
  { name: 'Lucian Fernandes', email: 'lucian@aurelian.club', role: 'member' },   // active
  { name: 'Marguerite Das', email: 'marguerite@aurelian.club', role: 'member' }, // active
  { name: 'Percival Nair', email: 'percival@aurelian.club', role: 'member' },    // active
  { name: 'Evander Khan', email: 'evander@aurelian.club', role: 'member' },      // EXPIRED - cannot book
  { name: 'Rosalind Iyer', email: 'rosalind@aurelian.club', role: 'member' },    // no membership yet
];

export function seed(db, { now = new Date(), timeZone = 'Asia/Kolkata' } = {}) {
  const today = dateInTz(now, timeZone);
  const hash = hashPassword(DEMO_PASSWORD);

  db.exec(`DELETE FROM notifications; DELETE FROM bookings; DELETE FROM classes;
           DELETE FROM memberships; DELETE FROM users;
           DELETE FROM sqlite_sequence WHERE name IN ('notifications','bookings','classes','memberships','users');`);

  const userId = {};
  const insUser = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)');
  for (const u of DEMO_USERS) userId[u.email.split('@')[0]] = Number(insUser.run(u.name, u.email, hash, u.role).lastInsertRowid);

  const plan = Object.fromEntries(db.prepare('SELECT id, code, months FROM plans').all().map((p) => [p.code, p]));
  const insMem = db.prepare('INSERT INTO memberships (user_id, plan_id, start_date, end_date) VALUES (?, ?, ?, ?)');
  const grant = (who, code, start) => {
    const p = plan[code];
    insMem.run(userId[who], p.id, start, addDays(addMonths(start, p.months), -1));
  };
  grant('priti', 'quarterly', addDays(today, -20));
  grant('cassius', 'monthly', addDays(today, -10));
  grant('lucian', 'monthly', addDays(today, -5));
  grant('marguerite', 'quarterly', addDays(today, -40));
  grant('percival', 'monthly', addDays(today, -2));
  // Octavia: a monthly plan that ends in 3 days -> triggers the expiry reminder.
  insMem.run(userId.octavia, plan.monthly.id, addDays(today, -27), addDays(today, 3));
  // Evander: lapsed ten days ago.
  insMem.run(userId.evander, plan.monthly.id, addDays(today, -40), addDays(today, -10));

  const insClass = db.prepare(`INSERT INTO classes (title, category, description, trainer_id, starts_at, ends_at, duration_min, capacity)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const addClass = (dayOffset, hhmm, title, category, description, trainer, durationMin, capacity) => {
    const startsAt = zonedTime(addDays(today, dayOffset), hhmm, timeZone);
    const endsAt = new Date(Date.parse(startsAt) + durationMin * 60_000).toISOString();
    return Number(insClass.run(title, category, description, userId[trainer], startsAt, endsAt, durationMin, capacity).lastInsertRowid);
  };

  // A fortnight of future classes. The 07:00 / 18:00 slots are far enough out to be bookable.
  const catalogue = [
    ['06:30', 'Sunrise Vinyasa', 'Yoga', 'Breath-led flow to open the day.', 'isolde', 60, 12],
    ['07:30', 'Reformer Foundations', 'Pilates', 'Controlled strength on the reformer.', 'isolde', 50, 8],
    ['12:30', 'Midday HIIT', 'HIIT', 'Forty minutes, no mercy, thorough warm-down.', 'sebastian', 45, 10],
    ['18:00', 'Barbell Club', 'Strength', 'Technique and progressive load.', 'dorian', 60, 6],
    ['19:30', 'Evening Yin', 'Yoga', 'Long holds, quiet room, low light.', 'isolde', 60, 12],
  ];
  for (let d = 1; d <= 13; d += 1) {
    const dow = new Date(`${addDays(today, d)}T00:00:00Z`).getUTCDay();
    catalogue.forEach((c, i) => {
      // Vary the week a little so the schedule feels curated, not generated.
      if (dow === 0 && i !== 0 && i !== 4) return;
      if ((d + i) % 3 === 0 && i === 1) return;
      addClass(d, ...c);
    });
  }

  // Demo scenarios ------------------------------------------------------------------------
  // 1) Tomorrow's HIIT: capacity 3, completely full, with a waitlist. Cancel a booking as a member and watch promotion.
  const hiit = addClass(1, '17:00', 'Signature HIIT', 'HIIT', 'The flagship session. Places are scarce.', 'sebastian', 45, 3);
  const book = db.prepare(`INSERT INTO bookings (class_id, user_id, status, created_at) VALUES (?, ?, ?, ?)`);
  const t0 = now.toISOString();
  for (const who of ['cassius', 'lucian', 'marguerite']) book.run(hiit, userId[who], 'booked', t0);
  for (const who of ['percival', 'octavia']) book.run(hiit, userId[who], 'waitlisted', t0);

  // 2) One place left: ideal for showing two people racing for the last spot.
  const lastSeat = addClass(2, '18:30', 'Last Seat Pilates', 'Pilates', 'A single place remains.', 'isolde', 50, 2);
  book.run(lastSeat, userId.cassius, 'booked', t0);

  // 3) A class that begins in ~30 minutes: booking window already closed, trainer can nearly mark attendance.
  const soon = db.prepare(`INSERT INTO classes (title, category, description, trainer_id, starts_at, ends_at, duration_min, capacity)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const soonStart = new Date(now.getTime() + 30 * 60_000).toISOString();
  const soonId = Number(soon.run('Twilight Flow', 'Yoga', 'Begins shortly - booking has closed.', userId.isolde,
    soonStart, new Date(now.getTime() + 90 * 60_000).toISOString(), 60, 10).lastInsertRowid);
  for (const who of ['priti', 'cassius']) book.run(soonId, userId[who], 'booked', t0);

  // 4) A class in progress right now, so a trainer can try marking attendance immediately.
  const liveStart = new Date(now.getTime() - 10 * 60_000).toISOString();
  const liveId = Number(soon.run('Power Hour', 'HIIT', 'In progress - mark attendance.', userId.sebastian,
    liveStart, new Date(now.getTime() + 50 * 60_000).toISOString(), 60, 8).lastInsertRowid);
  for (const who of ['priti', 'lucian', 'percival']) book.run(liveId, userId[who], 'booked', t0);

  // 5) History for the attendance report: past classes with marked attendance.
  const people = ['priti', 'cassius', 'lucian', 'marguerite', 'percival', 'octavia'];
  const markAt = (iso) => iso;
  const past = [
    [-2, '07:00', 'Sunrise Vinyasa', 'Yoga', 'isolde'],
    [-3, '18:00', 'Barbell Club', 'Strength', 'dorian'],
    [-5, '12:30', 'Midday HIIT', 'HIIT', 'sebastian'],
    [-6, '07:30', 'Reformer Foundations', 'Pilates', 'isolde'],
    [-8, '19:30', 'Evening Yin', 'Yoga', 'isolde'],
    [-9, '18:00', 'Barbell Club', 'Strength', 'dorian'],
    [-12, '12:30', 'Midday HIIT', 'HIIT', 'sebastian'],
  ];
  const markStmt = db.prepare(`INSERT INTO bookings (class_id, user_id, status, created_at, attendance_marked_by, attendance_marked_at)
                               VALUES (?, ?, ?, ?, ?, ?)`);
  past.forEach(([off, time, title, cat, trainer], idx) => {
    const id = addClass(off, time, title, cat, 'A past session.', trainer, 60, 10);
    const startsAt = zonedTime(addDays(today, off), time, timeZone);
    people.forEach((who, pIdx) => {
      // Deterministic pattern: Priti is diligent, Octavia drifts, others mix.
      const roll = (idx * 7 + pIdx * 5) % 10;
      const attendsThreshold = who === 'priti' ? 9 : who === 'octavia' ? 4 : 7;
      if (roll >= 9 && who !== 'priti') return; // did not book this one
      const status = roll < attendsThreshold ? 'attended' : 'absent';
      markStmt.run(id, userId[who], status, markAt(startsAt), userId[trainer], startsAt);
    });
  });

  return { users: DEMO_USERS.length, today };
}

// Run directly: `npm run seed`
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig({ jwtSecret: 'not-needed-by-the-seed-script' });
  const db = openDb(config.databasePath);
  const out = seed(db, { timeZone: config.timezone });
  console.log(`Seeded ${out.users} demo accounts for ${out.today} into ${config.databasePath}.`);
  console.log(`All demo accounts use the password: ${DEMO_PASSWORD}`);
  for (const u of DEMO_USERS) console.log(`  ${u.role.padEnd(8)} ${u.email}`);
  db.close();
}
