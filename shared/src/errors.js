// Error taxonomy.
//
// The queue worker checks `err.transient` to decide whether to retry.
// Anything not explicitly marked transient is treated as permanent and
// fails the job immediately (no retries), preserving the "do not retry
// config/syntax errors" requirement.

export class ControlPlaneError extends Error {
  constructor(message, { code = 'E_GENERIC', cause, meta } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.meta = meta;
    if (cause) this.cause = cause;
    this.transient = false;
  }
}

// Retryable: network blip, agent disconnected mid-job, transient I/O.
export class TransientError extends ControlPlaneError {
  constructor(message, opts = {}) {
    super(message, { code: opts.code ?? 'E_TRANSIENT', ...opts });
    this.transient = true;
  }
}

// Non-retryable: bad config, unknown app, unauthorized, command not whitelisted.
export class PermanentError extends ControlPlaneError {
  constructor(message, opts = {}) {
    super(message, { code: opts.code ?? 'E_PERMANENT', ...opts });
    this.transient = false;
  }
}

export class ValidationError extends PermanentError {
  constructor(message, meta) {
    super(message, { code: 'E_VALIDATION', meta });
  }
}

export class NotFoundError extends PermanentError {
  constructor(entity, id) {
    super(`${entity} ${id} not found`, { code: 'E_NOT_FOUND', meta: { entity, id } });
  }
}

export class ConflictError extends PermanentError {
  constructor(message, meta) {
    super(message, { code: 'E_CONFLICT', meta });
  }
}

export class AuthError extends PermanentError {
  constructor(message = 'unauthorized') {
    super(message, { code: 'E_AUTH' });
  }
}

export class CommandNotAllowedError extends PermanentError {
  constructor(command) {
    super(`command not whitelisted: ${command}`, {
      code: 'E_CMD_NOT_ALLOWED',
      meta: { command },
    });
  }
}

export class AgentUnavailableError extends TransientError {
  constructor(serverId) {
    super(`agent for server ${serverId} is not connected`, {
      code: 'E_AGENT_UNAVAILABLE',
      meta: { serverId },
    });
  }
}

export class TimeoutError extends TransientError {
  constructor(op, ms) {
    super(`${op} timed out after ${ms}ms`, { code: 'E_TIMEOUT', meta: { op, ms } });
  }
}

// Serialize any error into a JSON-safe payload for jobs.error / ws frames.
export function serializeError(err) {
  if (!err) return null;
  return {
    name:      err.name ?? 'Error',
    code:      err.code ?? 'E_GENERIC',
    message:   err.message ?? String(err),
    transient: Boolean(err.transient),
    meta:      err.meta ?? null,
  };
}
