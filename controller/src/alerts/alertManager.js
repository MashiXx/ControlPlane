// AlertManager — per-replica alert-on-down detector.
//
// The state scheduler invokes evaluate(replica, reportedState) for every
// replica it polls. We compare the reported state with the operator's
// expected_state (now stored per-replica in application_servers) and fire
// an alert when:
//   - expected_state = 'running' AND reported state is 'crashed'
//   - expected_state = 'running' AND reported state is 'stopped' or 'unknown'
//
// An operator-initiated stop flips expected_state to 'stopped' *before* the
// stop command runs (orchestrator.applyExpectedState), so the subsequent
// "stopped" observation is silent.

import { ExpectedState, ProcessState } from '@cp/shared/constants';
import { createLogger } from '@cp/shared/logger';
import { applicationServers } from '../db/repositories.js';
import { writeAudit } from '../audit/audit.js';

const logger = createLogger({ service: 'alerts' });

const DEBOUNCE_MS = 5 * 60 * 1000;

const BAD_STATES_WHEN_RUNNING_EXPECTED = new Set([
  ProcessState.CRASHED,
  ProcessState.STOPPED,
  ProcessState.UNKNOWN,
]);

export class AlertManager {
  constructor({ broadcastUi, notifyChat } = {}) {
    this.broadcastUi = broadcastUi ?? (() => {});
    this.notifyChat  = notifyChat  ?? (async () => {});
  }

  /**
   * @param {object} replica  — row with at least:
   *   { replica_id, application_id, server_id, expected_state, last_alert_at,
   *     app_name, server_name }
   * @param {string} reportedState
   * @param {object} [meta]   — pid, lastExitCode
   */
  async evaluate(replica, reportedState, meta = {}) {
    if (!replica) return;
    const expected = replica.expected_state ?? ExpectedState.STOPPED;
    if (expected !== ExpectedState.RUNNING) return;
    if (!BAD_STATES_WHEN_RUNNING_EXPECTED.has(reportedState)) return;

    const now = Date.now();
    const last = replica.last_alert_at ? new Date(replica.last_alert_at).getTime() : 0;
    if (now - last < DEBOUNCE_MS) return;

    await applicationServers.markAlerted(replica.replica_id).catch(() => {});

    const appName    = replica.app_name    ?? `app#${replica.application_id}`;
    const serverName = replica.server_name ?? `server#${replica.server_id}`;
    const text = `🚨 ${appName} @ ${serverName} is ${reportedState} (expected running)`
      + (meta.pid != null ? ` — pid was ${meta.pid}` : '')
      + (meta.lastExitCode != null ? ` exit=${meta.lastExitCode}` : '');

    logger.warn({
      appId: replica.application_id, appName,
      serverId: replica.server_id, serverName,
      expected, reported: reportedState,
    }, 'alert:replica-down');

    await writeAudit({
      actor: 'system', action: 'alert.app-down',
      targetType: 'application_server', targetId: String(replica.replica_id),
      result: 'failure', message: text,
      metadata: {
        applicationId: replica.application_id, serverId: replica.server_id,
        expected, reported: reportedState,
        pid: meta.pid ?? null, lastExitCode: meta.lastExitCode ?? null,
      },
    });

    this.broadcastUi({
      op: 'alert',
      kind: 'app-down',
      applicationId: replica.application_id, appName,
      serverId: replica.server_id, serverName,
      state: reportedState, expected,
      at: new Date().toISOString(),
      message: text,
    });

    try { await this.notifyChat(text); }
    catch (err) { logger.warn({ err: err.message }, 'alert:notify-failed'); }
  }
}
