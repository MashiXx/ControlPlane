# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common commands

The controller reads the root `.env` (its `dev` script runs `node --env-file=../.env`). Copy `.env.example` first and set `DASHBOARD_PASSWORD_HASH`.

```bash
cp .env.example .env
echo -n 'your-password' | npm run dashboard:hash --silent   # paste into .env
docker compose up -d         # MySQL 8 (auto-applies db/schema.sql on first boot)
npm install
npm run db:init              # re-apply db/schema.sql to an existing DB

npm run dev:controller       # REST + /ui WS + workers + SSH poller + SPA + Telegram bot
```

There is no test runner or linter wired up yet (`npm test` / `npm run lint` are placeholders). Migrations under `db/migrations/` are **not** applied by `db:init` — apply them manually against the running DB.

## Workspace layout

npm workspaces under internal scope `@cp/*`. ESM (`"type": "module"`), Node ≥20.

- `controller/` — REST API, `/ui` WS hub, orchestrator, in-process job worker, controller-side builder + artifact store, SSH client, remote-exec action logic, state poller, dashboard SPA (`controller/public/`), in-process Telegram bot (`controller/src/bot/`).
- `queue/` — in-process queue/producer/worker primitives. Surface mimics a subset of BullMQ.
- `shared/` — constants (enums), logger, error taxonomy, zod schemas, id helpers. Imported as `@cp/shared`, `@cp/shared/constants`, `@cp/shared/errors`, etc.
- `db/` — `schema.sql` (full MySQL 8 schema, InnoDB + utf8mb4) and `migrations/`.

The system runs as a **single process**. The controller drives every target server over SSH directly; there is no agent process and no reverse WebSocket channel. Auth to target hosts is the controller user's `~/.ssh/config`.

## Architecture invariants

These cut across multiple files and are easy to violate:

- **Every user-visible action is queued.** No code path may execute a job without going through `enqueueAction` and writing a `jobs` row + `audit_logs` entry. The orchestrator at [controller/src/orchestrator/orchestrator.js](controller/src/orchestrator/orchestrator.js) is the single chokepoint.
- **In-process queue, no broker.** Queues live in the controller process (`queue/src/queues.js`). Restarting the controller drops anything not yet picked up — intentional vs. Redis. Don't reintroduce Redis without explicit ask.
- **Idempotency window.** `producer.js` derives `jobId = action:targetType:targetId:timeBucket` so the same action against the same target inside `IDEMPOTENCY_WINDOW_MS` (5s) returns the existing job. The `jobs.idempotency_key` column is `UNIQUE` — duplicate inserts will get `ER_DUP_ENTRY` and must be tolerated by callers.
- **Retry only on `TransientError`.** `shared/src/errors.js` defines `TransientError` vs `PermanentError`. The worker checks `err.transient`. Validation, auth, "command not whitelisted", "app disabled" are permanent → fail fast. `ssh exit 255`, `ssh timeout`, `rsync` non-zero, healthcheck non-zero → transient.
- **Constants ↔ schema must stay aligned.** All enum values in `shared/src/constants.js` (`JobAction`, `JobStatus`, `LaunchMode`, `ProcessState`, `ServerStatus`, `Runtime`, `ExpectedState`) mirror MySQL `ENUM` columns in `db/schema.sql`. Adding a value requires editing both — and a migration.
- **Phase 1 is Java-only.** `Runtime = {JAVA}` and `LaunchMode` excludes `pm2`. Node.js/PM2 support returns in phase 2 — do NOT reintroduce `node` as a runtime or `pm2` as a launch mode without a paired migration and UI work.
- **Apps have a single placement.** Each `applications` row pins its deployment target via **exactly one** of `server_id` OR `server_group_id` (enforced by `chk_applications_placement` at DB level + zod `AppCreate`/`AppUpdate` at API level). `application_servers` still carries per-replica `process_state` / `expected_state` / `pid` / `last_alert_at` / `current_release_id`, but rows are **derived** from placement by `syncAppReplicas(appId)` — operators never edit that table directly. Changing `applications.server_id` / `server_group_id`, or changing a server-group's membership, re-runs the sync. Actions against an app default to fanning out to every current replica; `options.serverId` optionally narrows the action to one replica (used by the per-row buttons in the dashboard Replicas dialog). `options.serverIds`, `options.serverGroupId`, and `target.type='server_group'` are all gone.
- **Every deploy builds on the controller.** `applications.build_strategy` is pinned to `'controller'` (the enum has only that value). There is no agent-side build path.
- **Four named queues, not one.** `cp:restart`, `cp:build`, `cp:deploy`, `cp:system` (`QueueName` in constants). Each gets its own worker so a slow build can't starve restarts. `QueueForAction` maps actions to queues — extend both when adding an action.

## Controller → target protocol (SSH)

The controller drives every target-server action over SSH. Entry points:

- [controller/src/ssh/sshClient.js](controller/src/ssh/sshClient.js) — the single `runSsh(host, cmd, opts)` / `runRsync(local, host, remote, opts)` wrapper. Hardcodes `-o BatchMode=yes -o ConnectTimeout=10`. Exports `shellSafe` and `shellQuote` helpers.
- [controller/src/exec/remoteExec.js](controller/src/exec/remoteExec.js) — per-action logic: `startAction`, `stopAction`, `restartAction`, `healthcheckAction`, `deployAction`. Composes the wrapped / raw / systemd launch command on the fly and embeds it in the SSH call. Runs the whitelist (`SUSPICIOUS` regex) on untrusted apps.
- [controller/src/pollers/stateScheduler.js](controller/src/pollers/stateScheduler.js) — `setInterval` every `STATE_POLL_INTERVAL_MS` (30s default). Pings every non-draining server; on success walks every replica (row in `application_servers`) on that server, runs a launch-mode-specific status probe, and updates `application_servers.process_state`. Three consecutive server misses flip the server to `unreachable` and mark every replica on it as `unknown`.

