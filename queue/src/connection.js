// Single shared Redis connection factory.
// BullMQ requires maxRetriesPerRequest: null for blocking commands.

import IORedis from 'ioredis';

let connection = null;

export function getRedisOptions() {
  return {
    host:     process.env.REDIS_HOST ?? '127.0.0.1',
    port:     Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db:       Number(process.env.REDIS_DB ?? 0),
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };
}

export function getConnection() {
  if (!connection) connection = new IORedis(getRedisOptions());
  return connection;
}

export async function closeConnection() {
  if (connection) {
    await connection.quit().catch(() => {});
    connection = null;
  }
}
