// Orchestrator: takes a user-facing action request (from REST / bot / web),
// validates the target, enqueues in-process job(s), writes the corresponding
// rows into the `jobs` table, and records an audit entry.
//
// Targets:
//   - app   → single application; fan out to ALL the app's current replicas.
//             `options.serverId` optionally narrows to one replica.
//   - group → every enabled app in an application-group; each app fans out
//             to its own replicas.
//
// Placement is a property of the app (server_id or server_group_id), NOT
// per-action input. The caller doesn't pick servers — they edit the app.
//
// Every deploy is two-phase (build on controller → fan out one deploy job
// per target server). Non-deploy actions are fanned out here, one job per
// replica.
//
// Side-effect: every successful enqueue also updates
// `application_servers.expected_state` per replica so the alert detector
// knows whether a subsequent regression is operator-induced or a real
// outage.

import { enqueueAction, jobIdentity } from '@cp/queue';
import {
  ExpectedState,
  JobAction, JobActions, JobTargetType, RetryProfile,
} from '@cp/shared/constants';
import { NotFoundError, ValidationError } from '@cp/shared/errors';
import {
  applications, applicationServers, groups, jobs as jobsRepo,
} from '../db/repositories.js';
import { writeAudit } from '../audit/audit.js';

/**
 * Resolve the list of target server ids for an action. Starts from the
 * app's current replicas (derived from placement) and optionally narrows
 * to a single replica when `options.serverId` is supplied — that mode is
 * used by the dashboard's per-row Restart/Stop/Deploy buttons.
 */
async function resolveTargetServerIds(app, options = {}) {
  if (app.server_id == null && app.server_group_id == null) {
    throw new ValidationError(
      `app '${app.name}' has no placement; set server_id or server_group_id first`,
    );
  }
  const replicaIds = await applicationServers.serverIdsForApp(app.id);
  if (replicaIds.length === 0) {
    throw new ValidationError(
      `app '${app.name}' has no replicas (placement resolves to 0 servers)`,
    );
  }
  if (options.serverId != null) {
    const id = Number(options.serverId);
    if (!replicaIds.includes(id)) {
      throw new ValidationError(
        `server ${id} is not a replica of app '${app.name}'`,
      );
    }
    return [id];
  }
  return replicaIds;
}

/**
 * Validate and enqueue an action against one or more targets.
 *
 * @param {{ action: string, target: { type: string, id: string|number },
 *           triggeredBy: string, options?: object }} params
 * @returns {Promise<object[]>} Array of enqueue result objects.
 */
export async function submitAction({ action, target, triggeredBy, options = {} }) {
  if (!JobActions.includes(action)) {
    throw new ValidationError(`unknown action: ${action}`);
  }

  if (target.type === JobTargetType.APP) {
    const app = await resolveApp(target.id);
    const serverIds = await resolveTargetServerIds(app, options);
    return enqueueForApp(action, app, serverIds, triggeredBy, options);
  }

  if (target.type === JobTargetType.GROUP) {
    const group = await resolveGroup(target.id);
    const apps  = await applications.listByGroupName(group.name);
    if (apps.length === 0) throw new NotFoundError('group-applications', group.name);

    const perApp = [];
    for (const app of apps) {
      try {
        const serverIds = await resolveTargetServerIds(app, options);
        perApp.push(...await enqueueForApp(action, app, serverIds, triggeredBy, options));
      } catch (err) {
        if (err instanceof ValidationError && /no replicas|no placement/.test(err.message)) {
          await writeAudit({
            actor: triggeredBy, action: `${action}.group.skip`,
            targetType: 'app', targetId: String(app.id),
            result: 'info', message: err.message,
          });
          continue;
        }
        throw err;
      }
    }
    await writeAudit({
      actor: triggeredBy, action: `${action}.group`, targetType: 'group',
      targetId: group.name, result: 'info',
      message: `fanned out across ${perApp.length} replica-jobs in ${apps.length} apps`,
    });
    return perApp;
  }

  throw new ValidationError(
    `target.type='${target.type}' is not supported; use 'app' or 'group'`,
  );
}

