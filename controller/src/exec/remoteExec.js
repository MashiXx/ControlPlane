// Controller-side action logic. Replaces the old agent/jobHandler.js.
//
// Every function here runs entirely on the controller and drives the target
// server over SSH. The old split "controller enqueues, agent executes" is
// gone; the worker calls these functions directly.
//
// Functions:
//   startAction(app, { onChunk })
//   stopAction(app, { onChunk })
//   restartAction(app, { onChunk })
//   healthcheckAction(app, { onChunk, timeoutMs })
//   deployAction(app, artifact, releaseId, { onChunk })
//
// Conventions:
//   - `app` is the hydrated applications row. remote_install_path + hostname
//     must resolve to something shellSafe — both are validated before we
//     embed them in an SSH command.
//   - `onChunk({ stream, data })` is optional; when present, the action
//     streams stdout/stderr live (used for deploy + build). Short actions
//     buffer instead.
//   - A non-zero remote exit is raised as TransientError by default so the
//     queue retries. Healthcheck explicitly wraps it to preserve the
//     "retried-by-worker" semantics the agent path used.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import tar from 'tar-fs';

import { JobAction, LaunchMode, RELEASE_RETENTION_COUNT } from '@cp/shared/constants';
import {
  CommandNotAllowedError, PermanentError, TransientError, ValidationError,
} from '@cp/shared/errors';
import { createLogger } from '@cp/shared/logger';

import { runSsh, runRsync, shellSafe, shellQuote } from '../ssh/sshClient.js';
import { servers } from '../db/repositories.js';

const logger = createLogger({ service: 'controller.remoteExec' });

// ─── command whitelist ──────────────────────────────────────────────────
// Matches the agent's old SUSPICIOUS list exactly. Untrusted apps are
// blocked from `$(…)`, pipe-to-sh, `rm -rf /`, curl|sh.
const SUSPICIOUS = [
  /\brm\s+-rf\s+\//i,
  /[`$]\(/,
  /\|\s*sh\b/i,
  /\b(curl|wget)\b[^|]*\|\s*(sh|bash)\b/i,
];

function ensureSafe(command, { trusted }) {
  if (!command) return;
  if (trusted) return;
  for (const re of SUSPICIOUS) {
    if (re.test(command)) throw new CommandNotAllowedError(command);
  }
}

// ─── host/path resolution ───────────────────────────────────────────────
async function hostFor(app) {
  const server = await servers.get(app.server_id);
  if (!server.hostname) throw new PermanentError(`server ${server.name} has no hostname`);
  return { server, host: server.hostname };
}

function releaseCwd(app) {
  if (!app.remote_install_path) {
    throw new ValidationError(`app ${app.name} has no remote_install_path`);
  }
  shellSafe(app.remote_install_path);
  return path.posix.join(app.remote_install_path, 'current');
}

function envPrefix(envObj) {
  if (!envObj) return '';
  const obj = typeof envObj === 'string' ? safeParseJson(envObj) : envObj;
  if (!obj || typeof obj !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) continue;
    parts.push(`${k}=${shellQuote(String(v))}`);
  }
  return parts.length ? parts.join(' ') + ' ' : '';
}

function safeParseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// ─── launch-mode command composition ────────────────────────────────────
//
// These used to live in agent/src/launchModes.js. We compose them here
// instead and embed the result in a `bash -lc '…'` wrapper sent to the
// remote host.
const CP_DIR = '.cp';

function composeStartCmd(app) {
  const mode = app.launch_mode ?? LaunchMode.WRAPPED;
  const envStr = envPrefix(app.env);
  switch (mode) {
    case LaunchMode.WRAPPED: {
      const inner = `${envStr}${app.start_cmd}`.replace(/'/g, `'\\''`);
      return [
        `mkdir -p ${CP_DIR}`,
        `setsid nohup bash -c '${inner} >> ${CP_DIR}/stdout.log 2>> ${CP_DIR}/stderr.log & echo $! > ${CP_DIR}/pid'`
          + ` </dev/null >/dev/null 2>&1 &`,
        `disown || true`,
        `sleep 0.5 && test -s ${CP_DIR}/pid`,
      ].join(' && ');
    }
    case LaunchMode.RAW:
      return `${envStr}${app.start_cmd}`;
    case LaunchMode.SYSTEMD: {
      if (!app.status_cmd && !app.start_cmd) {
        throw new ValidationError('systemd launch mode requires start_cmd set to `systemctl start <unit>` or similar');
      }
      return app.start_cmd;
    }
    default:
      throw new ValidationError(`unsupported launch_mode: ${mode}`);
  }
}

