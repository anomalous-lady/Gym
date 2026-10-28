import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { runExpiryReminders } from './services/notifications.js';

const config = loadConfig();
const db = openDb(config.databasePath);
const app = createApp({ db, config });

const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (userCount === 0) {
  console.warn('[hint] The database is empty. Run "npm run seed" to load demo members, trainers and classes.');
}

const server = app.listen(config.port, () => {
  console.log(`${config.gymName} is open at http://localhost:${config.port}`);
});

// Expiry reminders: once at start-up, then hourly. The job is idempotent (see notifications.js).
const remind = () => {
  try {
    runExpiryReminders(db, { now: new Date(), timeZone: config.timezone, reminderDays: config.reminderDays });
  } catch (err) {
    console.error('[reminders] failed:', err);
  }
};
remind();
const timer = setInterval(remind, 60 * 60 * 1000);
timer.unref();

function shutdown() {
  clearInterval(timer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
