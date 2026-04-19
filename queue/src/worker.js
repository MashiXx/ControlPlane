// Worker factory for the in-process queue.
//
// Responsibilities:
//   - Pop jobs from a queue respecting a per-worker concurrency limit.
//   - Invoke the caller-supplied `processor(job, ctx)`.
//   - Retry transient failures with the job's configured backoff.
//   - Treat UnrecoverableError (or err.transient === false) as permanent.
//   - Log every outcome with a stable structured shape.

import { EventEmitter } from 'node:events';
import { createLogger } from '@cp/shared/logger';
import { ControlPlaneError, serializeError } from '@cp/shared/errors';
import { getQueue, computeBackoffMs, UnrecoverableError } from './queues.js';

/**
 * @param {string}   queueName
 * @param {(job, ctx) => Promise<any>} processor
 * @param {object}   [opts]
 * @param {number}   [opts.concurrency]
 * @param {object}   [opts.context]       // passed verbatim to processor
 * @returns {InMemoryWorker}
 */
export function createWorker(queueName, processor, opts = {}) {
  return new InMemoryWorker(queueName, processor, opts);
}

class InMemoryWorker extends EventEmitter {
  constructor(queueName, processor, opts = {}) {
    super();
    this.queue = getQueue(queueName);
    this.processor = processor;
    this.concurrency = opts.concurrency ?? Number(process.env.WORKER_CONCURRENCY ?? 4);
    this.context = opts.context ?? {};
    this.logger = createLogger({ service: 'queue.worker', queue: queueName });

    this._running = 0;
    this._inflight = new Set();
    this._closed = false;

    this.queue._registerWorker(this);
    // Let the caller finish wiring before we start draining.
    queueMicrotask(() => this._tryDrain());
  }

  async close() {
    this._closed = true;
    this.queue._unregisterWorker(this);
    await Promise.allSettled(this._inflight);
  }

  _tryDrain() {
    if (this._closed) return;
    while (this._running < this.concurrency) {
      const job = this.queue._takeOne();
      if (!job) return;
      this._run(job);
    }
  }

  _run(job) {
    this._running++;
    this.queue.active.add(job);
    job.processedOn = Date.now();
    job.attemptsMade += 1;

    const base = { queueJobId: job.id, action: job.data?.action, attempt: job.attemptsMade };
    this.logger.info({ ...base, data: redactPayload(job.data) }, 'job:start');

    const p = (async () => {
      const startedAt = Date.now();
      try {
        const result = await this.processor(job, this.context);
        job.returnvalue = result;
        this.queue._settle(job, 'completed');
        this.logger.info({ ...base, durationMs: Date.now() - startedAt }, 'job:success');
        return;
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        const serialized = serializeError(err);
        const transient = err instanceof ControlPlaneError ? err.transient : undefined;
        const permanent = err instanceof UnrecoverableError || transient === false;

        const maxAttempts = job.opts.attempts ?? 1;
        const canRetry = !permanent && job.attemptsMade < maxAttempts;

        if (!canRetry) {
          this.logger.error(
            { ...base, durationMs, err: serialized },
            permanent ? 'job:permanent-failure' : 'job:failure',
          );
          this.queue._settle(job, 'failed', err);
          this.emit('failed', job, err);
          return;
        }

        // Retry: leave the job registered in byId (so concurrent dedup still
        // works) and push it back through the delayed bucket.
        this.queue.active.delete(job);
        const delay = computeBackoffMs(job);
        this.logger.warn(
          { ...base, durationMs, willRetry: true, retryInMs: delay, err: serialized },
          'job:failure',
        );
        this.queue._scheduleDelayed(job, delay);
      }
    })().catch((err) => {
      // Defensive: processor throwing synchronously after settle shouldn't
      // crash the worker loop.
      this.logger.error({ err: serializeError(err) }, 'worker:internal-error');
      this.emit('error', err);
    }).finally(() => {
      this._running--;
      this._inflight.delete(p);
      if (!this._closed) this._tryDrain();
    });

    this._inflight.add(p);
  }
}

function redactPayload(data) {
  if (!data || typeof data !== 'object') return data;
  const { payload, ...rest } = data;
  if (!payload) return rest;
  const safe = { ...payload };
  for (const k of ['authToken', 'password', 'secret']) if (k in safe) safe[k] = '[REDACTED]';
  return { ...rest, payload: safe };
}
