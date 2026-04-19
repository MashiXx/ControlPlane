// Enumerations & constants shared across controller, agent, and queue.
// Keep these aligned with the ENUM columns in db/schema.sql.

export const JobAction = Object.freeze({
  START:       'start',
  STOP:        'stop',
  RESTART:     'restart',
  BUILD:       'build',
  DEPLOY:      'deploy',
  HEALTHCHECK: 'healthcheck',
});

export const JobActions = Object.values(JobAction);

export const JobStatus = Object.freeze({
  PENDING:   'pending',
  RUNNING:   'running',
  SUCCESS:   'success',
  FAILED:    'failed',
  CANCELLED: 'cancelled',
});

export const JobTargetType = Object.freeze({
  APP:    'app',
  GROUP:  'group',
  SERVER: 'server',
});

export const ProcessState = Object.freeze({
  RUNNING:  'running',
  STOPPED:  'stopped',
  CRASHED:  'crashed',
  STARTING: 'starting',
  UNKNOWN:  'unknown',
});

export const ServerStatus = Object.freeze({
  ONLINE:      'online',
  OFFLINE:     'offline',
  UNREACHABLE: 'unreachable',
  DRAINING:    'draining',
});

export const Runtime = Object.freeze({
  NODE: 'node',
  JAVA: 'java',
});

export const BuildStrategy = Object.freeze({
  TARGET:     'target',      // build on target server (agent)
  CONTROLLER: 'controller',  // build on controller host, copy artifact to target
  BUILDER:    'builder',     // future: dedicated builder pool
});

export const LaunchMode = Object.freeze({
  WRAPPED: 'wrapped',
  RAW:     'raw',
  PM2:     'pm2',
  SYSTEMD: 'systemd',
});

export const ArtifactTransfer = Object.freeze({
  HTTP:  'http',   // agent pulls from controller
  RSYNC: 'rsync',  // controller pushes via rsync+ssh
});

// How many releases to retain on target (older ones gc'd).
export const RELEASE_RETENTION_COUNT = 5;

// Short-lived token for artifact download URLs.
export const ARTIFACT_TOKEN_TTL_SEC = 5 * 60;

// Named in-process queues. Separate queues so a slow build never starves restarts.
export const QueueName = Object.freeze({
  RESTART: 'cp:restart',
  BUILD:   'cp:build',
  DEPLOY:  'cp:deploy',
  SYSTEM:  'cp:system',   // healthcheck, start, stop
});

export const QueueForAction = Object.freeze({
  [JobAction.START]:       QueueName.SYSTEM,
  [JobAction.STOP]:        QueueName.SYSTEM,
  [JobAction.HEALTHCHECK]: QueueName.SYSTEM,
  [JobAction.RESTART]:     QueueName.RESTART,
  [JobAction.BUILD]:       QueueName.BUILD,
  [JobAction.DEPLOY]:      QueueName.DEPLOY,
});

// Default retry profile per action — tuned conservatively.
// Values: { attempts, backoff: { type, delay, jitter? } }
export const RetryProfile = Object.freeze({
  [JobAction.START]:       { attempts: 3, backoff: { type: 'exponential', delay: 2_000 } },
  [JobAction.STOP]:        { attempts: 2, backoff: { type: 'exponential', delay: 1_000 } },
  [JobAction.RESTART]:     { attempts: 3, backoff: { type: 'exponential', delay: 2_000 } },
  [JobAction.BUILD]:       { attempts: 2, backoff: { type: 'exponential', delay: 10_000 } },
  [JobAction.DEPLOY]:      { attempts: 2, backoff: { type: 'exponential', delay: 10_000 } },
  [JobAction.HEALTHCHECK]: { attempts: 1, backoff: { type: 'fixed',       delay: 0      } },
});

// WebSocket frame opcodes (controller ↔ agent).
export const WsOp = Object.freeze({
  // agent → controller
  HELLO:       'hello',          // { agentId, authToken, version, os }
  HEARTBEAT:   'heartbeat',      // { ts, apps: [{id, state, pid, uptime}] }
  JOB_UPDATE:  'job:update',     // progress updates from the agent
  JOB_RESULT:  'job:result',     // terminal result
  LOG_CHUNK:   'log:chunk',      // streamed stdout/stderr
  // controller → agent
  WELCOME:     'welcome',        // { sessionId, heartbeatMs }
  EXECUTE:     'execute',        // { jobId, action, app, options }
  CANCEL:      'cancel',         // { jobId }
  REFRESH:     'refresh',        // pull-based state refresh
  // both directions
  ERROR:       'error',
  PONG:        'pong',
  PING:        'ping',
});

// Idempotency: a repeated action against the same target inside this window
// returns the existing job instead of enqueueing a new one.
export const IDEMPOTENCY_WINDOW_MS = 5_000;

// Agent → controller heartbeat cadence & detection threshold.
export const HEARTBEAT_INTERVAL_MS  = 10_000;
export const HEARTBEAT_MISS_LIMIT   = 3;

// Max bytes of command output retained in the audit log per job.
export const AUDIT_OUTPUT_LIMIT     = 8 * 1024;
