// Thin repository layer over mysql2. Each function takes an optional
// connection so a caller can opt into a transaction; otherwise the pool
// is used directly.

import { getPool } from './pool.js';
import { NotFoundError, ConflictError } from '@cp/shared/errors';

const conn = (c) => c ?? getPool();

// Build a dynamic UPDATE statement from a patch, restricted to a whitelist
// of column names so an attacker-controlled patch key can't touch other
// columns. Returns null when the patch has nothing the whitelist accepts.
function buildUpdate(table, id, patch, allowed) {
  const fields = Object.keys(patch).filter((k) => allowed.has(k));
  if (fields.length === 0) return null;
  const set = fields.map((f) => `\`${f}\` = :${f}`).join(', ');
  const params = { id };
  for (const f of fields) {
    const v = patch[f];
    params[f] = (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
  }
  return {
    sql: `UPDATE \`${table}\` SET ${set} WHERE id = :id`,
    params,
  };
}

// ─── servers ────────────────────────────────────────────────────────────
const SERVER_EDITABLE_FIELDS = new Set([
  'name', 'hostname', 'labels', 'artifact_transfer',
]);

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
  async create({ row, tokenHash }, c) {
    const [res] = await conn(c).execute(
      `INSERT INTO servers
         (name, hostname, auth_token_hash, artifact_transfer, labels)
       VALUES
         (:name, :hostname, :tokenHash, :artifactTransfer, :labels)`,
      {
        name: row.name,
        hostname: row.hostname,
        tokenHash,
        artifactTransfer: row.artifact_transfer,
        labels: row.labels ? JSON.stringify(row.labels) : null,
      },
    );
    return this.get(res.insertId, c);
  },
  async update(id, patch, c) {
    const q = buildUpdate('servers', id, patch, SERVER_EDITABLE_FIELDS);
    if (!q) return this.get(id, c);
    await conn(c).execute(q.sql, q.params);
    return this.get(id, c);
  },
  async rotateToken(id, tokenHash, c) {
    const [res] = await conn(c).execute(
      'UPDATE servers SET auth_token_hash = :tokenHash WHERE id = :id',
      { id, tokenHash },
    );
    if (res.affectedRows === 0) throw new NotFoundError('server', id);
  },
  async delete(id, c) {
    const n = await applications.countByServerId(id, c);
    if (n > 0) {
      throw new ConflictError(
        `server ${id} still has ${n} application(s); delete or migrate them first`,
        { appsReferencing: n },
      );
    }
    const [res] = await conn(c).execute('DELETE FROM servers WHERE id = :id', { id });
    if (res.affectedRows === 0) throw new NotFoundError('server', id);
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

// ─── server_groups ──────────────────────────────────────────────────────
// Fan-out deploy targets. Separate namespace from `groups` (which groups
// applications): a server_group bundles servers, with no FK back from apps.
const SERVER_GROUP_EDITABLE_FIELDS = new Set(['name', 'description']);

export const serverGroups = {
  async get(id, c) {
    const [rows] = await conn(c).execute(
      'SELECT * FROM server_groups WHERE id = :id LIMIT 1', { id },
    );
    if (!rows[0]) throw new NotFoundError('server_group', id);
    return rows[0];
  },
  async getByName(name, c) {
    const [rows] = await conn(c).execute(
      'SELECT * FROM server_groups WHERE name = :name LIMIT 1', { name },
    );
    return rows[0] ?? null;
  },
  // listWithMemberCounts returns each group with `member_count` attached so
  // the dashboard can render "eu-prod (4)" without a second round-trip.
  async list(c) {
    const [rows] = await conn(c).execute(
      `SELECT sg.*, COUNT(m.server_id) AS member_count
         FROM server_groups sg
         LEFT JOIN server_group_members m ON m.server_group_id = sg.id
         GROUP BY sg.id
         ORDER BY sg.name`,
    );
    return rows.map((r) => ({ ...r, member_count: Number(r.member_count) }));
  },
  async create(row, c) {
    const [res] = await conn(c).execute(
      'INSERT INTO server_groups (name, description) VALUES (:name, :description)',
      { name: row.name, description: row.description ?? null },
    );
    return this.get(res.insertId, c);
  },
  async update(id, patch, c) {
    const q = buildUpdate('server_groups', id, patch, SERVER_GROUP_EDITABLE_FIELDS);
    if (!q) return this.get(id, c);
    await conn(c).execute(q.sql, q.params);
    return this.get(id, c);
  },
  async delete(id, c) {
    // Members are removed automatically via ON DELETE CASCADE on the FK.
    const [res] = await conn(c).execute('DELETE FROM server_groups WHERE id = :id', { id });
    if (res.affectedRows === 0) throw new NotFoundError('server_group', id);
  },
  async listMembers(id, c) {
    const [rows] = await conn(c).execute(
      `SELECT s.* FROM servers s
         JOIN server_group_members m ON m.server_id = s.id
        WHERE m.server_group_id = :id
        ORDER BY s.name`,
      { id },
    );
    return rows;
  },
  async listMemberIds(id, c) {
    const [rows] = await conn(c).execute(
      `SELECT server_id FROM server_group_members WHERE server_group_id = :id`,
      { id },
    );
    return rows.map((r) => Number(r.server_id));
  },
  // replaceMembers atomically swaps the membership for a group. Used by
  // PATCH /api/server-groups/:id when the client sends a fresh serverIds
  // array — simpler than add/remove diffs and matches UI semantics.
  async replaceMembers(id, serverIds, c) {
    const pool = conn(c);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        'DELETE FROM server_group_members WHERE server_group_id = :id', { id },
      );
      for (const sid of serverIds) {
        await connection.execute(
          `INSERT INTO server_group_members (server_group_id, server_id)
             VALUES (:id, :sid)`,
          { id, sid },
        );
      }
      await connection.commit();
    } catch (err) {
      try { await connection.rollback(); } catch { /* already rolled back */ }
      throw err;
    } finally {
      connection.release();
    }
  },
};

