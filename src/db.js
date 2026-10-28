import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const schemaSql = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

/**
 * Opens (and if needed creates) the SQLite database.
 *
 * - WAL lets readers work while a writer is active.
 * - busy_timeout makes a second writer WAIT for the first instead of failing instantly;
 *   together with BEGIN IMMEDIATE (see bookings service) this is what serialises
 *   competing bookings even across separate processes/connections.
 */
export function openDb(file = ':memory:') {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(schemaSql);
  return db;
}
