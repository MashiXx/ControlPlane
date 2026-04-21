// AlertManager — centralised alert-on-down detector.
//
// The state scheduler runs an SSH probe every STATE_POLL_INTERVAL_MS (30s
// by default) against each server and each enabled app. For every probe
// result it calls evaluate() here; the manager compares the reported state
// with what the operator *expected* (applications.expected_state, set by the
// orchestrator when start/stop/restart/deploy was enqueued) and fires an
// alert whenever:
//
//   - expected_state = 'running' AND reported state is 'crashed'
//     → real crash, always alerts.
//   - expected_state = 'running' AND reported state is 'stopped' or
//     'unknown' → process vanished without operator consent.
//
// An operator-initiated stop flips expected_state to 'stopped' *before* the
// stop command runs, so the subsequent "stopped" observation is silent.
//
// Debounce: once an alert fires, applications.last_alert_at is stamped and
// we suppress further alerts for the same app until DEBOUNCE_MS elapses —
// otherwise every 10s heartbeat would re-page for a stuck process.

import { ExpectedState, ProcessState } from '@cp/shared/constants';
import { createLogger } from '@cp/shared/logger';
import { applications } from '../db/repositories.js';
import { writeAudit } from '../audit/audit.js';

const logger = createLogger({ service: 'alerts' });

// Don't re-fire for the same app for this long. Long enough to ride out the
// few heartbeats that happen while an operator investigates a crash, short
// enough that a second real incident still pages.
const DEBOUNCE_MS = 5 * 60 * 1000;

const BAD_STATES_WHEN_RUNNING_EXPECTED = new Set([
  ProcessState.CRASHED,
  ProcessState.STOPPED,
  ProcessState.UNKNOWN,
]);

export class AlertManager {
  /**
   * @param {object} opts
   * @param {(frame: object) => void} [opts.broadcastUi] — push an 'alert'
   *   frame to every connected dashboard WebSocket.
   * @param {(text: string) => Promise<void>} [opts.notifyChat] — send an
   *   alert text to the chat (Telegram admin bus). Optional: if absent we
   *   skip the external notify but still audit + broadcast.
   */
  constructor({ broadcastUi, notifyChat } = {}) {
    this.broadcastUi = broadcastUi ?? (() => {});
    this.notifyChat  = notifyChat  ?? (async () => {});
  }

  /**
   * Inspect one application's most recent heartbeat report and fire an alert
   * if the reported state is a regression against expected_state.
   *
   * @param {object} appRow          — hydrated applications row (needs
   *                                   id, name, expected_state, last_alert_at)
   * @param {string} reportedState   — one of ProcessState.*
   * @param {object} [meta]          — serverId, pid, lastExitCode
   */
  async evaluate(appRow, reportedState, meta = {}) {
    if (!appRow) return;
    const expected = appRow.expected_state ?? ExpectedState.STOPPED;
    if (expected !== ExpectedState.RUNNING) return;
    if (!BAD_STATES_WHEN_RUNNING_EXPECTED.has(reportedState)) return;

    const now = Date.now();
    const last = appRow.last_alert_at ? new Date(appRow.last_alert_at).getTime() : 0;
    if (now - last < DEBOUNCE_MS) return;

    // Stamp first so concurrent heartbeats see the debounce immediately.
    await applications.markAlerted(appRow.id).catch(() => {});

    const text = `🚨 ${appRow.name} is ${reportedState} (expected running)`
      + (meta.pid ? ` — pid was ${meta.pid}` : '')
      + (meta.lastExitCode != null ? ` exit=${meta.lastExitCode}` : '');

    logger.warn({
      appId: appRow.id, appName: appRow.name,
      expected, reported: reportedState,
    }, 'alert:app-down');

    await writeAudit({
      actor: 'system', action: 'alert.app-down',
      targetType: 'app', targetId: String(appRow.id),
      result: 'failure', message: text,
      metadata: {
        expected, reported: reportedState,
        serverId: meta.serverId, pid: meta.pid,
        lastExitCode: meta.lastExitCode ?? null,
      },
    });

    this.broadcastUi({
      op: 'alert',
      kind: 'app-down',
      appId: appRow.id, appName: appRow.name,
      state: reportedState, expected,
      at: new Date().toISOString(),
      message: text,
    });

    try { await this.notifyChat(text); }
    catch (err) { logger.warn({ err: err.message }, 'alert:notify-failed'); }
  }
}
