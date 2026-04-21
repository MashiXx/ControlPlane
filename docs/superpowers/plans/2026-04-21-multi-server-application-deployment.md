# Multi-Server Application Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one `applications` row run on N servers via a new `application_servers` replica table, with per-replica state/alerts and explicit server selectors on every action submit.

**Architecture:** Many-to-many `application_servers` table holds both membership and per-replica runtime state. `applications.server_id` + per-replica state columns are dropped. Every `submitAction` with `target.type='app'` must carry exactly one of `options.serverId`/`serverIds`/`serverGroupId`, fans out one job per target replica (using the existing `payload.serverIdOverride`). State poller, alert manager, dashboard, and bot are updated in lockstep.

**Tech Stack:** Node.js 20 ESM, Express, mysql2, zod, MySQL 8 (InnoDB / utf8mb4), vanilla ES-module SPA under `controller/public/`, node-telegram-bot-api.

**Spec:** `docs/superpowers/specs/2026-04-21-multi-server-application-deployment-design.md`.

**No test framework:** the repo has no unit test runner (`npm test` / `npm run lint` are placeholders). Verification uses explicit DB queries, curl against a running `npm run dev:controller`, and log inspection. Every task ends with a concrete verification block.

---

## File map

- **Create**
  - `db/migrations/005_multi_server_replicas.sql` — forward-only schema migration.
  - `controller/src/api/routes/replicas.js` — replica CRUD REST endpoints.
  - `controller/public/forms/replica.js` — "Add replica" modal form.
- **Modify**
  - `db/schema.sql` — new `application_servers` table; `applications` pruned.
  - `controller/src/db/repositories.js` — new `applicationServers` repo; `applications` rewritten.
  - `shared/src/constants.js` — drop `JobTargetType.SERVER_GROUP`.
  - `shared/src/schemas.js` — new `ReplicaAddInput`; `AppCreate`/`AppUpdate` stripped of `server_id`; `EnqueueActionBody` gains server selectors.
  - `controller/src/orchestrator/orchestrator.js` — replica-set resolution + fan-out for every action.
  - `controller/src/workers/jobWorker.js` — per-replica expected/state writes.
  - `controller/src/pollers/stateScheduler.js` — per-replica poll.
  - `controller/src/alerts/alertManager.js` — per-replica alerts.
  - `controller/src/api/routes/read.js` — expose replicas in app/server reads; wire replica router.
  - `controller/src/api/routes/crud.js` — remove `server_id` from `AppCreate`/`AppUpdate`; keep audit shape.
  - `controller/src/api/server.js` — mount replica router.
  - `controller/src/bot/start.js`, `controller/src/bot/api.js`, `controller/src/bot/format.js` — new command grammar.
  - `controller/public/app.js`, `controller/public/api.js`, `controller/public/forms/application.js` — SPA per-replica UI.

---

## Pre-work

- [ ] **Pre-1: Create working branch**

```bash
git checkout -b multi-server-replicas
```

- [ ] **Pre-2: Confirm dev DB is running and current**

```bash
docker compose up -d
npm install
npm run db:init            # apply db/schema.sql
mysql -h 127.0.0.1 -P 3306 -uroot controlplane -e "SHOW TABLES;"
```

Expected: table list including `applications`, `servers`, `server_groups`, `jobs`. No `application_servers` yet.

- [ ] **Pre-3: Dedupe duplicate app names (if any)**

The migration enforces `UNIQUE (applications.name)`. Check first:

```bash
mysql -h 127.0.0.1 -P 3306 -uroot controlplane -e \
  "SELECT name, COUNT(*) n FROM applications GROUP BY name HAVING n > 1;"
```

If the result is non-empty, the migration will fail at step 6. Resolve by renaming the duplicates (`UPDATE applications SET name = CONCAT(name, '-legacy') WHERE id = ?;`) or merging them by hand. For a fresh dev DB, the query returns zero rows — nothing to do.

---

## Task 1: Schema + migration

**Files:**
- Create: `db/migrations/005_multi_server_replicas.sql`
- Modify: `db/schema.sql` (inline replacement of the `applications` table, add `application_servers`)

- [ ] **Step 1: Write the migration**

Create `db/migrations/005_multi_server_replicas.sql`:

```sql
-- Migration 005: multi-server application replicas.
--
-- Introduces `application_servers` — a many-to-many replica table that also
-- carries per-replica runtime state (process_state, expected_state, pid,
-- timestamps, alert debounce, currently-deployed release). The matching
-- state columns on `applications` are dropped; `applications.server_id` is
-- dropped; the old `UNIQUE (name, server_id)` key collapses to `UNIQUE (name)`.
--
-- Forward-only. Apply with the controller off.

USE controlplane;

-- 1. Guard: dedupe app names first — UNIQUE (name) is enforced later.
SET @dup := (SELECT COUNT(*) FROM (
  SELECT name FROM applications GROUP BY name HAVING COUNT(*) > 1
) t);
SET @sql := IF(@dup > 0,
  'SELECT CONCAT("ABORT: ", @dup, " duplicate application name(s); rename them before migrating.") INTO @abort FROM DUAL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
-- If @dup > 0 the SELECT above binds @abort to a message. We then force a
-- SQL error so the migration halts cleanly.
SET @sql := IF(@dup > 0, 'SIGNAL SQLSTATE "45000" SET MESSAGE_TEXT = "duplicate application names — dedupe before migrating"', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. Create application_servers.
CREATE TABLE IF NOT EXISTS application_servers (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id       BIGINT UNSIGNED NOT NULL,
  server_id            BIGINT UNSIGNED NOT NULL,

  process_state        ENUM('running','stopped','crashed','starting','unknown')
                         NOT NULL DEFAULT 'unknown',
  expected_state       ENUM('running','stopped') NOT NULL DEFAULT 'stopped',
  pid                  INT UNSIGNED NULL,
  last_started_at      TIMESTAMP NULL,
  last_exit_code       INT NULL,
  last_exit_at         TIMESTAMP NULL,
  uptime_seconds       BIGINT UNSIGNED NULL,
  last_alert_at        TIMESTAMP NULL,
  unreachable_count    INT NOT NULL DEFAULT 0,

  current_release_id   VARCHAR(64) NULL,
  current_artifact_id  BIGINT UNSIGNED NULL,

  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                         ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_application_servers_pair (application_id, server_id),
  KEY idx_application_servers_server    (server_id),
  KEY idx_application_servers_state     (process_state),
  CONSTRAINT fk_app_servers_app
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_app_servers_server
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_app_servers_artifact
    FOREIGN KEY (current_artifact_id) REFERENCES artifacts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 3. Seed replicas from the existing applications rows (only rows with a server_id).
INSERT INTO application_servers
  (application_id, server_id, process_state, expected_state,
   pid, last_started_at, last_exit_code, last_exit_at,
   uptime_seconds, last_alert_at)
SELECT id, server_id,
       process_state, expected_state,
       pid, last_started_at, last_exit_code, last_exit_at,
       uptime_seconds, last_alert_at
  FROM applications
 WHERE server_id IS NOT NULL;

-- 4. Drop the FK + indexes + columns from applications.
-- Drop FK first, then indexes, then the column (MySQL rejects in reverse).
SET @fk := (SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS
             WHERE CONSTRAINT_SCHEMA = DATABASE()
               AND TABLE_NAME = 'applications'
               AND CONSTRAINT_NAME = 'fk_applications_server');
SET @sql := IF(@fk IS NOT NULL, 'ALTER TABLE applications DROP FOREIGN KEY fk_applications_server', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT INDEX_NAME FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'applications'
                AND INDEX_NAME = 'idx_applications_server' LIMIT 1);
SET @sql := IF(@idx IS NOT NULL, 'ALTER TABLE applications DROP INDEX idx_applications_server', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT INDEX_NAME FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'applications'
                AND INDEX_NAME = 'idx_applications_state' LIMIT 1);
SET @sql := IF(@idx IS NOT NULL, 'ALTER TABLE applications DROP INDEX idx_applications_state', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT INDEX_NAME FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'applications'
                AND INDEX_NAME = 'uq_applications_name_server' LIMIT 1);
SET @sql := IF(@idx IS NOT NULL, 'ALTER TABLE applications DROP INDEX uq_applications_name_server', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

ALTER TABLE applications
  DROP COLUMN server_id,
  DROP COLUMN process_state,
  DROP COLUMN expected_state,
  DROP COLUMN pid,
  DROP COLUMN last_started_at,
  DROP COLUMN last_exit_code,
  DROP COLUMN last_exit_at,
  DROP COLUMN uptime_seconds,
  DROP COLUMN last_alert_at;

-- 5. Collapse the compound unique key to a single-column UNIQUE (name).
ALTER TABLE applications ADD UNIQUE KEY uq_applications_name (name);
```

- [ ] **Step 2: Update `db/schema.sql`**

Edit `db/schema.sql`. Replace the `applications` table definition (lines 80-150 approximately — use the existing block locator) with:

