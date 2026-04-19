# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common commands

All services share a single root `.env` (each workspace's `dev` script runs `node --env-file=../.env`). Copy `.env.example` first.

```bash
cp .env.example .env
docker compose up -d         # MySQL 8 (auto-applies db/schema.sql on first boot)
npm install                  # installs all workspaces (root uses npm workspaces)
npm run db:init              # re-apply db/schema.sql to an existing DB

npm run dev:controller       # REST + WS hub + in-process worker (port 8080)
npm run dev:agent            # local agent that connects back to the controller
npm run dev:bot              # Telegram bot (needs TELEGRAM_TOKEN)
npm run dev:web              # SPA + API-proxy (port 8081)
```

There is no test runner or linter wired up yet (`npm test` / `npm run lint` are placeholders). Migrations under `db/migrations/` are **not** applied by `db:init` — apply them manually against the running DB.

## Workspace layout

npm workspaces under internal scope `@cp/*`. ESM (`"type": "module"`), Node ≥20.

- `controller/` — REST API, WS hub, orchestrator, in-process job worker, controller-side builder + artifact store.
- `agent/` — runs on each target server, holds the WS to the controller, executes whitelisted commands, manages process lifecycle.
- `queue/` — in-process queue/producer/worker primitives. Surface mimics a subset of BullMQ (`getQueue(name).add(...)`, `createWorker(...)`).
- `bot/` — Telegram bot, thin client over the controller REST API. No DB or agent access.
- `web/` — static SPA + tiny Express server that proxies `/api/*` to the controller, injecting the bearer token server-side so the browser never holds it.
- `shared/` — constants (enums), logger, error taxonomy, zod schemas, id helpers. Imported as `@cp/shared`, `@cp/shared/constants`, `@cp/shared/errors`, etc. (subpath exports declared in `shared/package.json`).
- `db/` — `schema.sql` (full MySQL 8 schema, InnoDB + utf8mb4) and `migrations/`.

## Architecture invariants

These cut across multiple files and are easy to violate:

- **Every user-visible action is queued.** No code path may execute a job without going through `enqueueAction` (or `enqueueGroupAction` for fan-out) and writing a `jobs` row + `audit_logs` entry. The orchestrator at [controller/src/orchestrator/orchestrator.js](controller/src/orchestrator/orchestrator.js) is the single chokepoint.
- **In-process queue, no broker.** Queues live in the controller process (`queue/src/queues.js`). Restarting the controller drops anything not yet picked up — this is the intentional trade-off vs. Redis. Don't reintroduce Redis without explicit ask.
- **Idempotency window.** `producer.js` derives `jobId = action:targetType:targetId:timeBucket` so the same action against the same target inside `IDEMPOTENCY_WINDOW_MS` (5s) returns the existing job rather than creating a new one. The `jobs.idempotency_key` column is `UNIQUE` — duplicate inserts will get `ER_DUP_ENTRY` and must be tolerated by callers.
- **Retry only on `TransientError`.** `shared/src/errors.js` defines `TransientError` vs `PermanentError`. The worker checks `err.transient`. Validation, auth, "command not whitelisted", "app disabled" are permanent → fail fast, never retry. `AgentUnavailableError` is transient → retried after agent reconnects.
- **Constants ↔ schema must stay aligned.** All enum values in `shared/src/constants.js` (`JobAction`, `JobStatus`, `BuildStrategy`, `LaunchMode`, `ArtifactTransfer`, `ProcessState`, `ServerStatus`, `Runtime`) mirror MySQL `ENUM` columns in `db/schema.sql`. Adding a value requires editing both — and a migration.
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

## Web token handling

The browser never holds an API token. `web/src/server.js` proxies `/api/*` to the controller and adds `Authorization: Bearer <token>` server-side using `WEB_CONTROLLER_TOKEN` (falls back to `TELEGRAM_CONTROLLER_TOKEN`). The browser does open a direct WS to the controller's `/ui` endpoint (currently unauthenticated; gated at the HTTP layer in production per the comment in `ws/hub.js`).

## Telegram bot scope

The bot is a thin REST client. It must not query the DB or talk to agents directly — every action goes through `POST /api/actions` and reads through `GET /api/jobs/:id` etc. `TELEGRAM_ADMIN_CHAT_IDS` gates destructive commands.
