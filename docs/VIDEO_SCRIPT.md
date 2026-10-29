# Video script (target 4:40, hard limit 5:00)

Read it in your own words. Words in [brackets] are what to do on screen. About 700 spoken words in total.

## 0:00 to 0:40  What I used and why  [show the GitHub repo page, then package.json]

"Hi, I'm Pritama. This is a gym booking app where members reserve classes, join a waitlist when a class is full, and get moved in automatically when someone cancels.

The stack: a Node and Express backend that I wrote, a SQLite database, and a plain JavaScript frontend with no build step. I used SQLite through better-sqlite3 because it needs no setup, and because its transactions are synchronous, which makes the rule 'never exceed capacity' easy to get right. Express serves both the API and the web pages from one process. For libraries: zod validates every input on the server, bcryptjs hashes passwords, jsonwebtoken handles login tokens, and dotenv reads settings. Tests use Node's built-in test runner. I used Claude as a coding assistant, and I'll explain every part I'm showing."

## 0:40 to 2:00  Demo  [browser, localhost:3000]

"This is the sign-in page. Clicking a taken seat releases it and the first person in the queue moves in. That's the whole product in one gesture.

I'll sign in as a member, Priti. This is the schedule: each filled circle is a taken place, each hollow one is free, and diamonds are the waitlist. Tomorrow's Signature HIIT is full, so I'll join the waitlist. I'm third in line.

In a second window I'm Cassius, who holds a place. I cancel. Back in Priti's window, the queue moved: Percival, first in line, was booked automatically and got a notification. No one clicked anything.

An expired member, Evander, can't book. The server refuses with a clear message.

As admin I'll add a class with bad input. The errors come from the server, per field. Now valid. As trainer Sebastian I open a class in progress, mark attendance, and save. The admin's Reports page shows each member's attendance rate."

## 2:00 to 3:40  Code walk  [GitHub, or VS Code]

"How it fits together. `server.js` loads config, opens the database from `schema.sql`, and builds the app from `app.js`. A request goes through `app.js`: check the login token, check the role, validate the input with zod, then call a service. All the real rules live in `src/services`, not in the routes, and not in the browser.

[open schema.sql] The database. Bookings have a status: booked, waitlisted, cancelled, attended or absent. A partial unique index means one live row per member per class. And these triggers refuse any insert that would exceed capacity. That's my last line of defence.

[open services/bookings.js, bookClass] When someone books, this runs inside a transaction opened with `.immediate()`. That takes the database write lock before reading, so two people can't both see one free place. If there's room and nobody queued, they're booked; otherwise they join the waitlist.

[cancelBooking and promoteWaitlist] Cancelling marks the row cancelled and, in the same transaction, `promoteWaitlist` takes the oldest waitlisted row and books it. Queue order is the row id, so it's strictly first come first served. Because it's one transaction, there's never a free place with nobody assigned.

[memberships.js] Membership 'active' is computed from dates, never stored, so nothing can forget to expire. A member must be active today and on the class day.

[public/app.js] The frontend builds the page with a small helper that never uses innerHTML, so user text can't inject markup. It calls the API with the token and refreshes every eight seconds."

## 3:40 to 4:30  The hard problem  [tests/bookings.test.js, then terminal: npm test]

"The hardest problem: two people pressing Reserve for the last place at the same instant. A naive version reads 'one place free' twice and books both. I solved it in three layers: the immediate transaction, promotion inside the cancel transaction, and the database triggers.

Testing it was the interesting part. better-sqlite3 is synchronous, so inside one Node process requests can't really overlap, and a same-process test proves nothing. So this test starts eight separate processes on one database file, all booking the last place at the same millisecond. Exactly one wins; seven join the waitlist. I also removed the locking to check the test fails, and it does. Here are all 22 tests passing."

## 4:30 to 4:50  Close  [README, Status section]

"Not done: real email, since reminders are in-app and logged; payments; and live updates poll instead of pushing. With more time I'd use server-sent events and move to Postgres with row locking. Thanks."

---

# Cheat-sheet: answers if you're asked "why" or "how"

**Why SQLite, not Postgres or MongoDB?** One gym, one writer. A single file means zero setup for a reviewer, and the write lock makes the capacity rule simple and provable. For many gyms I'd use Postgres with `SELECT ... FOR UPDATE` on the class row.

**Why better-sqlite3?** Synchronous API, so a transaction is plain code with no race between `await`s. `db.transaction(fn).immediate()` gives `BEGIN IMMEDIATE`.

**What is BEGIN IMMEDIATE?** A normal transaction takes the write lock lazily, at the first write, so two transactions can both read "1 free" first. IMMEDIATE takes it up front, so the second waits (busy_timeout = 5 s) and then reads fresh data.

**Why triggers as well?** Defence in depth. If a future bug skipped the check, the database itself rejects the 3rd booking in a 2-seat class.

**Why promote inside the cancel transaction?** So there is no gap in which a place is free but unassigned, and no way for a new booker to jump the queue.

**How is queue order decided?** `bookings.id` is AUTOINCREMENT, so lower id means joined earlier. Re-booking creates a new row, so you go to the back.

**Why is membership status derived, not stored?** A stored "expired" flag needs a job to flip it; a derived one can't go stale.

**Why zod?** One schema per input, run on the server for every request; it returns per-field messages the UI shows.

**bcryptjs vs bcrypt?** Pure JavaScript, so no compiling on a reviewer's machine.

**JWT, and why reload the user each request?** The token only carries the id and role claim. The server re-reads the user from the database each time, so a deleted user or changed role takes effect immediately.

**Why no framework (React) on the frontend?** No build step, nothing to install, and the file is easy to read in a video. The trade-off is more manual DOM code; a larger app would justify React.

**Timezones?** Stored in UTC, shown in `GYM_TIMEZONE`. Membership days are calendar days in that zone.

**What would break first at scale?** SQLite's single writer, and polling every 8 seconds. Fixes: Postgres and server-sent events.

**Where did AI help?** Claude generated the code under your direction; you must be able to explain it. Say so honestly. If asked what you changed or understood, point to the race test and the mutation check.
