// zod schemas for payload validation.
// Used by the controller at API boundaries and by the agent to validate
// inbound WS frames — never trust the other side blindly.

import { z } from 'zod';
import {
  JobActions,
  JobTargetType,
  ProcessState,
  Runtime,
  WsOp,
  BuildStrategy,
  LaunchMode,
  ArtifactTransfer,
} from './constants.js';

// ─── Primitive building blocks ───────────────────────────────────────────
const nonEmpty = z.string().trim().min(1);
const identifier = nonEmpty.max(64).regex(
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
  'must be alphanumeric with . _ -',
);

// Accept either a standard URL (http, https, ssh, git) OR the scp-style
// SSH syntax git clone uses: `user@host:path` (most commonly
// `git@github.com:org/repo.git`). z.string().url() rejects the scp form
// because it has no `://`.
const gitRepoUrl = z.string().trim().max(512).refine(
  (s) => /^(https?|ssh|git):\/\//i.test(s)
      || /^[\w.-]+@[\w.-]+:[\w./_-]+$/.test(s),
  'must be http(s)://, ssh://, git://, or git@host:path',
);

// ─── Application config (used by POST /api/applications & example JSON) ──
export const ApplicationConfig = z.object({
  name: identifier,
  serverName: identifier,
  groupName: identifier.optional(),
  runtime: z.enum([Runtime.NODE, Runtime.JAVA]),

  buildStrategy: z.enum(Object.values(BuildStrategy)).default(BuildStrategy.TARGET),
  artifactPattern: z.string().max(255).optional(),       // 'target/*.jar'
  remoteInstallPath: z.string().max(512).optional(),     // '/opt/ledger'
  builderServerName: identifier.optional(),

  repoUrl: gitRepoUrl.optional(),
  branch: nonEmpty.max(128).default('main'),
  workdir: nonEmpty.max(512),
  installCmd: z.string().max(512).optional(),
  buildCmd: z.string().max(512).optional(),
  startCmd: z.string().min(1).max(512),
  stopCmd: z.string().max(512).optional(),

  launchMode: z.enum(Object.values(LaunchMode)).default(LaunchMode.WRAPPED),
  statusCmd: z.string().max(512).optional(),
  logsCmd:   z.string().max(512).optional(),

  healthCmd: z.string().max(512).optional(),
  env: z.record(z.string(), z.string()).optional(),
  trusted: z.boolean().default(false),
  enabled: z.boolean().default(true),
})
.superRefine((cfg, ctx) => {
  if (cfg.launchMode === LaunchMode.RAW) {
    for (const f of ['stopCmd', 'statusCmd']) {
      if (!cfg[f]) ctx.addIssue({
        code: z.ZodIssueCode.custom, path: [f],
        message: `launchMode='raw' requires ${f}`,
      });
    }
  }
  if (cfg.buildStrategy === BuildStrategy.CONTROLLER) {
    for (const f of ['repoUrl', 'artifactPattern', 'remoteInstallPath']) {
      if (!cfg[f]) ctx.addIssue({
        code: z.ZodIssueCode.custom, path: [f],
        message: `buildStrategy='controller' requires ${f}`,
      });
    }
  }
});

// ─── Artifact descriptor sent to the agent in a deploy execute frame ────
export const ArtifactDescriptor = z.object({
  id:        z.number().int().positive(),
  sha256:    z.string().length(64),
  sizeBytes: z.number().int().nonnegative(),
  // Either `downloadUrl` (HTTP pull mode) or `prestagedPath` (rsync push mode).
  downloadUrl:   z.string().url().optional(),
  downloadToken: z.string().min(10).optional(),
  prestagedPath: z.string().optional(),
  releaseId:     z.string().min(1),
}).refine(
  (a) => Boolean(a.downloadUrl || a.prestagedPath),
  { message: 'artifact requires either downloadUrl or prestagedPath' },
);

// ─── API: enqueue an action ──────────────────────────────────────────────
export const EnqueueActionBody = z.object({
  action: z.enum(JobActions),
  target: z.object({
    type: z.enum(Object.values(JobTargetType)),
    id:   z.union([z.number().int().positive(), identifier]),
  }),
  options: z.record(z.string(), z.unknown()).optional(),
});

// ─── WebSocket frames ────────────────────────────────────────────────────
const WsBase = z.object({
  op: z.string(),
  // nonce so request/response can be correlated
  id: z.string().min(1).optional(),
  ts: z.number().int().nonnegative().optional(),
});

export const WsHello = WsBase.extend({
  op: z.literal(WsOp.HELLO),
  agentId: identifier,
  authToken: nonEmpty,
  version: nonEmpty.max(32),
  os: z.string().max(64).optional(),
  labels: z.record(z.string(), z.string()).optional(),
});

export const WsHeartbeat = WsBase.extend({
  op: z.literal(WsOp.HEARTBEAT),
  apps: z.array(
    z.object({
      id: z.number().int().positive(),
      state: z.enum(Object.values(ProcessState)),
      pid: z.number().int().positive().nullable().optional(),
      uptimeSeconds: z.number().int().nonnegative().nullable().optional(),
      lastExitCode: z.number().int().nullable().optional(),
    }),
  ).default([]),
});

