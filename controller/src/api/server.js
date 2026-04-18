import express from 'express';
import { apiAuth } from '../auth/apiAuth.js';
import { actionsRouter } from './routes/actions.js';
import { readRouter } from './routes/read.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestLog } from './middleware/requestLog.js';

export function buildHttpApp({ apiTokens }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use(requestLog());

  // Public
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/readyz',  (_req, res) => res.json({ ok: true }));

  // Everything under /api requires an API token.
  app.use('/api', apiAuth(apiTokens));
  app.use('/api', readRouter());
  app.use('/api', actionsRouter());

  app.use(errorHandler);
  return app;
}
