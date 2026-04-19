// Per-request trace id. Accepts X-Request-Id from callers so end-to-end
// traces can be stitched from bot → controller → worker → agent logs.

import { randomUUID } from 'node:crypto';

export function requestId() {
  return (req, res, next) => {
    const incoming = req.headers['x-request-id'];
    req.requestId = typeof incoming === 'string' && incoming.length <= 64
      ? incoming
      : randomUUID();
    res.setHeader('x-request-id', req.requestId);
    next();
  };
}
