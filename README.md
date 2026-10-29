# Aurelian Athletic Society: class booking with an automatic waitlist

Members with an active membership book classes. When a class is full they join a waitlist, and when someone cancels, **the server** moves the first person in line into the class, in the same database transaction as the cancellation.

Node.js · Express · SQLite (better-sqlite3) · vanilla JavaScript frontend (no build step)

## Run it

Requires Node 20 or newer.

```bash
npm install              # installs without compiling: better-sqlite3 ships prebuilt binaries (see .npmrc)
cp .env.example .env      # optional for local use; every setting has a default
npm run seed              # loads demo data (wipes existing data in the database)
npm start                 # http://localhost:3000
npm test                  # 22 automated tests
```

In production set `NODE_ENV=production` and a real `JWT_SECRET` (the server refuses to start without one). Every setting is listed in [`.env.example`](.env.example).

### Demo logins

All demo accounts use the password **`Aurelian2026`**. The sign-in page also has one-click buttons for the first three.

| Role | Email | What to try |
|---|---|---|
| Member | `priti@aurelian.club` | Active quarterly plan. Tomorrow's **Signature HIIT** is full, so join its waitlist |
| Trainer | `sebastian@aurelian.club` | **Power Hour** is in progress: open it and mark attendance |
| Admin | `admin@aurelian.club` | Add a class, add or end a plan, attendance report, send expiry reminders |
| Member | `cassius@aurelian.club` | Holds a place in Signature HIIT: cancel it and watch the first person in line move in |
| Member | `octavia@aurelian.club` | Plan ends in 3 days, so she has an expiry reminder in the bell |
| Member | `evander@aurelian.club` | Expired plan: booking is refused with a clear message |
| Member | `rosalind@aurelian.club` | No plan yet: buy one on the Membership page |

Other trainers: `isolde@aurelian.club`, `dorian@aurelian.club`. Other members: `lucian@`, `marguerite@`, `percival@aurelian.club`.

**Seeing a promotion with two browser windows:** sign in as Priti in one window and join the Signature HIIT waitlist (3rd in line). In another window sign in as Cassius and cancel his place. Percival (first in line) is moved in instantly. Cancel again and Octavia is next. Every screen refreshes itself every 8 seconds, and the member who is moved in gets a notification.

## Deploy (free-tier friendly)

No API keys or external services are needed. Set these environment variables on the host:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `JWT_SECRET` | a long random string: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `AUTO_SEED` | `true` (loads demo data the first time, when the database is empty) |
| `DATABASE_PATH` | `./data/gym.db`, or a persistent volume path such as `/data/gym.db` |

Build command: `npm install` · Start command: `npm start`. The host provides `PORT` automatically.

SQLite is a file, so the host needs a persistent disk if you want data to survive restarts. On a free tier without one the data resets on redeploy, and `AUTO_SEED` reloads the demo data, which is fine for a demo.

## What it does (against the brief)

| Requirement | Where |
|---|---|
| Monthly and quarterly plans with start and end dates; only active members can book | `plans`, `memberships`; `services/memberships.js` (`canHoldPlace`) |
| Admin creates classes with trainer, time, capacity | `services/classes.js`, admin "New class" form |
| Book and cancel up to 2 hours before the start | `services/bookings.js`; `BOOKING_CUTOFF_MINUTES` (default 120) |
| Full class gives a waitlist; first in line moves in on cancel | `promoteWaitlist()` runs inside the cancel transaction |
| Trainers mark attendance for their classes | `services/attendance.js` |
| Capacity never exceeded, even for the last spot | see "The hard problem" below |
| Stretch: expiry reminders | `runExpiryReminders()` (hourly job plus an admin button) |
| Stretch: per-member attendance reports | Admin, Reports (date range, drill into a member) |

## The hard problem: the last spot

Two members press "Reserve" for the last place at the same instant. A naive handler reads "1 place free" twice and books both.

Three layers stop that, all in the database, not in client code:

1. **`BEGIN IMMEDIATE` transactions.** Every operation that changes who holds a place (book, cancel, promote, capacity change) takes SQLite's write lock *before* it reads. The second request waits (`busy_timeout`), then sees 0 places free and joins the waitlist. This works across separate processes, not just inside one.
2. **Promotion in the same transaction as the cancellation.** There is no moment when a place is free but unassigned, so a new booker can never jump the queue. If a place is ever free while people are queued, `bookClass` settles the queue first.
3. **Database triggers** (`schema.sql`) reject any insert or update that would exceed capacity, or lower capacity below the number of places already taken. This is a backstop in case application code ever has a bug.

Queue order is the booking row id (`AUTOINCREMENT`), so it is strictly join order. A member who cancels and re-books gets a new row, meaning the back of the queue.

**How this is tested.** better-sqlite3 is synchronous, so inside one Node process requests cannot truly interleave. A same-process test therefore proves little. `tests/bookings.test.js` spawns **8 separate OS processes**, each with its own connection to the same database file, that start at the same millisecond and all try to book the last place. Exactly one wins and seven join the waitlist. I checked that this test can fail: with `BEGIN IMMEDIATE` removed, seven of the eight workers die with `SQLITE_BUSY_SNAPSHOT` and the test fails. The 25-request HTTP test, by contrast, still passes with the locking removed, because one Node process cannot interleave synchronous calls. It checks queue behaviour, not the lock.

