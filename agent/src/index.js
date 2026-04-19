// Agent entrypoint.
// Boots the process manager, opens the WS connection to the controller,
// and routes incoming EXECUTE frames to the job handler.

import { createLogger } from '@cp/shared/logger';
import { WsOp } from '@cp/shared/constants';
import { serializeError } from '@cp/shared/errors';
import { schemas } from '@cp/shared';

import { loadAgentConfig } from './config.js';
import { ProcessManager } from './processManager.js';
import { AgentWsClient } from './wsClient.js';
import { handleExecute } from './jobHandler.js';

const config = loadAgentConfig();
const logger = createLogger({ service: 'agent', agentId: config.agentId });
const pm = new ProcessManager({ logger: logger.child({ m: 'pm' }) });

const client = new AgentWsClient({
  config,
  logger: logger.child({ m: 'ws' }),
  getAppsSnapshot: () => pm.snapshot(),
  onFrame: async (op, frame) => {
    switch (op) {
      case WsOp.WELCOME:
        logger.info({ sessionId: frame.sessionId }, 'ws:welcome');
        return;

      case WsOp.EXECUTE: {
        const parsed = schemas.WsExecute.safeParse(frame);
        if (!parsed.success) {
          logger.warn({ issues: parsed.error.flatten() }, 'ws:bad-execute');
          client.sendError(frame.jobId ?? 'unknown', new Error('invalid execute frame'));
          return;
        }
        const exec = parsed.data;
        const started = Date.now();
        client.sendJobUpdate(exec.jobId, 'starting');
        try {
          const res = await handleExecute(exec, {
            pm,
            logger: logger.child({ jobId: exec.jobId }),
            sendChunk: (jobId, stream, buf) => client.sendLogChunk(jobId, stream, buf),
          });
          client.sendJobResult(exec.jobId, {
            success: true,
            durationMs: Date.now() - started,
            exitCode: res.exitCode ?? 0,
            stdoutTail: res.stdoutTail ?? '',
            stderrTail: res.stderrTail ?? '',
          });
        } catch (err) {
          const s = serializeError(err);
          logger.error({ jobId: exec.jobId, err: s }, 'job:error');
          client.sendJobResult(exec.jobId, {
            success: false,
            durationMs: Date.now() - started,
            exitCode: null,
            stdoutTail: '',
            stderrTail: err?.meta?.stderrTail ?? '',
            error: { code: s.code, message: s.message, transient: s.transient },
          });
        }
        return;
      }

      case WsOp.CANCEL:
        logger.info({ jobId: frame.jobId }, 'ws:cancel (not implemented)');
        return;

      case WsOp.PING:
        return;

      default:
        logger.debug({ op }, 'ws:unhandled-op');
    }
  },
});

client.start();
logger.info({ controller: config.controllerUrl }, 'agent:started');

const shutdown = async (signal) => {
  logger.info({ signal }, 'agent:shutdown');
  await client.stop();
  process.exit(0);
};
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error({ err: serializeError(reason) }, 'unhandled-rejection');
});
process.on('uncaughtException', (err) => {
  logger.error({ err: serializeError(err) }, 'uncaught-exception');
});
