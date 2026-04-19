// Dashboard auth endpoints. Mounted at the app root (NOT under /api),
// so /auth/* is reachable without a bearer token.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  COOKIE_DEFAULTS,
  SESSION_COOKIE_NAME,
  issueSessionToken,
  verifyPassword,
  verifySessionToken,
} from '../../auth/session.js';

export function authRouter({ passwordHash, sessionSecret, isProd }) {
  const r = Router();

  const loginLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10, // per IP per minute
    standardHeaders: true,
    legacyHeaders: false,
  });

  r.post('/auth/login', loginLimiter, async (req, res) => {
    if (!passwordHash) {
      return res.status(503).json({
        error: { code: 'E_NOT_CONFIGURED', message: 'DASHBOARD_PASSWORD_HASH is not set' },
      });
    }
    const password = req.body?.password;
    const ok = await verifyPassword(password, passwordHash);
    if (!ok) {
      return res.status(401).json({ error: { code: 'E_AUTH', message: 'invalid password' } });
    }
    const token = issueSessionToken(sessionSecret);
    res.cookie(SESSION_COOKIE_NAME, token, { ...COOKIE_DEFAULTS, secure: isProd });
    res.json({ ok: true });
  });

  r.post('/auth/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });

  r.get('/auth/me', (req, res) => {
    const raw = req.cookies?.[SESSION_COOKIE_NAME];
    const v = verifySessionToken(sessionSecret, raw);
    if (!v.ok) return res.status(401).json({ authenticated: false });
    res.json({ authenticated: true, exp: v.exp });
  });

  return r;
}
