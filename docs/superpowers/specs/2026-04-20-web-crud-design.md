# Web CRUD for applications / groups / servers

Date: 2026-04-20
Status: design approved

## Motivation

Today there is no UI or REST path to create/edit/delete apps, groups, or servers. The only way to populate the control plane is to run SQL against MySQL directly. This makes onboarding a new target server or a new managed process unnecessarily manual and error-prone. The Telegram bot never had CRUD — it is read + action-trigger only — so "move CRUD from Telegram to web" is really "add CRUD to web for the first time."

This spec adds full CRUD to the web dashboard for the three metadata tables users actually edit: `applications`, `groups`, `servers`. The Telegram bot stays unchanged.

## Scope

In scope:

- REST endpoints under `/api/*` for create / update / delete of applications, groups, servers.
- Server token provisioning and rotation.
- Web SPA: new tabs, modal-based forms, delete flows.
- Audit-log entries for every mutation.
- Zod schema validation in `shared/`.
- Repository methods for insert/update/delete.
- A smoke-test bash script exercising the new endpoints end-to-end.

Out of scope:

- Multi-user auth / RBAC. Dashboard stays single-user (one bcrypt password). Actor for every write is `"web"`.
- Telegram bot changes.
- A real test runner / CI wiring. Manual checklist + smoke script only.
- Schema migration. All columns, enums, FKs already exist.
- Bulk import/export.
- `api_tokens` table UI (table exists but is unused; keep as-is).

## Policy summary (approved)

| Entity | Delete | Block conditions | Cascade |
|---|---|---|---|
| application | hard | `enabled=1` OR `process_state != 'stopped'` | artifacts + deployments CASCADE (data loss — UI must warn) |
| server | hard | any `applications` row references it | — |
| group | hard | none | `applications.group_id` → NULL (FK SET NULL) |

**Edit policy**: every field editable except `application.server_id` (treated as migrate = delete + create). If app is running, UI shows banner "Changes apply after next restart."

**`trusted` flag**: visible in form, gated. When `trusted=1`, the seven command fields (`install_cmd`, `build_cmd`, `start_cmd`, `stop_cmd`, `status_cmd`, `logs_cmd`, `health_cmd`) render as free-form `<textarea>`; otherwise they render as template dropdowns. Toggling `trusted` requires a confirm and writes audit `app.trusted.toggle`.

**Server provisioning**: controller generates raw token via `crypto.randomBytes(32).toString('base64url')`, stores only SHA-256 (`auth_token_hash`), returns raw token once in the response body. Frontend displays it in a dismiss-once modal with a copy button and a ready-to-paste `AGENT_CONTROLLER_TOKEN=… npm run dev:agent` snippet. A **Rotate token** action regenerates and returns the new raw token the same way, and disconnects the currently-connected agent so it reconnects with the new token.

## Architecture

### REST API

New router `crudRouter()` in `controller/src/api/routes/crud.js`, mounted under `/api` alongside the existing `readRouter`. All endpoints require `requireAuth` (session cookie OR bearer).

| Method | Path | Body | Success | Error paths |
|---|---|---|---|---|
| POST | `/api/applications` | `AppCreate` | 201 + full row | 400 validation, 409 duplicate name on server |
| PATCH | `/api/applications/:id` | `AppUpdate` (partial) | 200 + full row | 400 validation, 404, 409 if attempting `server_id` change |
| DELETE | `/api/applications/:id` | — | 204 | 404, 409 if `enabled=1` or `process_state != 'stopped'` |
| POST | `/api/groups` | `GroupCreate` | 201 | 400, 409 duplicate |
| PATCH | `/api/groups/:id` | `GroupUpdate` | 200 | 400, 404 |
| DELETE | `/api/groups/:id` | — | 204 | 404 |
| POST | `/api/servers` | `ServerCreate` | 201 + `{ server, rawToken }` | 400, 409 duplicate name |
| PATCH | `/api/servers/:id` | `ServerUpdate` | 200 | 400, 404 |
| POST | `/api/servers/:id/rotate-token` | — | 200 + `{ rawToken }` | 404 |
| DELETE | `/api/servers/:id` | — | 204 | 404, 409 if apps reference it |

### Validation

Zod schemas live in `shared/src/schemas.js` (new additions, alongside existing `WsExecute` etc.):

- `AppCreate` — strict, required: `name`, `server_id`, `runtime`, `workdir`, `start_cmd`. Everything else optional.
- `AppUpdate` — partial of `AppCreate`, minus `server_id`.
- `GroupCreate`, `GroupUpdate` — `{ name, description? }`.
- `ServerCreate` — required: `name`, `hostname`, `artifact_transfer`. Optional `labels`, `ssh_config`.
- `ServerUpdate` — partial, excludes `auth_token_hash`, `status`, `last_seen_at`.

Field constraints:

