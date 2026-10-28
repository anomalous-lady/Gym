-- Aurelian gym: schema. Safe to run on every start (everything is IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'trainer', 'member')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Two plans, as required: monthly (1 calendar month) and quarterly (3).
CREATE TABLE IF NOT EXISTS plans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE CHECK (code IN ('monthly', 'quarterly')),
  name        TEXT NOT NULL,
  months      INTEGER NOT NULL CHECK (months > 0),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  blurb       TEXT NOT NULL DEFAULT ''
);

-- A membership is a dated window. "Active" is derived from the dates (never stored),
-- so there is no cron job that can forget to expire someone.
CREATE TABLE IF NOT EXISTS memberships (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id      INTEGER NOT NULL REFERENCES plans(id),
  start_date   TEXT NOT NULL,            -- YYYY-MM-DD, inclusive, gym timezone
  end_date     TEXT NOT NULL,            -- YYYY-MM-DD, inclusive
  cancelled_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships (user_id, end_date);

CREATE TABLE IF NOT EXISTS classes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  category     TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  trainer_id   INTEGER NOT NULL REFERENCES users(id),
  starts_at    TEXT NOT NULL,            -- ISO-8601 UTC, always ...Z with milliseconds
  ends_at      TEXT NOT NULL,
  duration_min INTEGER NOT NULL CHECK (duration_min BETWEEN 15 AND 240),
  capacity     INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 200),
  cancelled_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_classes_starts ON classes (starts_at);
CREATE INDEX IF NOT EXISTS idx_classes_trainer ON classes (trainer_id, starts_at);

-- One row per (class, member) attempt.
--   booked      holds a place
--   waitlisted  waiting; queue order is simply the row id (AUTOINCREMENT = join order)
--   attended / absent   set by the trainer; both still occupy the place
--   cancelled   history only; a member who rebooks gets a NEW row, i.e. the back of the queue
CREATE TABLE IF NOT EXISTS bookings (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id             INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status               TEXT NOT NULL CHECK (status IN ('booked', 'waitlisted', 'cancelled', 'attended', 'absent')),
  created_at           TEXT NOT NULL,
  promoted_at          TEXT,             -- set when moved in from the waitlist
  cancelled_at         TEXT,
  cancel_reason        TEXT,
  attendance_marked_by INTEGER REFERENCES users(id),
  attendance_marked_at TEXT
);

-- A member can hold at most one live row per class (cancelled rows are history).
CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_live
  ON bookings (class_id, user_id) WHERE status <> 'cancelled';
CREATE INDEX IF NOT EXISTS idx_bookings_class ON bookings (class_id, status, id);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings (user_id, status);

-- Defence in depth: even if application code had a bug, the database itself refuses to
-- hold more people than a class has places. (The application also serialises writers with
-- BEGIN IMMEDIATE, see services/bookings.js.)
CREATE TRIGGER IF NOT EXISTS trg_bookings_capacity_insert
BEFORE INSERT ON bookings
WHEN NEW.status IN ('booked', 'attended', 'absent')
BEGIN
  SELECT RAISE(ABORT, 'CAPACITY_EXCEEDED')
  WHERE (SELECT COUNT(*) FROM bookings
          WHERE class_id = NEW.class_id AND status IN ('booked', 'attended', 'absent'))
        >= (SELECT capacity FROM classes WHERE id = NEW.class_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_bookings_capacity_update
BEFORE UPDATE OF status ON bookings
WHEN NEW.status IN ('booked', 'attended', 'absent')
 AND OLD.status NOT IN ('booked', 'attended', 'absent')
BEGIN
  SELECT RAISE(ABORT, 'CAPACITY_EXCEEDED')
  WHERE (SELECT COUNT(*) FROM bookings
          WHERE class_id = NEW.class_id AND status IN ('booked', 'attended', 'absent'))
        >= (SELECT capacity FROM classes WHERE id = NEW.class_id);
END;

-- ...and capacity can never be lowered below the number of people already holding a place.
CREATE TRIGGER IF NOT EXISTS trg_classes_capacity_floor
BEFORE UPDATE OF capacity ON classes
BEGIN
  SELECT RAISE(ABORT, 'CAPACITY_BELOW_BOOKINGS')
  WHERE NEW.capacity < (SELECT COUNT(*) FROM bookings
                         WHERE class_id = NEW.id AND status IN ('booked', 'attended', 'absent'));
END;

-- In-app notifications (waitlist moves, expiry reminders, cancelled classes).
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  message    TEXT NOT NULL,
  ref_id     INTEGER,
  created_at TEXT NOT NULL,
  read_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, read_at, id);
-- Each expiry reminder (7-day / 1-day) is sent at most once per membership.
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_expiry
  ON notifications (kind, ref_id) WHERE kind LIKE 'expiry_%';

INSERT OR IGNORE INTO plans (code, name, months, price_cents, blurb) VALUES
  ('monthly',   'Monthly',   1, 350000,  'One calendar month of unrestricted booking.'),
  ('quarterly', 'Quarterly', 3, 900000,  'Three months at a considered saving.');
