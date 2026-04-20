# Agentless Controller — Design

**Date:** 2026-04-20
**Status:** Approved, ready for implementation plan
**Scope:** Remove the `agent/` process entirely and drive every target-server operation from the controller over SSH. One-way transition.

## Motivation

Today ControlPlane runs as two processes — a central `controller` and a per-server `agent` that holds a WebSocket back to the controller and executes whitelisted commands locally. For small fleets this is overkill: every managed server needs the agent installed, the controller must keep a reverse WS open, and the authentication model (`servers.auth_token_hash`) is a separate secret to rotate.

We want the controller to drive every action by SSH instead — no agent process, no WebSocket reverse channel, no per-server bearer token. Operators already run ControlPlane in an environment where their SSH keys reach the managed hosts (rsync transfer already relies on this). Collapsing onto SSH removes a process, a protocol, and a column.

## Decisions

- Agentless for **all** actions (build/deploy/start/stop/restart/healthcheck/state polling).
- `build_strategy='target'` is removed. Only controller-side build remains.
- Process state is tracked by a **periodic SSH poll** in the controller (default 30 s).
- Dashboard logs: **live stream** for long actions (deploy, build); **buffered result** for short actions (start/stop/healthcheck/poll).
- SSH auth comes **entirely** from `~/.ssh/config` of the user running the controller. No SSH credentials in DB.
- `agent/` workspace is **deleted**. No compat shim.

## Architecture

```
┌──────────────── controller (single process) ────────────────┐
│                                                              │
│   REST / dashboard (/ui WS)                                  │
│                │                                             │
│         orchestrator  ──►  in-process queue                  │
│                │                                             │
│         jobWorker  ──────► remoteExec {start/stop/…/deploy}  │
│                                        │                     │
│                            ssh ◄───────┤ (buffered or        │
│                            rsync ◄─────┘  streaming child)   │
│                                                              │
│   stateScheduler (setInterval, default 30 s)                 │
│                │                                             │
│                └─► ssh probe + pid/systemd/status_cmd        │
│                     updates applications.process_state       │
│                     + servers.status                         │
└──────────────────────────────────────────────────────────────┘
                            │
                            │   SSH / rsync+SSH
                            ▼
                ┌─── managed servers ────┐
                │ ~/.ssh/config looked up │
                │ by controller only      │
                └─────────────────────────┘
```

**Key invariants kept:**

- Every user-visible action still goes through `submitAction` → queue → worker → audit log.
- In-process queue, four named queues, idempotency window, retry profile — unchanged.
- Orchestrator remains the single chokepoint.

**Key invariants removed:**

- No WS reverse channel. `/agent` endpoint, `WsHub`, `WsExecute`/`WsHello`/heartbeat schemas are gone.
- No `AgentUnavailableError`. `ssh exit 255` becomes a `TransientError` and feeds the same retry path.
- No build-on-target branch in the job worker.

## Data model (migration `db/migrations/004_agentless.sql`)

Drop:

- `servers.auth_token_hash` (agent bearer)
- `servers.agent_version`
- `servers.artifact_transfer` — artifact delivery is always rsync+ssh now; there is no HTTP pull path without an agent
- `applications.builder_server_id` and the FK (no `builder` build strategy)

Modify:

- `applications.build_strategy` enum `('target','controller','builder')` → `('controller')` only. Existing rows are first `UPDATE`d to `'controller'` (the only remaining value).
- No change to `jobs.target_type` — all four values stay in use.

`db/schema.sql` is rewritten to reflect the post-migration state. This is a one-way migration; prior agent deployments are no longer supported on this branch.

## Components

### Deleted

