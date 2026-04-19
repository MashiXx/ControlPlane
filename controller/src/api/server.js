import express from 'express';
import cookieParser from 'cookie-parser';
import { requireAuth } from '../auth/requireAuth.js';
import { authRouter } from './routes/auth.js';
import { actionsRouter } from './routes/actions.js';
import { readRouter } from './routes/read.js';
import { metricsRouter } from './routes/metrics.js';
import { artifactBlobRouter, artifactTokenRouter } from './routes/artifacts.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestLog } from './middleware/requestLog.js';
import { requestId } from './middleware/requestId.js';

export function buildHttpApp({
  apiTokens,
  artifactSecret,
  publicBaseUrl,
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

  // Artifact blob endpoint: token-authenticated (NO bearer required).
  // Must sit above /api so agents can fetch without an API token.
  app.use('/', artifactBlobRouter({ secret: artifactSecret }));

  // Everything under /api requires bearer OR session cookie.
  app.use('/api', requireAuth({ apiTokens, sessionSecret }));
  app.use('/api', readRouter());
  app.use('/api', metricsRouter());
  app.use('/api', artifactTokenRouter({ secret: artifactSecret, publicBaseUrl }));
  app.use('/api', actionsRouter());

  app.use(errorHandler);
  return app;
}
