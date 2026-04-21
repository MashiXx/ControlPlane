// Orchestrator: takes a user-facing action request (from REST / bot / web),
// validates the target, enqueues in-process job(s), writes the corresponding
// rows into the `jobs` table, and records an audit entry.
//
// Targets:
//   - app   → single application; requires options.serverId / serverIds /
//             serverGroupId to select which replicas to act on.
//   - group → every enabled app in an application-group; applies the same
//             server selector to each app, skipping apps with no matching
//             replicas (audit-logged).
//
// Every deploy is two-phase (build on controller → fan out one deploy job per
// target server).  Non-deploy actions are fanned out here, one job per replica.
//
// Side-effect: every successful enqueue also updates
// `application_servers.expected_state` per replica so the alert detector knows
// whether a subsequent regression is operator-induced (no alert) or a real
// outage.

import { enqueueAction, jobIdentity } from '@cp/queue';
import {
  ExpectedState,
  JobAction, JobActions, JobTargetType, ProcessState, RetryProfile,
} from '@cp/shared/constants';
import { NotFoundError, ValidationError } from '@cp/shared/errors';
import {
  applications, applicationServers, groups, serverGroups, jobs as jobsRepo,
} from '../db/repositories.js';
import { writeAudit } from '../audit/audit.js';

/**
 * Resolve `options` → concrete list of target server ids, intersected with
 * the app's registered replicas. Throws ValidationError on any missing /
 * ambiguous / out-of-set selector.
 */
async function resolveTargetServerIds(app, options = {}) {
  const present = ['serverId', 'serverIds', 'serverGroupId']
    .filter((k) => options[k] !== undefined && options[k] !== null);
  if (present.length === 0) {
    throw new ValidationError(
      `action on app '${app.name}' requires options.serverId, options.serverIds, or options.serverGroupId`,
    );
  }
  if (present.length > 1) {
    throw new ValidationError(
      `options.serverId, options.serverIds, options.serverGroupId are mutually exclusive (got ${present.join(', ')})`,
    );
  }

  let requested;
  if (options.serverId !== undefined) {
    requested = [Number(options.serverId)];
  } else if (Array.isArray(options.serverIds)) {
    requested = options.serverIds.map(Number);
  } else {
    const sg = await resolveServerGroup(options.serverGroupId);
    requested = await serverGroups.listMemberIds(sg.id);
    if (requested.length === 0) {
      throw new ValidationError(`server-group '${sg.name}' has no members`);
    }
  }

  const replicaIds = new Set(await applicationServers.serverIdsForApp(app.id));
  const targetIds = requested.filter((id) => replicaIds.has(id));

  if (targetIds.length === 0) {
    throw new ValidationError(
      `no replicas of app '${app.name}' match the requested server set`,
    );
  }
  // Surface the first requested-but-not-a-replica id for a clear error.
  if (options.serverId !== undefined || Array.isArray(options.serverIds)) {
    const stray = requested.find((id) => !replicaIds.has(id));
    if (stray !== undefined) {
      throw new ValidationError(`server ${stray} is not a replica of app '${app.name}'`);
    }
  }
  return targetIds;
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
        if (err instanceof ValidationError && /no replicas/.test(err.message)) {
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

  // target.type='server_group' is gone. Surface a clear upgrade hint.
  throw new ValidationError(
    `target.type='${target.type}' is not supported; use target.type='app' with options.serverGroupId`,
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
    await applyExpectedState(app.id, serverId, action);

    await writeAudit({
      actor: triggeredBy, action, targetType: 'app', targetId: String(app.id),
      jobId, result: 'info',
      message: `queued ${action} for ${app.name}@server#${serverId}`,
    });
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
  app, triggeredBy, options, { deployServerIds, serverGroupName } = {},
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
      serverGroupName: serverGroupName ?? null,
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
    payload: { deployServerIds, serverGroupName: serverGroupName ?? null, options },
  }).catch((err) => {
    if (err?.code === 'ER_DUP_ENTRY') return null;
    throw err;
  });

  const enq = await enqueueAction(enqInput);

  // Flip expected=running per-replica so the alert detector understands the
  // intent even if the deploy fails mid-way.
  for (const sid of deployServerIds) {
    await applyExpectedState(app.id, sid, JobAction.DEPLOY);
  }

  await writeAudit({
    actor: triggeredBy, action: 'deploy.plan', targetType: 'app', targetId: String(app.id),
    jobId, result: 'info',
    message: `build-then-deploy for ${app.name} → ${deployServerIds.length} server(s)`,
    metadata: { serverIds: deployServerIds, serverGroupName: serverGroupName ?? null },
  });

  return {
    jobId,
    queueJobId: enq.queueJobId,
    application: { id: app.id, name: app.name },
    action: JobAction.DEPLOY,
    twoPhase: true,
    phase: 'build',
    fanOut: { serverIds: deployServerIds, serverGroupName: serverGroupName ?? null },
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

async function resolveServerGroup(idOrName) {
  const key = String(idOrName);
  if (/^\d+$/.test(key)) return serverGroups.get(Number(key));
  const byName = await serverGroups.getByName(key);
  if (!byName) throw new NotFoundError('server_group', idOrName);
  return byName;
}
