# Multi-Server Application Deployment — Design

**Date:** 2026-04-21
**Status:** Approved, ready for implementation plan
**Scope:** Let one application run on many servers. Replace `applications.server_id` (1:1 home server) with an `application_servers` replica table, and let every action (deploy/start/stop/restart/healthcheck) target a specific replica, an explicit list, or a server group.

## Motivation

Today `applications.server_id` pins each app to exactly one server. Operators who own multiple servers can still deploy the same app to each, but only by creating a separate `applications` row per host — duplicated repo/build config, duplicated alerts, duplicated dashboard entries. The `server_groups` primitive already supports fan-out deploys, but server_group targeting only works for `deploy`, and the state poller / alert detector still treat each `applications` row as a single-location process.

We want **one `applications` row to represent the app** and track **N running copies** ("replicas") of it on N servers. Deploy, restart, stop, and healthcheck should be first-class per-replica operations. State polling and alerting should be per-replica so operators see exactly which replica is down.

## Decisions

- Relation `app ↔ server` is expressed as a dedicated many-to-many table `application_servers` that **also holds per-replica runtime state** (`process_state`, `expected_state`, `pid`, timestamps, alert debounce, currently-deployed release).
- `applications.server_id` and every per-replica state column on `applications` are **removed** (copied into `application_servers` by migration).
- Every action on `target.type='app'` **must** carry an explicit server selector (`options.serverId` / `options.serverIds` / `options.serverGroupId`). No implicit "target all replicas" default — safer for ops; bot/UI can expand "all" into an explicit list before submit.
- `target.type='server_group'` is **removed** from the submit API. Replaced by `target.type='app' + options.serverGroupId`. Orchestrator returns a ValidationError pointing at the new shape if the old form is submitted.
- Per-replica `expected_state`: each action flips `expected_state` **only for the replicas it targets**. There is no app-level `expected_state`.
- Alerts are per-replica. Debounce per-replica (5 min) via `application_servers.last_alert_at`. Alert text names both app and server.
- Replica CRUD is explicit: operators add/remove a replica via new REST endpoints before they can submit actions for that (app, server) pair.
- All replicas run the **same** app config (env, start_cmd, stop_cmd, launch_mode, …). Per-replica config overrides are out of scope (YAGNI).
- Rollback remains whole-app (by `release_id`), not per-replica.
- Reusable workflow definitions (canary, rolling deploys) are **out of scope** — already deferred by the prior brainstorming round.

## Architecture

```
┌──────────────── controller (single process) ────────────────────┐
│                                                                  │
│   REST /api/actions ──► orchestrator.submitAction                │
│                                │                                 │
│                                │  options.serverId                │
│                                │  options.serverIds               │
│                                │  options.serverGroupId           │
│                                ▼                                 │
│                     resolve replica set                          │
│                        (intersect with                           │
│                         application_servers)                     │
│                                │                                 │
│                                ├─► BUILD (deploy only)           │
│                                │     └─► N DEPLOY jobs            │
│                                │         (serverIdOverride)      │
│                                │                                 │
│                                └─► N direct jobs (start/stop/…) │
│                                      (serverIdOverride)          │
│                                                                  │
│   stateScheduler (30 s):                                         │
│     SELECT a.*, s.hostname FROM application_servers a            │
│       JOIN servers s ON a.server_id = s.id                       │
│       WHERE s.status != 'draining' AND a.enabled                 │
│     → per-server reachability ping                               │
│     → per-replica status probe → update application_servers      │
│                                                                  │
│   alertManager: per-replica expected vs actual → alert.app-down  │
│                 with app.name + server.name                      │
└──────────────────────────────────────────────────────────────────┘
```

**Invariants kept:**

- Every user-visible action goes through `submitAction` → queue → worker → audit. Four named queues, idempotency window, retry profile — unchanged.
- Build-once-deploy-many: one BUILD, fan out N DEPLOY jobs. Deploy queueJobId format `deploy:app:<appId>@<serverId>:<hash>` stays.
- Controller-only SSH model unchanged; no new wire protocols.

