# Collapse `bot` and `web` into the controller process

**Date:** 2026-04-19
**Status:** Approved (pending implementation plan)

## Goal

Reduce the system from four processes to two: **controller** (host for everything) and **agent** (still deployed per target server). Drop the `bot` and `web` workspaces entirely. Browser talks same-origin with the controller; Telegram bot polling runs in-process inside the controller.

Motivation: the operator runs ~5 servers with a single dashboard user. Three local processes (`controller`, `bot`, `web`) plus the cross-process auth dance (web proxy injecting bearer tokens) is overhead without payoff at this scale.

## Non-goals

- Touching the `agent` (stays a separate process on each target server).
- Touching the four named in-process queues, the orchestrator, the build/deploy split, or the WS `/agent` protocol.
- Multi-user dashboard auth, RBAC, or per-user audit attribution. Single shared password is sufficient now; revisit if/when needed.
- Replacing or extending the existing `API_TOKENS` bearer model (kept for external scripts/CLI).

## Architecture after collapse

Two processes:

- **controller** (port 8080) — REST API + WS hub (`/agent`, `/ui`) + 4 in-process workers + DB pool + **SPA static assets** + **Telegram bot polling** (started only when `TELEGRAM_TOKEN` is set).
- **agent** — unchanged; same WS protocol, same provisioning flow.

Removed: the `web` Express proxy, the `bot` standalone process, and the `WEB_CONTROLLER_TOKEN` / `TELEGRAM_CONTROLLER_URL` plumbing that connected them back to the controller over HTTP.

## Auth model

The "browser never holds an API token" model is replaced with a **server-side cookie session**.

### Login flow

- New env vars in root `.env`:
  - `DASHBOARD_PASSWORD_HASH` — bcrypt hash of the operator's dashboard password.
  - `SESSION_SECRET` — 32-byte hex, used to sign the session cookie.
- Helper script: `npm run dashboard:hash` reads a password from stdin and prints the bcrypt hash to paste into `.env`.
- New endpoints:
  - `POST /auth/login` — body `{ password }`. Compares against `DASHBOARD_PASSWORD_HASH` with `bcrypt.compare`. On success, sets cookie `cp_session` (`HttpOnly`, `SameSite=Lax`, `Secure` in production, signed with `SESSION_SECRET`, TTL 7 days). On failure, 401.
  - `POST /auth/logout` — clears cookie.
  - `GET /auth/me` — returns `{ authenticated: true }` if cookie valid, else 401. SPA uses this on bootstrap to decide whether to show login screen.

### API middleware

`requireAuth` accepts **either**:

1. `Authorization: Bearer <token>` matching `API_TOKENS` (existing behavior, preserved for external scripts and CLI).
2. A valid signed `cp_session` cookie.

Either path passes. Both paths populate the same `req.actor` shape used by `audit_logs`. Cookie-authenticated actors are recorded as `actor = "web"` (no per-user identity in this design).

### WS `/ui`

Currently unauthenticated (gated at the network layer). After collapse, the WS upgrade handler verifies `cp_session` on the upgrade request; rejects with 401 if missing or invalid. WS `/agent` is unchanged (HELLO + bearer hash).

### Telegram bot

Runs in-process inside the controller. Calls API handlers as direct function calls (no HTTP, no bearer token). Identity in `audit_logs` continues to be `telegram:<chat_id>`.

## File layout changes

### Removed

- `bot/` workspace — entire directory.
- `web/` workspace — entire directory (including `web/src/server.js`, the proxy that no longer has a job).
- `bot/src/controllerClient.js` — the HTTP wrapper is replaced by direct in-process calls.
- Root `package.json`: `bot` and `web` removed from `workspaces[]`. `dev:bot` and `dev:web` removed from `scripts`.

### Moved

| From | To |
|---|---|
| `bot/src/format.js` | `controller/src/bot/format.js` |
| `bot/src/index.js` | `controller/src/bot/start.js` (refactored — see below) |
| `web/src/public/*` | `controller/public/*` |

### Added (controller/)

- `controller/src/auth/session.js` — sign/verify the `cp_session` cookie; bcrypt password comparison.
- `controller/src/api/authRoutes.js` — `/auth/login`, `/auth/logout`, `/auth/me`.
- `controller/src/api/middleware/requireAuth.js` — accepts Bearer **or** cookie; sets `req.actor`.
- `controller/src/bot/start.js` — exports `startBot({ apiHandlers, logger })`. No-op if `TELEGRAM_TOKEN` is missing. Calls handlers directly instead of going through `ControllerClient`.
- `scripts/hash-password.js` — bcrypt hashing helper.

### Modified

