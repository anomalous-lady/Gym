# 3 to 5 minute video: running order

Delete this file before submitting if you prefer. It is only a guide. Say it in your own words, since you must be able to explain every part.

**0:00 Demo (about 90 s)**
1. Sign-in page: click a taken seat, a place opens, the first in line moves in. This is the whole product in one gesture.
2. Sign in as Priti. Schedule, day ribbon. Tomorrow's Signature HIIT is full (three filled seats, two diamonds for the queue). Join the waitlist: "3rd of 3".
3. Second window as Cassius: cancel his place, confirm. Switch back: Priti's position changes, Percival was moved in. Show the bell notification.
4. Evander (expired plan) tries to book: clear refusal.
5. Admin: New class with bad input, so the server's field errors show. Then a valid class.
6. Trainer (Sebastian): open Power Hour, mark attendance, save. Then admin Reports.

**1:30 Code walk (about 90 s)**
- `src/schema.sql`: the bookings table, the partial unique index, and the capacity triggers.
- `src/services/bookings.js`: `bookClass`, `cancelBooking`, `promoteWaitlist`, and the `.immediate()` calls.

**3:00 The hard problem (about 60 s): the last spot**
- Two people press Reserve at the same instant, so a naive read-then-write double books.
- Fix in three layers: `BEGIN IMMEDIATE` (take the write lock before reading), promotion inside the cancel transaction (no gap, no queue-jumping), and DB triggers as a backstop.
- Testing: a same-process test proves nothing because better-sqlite3 is synchronous, so `tests/bookings.test.js` races 8 separate processes on one DB file. Run `npm test` on camera.

**4:15 Close (about 30 s)**: what is finished, what isn't (README "Status"), what you'd do next (Postgres `FOR UPDATE`, server-sent events, real e-mail).