**Invariants changed:**

- `applications` no longer carries a home server or runtime state columns. Those columns move to `application_servers`.
- `target.type='server_group'` is gone from the submit API.
- Every action must carry an explicit server selector.

## Data model

### New table `application_servers`

```sql
CREATE TABLE IF NOT EXISTS application_servers (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id       BIGINT UNSIGNED NOT NULL,
  server_id            BIGINT UNSIGNED NOT NULL,

  -- per-replica runtime state (was on applications)
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

  -- what's currently deployed to this replica
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
```

### Modified `applications`

Dropped columns (migrated into `application_servers`):

- `server_id`
- `process_state`
- `expected_state`
- `pid`
- `last_started_at`
- `last_exit_code`
- `last_exit_at`
- `uptime_seconds`
- `last_alert_at`

FK indexes referencing these (`idx_applications_server`, `idx_applications_state`) are dropped as well. `UNIQUE (name, server_id)` is replaced with `UNIQUE (name)` — app names become globally unique (they already were per-server, and per-server uniqueness now collapses to per-app).

Retained: `name`, `group_id`, `runtime`, `build_strategy`, `artifact_pattern`, `remote_install_path`, `repo_url`, `branch`, `workdir`, `install_cmd`, `build_cmd`, `start_cmd`, `stop_cmd`, `launch_mode`, `status_cmd`, `logs_cmd`, `health_cmd`, `env`, `trusted`, `enabled`, timestamps.

### Migration (`db/migrations/005_multi_server_replicas.sql`)

Forward-only, not paired with a down-migration:

1. `CREATE TABLE application_servers ...` (definition above).
2. `INSERT INTO application_servers (application_id, server_id, process_state, expected_state, pid, last_started_at, last_exit_code, last_exit_at, uptime_seconds, last_alert_at) SELECT id, server_id, process_state, expected_state, pid, last_started_at, last_exit_code, last_exit_at, uptime_seconds, last_alert_at FROM applications WHERE server_id IS NOT NULL;`
3. `ALTER TABLE applications DROP FOREIGN KEY fk_applications_server;`
4. `ALTER TABLE applications DROP INDEX idx_applications_server, DROP INDEX idx_applications_state, DROP INDEX uq_applications_name_server;`
5. `ALTER TABLE applications DROP COLUMN server_id, DROP COLUMN process_state, DROP COLUMN expected_state, DROP COLUMN pid, DROP COLUMN last_started_at, DROP COLUMN last_exit_code, DROP COLUMN last_exit_at, DROP COLUMN uptime_seconds, DROP COLUMN last_alert_at;`
6. `ALTER TABLE applications ADD UNIQUE KEY uq_applications_name (name);`

`db/schema.sql` is updated in lockstep so fresh installs skip the migration.

**Pre-migration caveat**: the old unique key was `(name, server_id)`, so two distinct `applications` rows could share a name on different servers. The migration assumes each name is unique; if any install has duplicates, step 6 will fail with `ER_DUP_ENTRY`. The migration file carries a guard `SELECT` that aborts early with a clear message listing the conflicting names so the operator can resolve them (merge into one app + register both servers as replicas) before retrying.

### `jobs` table

No schema change. `jobs.server_id` already exists and continues to identify the target replica for fan-out jobs.

## Orchestrator semantics

### Request shape

```js
submitAction({
  action: 'deploy'|'start'|'stop'|'restart'|'healthcheck',
  target: { type: 'app'|'group', id },          // server_group removed
  triggeredBy: 'web:alice' | 'telegram:123' | ...,
  options: {
    // exactly one of the three server selectors is required for target.type='app'
    serverId?:      number,
    serverIds?:     number[],
    serverGroupId?: number | string,

    // existing options still honored:
    applicationId?: number,    // for target.type='group' inner resolution
    commitSha?:     string,    // deploy only
  },
})
```

### Server-selector resolution (`target.type='app'`)

