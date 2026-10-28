import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers.js';
import { addMonths } from '../src/dates.js';
import { runExpiryReminders } from '../src/services/notifications.js';

describe('attendance', () => {
  let env, trainer, other, member, admin;
  before(async () => {
    env = await makeEnv();
    trainer = env.addUser('Tara Trainer', 'trainer');
    other = env.addUser('Otto Other', 'trainer');
    admin = env.addUser('Ada Admin', 'admin', { membership: null });
    member = env.addUser('Mia Member');
  });
  after(() => env.close());

  async function bookedClass(startsInMin) {
    const cls = env.addClass({ trainerId: trainer.id, capacity: 3, startsInMin });
    env.db.prepare(`INSERT INTO bookings (class_id, user_id, status, created_at) VALUES (?, ?, 'booked', ?)`)
      .run(cls, member.id, env.clock.now().toISOString());
    return cls;
  }
  const mark = async (who, cls, status = 'attended') =>
    env.http('POST', `/classes/${cls}/attendance`, { token: await env.login(who.email), body: { records: [{ userId: member.id, status }] } });

  test('the class trainer can mark attendance once the class has begun', async () => {
    const cls = await bookedClass(-5);
    const r = await mark(trainer, cls, 'attended');
    assert.equal(r.status, 200);
    assert.equal(env.db.prepare('SELECT status FROM bookings WHERE class_id=? AND user_id=?').get(cls, member.id).status, 'attended');
    // changing one's mind is allowed, and an attended place still counts toward capacity
    assert.equal((await mark(trainer, cls, 'absent')).status, 200);
    assert.equal(env.db.prepare(`SELECT COUNT(*) n FROM bookings WHERE class_id=? AND status IN ('booked','attended','absent')`).get(cls).n, 1);
  });

  test("another trainer, a member, and early marking are all refused", async () => {
    const live = await bookedClass(-5);
    assert.equal((await mark(other, live)).status, 403);
    assert.equal((await mark(member, live)).status, 403);
    const future = await bookedClass(300);
    const early = await mark(trainer, future);
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, 'CLASS_NOT_STARTED');
    assert.equal((await mark(admin, live)).status, 200, 'admin may mark any class');
  });

  test('marking someone who holds no place is rejected and changes nothing (all-or-nothing)', async () => {
    const cls = await bookedClass(-5);
    const stranger = env.addUser('Stranger Sam');
    const r = await env.http('POST', `/classes/${cls}/attendance`, {
      token: await env.login(trainer.email),
      body: { records: [{ userId: member.id, status: 'attended' }, { userId: stranger.id, status: 'attended' }] },
    });
    assert.equal(r.status, 404);
    assert.equal(env.db.prepare('SELECT status FROM bookings WHERE class_id=? AND user_id=?').get(cls, member.id).status, 'booked');
  });

  test('attendance report counts attended / absent per member', async () => {
    const r = await env.http('GET', '/admin/reports/attendance', { token: await env.login(admin.email) });
    assert.equal(r.status, 200);
    const row = r.body.rows.find((x) => x.id === member.id);
    assert.ok(row.attended + row.absent >= 1);
    assert.equal(row.rate, Math.round((row.attended / row.held) * 100));
  });
});