// ─── groups ─────────────────────────────────────────────────────────────
const GROUP_EDITABLE_FIELDS = new Set(['name', 'description']);

export const groups = {
  async get(id, c) {
    const [rows] = await conn(c).execute(
      'SELECT * FROM `groups` WHERE id = :id LIMIT 1',
      { id },
    );
    if (!rows[0]) throw new NotFoundError('group', id);
    return rows[0];
  },
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
  async create(row, c) {
    const [res] = await conn(c).execute(
      'INSERT INTO `groups` (name, description) VALUES (:name, :description)',
      { name: row.name, description: row.description ?? null },
    );
    return this.get(res.insertId, c);
  },
  async update(id, patch, c) {
    const q = buildUpdate('groups', id, patch, GROUP_EDITABLE_FIELDS);
    if (!q) return this.get(id, c);
    await conn(c).execute(q.sql, q.params);
    return this.get(id, c);
  },
  async delete(id, c) {
    const [res] = await conn(c).execute('DELETE FROM `groups` WHERE id = :id', { id });
    if (res.affectedRows === 0) throw new NotFoundError('group', id);
  },
};

// ─── applications ───────────────────────────────────────────────────────
const APP_EDITABLE_FIELDS = new Set([
  'name', 'group_id', 'runtime', 'build_strategy', 'artifact_pattern',
  'remote_install_path', 'builder_server_id', 'repo_url', 'branch',
  'workdir', 'install_cmd', 'build_cmd', 'start_cmd', 'stop_cmd',
  'launch_mode', 'status_cmd', 'logs_cmd', 'health_cmd', 'env',
  'trusted', 'enabled',
]);

