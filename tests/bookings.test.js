import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeEnv, makeClock, counts } from './helpers.js';
import { openDb } from '../src/db.js';

describe('booking and waitlist', () => {
  let env, trainer;
  before(async () => { env = await makeEnv(); trainer = env.addUser('Tess Trainer', 'trainer'); });
  after(() => env.close());

  const book = async (user, classId) => env.http('POST', `/classes/${classId}/book`, { token: await env.login(user.email) });
  const cancel = async (user, classId) => env.http('DELETE', `/classes/${classId}/book`, { token: await env.login(user.email) });

  test('books until full, then joins the waitlist in order', async () => {
    const [a, b, c, d] = ['Ann', 'Ben', 'Cal', 'Dee'].map((n) => env.addUser(`${n} A`));
    const cls = env.addClass({ trainerId: trainer.id, capacity: 2 });
    assert.equal((await book(a, cls)).body.status, 'booked');
    assert.equal((await book(b, cls)).body.status, 'booked');
    const rc = await book(c, cls);
    assert.equal(rc.body.status, 'waitlisted');
    assert.equal(rc.body.position, 1);
    assert.equal((await book(d, cls)).body.position, 2);
    assert.deepEqual(counts(env.db, cls), { booked: 2, waitlisted: 2 });
  });

  test('cancelling promotes the first waitlisted member on the server, in order, every time', async () => {
    const [a, b, c, d, e] = ['P1', 'P2', 'P3', 'P4', 'P5'].map((n) => env.addUser(`Promo ${n}`));
    const cls = env.addClass({ trainerId: trainer.id, capacity: 2 });
    for (const u of [a, b, c, d, e]) await book(u, cls); // a,b booked; c,d,e queued

    assert.equal((await cancel(a, cls)).status, 200);
    const status = (u) => env.db.prepare('SELECT status FROM bookings WHERE class_id=? AND user_id=? AND status<>? ').get(cls, u.id, 'cancelled')?.status;
    assert.equal(status(c), 'booked', 'first in line is promoted');
    assert.equal(status(d), 'waitlisted');
    assert.equal(status(e), 'waitlisted');

    assert.equal((await cancel(b, cls)).status, 200);
    assert.equal(status(d), 'booked', 'second cancellation promotes the next in line');
    assert.equal(status(e), 'waitlisted');
    assert.deepEqual(counts(env.db, cls), { booked: 2, waitlisted: 1 });

    const note = env.db.prepare(`SELECT message FROM notifications WHERE user_id = ? AND kind = 'waitlist_promoted'`).get(c.id);
    assert.match(note.message, /now booked/i);
  });

  test('leaving the waitlist does not free a place or promote anyone', async () => {
    const [a, b, c] = ['W1', 'W2', 'W3'].map((n) => env.addUser(`Leaver ${n}`));
    const cls = env.addClass({ trainerId: trainer.id, capacity: 1 });
    await book(a, cls); await book(b, cls); await book(c, cls);
    await cancel(b, cls); // b leaves the queue
    assert.deepEqual(counts(env.db, cls), { booked: 1, waitlisted: 1 });
    const r = await env.http('GET', `/classes/${cls}`, { token: await env.login(c.email) });
    assert.equal(r.body.class.my.position, 1, 'c moves up to position 1');
  });

  test('a member cannot hold two places in one class', async () => {
    const a = env.addUser('Double Dan');
    const cls = env.addClass({ trainerId: trainer.id, capacity: 5 });
    await book(a, cls);
    const again = await book(a, cls);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'ALREADY_BOOKED');
  });

  test('only active members can book (expired, not-yet-started and lapsed-by-class-day are refused)', async () => {
    const expired = env.addUser('Exp Ired', 'member', { membership: 'expired' });
    const none = env.addUser('No Plan', 'member', { membership: null });
    const future = env.addUser('Fut Ure', 'member', { membership: 'future' });
    const cls = env.addClass({ trainerId: trainer.id, capacity: 5 });
    for (const u of [expired, none, future]) {
      const r = await book(u, cls);
      assert.equal(r.status, 403, u.name);
      assert.equal(r.body.error.code, 'MEMBERSHIP_INACTIVE');
    }
    // Active today, but the monthly plan ends before the class day (class is 40 days out).
    const soonEnding = env.addUser('Soon Ending');
    const farClass = env.addClass({ trainerId: trainer.id, capacity: 5, startsInMin: 40 * 24 * 60 });
    assert.equal((await book(soonEnding, farClass)).status, 403);
  });

  test('booking and cancelling both close 2 hours before the start', async () => {
    const a = env.addUser('Window Wendy');
    const cls = env.addClass({ trainerId: trainer.id, capacity: 5, startsInMin: 119 }); // inside the window
    const r = await book(a, cls);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'BOOKING_CLOSED');

    const open = env.addClass({ trainerId: trainer.id, capacity: 5, startsInMin: 130 });
    assert.equal((await book(a, open)).status, 201);
    env.clock.advanceMin(11); // now 119 minutes before the start: cancellation is refused
    const c = await cancel(a, open);
    assert.equal(c.status, 409);
    assert.equal(c.body.error.code, 'CANCEL_WINDOW_CLOSED');
    env.clock.advanceMin(-11);
  });

  test('a staff removal or a raised capacity also advances the waitlist', async () => {
    const [a, b, c] = ['S1', 'S2', 'S3'].map((n) => env.addUser(`Staff ${n}`));
    const admin = env.addUser('Admin Amy', 'admin', { membership: null });
    const cls = env.addClass({ trainerId: trainer.id, capacity: 1 });
    await book(a, cls); await book(b, cls); await book(c, cls);
    const token = await env.login(admin.email);

    const patch = await env.http('PATCH', `/classes/${cls}`, { token, body: { capacity: 2 } });
    assert.equal(patch.status, 200);
    assert.equal(patch.body.promoted, 1, 'extra place goes to the head of the queue');
    assert.deepEqual(counts(env.db, cls), { booked: 2, waitlisted: 1 });

    const rm = await env.http('DELETE', `/classes/${cls}/bookings/${a.id}`, { token });
    assert.equal(rm.status, 200);
    assert.deepEqual(counts(env.db, cls), { booked: 2, waitlisted: 0 });

    const low = await env.http('PATCH', `/classes/${cls}`, { token, body: { capacity: 1 } });
    assert.equal(low.status, 409, 'capacity cannot drop below the places already taken');
  });

  test('a waitlisted member whose membership lapsed is skipped, not allowed to block the queue', async () => {
    const [a, b, c] = ['L1', 'L2', 'L3'].map((n) => env.addUser(`Lapse ${n}`));
    const cls = env.addClass({ trainerId: trainer.id, capacity: 1 });
    await book(a, cls); await book(b, cls); await book(c, cls);
    env.db.prepare('UPDATE memberships SET cancelled_at = ? WHERE user_id = ?').run(env.clock.now().toISOString(), b.id);
    await cancel(a, cls);
    const st = (u) => env.db.prepare(`SELECT status FROM bookings WHERE class_id=? AND user_id=? ORDER BY id DESC`).get(cls, u.id).status;
    assert.equal(st(b), 'cancelled');
    assert.equal(st(c), 'booked');
  });

  // NOTE: better-sqlite3 is synchronous, so inside ONE Node process requests cannot interleave anyway.
  // This test therefore proves the API-level behaviour (one winner, gapless queue positions);
  // the cross-process test below is the one that proves the database lock.
  test('the last place goes to exactly one of 25 simultaneous HTTP requests', async () => {
    const people = Array.from({ length: 25 }, (_, i) => env.addUser(`Racer ${String.fromCharCode(65 + i)}`));
    const cls = env.addClass({ trainerId: trainer.id, capacity: 1 });
    const tokens = await Promise.all(people.map((p) => env.login(p.email)));
    const results = await Promise.all(tokens.map((token) => env.http('POST', `/classes/${cls}/book`, { token })));
    assert.ok(results.every((r) => r.status === 201));
    assert.equal(results.filter((r) => r.body.status === 'booked').length, 1);
    assert.equal(results.filter((r) => r.body.status === 'waitlisted').length, 24);
    assert.deepEqual(counts(env.db, cls), { booked: 1, waitlisted: 24 });
    const positions = results.filter((r) => r.body.status === 'waitlisted').map((r) => r.body.position).sort((x, y) => x - y);
    assert.deepEqual(positions, Array.from({ length: 24 }, (_, i) => i + 1), 'queue positions are unique and gapless');
  });

  test('the database itself refuses to exceed capacity (trigger backstop)', () => {
    const [a, b] = ['T1', 'T2'].map((n) => env.addUser(`Trigger ${n}`));
    const cls = env.addClass({ trainerId: trainer.id, capacity: 1 });
    const ins = env.db.prepare(`INSERT INTO bookings (class_id, user_id, status, created_at) VALUES (?, ?, 'booked', 'x')`);
    ins.run(cls, a.id);
    assert.throws(() => ins.run(cls, b.id), /CAPACITY_EXCEEDED/);
  });
});

