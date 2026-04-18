// Supervises long-running application processes (the actual app, not builds).
//
// Scope: in-memory tracking per agent process. If the agent restarts, it
// loses visibility into previously-started apps and must re-discover them
// — a production deployment should use systemd / PM2 beneath this layer.
//
// Idempotency:
//   - start() on an already-running app is a no-op.
//   - stop() on a stopped app is a no-op.
//   - restart() is stop() then start(); never leaves the app in "both" state.

import { spawn } from 'node:child_process';
import { ProcessState } from '@cp/shared/constants';

export class ProcessManager {
  constructor({ logger }) {
    this.logger = logger;
    /** @type {Map<number, AppProcess>} */
    this.procs = new Map();
  }

  snapshot() {
    const now = Date.now();
    const out = [];
    for (const [appId, p] of this.procs) {
      out.push({
        id: appId,
        state: p.state,
        pid: p.pid ?? null,
        uptimeSeconds: p.startedAt ? Math.floor((now - p.startedAt) / 1000) : null,
        lastExitCode: p.lastExitCode ?? null,
      });
    }
    return out;
  }

  isRunning(appId) {
    const p = this.procs.get(appId);
    return !!p && p.state === ProcessState.RUNNING;
  }

  start(app, { onChunk } = {}) {
    if (this.isRunning(app.id)) {
      this.logger.info({ appId: app.id }, 'pm:start:already-running');
      return { alreadyRunning: true };
    }

    const child = spawn(app.startCmd, {
      cwd: app.workdir,
      env: { ...process.env, ...(app.env ?? {}) },
      shell: true,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const entry = {
      child,
      pid: child.pid,
      state: ProcessState.STARTING,
      startedAt: Date.now(),
      lastExitCode: null,
    };
    this.procs.set(app.id, entry);

    // Heuristic: if we're still alive a moment later, consider it running.
    const becomeRunning = setTimeout(() => {
      if (this.procs.get(app.id) === entry && entry.child.exitCode === null) {
        entry.state = ProcessState.RUNNING;
      }
    }, 500);

    child.stdout.on('data', (buf) => onChunk?.({ stream: 'stdout', data: buf }));
    child.stderr.on('data', (buf) => onChunk?.({ stream: 'stderr', data: buf }));

    child.on('exit', (code, signal) => {
      clearTimeout(becomeRunning);
      entry.lastExitCode = code;
      entry.state = code === 0 ? ProcessState.STOPPED : ProcessState.CRASHED;
      this.logger.info({ appId: app.id, code, signal }, 'pm:process-exit');
    });
    child.on('error', (err) => {
      clearTimeout(becomeRunning);
      entry.state = ProcessState.CRASHED;
      this.logger.error({ appId: app.id, err: err.message }, 'pm:process-error');
    });

    return { pid: entry.pid };
  }

  async stop(appId, { graceMs = 10_000 } = {}) {
    const entry = this.procs.get(appId);
    if (!entry || entry.state === ProcessState.STOPPED || entry.child.exitCode !== null) {
      return { alreadyStopped: true };
    }
    try { entry.child.kill('SIGTERM'); } catch { /* noop */ }

    const exited = await new Promise((resolve) => {
      const t = setTimeout(() => {
        try { entry.child.kill('SIGKILL'); } catch { /* noop */ }
        resolve(false);
      }, graceMs);
      entry.child.once('exit', () => { clearTimeout(t); resolve(true); });
    });

    entry.state = ProcessState.STOPPED;
    return { graceful: exited };
  }

  async restart(app, opts) {
    await this.stop(app.id, opts);
    return this.start(app, opts);
  }
}