```sql
CREATE TABLE IF NOT EXISTS applications (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name            VARCHAR(64)   NOT NULL,
  group_id        BIGINT UNSIGNED NULL,

  runtime         ENUM('java') NOT NULL DEFAULT 'java',
  build_strategy  ENUM('controller') NOT NULL DEFAULT 'controller',

  artifact_pattern     VARCHAR(255) NULL,
  remote_install_path  VARCHAR(512) NULL,

  repo_url        VARCHAR(512)  NULL,
  branch          VARCHAR(128)  NOT NULL DEFAULT 'main',
  workdir         VARCHAR(512)  NOT NULL,
  install_cmd     VARCHAR(512)  NULL,
  build_cmd       VARCHAR(512)  NULL,
  start_cmd       VARCHAR(512)  NOT NULL,
  stop_cmd        VARCHAR(512)  NULL,
  launch_mode     ENUM('wrapped','raw','systemd') NOT NULL DEFAULT 'wrapped',
  status_cmd      VARCHAR(512)  NULL,
  logs_cmd        VARCHAR(512)  NULL,
  health_cmd      VARCHAR(512)  NULL,
  env             JSON          NULL,

  trusted         TINYINT(1)    NOT NULL DEFAULT 0,
  enabled         TINYINT(1)    NOT NULL DEFAULT 1,

  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
                    ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_applications_name (name),
  KEY idx_applications_group   (group_id),
  CONSTRAINT fk_applications_group FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE SET NULL
) ENGINE=InnoDB;
```

Then add the `application_servers` definition (copy from the migration above, same DDL) immediately after the `artifacts` table block.

- [ ] **Step 3: Apply the migration**

```bash
mysql -h 127.0.0.1 -P 3306 -uroot controlplane < db/migrations/005_multi_server_replicas.sql
```

- [ ] **Step 4: Verify schema**

```bash
mysql -h 127.0.0.1 -P 3306 -uroot controlplane -e "DESCRIBE applications;"
mysql -h 127.0.0.1 -P 3306 -uroot controlplane -e "DESCRIBE application_servers;"
mysql -h 127.0.0.1 -P 3306 -uroot controlplane -e "SELECT application_id, server_id, expected_state, process_state FROM application_servers;"
```

Expected:
- `applications` no longer has `server_id`, `process_state`, `expected_state`, `pid`, `last_started_at`, `last_exit_code`, `last_exit_at`, `uptime_seconds`, `last_alert_at`.
- `application_servers` contains one row per previously-existing app, with the prior state columns carried over.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/005_multi_server_replicas.sql db/schema.sql
git commit -m "db: add application_servers replica table + drop per-replica cols from applications"
```

---

## Task 2: `applicationServers` repository

**Files:**
- Modify: `controller/src/db/repositories.js`

- [ ] **Step 1: Add the repository**

Append **after** the existing `applications` export and **before** the `artifacts` block:

```js
// ─── application_servers (per-replica state) ───────────────────────────
//
// Each row = one "replica": the fact that application X is registered on
// server Y. Carries all per-replica runtime state that used to live on the
// applications row. Lookups go via (application_id, server_id) which has a
// UNIQUE index.
export const applicationServers = {
  async get(applicationId, serverId, c) {
    const [rows] = await conn(c).execute(
      `SELECT * FROM application_servers
         WHERE application_id = :applicationId AND server_id = :serverId LIMIT 1`,
      { applicationId, serverId },
    );
    if (!rows[0]) throw new NotFoundError('application_server', `${applicationId}@${serverId}`);
    return rows[0];
  },
  async listForApp(applicationId, c) {
    const [rows] = await conn(c).execute(
      `SELECT ar.*, s.name AS server_name, s.hostname, s.status AS server_status
         FROM application_servers ar
         JOIN servers s ON ar.server_id = s.id
        WHERE ar.application_id = :applicationId
        ORDER BY s.name`,
      { applicationId },
    );
    return rows;
  },
  async listForServer(serverId, c) {
    const [rows] = await conn(c).execute(
      `SELECT ar.*, a.name AS app_name, a.enabled
         FROM application_servers ar
         JOIN applications a ON ar.application_id = a.id
        WHERE ar.server_id = :serverId
        ORDER BY a.name`,
      { serverId },
    );
    return rows;
  },
  async listForPoller(c) {
    // Joined shape needed by the state scheduler: one row per replica with
    // the server hostname + status and the app's launch-mode config.
    const [rows] = await conn(c).execute(
      `SELECT ar.id          AS replica_id,
              ar.application_id, ar.server_id,
              ar.process_state, ar.expected_state, ar.unreachable_count,
              ar.last_alert_at,
              s.hostname, s.name AS server_name, s.status AS server_status,
              a.name AS app_name, a.launch_mode, a.status_cmd,
              a.start_cmd, a.remote_install_path,
              a.enabled
         FROM application_servers ar
         JOIN servers      s ON ar.server_id      = s.id
         JOIN applications a ON ar.application_id = a.id
        WHERE a.enabled = 1 AND s.status != 'draining'`,
    );
    return rows;
  },
  async serverIdsForApp(applicationId, c) {
    const [rows] = await conn(c).execute(
      `SELECT server_id FROM application_servers WHERE application_id = :applicationId`,
      { applicationId },
    );
    return rows.map((r) => Number(r.server_id));
  },
  async insert({ applicationId, serverId }, c) {
    const [res] = await conn(c).execute(
      `INSERT INTO application_servers (application_id, server_id)
         VALUES (:applicationId, :serverId)`,
      { applicationId, serverId },
    );
    return res.insertId;
  },
  async remove(applicationId, serverId, c) {
    const [res] = await conn(c).execute(
      `DELETE FROM application_servers
         WHERE application_id = :applicationId AND server_id = :serverId`,
      { applicationId, serverId },
    );
    if (res.affectedRows === 0) {
      throw new NotFoundError('application_server', `${applicationId}@${serverId}`);
    }
  },
  async setExpectedState(applicationId, serverId, expected, c) {
    await conn(c).execute(
      `UPDATE application_servers
          SET expected_state = :expected
        WHERE application_id = :applicationId AND server_id = :serverId`,
      { applicationId, serverId, expected },
    );
  },
  async updateProcessState(replicaId, patch, c) {
    // patch: { state?, pid?, uptime?, exitCode?, exitAt?, startedAt?, unreachableCount? }
    await conn(c).execute(
      `UPDATE application_servers SET
         process_state     = COALESCE(:state, process_state),
         pid               = :pid,
         uptime_seconds    = :uptime,
         last_started_at   = COALESCE(:startedAt, last_started_at),
         last_exit_code    = COALESCE(:exitCode,  last_exit_code),
         last_exit_at      = COALESCE(:exitAt,    last_exit_at),
         unreachable_count = COALESCE(:unreachableCount, unreachable_count)
       WHERE id = :replicaId`,
      {
        replicaId,
        state:            patch.state ?? null,
        pid:              patch.pid  ?? null,
        uptime:           patch.uptime ?? null,
        startedAt:        patch.startedAt ?? null,
        exitCode:         patch.exitCode ?? null,
        exitAt:           patch.exitAt ?? null,
        unreachableCount: patch.unreachableCount ?? null,
      },
    );
  },
  async markAlerted(replicaId, c) {
    await conn(c).execute(
      `UPDATE application_servers SET last_alert_at = CURRENT_TIMESTAMP WHERE id = :replicaId`,
      { replicaId },
    );
  },
  async markUnknownForServer(serverId, c) {
    await conn(c).execute(
      `UPDATE application_servers SET process_state = 'unknown' WHERE server_id = :serverId`,
      { serverId },
    );
  },
  async onDeploySuccess({ applicationId, serverId, releaseId, artifactId }, c) {
    await conn(c).execute(
      `UPDATE application_servers
          SET current_release_id  = :releaseId,
              current_artifact_id = :artifactId,
              expected_state      = 'running'
        WHERE application_id = :applicationId AND server_id = :serverId`,
      { applicationId, serverId, releaseId, artifactId },
    );
  },
};
```

- [ ] **Step 2: Prune the `applications` repository**

Edit `controller/src/db/repositories.js`:

1. **Remove** the `countByServerId` method (lines ~259-265) — it's replaced by checking `application_servers`.
2. **Remove** the `updateProcessState` and `markAlerted` methods on `applications` (the rewrite keeps those semantics only on `applicationServers`).
3. **Update** `applications.delete`: the `SELECT … process_state` inside the transaction no longer applies (column is gone). Replace with a check that no replicas exist:

```js
async delete(id, c) {
  const pool = conn(c);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      'SELECT enabled FROM applications WHERE id = :id FOR UPDATE',
      { id },
    );
    if (!rows[0]) {
      await connection.rollback();
      throw new NotFoundError('application', id);
    }
    if (rows[0].enabled === 1) {
      await connection.rollback();
      throw new ConflictError(
        `application ${id} must be enabled=0 before delete`,
        { enabled: rows[0].enabled },
      );
    }
    const [rep] = await connection.execute(
      'SELECT COUNT(*) AS n FROM application_servers WHERE application_id = :id',
      { id },
    );
    if (Number(rep[0].n) > 0) {
      await connection.rollback();
      throw new ConflictError(
        `application ${id} still has ${rep[0].n} replica(s); remove them first`,
        { replicas: Number(rep[0].n) },
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
```

4. **Update** `APP_CREATE_COLUMNS` to remove `server_id`. The constant appears just above `applications.create` and is used to whitelist insert columns. New value:

```js
const APP_CREATE_COLUMNS = [
  'name', 'group_id', 'runtime', 'build_strategy',
  'artifact_pattern', 'remote_install_path',
  'repo_url', 'branch', 'workdir', 'install_cmd', 'build_cmd',
  'start_cmd', 'stop_cmd', 'launch_mode', 'status_cmd', 'logs_cmd',
  'health_cmd', 'env', 'trusted', 'enabled',
];
```

5. **Update** `APP_EDITABLE_FIELDS` (if it still lists `server_id`, remove it). It's a `Set` constant near `APP_CREATE_COLUMNS`.

6. **Update** `servers.delete` — it currently calls `applications.countByServerId` which we just removed. Replace with:

```js
async delete(id, c) {
  const [rows] = await conn(c).execute(
    `SELECT COUNT(*) AS n FROM application_servers WHERE server_id = :id`,
    { id },
  );
  const n = Number(rows[0].n);
  if (n > 0) {
    throw new ConflictError(
      `server ${id} still hosts ${n} replica(s); remove them first`,
      { replicasReferencing: n },
    );
  }
  const [res] = await conn(c).execute('DELETE FROM servers WHERE id = :id', { id });
  if (res.affectedRows === 0) throw new NotFoundError('server', id);
},
```

- [ ] **Step 3: Verify repositories load**

```bash
node --input-type=module -e "import('./controller/src/db/repositories.js').then(m => console.log(Object.keys(m)))"
```

Expected output includes `applications`, `applicationServers`, `servers`, `serverGroups`, `artifacts`, `deployments`, `jobs`, `audit`.

- [ ] **Step 4: Commit**

```bash
git add controller/src/db/repositories.js
git commit -m "db: applicationServers repo; prune applications of per-replica state"
```

---

## Task 3: Shared constants + schemas

**Files:**
- Modify: `shared/src/constants.js`
- Modify: `shared/src/schemas.js`

- [ ] **Step 1: Drop `JobTargetType.SERVER_GROUP`**

Edit `shared/src/constants.js`. Replace the `JobTargetType` block with:

```js
export const JobTargetType = Object.freeze({
  APP:    'app',
  GROUP:  'group',
  SERVER: 'server',
});
```

(`SERVER_GROUP` is removed. `SERVER` stays for completeness even though no code path currently uses it — it's a no-op rename risk otherwise and future-proof for a "run on this server" action.)

- [ ] **Step 2: Update `EnqueueActionBody`**

Edit `shared/src/schemas.js`. Replace the existing `EnqueueActionBody` block with:

```js
// Server-selector shape — exactly one must be present when target.type='app'.
const ServerSelector = z.object({
  serverId:      z.number().int().positive().optional(),
  serverIds:     z.array(z.number().int().positive()).min(1).optional(),
  serverGroupId: z.union([z.number().int().positive(), identifier]).optional(),
}).superRefine((val, ctx) => {
  const keys = ['serverId', 'serverIds', 'serverGroupId'].filter((k) => val[k] !== undefined);
  if (keys.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `options.serverId, options.serverIds, options.serverGroupId are mutually exclusive (got ${keys.join(', ')})`,
    });
  }
});

