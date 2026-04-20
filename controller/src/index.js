// Controller entrypoint. Wires:
//   - DB pool
//   - HTTP server (REST + cookie-session auth + SPA static)
//   - /ui WebSocket hub (dashboard live updates)
//   - in-process job workers (four named queues)
//   - state scheduler (SSH poll every STATE_POLL_INTERVAL_MS)
//   - in-process Telegram bot (started only when TELEGRAM_TOKEN is set)
//
// There is no longer an /agent WS endpoint, no agent-side bearer token, and
// no artifact HTTP blob route — rsync+ssh is the only artifact path, driven
// directly by the worker + state scheduler.

import http from 'node:http';
import { createLogger } from '@cp/shared/logger';
import { serializeError } from '@cp/shared/errors';
import { closeAll as closeQueues } from '@cp/queue';

import { loadControllerConfig } from './config.js';
import { initPool, closePool } from './db/pool.js';
import { buildHttpApp } from './api/server.js';
import { UiHub } from './ws/uiHub.js';
import { startWorkers } from './workers/jobWorker.js';
import { startBot } from './bot/start.js';
import { AlertManager } from './alerts/alertManager.js';
import { StateScheduler } from './pollers/stateScheduler.js';

const logger = createLogger({ service: 'controller' });
const config = loadControllerConfig();

initPool(config.db);

const app = buildHttpApp({
  apiTokens: config.apiTokens,
  sessionSecret: config.jwtSecret,
  dashboardPasswordHash: config.dashboardPasswordHash,
  isProd: config.isProd,
});
const httpServer = http.createServer(app);

// UI hub first — everything else broadcasts through it.
const uiHub = new UiHub({ httpServer, sessionSecret: config.jwtSecret });

// Alert manager broadcasts to the dashboard + (when the bot is up) Telegram.
const alertManager = new AlertManager({
  broadcastUi: (frame) => uiHub.broadcast(frame),
});

const workers = startWorkers({
  broadcastUi: (frame) => uiHub.broadcast(frame),
  config,
});

// State scheduler — periodic SSH probe that replaces agent heartbeats.
const stateScheduler = new StateScheduler({
  alertManager,
  broadcastUi: (frame) => uiHub.broadcast(frame),
});
stateScheduler.start();

const botLogger = createLogger({ service: 'bot' });
const bot = startBot({ logger: botLogger });
if (typeof bot.notifyAdmins === 'function') {
  alertManager.notifyChat = (text) => bot.notifyAdmins(text);
}

httpServer.listen(config.port, config.host, () => {
  logger.info({ host: config.host, port: config.port }, 'controller:listening');
});

const shutdown = async (signal) => {
  logger.info({ signal }, 'controller:shutdown');
  try {
    httpServer.close();
    stateScheduler.stop();
    uiHub.stop();
    await bot.stop();
    await Promise.all(workers.map((w) => w.close().catch(() => {})));
    await closeQueues();
    await closePool();
  } catch (err) {
    logger.error({ err: err.message }, 'shutdown:error');
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error({ err: serializeError(reason) }, 'unhandled-rejection');
});
process.on('uncaughtException', (err) => {
  logger.error({ err: serializeError(err) }, 'uncaught-exception');
});
