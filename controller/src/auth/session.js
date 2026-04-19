// Signed session cookie + bcrypt password compare.
//
// Cookie format: a base64url payload `{exp:<unix-seconds>}` joined to a
// signature with cookie-signature.sign(). Stateless — no server-side store.

import bcrypt from 'bcryptjs';
import cookieSignature from 'cookie-signature';

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const SESSION_COOKIE_NAME = 'cp_session';

/** Returns true if the password matches the bcrypt hash. */
export function verifyPassword(plain, hash) {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(String(plain ?? ''), hash);
}

/** Produce a signed cookie value carrying an expiry. */
export function issueSessionToken(secret, { ttlSeconds = SESSION_TTL_SECONDS } = {}) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return cookieSignature.sign(payload, secret);
}

/** Returns { ok: true, exp } or { ok: false, reason }. */
export function verifySessionToken(secret, signedValue) {
  if (!signedValue) return { ok: false, reason: 'missing' };
  const payload = cookieSignature.unsign(signedValue, secret);
  if (payload === false) return { ok: false, reason: 'bad-signature' };
  let parsed;
  try { parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { return { ok: false, reason: 'bad-payload' }; }
  if (typeof parsed?.exp !== 'number') return { ok: false, reason: 'bad-payload' };
  if (parsed.exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
  return { ok: true, exp: parsed.exp };
}

export const COOKIE_DEFAULTS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  maxAge: SESSION_TTL_SECONDS * 1000,
  // `secure` is set by the caller based on NODE_ENV.
};
