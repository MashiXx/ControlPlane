// Web dashboard server.
//
// Serves the SPA under / and proxies /api/* to the controller, injecting
// the bearer token server-side so the browser never holds it. Browser WS
// connects directly to the controller's /ui endpoint.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createLogger } from '@cp/shared/logger';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = createLogger({ service: 'web' });

const port           = Number(process.env.WEB_PORT ?? 8081);
const controllerUrl  = process.env.TELEGRAM_CONTROLLER_URL ?? process.env.CONTROLLER_URL ?? 'http://127.0.0.1:8080';
const controllerToken = process.env.WEB_CONTROLLER_TOKEN ?? process.env.TELEGRAM_CONTROLLER_TOKEN ?? '';
const controllerWs   = (process.env.CONTROLLER_WS_PUBLIC_URL
  ?? controllerUrl.replace(/^http/, 'ws')) + '/ui';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '128kb' }));

// Inject WS URL into the browser bootstrap.
app.get('/bootstrap.js', (_req, res) => {
  res.type('application/javascript').send(
    `window.__CP__ = ${JSON.stringify({ controllerWs })};`,
  );
});

// Pass-through proxy that tacks the bearer token on server-side.
app.use('/api', async (req, res) => {
  try {
    const url = `${controllerUrl}${req.originalUrl}`;
    const upstream = await fetch(url, {
      method: req.method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${controllerToken}`,
        'x-request-id': req.headers['x-request-id'] ?? '',
      },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
    });
    const text = await upstream.text();
    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.type(ct);
    res.send(text);
  } catch (err) {
    logger.error({ err: err.message, path: req.path }, 'proxy:error');
    res.status(502).json({ error: { code: 'E_UPSTREAM', message: err.message } });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(port, () => {
  logger.info({ port, controllerUrl, controllerWs }, 'web:listening');
});