const APP_CREATE_COLUMNS = [
  'name', 'server_id', 'group_id', 'runtime', 'build_strategy',
  'artifact_pattern', 'remote_install_path', 'builder_server_id',
  'repo_url', 'branch', 'workdir', 'install_cmd', 'build_cmd',
  'start_cmd', 'stop_cmd', 'launch_mode', 'status_cmd', 'logs_cmd',
  'health_cmd', 'env', 'trusted', 'enabled',
];

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
  async countByServerId(serverId, c) {
    const [rows] = await conn(c).execute(
      'SELECT COUNT(*) AS n FROM applications WHERE server_id = :serverId',
      { serverId },
    );
    return Number(rows[0].n);
  },
  async create(row, c) {
    const params = {};
    for (const col of APP_CREATE_COLUMNS) {
      const v = row[col];
      if (v === undefined) { params[col] = null; continue; }
      params[col] = (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
    }
    const placeholders = APP_CREATE_COLUMNS.map((k) => `:${k}`).join(', ');
    const cols = APP_CREATE_COLUMNS.map((k) => `\`${k}\``).join(', ');
    const [res] = await conn(c).execute(
      `INSERT INTO applications (${cols}) VALUES (${placeholders})`,
      params,
    );
    return this.get(res.insertId, c);
  },
  async update(id, patch, c) {
    const q = buildUpdate('applications', id, patch, APP_EDITABLE_FIELDS);
    if (!q) return this.get(id, c);
    await conn(c).execute(q.sql, q.params);
    return this.get(id, c);
  },
  async delete(id, c) {
    const pool = conn(c);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT enabled, process_state FROM applications WHERE id = :id FOR UPDATE',
        { id },
      );
      if (!rows[0]) {
        await connection.rollback();
        throw new NotFoundError('application', id);
      }
      const { enabled, process_state } = rows[0];
      if (enabled === 1 || process_state !== 'stopped') {
        await connection.rollback();
        throw new ConflictError(
          `application ${id} must be enabled=0 and process_state='stopped' (currently enabled=${enabled}, state='${process_state}')`,
          { enabled, process_state },
        );
      }
      await connection.execute('DELETE FROM applications WHERE id = :id', { id });
      await connection.commit();
    } catch (err) {
      try { await connection.rollback(); } catch { /* already rolled back */ }
      throw err;
    } finally {
      connection.release();
    }
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
  // Set operator-expected state. Called from the orchestrator when a lifecycle
  // action is enqueued: start/restart/deploy → running, stop → stopped.
  // Deliberately NOT exposed through the CRUD update whitelist — expected
  // state is derived from action submission, never user-patched directly.
  async setExpectedState(id, expected, c) {
    await conn(c).execute(
      'UPDATE applications SET expected_state = :expected WHERE id = :id',
      { id, expected },
    );
  },
  async markAlerted(id, c) {
    await conn(c).execute(
      'UPDATE applications SET last_alert_at = CURRENT_TIMESTAMP WHERE id = :id',
      { id },
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

// ─── artifacts ──────────────────────────────────────────────────────────
export const artifacts = {
  async insert(row, c) {
    const [res] = await conn(c).execute(
      `INSERT INTO artifacts
         (application_id, commit_sha, branch, config_hash, sha256, path,
          size_bytes, build_job_id)
       VALUES
         (:applicationId, :commitSha, :branch, :configHash, :sha256, :path,
          :sizeBytes, :buildJobId)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
      {
        applicationId: row.applicationId,
        commitSha:     row.commitSha ?? null,
        branch:        row.branch,
        configHash:    row.configHash,
        sha256:        row.sha256,
        path:          row.path,
        sizeBytes:     row.sizeBytes,
        buildJobId:    row.buildJobId,
      },
    );
    return res.insertId;
  },
  async get(id, c) {
    const [rows] = await conn(c).execute(
      'SELECT * FROM artifacts WHERE id = :id LIMIT 1', { id },
    );
    if (!rows[0]) throw new NotFoundError('artifact', id);
    return rows[0];
  },
  async findByCommitAndConfig(applicationId, commitSha, configHash, c) {
    const [rows] = await conn(c).execute(
      `SELECT * FROM artifacts
       WHERE application_id = :applicationId
         AND commit_sha = :commitSha
         AND config_hash = :configHash
       ORDER BY id DESC LIMIT 1`,
      { applicationId, commitSha, configHash },
    );
    return rows[0] ?? null;
  },
  async listForApp(applicationId, limit = 20, c) {
    const [rows] = await conn(c).query(
      'SELECT * FROM artifacts WHERE application_id = ? ORDER BY id DESC LIMIT ?',
      [applicationId, limit],
    );
    return rows;
  },
};

// ─── deployments ────────────────────────────────────────────────────────
export const deployments = {
  async insert(row, c) {
    const [res] = await conn(c).execute(
      `INSERT INTO deployments
         (application_id, job_id, commit_sha, branch, artifact_id, release_id, status)
       VALUES
         (:applicationId, :jobId, :commitSha, :branch, :artifactId, :releaseId, :status)`,
      {
        applicationId: row.applicationId,
        jobId:         row.jobId,
        commitSha:     row.commitSha ?? null,
        branch:        row.branch,
        artifactId:    row.artifactId ?? null,
        releaseId:     row.releaseId ?? null,
        status:        row.status ?? 'pending',
      },
    );
    return res.insertId;
  },
  async markDeployed(id, c) {
    await conn(c).execute(
      `UPDATE deployments SET status='deployed', deployed_at=CURRENT_TIMESTAMP
       WHERE id = :id`, { id },
    );
  },
  async markFailed(id, c) {
    await conn(c).execute(
      `UPDATE deployments SET status='failed' WHERE id = :id`, { id },
    );
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