async function enqueueForApp(action, app, serverIds, triggeredBy, options) {
  if (action === JobAction.START && !app.start_cmd) {
    throw new ValidationError(`app ${app.name} has no start_cmd`);
  }
  if (!app.enabled) throw new ValidationError(`app ${app.name} is disabled`);

  // deploy goes through the build → fan-out path; other actions fan out here.
  if (action === JobAction.DEPLOY) {
    return [await enqueueControllerBuild(app, triggeredBy, options, { deployServerIds: serverIds })];
  }

  const profile = RetryProfile[action];
  const results = [];

  for (const serverId of serverIds) {
    // Composite targetId keeps per-server queue idempotency unique.
    const enqInput = {
      action,
      targetType: JobTargetType.APP,
      targetId: `${app.id}@${serverId}`,
      triggeredBy,
      payload: {
        applicationId: app.id,
        appName: app.name,
        serverIdOverride: serverId,
        options,
      },
    };
    const identity = jobIdentity(enqInput);
    const jobId = await jobsRepo.insert({
      queueJobId: identity.queueJobId,
      idempotencyKey: identity.idempotencyKey,
      action,
      targetType: JobTargetType.APP,
      applicationId: app.id,
      groupId: app.group_id,
      serverId,
      maxAttempts: profile.attempts,
      triggeredBy,
      payload: { applicationId: app.id, appName: app.name, serverIdOverride: serverId, options },
    }).catch((err) => {
      if (err?.code === 'ER_DUP_ENTRY') return null;
      throw err;
    });

    const enq = await enqueueAction(enqInput);

    // When jobsRepo.insert collided on the idempotency key, the original
    // job is still owned by the first submitter — don't double-stamp
    // expected state or write a duplicate audit.
    if (jobId !== null) {
      await applyExpectedState(app.id, serverId, action);
      await writeAudit({
        actor: triggeredBy, action, targetType: 'app', targetId: String(app.id),
        jobId, result: 'info',
        message: `queued ${action} for ${app.name}@server#${serverId}`,
      });
    }

    results.push({
      jobId,
      queueJobId: enq.queueJobId,
      application: { id: app.id, name: app.name },
      serverId,
      action,
    });
  }
  return results;
}

async function enqueueControllerBuild(
  app, triggeredBy, options, { deployServerIds } = {},
) {
  if (!app.repo_url || !app.artifact_pattern || !app.remote_install_path) {
    throw new ValidationError(
      `deploy requires repo_url, artifact_pattern and remote_install_path (app ${app.name})`,
    );
  }
  if (!Array.isArray(deployServerIds) || deployServerIds.length === 0) {
    throw new ValidationError('deploy requires at least one target server');
  }
  const profile = RetryProfile[JobAction.BUILD];

  const enqInput = {
    action: JobAction.BUILD,
    targetType: JobTargetType.APP,
    targetId: app.id,
    triggeredBy,
    payload: {
      appName: app.name,
      applicationId: app.id,
      commitSha: options?.commitSha,
      deployServerIds,
      options,
    },
  };
  const identity = jobIdentity(enqInput);

  const jobId = await jobsRepo.insert({
    queueJobId: identity.queueJobId,
    idempotencyKey: identity.idempotencyKey,
    action: JobAction.BUILD,
    targetType: JobTargetType.APP,
    applicationId: app.id,
    groupId: app.group_id,
    serverId: null,
    maxAttempts: profile.attempts,
    triggeredBy,
    payload: { deployServerIds, options },
  }).catch((err) => {
    if (err?.code === 'ER_DUP_ENTRY') return null;
    throw err;
  });

  const enq = await enqueueAction(enqInput);

  if (jobId !== null) {
    // Flip expected=running per-replica so the alert detector understands
    // the intent even if the deploy fails mid-way.
    for (const sid of deployServerIds) {
      await applyExpectedState(app.id, sid, JobAction.DEPLOY);
    }
    await writeAudit({
      actor: triggeredBy, action: 'deploy.plan', targetType: 'app', targetId: String(app.id),
      jobId, result: 'info',
      message: `build-then-deploy for ${app.name} → ${deployServerIds.length} server(s)`,
      metadata: { serverIds: deployServerIds },
    });
  }

  return {
    jobId,
    queueJobId: enq.queueJobId,
    application: { id: app.id, name: app.name },
    action: JobAction.DEPLOY,
    twoPhase: true,
    phase: 'build',
    fanOut: { serverIds: deployServerIds },
  };
}

async function applyExpectedState(appId, serverId, action) {
  const map = {
    [JobAction.START]:   ExpectedState.RUNNING,
    [JobAction.RESTART]: ExpectedState.RUNNING,
    [JobAction.DEPLOY]:  ExpectedState.RUNNING,
    [JobAction.STOP]:    ExpectedState.STOPPED,
  };
  const next = map[action];
  if (!next) return;
  await applicationServers.setExpectedState(appId, serverId, next).catch(() => {});
}

async function resolveApp(idOrName) {
  if (typeof idOrName === 'number' || /^\d+$/.test(String(idOrName))) {
    return applications.get(Number(idOrName));
  }
  const all = await applications.list();
  const found = all.find((a) => a.name === idOrName);
  if (!found) throw new NotFoundError('application', idOrName);
  return found;
}

async function resolveGroup(idOrName) {
  const key = String(idOrName);
  const group = /^\d+$/.test(key)
    ? (await groups.list()).find((g) => g.id === Number(key))
    : await groups.getByName(key);
  if (!group) throw new NotFoundError('group', idOrName);
  return group;
}
