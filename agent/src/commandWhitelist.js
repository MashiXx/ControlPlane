// Command resolution + safety checks.
//
// The agent never receives raw shell strings from ad-hoc API callers.
// The controller sends an `execute` frame containing the app's DB-side
// config (stop/start/install/build/health commands). For a given action,
// we resolve which command to run. If the app is not `trusted`, we also
// run a shallow sanity check to catch obvious injection / subshell
// misuse introduced via config.

import { JobAction } from '@cp/shared/constants';
import { CommandNotAllowedError, ValidationError } from '@cp/shared/errors';

// Tokens that look like attempts to chain commands beyond what the
// user defined in config. Rejected for untrusted apps.
const SUSPICIOUS = [
  /\brm\s+-rf\s+\//i,
  /[`$]\(/,      // $( … )
  /\|\s*sh\b/i,  // pipe to sh
  /\b(curl|wget)\b[^|]*\|\s*(sh|bash)\b/i,  // curl | sh
];

export function resolveCommand(action, app) {
  switch (action) {
    case JobAction.START:       return requireCmd(app.startCmd,  'startCmd');
    case JobAction.STOP:        return app.stopCmd || null;   // optional
    case JobAction.HEALTHCHECK: return app.healthCmd || null; // optional
    case JobAction.BUILD:       return requireCmd(app.buildCmd, 'buildCmd');
    // RESTART is handled as stop+start by the executor
    // DEPLOY  is handled as a pipeline (pull → install → build → restart)
    default: return null;
  }
}

function requireCmd(cmd, label) {
  if (!cmd || !cmd.trim()) {
    throw new ValidationError(`${label} is not configured for this app`);
  }
  return cmd;
}

export function ensureSafe(command, { trusted }) {
  if (!command) return;
  if (trusted) return;
  for (const re of SUSPICIOUS) {
    if (re.test(command)) {
      throw new CommandNotAllowedError(command);
    }
  }
}