- `controller/src/index.js` — after `startWorkers(...)`:
  1. Mount `cookie-parser` middleware.
  2. Mount `/auth/*` routes (no auth required on these).
  3. Mount `/api/*` with `requireAuth`.
  4. Mount `express.static(controller/public)` for the SPA.
  5. Call `startBot({ apiHandlers, logger })`.
  6. Add bot shutdown to the existing `shutdown(signal)` handler.
- `controller/src/api/server.js` — wire `requireAuth` onto `/api/*`.
- `controller/src/ws/hub.js` — verify `cp_session` cookie on `/ui` upgrade; reject 401 otherwise. `/agent` unchanged.
- `controller/package.json` — add `bcryptjs`, `cookie-signature`, and `cookie` deps.
- `controller/src/bot/start.js` (refactor of `bot/src/index.js`):
  - Export a function instead of running at module top level.
  - Drop `node-telegram-bot-api` SIGINT/SIGTERM handlers (controller's `shutdown` owns this).
  - Replace `ControllerClient` calls with direct calls to API handler functions.
  - Drop `TELEGRAM_CONTROLLER_URL` / `TELEGRAM_CONTROLLER_TOKEN` env reads.

### SPA bootstrap

The previous `web/src/server.js` injected `controllerWs` into `bootstrap.js` because the SPA was served from a different origin than the controller. After collapse it's same-origin: the dynamic `/bootstrap.js` route is removed entirely, and the SPA derives its WS URL from `location.host` plus a hardcoded `/ui` path in its own JS. One less moving part.

## Environment variables

### Removed from `.env.example`

- `WEB_PORT`
- `WEB_CONTROLLER_TOKEN`
- `TELEGRAM_CONTROLLER_URL`
- `TELEGRAM_CONTROLLER_TOKEN`
- `CONTROLLER_WS_PUBLIC_URL`

### Added

- `DASHBOARD_PASSWORD_HASH` — bcrypt hash; required for dashboard login. If empty, `/auth/login` returns 503 and the SPA shows a setup hint.
- `SESSION_SECRET` — required when `DASHBOARD_PASSWORD_HASH` is set. Random 32-byte hex; controller fails fast at boot if missing or shorter than 32 bytes.

### Behavior change

- `TELEGRAM_TOKEN` is now optional. When unset, `startBot` logs `bot:disabled` and returns; controller boots normally. When set, `TELEGRAM_ADMIN_CHAT_IDS` continues to gate destructive commands.
- `API_TOKENS` is unchanged — still accepted by `requireAuth` for external scripts.

## Dev workflow

Old:
```
npm run dev:controller
npm run dev:agent
npm run dev:bot
npm run dev:web
```

New:
```
npm run dev:controller   # REST + WS + 4 workers + SPA + Telegram bot (if TELEGRAM_TOKEN set)
npm run dev:agent
```

Plus: `npm run dashboard:hash` for setting up the dashboard password.

## Documentation updates

`CLAUDE.md` is updated to reflect the new architecture:

- **Common commands** — drop `dev:bot`/`dev:web`, add `dashboard:hash`.
- **Workspace layout** — drop `bot/` and `web/` entries; note that the Telegram bot lives at `controller/src/bot/` and SPA assets at `controller/public/`.
- **Architecture invariants** — no change (the queue/orchestrator/agent invariants are unaffected).
- **Web token handling** — replace with: "Dashboard auth is a single-password cookie session. `requireAuth` accepts Bearer (for scripts) or `cp_session` cookie (for browser). WS `/ui` upgrade is gated by the same cookie."
- **Telegram bot scope** — note that the bot now runs in-process and calls API handlers directly; the "no DB or agent access" rule is preserved by routing all bot actions through the same handler functions used by REST.

## Risk and rollback

- **Single-process blast radius.** A crash in the bot or the auth layer takes the controller down. Mitigation: the bot runs inside its own try/catch wrapper at startup; bcrypt and cookie verification are isolated and well-tested libraries.
- **Session secret rotation invalidates all sessions.** Acceptable — operator simply re-logs in.
- **No rollback plan beyond `git revert`.** This is a refactor of a small system with no production tenants beyond the operator; staged rollout is overkill.

## Out of scope (explicitly deferred)

- CSRF tokens on `/auth/login` and `/api/*` mutations. Cookie is `SameSite=Lax`, which prevents the common cross-site form submission vector. Add full CSRF protection when/if the dashboard is ever exposed to untrusted browsers or third-party origins.
- Rate limiting on `/auth/login`. Add if brute-force becomes a concern; not pressing for a single-user, network-restricted dashboard.
- Per-user audit attribution from the dashboard. Requires multi-user model (B2 from brainstorming); revisit when needed.
