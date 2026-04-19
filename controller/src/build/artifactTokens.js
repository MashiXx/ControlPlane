// HMAC-based short-lived tokens for artifact download URLs.
// Stateless: verification needs only the shared secret and the current time.

import crypto from 'node:crypto';
import { ARTIFACT_TOKEN_TTL_SEC } from '@cp/shared/constants';
import { AuthError } from '@cp/shared/errors';

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  const pad = 4 - (s.length % 4 || 4);
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad % 4), 'base64');
}

export function issueArtifactToken({ secret, artifactId, ttlSec = ARTIFACT_TOKEN_TTL_SEC }) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = `${artifactId}.${exp}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest();
  return `${payload}.${b64url(sig)}`;
}

export function verifyArtifactToken({ secret, token, artifactId }) {
  if (!token || typeof token !== 'string') throw new AuthError('missing token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('malformed token');
  const [tokId, expStr, sigStr] = parts;
  if (String(artifactId) !== tokId) throw new AuthError('token/artifact mismatch');
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    throw new AuthError('token expired');
  }
  const expected = crypto.createHmac('sha256', secret).update(`${tokId}.${expStr}`).digest();
  const provided = b64urlDecode(sigStr);
  if (expected.length !== provided.length
      || !crypto.timingSafeEqual(expected, provided)) {
    throw new AuthError('token signature invalid');
  }
}
