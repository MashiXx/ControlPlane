# ControlPlane

A small distributed process management system for Node.js and Java
applications across a handful of remote servers.

Reliability, observability, and operational safety are first-class concerns.
All actions are queued, retried with backoff, and audited to a database.

---

## Architecture

```
                            ┌──────────────────┐    ┌────────────┐
                            │  Browser         │    │  MySQL     │
                            │  Dashboard SPA   │    │ (state,    │
                            └────────┬─────────┘    │  audit)    │
                                     │ same-origin   └─────▲──────┘
                              REST + WS + cookie           │
                                     │                     │
                                     ▼                     │
 ┌──────────────────────────────────────────────────────────┴──────┐
 │  Controller (single process)                                    │
 │                                                                 │
 │  - HTTP server: REST API + cookie-session auth + SPA static     │
 │  - WS hub: /agent (bearer-hash) + /ui (cookie-gated)            │
 │  - Orchestrator + 4 in-process workers                          │
 │  - Controller-side artifact builder + artifact store            │
 │  - Telegram bot polling (in-process; opt-in via TELEGRAM_TOKEN) │
 │  - Audit sink                                                   │
 └──┬─────────────┬────────────────────────────────────────────────┘
    │             │
    │  WebSocket  │  (bidirectional, heartbeat)
    │             │
    ▼             ▼
 ┌────────────┐ ┌────────────┐
 │  Agent     │ │  Agent     │
 │  server-A  │ │  server-N  │
 │ - executor │ │ - executor │
 │ - pm       │ │ - pm       │
 │ - health   │ │ - health   │
 └────────────┘ └────────────┘
```

The system runs as **two processes**: one `controller` (which hosts everything
except the agent) and one `agent` per managed target server.

### Components

| Component    | Path           | Responsibility                                                    |
| ------------ | -------------- | ----------------------------------------------------------------- |
| `controller` | `/controller`  | REST + WS API, orchestrator, in-process job worker, controller-side artifact builder, dashboard SPA static (`controller/public/`), in-process Telegram bot (`controller/src/bot/`), audit sink. |
| `agent`      | `/agent`       | Runs on each target server. Holds the WS to the controller, executes whitelisted commands, manages process lifecycle. |
| `queue`      | `/queue`       | In-process queue/producer/worker primitives shared by everyone.   |
| `shared`     | `/shared`      | Constants (enums), logger, error taxonomy, zod schemas, id helpers. |
| `db`         | `/db`          | `schema.sql` + migrations.                                        |

### Data flow — a `restart <group>` from Telegram

1. User sends `/restart payment` to the bot.
2. The bot (in-process inside the controller) calls `BotApi.enqueue(...)`,
   which delegates to the orchestrator's `submitAction` directly — no HTTP
   loopback, no bearer token.
3. Orchestrator validates input, writes an `audit_logs` row (`actor =
   telegram:<chat_id>`, result `info`), and enqueues one in-process job
   **per application** in the group.
4. The in-process worker for `cp:restart` pops each job, resolves the
   target server, and sends a typed `EXECUTE` frame over the agent's
   WebSocket connection.
5. The agent runs the whitelisted command, streams stdout/stderr back,
   and emits `JOB_UPDATE` / `JOB_RESULT` frames.
6. Worker records the final result in `jobs` + appends output to
   `audit_logs`.
7. All subscribed WS `/ui` clients (browser dashboard) see the status
   change in real-time. The bot polls the `jobs` repository in-process
   for terminal status.

The same flow from the **browser dashboard** differs only in step 1–3:
the browser POSTs `/api/actions` with its `cp_session` cookie, which
`requireAuth` accepts; `submitAction` is then invoked from the request
handler. Audit `actor = "web"`.

The same flow from a **CI script / CLI** differs only in step 1–3:
the script POSTs `/api/actions` with `Authorization: Bearer <token>`
matching `CONTROLLER_API_TOKENS`. Audit `actor = "api:<token-name>"`.

In every case, `submitAction` is the single chokepoint and the queue
guarantees apply.

### Build-once-deploy-many (`build_strategy`)

Each application declares **where** it is built via
`applications.build_strategy`:

- `target` (default, legacy) — the agent on the target server does the
  full pull + install + build + restart in-place.
- `controller` — the controller host clones, builds, packs a
  content-addressed `tar.gz` artifact under
  `ARTIFACT_STORE_DIR/<appId>/<sha256>.tar.gz`, then transfers the
  artifact to the target(s) (see `artifact_transfer` below) and the
  agent stages it into `<remote_install_path>/releases/<release_id>/`,
  swaps the `current` symlink atomically, and restarts. Target servers
  don't need Maven/JDK/Node build toolchain — only the runtime.
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
  the API token, rotatable).
- `rsync` — the controller pushes the unpacked artifact to the target
  over `rsync -e ssh` directly into `<remote_install_path>/releases/<id>/`,
  using the SSH config on the `servers` row. The agent receives a
  `prestagedPath` reference and skips the download.

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
- `pm2`, `systemd` — reserved shortcuts for future wiring.

### Reliability model

- **Every action** is a queued job. No action bypasses the orchestrator's
  `submitAction` chokepoint.