1. Load the app (by id or name).
2. Load the app's replica set: `application_servers WHERE application_id = :id` → `replicaServerIds: Set<number>`.
3. Resolve `options`:
   - `serverId` → `[serverId]`.
   - `serverIds` → as given.
   - `serverGroupId` → `server_group_members` of the referenced group.
   - **None of the three present** → `throw ValidationError('must specify serverId, serverIds, or serverGroupId')`.
   - **More than one present** → `throw ValidationError('serverId, serverIds, serverGroupId are mutually exclusive')`.
4. `targetServerIds := resolved ∩ replicaServerIds`.
   - Empty → `throw ValidationError('no replicas of <app> match the requested server set')`.
   - Non-empty subset of `resolved` (some requested servers aren't replicas of this app) → `throw ValidationError('server <id> is not a replica of <app>')` naming the first offender.
5. Build fan-out jobs (below).

### Fan-out

- **`deploy`**:
  - Enqueue **one** BUILD as today with `payload.deployServerIds = targetServerIds` and `payload.serverGroupName` (when the selector was `serverGroupId`, for audit breadcrumbs).
  - The BUILD worker enqueues **N DEPLOY jobs**, one per `serverId` in `targetServerIds`, each with `payload.serverIdOverride`, `payload.applicationId`, `payload.artifactId`, `payload.releaseId`. The idempotency key continues to be derived from `targetId = ${appId}@${serverId}`.
  - On a successful DEPLOY, the worker updates the matching `application_servers` row: `current_release_id`, `current_artifact_id`, `expected_state='running'`.
- **`start` / `stop` / `restart` / `healthcheck`**:
  - Enqueue N direct jobs, one per `serverId`, each with `payload.serverIdOverride` and `payload.applicationId`. The existing worker codepath already reads `serverIdOverride`; only the per-replica state writes are new.
  - `start`, `restart` flip the targeted replicas' `expected_state='running'`. `stop` flips to `'stopped'`. `deploy` flips to `'running'`. `healthcheck` does not change expected state.

### `target.type='group'` (app-group)

Unchanged at the group level: every enabled app in the app-group is iterated. The same `options` server-selector is applied to **each** inner app (intersected against that app's own replica set). Apps in the group that have zero matching replicas are skipped with an `audit_logs` note (not a hard failure), and the overall submit returns a per-app result list.

### Idempotency

Unchanged. `queueJobId = ${action}:app:${appId}@${serverId}:${hash}` for every per-replica job. The 5 s idempotency window applies per (action, app, server) pair.

### `target.type='server_group'` deprecation

Returns `ValidationError('target.type="server_group" is removed; submit with target.type="app" and options.serverGroupId')`. REST, bot, and SPA are updated in the same change; the error is a safety net for out-of-date callers.

## State poller

`controller/src/pollers/stateScheduler.js` changes:

1. Top-level query changes from "per app join its home server" to "per replica join its server":

   ```sql
   SELECT ar.id            AS replica_id,
          ar.application_id,
          ar.server_id,
          ar.expected_state,
          ar.process_state,
          ar.unreachable_count,
          s.hostname, s.name AS server_name, s.status AS server_status,
          a.name AS app_name, a.launch_mode, a.status_cmd, a.start_cmd,
          a.enabled
     FROM application_servers ar
     JOIN servers      s ON ar.server_id = s.id
     JOIN applications a ON ar.application_id = a.id
    WHERE s.status != 'draining' AND a.enabled = 1;
   ```

2. Group replicas by `server_id`. For each server:
   - Run one SSH reachability ping.
   - On success, probe each replica with the launch-mode-specific status command; `UPDATE application_servers SET process_state=?, pid=?, uptime_seconds=?, last_started_at=?, last_exit_code=?, last_exit_at=?, unreachable_count=0 WHERE id = ?`.
   - On failure, increment `application_servers.unreachable_count += 1` for every replica on this server. If the increment crosses 3, set `servers.status='unreachable'` and `application_servers.process_state='unknown'` for every replica on it.

3. After each replica's state write, call `alertManager.check(replica)`.

## Alert manager

`controller/src/alerts/alertManager.js` changes:

- Input becomes a full replica row (with joined `applications` and `servers` names for the message).
- Trigger condition: `replica.expected_state = 'running'` AND `replica.process_state ∈ {'crashed','stopped','unknown'}`.
- Debounce: `replica.last_alert_at` within last 5 min → skip.
- On fire:
  1. `INSERT INTO audit_logs (action='alert.app-down', target_type='application_server', target_id=<replica_id>, metadata={appName, serverName, process_state, expected_state, unreachable_count})`.
  2. `UPDATE application_servers SET last_alert_at = NOW() WHERE id = <replica_id>`.
  3. `uiHub.broadcast({ op: 'alert', appId, serverId, appName, serverName, processState, expectedState })`.
  4. `bot.notifyAdmins(\`${appName} @ ${serverName} is ${process_state} (expected running)\`)` when bot is running.

`audit_logs.target_type` gains a value `'application_server'` — this is a string column with no enum, so no schema change is required.

## Replica CRUD (REST)

New endpoints under `/api/applications/:id/servers`:

- `GET /api/applications/:id/servers` — returns the app's replica rows joined with `servers` (`{ serverId, serverName, processState, expectedState, pid, uptimeSeconds, currentReleaseId, currentArtifactId, lastAlertAt }`).
- `POST /api/applications/:id/servers` — body: `{ serverId: number }`. Inserts `application_servers` with `expected_state='stopped'`, `process_state='unknown'`, everything else null/zero. Rejects with `ValidationError` when `servers.status='draining'`; rejects with `ConflictError` on UNIQUE (`application_id`, `server_id`) collision (already registered). Writes an `audit_logs` entry (`action='replica.added'`).
- `DELETE /api/applications/:id/servers/:serverId` — removes the row. Rejects with `ConflictError` if `jobs` has a row with `(application_id, server_id)` and `status ∈ ('queued','running')`. Writes `action='replica.removed'` audit.

Zod schemas (`shared/src/schemas.js`) are extended with `ReplicaAddInput`, `ReplicaParams`.

Auth: `requireAuth` middleware already covers `/api/*` — same auth model as existing CRUD.

## Dashboard UI

**App list** (`controller/public/`):
- Replica summary column per row: `2/3 running, 1 crashed` with color coding (green/red/yellow).
- Clicking expands to a per-replica mini-table.

**App detail page**:
- New "Replicas" tab. Table: server name, process_state, expected_state, pid, uptime, current release, last alert.
- Per-row action buttons: `Restart`, `Stop`, `Deploy` (submits with `options.serverId`).
- "Bulk actions" row above the table: selector (multi-select of this app's replicas, or a server-group dropdown), then action buttons applied to the selection.
- "Add server" button opens a dialog showing servers **not** already registered as replicas of this app. Submits `POST /api/applications/:id/servers`.
- Confirmation modal for `stop`/`restart` when the selection contains ≥ 2 replicas: "This will affect N replicas. Continue?" (This is the UI safety net called out in the brainstorming round — the API itself is always explicit, no default-all-replicas.)

**Server detail page**:
- New "Applications" section listing every replica on this server (join via `application_servers`): app name, process_state, expected_state, last alert.

**Action submission UI** (existing "Submit action" form):
- Replace "Target type: app / group / server_group" with "Target type: app / group" + mandatory server selector controls (radio: `single server` | `server list` | `server group`; then a dropdown/multi-select populated from the selected app's replica set).

## Telegram bot

Command grammar:

- `/apps` — each app shows `replicas: N/M running` aggregate.
- `/app <name>` — shows per-replica list with state.
- `/restart <app> <server>` | `/stop <app> <server>` | `/deploy <app> <server>` — single replica.
- `/restart <app> group:<server-group>` | `/stop ...` | `/deploy ...` — server group (bot resolves server-group name → `options.serverGroupId` before submitting).
- `/restart <app> all` | `/stop <app> all` | `/deploy <app> all` — the bot fetches the app's replica list and submits with explicit `options.serverIds` (so the API-level "no default" rule is respected).
- Unknown/ambiguous syntax responds with a usage hint.

Destructive commands (`stop <app> all`, `restart <app> all`) require an admin chat id (`TELEGRAM_ADMIN_CHAT_IDS`) — same gate as today for destructive ops.

## Worker changes

`controller/src/workers/jobWorker.js`:

- `runDeploy` already uses `payload.applicationId` (recent fix). After a successful deploy, also write the target replica's `application_servers` row: `UPDATE application_servers SET current_release_id=?, current_artifact_id=?, expected_state='running' WHERE application_id=? AND server_id=?`.
- Start/stop/restart branches: flip targeted replica's `expected_state` as part of the successful-finish path (same transaction/step as `jobsRepo.markFinished`).
- Alert/state writes for all actions read the replica row for `expected_state` (no longer the app row).

`controller/src/orchestrator/orchestrator.js`:

- `EXPECTED_STATE_FOR_ACTION` becomes `applyExpectedStateForReplicas(appId, serverIds, action)` that sets expected state per-replica (via `application_servers`).

## Constants

`shared/src/constants.js`:

- `JobTargetType.SERVER_GROUP` is removed. Dependent code (producer validation, orchestrator) is updated accordingly.
- `ProcessState`, `ExpectedState`, `ServerStatus` enums are unchanged — they migrate verbatim from `applications` columns onto `application_servers`.

## Risks and open questions

- **Concurrent replica mutation**: adding/removing a replica while a fan-out job is mid-flight. Mitigation: `DELETE /api/applications/:id/servers/:serverId` hard-checks `jobs` for pending/running entries; `POST` is safe because new replicas are `expected_state='stopped'` and the next submitted action is the thing that kicks them to running.
- **Partial fan-out failures**: if 1 of 3 DEPLOY jobs fails, the app has 2 replicas on release N+1 and 1 on release N. That's pre-existing behavior and is not changed here — operator retries the failed replica explicitly. We do **not** introduce a transactional "all-or-nothing" fan-out.
- **Alert flood on global outage**: if a shared SSH bastion goes down, every replica on every affected server alerts. Existing 5-min debounce per replica applies; we don't add fleet-wide suppression because the per-(app, server) signal is still the right information.
- **`audit_logs.target_type` as free string**: works today, but adds implicit coupling between alert detector and any consumer filtering on `target_type`. Flagged; no action needed unless a future query starts enum-matching it.

## Implementation order (for the plan)

Each step is independently testable against a dev MySQL.

1. **Schema + migration** — `application_servers` table, `applications` column drops, `db/migrations/005_multi_server_replicas.sql`, update `db/schema.sql`.
2. **Repositories** — new `applicationServers` repo in `controller/src/db/repositories.js`; update `applications.get/list/insert/update` to strip removed columns.
3. **Orchestrator** — server-selector parsing, replica-set intersection, fan-out for all actions, per-replica `expected_state`.
4. **Worker** — per-replica expected/state writes in all branches.
5. **State poller** — switch query and writes to `application_servers`.
6. **Alert manager** — per-replica trigger + debounce + alert text.
7. **Replica CRUD API** — read/add/remove endpoints + zod schemas.
8. **Dashboard SPA** — replica list + per-replica actions + bulk confirmation modal.
9. **Bot** — new command grammar; `all` keyword expansion.
10. **Smoke test** — deploy an app to two servers, restart one, verify per-replica alert, remove a replica, add it back.

## Out of scope (deliberate)

- Workflow definitions (canary, rolling, approval gates) — deferred.
- Per-replica config overrides — app config stays global.
- Rollback per-replica — rollback remains whole-app by release id.
- Automatic replica membership from `server_groups` (Option C from brainstorming) — membership is explicit CRUD only.
