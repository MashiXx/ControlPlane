// BullMQ worker factory.
//
// Key behaviors:
//   - Worker code is provided by the caller (controller) as a `processor`
//     function receiving (job, context). The queue module stays agnostic
//     of business logic.
//   - Transient errors are re-thrown so BullMQ retries with backoff.
//   - Permanent errors are wrapped in BullMQ's UnrecoverableError so the
//     job fails immediately without burning retries.
//   - Every outcome is logged with a stable structured shape.

import { Worker, UnrecoverableError } from 'bullmq';
import { createLogger } from '@cp/shared/logger';
import { ControlPlaneError, serializeError } from '@cp/shared/errors';
import { getConnection } from './connection.js';

/**
 * @param {string}   queueName
 * @param {(job, ctx) => Promise<any>} processor
 * @param {object}   [opts]
 * @param {number}   [opts.concurrency]
 * @param {object}   [opts.context]      // passed verbatim to processor
 * @returns {Worker}
 */
export function createWorker(queueName, processor, opts = {}) {
  const logger = createLogger({ service: 'queue.worker', queue: queueName });
  const concurrency = opts.concurrency ?? Number(process.env.WORKER_CONCURRENCY ?? 4);

  const worker = new Worker(
    queueName,
    async (job) => {
      const started = Date.now();
      const base = { queueJobId: job.id, action: job.data?.action, attempt: job.attemptsMade + 1 };
      logger.info({ ...base, data: redactPayload(job.data) }, 'job:start');

      try {
        const result = await processor(job, opts.context ?? {});
        logger.info({ ...base, durationMs: Date.now() - started }, 'job:success');
        return result;
      } catch (err) {
        const durationMs = Date.now() - started;
        const serialized = serializeError(err);
        const transient = err instanceof ControlPlaneError ? err.transient : undefined;

        if (transient === false) {
          // Known permanent error — don't retry.
          logger.error({ ...base, durationMs, err: serialized }, 'job:permanent-failure');
          throw new UnrecoverableError(err.message || 'permanent error');
        }

        // Last attempt? Log as final failure. Otherwise BullMQ will retry.
        const willRetry = job.attemptsMade + 1 < (job.opts?.attempts ?? 1);
        logger.warn({ ...base, durationMs, willRetry, err: serialized }, 'job:failure');
        throw err;
      }
    },
    {
      connection: getConnection(),
      prefix: process.env.QUEUE_PREFIX ?? 'cp',
      concurrency,
      // One lock per job; extended automatically while the processor runs.
      lockDuration: 60_000,
      stalledInterval: 15_000,
    },
  );

  worker.on('error', (err) => {
    logger.error({ err: serializeError(err) }, 'worker:error');
  });
  worker.on('failed', (job, err) => {
    logger.warn(
      { queueJobId: job?.id, err: serializeError(err) },
      'worker:job-failed-event',
    );
  });
  worker.on('stalled', (jobId) => {
    logger.warn({ queueJobId: jobId }, 'worker:job-stalled');
  });

  return worker;
}

function redactPayload(data) {
  if (!data || typeof data !== 'object') return data;
  const { payload, ...rest } = data;
  if (!payload) return rest;
  const safe = { ...payload };
  for (const k of ['authToken', 'password', 'secret']) if (k in safe) safe[k] = '[REDACTED]';
  return { ...rest, payload: safe };
}