- `name`: `^[a-z0-9-]{1,64}$`.
- `workdir`, `remote_install_path`: `^/[\w\-./]+$` (absolute, no `..`, no whitespace / shell chars).
- `env`: JSON object; keys match `^[A-Z_][A-Z0-9_]*$`; values are strings; total stringified size < 32 KB.
- `start_cmd` and the other six command fields: free text when `trusted=1`. When `trusted=0` the backend accepts any string (the agent enforces the template whitelist; controller does not re-enforce).
- `runtime`, `build_strategy`, `launch_mode`, `artifact_transfer`: match existing MySQL ENUMs (source of truth: `shared/src/constants.js`).

### Errors

`ControlPlaneError` subclasses used:

- `ValidationError` (existing) → 400
- `NotFoundError` (existing) → 404
- `ConflictError` (new, add to `shared/src/errors.js`) → 409

`controller/src/api/middleware/errorHandler.js` needs one-line extension to map `ConflictError` → 409.

### Repository layer

Add to `controller/src/db/repositories.js`:

**`applications`**

- `create(row, c)` — INSERT with all known columns, returns full row via `applications.get(insertId)`.
- `update(id, patch, c)` — dynamic UPDATE; allowed fields whitelisted in a module-level constant `APP_EDITABLE_FIELDS` (excludes `id`, `server_id`, `created_at`, `updated_at`, and all runtime-state columns: `process_state`, `pid`, `last_started_at`, `last_exit_code`, `last_exit_at`, `uptime_seconds`). Returns full row.
- `delete(id, c)` — transaction: `SELECT ... FOR UPDATE`; if `enabled != 0` or `process_state != 'stopped'`, throw `ConflictError`; else `DELETE FROM applications WHERE id = ?`.
- `countByServerId(serverId, c)` — `SELECT COUNT(*)`, used by server delete.

**`groups`**

- `get(id, c)`, `create(row, c)`, `update(id, patch, c)`, `delete(id, c)`.

**`servers`**

- `create({ row, tokenHash }, c)` — INSERT, `row` excludes raw token.
- `update(id, patch, c)` — dynamic UPDATE with whitelist `SERVER_EDITABLE_FIELDS` (excludes `auth_token_hash`, `status`, `last_seen_at`, `agent_version`).
- `rotateToken(id, tokenHash, c)`.
- `delete(id, c)` — pre-check `applications.countByServerId() === 0`; DELETE.

Dynamic `UPDATE` builder:

```js
function buildUpdate(table, id, patch, allowed) {
  const fields = Object.keys(patch).filter(k => allowed.has(k));
  if (fields.length === 0) return null;
  const set = fields.map(f => `${f} = :${f}`).join(', ');
  return {
    sql: `UPDATE ${table} SET ${set} WHERE id = :id`,
    params: { id, ...Object.fromEntries(fields.map(f => [f, patch[f]])) },
  };
}
```

Field names come from the whitelist constant, never from request body keys directly — prevents column injection.

### Audit

Every mutation writes one `audit_logs` row via a new helper `audit.record({ actor, action, targetType, targetId, result, metadata })` that wraps the existing `audit.insert`. Route handlers do not write to `audit_logs` directly.

Action names:

- `app.create`, `app.update`, `app.delete`, `app.trusted.toggle`
- `group.create`, `group.update`, `group.delete`
- `server.create`, `server.update`, `server.delete`, `server.rotate-token`

`metadata` contains a diff of edited field **names** (never values). For `env`, log key names + count + total size; never the values. Raw tokens are never logged.

### Token rotation + WS disconnect

After `servers.rotateToken`, the route handler calls `wsHub.disconnectServer(serverId, 'token-rotated')`. New method on `WsHub`:

```js
disconnectServer(serverId, reason) {
  const socket = this.byServerId.get(serverId);
  if (socket) socket.close(4001, reason);
}
```

The agent's reconnect loop will re-attempt with whatever token is in its env; the operator is responsible for updating the agent's `AGENT_CONTROLLER_TOKEN` and restarting it.

### Web SPA

Module split in `controller/public/`:

- `app.js` — entry, state, WS connection, refresh loop (existing, slimmed).
- `api.js` — typed fetch helpers (`createApp`, `updateApp`, `deleteApp`, `rotateServerToken`, …).
- `forms/application.js`, `forms/group.js`, `forms/server.js` — build form DOM, collect values, call api.
- `ui/modal.js` — generic modal (backdrop, Esc-close, form-container, action buttons).
- `ui/table.js` — shared row/cell helpers.

Use ESM via `<script type="module">` in `index.html`.

**Tabs:** existing (Apps, Jobs, Audit) + new **Groups**, **Servers**. Each new tab is a table with a `+ New` button and per-row `Edit` / `Delete`.

**Apps tab:** add a `+ New App` button; extend each row with `Edit` and `Delete` buttons. `Edit` opens a modal with the application form.

**Application form (single long form, collapsible sections):**

1. **Basics** — name, server (select), group (select, nullable), runtime.
2. **Git** — repo_url, branch.
3. **Build** — build_strategy, install_cmd, build_cmd, artifact_pattern, remote_install_path, builder_server_id.
4. **Run** — launch_mode, workdir, start_cmd, stop_cmd, status_cmd, logs_cmd, health_cmd, env.
5. **Advanced** (collapsed by default) — `trusted` toggle, `enabled` toggle.

