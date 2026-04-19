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

import { JobAction, BuildStrategy, LaunchMode } from '@cp/shared/constants';
import { PermanentError, TransientError, ValidationError } from '@cp/shared/errors';
import { runOnce } from './executor.js';
import { ensureSafe, resolveCommand } from './commandWhitelist.js';
import { stageArtifact } from './artifactPuller.js';
import { startCmdForLaunch, stopCmdForLaunch, statusCmdForLaunch } from './launchModes.js';

export async function handleExecute(frame, { pm, sendChunk, logger }) {
  const { jobId, action, app, artifact, timeoutMs } = frame;
  const onChunk = (chunk) => sendChunk(jobId, chunk.stream, chunk.data);
  const launchCwd = app.remoteInstallPath
    ? path.join(app.remoteInstallPath, 'current')
    : app.workdir;

  await ensureWorkdir(app.workdir);
  if (app.remoteInstallPath) await ensureWorkdir(app.remoteInstallPath);

  switch (action) {
    case JobAction.START: {
      ensureSafe(app.startCmd, { trusted: app.trusted });
      const cmd = startCmdForLaunch(app);
      const r = await runOnce(cmd, { cwd: launchCwd, env: app.env, onChunk, timeoutMs: 30_000 });
      if (r.exitCode !== 0) throw failForExit('start', r);
      return r;
    }

    case JobAction.STOP: {
      const cmd = stopCmdForLaunch(app);
      if (!cmd) {
        // no stop_cmd configured and not wrapped — legacy PM path
        const out = await pm.stop(app.id);
        return ok({ exitCode: 0, message: out.alreadyStopped ? 'already-stopped' : 'stopped' });
      }
      const r = await runOnce(cmd, { cwd: launchCwd, onChunk, timeoutMs: 60_000 });
      return r;  // stop must be idempotent → exit 0
    }

    case JobAction.RESTART: {
      ensureSafe(app.startCmd, { trusted: app.trusted });
      const stopCmd = stopCmdForLaunch(app);
      if (stopCmd) await runOnce(stopCmd, { cwd: launchCwd, onChunk, timeoutMs: 60_000 });
      const startCmd = startCmdForLaunch(app);
      const r = await runOnce(startCmd, { cwd: launchCwd, env: app.env, onChunk, timeoutMs: 30_000 });
      if (r.exitCode !== 0) throw failForExit('start', r);
      return r;
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
      // Two flavours:
      //   A) build_strategy='target' (legacy): pull + install + build + restart in workdir.
      //   B) build_strategy='controller': controller built the artifact, agent
      //      just stages it into remote_install_path/releases/<id>, swaps the
      //      'current' symlink, and restarts.

      if (app.buildStrategy === BuildStrategy.CONTROLLER) {
        if (!artifact) throw new ValidationError('deploy: artifact descriptor missing');
        if (!app.remoteInstallPath) throw new ValidationError('deploy: remoteInstallPath missing');

        const staged = await stageArtifact({
          artifact,
          remoteInstallPath: app.remoteInstallPath,
          log: (msg) => onChunk({ stream: 'stdout', data: Buffer.from(msg + '\n') }),
        });

        // Restart from the 'current' symlink so start_cmd works against the
        // just-staged release atomically.
        ensureSafe(app.startCmd, { trusted: app.trusted });
        const stopCmd  = stopCmdForLaunch(app);
        const startCmd = startCmdForLaunch(app);
        if (stopCmd)  await runOnce(stopCmd,  { cwd: path.join(app.remoteInstallPath, 'current'), onChunk, timeoutMs: 60_000 });
        const r = await runOnce(startCmd, { cwd: path.join(app.remoteInstallPath, 'current'), env: app.env, onChunk, timeoutMs: 30_000 });
        if (r.exitCode !== 0) throw failForExit('start', r);

        return ok({
          exitCode: 0,
          message: `deployed release=${artifact.releaseId} sha=${artifact.sha256.slice(0, 12)}`,
          stdoutTail: `release=${artifact.releaseId}\nreleaseDir=${staged.releaseDir}\n`,
        });
      }

      // target: build in-place then restart
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
