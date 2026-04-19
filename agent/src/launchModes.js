// Launch mode helpers. Each returns the shell command to run for a given
// lifecycle action. The contract is:
//   - start:  detaches, leaves something we can later stop/status.
//   - stop:   idempotent (exit 0 if already stopped).
//   - status: exit 0 = running; non-zero = stopped.

import { LaunchMode } from '@cp/shared/constants';
import { PermanentError } from '@cp/shared/errors';

const CP_DIR = '.cp';

export function startCmdForLaunch(app) {
  switch (app.launchMode) {
    case LaunchMode.WRAPPED: return wrappedStart(app);
    case LaunchMode.RAW:     return app.startCmd;
    default:
      throw new PermanentError(`launchMode '${app.launchMode}' not implemented on agent`);
  }
}

export function stopCmdForLaunch(app) {
  switch (app.launchMode) {
    case LaunchMode.WRAPPED: return wrappedStop();
    case LaunchMode.RAW:     return app.stopCmd;
    default:
      throw new PermanentError(`launchMode '${app.launchMode}' not implemented on agent`);
  }
}

export function statusCmdForLaunch(app) {
  switch (app.launchMode) {
    case LaunchMode.WRAPPED: return wrappedStatus();
    case LaunchMode.RAW:     return app.statusCmd ?? null;
    default:
      throw new PermanentError(`launchMode '${app.launchMode}' not implemented on agent`);
  }
}

// ─── wrapped: nohup + setsid + PID file ────────────────────────────────
function wrappedStart(app) {
  const inner = app.startCmd.replace(/'/g, `'\\''`);
  return [
    `mkdir -p ${CP_DIR}`,
    `setsid nohup bash -c '${inner} >> ${CP_DIR}/stdout.log 2>> ${CP_DIR}/stderr.log & echo $! > ${CP_DIR}/pid'`
      + ` </dev/null >/dev/null 2>&1 &`,
    `disown || true`,
    `sleep 0.5 && test -s ${CP_DIR}/pid`,
  ].join(' && ');
}

function wrappedStop() {
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
}

function wrappedStatus() {
  return [
    `p=$(cat ${CP_DIR}/pid 2>/dev/null);`,
    `[ -n "$p" ] && kill -0 "$p" 2>/dev/null && echo running $p || { echo stopped; exit 1; }`,
  ].join(' ');
}
