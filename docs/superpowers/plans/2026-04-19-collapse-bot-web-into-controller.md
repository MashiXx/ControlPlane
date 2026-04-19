# Collapse `bot` and `web` into the controller — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four-process layout (controller / agent / bot / web) with two processes (controller / agent). Telegram polling and SPA static serving move into the controller; browser auth changes from "proxy injects bearer" to "single-password cookie session".

**Architecture:** Controller becomes the single host for HTTP API + WS hub + workers + SPA static files + Telegram bot. Browser authenticates via a `cp_session` cookie signed with `CONTROLLER_JWT_SECRET` (already in `.env.example`). The existing bearer-token API auth continues to work for external scripts/CLI; the new `requireAuth` middleware accepts either Bearer **or** a valid session cookie. The Telegram bot calls the controller's repositories and orchestrator directly (no HTTP loopback).

**Tech Stack:** Node 20+ ESM, Express 4, `ws`, MySQL 8, `bcryptjs`, `cookie-parser`, `cookie-signature`, `node-telegram-bot-api`.

**Spec reference:** [docs/superpowers/specs/2026-04-19-collapse-bot-web-into-controller-design.md](../specs/2026-04-19-collapse-bot-web-into-controller-design.md)

---

## Notes for the implementer

- **No test runner exists in this repo** (`npm test` is a placeholder). Verification is manual: `curl`, browser DevTools, and small `node -e` smoke scripts. Each task ends with a concrete verification step before commit. Do **not** introduce a test framework as part of this work.
- **Spec said `SESSION_SECRET`** but `.env.example` already defines `CONTROLLER_JWT_SECRET` ("Secret used to sign session cookies / JWTs for human users"). Reuse `CONTROLLER_JWT_SECRET` and do not introduce a second secret. Document this in the spec follow-up section of CLAUDE.md updates (Task 23).
- **Spec said `API_TOKENS`** for the bearer env. The actual existing var is `CONTROLLER_API_TOKENS`. Use `CONTROLLER_API_TOKENS` everywhere.
- **Working directory** for all `git`/`npm`/`node` commands is the repo root: `/Users/mashi/mashicode/ControlPlane`.
- **Single-process architecture invariant** from CLAUDE.md still applies: `enqueueAction` is the single chokepoint for jobs. The bot and dashboard both still go through it.
- **Tasks are ordered to keep the system runnable after every commit.** Old `bot/` and `web/` workspaces stay alive (unused) until the final cleanup phase. `npm run dev:controller` should boot successfully after every task.

---

## File layout (target state)

**New files (under `controller/`):**

- `controller/src/auth/session.js` — sign/verify `cp_session` cookie; bcrypt password compare.
- `controller/src/auth/requireAuth.js` — middleware: Bearer OR cookie.
- `controller/src/api/routes/auth.js` — `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`.
- `controller/src/bot/format.js` — moved from `bot/src/format.js` (verbatim).
- `controller/src/bot/api.js` — in-process adapter exposing the same surface `bot/src/controllerClient.js` had, but calling repositories/orchestrator directly.
- `controller/src/bot/start.js` — `startBot({ logger })`; no-op when `TELEGRAM_TOKEN` is unset.
- `controller/public/index.html`, `controller/public/styles.css`, `controller/public/app.js`, `controller/public/login.html`, `controller/public/login.js` — SPA assets, moved from `web/src/public/` plus a tiny login page.
- `scripts/hash-password.js` — bcrypt hashing helper.

**Modified files:**

- `controller/src/index.js` — wire cookie-parser, mount `/auth/*`, mount static, swap `apiAuth` → `requireAuth`, call `startBot`, add bot to shutdown.
- `controller/src/api/server.js` — pass session-signing secret in; mount `/auth/*` before `/api/*`; swap `apiAuth` → `requireAuth`; mount `express.static` after API routes.
- `controller/src/ws/hub.js` — verify `cp_session` cookie on `/ui` upgrade; reject 401 if invalid.
- `controller/src/config.js` — add `dashboardPasswordHash` to returned config.
- `controller/package.json` — add `bcryptjs`, `cookie-parser`, `cookie-signature` deps.
- `package.json` (root) — drop `bot`/`web` from `workspaces`; drop `dev:bot`/`dev:web`; add `dashboard:hash`.
- `.env.example` — drop web/proxy vars; add `DASHBOARD_PASSWORD_HASH`; reword `CONTROLLER_JWT_SECRET` comment; mark `TELEGRAM_TOKEN` optional.
- `CLAUDE.md` — update commands/workspace/auth sections.

**Deleted (final cleanup):**

- `bot/` directory (after files are moved/superseded).
- `web/` directory (after files are moved).

---

## Phase A — Auth foundation (controller still serves only `/api`)

### Task 1: Add npm dependencies to controller

**Files:**
- Modify: `controller/package.json`

- [ ] **Step 1: Add deps to controller/package.json**

Edit `controller/package.json`. In the `"dependencies"` block, add (alphabetically placed):

```json
"bcryptjs": "^2.4.3",
"cookie-parser": "^1.4.7",
"cookie-signature": "^1.2.2",
```

- [ ] **Step 2: Install**

Run from repo root:
```bash
npm install
```

Expected: lockfile updates, no errors. `node_modules/bcryptjs`, `node_modules/cookie-parser`, `node_modules/cookie-signature` exist.

- [ ] **Step 3: Commit**

```bash
git add controller/package.json package-lock.json
git commit -m "chore(controller): add bcryptjs, cookie-parser, cookie-signature"
```

---

### Task 2: Add `dashboard:hash` helper script

**Files:**
- Create: `scripts/hash-password.js`
- Modify: `package.json` (root)

- [ ] **Step 1: Create scripts/hash-password.js**

```js
#!/usr/bin/env node
// Reads a password from stdin, prints a bcrypt hash to stdout.
// Usage:  echo -n 'mypassword' | npm run dashboard:hash --silent
//         (or run interactively and type the password + Ctrl-D)

import bcrypt from 'bcryptjs';

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const password = Buffer.concat(chunks).toString('utf8').trim();
  if (!password) {
    process.stderr.write('error: empty password\n');
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 12);
  process.stdout.write(hash + '\n');
}

main().catch((err) => {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Add npm script to root package.json**

Edit `package.json` (root). In `"scripts"`, add after `"db:init"`:

```json
"dashboard:hash": "node scripts/hash-password.js",
```

- [ ] **Step 3: Smoke test**

Run from repo root:
```bash
echo -n 'hunter2' | npm run --silent dashboard:hash
```

Expected: a single line starting with `$2a$12$` or `$2b$12$` (a bcrypt hash). No other output.

Then verify the hash is valid:
```bash
node -e "import('bcryptjs').then(({default:b})=>b.compare('hunter2', process.argv[1]).then(r=>console.log(r)))" "$(echo -n hunter2 | npm run --silent dashboard:hash)"
```

Expected: `true`.

- [ ] **Step 4: Commit**

```bash
git add scripts/hash-password.js package.json
git commit -m "feat(scripts): add dashboard:hash bcrypt helper"
```

---

### Task 3: Add session signing/verification helpers

**Files:**
- Create: `controller/src/auth/session.js`

- [ ] **Step 1: Create controller/src/auth/session.js**

```js
// Signed session cookie + bcrypt password compare.
//
// Cookie format: a base64url payload `{exp:<unix-seconds>}` joined to a
// signature with cookie-signature.sign(). Stateless — no server-side store.

