// Controller entrypoint: wires DB pool, HTTP server (REST + cookie-session
// auth + SPA static), WS hub (/agent + /ui), in-process job workers, and
// the in-process Telegram bot (started only when TELEGRAM_TOKEN is set).

import http from 'node:http';
import { createLogger } from '@cp/shared/logger';
import { HEARTBEAT_INTERVAL_MS } from '@cp/shared/constants';
import { serializeError } from '@cp/shared/errors';
import { closeAll as closeQueues } from '@cp/queue';

import { loadControllerConfig } from './config.js';
import { initPool, closePool } from './db/pool.js';
import { buildHttpApp } from './api/server.js';
import { WsHub } from './ws/hub.js';
import { startWorkers } from './workers/jobWorker.js';
import { startBot } from './bot/start.js';

const logger = createLogger({ service: 'controller' });
const config = loadControllerConfig();

initPool(config.db);

// Late-bound reference the CRUD router uses for token rotation.
let hub;
const app = buildHttpApp({
  apiTokens: config.apiTokens,
  artifactSecret: config.artifactSecret,
  publicBaseUrl: config.publicBaseUrl,
  sessionSecret: config.jwtSecret,
  dashboardPasswordHash: config.dashboardPasswordHash,
  isProd: config.isProd,
  getWsHub: () => hub,
});
const httpServer = http.createServer(app);

hub = new WsHub({
  httpServer,
  heartbeatMs: HEARTBEAT_INTERVAL_MS,
  sessionSecret: config.jwtSecret,
});
hub.startHeartbeatMonitor();

const workers = startWorkers({
  hub,
  dispatchTimeoutMs: config.jobDispatchTimeoutMs,
  config,
});

const botLogger = createLogger({ service: 'bot' });
const bot = startBot({ logger: botLogger });

httpServer.listen(config.port, config.host, () => {
  logger.info({ host: config.host, port: config.port }, 'controller:listening');
});

const shutdown = async (signal) => {
  logger.info({ signal }, 'controller:shutdown');
  try {
    httpServer.close();
    hub.stop();
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
