// State scheduler — the controller's replacement for agent heartbeats.
//
// Every STATE_POLL_INTERVAL_MS (default 30s) we:
//
//   1. Load every enabled replica from application_servers (joined with
//      servers and applications) via applicationServers.listForPoller().
//      Replicas are grouped by server so we make at most one reachability
//      ping per server per sweep.
//
//   2. For every non-'draining' server: `ssh <host> echo __cp_probe_ok__`.
//      - Success  → mark 'online', reset miss counter.
//      - Failure  → increment miss; at STATE_POLL_MISS_LIMIT in a row the
//                   server flips to 'unreachable' and all its replicas are
//                   marked 'unknown'.
//
//   3. For every enabled replica on an online server: run a per-launch-mode
//      status probe. The result updates application_servers.process_state /
//      pid / uptime_seconds.
//
//   4. After each replica update we invoke the alert manager so a regression
//      vs. expected_state pages the operator.
//
// This module owns no state beyond a Map<serverId, missCount>. Everything
// else is persisted in the DB, so controller restart picks up cleanly.

import {
  ProcessState, ServerStatus,
  STATE_POLL_INTERVAL_MS, STATE_POLL_MISS_LIMIT,
} from '@cp/shared/constants';
import { createLogger } from '@cp/shared/logger';

import { runSsh, shellSafe } from '../ssh/sshClient.js';
import { servers, applicationServers } from '../db/repositories.js';

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
    if (this._running) return;
    this._running = true;
    try {
      const replicas = await applicationServers.listForPoller();

      // Group replicas by server so we make at most one reachability ping per
      // server per sweep.
      const byServer = new Map(); // serverId → { server, replicas: [] }
      for (const r of replicas) {
        if (!byServer.has(r.server_id)) {
          byServer.set(r.server_id, {
            server: {
              id: r.server_id,
              hostname: r.hostname,
              name: r.server_name,
              status: r.server_status,
            },
            replicas: [],
          });
        }
        byServer.get(r.server_id).replicas.push(r);
      }

      await Promise.all([...byServer.values()].map((entry) =>
        this._pollServer(entry).catch((err) =>
          logger.warn({ err: err.message, serverId: entry.server.id }, 'poll:server-error'),
        ),
      ));
    } finally {
      this._running = false;
    }
  }

  async _pollServer({ server, replicas }) {
    if (server.status === ServerStatus.DRAINING) return;
    if (!server.hostname) return;

    try {
      const r = await runSsh(server.hostname, `echo ${PROBE_OK_MARKER}`, { timeoutMs: 10_000 });
      if (r.exitCode !== 0 || !r.stdoutTail.includes(PROBE_OK_MARKER)) {
        return this._markMiss(server, replicas);
      }
    } catch (err) {
      return this._markMiss(server, replicas, err);
    }

    this.missCounts.delete(server.id);
    await servers.updateStatus(server.id, ServerStatus.ONLINE).catch(() => {});

    for (const replica of replicas) {
      await this._pollReplica(server, replica).catch((err) =>
        logger.warn({ err: err.message, replicaId: replica.replica_id }, 'poll:replica-error'),
      );
    }
  }

  async _markMiss(server, replicas, err) {
    const n = (this.missCounts.get(server.id) ?? 0) + 1;
    this.missCounts.set(server.id, n);
    logger.debug({ serverId: server.id, misses: n, err: err?.message }, 'poll:miss');

    if (n >= STATE_POLL_MISS_LIMIT && server.status !== ServerStatus.UNREACHABLE) {
      await servers.updateStatus(server.id, ServerStatus.UNREACHABLE).catch(() => {});
      await applicationServers.markUnknownForServer(server.id).catch(() => {});
      logger.warn({ serverId: server.id, misses: n }, 'server:unreachable');

      if (this.alertManager) {
        for (const replica of replicas) {
          await this.alertManager.evaluate(
            { ...replica, process_state: ProcessState.UNKNOWN },
            ProcessState.UNKNOWN,
          );
        }
      }
    }
  }

  async _pollReplica(server, replica) {
    const probe = composeStatusProbe(replica);
    if (!probe) return;

    let r;
    try {
      r = await runSsh(server.hostname, probe.cmd, { timeoutMs: 10_000 });
    } catch (err) {
      await applicationServers.updateProcessState(replica.replica_id, { state: ProcessState.UNKNOWN });
      return;
    }

    const { state, pid, uptime } = probe.parse(r);
    await applicationServers.updateProcessState(replica.replica_id, { state, pid, uptime });

    this.broadcastUi({
      op: 'state',
      serverId: server.id,
      replicas: [{
        applicationId: replica.application_id,
        serverId: replica.server_id,
        state, pid: pid ?? null, uptimeSeconds: uptime ?? null,
      }],
    });

    if (this.alertManager) {
      await this.alertManager.evaluate({ ...replica, process_state: state }, state);
    }
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────
// composeStatusProbe is inlined here rather than imported from remoteExec
// because the poller runs on a timer and we want zero coupling to the
// worker/exec pipeline.
//
// The `replica` parameter is a joined row from applicationServers.listForPoller()
// and carries launch_mode, status_cmd, start_cmd, remote_install_path — the
// same fields the old `app` parameter had.
function composeStatusProbe(replica) {
  const mode = replica.launch_mode ?? 'wrapped';
  if (!replica.remote_install_path) return null;
  shellSafe(replica.remote_install_path);
  const currentDir = `${replica.remote_install_path}/current`;

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

  if (mode === 'systemd' && replica.status_cmd) {
    // Typically `systemctl is-active <unit>` — exit 0 = active.
    return {
      cmd: replica.status_cmd,
      parse: (r) => r.exitCode === 0
        ? { state: 'running', pid: null, uptime: null }
        : { state: 'stopped', pid: null, uptime: null },
    };
  }

  if (mode === 'raw' && replica.status_cmd) {
    return {
      cmd: `cd ${currentDir} 2>/dev/null; ${replica.status_cmd}`,
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
