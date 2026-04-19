# ControlPlane

A production-grade distributed process management system for Node.js and Java
applications across fleets of remote servers.

Reliability, observability, and operational safety are first-class concerns.
All actions are queued, retried with backoff, and audited to a database.

---

## Architecture

```
                            ┌──────────────────┐
                            │  Telegram Bot    │
                            │  /status /restart│
                            └────────┬─────────┘
                                     │ HTTPS (API token)
                                     ▼
 ┌─────────────┐  WebSocket   ┌──────────────────┐      ┌────────────┐
 │ Web         │◄────────────►│                  │◄────►│  MySQL     │
 │ Dashboard   │   REST       │   Controller     │      │ (state,    │
 └─────────────┘              │                  │      │  audit)    │
                              │  - REST / WS API │      └────────────┘
                              │  - Orchestrator  │
                              │  - Job Worker    │      ┌────────────┐
                              │  - Audit Sink    │◄────►│  Redis     │
                              └──┬─────────────┬─┘      │ (BullMQ)   │
                                 │             │        └────────────┘
                     WebSocket   │             │  BullMQ jobs
                    (bidir, hb)  │             │
                  ┌──────────────┘             └──────────────┐
                  ▼                                           ▼
           ┌────────────┐                              ┌────────────┐
           │  Agent     │                              │  Agent     │
           │  server-A  │              ...             │  server-N  │
           │            │                              │            │
           │ - executor │                              │ - executor │
           │ - pm (pm2) │                              │ - pm (pm2) │
           │ - health   │                              │ - health   │
           └────────────┘                              └────────────┘
```

### Components

| Component    | Path           | Responsibility                                               |
| ------------ | -------------- | ------------------------------------------------------------ |
| `controller` | `/controller`  | REST + WS API, orchestrator, BullMQ worker, audit sink.      |
| `agent`      | `/agent`       | Runs on each target server. Executes whitelisted commands.   |
| `queue`      | `/queue`       | BullMQ queue/producer/worker primitives shared by everyone.  |
| `bot`        | `/bot`         | Telegram bot → Controller API. No direct agent access.       |
| `web`        | `/web`         | Static SPA + WS client for dashboards and actions.           |
| `shared`     | `/shared`      | Constants, logger, error classes, zod schemas, DB types.     |
| `db`         | `/db`          | `schema.sql` + migrations.                                   |

### Data flow — a `restart <group>` from Telegram

1. User sends `/restart payment` to the bot.
2. Bot calls `POST /api/groups/payment/actions/restart` with its API token.
3. Controller validates RBAC, writes an `audit_logs` row (`queued`), and
   enqueues one BullMQ job **per application** in the group.
4. The BullMQ worker pops each job, resolves the target server, and sends a
   typed `execute` frame over the agent's WebSocket connection.
5. The agent runs the whitelisted command, streams stdout/stderr back, and
   emits `job:update` events.
6. Worker records the final result in `jobs` + appends output to `audit_logs`.
7. All subscribed WS clients (web dashboard) see the status change in
   real-time; the bot polls `GET /api/jobs/:id` until terminal.

### Build-once-deploy-many (`build_strategy`)

Each application declares **where** it is built via
`applications.build_strategy`:

- `target` (default, legacy) — the agent on the target server does the
  full pull + install + build + restart in-place.
- `controller` — the controller host clones, builds, packs a content-
  addressed `tar.gz` artifact under `ARTIFACT_STORE_DIR/<appId>/<sha256>.tar.gz`,
  then copies the artifact to the target(s) and the agent just stages it
  into `<remote_install_path>/releases/<release_id>/`, swaps the
  `current` symlink atomically, and restarts. Target servers don't need
  Maven/JDK/Node build toolchain — only the runtime.
- `builder` — reserved for a future dedicated builder pool.

Artifacts are **deduped** by `(application_id, sha256)` and by
`(application_id, commit_sha, config_hash)` where `config_hash` is the
sha256 of `install_cmd | build_cmd | artifact_pattern` — rebuilding is
skipped if the same commit with the same build config already produced
an artifact.

### Artifact transfer (`servers.artifact_transfer`)

Per-server choice of how artifacts reach the target:

