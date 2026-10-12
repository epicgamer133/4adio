import crypto from 'node:crypto';
import { config } from './config.js';

const COOKIE = 'rs_admin';
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map(); // token -> expiresAt
const failures = new Map(); // ip -> { count, until }

const salt = crypto.randomBytes(16);
const passwordHash = config.adminPassword ? crypto.scryptSync(config.adminPassword, salt, 64) : null;

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function cookie(value, maxAgeSec) {
  return [
    `${COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
    config.secureCookies ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

function sessionFrom(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const exp = sessions.get(token);
  if (!exp || exp < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return token;
}

export function isAdmin(req) {
  return Boolean(sessionFrom(req));
}

export function login(req, res) {
  const ip = req.ip;
  const f = failures.get(ip);
  if (f && f.until > Date.now()) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }
  if (!passwordHash) {
    return res.status(503).json({ error: 'ADMIN_PASSWORD is not set on the server.' });
  }
  const attempt = crypto.scryptSync(String(req.body?.password || ''), salt, 64);
  if (!crypto.timingSafeEqual(attempt, passwordHash)) {
    const count = (f?.count || 0) + 1;
    // 5 free tries, then an escalating lockout.
    failures.set(ip, { count, until: count >= 5 ? Date.now() + Math.min(60, 2 ** (count - 5)) * 60_000 : 0 });
    return res.status(401).json({ error: 'Wrong password.' });
  }
  failures.delete(ip);
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, Date.now() + SESSION_TTL);
  res.setHeader('Set-Cookie', cookie(token, SESSION_TTL / 1000));
  res.json({ ok: true });
}

export function logout(req, res) {
  const token = sessionFrom(req);
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', cookie('', 0));
  res.json({ ok: true });
}

/**
 * Guards every admin API route. The custom header blocks cross-site form
 * posts (browsers can't add it without a CORS preflight we never allow).
 */
export function requireAdmin(req, res, next) {
  if (req.get('X-Requested-With') !== 'radio-admin') return res.status(403).json({ error: 'Forbidden' });
  if (!sessionFrom(req)) return res.status(401).json({ error: 'Not logged in' });
  next();
}