import bcrypt from 'bcryptjs';
import cookieSignature from 'cookie-signature';

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const SESSION_COOKIE_NAME = 'cp_session';

/** Returns true if the password matches the bcrypt hash. */
export function verifyPassword(plain, hash) {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(String(plain ?? ''), hash);
}

/** Produce a signed cookie value carrying an expiry. */
export function issueSessionToken(secret, { ttlSeconds = SESSION_TTL_SECONDS } = {}) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return cookieSignature.sign(payload, secret);
}

/** Returns { ok: true, exp } or { ok: false, reason }. */
export function verifySessionToken(secret, signedValue) {
  if (!signedValue) return { ok: false, reason: 'missing' };
  const payload = cookieSignature.unsign(signedValue, secret);
  if (payload === false) return { ok: false, reason: 'bad-signature' };
  let parsed;
  try { parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { return { ok: false, reason: 'bad-payload' }; }
  if (typeof parsed?.exp !== 'number') return { ok: false, reason: 'bad-payload' };
  if (parsed.exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
  return { ok: true, exp: parsed.exp };
}

export const COOKIE_DEFAULTS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  maxAge: SESSION_TTL_SECONDS * 1000,
  // `secure` is set by the caller based on NODE_ENV.
};
```

- [ ] **Step 2: Smoke test**

Run from repo root:
```bash
node -e "
import('./controller/src/auth/session.js').then(async (m) => {
  const secret = 'test-secret';
  const tok = m.issueSessionToken(secret);
  console.log('issued:', tok.slice(0, 40) + '…');
  console.log('verify good:', m.verifySessionToken(secret, tok));
  console.log('verify bad-sig:', m.verifySessionToken('other-secret', tok));
  console.log('verify missing:', m.verifySessionToken(secret, ''));
  console.log('password ok:',  await m.verifyPassword('hunter2', await (await import('bcryptjs')).default.hash('hunter2', 4)));
  console.log('password bad:', await m.verifyPassword('wrong',   await (await import('bcryptjs')).default.hash('hunter2', 4)));
});
"
```

Expected output (order matters):
```
issued: <40 char prefix>…
verify good: { ok: true, exp: <number> }
verify bad-sig: { ok: false, reason: 'bad-signature' }
verify missing: { ok: false, reason: 'missing' }
password ok: true
password bad: false
```

- [ ] **Step 3: Commit**

```bash
git add controller/src/auth/session.js
git commit -m "feat(auth): add signed session cookie + bcrypt password helpers"
```

---

### Task 4: Add `requireAuth` middleware (Bearer OR cookie)

**Files:**
- Create: `controller/src/auth/requireAuth.js`

- [ ] **Step 1: Create controller/src/auth/requireAuth.js**

```js
// Auth middleware accepting EITHER:
//   - Authorization: Bearer <token> matching CONTROLLER_API_TOKENS
//   - cp_session signed cookie matching CONTROLLER_JWT_SECRET
//
// Sets req.actor:
//   - "api:<token-name>"  for bearer
//   - "web"               for cookie

import { AuthError } from '@cp/shared/errors';
import { SESSION_COOKIE_NAME, verifySessionToken } from './session.js';

export function requireAuth({ apiTokens, sessionSecret }) {
  const byToken = new Map(apiTokens.map((t) => [t.token, t.name]));

  return (req, _res, next) => {
    // 1. Bearer.
    const header = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (m) {
      const name = byToken.get(m[1]);
      if (!name) return next(new AuthError('invalid token'));
      req.actor = `api:${name}`;
      return next();
    }
    // 2. Cookie.
    const raw = req.cookies?.[SESSION_COOKIE_NAME];
    if (raw) {
      const v = verifySessionToken(sessionSecret, raw);
      if (v.ok) {
        req.actor = 'web';
        return next();
      }
    }
    return next(new AuthError('authentication required'));
  };
}
```

- [ ] **Step 2: Smoke test (unit-style)**

Run from repo root:
```bash
node -e "
import('./controller/src/auth/requireAuth.js').then(async ({ requireAuth }) => {
  const { issueSessionToken } = await import('./controller/src/auth/session.js');
  const mw = requireAuth({ apiTokens: [{ name: 'ci', token: 'tok-1' }], sessionSecret: 's' });
  const run = (req) => new Promise((resolve) => mw(req, {}, (err) => resolve({ err: err?.message, actor: req.actor })));
  console.log('bearer ok:',     await run({ headers: { authorization: 'Bearer tok-1' }, cookies: {} }));
  console.log('bearer bad:',    await run({ headers: { authorization: 'Bearer nope' },  cookies: {} }));
  console.log('cookie ok:',     await run({ headers: {}, cookies: { cp_session: issueSessionToken('s') } }));
  console.log('cookie bad:',    await run({ headers: {}, cookies: { cp_session: 'garbage' } }));
  console.log('no creds:',      await run({ headers: {}, cookies: {} }));
});
"
```

Expected output:
```
bearer ok:  { err: undefined, actor: 'api:ci' }
bearer bad: { err: 'invalid token', actor: undefined }
cookie ok:  { err: undefined, actor: 'web' }
cookie bad: { err: 'authentication required', actor: undefined }
no creds:   { err: 'authentication required', actor: undefined }
```

- [ ] **Step 3: Commit**

```bash
git add controller/src/auth/requireAuth.js
git commit -m "feat(auth): add requireAuth middleware accepting bearer or cookie"
```

---

### Task 5: Add auth routes (`/auth/login`, `/auth/logout`, `/auth/me`)

**Files:**
- Create: `controller/src/api/routes/auth.js`

- [ ] **Step 1: Create controller/src/api/routes/auth.js**

```js
// Dashboard auth endpoints. Mounted at the app root (NOT under /api),
// so /auth/* is reachable without a bearer token.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  COOKIE_DEFAULTS,
  SESSION_COOKIE_NAME,
  issueSessionToken,
  verifyPassword,
  verifySessionToken,
} from '../../auth/session.js';