- `agent/` workspace (entire directory). Removed from root `package.json` `workspaces` and `dev:agent` script.
- `controller/src/ws/hub.js` — `WsHub`, `executeAndWait`, agent-session registry.
- `controller/src/transport/artifactTokens.js` + the REST route `/artifacts/:id/blob` that served signed downloads.
- `artifactTransfer.js`'s `http` branch (the file is removed entirely; `jobWorker` calls rsync directly now).
- `shared/src/schemas.js` entries: `WsHello`, `WsExecute`, `WsFromAgent`, `WsToAgent`, heartbeat frames.
- `shared/src/constants.js` — `WsOp` reduced to just the `/ui` frames the dashboard still consumes (log chunk, job update). `BuildStrategy` shrunk to `{ CONTROLLER: 'controller' }` or removed and inlined. `ArtifactTransfer` removed.
- Env vars: `ARTIFACT_SIGNING_SECRET`, `AGENT_ID`, `AGENT_SERVER_NAME`, `CONTROLLER_WS_URL`, `AGENT_AUTH_TOKEN`, `AGENT_HEARTBEAT_MS`, `AGENT_WORKDIR`.

### New

- **`controller/src/ssh/sshClient.js`** — single wrapper around `spawn('ssh', ...)`:
  - `runSsh(host, cmd, { timeoutMs, env, onChunk? })`.
  - When `onChunk` is provided, stdout/stderr stream through it (live mode); otherwise buffered (returns `{ exitCode, stdoutTail, stderrTail, durationMs }`).
  - Hardcoded options `-o BatchMode=yes -o ConnectTimeout=10`, same as today's rsync transfer.
  - Uses the existing `shellSafe` helper from `rsyncTransfer.js` (lifted into a shared util) for remote-path sanitization.
