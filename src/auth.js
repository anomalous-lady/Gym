import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { forbidden, unauthorized } from './errors.js';

export const hashPassword = (plain) => bcrypt.hashSync(plain, 10);
export const checkPassword = (plain, hash) => bcrypt.compareSync(plain, hash);

// A real hash of a throwaway string: comparing against it when the e-mail is unknown keeps
// response time similar, so login does not reveal which e-mails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
export const burnPasswordTime = (plain) => bcrypt.compareSync(plain, DUMMY_HASH);

export const signToken = (user, config) =>
  jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

/**
 * Reads the Bearer token, then loads the user FROM THE DATABASE on every request, so a
 * deleted user or changed role takes effect immediately rather than when the token expires.
 */
export function authenticate(db, config) {
  return (req, _res, next) => {
    const header = req.get('authorization') || '';
    const match = /^Bearer (.+)$/i.exec(header);
    if (!match) return next(unauthorized());
    try {
      const payload = jwt.verify(match[1], config.jwtSecret);
      const user = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(payload.sub);
      if (!user) return next(unauthorized('Your session is no longer valid. Please sign in again.'));
      req.user = user;
      next();
    } catch {
      next(unauthorized('Your session has expired. Please sign in again.'));
    }
  };
}

export const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user?.role) ? next() : next(forbidden());

/** Tiny in-memory rate limiter (per IP + key) - enough to blunt password guessing. */
export function rateLimit({ windowMs, max, keyFn = (req) => req.ip }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = keyFn(req);
    const entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
    } else {
      entry.count += 1;
      if (entry.count > max) {
        const wait = Math.ceil((entry.resetAt - now) / 1000);
        res.set('Retry-After', String(wait));
        return res.status(429).json({ error: { code: 'RATE_LIMITED', message: `Too many attempts. Try again in ${wait}s.` } });
      }
    }
    if (hits.size > 5000) for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
    next();
  };
}