export const EnqueueActionBody = z.object({
  action: z.enum(JobActions),
  target: z.object({
    type: z.enum(Object.values(JobTargetType)),
    id:   z.union([z.number().int().positive(), identifier]),
  }),
  // options is validated loosely here — the orchestrator applies ServerSelector
  // semantics after it resolves the target app. We keep the outer shape open
  // so callers can still pass commitSha, applicationId (for target.type='group'),
  // etc. alongside the server selector keys.
  options: z.record(z.string(), z.unknown()).optional(),
});

export { ServerSelector };
```

- [ ] **Step 3: Strip `server_id` from `AppCreate`/`AppUpdate`**

In `shared/src/schemas.js`, change `AppCreate`:

```js
export const AppCreate = z.object({
  ...appBaseFields,
}).strict();

export const AppUpdate = z.object(
  Object.fromEntries(Object.entries(appBaseFields).map(([k, v]) => [k, v.optional()])),
).strict();
```

(Removes the `server_id: z.number().int().positive()` line.)

- [ ] **Step 4: Add `ReplicaAddInput`**

Append to `shared/src/schemas.js`:

```js
export const ReplicaAddInput = z.object({
  serverId: z.number().int().positive(),
}).strict();
```

- [ ] **Step 5: Update `ApplicationConfig`**

`ApplicationConfig` (the CLI-style import shape near the top of `schemas.js`) currently has `serverName: identifier`. Replace with:

```js
  serverNames: z.array(identifier).min(1),
```

(Renamed plural, required at least one.)

- [ ] **Step 6: Verify schemas parse**

```bash
node --input-type=module -e "
import * as s from './shared/src/schemas.js';
console.log(s.EnqueueActionBody.safeParse({
  action: 'restart',
  target: { type: 'app', id: 1 },
  options: { serverId: 1 }
}).success);
console.log(s.AppCreate.safeParse({
  name: 'test', workdir: '/tmp/w', start_cmd: 'echo'
}).success);
console.log(s.ReplicaAddInput.safeParse({ serverId: 3 }).success);
"
```

All three lines print `true`.

- [ ] **Step 7: Commit**

```bash
git add shared/src/constants.js shared/src/schemas.js
git commit -m "shared: drop SERVER_GROUP target type; add ReplicaAddInput + ServerSelector"
```

---

## Task 4: Orchestrator — replica-set resolution + fan-out for every action

**Files:**
- Modify: `controller/src/orchestrator/orchestrator.js`

- [ ] **Step 1: Import the new repo + selector**

At the top of `controller/src/orchestrator/orchestrator.js`, update the imports:

```js
import { enqueueAction, jobIdentity } from '@cp/queue';
import {
  ExpectedState,
  JobAction, JobActions, JobTargetType, ProcessState, RetryProfile,
} from '@cp/shared/constants';
import { NotFoundError, ValidationError } from '@cp/shared/errors';
import {
  applications, applicationServers, groups, serverGroups, jobs as jobsRepo,
} from '../db/repositories.js';
import { writeAudit } from '../audit/audit.js';
```

- [ ] **Step 2: Add the server-selector resolver**

Insert, just above `submitAction`:

```js
/**
 * Resolve `options` → concrete list of target server ids, intersected with
 * the app's registered replicas. Throws ValidationError on any missing /
 * ambiguous / out-of-set selector.
 */
async function resolveTargetServerIds(app, options = {}) {
  const present = ['serverId', 'serverIds', 'serverGroupId']
    .filter((k) => options[k] !== undefined && options[k] !== null);
  if (present.length === 0) {
    throw new ValidationError(
      `action on app '${app.name}' requires options.serverId, options.serverIds, or options.serverGroupId`,
    );
  }
  if (present.length > 1) {
    throw new ValidationError(
      `options.serverId, options.serverIds, options.serverGroupId are mutually exclusive (got ${present.join(', ')})`,
    );
  }

  let requested;
  if (options.serverId !== undefined) {
    requested = [Number(options.serverId)];
  } else if (Array.isArray(options.serverIds)) {
    requested = options.serverIds.map(Number);
  } else {
    const sg = await resolveServerGroup(options.serverGroupId);
    requested = await serverGroups.listMemberIds(sg.id);
    if (requested.length === 0) {
      throw new ValidationError(`server-group '${sg.name}' has no members`);
    }
  }

  const replicaIds = new Set(await applicationServers.serverIdsForApp(app.id));
  const targetIds = requested.filter((id) => replicaIds.has(id));

  if (targetIds.length === 0) {
    throw new ValidationError(
      `no replicas of app '${app.name}' match the requested server set`,
    );
  }
  // Surface the first requested-but-not-a-replica id for a clear error.
  if (options.serverId !== undefined || Array.isArray(options.serverIds)) {
    const stray = requested.find((id) => !replicaIds.has(id));
    if (stray !== undefined) {
      throw new ValidationError(`server ${stray} is not a replica of app '${app.name}'`);
    }
  }
  return targetIds;
}
```

- [ ] **Step 3: Rewrite `submitAction` / `enqueueOne`**

Replace the existing `submitAction`, `enqueueOne`, and `applyExpectedState` block with:

```js
export async function submitAction({ action, target, triggeredBy, options = {} }) {
  if (!JobActions.includes(action)) {
    throw new ValidationError(`unknown action: ${action}`);
  }
  if (target.type === JobTargetType.APP) {
    const app = await resolveApp(target.id);
    const serverIds = await resolveTargetServerIds(app, options);
    return enqueueForApp(action, app, serverIds, triggeredBy, options);
  }

  if (target.type === JobTargetType.GROUP) {
    const group = await resolveGroup(target.id);
    const apps  = await applications.listByGroupName(group.name);
    if (apps.length === 0) throw new NotFoundError('group-applications', group.name);

    const perApp = [];
    for (const app of apps) {
      try {
        const serverIds = await resolveTargetServerIds(app, options);
        perApp.push(...await enqueueForApp(action, app, serverIds, triggeredBy, options));
      } catch (err) {
        if (err instanceof ValidationError && /no replicas/.test(err.message)) {
          await writeAudit({
            actor: triggeredBy, action: `${action}.group.skip`,
            targetType: 'app', targetId: String(app.id),
            result: 'info', message: err.message,
          });
          continue;
        }
        throw err;
      }
    }
    await writeAudit({
      actor: triggeredBy, action: `${action}.group`, targetType: 'group',
      targetId: group.name, result: 'info',
      message: `fanned out across ${perApp.length} replica-jobs in ${apps.length} apps`,
    });
    return perApp;
  }

  // target.type='server_group' is gone. Surface a clear upgrade hint.
  throw new ValidationError(
    `target.type='${target.type}' is not supported; use target.type='app' with options.serverGroupId`,
  );
}

