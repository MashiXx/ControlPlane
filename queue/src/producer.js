// Enqueues actions onto the correct in-process queue.
//
// Every enqueue derives:
//   - queue name          from QueueForAction[action]
//   - retry profile       from RetryProfile[action]
//   - idempotency key     from (action, targetType, targetId, IDEMPOTENCY_WINDOW_MS)
//
// The queue treats `jobId` as a uniqueness key: if a job with the same id
// already exists (waiting/active/delayed/retained), the producer returns that
// existing job instead of creating a duplicate. We piggy-back on that to
// implement "same action on same target within a short window = same job".

import {
  JobAction,
  JobActions,
  JobTargetType,
  QueueForAction,
  RetryProfile,
  IDEMPOTENCY_WINDOW_MS,
} from '@cp/shared/constants';
import { idempotencyKey } from '@cp/shared/ids';
import { ValidationError } from '@cp/shared/errors';
import { getQueue } from './queues.js';

/**
 * @typedef {Object} EnqueueInput
 * @property {'start'|'stop'|'restart'|'build'|'deploy'|'healthcheck'} action
 * @property {'app'|'group'|'server'} targetType
 * @property {string|number} targetId   // app id, group name, server id, etc.
 * @property {string}   triggeredBy     // "telegram:123", "web:alice", "system"
 * @property {Object}   [payload]       // action-specific payload
 * @property {number}   [attemptsOverride]
 * @property {number}   [delayMs]
 * @property {string}   [parentJobId]   // queue job id of the parent (group fan-out)
 */

// Pure, deterministic: derive the identity pair (queueJobId, idempotencyKey)
// without touching the queue. Lets orchestrators commit the `jobs` DB row
// BEFORE pushing to the queue so workers can never race ahead of the row.
export function jobIdentity(input) {
  validateInput(input);
  const { action, targetType, targetId } = input;
  const key = idempotencyKey({
    action, targetType, targetId: String(targetId),
    bucketMs: IDEMPOTENCY_WINDOW_MS,
  });
  return {
    queueJobId:     `${action}:${targetType}:${targetId}:${key}`,
    idempotencyKey: key,
  };
}

export async function enqueueAction(input) {
  const {
    action, targetType, targetId, triggeredBy,
    payload = {}, attemptsOverride, delayMs, parentJobId,
  } = input;

  const queueName = QueueForAction[action];
  if (!queueName) throw new ValidationError(`no queue mapped for action: ${action}`);

  const profile = RetryProfile[action];
  const attempts = attemptsOverride ?? profile.attempts;
  const backoff  = profile.backoff;

  const { queueJobId: jobId, idempotencyKey: key } = jobIdentity(input);

  const queue = getQueue(queueName);
  const job = await queue.add(
    action,
    { action, targetType, targetId, triggeredBy, payload, parentJobId },
    {
      jobId,
      attempts,
      backoff,
      delay: delayMs,
      // Keep payload small; full stdout goes to DB audit, not the in-memory queue.
      removeOnComplete: { age: 3600, count: 500 },
      removeOnFail:     { age: 7 * 24 * 3600 },
    },
  );

  return {
    queueJobId: job.id,
    queueName,
    idempotencyKey: key,
    attempts,
    reused: job.attemptsMade > 0 || job.processedOn != null,
  };
}

function validateInput(input) {
  if (!input || typeof input !== 'object') throw new ValidationError('enqueue: missing input');
  if (!JobActions.includes(input.action)) {
    throw new ValidationError(`enqueue: invalid action '${input.action}'`);
  }
  if (!Object.values(JobTargetType).includes(input.targetType)) {
    throw new ValidationError(`enqueue: invalid targetType '${input.targetType}'`);
  }
  if (input.targetId === undefined || input.targetId === null || input.targetId === '') {
    throw new ValidationError('enqueue: targetId required');
  }
  if (!input.triggeredBy) {
    throw new ValidationError('enqueue: triggeredBy required');
  }
}

// Convenience: fan out a group action into per-application jobs.
export async function enqueueGroupAction({ action, applications, triggeredBy, payload }) {
  if (!Array.isArray(applications) || applications.length === 0) {
    throw new ValidationError('enqueueGroupAction: applications must be non-empty');
  }
  const children = [];
  for (const app of applications) {
    const res = await enqueueAction({
      action,
      targetType: JobTargetType.APP,
      targetId: app.id,
      triggeredBy,
      payload: { ...payload, appName: app.name },
    });
    children.push({ applicationId: app.id, ...res });
  }
  return children;
}

// Re-exports for callers.
export { JobAction, JobTargetType };
