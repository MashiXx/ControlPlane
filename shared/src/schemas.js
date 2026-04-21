// zod schemas for payload validation.
// Used by the controller at API boundaries.

import { z } from 'zod';
import {
  JobActions,
  JobTargetType,
  Runtime,
  LaunchMode,
} from './constants.js';

// ─── Primitive building blocks ───────────────────────────────────────────
const nonEmpty = z.string().trim().min(1);
const identifier = nonEmpty.max(64).regex(
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
  'must be alphanumeric with . _ -',
);

// Accept either a standard URL (http, https, ssh, git) OR the scp-style
// SSH syntax git clone uses: `user@host:path`.
const gitRepoUrl = z.string().trim().max(512).refine(
  (s) => /^(https?|ssh|git):\/\//i.test(s)
      || /^[\w.-]+@[\w.-]+:[\w./_-]+$/.test(s),
  'must be http(s)://, ssh://, git://, or git@host:path',
);

// ─── Application config (used by POST /api/applications & example JSON) ──
// Phase 1: runtime locked to 'java'. Every app builds on the controller and
// deploys via rsync+ssh — build strategy is no longer a user choice.
//
// Placement is single-valued: exactly one of `serverName` or
// `serverGroupName` must be set. The replicas the app runs on are derived
// from that placement by the controller.
export const ApplicationConfig = z.object({
  name: identifier,
  serverName:      identifier.optional(),
  serverGroupName: identifier.optional(),
  groupName: identifier.optional(),
  runtime: z.enum(Object.values(Runtime)).default(Runtime.JAVA),

  artifactPattern: z.string().max(255),            // 'target/*.jar'
  remoteInstallPath: z.string().max(512),          // '/opt/ledger'

  repoUrl: gitRepoUrl,
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
  const placements = ['serverName', 'serverGroupName'].filter((k) => cfg[k]);
  if (placements.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['serverName'],
      message: 'exactly one of serverName / serverGroupName must be set',
    });
  }
  if (cfg.launchMode === LaunchMode.RAW) {
    for (const f of ['stopCmd', 'statusCmd']) {
      if (!cfg[f]) ctx.addIssue({
        code: z.ZodIssueCode.custom, path: [f],
        message: `launchMode='raw' requires ${f}`,
      });
    }
  }
});

// ─── API: enqueue an action ──────────────────────────────────────────────
//
// Placement is part of the app (server_id or server_group_id). An action
// against an app fans out to ALL its replicas by default. `options.serverId`
// is an optional narrowing to a single replica — used by per-row action
// buttons in the dashboard Replicas dialog.
export const EnqueueActionBody = z.object({
  action: z.enum(JobActions),
  target: z.object({
    type: z.enum(Object.values(JobTargetType)),
    id:   z.union([z.number().int().positive(), identifier]),
  }),
  options: z.record(z.string(), z.unknown()).optional(),
});

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
  // Placement: exactly one of server_id / server_group_id must be non-null
  // on create; on update, at most one may be non-null (the other must be
  // explicitly cleared by the caller in the same patch).
  server_id:        z.number().int().positive().nullable().optional(),
  server_group_id:  z.number().int().positive().nullable().optional(),
  runtime:          z.enum(Object.values(Runtime)).default(Runtime.JAVA),
  artifact_pattern: z.string().max(255).optional(),
  remote_install_path: pathAbs.optional(),
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

// Reject placement combinations that don't make sense. `exact` forces
// exactly-one non-null (create); `atMost` forbids both non-null (update).
function refinePlacement(mode) {
  return (val, ctx) => {
    const sid = val.server_id;
    const sgid = val.server_group_id;
    const hasS  = sid != null;
    const hasSG = sgid != null;
    if (hasS && hasSG) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['server_id'],
        message: 'server_id and server_group_id are mutually exclusive',
      });
    }
    if (mode === 'exact' && !hasS && !hasSG) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['server_id'],
        message: 'exactly one of server_id / server_group_id must be set',
      });
    }
  };
}

export const AppCreate = z.object({
  ...appBaseFields,
}).strict().superRefine(refinePlacement('exact'));

export const AppUpdate = z.object(
  Object.fromEntries(Object.entries(appBaseFields).map(([k, v]) => [k, v.optional()])),
).strict().superRefine(refinePlacement('atMost'));

export const GroupCreate = z.object({
  name: dbName,
  description: z.string().max(255).optional(),
}).strict();

export const GroupUpdate = GroupCreate.partial();

// A ServerGroup is a named bundle of servers, used as a deploy fan-out
// target. `serverIds` fully replaces the membership when present.
export const ServerGroupCreate = z.object({
  name: dbName,
  description: z.string().max(255).optional(),
  serverIds: z.array(z.number().int().positive()).optional(),
}).strict();

export const ServerGroupUpdate = z.object({
  name: dbName.optional(),
  description: z.string().max(255).nullable().optional(),
  serverIds: z.array(z.number().int().positive()).optional(),
}).strict();

// `hostname` can be any OpenSSH-compatible target: a DNS name, a raw IP,
// or — most usefully — a Host alias defined in the controller's
// ~/.ssh/config. The controller passes it straight to `ssh` / `rsync`, so
// all connection details (User, Port, IdentityFile, ProxyJump) live in the
// ssh config file, not in the DB.
export const ServerCreate = z.object({
  name: dbName,
  hostname: z.string().min(1).max(255),
  labels: z.record(z.string(), z.string()).optional(),
}).strict();

export const ServerUpdate = z.object({
  name: dbName.optional(),
  hostname: z.string().min(1).max(255).optional(),
  labels: z.record(z.string(), z.string()).nullable().optional(),
}).strict();