- The queue is **in-process** (in `queue/`, mounted inside the controller).
  Restarting the controller drops anything not yet picked up — intentional
  trade-off vs. a broker like Redis. Four named queues:
  `cp:restart`, `cp:build`, `cp:deploy`, `cp:system`.
- Jobs are **retried on transient failures only** (see
  `shared/src/errors.js` — `TransientError` vs `PermanentError`).
  Validation, auth, and "command not whitelisted" fail fast.
- Exponential backoff with jitter, max attempts configurable per job type.
- **Idempotency window**: `(action, target, time_bucket)` produces the
  same `jobs.idempotency_key`; a duplicate request inside
  `IDEMPOTENCY_WINDOW_MS` (5s) returns the existing job rather than
  creating a new one.
- Agents auto-reconnect with backoff; in-flight jobs are nacked by the
  controller on disconnect (`AgentUnavailableError`, transient → retried).
- Heartbeats every 10s; missed 3 heartbeats → server marked `unreachable`.

### Security model

- **Agent → controller**: per-server bearer token (`servers.auth_token`,
  stored hashed as SHA-256). Raw token shown to the operator once at
  provisioning.
- **External scripts → controller `/api/*`**: bearer tokens listed in
  `CONTROLLER_API_TOKENS` env (`name:token,name:token`). The
  `requireAuth` middleware accepts these.
- **Browser → controller**: single shared password set as
  `DASHBOARD_PASSWORD_HASH` (bcrypt). `POST /auth/login` issues
  `cp_session` — an HttpOnly + SameSite=Lax cookie signed with
  `CONTROLLER_JWT_SECRET` (Secure in production). The same `requireAuth`
  middleware accepts a valid cookie *or* a bearer token.
- **WebSocket `/ui`**: gated by the same `cp_session` cookie. Upgrades
  without a valid cookie get HTTP 401.
- **Boot guard**: when `DASHBOARD_PASSWORD_HASH` is set, the controller
  refuses to start unless `CONTROLLER_JWT_SECRET` is at least 32 chars
  and not the placeholder default — prevents accidentally signing
  sessions with a guessable secret.
- The controller never executes raw shell input on a target. Each job
  type maps to a **whitelisted command template** on the agent side.
- All state-changing endpoints are rate-limited.
- Audit trail is append-only: who, what, when, target, result, log
  snippet. Actor strings: `telegram:<chat_id>`, `web`, `api:<name>`,
  `agent:<id>`.

---

## Project structure

```
/
├── controller/        REST + WS + orchestrator + in-process worker + bot + SPA
│   ├── src/
│   │   ├── api/       routes (auth, actions, read, metrics, artifacts)
│   │   ├── auth/      session.js, requireAuth.js
│   │   ├── bot/       in-process Telegram bot + BotApi adapter
│   │   ├── ws/        WS hub (/agent + /ui)
│   │   ├── workers/   in-process job workers
│   │   └── ...
│   └── public/        dashboard SPA static assets (index.html, login.html, app.js, …)
├── agent/             per-server executor + WS client
├── queue/             in-process queues, producers, workers
├── shared/            constants, logger, errors, zod schemas
├── scripts/
│   └── hash-password.js   bcrypt helper for DASHBOARD_PASSWORD_HASH
├── db/
│   ├── schema.sql     full MySQL schema with indexes & FKs
│   └── migrations/
├── docs/superpowers/  design specs + implementation plans
├── examples/          example app config
├── docker-compose.yml MySQL 8 for local dev
├── .env.example
└── package.json       npm workspaces (controller, agent, queue, shared)
```

---

## Quick start (local)

```bash
cp .env.example .env
echo -n 'your-password' | npm run dashboard:hash --silent   # paste into .env DASHBOARD_PASSWORD_HASH
# Edit .env: set CONTROLLER_JWT_SECRET to a real 32+ char secret
docker compose up -d            # MySQL (auto-applies db/schema.sql on first boot)
npm install                     # installs all workspaces
npm run db:init                 # re-apply db/schema.sql to an existing DB

npm run dev:controller          # REST + WS + workers + SPA + Telegram bot (if TELEGRAM_TOKEN set)
npm run dev:agent               # local agent that connects back to the controller
```

Dashboard: <http://127.0.0.1:8080/> — log in with the password you hashed.

External script example:

```bash
curl -H "Authorization: Bearer ci:your-token" \
     http://127.0.0.1:8080/api/applications
```

Telegram bot: leave `TELEGRAM_TOKEN` empty to disable; set it to enable
in-process polling on the next controller restart.

---

## Implementation status

- [x] Step 1 — Architecture, project skeleton, data models (`shared/`, `db/schema.sql`)
- [x] Step 2 — In-process queue (`queue/`)
- [x] Step 3 — Agent
- [x] Step 4 — Controller (API, WS hub, orchestrator, worker)
- [x] Step 5 — Logging + audit pipeline (request-id correlation, `/api/metrics`)
- [x] Step 6 — Telegram bot
- [x] Step 7 — Web dashboard
- [x] Step 8 — Build-once-deploy-many (controller-side artifact builder + transport)
- [x] Step 9 — Two-process layout (bot + SPA folded into controller; cookie-session dashboard auth)
