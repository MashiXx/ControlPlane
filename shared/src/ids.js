// Small id helpers. Using crypto.randomUUID to avoid an extra dependency.

import { randomUUID, createHash } from 'node:crypto';

export function newJobId() {
  return `job_${randomUUID()}`;
}

export function newSessionId() {
  return `sess_${randomUUID().slice(0, 12)}`;
}

// Stable idempotency key for "same action on same target within window".
// The window itself is enforced at enqueue time; this function just produces
// a deterministic fingerprint for the tuple.
export function idempotencyKey({ action, targetType, targetId, bucketMs }) {
  const bucket = Math.floor(Date.now() / bucketMs);
  return createHash('sha256')
    .update(`${action}|${targetType}|${targetId}|${bucket}`)
    .digest('hex')
    .slice(0, 32);
}

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}