- **`controller/src/exec/remoteExec.js`** — replaces the per-action logic that previously lived in `agent/src/jobHandler.js`, but runs on the controller:
  - `startAction(app, onChunk)` — composes the wrapped / raw / systemd start on the fly; SSH executes it.
  - `stopAction(app, onChunk)`
  - `restartAction(app, onChunk)`
  - `healthcheckAction(app)`
  - `deployAction(app, artifact, releaseId, onChunk)` — orchestrates stage → rsync → symlink swap → stop → start → GC old releases.
  - All three launch modes are handled here: `wrapped` (controller synthesizes `setsid nohup … & echo $!>pid`), `systemd` (`systemctl start/stop/is-active`), `raw` (user's `start_cmd` / `stop_cmd` / `status_cmd`).
- **`controller/src/pollers/stateScheduler.js`** — single `setInterval` loop:
  - Every `STATE_POLL_INTERVAL_MS` (default `30_000`): for each non-`draining` server, run probe + per-app status.
  - Concurrency: `Promise.all` across servers (no cap in v1; add `POLL_CONCURRENCY` env if we see trouble later).
  - Writes `servers.status`, `applications.process_state`, `pid`, `last_started_at`, `uptime_seconds`.
  - Runs the existing alert-on-down comparison against `expected_state` / `last_alert_at`.

### Modified

- **`controller/src/workers/jobWorker.js`** — the "dispatch to agent" branch (`Branch 3`) is replaced by a call to the matching `remoteExec` function. The controller-build branch (`Branch 1`) is unchanged. The controller-deploy branch (`Branch 2`) becomes `deployAction(...)` directly; the intermediate `prepareArtifactForTarget` + `executeAndWait` pair is gone.
- **`controller/src/orchestrator/orchestrator.js`** — the `build_strategy === CONTROLLER` check in `enqueueOne` simplifies (only value possible). `enqueueServerGroupDeploy` keeps its current shape.
- **`controller/src/index.js`** — remove `/agent` WS upgrade handler and `WsHub` construction; remove the artifact download REST route; initialize `stateScheduler` after DB pool + queues are up.
- **`controller/public/forms/server.js`** — drop the "Artifact transfer" dropdown and the agent-token output. Add a note: "Add a matching entry in the controller's `~/.ssh/config`."
- **`controller/public/forms/application.js`** — the `build_strategy` dropdown is removed; every new app implicitly uses `controller`.
- **Root `package.json`** — remove the `agent` workspace and the `dev:agent` script.
- **`.env.example` / `.env`** — drop agent-related and artifact-signing vars; add `STATE_POLL_INTERVAL_MS=30000` (optional) and a comment pointing operators at `ControlMaster` in `~/.ssh/config`.

## Data flow

### Deploy

1. `submitAction({ action: 'deploy', target: { type: 'app', id } })`.
2. Orchestrator detects the app exists and is enabled; enqueues a **BUILD** job (all apps build on controller now). `jobs` row committed **before** the queue push (race fix already in main).
3. Build worker runs `runBuild` → content-addressed tarball under `tmp/artifacts/<appId>/<sha>.tar.gz`; enqueues one **DEPLOY** child job per target server.
4. Deploy worker calls `remoteExec.deployAction(app, artifact, releaseId, onChunk)`:
   1. Extract tarball to `tmp/staging/cp-stage-<artifactId>-<rand>/`.
   2. `ssh <host> mkdir -p <remoteInstallPath>/releases/<releaseId>/`.
   3. `rsync -az --delete staging/ <host>:<remoteInstallPath>/releases/<releaseId>/` — streaming progress to `onChunk`.
   4. `ssh <host>` swap current symlink atomically via tmp-symlink + `mv -T`.
   5. `ssh <host>` `stop_cmd` in `current/` (if present, wrapped by launch mode).
   6. `ssh <host>` `start_cmd` in `current/`, wrapping per `launch_mode`.
   7. `ssh <host>` GC old releases, keeping `RELEASE_RETENTION_COUNT` (5) newest.
   8. Remove local staging dir in `finally`.
5. Deploy worker marks `deployments.deployed`, writes audit.

Logs for steps 3–7 stream live to the dashboard. The final `jobs.result` carries the tail for post-hoc inspection.

### Start / Stop / Restart

- Orchestrator enqueues onto `cp:system` (start/stop) or `cp:restart`.
- Worker calls `remoteExec.startAction` / `stopAction` / `restartAction` — all buffered.
- `launch_mode='wrapped'` uses a PID file (`current/app.pid`); stop sends `SIGTERM`, waits up to 5 s, escalates to `SIGKILL`.
- `launch_mode='systemd'` shells out to `systemctl`.
- `launch_mode='raw'` runs the operator-supplied commands as-is (still subject to `ensureSafe` unless the app is `trusted=1`).
- `stdoutTail`, `stderrTail`, `exitCode`, `durationMs` land in `jobs.result` and `audit_logs.message`.

### Healthcheck

- `remoteExec.healthcheckAction` runs `health_cmd` via SSH in `current/`. Exit 0 → success; non-zero → `TransientError` (retried per `RETRY_HEALTHCHECK_ATTEMPTS`).

### Build

- Runs entirely on controller: `git clone --depth 50 --branch <branch> <repo_url>` into `tmp/builds/cp-build-<appId>-<rand>/`, then `install_cmd` + `build_cmd`, then glob `artifact_pattern` and pack into the artifact store. Identical to today's controller-side build.

### State polling

- `stateScheduler` wakes every `STATE_POLL_INTERVAL_MS`:
  1. For each non-`draining` server: `ssh <host> echo __cp_probe_ok__` (timeout 10 s).
     - Success → `servers.status='online'`, reset miss counter.
     - Fail → increment miss; at 3 consecutive misses mark `unreachable`.
  2. For each enabled app on online servers:
     - `wrapped`: `ssh <host> 'kill -0 $(cat <pidfile>) && ps -o etimes= -p $(cat <pidfile>)'` → alive + uptime, or stopped.
     - `systemd`: `ssh <host> systemctl is-active <unit>`.
     - `raw`: `ssh <host> <status_cmd>` (non-zero → stopped).
     - Update `applications.process_state`, `pid`, `uptime_seconds`.
  3. Alert-on-down check (existing logic) compares against `expected_state`; debounced via `last_alert_at`.

## Error handling

| Situation | Error class | Retry? |
|---|---|---|
| `ssh` exit 255 (host unreachable, DNS, key rejected) | `TransientError` | Yes (per action `RETRY_*_ATTEMPTS`); poller increments miss counter |
| `ssh exit != 0` from the remote command | `TransientError` with `meta.exitCode`, stderr tail | Yes |
| `ssh` timeout (> `timeoutMs`) | `TransientError('ssh timeout')`; child killed with SIGKILL | Yes |
| `Host key verification failed` | `PermanentError` | No — operator must fix `known_hosts` |
| `shellSafe` regex rejects a path | `PermanentError('unsafe …')` | No |
| rsync exit ≠ 0 | `TransientError` | Yes |
| App disabled, unknown action, validation failure | `PermanentError` / `ValidationError` | No |

Deploy edge cases:

- **Start fails after symlink swap** — the new release is live but not running. We leave it; the next poll reports `process_state != running`, alert-on-down pages, operator decides. No automatic rollback in v1.
- **Stale PID file** — `kill -0` fails → poll reports `stopped`. Next start overwrites the file.
- **Controller crash mid-rsync** — release dir has partial content, but `current` symlink is still pointing at the old release. Next deploy with the same `releaseId` is clean because rsync uses `--delete`. Staging dirs left behind are swept on boot (`fs.rm('tmp/staging/cp-stage-*', ...)` at controller startup).
- **Poll observes mid-deploy state** — the ~1 s window where the app is stopped between stop and start can show `stopped` in the dashboard. Alert debounce already handles this.

SSH cost:

- Each action spawns a fresh SSH process. With 30 s poll × N servers × M apps, the handshake cost can add up. We do **not** build a connection pool in controller code. Instead, the README documents a `ControlMaster auto / ControlPath / ControlPersist 10m` block for `~/.ssh/config` — OpenSSH transparently reuses connections. Zero code in controller.

## Security

- No secrets added to the DB. `~/.ssh/config` + key files on the controller host remain the only credential surface.
- Remote paths (`remote_install_path`, `releaseId`, `app.workdir`) are passed through `shellSafe` before being embedded in any SSH command string. The existing regex `/^[\w@%+=:,./-]+$/` is reused.
- `start_cmd` / `build_cmd` / `install_cmd` are still gated by `ensureSafe` (the whitelist + SUSPICIOUS regex) unless `applications.trusted = 1`, matching today's agent behavior.
- `BatchMode=yes` is hardcoded — no SSH prompt can ever block the controller.

## Verification plan

The project has no test runner yet, so verification is a manual smoke sequence. Before merging:

1. Back up the DB (`mysqldump … controlplane > backup.sql`).
2. Apply migration 004, restart controller. Boot must succeed with no reference to `WsHub`, `/agent`, or missing env.
3. Dashboard login works; server list shows servers `offline` (no poll yet).
4. After one poll interval, reachable servers flip to `online`.
5. Deploy app `naruto`:
   - WS `/ui` streams build → rsync → SSH steps.
   - `tmp/artifacts/1/<sha>.tar.gz` is created.
   - On the server, `<remote_install_path>/releases/<releaseId>/target/` is populated and `current` points at it.
   - The wrapped process is running.
6. Next poll reports `running`, with `pid` and `uptime_seconds`.
7. Stop → process dies, next poll reports `stopped`.
8. Start → back to `running`.
9. Cut the server's network: after 3 missed probes (~90 s), status becomes `unreachable` and alert-on-down fires if `expected_state = running`.
10. Restore the server; status returns to `online`.

Grep gates (must return empty):

- `WsHub`, `WsExecute`, `WsHello`, `dispatchToAgent`
- `auth_token_hash`, `agent_version`, `artifact_transfer`
- `BuildStrategy.TARGET`, `BuildStrategy.BUILDER`
- `AGENT_`, `CONTROLLER_WS_URL`, `ARTIFACT_SIGNING_SECRET` in env files and source

Rollback if smoke fails: `git reset --hard <sha>` + restore `backup.sql`. No merge until smoke passes.

## Out of scope (v1)

- Automatic rollback to the previous release on failed deploy.
- SSH connection pool inside controller code (rely on OpenSSH `ControlMaster`).
- Per-app poll interval / budget.
- `systemd`-based graceful rolling restart.
- Multi-region / ProxyJump helpers beyond whatever the user puts in `~/.ssh/config`.
