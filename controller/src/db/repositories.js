// Thin repository layer over mysql2. Each function takes an optional
// connection so a caller can opt into a transaction; otherwise the pool
// is used directly.

import { getPool } from './pool.js';
import { NotFoundError } from '@cp/shared/errors';

const conn = (c) => c ?? getPool();

// ─── servers ────────────────────────────────────────────────────────────
export const servers = {
  async findByTokenHash(hash, c) {
    const [rows] = await conn(c).execute(
      'SELECT * FROM servers WHERE auth_token_hash = :hash LIMIT 1',
      { hash },
    );
    return rows[0] ?? null;
  },
  async get(id, c) {
    const [rows] = await conn(c).execute(
      'SELECT * FROM servers WHERE id = :id LIMIT 1',
      { id },
    );
    if (!rows[0]) throw new NotFoundError('server', id);
    return rows[0];
  },
  async list(c) {
    const [rows] = await conn(c).execute('SELECT * FROM servers ORDER BY name');
    return rows;
  },
  async updateStatus(id, status, c) {
    await conn(c).execute(
      'UPDATE servers SET status = :status, last_seen_at = CURRENT_TIMESTAMP WHERE id = :id',
      { id, status },
    );
  },
  async updateSeen(id, patch = {}, c) {
    await conn(c).execute(
      `UPDATE servers SET status='online', last_seen_at=CURRENT_TIMESTAMP,
              agent_version = COALESCE(:version, agent_version),
              os            = COALESCE(:os, os)
       WHERE id = :id`,
      { id, version: patch.version ?? null, os: patch.os ?? null },
    );
  },
};

// ─── groups ─────────────────────────────────────────────────────────────
export const groups = {
  async getByName(name, c) {
    const [rows] = await conn(c).execute(
      'SELECT * FROM `groups` WHERE name = :name LIMIT 1',
      { name },
    );
    return rows[0] ?? null;
  },
  async list(c) {
    const [rows] = await conn(c).execute('SELECT * FROM `groups` ORDER BY name');
    return rows;
  },
};

// ─── applications ───────────────────────────────────────────────────────
export const applications = {
  async get(id, c) {
    const [rows] = await conn(c).execute(
      'SELECT * FROM applications WHERE id = :id LIMIT 1',
      { id },
    );
    if (!rows[0]) throw new NotFoundError('application', id);
    return rows[0];
  },
  async listByGroupName(name, c) {
    const [rows] = await conn(c).execute(
      `SELECT a.* FROM applications a
       JOIN \`groups\` g ON g.id = a.group_id
       WHERE g.name = :name AND a.enabled = 1
       ORDER BY a.name`,
      { name },
    );
    return rows;
  },
  async list(c) {
    const [rows] = await conn(c).execute('SELECT * FROM applications ORDER BY name');
    return rows;
  },
  async updateProcessState(id, patch, c) {
    await conn(c).execute(
      `UPDATE applications SET
         process_state   = COALESCE(:state,       process_state),
         pid             = :pid,
         uptime_seconds  = :uptime,
         last_exit_code  = COALESCE(:exitCode,    last_exit_code)
       WHERE id = :id`,
      {
        id,
        state:    patch.state    ?? null,
        pid:      patch.pid      ?? null,
        uptime:   patch.uptime   ?? null,
        exitCode: patch.exitCode ?? null,
      },
    );
  },
};

// ─── jobs ───────────────────────────────────────────────────────────────
export const jobs = {
  async insert(row, c) {
    const [res] = await conn(c).execute(
      `INSERT INTO jobs
         (queue_job_id, parent_job_id, idempotency_key, action, target_type,
          application_id, group_id, server_id, status, attempts, max_attempts,
          triggered_by, payload, enqueued_at)
       VALUES
         (:queueJobId, :parentJobId, :idempotencyKey, :action, :targetType,
          :applicationId, :groupId, :serverId, 'pending', 0, :maxAttempts,
          :triggeredBy, :payload, CURRENT_TIMESTAMP)`,
      {
        queueJobId: row.queueJobId,
        parentJobId: row.parentJobId ?? null,
        idempotencyKey: row.idempotencyKey ?? null,
        action: row.action,
        targetType: row.targetType,
        applicationId: row.applicationId ?? null,
        groupId: row.groupId ?? null,
        serverId: row.serverId ?? null,
        maxAttempts: row.maxAttempts ?? 3,
        triggeredBy: row.triggeredBy,
        payload: row.payload ? JSON.stringify(row.payload) : null,
      },
    );
    return res.insertId;
  },
  async getByQueueJobId(queueJobId, c) {
    const [rows] = await conn(c).execute(
      'SELECT * FROM jobs WHERE queue_job_id = :queueJobId LIMIT 1',
      { queueJobId },
    );
    return rows[0] ?? null;
  },
  async get(id, c) {
    const [rows] = await conn(c).execute(
      'SELECT * FROM jobs WHERE id = :id LIMIT 1',
      { id },
    );
    return rows[0] ?? null;
  },
  async markRunning(queueJobId, attempt, c) {
    await conn(c).execute(
      `UPDATE jobs SET status='running', attempts = :attempt,
                      started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
       WHERE queue_job_id = :queueJobId`,
      { queueJobId, attempt },
    );
  },
  async markFinished(queueJobId, status, { result, errorCode, errorMessage }, c) {
    await conn(c).execute(
      `UPDATE jobs SET status = :status, finished_at = CURRENT_TIMESTAMP,
                      result = :result, error_code = :errorCode,
                      error_message = :errorMessage
       WHERE queue_job_id = :queueJobId`,
      {
        queueJobId, status,
        result: result ? JSON.stringify(result) : null,
        errorCode: errorCode ?? null,
        errorMessage: errorMessage ?? null,
      },
    );
  },
  async listRecent(limit = 100, c) {
    const [rows] = await conn(c).query(
      'SELECT * FROM jobs ORDER BY enqueued_at DESC LIMIT ?',
      [limit],
    );
    return rows;
  },
};

// ─── audit ──────────────────────────────────────────────────────────────
export const audit = {
  async write(row, c) {
    await conn(c).execute(
      `INSERT INTO audit_logs
         (actor, action, target_type, target_id, job_id, result,
          http_status, message, metadata)
       VALUES
         (:actor, :action, :targetType, :targetId, :jobId, :result,
          :httpStatus, :message, :metadata)`,
      {
        actor:      row.actor,
        action:     row.action,
        targetType: row.targetType,
        targetId:   row.targetId ?? null,
        jobId:      row.jobId ?? null,
        result:     row.result ?? 'info',
        httpStatus: row.httpStatus ?? null,
        message:    row.message ?? null,
        metadata:   row.metadata ? JSON.stringify(row.metadata) : null,
      },
    );
  },
  async listRecent(limit = 100, c) {
    const [rows] = await conn(c).query(
      'SELECT * FROM audit_logs ORDER BY occurred_at DESC LIMIT ?',
      [limit],
    );
    return rows;
  },
};