async function enqueueForApp(action, app, serverIds, triggeredBy, options) {
  if (action === JobAction.START && !app.start_cmd) {
    throw new ValidationError(`app ${app.name} has no start_cmd`);
  }
  if (!app.enabled) throw new ValidationError(`app ${app.name} is disabled`);

  // deploy goes through the build → fan-out path; other actions fan out here.
  if (action === JobAction.DEPLOY) {
    return [await enqueueControllerBuild(app, triggeredBy, options, { deployServerIds: serverIds })];
  }

  const profile = RetryProfile[action];
  const results = [];

  for (const serverId of serverIds) {
    // Composite targetId keeps per-server queue idempotency unique.
    const enqInput = {
      action,
      targetType: JobTargetType.APP,
      targetId: `${app.id}@${serverId}`,
      triggeredBy,
      payload: {
        applicationId: app.id,
        appName: app.name,
        serverIdOverride: serverId,
        options,
      },
    };
    const identity = jobIdentity(enqInput);
    const jobId = await jobsRepo.insert({
      queueJobId: identity.queueJobId,
      idempotencyKey: identity.idempotencyKey,
      action,
      targetType: JobTargetType.APP,
      applicationId: app.id,
      groupId: app.group_id,
      serverId,
      maxAttempts: profile.attempts,
      triggeredBy,
      payload: { applicationId: app.id, appName: app.name, serverIdOverride: serverId, options },
    }).catch((err) => {
      if (err?.code === 'ER_DUP_ENTRY') return null;
      throw err;
    });

    const enq = await enqueueAction(enqInput);
    await applyExpectedState(app.id, serverId, action);

    await writeAudit({
      actor: triggeredBy, action, targetType: 'app', targetId: String(app.id),
      jobId, result: 'info',
      message: `queued ${action} for ${app.name}@server#${serverId}`,
    });
    results.push({
      jobId,
      queueJobId: enq.queueJobId,
      application: { id: app.id, name: app.name },
      serverId,
      action,
    });
  }
  return results;
}

async function applyExpectedState(appId, serverId, action) {
  const map = {
    [JobAction.START]:   ExpectedState.RUNNING,
    [JobAction.RESTART]: ExpectedState.RUNNING,
    [JobAction.DEPLOY]:  ExpectedState.RUNNING,
    [JobAction.STOP]:    ExpectedState.STOPPED,
  };
  const next = map[action];
  if (!next) return;
  await applicationServers.setExpectedState(appId, serverId, next).catch(() => {});
}
```

- [ ] **Step 4: Rewrite `enqueueControllerBuild`**

Replace the existing `enqueueControllerBuild` with a version that requires an explicit server list:

```js
async function enqueueControllerBuild(
  app, triggeredBy, options, { deployServerIds, serverGroupName } = {},
) {
  if (!app.repo_url || !app.artifact_pattern || !app.remote_install_path) {
    throw new ValidationError(
      `deploy requires repo_url, artifact_pattern and remote_install_path (app ${app.name})`,
    );
  }
  if (!Array.isArray(deployServerIds) || deployServerIds.length === 0) {
    throw new ValidationError('deploy requires at least one target server');
  }
  const profile = RetryProfile[JobAction.BUILD];

  const enqInput = {
    action: JobAction.BUILD,
    targetType: JobTargetType.APP,
    targetId: app.id,
    triggeredBy,
    payload: {
      appName: app.name,
      applicationId: app.id,
      commitSha: options?.commitSha,
      deployServerIds,
      serverGroupName: serverGroupName ?? null,
      options,
    },
  };
  const identity = jobIdentity(enqInput);

  const jobId = await jobsRepo.insert({
    queueJobId: identity.queueJobId,
    idempotencyKey: identity.idempotencyKey,
    action: JobAction.BUILD,
    targetType: JobTargetType.APP,
    applicationId: app.id,
    groupId: app.group_id,
    serverId: null,
    maxAttempts: profile.attempts,
    triggeredBy,
    payload: { deployServerIds, serverGroupName: serverGroupName ?? null, options },
  }).catch((err) => {
    if (err?.code === 'ER_DUP_ENTRY') return null;
    throw err;
  });

  const enq = await enqueueAction(enqInput);

  // Flip expected=running per-replica so the alert detector understands the
  // intent even if the deploy fails mid-way.
  for (const sid of deployServerIds) {
    await applyExpectedState(app.id, sid, JobAction.DEPLOY);
  }

  await writeAudit({
    actor: triggeredBy, action: 'deploy.plan', targetType: 'app', targetId: String(app.id),
    jobId, result: 'info',
    message: `build-then-deploy for ${app.name} → ${deployServerIds.length} server(s)`,
    metadata: { serverIds: deployServerIds, serverGroupName: serverGroupName ?? null },
  });

  return {
    jobId,
    queueJobId: enq.queueJobId,
    application: { id: app.id, name: app.name },
    action: JobAction.DEPLOY,
    twoPhase: true,
    phase: 'build',
    fanOut: { serverIds: deployServerIds, serverGroupName: serverGroupName ?? null },
  };
}
```

- [ ] **Step 5: Remove `enqueueServerGroupDeploy`**

Delete the function (and its call site inside `submitAction`, which was already replaced in Step 3). The server-group codepath now runs through `target.type='app' + options.serverGroupId`.

- [ ] **Step 6: Verify the orchestrator parses**

```bash
node --input-type=module -e "import('./controller/src/orchestrator/orchestrator.js').then(m => console.log(typeof m.submitAction))"
```

Expected: `function`.

- [ ] **Step 7: Commit**

```bash
git add controller/src/orchestrator/orchestrator.js
git commit -m "orchestrator: per-replica fan-out; explicit server selector required"
```

---

## Task 5: Worker — per-replica state writes

**Files:**
- Modify: `controller/src/workers/jobWorker.js`

- [ ] **Step 1: Import `applicationServers`**

At the top of `jobWorker.js`:

```js
import {
  applications, servers, artifacts as artifactsRepo, jobs as jobsRepo, deployments,
  applicationServers,
} from '../db/repositories.js';
```

- [ ] **Step 2: Add replica-state writes to start/stop/restart branches**

Replace the trailing block of the non-BUILD, non-DEPLOY branch in `processor` (the block that calls `exec(effectiveApp, {...})`) with:

```js
      // ─── START / STOP / RESTART / HEALTHCHECK ───────────────────────
      const exec = EXEC_FOR_ACTION[action];
      if (!exec) {
        throw new PermanentError(`unsupported action: ${action}`, { code: 'E_UNSUPPORTED_ACTION' });
      }
      const serverId = payload?.serverIdOverride;
      if (!serverId) {
        throw new PermanentError(`${action} job is missing payload.serverIdOverride`, {
          code: 'E_NO_SERVER_OVERRIDE',
        });
      }
      const server = await servers.get(serverId);
      const effectiveApp = { ...app, server_id: server.id };
      const result = await exec(effectiveApp, { onChunk });

      // Reflect the reported state onto application_servers so the dashboard
      // sees the outcome immediately rather than waiting for the next sweep.
      if (action === JobAction.START || action === JobAction.RESTART) {
        await applicationServers.updateProcessState(
          (await applicationServers.get(app.id, server.id)).id,
          { state: ProcessState.RUNNING, startedAt: new Date() },
        ).catch(() => {});
      } else if (action === JobAction.STOP) {
        await applicationServers.updateProcessState(
          (await applicationServers.get(app.id, server.id)).id,
          { state: ProcessState.STOPPED, pid: null, uptime: null },
        ).catch(() => {});
      }

      await jobsRepo.markFinished(queueJobId, 'success', {
        result: {
          exitCode:   result.exitCode ?? 0,
          durationMs: result.durationMs ?? 0,
          stdoutTail: result.stdoutTail?.slice(-4096),
          stderrTail: result.stderrTail?.slice(-4096),
        },
      });
      await writeAudit({
        actor: triggeredBy, action, targetType: 'app', targetId: String(app.id),
        result: 'success', message: combine(result.stdoutTail, result.stderrTail),
        metadata: { serverId },
      });
      return result;
