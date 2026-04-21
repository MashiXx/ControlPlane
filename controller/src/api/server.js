import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAuth } from '../auth/requireAuth.js';
import { authRouter } from './routes/auth.js';
import { actionsRouter } from './routes/actions.js';
import { readRouter } from './routes/read.js';
import { crudRouter } from './routes/crud.js';
import { replicasRouter } from './routes/replicas.js';
import { metricsRouter } from './routes/metrics.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestLog } from './middleware/requestLog.js';
import { requestId } from './middleware/requestId.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function buildHttpApp({
  apiTokens,
  sessionSecret,
  dashboardPasswordHash,
  isProd,
}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use(requestId());
  app.use(requestLog());

  // Public
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/readyz',  (_req, res) => res.json({ ok: true }));

  // Auth endpoints — public (no requireAuth).
  app.use('/', authRouter({
    passwordHash: dashboardPasswordHash,
    sessionSecret,
    isProd,
  }));

  // Everything under /api requires bearer OR session cookie.
  app.use('/api', requireAuth({ apiTokens, sessionSecret }));
  app.use('/api', replicasRouter());
  app.use('/api', readRouter());
  app.use('/api', metricsRouter());
  app.use('/api', crudRouter());
  app.use('/api', actionsRouter());

  // SPA static assets. Served last so it doesn't shadow /api or /auth.
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  app.use(errorHandler);
  return app;
}
