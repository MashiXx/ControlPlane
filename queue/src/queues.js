// Lazily-instantiated BullMQ Queue + QueueEvents per named queue.
// One queue per action category so a slow build never starves a restart.

import { Queue, QueueEvents } from 'bullmq';
import { QueueName } from '@cp/shared/constants';
import { getConnection } from './connection.js';

const queues = new Map();        // name -> Queue
const queueEvents = new Map();   // name -> QueueEvents

export const ALL_QUEUE_NAMES = Object.values(QueueName);

function prefix() {
  return process.env.QUEUE_PREFIX ?? 'cp';
}

export function getQueue(name) {
  if (!ALL_QUEUE_NAMES.includes(name)) {
    throw new Error(`unknown queue: ${name}`);
  }
  if (!queues.has(name)) {
    queues.set(name, new Queue(name, {
      connection: getConnection(),
      prefix: prefix(),
      defaultJobOptions: {
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail:     { age: 7  * 24 * 3600 },
      },
    }));
  }
  return queues.get(name);
}

export function getQueueEvents(name) {
  if (!queueEvents.has(name)) {
    queueEvents.set(name, new QueueEvents(name, {
      connection: getConnection(),
      prefix: prefix(),
    }));
  }
  return queueEvents.get(name);
}

export async function closeAll() {
  await Promise.all([...queues.values()].map((q) => q.close().catch(() => {})));
  await Promise.all([...queueEvents.values()].map((qe) => qe.close().catch(() => {})));
  queues.clear();
  queueEvents.clear();
}