## Data model

```
users(id, name, email UNIQUE, password_hash, role: admin|trainer|member)
plans(id, code: monthly|quarterly, name, months, price_cents, blurb)
memberships(id, user_id, plan_id, start_date, end_date, cancelled_at)       dates are YYYY-MM-DD, inclusive
classes(id, title, category, description, trainer_id, starts_at, ends_at,
        duration_min, capacity, cancelled_at)                               times are UTC ISO-8601
bookings(id, class_id, user_id, status, created_at, promoted_at, cancelled_at, cancel_reason,
         attendance_marked_by, attendance_marked_at)
notifications(id, user_id, kind, message, ref_id, created_at, read_at)
```

`bookings.status` is one of `booked`, `waitlisted`, `attended`, `absent`, `cancelled`. A partial unique index on `(class_id, user_id) WHERE status <> 'cancelled'` allows one live row per member per class.

### Design decisions

- **Membership "active" is derived from dates, never stored.** There is no job that can forget to expire someone. A member can book only if they are active today *and* still covered on the day of the class, so a plan ending next week cannot reserve a class in three weeks.
- **Renewals queue.** Buying a plan while one is running starts it the day after the current one ends. At most one renewal can be queued.
- **Both windows close 2 hours before the start**, for booking and for cancelling a held place. Leaving a *waitlist* is allowed until the class starts, since it frees nothing.
- **A lapsed member at the head of the queue is skipped** (and told why) rather than blocking everyone behind them.
- **Attended and absent still count toward capacity**, so marking attendance can never open a phantom place.
- **Raising a class's capacity promotes the waitlist** too. Staff removing a member promotes it as well.
- **Timezones.** Times are stored in UTC and displayed in the gym's timezone (`GYM_TIMEZONE`). Membership days are calendar days in that zone.
- **Validation lives on the server** (zod schemas in `validation.js`); the UI shows the server's per-field messages. Self-registration can only create members. Passwords are bcrypt-hashed, login is rate-limited, and the user is re-loaded from the database on every request, so a role change takes effect immediately.
- **No `innerHTML` anywhere in the frontend**, so user-supplied text cannot inject markup. A Content-Security-Policy header is set.

## API (all under `/api`, JSON, Bearer token)

`POST /auth/login|register` · `GET /classes?from&to` · `GET /classes/:id` · `GET /classes/:id/roster` (staff) · `POST /classes` · `PATCH /classes/:id` · `POST /classes/:id/cancel` (admin) · `POST|DELETE /classes/:id/book` (member) · `DELETE /classes/:id/bookings/:userId` (admin) · `POST /classes/:id/attendance` (trainer or admin) · `GET /me/bookings|memberships|attendance|notifications` · `POST /me/memberships` · `GET /admin/members|expiring|trainers` · `POST /admin/memberships` · `DELETE /admin/memberships/:id` · `POST /admin/reminders/run` · `GET /admin/reports/attendance` · `GET /admin/reports/members/:id` · `GET /trainer/classes`

## Tests

`npm test` runs 22 tests with Node's built-in runner on an in-memory database and a controllable clock: booking and waitlist order, promotion on every cancel, the 2-hour windows, inactive members, capacity raise and staff removal, lapsed waitlist members, 25 simultaneous HTTP requests for one place, 8-process race on a database file, the database trigger, attendance permissions, plan dates and renewals, idempotent reminders, role enforcement, and server-side validation messages.

## Status

**Finished and exercised in a browser:** everything in the table above, at desktop and phone widths (no horizontal overflow at 390px). Keyboard focus styles, dialog focus trapping and `prefers-reduced-motion` are implemented but I did not test them with assistive technology.

**Not done, and what I'd do with more time**
- **Expiry reminders are in-app and logged, not e-mailed.** The e-mail is simulated in the server log. Next step: a transactional-mail provider behind the same `notify()` call.
- **Payments are not integrated.** Choosing a plan confirms it immediately.
- **SQLite allows one writer at a time.** That is right for one gym and is what makes the locking simple. For many gyms I would move to Postgres and use `SELECT ... FOR UPDATE` on the class row, keeping the same transaction structure and trigger idea.
- **Live updates poll every 8 seconds.** Server-sent events would make a promotion appear instantly.
- No password reset, no e-mail verification, and the token is kept in `localStorage` (a httpOnly cookie would be stronger). The rate limiter is in memory.
- Admins cannot move a class that already has bookings (they cancel and recreate it, which notifies everyone). Recurring class series are not modelled.
- Not deployed, so there is no live demo link.

## AI tools used

I used **Claude (Anthropic)** as a pair-programmer for this project: scaffolding the schema and services, the Express API, the seed script, the tests, the frontend, and drafting this README. I directed the design, reviewed the code, and ran and debugged it. Two bugs surfaced in browser testing and were fixed (a swallowed login error, and clipped navigation), as was a trainer-clash check that wrongly blocked capacity edits.