export const WsExecute = WsBase.extend({
  op: z.literal(WsOp.EXECUTE),
  jobId: nonEmpty,
  action: z.enum(JobActions),
  // The agent never sees raw commands from the wire — it receives the app's
  // id plus the action and resolves the command locally from its cached config.
  // `command` field is only honored when app.trusted=true (see agent executor).
  app: z.object({
    id: z.number().int().positive(),
    name: identifier,
    runtime: z.enum([Runtime.NODE, Runtime.JAVA]),
    workdir: nonEmpty,
    installCmd: z.string().optional(),
    buildCmd: z.string().optional(),
    startCmd: z.string(),
    stopCmd: z.string().optional(),
    statusCmd: z.string().optional(),
    logsCmd:   z.string().optional(),
    launchMode: z.enum(Object.values(LaunchMode)).default(LaunchMode.WRAPPED),
    healthCmd: z.string().optional(),
    repoUrl: gitRepoUrl.optional(),
    branch: nonEmpty.default('main'),
    env: z.record(z.string(), z.string()).optional(),
    trusted: z.boolean().default(false),
    buildStrategy: z.enum(Object.values(BuildStrategy)).default(BuildStrategy.TARGET),
    remoteInstallPath: z.string().optional(),
  }),
  // Populated when action=deploy and build_strategy != 'target'.
  artifact: ArtifactDescriptor.optional(),
  timeoutMs: z.number().int().positive().max(60 * 60 * 1000).optional(),
});

export const WsJobUpdate = WsBase.extend({
  op: z.literal(WsOp.JOB_UPDATE),
  jobId: nonEmpty,
  phase: z.enum(['queued', 'starting', 'running', 'finalizing']),
  progress: z.number().min(0).max(100).optional(),
  message: z.string().max(1024).optional(),
});

export const WsJobResult = WsBase.extend({
  op: z.literal(WsOp.JOB_RESULT),
  jobId: nonEmpty,
  success: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  exitCode: z.number().int().nullable().optional(),
  stdoutTail: z.string().optional(),
  stderrTail: z.string().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    transient: z.boolean().optional(),
  }).nullable().optional(),
});

export const WsLogChunk = WsBase.extend({
  op: z.literal(WsOp.LOG_CHUNK),
  jobId: nonEmpty,
  stream: z.enum(['stdout', 'stderr']),
  // base64 to survive arbitrary bytes through JSON
  dataB64: z.string(),
});

export const WsCancel = WsBase.extend({
  op: z.literal(WsOp.CANCEL),
  jobId: nonEmpty,
});

export const WsError = WsBase.extend({
  op: z.literal(WsOp.ERROR),
  code: z.string(),
  message: z.string(),
  jobId: z.string().optional(),
});

export const WsInbound = z.discriminatedUnion('op', [
  WsHello, WsHeartbeat, WsJobUpdate, WsJobResult, WsLogChunk, WsError,
]);

export const WsOutbound = z.discriminatedUnion('op', [
  WsExecute, WsCancel, WsError,
]);

// ─── CRUD payloads for /api/applications, /api/groups, /api/servers ──────
//
// These are NOT the same as ApplicationConfig above. ApplicationConfig is
// the import-by-NAME JSON format used by CLI tooling; the web form already
// knows the numeric server_id and group_id because the user picked them
// from a dropdown, so these schemas use ids directly.

const pathAbs = z.string().regex(
  /^\/[\w\-./]+$/,
  'must be an absolute path (no spaces, no "..")',
).max(512);

const envObject = z.record(
  z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'env var must match ^[A-Z_][A-Z0-9_]*$'),
  z.string(),
).refine(
  (obj) => JSON.stringify(obj).length < 32 * 1024,
  { message: 'env object exceeds 32 KB' },
);

const cmdString = z.string().max(512);
const dbName = z.string().regex(/^[a-z0-9-]{1,64}$/, 'lowercase alphanumeric / hyphen, max 64');

const appBaseFields = {
  name:             dbName,
  group_id:         z.number().int().positive().nullable().optional(),
  runtime:          z.enum([Runtime.NODE, Runtime.JAVA]),
  build_strategy:   z.enum(Object.values(BuildStrategy)).optional(),
  artifact_pattern: z.string().max(255).optional(),
  remote_install_path: pathAbs.optional(),
  builder_server_id: z.number().int().positive().nullable().optional(),
  repo_url:         gitRepoUrl.optional(),
  branch:           z.string().min(1).max(128).optional(),
  workdir:          pathAbs,
  install_cmd:      cmdString.optional(),
  build_cmd:        cmdString.optional(),
  start_cmd:        cmdString.min(1),
  stop_cmd:         cmdString.optional(),
  launch_mode:      z.enum(Object.values(LaunchMode)).optional(),
  status_cmd:       cmdString.optional(),
  logs_cmd:         cmdString.optional(),
  health_cmd:       cmdString.optional(),
  env:              envObject.optional(),
  trusted:          z.boolean().optional(),
  enabled:          z.boolean().optional(),
};

export const AppCreate = z.object({
  ...appBaseFields,
  server_id: z.number().int().positive(),
}).strict();

export const AppUpdate = z.object(
  Object.fromEntries(Object.entries(appBaseFields).map(([k, v]) => [k, v.optional()])),
).strict();

export const GroupCreate = z.object({
  name: dbName,
  description: z.string().max(255).optional(),
}).strict();

export const GroupUpdate = GroupCreate.partial();

// `hostname` can be any OpenSSH-compatible target: a DNS name, a raw IP,
// or — most usefully — a Host alias defined in the controller's
// ~/.ssh/config. For rsync transport the controller passes it straight
// to `ssh` / `rsync`, so all connection details (User, Port, IdentityFile,
// ProxyJump) live in the ssh config file, not in the DB.
export const ServerCreate = z.object({
  name: dbName,
  hostname: z.string().min(1).max(255),
  artifact_transfer: z.enum(Object.values(ArtifactTransfer)),
  labels: z.record(z.string(), z.string()).optional(),
}).strict();

export const ServerUpdate = z.object({
  name: dbName.optional(),
  hostname: z.string().min(1).max(255).optional(),
  artifact_transfer: z.enum(Object.values(ArtifactTransfer)).optional(),
  labels: z.record(z.string(), z.string()).nullable().optional(),
}).strict();