export function authRouter({ passwordHash, sessionSecret, isProd }) {
  const r = Router();

  const loginLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10, // per IP per minute
    standardHeaders: true,
    legacyHeaders: false,
  });

  r.post('/auth/login', loginLimiter, async (req, res) => {
    if (!passwordHash) {
      return res.status(503).json({
        error: { code: 'E_NOT_CONFIGURED', message: 'DASHBOARD_PASSWORD_HASH is not set' },
      });
    }
    const password = req.body?.password;
    const ok = await verifyPassword(password, passwordHash);
    if (!ok) {
      return res.status(401).json({ error: { code: 'E_AUTH', message: 'invalid password' } });
    }
    const token = issueSessionToken(sessionSecret);
    res.cookie(SESSION_COOKIE_NAME, token, { ...COOKIE_DEFAULTS, secure: isProd });
    res.json({ ok: true });
  });

  r.post('/auth/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });

  r.get('/auth/me', (req, res) => {
    const raw = req.cookies?.[SESSION_COOKIE_NAME];
    const v = verifySessionToken(sessionSecret, raw);
    if (!v.ok) return res.status(401).json({ authenticated: false });
    res.json({ authenticated: true, exp: v.exp });
  });

  return r;
}
```

- [ ] **Step 2: Commit**

```bash
git add controller/src/api/routes/auth.js
git commit -m "feat(api): add /auth/login, /auth/logout, /auth/me routes"
```

(Verification happens in Task 7 once everything is wired into the server.)

---

### Task 6: Extend controller config with `dashboardPasswordHash`

**Files:**
- Modify: `controller/src/config.js`

- [ ] **Step 1: Add dashboardPasswordHash to loadControllerConfig**

In `controller/src/config.js`, inside the returned object (after `apiTokens:` line), add:

```js
    dashboardPasswordHash: process.env.DASHBOARD_PASSWORD_HASH ?? '',
    isProd: process.env.NODE_ENV === 'production',