- `http` (default) — the agent pulls via a signed, short-lived URL
  against the controller's `GET /artifacts/:id/blob?token=…` endpoint.
  Token is HMAC-signed with `ARTIFACT_SIGNING_SECRET` (independent from
  the API token, rotatable). Works through the existing WS agent.
- `rsync` — the controller pushes the unpacked artifact to the target
  over `rsync -e ssh` directly into `<remote_install_path>/releases/<id>/`,
  using the SSH config on the `servers` row. The agent receives a
  `prestagedPath` reference and skips the download. Useful when the
  target has no outbound connectivity to the controller, or for
  incremental delta transfer on large artifacts.

Atomic release swap on the target:

```
<remote_install_path>/
  releases/
    1713400000-abc1234/   ← just-staged
    1713300000-def5678/   ← previous (kept for rollback)
  current → releases/1713400000-abc1234   (symlink, atomically renamed)
```

Retention keeps the most recent `RELEASE_RETENTION_COUNT` releases;
older directories are garbage-collected.

### Launch mode (`launch_mode`)

How `start`/`stop`/`status` actually run on the target:

- `wrapped` (default) — you write only `start_cmd`; the agent wraps it
  in `setsid nohup … & echo $! > .cp/pid`, which survives SSH
  disconnect. Stop/status are synthesized from the PID file with
  SIGTERM → SIGKILL grace.
- `raw` — you provide all of `start_cmd`, `stop_cmd`, `status_cmd`, and
  optionally `logs_cmd`. Contract: `start_cmd` must self-detach;
  `stop_cmd` must be idempotent; `status_cmd` exits 0 iff running.
  Use this for `mvn exec:java`, `pm2`, custom scripts, etc.
- `pm2`, `systemd` — reserved shortcuts for future wiring.

### Reliability model

- **Every action** is a BullMQ job. No action bypasses the queue.
- Jobs are **retried on transient failures only** (see
  `shared/src/errors.js` — `TransientError` vs `PermanentError`).
  Config/syntax errors fail fast.
- Exponential backoff with jitter, max attempts configurable per job type.
- Idempotency key = `(app_id, action, dedupe_window)` prevents double-execution
  of the same restart triggered twice within N seconds.
- Agents auto-reconnect with backoff; in-flight jobs are nacked by the
  controller on disconnect and re-queued.
- Heartbeats every 10s; missed 3 heartbeats → server marked `unreachable`.

### Security model

- Agents authenticate to the controller with a per-server bearer token
  (`servers.auth_token`, stored hashed).
- The controller never executes raw shell input. Each job type maps to a
  **whitelisted command template** on the agent side.
- All critical endpoints are rate-limited.
- Audit trail is append-only: who, what, when, target, result, log snippet.

---

## Project structure

```
/
├── controller/      REST + WS + orchestrator + BullMQ worker
├── agent/           Per-server executor + WS client
├── queue/           BullMQ wrappers (queues, producers, job schemas)
├── bot/             Telegram bot (thin client over Controller API)
├── web/             Static SPA + WS client
├── shared/          Constants, logger, errors, zod schemas
├── db/
│   ├── schema.sql   Full MySQL schema with indexes & FKs
│   └── migrations/
├── examples/
│   └── apps.example.json
├── docker-compose.yml   MySQL 8 + Redis 7 for local dev
├── .env.example
└── package.json     npm workspaces
```

---

## Quick start (local)

```bash
cp .env.example .env
docker compose up -d            # MySQL + Redis
npm install                     # installs all workspaces
npm run db:init                 # applies db/schema.sql
npm run dev:controller          # starts controller
npm run dev:agent               # starts a local agent
npm run dev:bot                 # starts telegram bot (needs TELEGRAM_TOKEN)
```

---

## Implementation status

- [x] Step 1 — Architecture, project skeleton, data models (`shared/`, `db/schema.sql`)
- [x] Step 2 — Queue system (`queue/`)
- [x] Step 3 — Agent
- [x] Step 4 — Controller (API, WS hub, orchestrator, worker)
- [x] Step 5 — Logging + audit pipeline (request-id correlation, `/api/metrics`)
- [x] Step 6 — Telegram bot
- [x] Step 7 — Web dashboard
