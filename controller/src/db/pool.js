import mysql from 'mysql2/promise';

let pool = null;

export function initPool(dbConfig) {
  if (pool) return pool;
  pool = mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    namedPlaceholders: true,
    timezone: 'Z',
  });
  return pool;
}

export function getPool() {
  if (!pool) throw new Error('DB pool not initialized');
  return pool;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