function composeStopCmd(app) {
  const mode = app.launch_mode ?? LaunchMode.WRAPPED;
  switch (mode) {
    case LaunchMode.WRAPPED:
      return [
        `if [ -s ${CP_DIR}/pid ]; then`,
        `  p=$(cat ${CP_DIR}/pid);`,
        `  if kill -0 "$p" 2>/dev/null; then`,
        `    kill -TERM "$p";`,
        `    for i in $(seq 1 20); do kill -0 "$p" 2>/dev/null || break; sleep 0.5; done;`,
        `    kill -0 "$p" 2>/dev/null && kill -KILL "$p" || true;`,
        `  fi;`,
        `  rm -f ${CP_DIR}/pid;`,
        `fi; exit 0`,
      ].join(' ');
    case LaunchMode.RAW:
    case LaunchMode.SYSTEMD:
      return app.stop_cmd || null;
    default:
      return null;
  }
}

function composeStatusCmd(app) {
  const mode = app.launch_mode ?? LaunchMode.WRAPPED;
  switch (mode) {
    case LaunchMode.WRAPPED:
      return [
        `p=$(cat ${CP_DIR}/pid 2>/dev/null);`,
        `if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then`,
        `  up=$(ps -o etimes= -p "$p" 2>/dev/null | tr -d ' ');`,
        `  echo "running $p ${'$'}{up:-0}";`,
        `else`,
        `  echo stopped; exit 1;`,
        `fi`,
      ].join(' ');
    case LaunchMode.RAW:
      return app.status_cmd || null;
    case LaunchMode.SYSTEMD:
      return app.status_cmd || null;
    default:
      return null;
  }
}

// Wrap any remote command so it runs inside <remote_install_path>/current
// unless the caller supplies a different cwd (build/healthcheck sometimes
// want `workdir` instead).
function wrapInCwd(cmd, cwd) {
  if (!cmd) return null;
  return `cd ${shellSafe(cwd)} && ${cmd}`;
}

// ─── actions ────────────────────────────────────────────────────────────
export async function startAction(app, { onChunk } = {}) {
  ensureSafe(app.start_cmd, { trusted: Boolean(app.trusted) });
  const { host } = await hostFor(app);
  const cwd = releaseCwd(app);
  const cmd = composeStartCmd(app);
  const r = await runSsh(host, wrapInCwd(cmd, cwd), { timeoutMs: 60_000, onChunk });
  if (r.exitCode !== 0) throw failForExit('start', r);
  return r;
}

export async function stopAction(app, { onChunk } = {}) {
  const { host } = await hostFor(app);
  const cwd = releaseCwd(app);
  const cmd = composeStopCmd(app);
  if (!cmd) {
    // raw/systemd without stop_cmd: nothing to do — treat as already-stopped.
    return { exitCode: 0, stdoutTail: 'no stop_cmd configured', stderrTail: '', durationMs: 0 };
  }
  const r = await runSsh(host, wrapInCwd(cmd, cwd), { timeoutMs: 90_000, onChunk });
  // stop is idempotent — we accept any clean exit.
  return r;
}

export async function restartAction(app, { onChunk } = {}) {
  ensureSafe(app.start_cmd, { trusted: Boolean(app.trusted) });
  await stopAction(app, { onChunk });
  return startAction(app, { onChunk });
}

export async function healthcheckAction(app, { onChunk, timeoutMs } = {}) {
  if (!app.health_cmd) throw new ValidationError(`app ${app.name} has no health_cmd`);
  ensureSafe(app.health_cmd, { trusted: Boolean(app.trusted) });
  const { host } = await hostFor(app);
  const cwd = releaseCwd(app);
  const r = await runSsh(host, wrapInCwd(app.health_cmd, cwd), {
    timeoutMs: timeoutMs ?? 30_000,
    onChunk,
  });
  if (r.exitCode !== 0) {
    throw new TransientError(`healthcheck failed exit=${r.exitCode}`, {
      code: 'E_HEALTHCHECK_FAILED',
      meta: { exitCode: r.exitCode, stderrTail: r.stderrTail?.slice(-2048) },
    });
  }
  return r;
}

/**
 * Stage an artifact on a target server and (re)start the app.
 *
 * Pipeline:
 *   1. Extract controller-local tar.gz → local staging dir.
 *   2. `ssh host mkdir -p <install>/releases/<release>`.
 *   3. `rsync -az --delete staging/ host:<install>/releases/<release>/`.
 *   4. Atomic swap: `ln -sfn …/<release> …/current.tmp && mv -T current.tmp current`.
 *   5. `stop_cmd` in current/ (idempotent).
 *   6. `start_cmd` in current/.
 *   7. GC old releases, keep the newest RELEASE_RETENTION_COUNT.
 *   8. Local staging dir removed in a `finally`.
 */