describe('capacity across separate processes (real parallelism)', () => {
  test('8 processes race for the last place on one database file: one wins, nobody overbooks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-race-'));
    const file = path.join(dir, 'race.db');
    const env = await makeEnv({ file, clock: makeClock() });
    try {
    const trainer = env.addUser('Race Trainer', 'trainer');
    const people = Array.from({ length: 8 }, (_, i) => env.addUser(`Proc ${i}`));
    const cls = env.addClass({ trainerId: trainer.id, capacity: 1 });

    const startAt = Date.now() + 1500; // everyone starts together
    const worker = fileUrl('race-worker.js');
    const outputs = await Promise.all(people.map((p) => new Promise((resolve, reject) => {
      let out = '';
      const child = spawn(process.execPath, [worker, file, String(cls), String(p.id), String(startAt)], { stdio: ['ignore', 'pipe', 'inherit'] });
      // Safety net so a stuck worker can never hang the test run.
      const guard = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('worker did not finish within 20s')); }, 20_000);
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', () => { clearTimeout(guard); resolve(JSON.parse(out.trim().split('\n').pop())); });
      child.on('error', reject);
    })));

    assert.ok(outputs.every((o) => o.ok), `a worker failed (bookings are not being serialised): ${JSON.stringify(outputs)}`);
    assert.equal(outputs.filter((o) => o.status === 'booked').length, 1);
    assert.equal(outputs.filter((o) => o.status === 'waitlisted').length, 7);
    const verify = openDb(file);
    assert.deepEqual(counts(verify, cls), { booked: 1, waitlisted: 7 });
    verify.close();
    } finally {
      await env.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

const fileUrl = (name) => path.join(path.dirname(new URL(import.meta.url).pathname), name);
