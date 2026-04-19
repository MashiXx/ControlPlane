// Auth middleware accepting EITHER:
//   - Authorization: Bearer <token> matching CONTROLLER_API_TOKENS
//   - cp_session signed cookie matching CONTROLLER_JWT_SECRET
//
// Sets req.actor:
//   - "api:<token-name>"  for bearer
//   - "web"               for cookie

import { AuthError } from '@cp/shared/errors';
import { SESSION_COOKIE_NAME, verifySessionToken } from './session.js';

export function requireAuth({ apiTokens, sessionSecret }) {
  const byToken = new Map(apiTokens.map((t) => [t.token, t.name]));

  return (req, _res, next) => {
    // 1. Bearer.
    const header = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (m) {
      const name = byToken.get(m[1]);
      if (!name) return next(new AuthError('invalid token'));
      req.actor = `api:${name}`;
      return next();
    }
    // 2. Cookie.
    const raw = req.cookies?.[SESSION_COOKIE_NAME];
    if (raw) {
      const v = verifySessionToken(sessionSecret, raw);
      if (v.ok) {
        req.actor = 'web';
        return next();
      }
    }
    return next(new AuthError('authentication required'));
  };
}