```

Add `ProcessState` to the constants import at the top of the file:

```js
import {
  JobAction, JobTargetType, ProcessState, QueueName, RetryProfile,
} from '@cp/shared/constants';
```

- [ ] **Step 3: Record successful deploys on the replica row**

Inside `runDeploy`, right after `deployments.markDeployed(deployId)` on the happy path, add:

```js
    await applicationServers.onDeploySuccess({
      applicationId: app.id,
      serverId: server.id,
      releaseId,
      artifactId: artifact.id,
    }).catch(() => {});
```

- [ ] **Step 4: Verify the worker still loads**

```bash
node --input-type=module -e "import('./controller/src/workers/jobWorker.js').then(m => console.log(typeof m.startWorkers))"
```

Expected: `function`.

- [ ] **Step 5: Commit**

```bash
git add controller/src/workers/jobWorker.js
git commit -m "worker: per-replica process_state + onDeploySuccess writes"
```

---

## Task 6: State poller — per-replica

**Files:**
- Modify: `controller/src/pollers/stateScheduler.js`

- [ ] **Step 1: Replace the imports**

```js
import {
  ProcessState, ServerStatus,
  STATE_POLL_INTERVAL_MS, STATE_POLL_MISS_LIMIT,
} from '@cp/shared/constants';
import { createLogger } from '@cp/shared/logger';

import { runSsh, shellSafe } from '../ssh/sshClient.js';
import { servers, applicationServers } from '../db/repositories.js';
```

(Removes the `applications` import — no longer needed here.)

- [ ] **Step 2: Replace `_runSweep` and `_pollServer`**

```js
  async _runSweep() {
    if (this._running) return;
    this._running = true;
    try {
      const replicas = await applicationServers.listForPoller();

      // Group replicas by server so we make at most one reachability ping per
      // server per sweep.
      const byServer = new Map(); // serverId → { server, replicas: [] }
      for (const r of replicas) {
        if (!byServer.has(r.server_id)) {
          byServer.set(r.server_id, {
            server: {
              id: r.server_id,
              hostname: r.hostname,
              name: r.server_name,
              status: r.server_status,
            },
            replicas: [],
          });
        }
        byServer.get(r.server_id).replicas.push(r);
      }

      await Promise.all([...byServer.values()].map((entry) =>
        this._pollServer(entry).catch((err) =>
          logger.warn({ err: err.message, serverId: entry.server.id }, 'poll:server-error'),
        ),
      ));
    } finally {
      this._running = false;
    }
  }

  async _pollServer({ server, replicas }) {
    if (server.status === ServerStatus.DRAINING) return;
    if (!server.hostname) return;

    try {
      const r = await runSsh(server.hostname, `echo ${PROBE_OK_MARKER}`, { timeoutMs: 10_000 });
      if (r.exitCode !== 0 || !r.stdoutTail.includes(PROBE_OK_MARKER)) {
        return this._markMiss(server, replicas);
      }
    } catch (err) {
      return this._markMiss(server, replicas, err);
    }

    this.missCounts.delete(server.id);
    await servers.updateStatus(server.id, ServerStatus.ONLINE).catch(() => {});

    for (const replica of replicas) {
      await this._pollReplica(server, replica).catch((err) =>
        logger.warn({ err: err.message, replicaId: replica.replica_id }, 'poll:replica-error'),
      );
    }
  }
```

- [ ] **Step 3: Replace `_markMiss`**

```js
  async _markMiss(server, replicas, err) {
    const n = (this.missCounts.get(server.id) ?? 0) + 1;
    this.missCounts.set(server.id, n);
    logger.debug({ serverId: server.id, misses: n, err: err?.message }, 'poll:miss');

    if (n >= STATE_POLL_MISS_LIMIT && server.status !== ServerStatus.UNREACHABLE) {
      await servers.updateStatus(server.id, ServerStatus.UNREACHABLE).catch(() => {});
      await applicationServers.markUnknownForServer(server.id).catch(() => {});
      logger.warn({ serverId: server.id, misses: n }, 'server:unreachable');

      if (this.alertManager) {
        for (const replica of replicas) {
          await this.alertManager.evaluate(
            { ...replica, process_state: ProcessState.UNKNOWN },
            ProcessState.UNKNOWN,
          );
        }
      }
    }
  }
```

- [ ] **Step 4: Replace `_pollApp` → `_pollReplica`**

```js
  async _pollReplica(server, replica) {
    const probe = composeStatusProbe(replica);
    if (!probe) return;

    let r;
    try {
      r = await runSsh(server.hostname, probe.cmd, { timeoutMs: 10_000 });
    } catch (err) {
      await applicationServers.updateProcessState(replica.replica_id, { state: ProcessState.UNKNOWN });
      return;
    }

    const { state, pid, uptime } = probe.parse(r);
    await applicationServers.updateProcessState(replica.replica_id, { state, pid, uptime });

    this.broadcastUi({
      op: 'state',
      serverId: server.id,
      replicas: [{
        applicationId: replica.application_id,
        serverId: replica.server_id,
        state, pid: pid ?? null, uptimeSeconds: uptime ?? null,
      }],
    });

    if (this.alertManager) {
      await this.alertManager.evaluate({ ...replica, process_state: state }, state);
    }
  }
```

- [ ] **Step 5: Delete `_listEnabledApps` and `_updateApp`**

Those methods are now unused; remove them from the class body.

- [ ] **Step 6: Verify the poller loads**

```bash
node --input-type=module -e "import('./controller/src/pollers/stateScheduler.js').then(m => console.log(typeof m.StateScheduler))"
```

Expected: `function`.

- [ ] **Step 7: Commit**

```bash
git add controller/src/pollers/stateScheduler.js
git commit -m "poller: per-replica state polling via application_servers"
```

---

## Task 7: Alert manager — per-replica

**Files:**
- Modify: `controller/src/alerts/alertManager.js`

- [ ] **Step 1: Replace the whole file**

```js
// AlertManager — per-replica alert-on-down detector.
//
// The state scheduler invokes evaluate(replica, reportedState) for every
// replica it polls. We compare the reported state with the operator's
// expected_state (now stored per-replica in application_servers) and fire
// an alert when:
//   - expected_state = 'running' AND reported state is 'crashed'
//   - expected_state = 'running' AND reported state is 'stopped' or 'unknown'
//
// An operator-initiated stop flips expected_state to 'stopped' *before* the
// stop command runs (orchestrator.applyExpectedState), so the subsequent
// "stopped" observation is silent.

import { ExpectedState, ProcessState } from '@cp/shared/constants';
import { createLogger } from '@cp/shared/logger';
import { applicationServers } from '../db/repositories.js';
import { writeAudit } from '../audit/audit.js';

const logger = createLogger({ service: 'alerts' });

const DEBOUNCE_MS = 5 * 60 * 1000;

const BAD_STATES_WHEN_RUNNING_EXPECTED = new Set([
  ProcessState.CRASHED,
  ProcessState.STOPPED,
  ProcessState.UNKNOWN,
]);

export class AlertManager {
  constructor({ broadcastUi, notifyChat } = {}) {
    this.broadcastUi = broadcastUi ?? (() => {});
    this.notifyChat  = notifyChat  ?? (async () => {});
  }