export async function deployAction(app, artifact, releaseId, opts = {}) {
  const { onChunk, stagingBase } = opts;
  if (!artifact?.path) throw new ValidationError('deploy: artifact.path missing');
  if (!releaseId) throw new ValidationError('deploy: releaseId missing');
  if (!app.remote_install_path) throw new ValidationError('deploy: remote_install_path missing');
  ensureSafe(app.start_cmd, { trusted: Boolean(app.trusted) });

  const { host } = await hostFor(app);
  const installPath = shellSafe(app.remote_install_path);
  const safeRelease = shellSafe(String(releaseId));
  const releaseDir = path.posix.join(installPath, 'releases', safeRelease);
  const currentLink = path.posix.join(installPath, 'current');

  const base = stagingBase ?? os.tmpdir();
  await fs.mkdir(base, { recursive: true });
  const staging = await fs.mkdtemp(path.join(base, `cp-stage-${artifact.id}-`));

  try {
    // 1. extract locally
    await pipeline(
      createReadStream(artifact.path),
      createGunzip(),
      tar.extract(staging),
    );
    log(onChunk, `staged artifact #${artifact.id} locally at ${staging}\n`);

    // 2. remote mkdir
    await runSsh(host, `mkdir -p ${releaseDir}`, { timeoutMs: 30_000 });

    // 3. rsync push
    await runRsync(staging, host, releaseDir + '/', {
      timeoutMs: 20 * 60 * 1000,
      onChunk,
    });
    log(onChunk, `rsynced to ${host}:${releaseDir}\n`);

    // 4. atomic symlink swap
    const swapCmd = `ln -sfn ${releaseDir} ${currentLink}.tmp && mv -Tf ${currentLink}.tmp ${currentLink}`;
    const swap = await runSsh(host, swapCmd, { timeoutMs: 30_000 });
    if (swap.exitCode !== 0) throw failForExit('symlink-swap', swap);
    log(onChunk, `swapped ${currentLink} → ${releaseDir}\n`);

    // 5. stop (idempotent)
    const stopRemote = composeStopCmd(app);
    if (stopRemote) {
      await runSsh(host, wrapInCwd(stopRemote, currentLink), { timeoutMs: 90_000, onChunk });
    }

    // 6. start
    const startRemote = composeStartCmd(app);
    const startRes = await runSsh(host, wrapInCwd(startRemote, currentLink), {
      timeoutMs: 60_000, onChunk,
    });
    if (startRes.exitCode !== 0) throw failForExit('start', startRes);

    // 7. GC old releases
    const gcCmd = [
      `cd ${path.posix.join(installPath, 'releases')}`,
      // newest first by directory name (release ids sort lexically since they
      // start with <unix_ts>); keep the top N.
      `ls -1 | sort -r | tail -n +$((${Number(RELEASE_RETENTION_COUNT) + 1})) | xargs -r -I{} rm -rf -- {}`,
    ].join(' && ');
    await runSsh(host, gcCmd, { timeoutMs: 60_000 }).catch((err) => {
      logger.warn({ err: err.message, appId: app.id }, 'deploy:gc-failed');
    });

    return {
      exitCode: 0,
      releaseDir,
      message: `deployed release=${releaseId} sha=${artifact.sha256?.slice(0, 12)}`,
      stdoutTail: `release=${releaseId}\nreleaseDir=${releaseDir}\n`,
      stderrTail: startRes.stderrTail ?? '',
      durationMs: startRes.durationMs ?? 0,
    };
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── helpers ────────────────────────────────────────────────────────────
function failForExit(phase, result) {
  return new TransientError(`${phase} failed exit=${result.exitCode}`, {
    code: `E_${phase.replace('-', '_').toUpperCase()}_FAILED`,
    meta: {
      exitCode: result.exitCode,
      stderrTail: result.stderrTail?.slice(-2048),
      stdoutTail: result.stdoutTail?.slice(-1024),
    },
  });
}

function log(onChunk, text) {
  if (!onChunk) return;
  try { onChunk({ stream: 'stdout', data: Buffer.from(text, 'utf8') }); } catch { /* noop */ }
}

// Export the action map so the job worker can dispatch by action name.
export const ACTIONS = Object.freeze({
  [JobAction.START]:       startAction,
  [JobAction.STOP]:        stopAction,
  [JobAction.RESTART]:     restartAction,
  [JobAction.HEALTHCHECK]: healthcheckAction,
});
