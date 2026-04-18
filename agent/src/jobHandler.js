// Translates a WS `execute` frame into concrete agent work.
//
// Per-action pipelines:
//   start        → pm.start
//   stop         → pm.stop
//   restart      → pm.restart (stop then start, idempotent)
//   build        → (clone/pull) → install → build
//   deploy       → pull → install → build → restart
//   healthcheck  → runOnce(healthCmd) and interpret exit code
//
// All output chunks are forwarded to the WS client as LOG_CHUNK frames
// via the provided `sendChunk(jobId, stream, buffer)` callback.

import path from 'node:path';
import fs from 'node:fs/promises';

import { JobAction } from '@cp/shared/constants';
import { PermanentError, TransientError, ValidationError } from '@cp/shared/errors';
import { runOnce } from './executor.js';
import { ensureSafe, resolveCommand } from './commandWhitelist.js';

export async function handleExecute(frame, { pm, sendChunk, logger }) {
  const { jobId, action, app, timeoutMs } = frame;
  const onChunk = (chunk) => sendChunk(jobId, chunk.stream, chunk.data);

  await ensureWorkdir(app.workdir);

  switch (action) {
    case JobAction.START: {
      ensureSafe(app.startCmd, { trusted: app.trusted });
      const out = pm.start(app, { onChunk });
      return ok({ exitCode: 0, message: out.alreadyRunning ? 'already-running' : `pid=${out.pid}` });
    }

    case JobAction.STOP: {
      const out = await pm.stop(app.id);
      return ok({ exitCode: 0, message: out.alreadyStopped ? 'already-stopped' : (out.graceful ? 'graceful' : 'forced') });
    }

    case JobAction.RESTART: {
      ensureSafe(app.startCmd, { trusted: app.trusted });
      const out = await pm.restart(app, { onChunk });
      return ok({ exitCode: 0, message: `pid=${out.pid ?? '-'}` });
    }

    case JobAction.HEALTHCHECK: {
      const cmd = resolveCommand(JobAction.HEALTHCHECK, app);
      if (!cmd) throw new ValidationError('healthCmd not configured');
      ensureSafe(cmd, { trusted: app.trusted });
      const r = await runOnce(cmd, { cwd: app.workdir, onChunk, timeoutMs: timeoutMs ?? 30_000 });
      if (r.exitCode !== 0) throw new TransientError(`healthcheck failed exit=${r.exitCode}`);
      return r;
    }

    case JobAction.BUILD: {
      const buildCmd = resolveCommand(JobAction.BUILD, app);
      ensureSafe(buildCmd, { trusted: app.trusted });
      await ensureRepo(app, onChunk, logger);
      if (app.installCmd) {
        ensureSafe(app.installCmd, { trusted: app.trusted });
        const r = await runOnce(app.installCmd, { cwd: app.workdir, env: app.env, onChunk, timeoutMs });
        if (r.exitCode !== 0) throw failForExit('install', r);
      }
      const r = await runOnce(buildCmd, { cwd: app.workdir, env: app.env, onChunk, timeoutMs });
      if (r.exitCode !== 0) throw failForExit('build', r);
      return r;
    }

    case JobAction.DEPLOY: {
      // deploy = pull + install + build + restart
      await ensureRepo(app, onChunk, logger, { forcePull: true });
      if (app.installCmd) {
        ensureSafe(app.installCmd, { trusted: app.trusted });
        const r = await runOnce(app.installCmd, { cwd: app.workdir, env: app.env, onChunk, timeoutMs });
        if (r.exitCode !== 0) throw failForExit('install', r);
      }
      if (app.buildCmd) {
        ensureSafe(app.buildCmd, { trusted: app.trusted });
        const r = await runOnce(app.buildCmd, { cwd: app.workdir, env: app.env, onChunk, timeoutMs });
        if (r.exitCode !== 0) throw failForExit('build', r);
      }
      ensureSafe(app.startCmd, { trusted: app.trusted });
      const out = await pm.restart(app, { onChunk });
      return ok({ exitCode: 0, message: `deployed pid=${out.pid ?? '-'}` });
    }

    default:
      throw new PermanentError(`unsupported action: ${action}`, { code: 'E_UNSUPPORTED_ACTION' });
  }
}

function ok(partial) {
  return { exitCode: 0, stdoutTail: '', stderrTail: '', durationMs: 0, ...partial };
}

function failForExit(phase, result) {
  const err = new TransientError(`${phase} failed exit=${result.exitCode}`, {
    code: `E_${phase.toUpperCase()}_FAILED`,
    meta: { exitCode: result.exitCode, stderrTail: result.stderrTail?.slice(-2048) },
  });
  return err;
}

async function ensureWorkdir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function ensureRepo(app, onChunk, logger, { forcePull = false } = {}) {
  if (!app.repoUrl) return;
  const gitDir = path.join(app.workdir, '.git');
  let cloned = false;
  try {
    await fs.stat(gitDir);
  } catch {
    logger.info({ appId: app.id, workdir: app.workdir }, 'git:clone');
    const r = await runOnce(`git clone --branch ${shellArg(app.branch)} ${shellArg(app.repoUrl)} .`, {
      cwd: app.workdir, onChunk,
    });
    if (r.exitCode !== 0) throw failForExit('clone', r);
    cloned = true;
  }
  if (!cloned || forcePull) {
    const r = await runOnce(
      `git fetch --prune && git checkout ${shellArg(app.branch)} && git pull --ff-only`,
      { cwd: app.workdir, onChunk },
    );
    if (r.exitCode !== 0) throw failForExit('pull', r);
  }
}

function shellArg(s) {
  // Minimal single-quote escaping for shell args.
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