All connection details (User, Port, IdentityFile, ProxyJump, `ControlMaster`) live in the controller user's `~/.ssh/config`. Nothing per-server beyond the hostname alias lives in the DB.

## Build-once-deploy-many

Every `deploy` is two-phase:

1. The orchestrator enqueues a **BUILD** job. [controller/src/workers/jobWorker.js](controller/src/workers/jobWorker.js) runs `runBuild` locally, producing a content-addressed `tar.gz` under `ARTIFACT_STORE_DIR/<appId>/<sha256>.tar.gz` and an `artifacts` row.
2. On success the build worker enqueues one **DEPLOY** job per target server (server-group fan-out) carrying `artifactId` and `releaseId`. The deploy branch calls `deployAction` which extracts locally → `rsync -az --delete` to `<remote_install_path>/releases/<releaseId>/` → atomic `ln -sfn` swap of `current` → stop → start → GC old releases (keep newest `RELEASE_RETENTION_COUNT = 5`).

Artifacts are deduped by `(application_id, sha256)` AND by `(application_id, commit_sha, config_hash)` where `config_hash = sha256(install_cmd|build_cmd|artifact_pattern)`. Same commit + same build config → reused artifact, no rebuild.

## Server groups & fan-out deploy

Separate from `groups` (which bundles *applications*): `server_groups` + `server_group_members` bundle **servers**. An app placed on a group has one replica per current member; adding or removing a member re-runs `syncAppReplicas` for every dependent app. The flow is:

1. Operator creates a server-group (e.g. `eu-payments`) and picks member servers via the dashboard's "Server groups" tab.
2. Operator creates or edits an application, picking either **Single server** (sets `applications.server_id`) or **Server group** (sets `applications.server_group_id`) — never both. `syncAppReplicas(appId)` fills `application_servers` from that placement.
3. Operator (or bot/API) submits `POST /api/actions` with `{ action: 'deploy', target: { type: 'app', id: 42 } }`. No server selector required; the orchestrator reads the app's current replicas.
4. Orchestrator enqueues **one** BUILD carrying `payload.deployServerIds = [<all current replicas>]`.
5. On build success the build worker enqueues **N** deploy jobs — one per target server — each with `payload.serverIdOverride` so `deployAction` hits the right host.

Per-replica surgery is still possible via `options.serverId` — the dashboard's Replicas dialog uses it for its Restart / Stop / Deploy buttons. The passed server must already be a replica of the app (i.e. `=applications.server_id` or a current member of `applications.server_group_id`).

## Expected state & alert-on-down

Every lifecycle action flips `application_servers.expected_state` **per replica**:

- `start`, `restart`, `deploy` → `running`
- `stop` → `stopped`

The alert detector [controller/src/alerts/alertManager.js](controller/src/alerts/alertManager.js) is called by the state scheduler after every per-replica probe. When `expected_state='running'` and the poll reports `crashed`, `stopped`, or `unknown`, it:

1. Writes an `alert.app-down` row to `audit_logs` with `target_type='application_server'` and `target_id=<replica id>`.
2. Broadcasts `{ op: 'alert' }` via `UiHub` to every `/ui` WS client, naming both app and server.
3. Calls `bot.notifyAdmins(text)` if the Telegram bot is running.

Debounce is 5 minutes **per replica** (`application_servers.last_alert_at`). `expected_state` is derived from action submission — operators flip it by submitting a matching action, not by editing the row directly.

## Dashboard auth

The dashboard uses a single shared password (bcrypt hash in `DASHBOARD_PASSWORD_HASH`) and a signed session cookie (`cp_session`, signed with `CONTROLLER_JWT_SECRET`). Login flow:

1. Browser POSTs `{ password }` to `/auth/login`.
2. Controller verifies against the bcrypt hash and sets an `HttpOnly`, `SameSite=Lax` cookie. `Secure` is added when `NODE_ENV=production`.
3. SPA calls `/api/*` with `credentials: 'same-origin'`. The `requireAuth` middleware accepts **either** `Authorization: Bearer <token>` (matching `CONTROLLER_API_TOKENS`) **or** a valid `cp_session` cookie.
4. WS `/ui` upgrade verifies the same cookie and rejects with HTTP 401 otherwise.

Generate a password hash with `echo -n 'your-password' | npm run dashboard:hash --silent`. When `DASHBOARD_PASSWORD_HASH` is set, the controller fails to boot if `CONTROLLER_JWT_SECRET` is left at the placeholder default or shorter than 32 chars.

## Telegram bot scope

The Telegram bot runs **in-process inside the controller** (started only when `TELEGRAM_TOKEN` is set). It calls the controller's repositories and orchestrator directly via [controller/src/bot/api.js](controller/src/bot/api.js) — no HTTP loopback, no bearer token. It must not query the DB outside those repositories: every action goes through `submitAction` (the orchestrator's single chokepoint, same as REST). `TELEGRAM_ADMIN_CHAT_IDS` gates destructive commands.
