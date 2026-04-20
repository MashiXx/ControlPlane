// State scheduler — the controller's replacement for agent heartbeats.
//
// Every STATE_POLL_INTERVAL_MS (default 30s) we:
//
//   1. For every non-'draining' server: `ssh <host> echo __cp_probe_ok__`.
//      - Success  → mark 'online', reset miss counter.
//      - Failure  → increment miss; at STATE_POLL_MISS_LIMIT in a row the
//                   server flips to 'unreachable' and apps on it are marked
//                   'unknown'.
//
//   2. For every enabled app on an online server: run a per-launch-mode
//      status probe. The result updates applications.process_state / pid /
//      uptime_seconds.
//
//   3. After each update we invoke the alert manager so a regression vs.
//      expected_state pages the operator (same contract as before, just
//      driven by our own polling instead of an agent heartbeat).
//
// This module owns no state beyond a Map<serverId, missCount>. Everything
// else is persisted in the DB, so controller restart picks up cleanly.

import {
  ProcessState, ServerStatus,
  STATE_POLL_INTERVAL_MS, STATE_POLL_MISS_LIMIT,
} from '@cp/shared/constants';
import { createLogger } from '@cp/shared/logger';

import { runSsh, shellSafe } from '../ssh/sshClient.js';
import { servers, applications } from '../db/repositories.js';

const logger = createLogger({ service: 'controller.stateScheduler' });

const PROBE_OK_MARKER = '__cp_probe_ok__';

export class StateScheduler {
  constructor({ alertManager, broadcastUi, intervalMs } = {}) {
    this.alertManager = alertManager ?? null;
    this.broadcastUi  = broadcastUi ?? (() => {});
    this.intervalMs   = intervalMs ?? STATE_POLL_INTERVAL_MS;
    this.missCounts   = new Map();  // serverId → consecutive misses
    this._timer = null;
    this._running = false;
  }

