// Lightweight JSON metrics. Easy to flip to Prometheus later; for now a
// machine-readable dashboard-friendly snapshot is enough.

import { Router } from 'express';
import { getQueue, ALL_QUEUE_NAMES } from '@cp/queue';
import { getPool } from '../../db/pool.js';

export function metricsRouter() {
  const r = Router();

  r.get('/metrics', async (_req, res, next) => {
    try {
      const pool = getPool();
      const [appsByState] = await pool.query(
        'SELECT process_state AS state, COUNT(*) AS n FROM application_servers GROUP BY process_state',
      );
      const [jobsByStatus] = await pool.query(
        `SELECT status, COUNT(*) AS n FROM jobs
         WHERE enqueued_at > (NOW() - INTERVAL 24 HOUR)
         GROUP BY status`,
      );
      const [serversByStatus] = await pool.query(
        'SELECT status, COUNT(*) AS n FROM servers GROUP BY status',
      );

      const queues = {};
      for (const name of ALL_QUEUE_NAMES) {
        const q = getQueue(name);
        queues[name] = await q.getJobCounts('wait', 'active', 'delayed', 'failed', 'completed');
      }

      res.json({
        ts: new Date().toISOString(),
        applications: reshape(appsByState, 'state'),
        jobs_24h:     reshape(jobsByStatus, 'status'),
        servers:      reshape(serversByStatus, 'status'),
        queues,
      });
    } catch (e) { next(e); }
  });

  return r;
}

function reshape(rows, key) {
  const out = {};
  for (const row of rows) out[row[key]] = Number(row.n);
  return out;
}
