# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common commands

All services share a single root `.env` (each workspace's `dev` script runs `node --env-file=../.env`). Copy `.env.example` first and set `DASHBOARD_PASSWORD_HASH`.

```bash
cp .env.example .env
echo -n 'your-password' | npm run dashboard:hash --silent   # paste into .env
docker compose up -d         # MySQL 8 (auto-applies db/schema.sql on first boot)
npm install
npm run db:init              # re-apply db/schema.sql to an existing DB

npm run dev:controller       # REST + WS hub + workers + SPA + Telegram bot (if TELEGRAM_TOKEN set)
npm run dev:agent            # local agent that connects back to the controller
```

There is no test runner or linter wired up yet (`npm test` / `npm run lint` are placeholders). Migrations under `db/migrations/` are **not** applied by `db:init` — apply them manually against the running DB.

## Workspace layout

npm workspaces under internal scope `@cp/*`. ESM (`"type": "module"`), Node ≥20.

- `controller/` — REST API, WS hub, orchestrator, in-process job worker, controller-side builder + artifact store, dashboard SPA static (`controller/public/`), and in-process Telegram bot (`controller/src/bot/`).
- `agent/` — runs on each target server, holds the WS to the controller, executes whitelisted commands, manages process lifecycle.
- `queue/` — in-process queue/producer/worker primitives. Surface mimics a subset of BullMQ.
- `shared/` — constants (enums), logger, error taxonomy, zod schemas, id helpers. Imported as `@cp/shared`, `@cp/shared/constants`, `@cp/shared/errors`, etc.
- `db/` — `schema.sql` (full MySQL 8 schema, InnoDB + utf8mb4) and `migrations/`.

The system runs as **two processes**: one `controller` (which hosts everything except the agent) and one `agent` per managed server.

## Architecture invariants

These cut across multiple files and are easy to violate:

- **Every user-visible action is queued.** No code path may execute a job without going through `enqueueAction` (or `enqueueGroupAction` for fan-out) and writing a `jobs` row + `audit_logs` entry. The orchestrator at [controller/src/orchestrator/orchestrator.js](controller/src/orchestrator/orchestrator.js) is the single chokepoint.
- **In-process queue, no broker.** Queues live in the controller process (`queue/src/queues.js`). Restarting the controller drops anything not yet picked up — this is the intentional trade-off vs. Redis. Don't reintroduce Redis without explicit ask.
- **Idempotency window.** `producer.js` derives `jobId = action:targetType:targetId:timeBucket` so the same action against the same target inside `IDEMPOTENCY_WINDOW_MS` (5s) returns the existing job rather than creating a new one. The `jobs.idempotency_key` column is `UNIQUE` — duplicate inserts will get `ER_DUP_ENTRY` and must be tolerated by callers.
- **Retry only on `TransientError`.** `shared/src/errors.js` defines `TransientError` vs `PermanentError`. The worker checks `err.transient`. Validation, auth, "command not whitelisted", "app disabled" are permanent → fail fast, never retry. `AgentUnavailableError` is transient → retried after agent reconnects.
- **Constants ↔ schema must stay aligned.** All enum values in `shared/src/constants.js` (`JobAction`, `JobStatus`, `BuildStrategy`, `LaunchMode`, `ArtifactTransfer`, `ProcessState`, `ServerStatus`, `Runtime`, `ExpectedState`) mirror MySQL `ENUM` columns in `db/schema.sql`. Adding a value requires editing both — and a migration.
- **Phase 1 is Java-only.** `Runtime = {JAVA}` and `LaunchMode` excludes `pm2`. Node.js/PM2 support returns in phase 2 — do NOT reintroduce `node` as a runtime or `pm2` as a launch mode without a paired migration and UI work.
- **Four named queues, not one.** `cp:restart`, `cp:build`, `cp:deploy`, `cp:system` (`QueueName` in constants). Each gets its own worker so a slow build can't starve restarts. `QueueForAction` maps actions to queues — extend both when adding an action.

## Controller ↔ agent protocol

WebSocket on `/agent` (agents) and `/ui` (browsers). Frame opcodes are `WsOp` in `shared/src/constants.js`. Frames are validated with zod schemas in `shared/src/schemas.js` (e.g. `WsExecute`).

- Agent authenticates with HELLO carrying a bearer token. The controller stores **only the SHA-256 hash** in `servers.auth_token_hash`; raw token is shown to the operator once at provisioning.
- Heartbeat every `HEARTBEAT_INTERVAL_MS` (10s); after `HEARTBEAT_MISS_LIMIT` (3) misses the server is marked `unreachable`.
- On agent disconnect, `WsHub` rejects all in-flight `executeAndWait` promises with `AgentUnavailableError` so they get re-queued.
- The controller never sends raw shell input to the agent. Each EXECUTE frame carries the app's DB-side config; the agent looks up the action in its own templates (see `agent/src/jobHandler.js` + `agent/src/commandWhitelist.js`). Untrusted apps additionally get a `SUSPICIOUS` regex check on commands.

## Build-once-deploy-many

A `deploy` is two-phase when `applications.build_strategy = 'controller'`:

1. The orchestrator enqueues a **BUILD** job onto the controller. `controller/src/workers/jobWorker.js` runs `runBuild` locally, producing a content-addressed `tar.gz` under `ARTIFACT_STORE_DIR/<appId>/<sha256>.tar.gz` and an `artifacts` row.
2. On success the build worker enqueues a **DEPLOY** job carrying `artifactId`. The deploy branch resolves the target server's `artifact_transfer` (`http` → signed short-lived URL via `ARTIFACT_SIGNING_SECRET`; `rsync` → controller pushes via `rsync -e ssh` directly into `releases/<id>/`) and dispatches an EXECUTE frame to the agent. Agent stages, swaps the `current` symlink atomically, and restarts.

Artifacts are deduped by `(application_id, sha256)` AND by `(application_id, commit_sha, config_hash)` where `config_hash = sha256(install_cmd|build_cmd|artifact_pattern)`. Same commit + same build config → reused artifact, no rebuild.

`build_strategy = 'target'` (default, legacy) is the original single-step flow: agent does pull + install + build + restart in-place. Don't conflate the two code paths.

## Server groups & fan-out deploy

Separate from `groups` (which bundles *applications*): `server_groups` + `server_group_members` bundle **servers** for deploy fan-out. The flow is:

1. Operator creates a server-group (e.g. `eu-payments`) and picks member servers via the dashboard's "Server groups" tab.
2. Operator (or bot/API) submits `POST /api/actions` with `{ action: 'deploy', target: { type: 'server_group', id: 'eu-payments' }, options: { applicationId: 42 } }`.
3. Orchestrator enqueues **one** controller BUILD carrying `payload.deployServerIds = [<member ids>]` and `serverGroupName`.
4. On build success the build worker enqueues **N** deploy jobs — one per member — each with `payload.serverIdOverride` set so `runControllerDeploy` and `dispatchToAgent` hit the right agent.
5. Server-group deploys require `build_strategy = 'controller'`. The orchestrator rejects agent-side builds because they can't be multiplexed across servers.

## Expected state & alert-on-down

Every lifecycle action flips `applications.expected_state`:

- `start`, `restart`, `deploy` → `running`
- `stop` → `stopped`

The alert detector (`controller/src/alerts/alertManager.js`) is invoked on every heartbeat by `WsHub`. When `expected_state='running'` and the agent reports `crashed`, `stopped`, or `unknown`, it:

1. Writes an `alert.app-down` row to `audit_logs`.
2. Broadcasts an `{ op: 'alert' }` frame to every `/ui` WS client (shown as a red sticky banner in the SPA).
3. Calls `bot.notifyAdmins(text)` if the Telegram bot is running, paging every chat id in `TELEGRAM_ADMIN_CHAT_IDS`.

Debounce is 5 minutes per app (`applications.last_alert_at`) — enough to ride out an investigation, short enough that a fresh incident still pages. Expected state is **not** part of `APP_EDITABLE_FIELDS`; it's derived from action submission, never PATCH'd directly.

## Dashboard auth

The dashboard uses a single shared password (set as bcrypt hash in `DASHBOARD_PASSWORD_HASH`) and a signed session cookie (`cp_session`, signed with `CONTROLLER_JWT_SECRET`). Login flow:

1. Browser POSTs `{ password }` to `/auth/login`.
2. Controller verifies against the bcrypt hash and sets an `HttpOnly`, `SameSite=Lax` cookie. `Secure` is added when `NODE_ENV=production`.
3. SPA calls `/api/*` with `credentials: 'same-origin'`. The `requireAuth` middleware accepts **either** `Authorization: Bearer <token>` (matching `CONTROLLER_API_TOKENS`, used by external scripts/CLI) **or** a valid `cp_session` cookie.
4. WS `/ui` upgrade verifies the same cookie and rejects with HTTP 401 if missing or invalid.

Generate a password hash with `echo -n 'your-password' | npm run dashboard:hash --silent` and paste into `.env`. When `DASHBOARD_PASSWORD_HASH` is set, the controller fails to boot if `CONTROLLER_JWT_SECRET` is left at the placeholder default or shorter than 32 chars.

## Telegram bot scope

The Telegram bot runs **in-process inside the controller** (started only when `TELEGRAM_TOKEN` is set). It calls the controller's repositories and orchestrator directly via [controller/src/bot/api.js](controller/src/bot/api.js) — no HTTP loopback, no bearer token. It must not query the DB outside those repositories or talk to agents directly: every action goes through `submitAction` (the orchestrator's single chokepoint, same as REST). `TELEGRAM_ADMIN_CHAT_IDS` gates destructive commands.