  start() {
    if (this._timer) return;
    // First sweep fires immediately; after that every intervalMs.
    this._timer = setInterval(() => this._runSweep().catch(() => {}), this.intervalMs);
    setImmediate(() => this._runSweep().catch(() => {}));
    logger.info({ intervalMs: this.intervalMs }, 'state-scheduler:started');
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  async _runSweep() {
    if (this._running) return;  // overlap-guard: a slow sweep must not stack
    this._running = true;
    try {
      const allServers = await servers.list();
      await Promise.all(allServers.map((s) => this._pollServer(s).catch((err) =>
        logger.warn({ err: err.message, serverId: s.id }, 'poll:server-error'),
      )));
    } finally {
      this._running = false;
    }
  }

  async _pollServer(server) {
    if (server.status === ServerStatus.DRAINING) return;
    if (!server.hostname) return;

    try {
      const r = await runSsh(server.hostname, `echo ${PROBE_OK_MARKER}`, { timeoutMs: 10_000 });
      if (r.exitCode !== 0 || !r.stdoutTail.includes(PROBE_OK_MARKER)) {
        return this._markMiss(server);
      }
    } catch (err) {
      return this._markMiss(server, err);
    }

    // Reachable — reset miss counter, stamp online.
    this.missCounts.delete(server.id);
    await servers.updateStatus(server.id, ServerStatus.ONLINE).catch(() => {});

    // App-level polling. Done sequentially per server to keep the number of
    // concurrent ssh processes bounded (one per server at a time).
    const apps = await this._listEnabledApps(server.id);
    for (const app of apps) {
      await this._pollApp(server, app).catch((err) =>
        logger.warn({ err: err.message, appId: app.id }, 'poll:app-error'),
      );
    }
  }

  async _listEnabledApps(serverId) {
    // No tailored repo method; cheap enough to filter a list() result.
    const rows = await applications.list();
    return rows.filter((a) => a.server_id === serverId && a.enabled === 1);
  }

  async _markMiss(server, err) {
    const n = (this.missCounts.get(server.id) ?? 0) + 1;
    this.missCounts.set(server.id, n);
    logger.debug({
      serverId: server.id, misses: n, err: err?.message,
    }, 'poll:miss');

    if (n >= STATE_POLL_MISS_LIMIT && server.status !== ServerStatus.UNREACHABLE) {
      await servers.updateStatus(server.id, ServerStatus.UNREACHABLE).catch(() => {});
      logger.warn({ serverId: server.id, misses: n }, 'server:unreachable');
      // Flip every app on the unreachable server to 'unknown' and let the
      // alert detector decide whether to page.
      const apps = await this._listEnabledApps(server.id);
      for (const app of apps) {
        await applications.updateProcessState(app.id, { state: ProcessState.UNKNOWN }).catch(() => {});
        if (this.alertManager) {
          const fresh = await applications.get(app.id).catch(() => null);
          if (fresh) await this.alertManager.evaluate(fresh, ProcessState.UNKNOWN, {
            serverId: server.id,
          });
        }
      }
    }
  }

  async _pollApp(server, app) {
    // Remote status command, composed on the fly (we can't import remoteExec
    // without a circular dep via the worker, so we inline the small bit we
    // need here).
    const probe = composeStatusProbe(app);
    if (!probe) return;  // no way to probe this app (launch_mode='raw' without status_cmd)

    let r;
    try {
      r = await runSsh(server.hostname, probe.cmd, { timeoutMs: 10_000 });
    } catch (err) {
      // Single transient failure → mark UNKNOWN; don't propagate up, the
      // server-level miss counter handles repeated failures.
      await this._updateApp(app, { state: ProcessState.UNKNOWN });
      return;
    }

    const { state, pid, uptime } = probe.parse(r);
    await this._updateApp(app, { state, pid, uptime });

    if (this.alertManager) {
      const fresh = await applications.get(app.id).catch(() => null);
      if (fresh) await this.alertManager.evaluate(fresh, state, {
        serverId: server.id, pid,
      });
    }
  }

  async _updateApp(app, patch) {
    await applications.updateProcessState(app.id, patch).catch(() => {});
    this.broadcastUi({
      op: 'state',
      serverId: app.server_id,
      apps: [{ id: app.id, state: patch.state, pid: patch.pid ?? null, uptimeSeconds: patch.uptime ?? null }],
    });
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────
// composeStatusProbe is inlined here rather than imported from remoteExec
// because the poller runs on a timer and we want zero coupling to the
// worker/exec pipeline.
function composeStatusProbe(app) {
  const mode = app.launch_mode ?? 'wrapped';
  if (!app.remote_install_path) return null;
  shellSafe(app.remote_install_path);
  const currentDir = `${app.remote_install_path}/current`;

  if (mode === 'wrapped') {
    // Echoes: `running <pid> <etimes>` OR `stopped` with exit 1.
    const cmd = `cd ${currentDir} 2>/dev/null && `
      + `p=$(cat .cp/pid 2>/dev/null); `
      + `if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then `
      +   `up=$(ps -o etimes= -p "$p" 2>/dev/null | tr -d ' '); `
      +   `echo "running $p \${up:-0}"; `
      + `else echo stopped; exit 1; fi`;
    return { cmd, parse: parseWrappedStatus };
  }

  if (mode === 'systemd' && app.status_cmd) {
    // Typically `systemctl is-active <unit>` — exit 0 = active.
    return {
      cmd: app.status_cmd,
      parse: (r) => r.exitCode === 0
        ? { state: 'running', pid: null, uptime: null }
        : { state: 'stopped', pid: null, uptime: null },
    };
  }

  if (mode === 'raw' && app.status_cmd) {
    return {
      cmd: `cd ${currentDir} 2>/dev/null; ${app.status_cmd}`,
      parse: (r) => r.exitCode === 0
        ? { state: 'running', pid: null, uptime: null }
        : { state: 'stopped', pid: null, uptime: null },
    };
  }

  return null;
}

function parseWrappedStatus(r) {
  if (r.exitCode !== 0) return { state: 'stopped', pid: null, uptime: null };
  const m = /running\s+(\d+)\s+(\d+)/.exec(r.stdoutTail);
  if (!m) return { state: 'running', pid: null, uptime: null };
  return {
    state: 'running',
    pid: Number(m[1]),
    uptime: Number(m[2]),
  };
}