  /**
   * @param {object} replica  — row with at least:
   *   { replica_id, application_id, server_id, expected_state, last_alert_at,
   *     app_name, server_name }
   * @param {string} reportedState
   * @param {object} [meta]   — pid, lastExitCode
   */
  async evaluate(replica, reportedState, meta = {}) {
    if (!replica) return;
    const expected = replica.expected_state ?? ExpectedState.STOPPED;
    if (expected !== ExpectedState.RUNNING) return;
    if (!BAD_STATES_WHEN_RUNNING_EXPECTED.has(reportedState)) return;

    const now = Date.now();
    const last = replica.last_alert_at ? new Date(replica.last_alert_at).getTime() : 0;
    if (now - last < DEBOUNCE_MS) return;

    await applicationServers.markAlerted(replica.replica_id).catch(() => {});

    const appName    = replica.app_name    ?? `app#${replica.application_id}`;
    const serverName = replica.server_name ?? `server#${replica.server_id}`;
    const text = `🚨 ${appName} @ ${serverName} is ${reportedState} (expected running)`
      + (meta.pid != null ? ` — pid was ${meta.pid}` : '')
      + (meta.lastExitCode != null ? ` exit=${meta.lastExitCode}` : '');

    logger.warn({
      appId: replica.application_id, appName,
      serverId: replica.server_id, serverName,
      expected, reported: reportedState,
    }, 'alert:replica-down');

    await writeAudit({
      actor: 'system', action: 'alert.app-down',
      targetType: 'application_server', targetId: String(replica.replica_id),
      result: 'failure', message: text,
      metadata: {
        applicationId: replica.application_id, serverId: replica.server_id,
        expected, reported: reportedState,
        pid: meta.pid ?? null, lastExitCode: meta.lastExitCode ?? null,
      },
    });

    this.broadcastUi({
      op: 'alert',
      kind: 'app-down',
      applicationId: replica.application_id, appName,
      serverId: replica.server_id, serverName,
      state: reportedState, expected,
      at: new Date().toISOString(),
      message: text,
    });

    try { await this.notifyChat(text); }
    catch (err) { logger.warn({ err: err.message }, 'alert:notify-failed'); }
  }
}
```

- [ ] **Step 2: Verify**

```bash
node --input-type=module -e "import('./controller/src/alerts/alertManager.js').then(m => console.log(typeof m.AlertManager))"
```

Expected: `function`.

- [ ] **Step 3: Commit**

```bash
git add controller/src/alerts/alertManager.js
git commit -m "alerts: per-replica detector + alert text names app@server"
```

---

## Task 8: Replica CRUD REST endpoints

**Files:**
- Create: `controller/src/api/routes/replicas.js`
- Modify: `controller/src/api/server.js`

- [ ] **Step 1: Create the router**

Create `controller/src/api/routes/replicas.js`:

```js
// Replica CRUD — GET / POST / DELETE under /api/applications/:id/servers.
//
// The "replica" is the (application, server) pair. The row it reads/writes
// is application_servers. Membership mutations are NOT jobs (same as every
// other CRUD endpoint) — they write directly through the repo.

import { Router } from 'express';
import {
  NotFoundError, ValidationError, ConflictError,
} from '@cp/shared/errors';
import { ServerStatus } from '@cp/shared/constants';
import { ReplicaAddInput } from '@cp/shared/schemas';
import {
  applications, applicationServers, servers, jobs as jobsRepo,
} from '../../db/repositories.js';
import { writeAudit } from '../../audit/audit.js';

const actorOf = (req) => req.actor ?? 'unknown';
const parseId = (raw) => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('invalid id');
  return id;
};

function parse(schema, body) {
  const r = schema.safeParse(body);
  if (!r.success) {
    const msg = r.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new ValidationError(msg, { issues: r.error.issues });
  }
  return r.data;
}

export function replicasRouter() {
  const r = Router();

  // GET /api/applications/:id/servers — list replicas of an app.
  r.get('/applications/:id/servers', async (req, res, next) => {
    try {
      const appId = parseId(req.params.id);
      await applications.get(appId);                     // 404 if app missing
      const rows = await applicationServers.listForApp(appId);
      res.json(rows);
    } catch (e) { next(e); }
  });

  // POST /api/applications/:id/servers {serverId} — register a replica.
  r.post('/applications/:id/servers', async (req, res, next) => {
    try {
      const appId = parseId(req.params.id);
      const { serverId } = parse(ReplicaAddInput, req.body);
      await applications.get(appId);                     // 404 if app missing
      const server = await servers.get(serverId);        // 404 if server missing
      if (server.status === ServerStatus.DRAINING) {
        throw new ValidationError(`server '${server.name}' is draining; cannot register as replica`);
      }
      try {
        await applicationServers.insert({ applicationId: appId, serverId });
      } catch (err) {
        if (err?.code === 'ER_DUP_ENTRY') {
          throw new ConflictError(`server ${serverId} is already a replica of app ${appId}`);
        }
        throw err;
      }
      await writeAudit({
        actor: actorOf(req), action: 'replica.added',
        targetType: 'application_server', targetId: `${appId}@${serverId}`,
        result: 'success', httpStatus: 201,
        metadata: { applicationId: appId, serverId },
      });
      const row = await applicationServers.get(appId, serverId);
      res.status(201).json(row);
    } catch (e) { next(e); }
  });

  // DELETE /api/applications/:id/servers/:serverId — unregister a replica.
  r.delete('/applications/:id/servers/:serverId', async (req, res, next) => {
    try {
      const appId    = parseId(req.params.id);
      const serverId = parseId(req.params.serverId);

      // Reject if any job for this (app, server) is still queued/running.
      const pending = await jobsRepo.countPendingForReplica(appId, serverId).catch(() => 0);
      if (pending > 0) {
        throw new ConflictError(
          `${pending} job(s) are still queued/running for this replica; wait or cancel them first`,
          { pending },
        );
      }

      try {
        await applicationServers.remove(appId, serverId);
      } catch (err) {
        if (err instanceof NotFoundError) throw err;
        throw err;
      }
      await writeAudit({
        actor: actorOf(req), action: 'replica.removed',
        targetType: 'application_server', targetId: `${appId}@${serverId}`,
        result: 'success', httpStatus: 204,
        metadata: { applicationId: appId, serverId },
      });
      res.status(204).end();
    } catch (e) { next(e); }
  });

  return r;
}
```

- [ ] **Step 2: Add `countPendingForReplica` to the `jobs` repository**

Edit `controller/src/db/repositories.js` — inside the `jobs` export, add:

```js
  async countPendingForReplica(applicationId, serverId, c) {
    const [rows] = await conn(c).execute(
      `SELECT COUNT(*) AS n FROM jobs
         WHERE application_id = :applicationId
           AND server_id = :serverId
           AND status IN ('pending','running')`,
      { applicationId, serverId },
    );
    return Number(rows[0].n);
  },
```

- [ ] **Step 3: Wire the router into the API**

Edit `controller/src/api/server.js`. Find the mount point where `crudRouter()` is mounted under `/api` and mount the new router alongside it:

```js
import { replicasRouter } from './routes/replicas.js';
// ...
app.use('/api', replicasRouter());
```

(Order: put this mount **before** `crudRouter()` so the more-specific `/applications/:id/servers` route wins in the Express router table. If Express already matches the longer path first due to the `Router` ordering — run the verification steps to confirm.)

- [ ] **Step 4: Verify with curl**

Start the controller in another terminal:

```bash
npm run dev:controller
```

From the test shell, log in to get a session cookie (cookie jar `cp.cookies`):

```bash
COOKIES=/tmp/cp.cookies
curl -s -c $COOKIES -H 'Content-Type: application/json' \
  -d '{"password":"<your-dev-pass>"}' \
  http://localhost:3000/auth/login | head -c 200

# list existing apps + servers
APP_ID=$(curl -s -b $COOKIES http://localhost:3000/api/applications | node -e "process.stdin.on('data', d => { const r = JSON.parse(d); console.log(r[0]?.id || ''); })")
SRV_ID=$(curl -s -b $COOKIES http://localhost:3000/api/servers      | node -e "process.stdin.on('data', d => { const r = JSON.parse(d); console.log(r[0]?.id || ''); })")

# list replicas of the first app
curl -s -b $COOKIES http://localhost:3000/api/applications/$APP_ID/servers

# add a second server as replica (or reuse — the current replica should conflict)
curl -s -b $COOKIES -H 'Content-Type: application/json' \
  -d "{\"serverId\":$SRV_ID}" \
  http://localhost:3000/api/applications/$APP_ID/servers
```

Expected: GET returns an array (already-migrated replica present). POST with the existing serverId returns 409 Conflict; POST with a different existing server id returns 201 + the new replica row.

- [ ] **Step 5: Commit**

```bash
git add controller/src/api/routes/replicas.js controller/src/api/server.js controller/src/db/repositories.js
git commit -m "api: replica CRUD (GET/POST/DELETE /api/applications/:id/servers)"
```

---

## Task 9: Read API — expose replicas in app/server detail

**Files:**
- Modify: `controller/src/api/routes/read.js`

- [ ] **Step 1: Attach replicas to GET /api/applications/:id**

Replace the `r.get('/applications/:id', ...)` handler with:

```js
  r.get('/applications/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const [app, replicas] = await Promise.all([
        applications.get(id),
        applicationServers.listForApp(id),
      ]);
      res.json({ ...app, replicas });
    } catch (e) { next(e); }
  });
```

Import `applicationServers` at the top:

```js
import {
  applications, applicationServers, groups, servers, serverGroups,
  jobs as jobsRepo, audit,
} from '../../db/repositories.js';
```

- [ ] **Step 2: Attach replicas to GET /api/servers/:id**

Add a new handler (no existing one):

```js
  r.get('/servers/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const [server, apps] = await Promise.all([
        servers.get(id),
        applicationServers.listForServer(id),
      ]);
      res.json({ ...server, applications: apps });
    } catch (e) { next(e); }
  });