```

The full returned object becomes:

```js
return {
  host: process.env.CONTROLLER_HOST ?? '0.0.0.0',
  port: Number(process.env.CONTROLLER_PORT ?? 8080),
  jwtSecret: process.env.CONTROLLER_JWT_SECRET ?? 'change-me',
  apiTokens: parseApiTokens(process.env.CONTROLLER_API_TOKENS ?? ''),
  dashboardPasswordHash: process.env.DASHBOARD_PASSWORD_HASH ?? '',
  isProd: process.env.NODE_ENV === 'production',
  db: { /* unchanged */ },
  // ... rest unchanged
};
```

- [ ] **Step 2: Smoke test**

```bash
DASHBOARD_PASSWORD_HASH='$2a$12$abc' NODE_ENV=production node -e "
import('./controller/src/config.js').then(({ loadControllerConfig }) => {
  const c = loadControllerConfig();
  console.log('hash:', c.dashboardPasswordHash);
  console.log('prod:', c.isProd);
});
"
```

Expected:
```
hash: $2a$12$abc
prod: true
```

- [ ] **Step 3: Commit**

```bash
git add controller/src/config.js
git commit -m "feat(controller): expose DASHBOARD_PASSWORD_HASH and isProd in config"
```

---

### Task 7: Wire cookie-parser, mount `/auth/*`, swap `apiAuth` → `requireAuth`

**Files:**
- Modify: `controller/src/api/server.js`
- Modify: `controller/src/index.js`

- [ ] **Step 1: Update buildHttpApp signature and body**

Replace the entire content of `controller/src/api/server.js` with:

```js
import express from 'express';
import cookieParser from 'cookie-parser';
import { requireAuth } from '../auth/requireAuth.js';
import { authRouter } from './routes/auth.js';
import { actionsRouter } from './routes/actions.js';
import { readRouter } from './routes/read.js';
import { metricsRouter } from './routes/metrics.js';
import { artifactBlobRouter, artifactTokenRouter } from './routes/artifacts.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestLog } from './middleware/requestLog.js';
import { requestId } from './middleware/requestId.js';

export function buildHttpApp({
  apiTokens,
  artifactSecret,
  publicBaseUrl,
  sessionSecret,
  dashboardPasswordHash,
  isProd,
}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use(requestId());
  app.use(requestLog());

  // Public
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/readyz',  (_req, res) => res.json({ ok: true }));

  // Auth endpoints — public (no requireAuth).
  app.use('/', authRouter({
    passwordHash: dashboardPasswordHash,
    sessionSecret,
    isProd,
  }));

  // Artifact blob endpoint: token-authenticated (NO bearer required).
  // Must sit above /api so agents can fetch without an API token.
  app.use('/', artifactBlobRouter({ secret: artifactSecret }));

  // Everything under /api requires bearer OR session cookie.
  app.use('/api', requireAuth({ apiTokens, sessionSecret }));
  app.use('/api', readRouter());
  app.use('/api', metricsRouter());
  app.use('/api', artifactTokenRouter({ secret: artifactSecret, publicBaseUrl }));
  app.use('/api', actionsRouter());

  app.use(errorHandler);
  return app;
}
```

- [ ] **Step 2: Pass new config to buildHttpApp in index.js**

In `controller/src/index.js`, replace the `buildHttpApp({...})` call with:

```js
const app = buildHttpApp({
  apiTokens: config.apiTokens,
  artifactSecret: config.artifactSecret,
  publicBaseUrl: config.publicBaseUrl,
  sessionSecret: config.jwtSecret,
  dashboardPasswordHash: config.dashboardPasswordHash,
  isProd: config.isProd,
});
```

- [ ] **Step 3: Smoke test (full stack)**

Set up env (you need a running MySQL — see CLAUDE.md `docker compose up -d`):
```bash
HASH=$(echo -n 'hunter2' | npm run --silent dashboard:hash)
export DASHBOARD_PASSWORD_HASH="$HASH"
```

Start controller in background:
```bash
npm run dev:controller &
CTRL_PID=$!
sleep 3
```

Verify endpoints:
```bash
# /api requires auth
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/api/applications
# expected: 401

# Bearer still works (use a token from CONTROLLER_API_TOKENS in .env)
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Authorization: Bearer telegram-bot:replace-me' \
  http://127.0.0.1:8080/api/applications
# expected: 200 (or 200 with empty array if DB is fresh)

# Login: wrong password
curl -s -w '\n%{http_code}\n' -X POST http://127.0.0.1:8080/auth/login \
  -H 'content-type: application/json' \
  -d '{"password":"wrong"}'
# expected: {"error":{"code":"E_AUTH","message":"invalid password"}} 401

# Login: right password
curl -s -c /tmp/cp_cookies.txt -w '\n%{http_code}\n' -X POST http://127.0.0.1:8080/auth/login \
  -H 'content-type: application/json' \
  -d '{"password":"hunter2"}'
# expected: {"ok":true} 200, and /tmp/cp_cookies.txt contains cp_session

# /auth/me with cookie
curl -s -b /tmp/cp_cookies.txt -w '\n%{http_code}\n' http://127.0.0.1:8080/auth/me
# expected: {"authenticated":true,"exp":<number>} 200

# /api with cookie (no bearer)
curl -s -b /tmp/cp_cookies.txt -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/api/applications
# expected: 200

# Logout
curl -s -b /tmp/cp_cookies.txt -c /tmp/cp_cookies.txt -X POST http://127.0.0.1:8080/auth/logout
# expected: {"ok":true}
# /tmp/cp_cookies.txt should now have cp_session cleared (empty/expired)
```

Stop controller:
```bash
kill $CTRL_PID
wait $CTRL_PID 2>/dev/null
```

If any of the expected outputs above does not match, debug before proceeding.

- [ ] **Step 4: Commit**

```bash
git add controller/src/api/server.js controller/src/index.js
git commit -m "feat(controller): wire cookies, /auth routes, and bearer-or-cookie auth"
```

---

### Task 8: Gate WS `/ui` upgrade with the session cookie

**Files:**
- Modify: `controller/src/ws/hub.js`

- [ ] **Step 1: Add cookie verification to WsHub**

Edit `controller/src/ws/hub.js`:

1. Add new imports near the top (after the existing `import` block):

```js
import { parse as parseCookie } from 'cookie';
import { SESSION_COOKIE_NAME, verifySessionToken } from '../auth/session.js';
```

(`cookie` is a transitive dep of `cookie-parser` and is already in the tree; if `npm ls cookie` shows it missing, add `"cookie": "^0.6.0"` to `controller/package.json` and `npm install`.)

2. Update the constructor to accept `sessionSecret`:

Change:
```js
constructor({ httpServer, heartbeatMs, onJobResult }) {
  this.heartbeatMs = heartbeatMs;
  this.onJobResult = onJobResult;
```

To:
```js
constructor({ httpServer, heartbeatMs, onJobResult, sessionSecret }) {
  this.heartbeatMs = heartbeatMs;
  this.onJobResult = onJobResult;
  this.sessionSecret = sessionSecret;
```

3. Update `_handleUpgrade` to verify the cookie on `/ui`:

Replace the existing `_handleUpgrade` method with:

```js
_handleUpgrade(req, socket, head) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/agent') {
    this.wss.handleUpgrade(req, socket, head, (ws) => this._attachAgent(ws, req));
  } else if (url.pathname === '/ui') {
    if (!this._uiAuthOk(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this._attachUi(ws, req));
  } else {
    socket.destroy();
  }
}

_uiAuthOk(req) {
  const cookies = parseCookie(req.headers.cookie ?? '');
  const v = verifySessionToken(this.sessionSecret, cookies[SESSION_COOKIE_NAME]);
  return v.ok;
}
```

- [ ] **Step 2: Pass sessionSecret from index.js**

In `controller/src/index.js`, update the `WsHub` constructor call:

```js
const hub = new WsHub({
  httpServer,
  heartbeatMs: HEARTBEAT_INTERVAL_MS,
  sessionSecret: config.jwtSecret,
});
```

(Leave `onJobResult` alone — only add `sessionSecret`.)

- [ ] **Step 3: Smoke test**

Start controller as in Task 7, then:

```bash
# WS /ui without cookie → should fail handshake with 401
node -e "
import('ws').then(({ default: WS }) => {
  const ws = new WS('ws://127.0.0.1:8080/ui');
  ws.on('open', () => { console.log('open (UNEXPECTED)'); ws.close(); process.exit(1); });
  ws.on('unexpected-response', (_req, res) => { console.log('status:', res.statusCode); process.exit(0); });
  ws.on('error', (err) => { console.log('error:', err.message); process.exit(0); });
});
"
# expected: "status: 401"

# WS /ui with cookie → should connect
HASH=$(echo -n 'hunter2' | npm run --silent dashboard:hash)
# (You may need to log in again to refresh /tmp/cp_cookies.txt)
COOKIE=$(grep cp_session /tmp/cp_cookies.txt | awk '{print $6"="$7}')
node -e "
import('ws').then(({ default: WS }) => {
  const ws = new WS('ws://127.0.0.1:8080/ui', { headers: { cookie: process.argv[1] } });
  ws.on('open', () => { console.log('open OK'); ws.close(); process.exit(0); });
  ws.on('error', (err) => { console.log('error:', err.message); process.exit(1); });
  setTimeout(() => { console.log('timeout'); process.exit(1); }, 3000);
});
" "$COOKIE"
# expected: "open OK"
```

- [ ] **Step 4: Commit**

```bash
git add controller/src/ws/hub.js controller/src/index.js
git commit -m "feat(ws): require session cookie on /ui upgrade"
```

---

## Phase B — SPA moves into the controller

### Task 9: Copy SPA assets into `controller/public/`

**Files:**
- Create: `controller/public/index.html`, `controller/public/styles.css`, `controller/public/app.js`

- [ ] **Step 1: Copy files**

Run from repo root:
```bash
mkdir -p controller/public
cp web/src/public/index.html  controller/public/index.html
cp web/src/public/styles.css  controller/public/styles.css
cp web/src/public/app.js      controller/public/app.js
```

- [ ] **Step 2: Remove the bootstrap.js dependency from index.html**

Edit `controller/public/index.html`. Remove this line:

```html
  <script src="/bootstrap.js"></script>
```

(The previous `web/server.js` injected `window.__CP__` here. Same-origin SPA derives the WS URL itself in app.js — see next step.)

- [ ] **Step 3: Update app.js to derive WS URL from same origin**

In `controller/public/app.js`, change line 4 from:

```js
const wsUrl = window.__CP__?.controllerWs ?? `${location.origin.replace(/^http/, 'ws')}/ui`;
```

To:

```js
const wsUrl = `${location.origin.replace(/^http/, 'ws')}/ui`;
```

- [ ] **Step 4: Make API calls cookie-aware (no bearer header needed)**

In `controller/public/app.js`, find the `api()` function and add `credentials: 'same-origin'` so cookies are sent on cross-port dev too. Replace:

```js
async function api(path, init) {
  const res = await fetch(apiBase + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}
```

With:

```js
async function api(path, init) {
  const res = await fetch(apiBase + path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (res.status === 401) {
    location.href = '/login.html';
    throw new Error('unauthenticated');
  }
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}
```

- [ ] **Step 5: Commit**

```bash
git add controller/public/
git commit -m "feat(web): move SPA assets into controller/public, drop bootstrap.js"
```

---

### Task 10: Add a tiny login page

**Files:**
- Create: `controller/public/login.html`, `controller/public/login.js`

- [ ] **Step 1: Create controller/public/login.html**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ControlPlane — Login</title>
  <link rel="stylesheet" href="/styles.css">
  <style>
    .login-wrap { display:flex; align-items:center; justify-content:center; min-height:80vh; }
    .login-card { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:24px; width:320px; }
    .login-card h2 { margin:0 0 16px; font-size:16px; }
    .login-card input[type=password] {
      width:100%; padding:8px 10px; background:#0d1117; color:#e6edf3;
      border:1px solid #30363d; border-radius:6px; font:inherit;
    }
    .login-card .row { display:flex; gap:8px; margin-top:12px; }
    .login-card .err { color:#ff6a69; font-size:12px; min-height:16px; margin-top:8px; }
  </style>
</head>
<body>
  <header><h1>ControlPlane</h1></header>
  <main>
    <div class="login-wrap">
      <form id="login-form" class="login-card">
        <h2>Sign in</h2>
        <input id="password" type="password" placeholder="Password" autofocus required>
        <div class="row"><button type="submit">Sign in</button></div>
        <div id="err" class="err"></div>
      </form>
    </div>
  </main>
  <script src="/login.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create controller/public/login.js**

```js
const form = document.getElementById('login-form');
const errEl = document.getElementById('err');

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  errEl.textContent = '';
  const password = document.getElementById('password').value;
  try {
    const res = await fetch('/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) { location.href = '/'; return; }
    const body = await res.json().catch(() => ({}));
    errEl.textContent = body?.error?.message ?? `error ${res.status}`;
  } catch (err) {
    errEl.textContent = err.message;
  }
});
```

- [ ] **Step 3: Commit**

```bash
git add controller/public/login.html controller/public/login.js
git commit -m "feat(web): add login page"
```

---

### Task 11: Mount `express.static` on controller

**Files:**
- Modify: `controller/src/api/server.js`

- [ ] **Step 1: Add express.static after API routes**

In `controller/src/api/server.js`:

1. Add imports at the top:

```js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
```

2. Add a `__dirname` derivation right after the imports block:

```js
const __dirname = path.dirname(fileURLToPath(import.meta.url));
```

3. Just before `app.use(errorHandler);`, add:

```js
// SPA static assets. Served last so it doesn't shadow /api or /auth.
app.use(express.static(path.join(__dirname, '..', '..', 'public')));
```

That resolves to `controller/public/` (server.js is at `controller/src/api/server.js`).

- [ ] **Step 2: Smoke test**

Restart the controller (`npm run dev:controller`), then:

```bash
# Static assets
curl -s -o /dev/null -w 'index: %{http_code}\n' http://127.0.0.1:8080/
curl -s -o /dev/null -w 'login: %{http_code}\n' http://127.0.0.1:8080/login.html
curl -s -o /dev/null -w 'app.js: %{http_code}\n' http://127.0.0.1:8080/app.js
curl -s -o /dev/null -w 'styles: %{http_code}\n' http://127.0.0.1:8080/styles.css
# expected: all 200

# Static must NOT shadow API
curl -s -o /dev/null -w 'api 401: %{http_code}\n' http://127.0.0.1:8080/api/applications
# expected: 401 (auth, not 200/static)
```

Then open http://127.0.0.1:8080/login.html in a browser:
- Type the password (`hunter2` from Task 7).
- On submit, browser should redirect to `/`.
- Dashboard loads, "conn" dot in header turns green (WS connected).
- Refresh page — still authenticated (cookie persists).
- Open DevTools → Application → Cookies — `cp_session` should be HttpOnly, SameSite=Lax.

If anything is broken, debug before proceeding.

- [ ] **Step 3: Commit**

```bash
git add controller/src/api/server.js
git commit -m "feat(controller): serve SPA static assets from controller/public"
```

---

## Phase C — Telegram bot moves into the controller

### Task 12: Add `node-telegram-bot-api` dep to controller

**Files:**
- Modify: `controller/package.json`

- [ ] **Step 1: Add dep**

Edit `controller/package.json`. In `"dependencies"`, add:

```json
"node-telegram-bot-api": "^0.66.0",
```

(Match the version pinned in `bot/package.json` to avoid duplicate trees. Run `cat bot/package.json | grep node-telegram-bot-api` first and use the same version range.)

- [ ] **Step 2: Install**

```bash
npm install
```

- [ ] **Step 3: Commit**

```bash
git add controller/package.json package-lock.json
git commit -m "chore(controller): add node-telegram-bot-api dep"
```

---

### Task 13: Move bot format helper

**Files:**
- Create: `controller/src/bot/format.js`

- [ ] **Step 1: Copy file verbatim**

```bash
mkdir -p controller/src/bot
cp bot/src/format.js controller/src/bot/format.js
```

- [ ] **Step 2: Commit**

```bash
git add controller/src/bot/format.js
git commit -m "feat(bot): move format helper into controller/src/bot"
```

---

### Task 14: In-process bot API adapter

**Files:**
- Create: `controller/src/bot/api.js`

The bot today uses `bot/src/controllerClient.js` to make HTTP calls. The new adapter exposes the same surface but calls repositories and the orchestrator directly. Same shape so [controller/src/bot/format.js](../../controller/src/bot/format.js) keeps working unchanged.

- [ ] **Step 1: Create controller/src/bot/api.js**

```js
// In-process replacement for bot/src/controllerClient.js.
// Same method names + return shapes — direct calls to repos + orchestrator.

import { applications, groups, servers, jobs as jobsRepo } from '../db/repositories.js';
import { submitAction } from '../orchestrator/orchestrator.js';

export class BotApi {
  listGroups()         { return groups.list(); }
  listApplications()   { return applications.list(); }
  listServers()        { return servers.list(); }
  getApplication(id)   { return applications.get(Number(id)); }
  getJob(id)           { return jobsRepo.get(Number(id)); }

  async enqueue({ action, target, options, triggeredBy }) {
    const jobs = await submitAction({ action, target, options, triggeredBy });
    return { accepted: true, jobs };
  }
}
```

(`metrics()` from the old client is **not** ported because the bot's commands don't call it; format.js doesn't reference it either.)

- [ ] **Step 2: Smoke test**

```bash
node -e "
import('./controller/src/db/pool.js').then(async ({ initPool }) => {
  initPool({ host:'127.0.0.1', port:3306, user:'root', password:'root', database:'controlplane', connectionLimit:5 });
  const { BotApi } = await import('./controller/src/bot/api.js');
  const api = new BotApi();
  console.log('groups count:', (await api.listGroups()).length);
  console.log('apps count:',   (await api.listApplications()).length);
  process.exit(0);
});
"
```

Expected: two lines with numbers (0 is fine on a fresh DB). No errors.

- [ ] **Step 3: Commit**

```bash
git add controller/src/bot/api.js
git commit -m "feat(bot): in-process BotApi adapter (no HTTP loopback)"
```

---

### Task 15: Refactor bot startup as `startBot({ logger })`

**Files:**
- Create: `controller/src/bot/start.js`

Rewrite `bot/src/index.js` as an exported `startBot` function. Differences from the original:

- Reads `TELEGRAM_TOKEN` lazily; returns `{ stop: () => {} }` if unset.
- Uses `BotApi` instead of `ControllerClient` (no URL, no API token reads).
- Drops top-level `process.on('SIGINT'/'SIGTERM')` — controller's `shutdown` owns this.
- Returns a `{ stop }` handle for the controller's shutdown to await.
- Records `triggeredBy: \`telegram:${msg.from?.id ?? 'anon'}\`` on `enqueue` calls so `audit_logs.actor` matches the old behavior.

- [ ] **Step 1: Create controller/src/bot/start.js**

```js
// In-process Telegram bot. Started by controller/src/index.js when
// TELEGRAM_TOKEN is set. Talks to the controller via BotApi (no HTTP).
//
// Commands match the previous standalone bot:
//   /status                — overview of all apps
//   /group <name>          — apps in a group
//   /app <name>            — app detail
//   /restart <group>       — restart all apps in a group
//   /build <group>         — build all apps in a group
//   /deploy <group>        — deploy all apps in a group

import TelegramBot from 'node-telegram-bot-api';
import { ControlPlaneError } from '@cp/shared/errors';
import { JobAction, JobTargetType } from '@cp/shared/constants';

import { BotApi } from './api.js';
import { fmtApps, fmtJob, fmtEnqueueResult } from './format.js';

export function startBot({ logger }) {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) {
    logger.info('bot:disabled (TELEGRAM_TOKEN not set)');
    return { stop: async () => {} };
  }

  const admins = new Set(
    (process.env.TELEGRAM_ADMIN_CHAT_IDS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean).map(Number),
  );

  const api = new BotApi();
  const bot = new TelegramBot(token, { polling: true });

  const isAdmin = (msg) => admins.size === 0 || admins.has(msg.from?.id);
  const actorOf = (msg) => `telegram:${msg.from?.id ?? 'anon'}`;
  const send = (chatId, text, extra = {}) =>
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra });

  async function guarded(msg, fn) {
    try { await fn(); }
    catch (err) {
      const text = err instanceof ControlPlaneError
        ? `⚠️ ${err.code}: ${err.message}`
        : `⚠️ unexpected: ${err.message}`;
      logger.warn({ err: err.message, chat: msg.chat.id }, 'bot:command-failed');
      await send(msg.chat.id, text);
    }
  }

  // /status
  bot.onText(/^\/status(?:@\w+)?\s*$/, (msg) => guarded(msg, async () => {
    const apps = await api.listApplications();
    await send(msg.chat.id, fmtApps(apps));
  }));

  // /group <name>
  bot.onText(/^\/group(?:@\w+)?\s+(\S+)/, (msg, m) => guarded(msg, async () => {
    const name = m[1];
    const apps = await api.listApplications();
    const groups = await api.listGroups();
    const g = groups.find((x) => x.name === name);
    if (!g) return send(msg.chat.id, `_group *${name}* not found_`);
    const filtered = apps.filter((a) => a.group_id === g.id);
    await send(msg.chat.id, `*${name}* — ${filtered.length} apps\n${fmtApps(filtered)}`);
  }));

  // /app <name>
  bot.onText(/^\/app(?:@\w+)?\s+(\S+)/, (msg, m) => guarded(msg, async () => {
    const name = m[1];
    const apps = await api.listApplications();
    const app = apps.find((a) => a.name === name);
    if (!app) return send(msg.chat.id, `_app *${name}* not found_`);
    const detail = await api.getApplication(app.id);
    const lines = [
      `*${detail.name}*  _${detail.process_state}_`,
      `runtime: \`${detail.runtime}\`  pid: \`${detail.pid ?? '-'}\``,
      `server: \`${detail.server_id}\`  branch: \`${detail.branch}\``,
      `enabled: ${detail.enabled ? '✅' : '❌'}  trusted: ${detail.trusted ? '✅' : '❌'}`,
    ];
    await send(msg.chat.id, lines.join('\n'));
  }));

  // /restart, /build, /deploy <group>
  const actionCommands = [
    { re: /^\/restart(?:@\w+)?\s+(\S+)/, action: JobAction.RESTART },
    { re: /^\/build(?:@\w+)?\s+(\S+)/,   action: JobAction.BUILD   },
    { re: /^\/deploy(?:@\w+)?\s+(\S+)/,  action: JobAction.DEPLOY  },
  ];
  for (const { re, action } of actionCommands) {
    bot.onText(re, (msg, m) => guarded(msg, async () => {
      if (!isAdmin(msg)) return send(msg.chat.id, '_forbidden_');
      const groupName = m[1];
      const result = await api.enqueue({
        action,
        target: { type: JobTargetType.GROUP, id: groupName },
        triggeredBy: actorOf(msg),
      });
      await send(msg.chat.id, `*${action}* → *${groupName}*\n${fmtEnqueueResult(result)}`);
      const first = result.jobs?.[0];
      if (first?.jobId) pollJobStatus(msg.chat.id, first.jobId);
    }));
  }

  async function pollJobStatus(chatId, jobId) {
    const deadline = Date.now() + 60_000;
    let last;
    while (Date.now() < deadline) {
      try {
        const job = await api.getJob(jobId);
        if (!job) return;
        if (job.status !== last) {
          last = job.status;
          await send(chatId, fmtJob(job));
          if (['success', 'failed', 'cancelled'].includes(job.status)) return;
        }
      } catch { /* ignore transient polling errors */ }
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }

  logger.info({ admins: admins.size }, 'bot:started');

  return {
    stop: async () => {
      try { await bot.stopPolling(); }
      catch (err) { logger.warn({ err: err.message }, 'bot:stop-failed'); }
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add controller/src/bot/start.js
git commit -m "feat(bot): startBot() runs in-process, calls BotApi directly"
```

---

### Task 16: Wire `startBot` into the controller boot + shutdown

**Files:**
- Modify: `controller/src/index.js`

- [ ] **Step 1: Import and call startBot**

In `controller/src/index.js`:

1. Add import near the top with the other imports:

```js
import { startBot } from './bot/start.js';
```

2. Right after the `const workers = startWorkers(...)` call, add:

```js
const botLogger = createLogger({ service: 'bot' });
const bot = startBot({ logger: botLogger });
```

3. In the existing `shutdown(signal)` function, between the `hub.stop()` and `Promise.all(workers...)` lines, add:

```js
await bot.stop();
```

The full updated `shutdown` body becomes:

```js
const shutdown = async (signal) => {
  logger.info({ signal }, 'controller:shutdown');
  try {
    httpServer.close();
    hub.stop();
    await bot.stop();
    await Promise.all(workers.map((w) => w.close().catch(() => {})));
    await closeQueues();
    await closePool();
  } catch (err) {
    logger.error({ err: err.message }, 'shutdown:error');
  } finally {
    process.exit(0);
  }
};
```

- [ ] **Step 2: Smoke test (bot disabled)**

Without `TELEGRAM_TOKEN` in env, restart the controller:
```bash
unset TELEGRAM_TOKEN
npm run dev:controller &
CTRL_PID=$!
sleep 3
```

Expected log lines (among others):
```
... "bot:disabled (TELEGRAM_TOKEN not set)"
... "controller:listening"
```

Stop:
```bash
kill -INT $CTRL_PID
wait $CTRL_PID 2>/dev/null
```

- [ ] **Step 3: Smoke test (bot enabled, no DB needed for boot test)**

Set a clearly-fake token and confirm the bot starts polling without crashing the controller. Telegram will reject API calls (invalid token) but `node-telegram-bot-api` keeps polling — that's fine for boot verification.

```bash
TELEGRAM_TOKEN='1234567890:fake-for-boot-test' npm run dev:controller &
CTRL_PID=$!
sleep 4
```

Expected logs:
```
... "bot:started"
... "controller:listening"
```

(You may see warnings from telegram polling failures — those are expected with a fake token.)

Stop:
```bash
kill -INT $CTRL_PID
wait $CTRL_PID 2>/dev/null
```

Verify shutdown logs include:
```
controller:shutdown
```
without a hung process (the `kill` should return promptly, < 5 sec).

- [ ] **Step 4: Commit**

```bash
git add controller/src/index.js
git commit -m "feat(controller): start in-process bot at boot, stop on shutdown"
```

---

## Phase D — Cleanup

### Task 17: Drop the old `bot/` and `web/` workspaces

**Files:**
- Delete: `bot/`, `web/`
- Modify: `package.json` (root)

- [ ] **Step 1: Remove workspaces and dev scripts from root package.json**

Replace the entire content of `package.json` (root) with:

```json
{
  "name": "controlplane",
  "version": "0.1.0",
  "private": true,
  "description": "Distributed process management system for Node.js and Java applications.",
  "type": "module",
  "workspaces": [
    "shared",
    "queue",
    "controller",
    "agent"
  ],
  "scripts": {
    "db:init": "mysql --protocol=TCP -h ${DB_HOST:-127.0.0.1} -P ${DB_PORT:-3306} -u ${DB_USER:-root} -p${DB_PASSWORD:-root} ${DB_NAME:-controlplane} < db/schema.sql",
    "dev:controller": "npm --workspace controller run dev",
    "dev:agent": "npm --workspace agent run dev",
    "dashboard:hash": "node scripts/hash-password.js",
    "lint": "echo 'add eslint in later steps'",
    "test": "echo 'add tests in later steps'"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 2: Delete the old workspace directories**

```bash
rm -rf bot web
```

- [ ] **Step 3: Reinstall to refresh node_modules links**

```bash
rm -rf node_modules package-lock.json
npm install
```

(Full reinstall to drop the `@cp/bot` and `@cp/web` symlinks cleanly.)

- [ ] **Step 4: Smoke test — full boot**

```bash
HASH=$(echo -n 'hunter2' | npm run --silent dashboard:hash)
DASHBOARD_PASSWORD_HASH="$HASH" npm run dev:controller &
CTRL_PID=$!
sleep 3

# Static
curl -s -o /dev/null -w 'login html: %{http_code}\n' http://127.0.0.1:8080/login.html

# Auth flow
curl -s -c /tmp/cp.txt -X POST http://127.0.0.1:8080/auth/login \
  -H 'content-type: application/json' -d '{"password":"hunter2"}' >/dev/null
curl -s -b /tmp/cp.txt -o /dev/null -w 'apps via cookie: %{http_code}\n' \
  http://127.0.0.1:8080/api/applications

# Bearer still works
TOK=$(grep ^CONTROLLER_API_TOKENS .env | sed 's/^[^=]*=//' | cut -d',' -f1 | cut -d':' -f2-)
curl -s -H "Authorization: Bearer $TOK" -o /dev/null -w 'apps via bearer: %{http_code}\n' \
  http://127.0.0.1:8080/api/applications

kill -INT $CTRL_PID
wait $CTRL_PID 2>/dev/null
```

Expected:
```
login html: 200
apps via cookie: 200
apps via bearer: 200
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: drop bot/ and web/ workspaces (folded into controller)"
```

---

### Task 18: Update `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Replace the file**

Overwrite `.env.example` with:

```
# ───────── Core ─────────
NODE_ENV=development
LOG_LEVEL=info

# ───────── Controller ─────────
CONTROLLER_HOST=0.0.0.0
CONTROLLER_PORT=8080
# Secret used to sign the dashboard session cookie (cp_session).
# Rotate to invalidate every active dashboard session.
CONTROLLER_JWT_SECRET=change-me-in-prod
# Comma-separated bearer tokens for service clients (CI, scripts).
# The Telegram bot no longer uses one — it runs in-process.
CONTROLLER_API_TOKENS=ci:replace-me
# Public URL agents & rsync transport use to reach the controller
CONTROLLER_PUBLIC_URL=http://127.0.0.1:8080
# Distinct secret used only to sign short-lived artifact download URLs.
ARTIFACT_SIGNING_SECRET=change-me-in-prod
ARTIFACT_STORE_DIR=/var/lib/controlplane/artifacts
CONTROLLER_SSH_KEY_DIR=/root/.ssh
BUILD_TIMEOUT_MS=1800000

# ───────── Dashboard auth ─────────
# bcrypt hash of the dashboard password.
# Generate with:  echo -n 'your-password' | npm run dashboard:hash --silent
DASHBOARD_PASSWORD_HASH=

# ───────── Agent ─────────
AGENT_ID=agent-local
AGENT_SERVER_NAME=local-dev
CONTROLLER_WS_URL=ws://127.0.0.1:8080/agent
AGENT_AUTH_TOKEN=replace-me
AGENT_HEARTBEAT_MS=10000
AGENT_WORKDIR=/var/lib/controlplane/apps

# ───────── MySQL ─────────
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=root
DB_NAME=controlplane
DB_POOL_SIZE=10

# ───────── Queue ─────────
WORKER_CONCURRENCY=4

# ───────── Telegram Bot (optional — leave TELEGRAM_TOKEN blank to disable) ─────────
TELEGRAM_TOKEN=
# Comma-separated chat IDs allowed to issue destructive commands
TELEGRAM_ADMIN_CHAT_IDS=
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs(env): drop web/proxy vars, document DASHBOARD_PASSWORD_HASH"
```

---

### Task 19: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Replace the "Common commands" block**

Find the section starting `## Common commands` and ending before `## Workspace layout`. Replace with:

````markdown
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
````

- [ ] **Step 2: Replace the "Workspace layout" block**

Find the `## Workspace layout` section. Replace its body (keep the heading, replace everything until the next `##`) with:

````markdown
## Workspace layout

npm workspaces under internal scope `@cp/*`. ESM (`"type": "module"`), Node ≥20.

- `controller/` — REST API, WS hub, orchestrator, in-process job worker, controller-side builder + artifact store, dashboard SPA static (`controller/public/`), and in-process Telegram bot (`controller/src/bot/`).
- `agent/` — runs on each target server, holds the WS to the controller, executes whitelisted commands, manages process lifecycle.
- `queue/` — in-process queue/producer/worker primitives. Surface mimics a subset of BullMQ.
- `shared/` — constants (enums), logger, error taxonomy, zod schemas, id helpers. Imported as `@cp/shared`, `@cp/shared/constants`, `@cp/shared/errors`, etc.
- `db/` — `schema.sql` (full MySQL 8 schema, InnoDB + utf8mb4) and `migrations/`.

The system runs as **two processes**: one `controller` (which hosts everything except the agent) and one `agent` per managed server.
````

- [ ] **Step 3: Replace the "Web token handling" block**

Find the `## Web token handling` section. Replace its body with:

````markdown
## Dashboard auth

The dashboard uses a single shared password (set as bcrypt hash in `DASHBOARD_PASSWORD_HASH`) and a signed session cookie (`cp_session`, signed with `CONTROLLER_JWT_SECRET`). Login flow:

1. Browser POSTs `{ password }` to `/auth/login`.
2. Controller verifies against the bcrypt hash and sets an `HttpOnly`, `SameSite=Lax` cookie. `Secure` is added when `NODE_ENV=production`.
3. SPA calls `/api/*` with `credentials: 'same-origin'`. The `requireAuth` middleware accepts **either** `Authorization: Bearer <token>` (matching `CONTROLLER_API_TOKENS`, used by external scripts/CLI) **or** a valid `cp_session` cookie.
4. WS `/ui` upgrade verifies the same cookie and rejects with HTTP 401 if missing or invalid.

Generate a password hash with `echo -n 'your-password' | npm run dashboard:hash --silent` and paste into `.env`.
````

- [ ] **Step 4: Replace the "Telegram bot scope" block**

Find `## Telegram bot scope`. Replace its body with:

````markdown
## Telegram bot scope

The Telegram bot runs **in-process inside the controller** (started only when `TELEGRAM_TOKEN` is set). It calls the controller's repositories and orchestrator directly via [controller/src/bot/api.js](controller/src/bot/api.js) — no HTTP loopback, no bearer token. It must not query the DB outside those repositories or talk to agents directly: every action goes through `submitAction` (the orchestrator's single chokepoint, same as REST). `TELEGRAM_ADMIN_CHAT_IDS` gates destructive commands.
````

- [ ] **Step 5: Smoke test — re-read CLAUDE.md**

Open `CLAUDE.md` in your editor and skim it end-to-end. Check that:
- No references remain to `dev:bot`, `dev:web`, `WEB_PORT`, `WEB_CONTROLLER_TOKEN`, `TELEGRAM_CONTROLLER_URL`, or `TELEGRAM_CONTROLLER_TOKEN`.
- The "Architecture invariants" section (queue, idempotency, retries, constants↔schema, four named queues) is **unchanged** — these are still true.
- The "Controller ↔ agent protocol" and "Build-once-deploy-many" sections are **unchanged** — these are still true.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): document two-process layout and cookie session auth"
```

---

### Task 20: Final end-to-end smoke test

**Files:** none (verification only)

- [ ] **Step 1: Fresh boot from clean env**

```bash
# Make sure MySQL is up
docker compose up -d
sleep 3

# Generate hash and put in .env if not already there
HASH=$(echo -n 'hunter2' | npm run --silent dashboard:hash)
grep -q '^DASHBOARD_PASSWORD_HASH=' .env \
  && sed -i.bak "s|^DASHBOARD_PASSWORD_HASH=.*|DASHBOARD_PASSWORD_HASH=$HASH|" .env \
  || echo "DASHBOARD_PASSWORD_HASH=$HASH" >> .env

# Boot controller
npm run dev:controller &
CTRL_PID=$!
sleep 4
```

- [ ] **Step 2: Browser walkthrough**

Open http://127.0.0.1:8080/ in a browser:
- You should be redirected to `/login.html` (or land on dashboard if a previous cookie is still valid — clear cookies and refresh to test login).
- Enter `hunter2`, submit.
- Dashboard loads. Connection dot turns green.
- Click "Refresh" — apps/jobs/audit tabs render without errors in the JS console.
- DevTools → Network — `/api/*` requests return 200 with `Cookie: cp_session=…` (no `Authorization` header).
- DevTools → Application → Cookies — `cp_session` is HttpOnly + SameSite=Lax.
- Click logout (if a logout button exists; otherwise `await fetch('/auth/logout', {method:'POST'})` in the console). Refresh — back to login page.

- [ ] **Step 3: Bearer still works for scripts**

```bash
TOK=$(grep ^CONTROLLER_API_TOKENS .env | sed 's/^[^=]*=//' | cut -d',' -f1 | cut -d':' -f2-)
curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1:8080/api/applications | head -c 200
echo
# expected: a JSON array (possibly empty)
```

- [ ] **Step 4: Bot start/stop (optional, if you have a real TELEGRAM_TOKEN)**

If you have a real Telegram bot token, set it in `.env`, restart, and `/status` from Telegram should produce an "_no applications_" reply (or the actual app list). `Ctrl-C` on the controller should stop polling within a couple of seconds.

- [ ] **Step 5: Stop and confirm clean shutdown**

```bash
kill -INT $CTRL_PID
wait $CTRL_PID
# exit code should be 0
echo "exit: $?"
```

Expected logs:
```
controller:shutdown
```

No hung promises, no "shutdown:error" lines.

- [ ] **Step 6: No follow-up commit needed if everything passes**

If anything failed, fix and commit the fix; if all green, the plan is complete.

---

## Summary of commits (target sequence)

1. `chore(controller): add bcryptjs, cookie-parser, cookie-signature`
2. `feat(scripts): add dashboard:hash bcrypt helper`
3. `feat(auth): add signed session cookie + bcrypt password helpers`
4. `feat(auth): add requireAuth middleware accepting bearer or cookie`
5. `feat(api): add /auth/login, /auth/logout, /auth/me routes`
6. `feat(controller): expose DASHBOARD_PASSWORD_HASH and isProd in config`
7. `feat(controller): wire cookies, /auth routes, and bearer-or-cookie auth`
8. `feat(ws): require session cookie on /ui upgrade`
9. `feat(web): move SPA assets into controller/public, drop bootstrap.js`
10. `feat(web): add login page`
11. `feat(controller): serve SPA static assets from controller/public`
12. `chore(controller): add node-telegram-bot-api dep`
13. `feat(bot): move format helper into controller/src/bot`
14. `feat(bot): in-process BotApi adapter (no HTTP loopback)`
15. `feat(bot): startBot() runs in-process, calls BotApi directly`
16. `feat(controller): start in-process bot at boot, stop on shutdown`
17. `chore: drop bot/ and web/ workspaces (folded into controller)`
18. `docs(env): drop web/proxy vars, document DASHBOARD_PASSWORD_HASH`
19. `docs(claude): document two-process layout and cookie session auth`