Form behaviour:

- `runtime` change fills empty defaults:
  - `node`: `install_cmd='npm ci'`, `build_cmd='npm run build'`, `start_cmd='node dist/index.js'`, `launch_mode='wrapped'`.
  - `java`: `build_cmd='mvn -B package'`, `artifact_pattern='target/*.jar'`, `start_cmd='java -jar <artifact>'`.
- `trusted` toggle swaps the seven command fields between `<select>` (templates) and `<textarea>` (free-form). Toggling on requires `confirm("This grants arbitrary command execution on the target server. Continue?")`.
- Edit mode: if `process_state !== 'stopped'`, show a yellow banner "Changes apply after next restart." `server_id` field disabled.
- Delete: a two-step confirm naming the number of artifacts and deployments that will be cascade-deleted.

**Group form:** name + description.

**Server form:** name, hostname, artifact_transfer (select), labels (key/value pairs → JSON), ssh_config (collapsed JSON textarea when `artifact_transfer=rsync`).

**Server create response handler:** on 201, open a dismiss-once modal showing the raw token, a copy button, and a ready-to-paste command block:

```
AGENT_SERVER_NAME=<name> AGENT_CONTROLLER_TOKEN=<raw> npm run dev:agent
```

The modal has a single dismiss button that refreshes the server list.

**Rotate-token button** on each server row reuses the same dismiss-once modal.

## Security & edge cases

- **Path sanitization**: `workdir`, `remote_install_path` constrained to absolute paths without `..` or shell metachars.
- **Env scrubbing in audit**: only keys + count + total size go into `audit_logs.metadata`; values never logged. Raw tokens never logged anywhere.
- **Race: delete + concurrent job.** Between user clicking Delete and DELETE executing, a restart job may be in flight. The `process_state='stopped'` check at DELETE is best-effort. If DELETE wins, an in-flight job will fail when the agent reports results for an `application_id` that no longer exists. Tolerated; the mismatch is recorded as audit `app.delete.race-detected`.
- **Race: rotate-token + live agent.** `UPDATE` changes the hash but the current WS socket stays open (HELLO is verified only at connect). Fix: after UPDATE, call `wsHub.disconnectServer(id, 'token-rotated')`.
- **Column injection**: impossible — UPDATE builder takes field names from a module-level whitelist constant, never from request body keys.
- **Trusted mode on controller**: controller accepts any string in command fields when `trusted=1`. The actual enforcement lives in the agent (`agent/src/commandWhitelist.js`); trusted apps bypass it there by design. This spec does not change agent behavior.

## Testing

No test runner is wired up in this repo, and adding one is out of scope. Verification is manual:

1. **Smoke script** `scripts/smoke-crud.sh` (new). Uses `curl` + `jq` with `CONTROLLER_API_TOKENS` bearer. Sequence:
   - POST `/api/servers` → capture `rawToken`, assert non-empty.
   - POST `/api/groups` with `name: 'smoke'`.
   - POST `/api/applications` with the new server + group.
   - PATCH app (change `branch`), assert 200 and new value visible in GET.
   - DELETE app while `enabled=1` → assert 409.
   - PATCH app `{ enabled: 0 }`; app is `process_state='unknown'` in DB (no agent connected) → DELETE still blocked. Script forces `UPDATE applications SET process_state='stopped' WHERE id=?` via a direct `mysql` call, then DELETE → assert 204.
   - DELETE server with no apps → assert 204.
   - DELETE group → assert 204.
2. **Manual UI checklist** (document in `docs/superpowers/specs/` next to this file, filled during QA):
   - Create app via form with runtime=node; defaults populate.
   - Toggle `trusted`; command fields switch to textarea; warning shown.
   - Edit running app; banner shown; `server_id` disabled.
   - Delete running app; rejected with clear message.
   - Rotate server token; agent socket closes within 1s; new raw token shown once.
   - Delete server with app; rejected; error lists referencing app names.
   - Delete group with apps; succeeds; apps show no group.

## Rollout

- No schema migration. No config change.
- Deploy = restart controller. Existing UI keeps working during rollout because read endpoints are unchanged.
- Backward compatibility: `GET /api/applications` response shape unchanged. External scripts using the bearer-token API path are unaffected.

## Implementation ordering (handed to writing-plans)

1. Shared: add `ConflictError`; add zod schemas for create/update payloads.
2. Repositories: `applications.create/update/delete/countByServerId`, `groups.{get,create,update,delete}`, `servers.{create,update,rotateToken,delete}`, and `audit.record` wrapper.
3. Error handler: map `ConflictError` → 409.
4. REST routes: new `crudRouter` wired into `server.js`.
5. `WsHub.disconnectServer` + hook it from the rotate-token route.
6. SPA: module split (`ui/modal.js`, `ui/table.js`, `api.js`).
7. SPA: Groups tab + form (simplest, proves the pattern).
8. SPA: Servers tab + form + token-reveal modal + Rotate button.
9. SPA: Apps tab actions + application form (biggest step).
10. `scripts/smoke-crud.sh` and run it end-to-end against a local controller.