```

- [ ] **Step 3: Verify**

```bash
curl -s -b $COOKIES http://localhost:3000/api/applications/$APP_ID | node -e "let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d); console.log('replicas:', o.replicas?.length ?? 'missing');})"
curl -s -b $COOKIES http://localhost:3000/api/servers/$SRV_ID      | node -e "let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d); console.log('apps:', o.applications?.length ?? 'missing');})"
```

Both print a numeric count (≥ 0).

- [ ] **Step 4: Commit**

```bash
git add controller/src/api/routes/read.js
git commit -m "api: include replicas in GET app and new GET server detail"
```

---

## Task 10: CRUD router — drop `server_id` from AppCreate

**Files:**
- Modify: `controller/src/api/routes/crud.js`

- [ ] **Step 1: Update the POST /api/applications handler**

The `AppCreate` schema no longer accepts `server_id`. The existing handler just passes the parsed body to `applications.create(body)`. Because `APP_CREATE_COLUMNS` was already stripped in Task 2, no code change is strictly required here — but update the `ER_DUP_ENTRY` message to match the new unique key:

Replace:

```js
      if (e.code === 'ER_DUP_ENTRY') return next(new ConflictError('application name already exists on this server'));
```

with:

```js
      if (e.code === 'ER_DUP_ENTRY') return next(new ConflictError('application name already exists'));
```

- [ ] **Step 2: Verify**

```bash
curl -s -b $COOKIES -H 'Content-Type: application/json' \
  -d '{"name":"smoke-test","workdir":"/tmp/sm","start_cmd":"echo hi"}' \
  http://localhost:3000/api/applications
```

Expected: 201 with the created row (no `server_id` field).

Clean up:

```bash
curl -s -X DELETE -b $COOKIES http://localhost:3000/api/applications/<id-from-above>
```

- [ ] **Step 3: Commit**

```bash
git add controller/src/api/routes/crud.js
git commit -m "api: drop server_id from application create; update dup-key message"
```

---

## Task 11: Dashboard SPA — per-replica UI

**Files:**
- Modify: `controller/public/api.js`
- Modify: `controller/public/app.js`
- Modify: `controller/public/forms/application.js`
- Create: `controller/public/forms/replica.js`

Before editing, run `node --input-type=module -e "import('./controller/public/app.js')"` to confirm the file loads cleanly (should error only on missing DOM — that's fine, it just validates syntax).

- [ ] **Step 1: Extend the SPA API client**

Append to `controller/public/api.js`:

```js
export async function listReplicas(appId) {
  const r = await fetch(`/api/applications/${appId}/servers`, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(`listReplicas ${r.status}`);
  return r.json();
}

export async function addReplica(appId, serverId) {
  const r = await fetch(`/api/applications/${appId}/servers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ serverId }),
  });
  if (!r.ok) throw new Error(`addReplica ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function removeReplica(appId, serverId) {
  const r = await fetch(`/api/applications/${appId}/servers/${serverId}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!r.ok && r.status !== 204) throw new Error(`removeReplica ${r.status}: ${await r.text()}`);
}

// Submit an action with an explicit server selector. `selector` is one of:
//   { serverId: N } | { serverIds: [N,...] } | { serverGroupId: N | 'name' }
export async function submitAction(action, appId, selector, extra = {}) {
  const r = await fetch('/api/actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      action,
      target: { type: 'app', id: appId },
      options: { ...selector, ...extra },
    }),
  });
  if (!r.ok) throw new Error(`submitAction ${r.status}: ${await r.text()}`);
  return r.json();
}
```

- [ ] **Step 2: Create the replica-management modal form**

Create `controller/public/forms/replica.js`:

```js
import { listReplicas, addReplica, removeReplica, submitAction } from '../api.js';
import { openModal, closeModal } from '../ui/modal.js';

export async function openReplicasDialog(app, allServers) {
  const replicas = await listReplicas(app.id);
  const registeredIds = new Set(replicas.map((r) => r.server_id));
  const candidates = allServers.filter((s) => !registeredIds.has(s.id) && s.status !== 'draining');

  const body = document.createElement('div');
  body.innerHTML = `
    <h3>Replicas of <code>${app.name}</code></h3>
    <table class="replicas">
      <thead><tr><th>Server</th><th>State</th><th>Expected</th><th>PID</th><th>Release</th><th></th></tr></thead>
      <tbody>${replicas.map((r) => `
        <tr data-server-id="${r.server_id}">
          <td>${r.server_name}</td>
          <td class="state-${r.process_state}">${r.process_state}</td>
          <td>${r.expected_state}</td>
          <td>${r.pid ?? '-'}</td>
          <td>${r.current_release_id ?? '-'}</td>
          <td>
            <button data-action="restart">Restart</button>
            <button data-action="stop">Stop</button>
            <button data-action="deploy">Deploy</button>
            <button data-action="remove" class="danger">Remove</button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>
    <hr/>
    <form class="add-replica">
      <label>Add server as replica:
        <select name="serverId">
          ${candidates.map((s) => `<option value="${s.id}">${s.name} (${s.hostname})</option>`).join('')}
        </select>
      </label>
      <button type="submit" ${candidates.length === 0 ? 'disabled' : ''}>Add</button>
    </form>
  `;

  body.querySelectorAll('tr[data-server-id]').forEach((tr) => {
    const serverId = Number(tr.getAttribute('data-server-id'));
    tr.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const action = btn.getAttribute('data-action');
        try {
          if (action === 'remove') {
            if (!confirm(`Remove replica on this server?`)) return;
            await removeReplica(app.id, serverId);
          } else {
            await submitAction(action, app.id, { serverId });
          }
          closeModal();
        } catch (err) { alert(err.message); }
      });
    });
  });

  body.querySelector('form.add-replica').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const serverId = Number(ev.target.serverId.value);
    try {
      await addReplica(app.id, serverId);
      closeModal();
    } catch (err) { alert(err.message); }
  });

  openModal(body);
}
```

- [ ] **Step 3: Wire the "Replicas" button into the app list**

Edit `controller/public/forms/application.js`. Find the row-rendering function (typically `renderAppRow` or similar) and add a button:

```js
const replicasBtn = document.createElement('button');
replicasBtn.textContent = 'Replicas';
replicasBtn.addEventListener('click', async () => {
  const servers = await listServers();
  openReplicasDialog(app, servers);
});
row.querySelector('.actions').appendChild(replicasBtn);
```

Import `openReplicasDialog` from `./replica.js` and `listServers` from `../api.js` at the top of the file.

- [ ] **Step 4: Remove `server` column (if present) from the app list**

In the same file, find the header row rendering and drop any `<th>Server</th>` + the matching `<td>${app.server_name}</td>` cell. Replace with a "Replicas" column that renders `replicas.length` (the GET /applications response doesn't include replicas by default — call `listReplicas(app.id)` lazily or skip this column initially and show it only inside the dialog).

Minimum viable: drop the server column entirely (don't add a replica column yet). Operators can click "Replicas" to see per-replica state. This keeps Task 11 tractable.

- [ ] **Step 5: Update the "Create application" form**

In `controller/public/forms/application.js`, find the create-form fields. Remove the `server_id` select + label — apps are created with no replicas; operators add replicas via the dialog.

- [ ] **Step 6: Verify**

Reload the dashboard at `http://localhost:3000/`. Confirm:
- App list renders without a server column.
- Clicking "Replicas" on an existing app opens the dialog showing the migrated replica.
- Adding a new server as replica via the dialog adds a row.
- Clicking "Restart"/"Stop"/"Deploy" in the dialog submits the action with `options.serverId` (check network tab or `audit_logs`).
- "Remove" with no pending jobs deletes the replica; with a queued job it returns a 409.

- [ ] **Step 7: Commit**

```bash
git add controller/public/api.js controller/public/app.js controller/public/forms/application.js controller/public/forms/replica.js
git commit -m "ui: per-replica dialog with register/remove + per-replica actions"
```

---

## Task 12: Telegram bot — server-aware command grammar

**Files:**
- Modify: `controller/src/bot/api.js`
- Modify: `controller/src/bot/format.js`
- Modify: `controller/src/bot/start.js`

- [ ] **Step 1: Extend the bot api layer**

Edit `controller/src/bot/api.js`. Add:

```js
import { applications as appsRepo, applicationServers, servers as serversRepo } from '../db/repositories.js';

// ...inside class BotApi...
  async listReplicas(appId) { return applicationServers.listForApp(appId); }
  async listServers()       { return serversRepo.list(); }
```

(Keep the existing `listApplications`, `getApplication`, `enqueue`, `getJob` methods.)

- [ ] **Step 2: Parse the new command shape in `start.js`**

Replace the `actionCommands` loop in `controller/src/bot/start.js` with per-action registrations that accept `<server|group:name|all>` as a trailing token:

