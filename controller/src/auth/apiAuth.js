// Bearer-token API auth middleware.
// Tokens come from CONTROLLER_API_TOKENS env var (see config.js).

import { AuthError } from '@cp/shared/errors';

export function apiAuth(tokens) {
  const byToken = new Map(tokens.map((t) => [t.token, t.name]));

  return (req, res, next) => {
    const header = req.headers.authorization ?? '';
    const match  = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return next(new AuthError('missing bearer token'));
    const name = byToken.get(match[1]);
    if (!name) return next(new AuthError('invalid token'));
    req.actor = `api:${name}`;
    next();
  };
}
