// In-process job queues. No external broker — queues live in the controller
// process, backed by plain JS data structures.
//
// Surface kept intentionally close to the subset of BullMQ we used before:
//   - getQueue(name).add(jobName, data, opts)   → Promise<Job>
//   - queue.getJobCounts('wait','active',...)   → Promise<Record<state,number>>
//   - ALL_QUEUE_NAMES                           → array of known queue names
//   - closeAll()                                → cancels timers, stops dispatch
//
// Semantics worth knowing:
//   - `opts.jobId` is a uniqueness key. If a job with the same id is still
//     waiting/active/delayed/retained, `add` returns that existing job — this
//     is how producer.js implements the idempotency window.
//   - Retained completed/failed jobs are kept in-memory for `removeOnComplete`
//     / `removeOnFail` durations so late duplicates still dedupe.
//   - `opts.attempts` + `opts.backoff` drive retry scheduling; the worker
//     re-queues the same Job instance with a delay.
//   - No cross-process visibility. Jobs enqueued while the controller is down
//     are lost. That is the intended trade-off vs. Redis.

import { randomUUID } from 'node:crypto';
import { QueueName } from '@cp/shared/constants';

export const ALL_QUEUE_NAMES = Object.values(QueueName);

const queues = new Map();

const DEFAULT_JOB_OPTIONS = Object.freeze({
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail:     { age: 7 * 24 * 3600 },
});

// ─── Job ─────────────────────────────────────────────────────────────────

class InMemoryJob {
  constructor({ id, name, data, queue, opts }) {
    this.id = id;
    this.name = name;
    this.data = data;
    this.opts = opts;
    this.attemptsMade = 0;
    this.processedOn = null;
    this.finishedOn = null;
    this.returnvalue = null;
    this.failedReason = null;
    this._queue = queue;
  }
}

// ─── Queue ───────────────────────────────────────────────────────────────

class InMemoryQueue {
  constructor(name) {
    this.name = name;
    this.waiting = [];                     // FIFO of ready-to-run jobs
    this.active = new Set();               // jobs currently being processed
    this.delayed = new Map();              // jobId → { job, timer }
    this.completed = [];                   // recent successes (metrics)
    this.failed = [];                      // recent failures (metrics)
    this.byId = new Map();                 // jobId → Job (for dedup)
    this._retentionTimers = new Map();     // jobId → timer
    this._workers = new Set();
    this._closed = false;
  }

  async add(jobName, data, opts = {}) {
    if (this._closed) throw new Error(`queue ${this.name} is closed`);

    const merged = { ...DEFAULT_JOB_OPTIONS, ...opts };
    const id = merged.jobId ?? randomUUID();

    const existing = this.byId.get(id);
    if (existing) return existing;

    const job = new InMemoryJob({
      id,
      name: jobName,
      data,
      queue: this,
      opts: {
        jobId: id,
        attempts: merged.attempts ?? 1,
        backoff:  merged.backoff,
        delay:    merged.delay,
        removeOnComplete: merged.removeOnComplete,
        removeOnFail:     merged.removeOnFail,
      },
    });

    this.byId.set(id, job);

    const delay = Number(opts.delay ?? 0);
    if (delay > 0) {
      this._scheduleDelayed(job, delay);
    } else {
      this.waiting.push(job);
      this._signalWorkers();
    }
    return job;
  }

  async getJobCounts(...states) {
    const all = {
      wait:      this.waiting.length,
      active:    this.active.size,
      delayed:   this.delayed.size,
      failed:    this.failed.length,
      completed: this.completed.length,
    };
    if (states.length === 0) return all;
    const out = {};
    for (const s of states) out[s] = all[s] ?? 0;
    return out;
  }

  async close() {
    this._closed = true;
    for (const { timer } of this.delayed.values()) clearTimeout(timer);
    this.delayed.clear();
    for (const timer of this._retentionTimers.values()) clearTimeout(timer);
    this._retentionTimers.clear();
  }

  // ─── Worker-facing internals ───────────────────────────────────────────

  _registerWorker(w)   { this._workers.add(w); }
  _unregisterWorker(w) { this._workers.delete(w); }

  _takeOne() {
    return this.waiting.shift() ?? null;
  }

  _signalWorkers() {
    for (const w of this._workers) w._tryDrain();
  }

  _scheduleDelayed(job, ms) {
    const timer = setTimeout(() => {
      this.delayed.delete(job.id);
      if (this._closed) return;
      this.waiting.push(job);
      this._signalWorkers();
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    this.delayed.set(job.id, { job, timer });
  }

  _settle(job, kind, err) {
    this.active.delete(job);
    job.finishedOn = Date.now();

    const bucket = kind === 'completed' ? this.completed : this.failed;
    const retention = kind === 'completed' ? job.opts.removeOnComplete : job.opts.removeOnFail;
    if (kind === 'failed') {
      job.failedReason = err?.message ?? String(err);
    }

    bucket.push({ id: job.id, ts: job.finishedOn, reason: job.failedReason ?? undefined });
    const countCap = retention?.count;
    if (countCap && bucket.length > countCap) {
      bucket.splice(0, bucket.length - countCap);
    }

    const ageSec = retention?.age;
    if (ageSec && ageSec > 0) {
      const t = setTimeout(() => {
        this.byId.delete(job.id);
        this._retentionTimers.delete(job.id);
      }, ageSec * 1000);
      if (typeof t.unref === 'function') t.unref();
      this._retentionTimers.set(job.id, t);
    } else {
      this.byId.delete(job.id);
    }
  }
}

// ─── Module-level accessors ──────────────────────────────────────────────

export function getQueue(name) {
  if (!ALL_QUEUE_NAMES.includes(name)) {
    throw new Error(`unknown queue: ${name}`);
  }
  let q = queues.get(name);
  if (!q) {
    q = new InMemoryQueue(name);
    queues.set(name, q);
  }
  return q;
}

export async function closeAll() {
  await Promise.all([...queues.values()].map((q) => q.close().catch(() => {})));
  queues.clear();
}

// Bubble up the retry-backoff helper so the worker can share it without
// reaching into Queue internals.
export function computeBackoffMs(job) {
  const b = job.opts?.backoff;
  if (!b) return 0;
  const base = Number(b.delay ?? 0);
  if (b.type === 'exponential') {
    // attemptsMade is incremented before we compute backoff, so use (n-1).
    const n = Math.max(1, job.attemptsMade);
    return base * (2 ** (n - 1));
  }
  return base;
}

// Signal a permanent failure from inside a processor — worker short-circuits
// retry when it sees this name, mirroring BullMQ's UnrecoverableError.
export class UnrecoverableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnrecoverableError';
  }
}