```js
  // /<action> <app> <server|group:name|all>
  const parseServerArg = async (appId, raw) => {
    if (raw === 'all') {
      const rs = await api.listReplicas(appId);
      return { serverIds: rs.map((r) => Number(r.server_id)) };
    }
    if (raw.startsWith('group:')) {
      return { serverGroupId: raw.slice('group:'.length) };
    }
    // Assume a server name. Map to id.
    const all = await api.listServers();
    const s = all.find((x) => x.name === raw);
    if (!s) throw new Error(`server '${raw}' not found`);
    return { serverId: s.id };
  };

  const actionCommands = [
    { re: /^\/restart(?:@\w+)?\s+(\S+)\s+(\S+)/, action: JobAction.RESTART },
    { re: /^\/stop(?:@\w+)?\s+(\S+)\s+(\S+)/,    action: JobAction.STOP    },
    { re: /^\/deploy(?:@\w+)?\s+(\S+)\s+(\S+)/,  action: JobAction.DEPLOY  },
  ];
  for (const { re, action } of actionCommands) {
    bot.onText(re, (msg, m) => guarded(msg, async () => {
      if (!isAdmin(msg)) return send(msg.chat.id, '_forbidden_');
      const [, appName, serverArg] = m;
      const apps = await api.listApplications();
      const app = apps.find((a) => a.name === appName);
      if (!app) return send(msg.chat.id, `_app *${appName}* not found_`);
      const selector = await parseServerArg(app.id, serverArg);
      const result = await api.enqueue({
        action,
        target: { type: JobTargetType.APP, id: app.id },
        triggeredBy: actorOf(msg),
        options: selector,
      });
      await send(msg.chat.id, `*${action}* → *${appName}* (${serverArg})\n${fmtEnqueueResult(result)}`);
      const first = result.jobs?.[0];
      if (first?.jobId) pollJobStatus(msg.chat.id, first.jobId);
    }));
  }
```

- [ ] **Step 3: Update `/app <name>` output**

In the same file, replace the `/app` handler body with:

```js
  bot.onText(/^\/app(?:@\w+)?\s+(\S+)/, (msg, m) => guarded(msg, async () => {
    const name = m[1];
    const apps = await api.listApplications();
    const app = apps.find((a) => a.name === name);
    if (!app) return send(msg.chat.id, `_app *${name}* not found_`);
    const replicas = await api.listReplicas(app.id);
    const lines = [
      `*${app.name}* — ${replicas.length} replica(s)`,
      `runtime: \`${app.runtime}\`  branch: \`${app.branch}\``,
      `enabled: ${app.enabled ? '✅' : '❌'}  trusted: ${app.trusted ? '✅' : '❌'}`,
      '',
      ...replicas.map((r) =>
        `• @${r.server_name}: _${r.process_state}_ (expected ${r.expected_state}${r.pid ? `, pid ${r.pid}` : ''})`,
      ),
    ];
    await send(msg.chat.id, lines.join('\n'));
  }));
```

- [ ] **Step 4: Update `fmtApps` to show replica counts**

Edit `controller/src/bot/format.js`. Replace `fmtApps`:

```js
export function fmtApps(apps) {
  if (!apps.length) return '_no applications_';
  return apps.map((a) => {
    const running = a.replicaCountRunning ?? '?';
    const total   = a.replicaCountTotal   ?? '?';
    return `• *${a.name}*  ${running}/${total}  ${a.enabled ? '' : '(disabled)'}`;
  }).join('\n');
}
```

`a.replicaCountRunning` / `replicaCountTotal` aren't on the default `listApplications` response yet. Enhance the API layer — in `controller/src/bot/api.js` wrap `listApplications`:

```js
async listApplications() {
  const apps = await appsRepo.list();
  // Enrich with replica counts.
  const out = [];
  for (const app of apps) {
    const reps = await applicationServers.listForApp(app.id);
    out.push({
      ...app,
      replicaCountTotal: reps.length,
      replicaCountRunning: reps.filter((r) => r.process_state === 'running').length,
    });
  }
  return out;
}
```

- [ ] **Step 5: Verify (manual)**

With `TELEGRAM_TOKEN` and `TELEGRAM_ADMIN_CHAT_IDS` set in `.env`, restart the controller, and from a Telegram chat:

- `/status` → each app shows `N/M` counts.
- `/app <name>` → per-replica list.
- `/restart <name> <server-name>` → submits with `options.serverId`.
- `/restart <name> group:<server-group>` → submits with `options.serverGroupId`.
- `/restart <name> all` → submits with `options.serverIds` (expanded list).

If no `TELEGRAM_TOKEN` is configured, skip this verification and note that in the commit message.

- [ ] **Step 6: Commit**

```bash
git add controller/src/bot/api.js controller/src/bot/format.js controller/src/bot/start.js
git commit -m "bot: <app> <server|group:name|all> grammar; replica counts in /status and /app"
```

---

## Task 13: End-to-end smoke test + doc updates

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md` (if it describes app lifecycle)
- Modify: `.env.example` (if it references removed fields)

- [ ] **Step 1: Run the smoke flow end-to-end**

With a running controller and a second reachable server configured in `~/.ssh/config`:

```bash
# (1) Add the second server to ControlPlane
curl -s -b $COOKIES -H 'Content-Type: application/json' \
  -d '{"name":"server-b","hostname":"server-b-alias"}' \
  http://localhost:3000/api/servers

# (2) Register it as a replica of an existing app
SRV_B=$(curl -s -b $COOKIES http://localhost:3000/api/servers | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);console.log(r.find(s=>s.name==='server-b').id)})")
APP_ID=1
curl -s -b $COOKIES -H 'Content-Type: application/json' \
  -d "{\"serverId\":$SRV_B}" \
  http://localhost:3000/api/applications/$APP_ID/servers

# (3) Deploy to both replicas via server-group
#    (assume server-group `all-servers` exists with members [server-a, server-b])
curl -s -b $COOKIES -H 'Content-Type: application/json' \
  -d "{\"action\":\"deploy\",\"target\":{\"type\":\"app\",\"id\":$APP_ID},\"options\":{\"serverGroupId\":\"all-servers\"}}" \
  http://localhost:3000/api/actions

# (4) Restart just server-b's replica
curl -s -b $COOKIES -H 'Content-Type: application/json' \
  -d "{\"action\":\"restart\",\"target\":{\"type\":\"app\",\"id\":$APP_ID},\"options\":{\"serverId\":$SRV_B}}" \
  http://localhost:3000/api/actions

# (5) Stop one replica → wait 30s → confirm alert fires for THAT replica only
curl -s -b $COOKIES -H 'Content-Type: application/json' \
  -d "{\"action\":\"stop\",\"target\":{\"type\":\"app\",\"id\":$APP_ID},\"options\":{\"serverId\":$SRV_B}}" \
  http://localhost:3000/api/actions

# Wait > 30s, then check audit logs
sleep 35
curl -s -b $COOKIES 'http://localhost:3000/api/audit?limit=20' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);r.filter(x=>x.action==='alert.app-down').slice(0,3).forEach(x=>console.log(x.action, x.target_id, x.message));})"
```

Expected: (3) enqueues one BUILD → 2 DEPLOY jobs; (4) enqueues one RESTART targeting only server-b; (5) eventually produces **no** alert because `expected_state` was flipped to stopped before the stop. Then **manually kill** the process on server-a (`ssh server-a pkill -f <java cmd>`) and wait 30s — an alert should fire for `server-a` only.

- [ ] **Step 2: Update CLAUDE.md**

Edit `CLAUDE.md` — the "Architecture invariants" section. Add this bullet near the `Phase 1 is Java-only.` one:

```
- **Apps are multi-tenant across servers.** `applications.server_id` no longer exists; each app registers N replicas in `application_servers` (one row per (app, server) pair, carrying per-replica process_state / expected_state / pid / last_alert_at / current_release_id). Every action (deploy/start/stop/restart/healthcheck) must carry an explicit server selector — `options.serverId`, `options.serverIds`, or `options.serverGroupId`. `target.type='server_group'` is gone.
```

And in "Controller → target protocol (SSH)", update the stateScheduler bullet:

```
- [controller/src/pollers/stateScheduler.js](controller/src/pollers/stateScheduler.js) — `setInterval` every `STATE_POLL_INTERVAL_MS` (30s default). Pings every non-draining server; on success walks every replica (row in `application_servers`) on that server, runs a launch-mode-specific status probe, and updates `application_servers.process_state`. Three consecutive server misses flip the server to `unreachable` and mark every replica on it as `unknown`.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md .env.example
git commit -m "docs: multi-server replicas — architecture notes + smoke flow"
```

- [ ] **Step 4: Merge-ready push**

```bash
git push -u origin multi-server-replicas
```

Open a PR with `gh pr create` (title: `Multi-server application deployment`; body references the spec path).

---

## Self-review notes

- Every section in the spec maps to a task (Schema → 1; Repositories → 2; Constants/Schemas → 3; Orchestrator → 4; Worker → 5; Poller → 6; Alerts → 7; Replica CRUD → 8 + 9; UI → 11; Bot → 12; Smoke test → 13).
- Placeholder scan: no `TBD`/`TODO` markers remain; every code block is complete.
- Type consistency: `replica_id` vs `application_servers.id` — the poller uses the alias `replica_id`, the repo method `updateProcessState(replicaId, …)` matches; CRUD uses the underlying id.
- The `parseServerArg` helper in the bot assumes server names are unique (they are — `servers.UNIQUE uq_servers_name`).
- `jobs.status IN ('pending','running')` matches `JobStatus` enum values `PENDING` and `RUNNING`.