describe('memberships and reminders', () => {
  let env, member;
  before(async () => { env = await makeEnv(); member = env.addUser('Mona Member', 'member', { membership: null }); });
  after(() => env.close());

  test('monthly and quarterly plans get the right end dates (inclusive, month-end safe)', async () => {
    const token = await env.login(member.email);
    const plans = (await env.http('GET', '/plans')).body.plans;
    const quarterly = plans.find((p) => p.code === 'quarterly');
    const r = await env.http('POST', '/me/memberships', { token, body: { planId: quarterly.id } });
    assert.equal(r.status, 201);
    assert.equal(r.body.membership.startDate, env.today());
    const expectedEnd = new Date(Date.parse(addMonths(env.today(), 3) + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10);
    assert.equal(r.body.membership.endDate, expectedEnd);
    assert.equal(r.body.membership.status, 'active');
    // a renewal queues behind the current plan; a third purchase is refused
    const monthly = plans.find((p) => p.code === 'monthly');
    const renew = await env.http('POST', '/me/memberships', { token, body: { planId: monthly.id } });
    assert.equal(renew.status, 201);
    assert.equal(renew.body.membership.status, 'upcoming');
    assert.equal(renew.body.membership.startDate > r.body.membership.endDate, true);
    assert.equal((await env.http('POST', '/me/memberships', { token, body: { planId: monthly.id } })).status, 409);
  });

  test('expiry reminders are sent once per threshold and skipped when a renewal exists', async () => {
    const a = env.addUser('Expiring Ed', 'member', { membership: null });
    const b = env.addUser('Renewed Rae', 'member', { membership: null });
    const insert = env.db.prepare('INSERT INTO memberships (user_id, plan_id, start_date, end_date) VALUES (?, ?, ?, ?)');
    const plan = env.db.prepare(`SELECT id FROM plans WHERE code='monthly'`).get().id;
    insert.run(a.id, plan, '2030-05-20', '2030-06-12');   // ends in 2 days
    insert.run(b.id, plan, '2030-05-20', '2030-06-12');
    insert.run(b.id, plan, '2030-06-13', '2030-07-12');   // already renewed
    const opts = { now: env.clock.now(), timeZone: 'Asia/Kolkata', reminderDays: 7, log: () => {} };

    assert.equal(runExpiryReminders(env.db, opts).sent, 1);
    assert.equal(runExpiryReminders(env.db, opts).sent, 0, 'idempotent: running again sends nothing new');
    assert.equal(env.db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ?').get(b.id).n, 0);

    env.clock.advanceMin(24 * 60); // one day left: the tighter reminder fires once more
    assert.equal(runExpiryReminders(env.db, { ...opts, now: env.clock.now() }).sent, 1);
    const kinds = env.db.prepare('SELECT kind FROM notifications WHERE user_id = ? ORDER BY id').all(a.id).map((r) => r.kind);
    assert.deepEqual(kinds, ['expiry_7d', 'expiry_1d']);
  });
});

describe('server-side validation and permissions', () => {
  let env, admin, member, trainer;
  before(async () => {
    env = await makeEnv();
    admin = env.addUser('Ada Admin', 'admin', { membership: null });
    trainer = env.addUser('Tom Trainer', 'trainer');
    member = env.addUser('Mel Member');
  });
  after(() => env.close());

  test('creating a class validates every field and reports each one', async () => {
    const token = await env.login(admin.email);
    const bad = await env.http('POST', '/classes', { token, body: { title: 'x', capacity: 0, durationMin: 5, trainerId: 'abc' } });
    assert.equal(bad.status, 400);
    for (const f of ['title', 'category', 'trainerId', 'startsAt', 'durationMin', 'capacity']) assert.ok(bad.body.error.fields[f], `field ${f}`);

    const past = await env.http('POST', '/classes', { token, body: { title: 'Yoga', category: 'Yoga', trainerId: trainer.id, startsAt: '2020-01-01T10:00:00Z', durationMin: 60, capacity: 10 } });
    assert.equal(past.status, 400);
    assert.ok(past.body.error.fields.startsAt);

    const notTrainer = await env.http('POST', '/classes', { token, body: { title: 'Yoga', category: 'Yoga', trainerId: member.id, startsAt: '2030-06-11T10:00:00Z', durationMin: 60, capacity: 10 } });
    assert.equal(notTrainer.status, 400);
  });

  test('a valid class is created, and a trainer cannot be double-booked', async () => {
    const token = await env.login(admin.email);
    const body = { title: 'Dawn Yoga', category: 'Yoga', trainerId: trainer.id, startsAt: '2030-06-11T01:00:00Z', durationMin: 60, capacity: 12 };
    const ok = await env.http('POST', '/classes', { token, body });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.class.capacity, 12);
    const clash = await env.http('POST', '/classes', { token, body: { ...body, title: 'Clash', startsAt: '2030-06-11T01:30:00Z' } });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error.code, 'TRAINER_BUSY');
  });

  test('roles are enforced: members cannot administer, admins cannot book, anonymous is refused', async () => {
    const m = await env.login(member.email);
    const a = await env.login(admin.email);
    assert.equal((await env.http('POST', '/classes', { token: m, body: {} })).status, 403);
    assert.equal((await env.http('GET', '/admin/members', { token: m })).status, 403);
    const cls = env.addClass({ trainerId: trainer.id, capacity: 3 });
    assert.equal((await env.http('POST', `/classes/${cls}/book`, { token: a })).status, 403);
    assert.equal((await env.http('GET', '/classes')).status, 401);
    assert.equal((await env.http('GET', '/classes', { token: 'garbage' })).status, 401);
  });

  test('ids, dates and JSON are validated; login and registration give clear messages', async () => {
    const m = await env.login(member.email);
    assert.equal((await env.http('POST', '/classes/abc/book', { token: m })).status, 400);
    assert.equal((await env.http('POST', '/classes/99999/book', { token: m })).status, 404);
    assert.equal((await env.http('GET', '/classes?from=nope', { token: m })).status, 400);

    const raw = await fetch(`${env.base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    assert.equal(raw.status, 400);

    const wrong = await env.http('POST', '/auth/login', { body: { email: member.email, password: 'WrongPass1' } });
    assert.equal(wrong.status, 401);
    const weak = await env.http('POST', '/auth/register', { body: { name: 'Zed', email: 'zed@test.club', password: 'short' } });
    assert.equal(weak.status, 400);
    assert.ok(weak.body.error.fields.password);
    const dup = await env.http('POST', '/auth/register', { body: { name: 'Zed', email: member.email, password: 'Longenough1' } });
    assert.equal(dup.status, 409);
    const fresh = await env.http('POST', '/auth/register', { body: { name: '  Zed   Zero ', email: 'ZED@test.club', password: 'Longenough1' } });
    assert.equal(fresh.status, 201);
    assert.equal(fresh.body.user.name, 'Zed Zero');
    assert.equal(fresh.body.user.role, 'member', 'self-registration can only create members');
    // a registered stranger with no plan cannot book
    const noPlan = await env.http('POST', `/classes/${env.addClass({ trainerId: trainer.id })}/book`, { token: fresh.body.token });
    assert.equal(noPlan.body.error.code, 'MEMBERSHIP_INACTIVE');
  });

  test('cancelling a class releases everyone and tells them', async () => {
    const a = await env.login(admin.email);
    const cls = env.addClass({ trainerId: trainer.id, capacity: 1, startsInMin: 800 });
    const m2 = env.addUser('Second Sam');
    await env.http('POST', `/classes/${cls}/book`, { token: await env.login(member.email) });
    await env.http('POST', `/classes/${cls}/book`, { token: await env.login(m2.email) });
    const r = await env.http('POST', `/classes/${cls}/cancel`, { token: a });
    assert.equal(r.body.released, 2);
    assert.equal(env.db.prepare(`SELECT COUNT(*) n FROM notifications WHERE kind = 'class_cancelled'`).get().n, 2);
    const again = await env.http('POST', `/classes/${cls}/book`, { token: await env.login(member.email) });
    assert.equal(again.body.error.code, 'CLASS_CANCELLED');
  });
});
