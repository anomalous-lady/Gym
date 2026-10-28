import 'dotenv/config';
import crypto from 'node:crypto';

/**
 * Builds the runtime configuration from environment variables.
 * `overrides` exists so tests can pass their own values without touching process.env.
 */
export function loadConfig(overrides = {}) {
  const env = process.env;
  const isProduction = (overrides.nodeEnv ?? env.NODE_ENV) === 'production';

  let jwtSecret = overrides.jwtSecret ?? env.JWT_SECRET;
  if (!jwtSecret) {
    if (isProduction) {
      throw new Error('JWT_SECRET must be set when NODE_ENV=production');
    }
    // Development convenience: a random per-process secret. Logins reset on restart.
    jwtSecret = crypto.randomBytes(32).toString('hex');
    console.warn('[config] JWT_SECRET not set - using a temporary secret (logins reset on restart).');
  }

  const config = {
    nodeEnv: isProduction ? 'production' : 'development',
    port: Number(env.PORT) || 3000,
    databasePath: env.DATABASE_PATH || './data/gym.db',
    jwtSecret,
    jwtExpiresIn: env.JWT_EXPIRES_IN || '12h',
    gymName: env.GYM_NAME || 'Aurelian Athletic Society',
    timezone: env.GYM_TIMEZONE || 'Asia/Kolkata',
    currency: env.CURRENCY || 'INR',
    cutoffMinutes: Number(env.BOOKING_CUTOFF_MINUTES) || 120,
    reminderDays: Number(env.REMINDER_DAYS) || 7,
    ...overrides,
  };
  return config;
}
