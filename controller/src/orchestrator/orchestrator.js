// Orchestrator: takes a user-facing action request (from REST / bot / web),
// validates the target, enqueues in-process job(s), writes the corresponding
// rows into the `jobs` table, and records an audit entry.
//
// Targets:
//   - app          → single application (one job)
//   - group        → every enabled app in an application-group (fan-out)
//   - server_group → one application deployed to every server in a
//                    server-group (build once, deploy N times)
//
// Side-effect worth calling out: every successful enqueue *also* updates
// `applications.expected_state` so the alert detector knows whether a
// subsequent regression is operator-induced (no alert) or a real outage.

import { enqueueAction } from '@cp/queue';
import {
  BuildStrategy,
  ExpectedState,
  JobAction, JobActions, JobTargetType, ProcessState, RetryProfile,
} from '@cp/shared/constants';
import { NotFoundError, ValidationError } from '@cp/shared/errors';
import {
  applications, groups, serverGroups, jobs as jobsRepo,
} from '../db/repositories.js';
import { writeAudit } from '../audit/audit.js';

// Which actions flip expected_state, and in which direction. Actions not in
// this map leave expected_state untouched (e.g. build, healthcheck).
const EXPECTED_STATE_FOR_ACTION = Object.freeze({
  [JobAction.START]:   ExpectedState.RUNNING,
  [JobAction.RESTART]: ExpectedState.RUNNING,
  [JobAction.DEPLOY]:  ExpectedState.RUNNING,
  [JobAction.STOP]:    ExpectedState.STOPPED,
});

export async function submitAction({ action, target, triggeredBy, options = {} }) {
  if (!JobActions.includes(action)) {
    throw new ValidationError(`unknown action: ${action}`);
  }

  if (target.type === JobTargetType.APP) {
    const app = await resolveApp(target.id);
    return [await enqueueOne(action, app, triggeredBy, options)];
  }

  if (target.type === JobTargetType.GROUP) {
    const group = await resolveGroup(target.id);
    const apps  = await applications.listByGroupName(group.name);
    if (apps.length === 0) throw new NotFoundError('group-applications', group.name);
    const results = [];
    for (const app of apps) {
      results.push(await enqueueOne(action, app, triggeredBy, options));
    }
    await writeAudit({
      actor: triggeredBy, action: `${action}.group`, targetType: 'group',
      targetId: group.name, result: 'info',
      message: `fanned out to ${apps.length} apps`,
      metadata: { applications: apps.map((a) => a.name) },
    });
    return results;
  }

  if (target.type === JobTargetType.SERVER_GROUP) {
    return [await enqueueServerGroupDeploy({
      action, serverGroupRef: target.id, triggeredBy, options,
    })];
  }

  throw new ValidationError(`unsupported target.type: ${target.type}`);
}

async function enqueueOne(action, app, triggeredBy, options) {
  if (action === JobAction.START && !app.start_cmd) {
    throw new ValidationError(`app ${app.name} has no start_cmd`);
  }
  if (!app.enabled) throw new ValidationError(`app ${app.name} is disabled`);
  if (action === JobAction.RESTART && app.process_state === ProcessState.UNKNOWN) {
    // Allowed, but logged — the agent will sort it out.
  }

  // Special-case: deploy on an app that builds on controller is two-phase:
  //   1. BUILD job (runs locally on controller)
  //   2. DEPLOY job (enqueued by the build worker on success)
  // We only enqueue the BUILD here; the chain is driven by the worker.
  if (action === JobAction.DEPLOY && app.build_strategy === BuildStrategy.CONTROLLER) {
    return enqueueControllerBuild(app, triggeredBy, options);
  }

  const profile = RetryProfile[action];
  const enq = await enqueueAction({
    action,
    targetType: JobTargetType.APP,
    targetId: app.id,
    triggeredBy,
    payload: { appName: app.name, serverId: app.server_id, options },
  });

  const jobId = await jobsRepo.insert({
    queueJobId: enq.queueJobId,
    idempotencyKey: enq.idempotencyKey,
    action,
    targetType: JobTargetType.APP,
    applicationId: app.id,
    groupId: app.group_id,
    serverId: app.server_id,
    maxAttempts: profile.attempts,
    triggeredBy,
    payload: { appName: app.name, options },
  }).catch(async (err) => {
    if (err?.code === 'ER_DUP_ENTRY') return null;
    throw err;
  });

  await applyExpectedState(app.id, action);

  await writeAudit({
    actor: triggeredBy, action, targetType: 'app', targetId: String(app.id),
    jobId, result: 'info', message: `queued ${action} for ${app.name}`,
  });

  return {
    jobId,
    queueJobId: enq.queueJobId,
    application: { id: app.id, name: app.name },
    action,
  };
}

async function enqueueControllerBuild(
  app, triggeredBy, options, { deployServerIds, serverGroupName } = {},
) {
  const profile = RetryProfile[JobAction.BUILD];
  const enq = await enqueueAction({
    action: JobAction.BUILD,
    targetType: JobTargetType.APP,
    targetId: app.id,
    triggeredBy,
    payload: {
      appName: app.name,
      serverId: app.server_id,
      buildOnController: true,
      commitSha: options?.commitSha,
      // When provided the build worker will chain one DEPLOY per server id
      // rather than a single deploy against app.server_id.
      deployServerIds: deployServerIds ?? null,
      serverGroupName: serverGroupName ?? null,
      options,
    },
  });

  const jobId = await jobsRepo.insert({
    queueJobId: enq.queueJobId,
    idempotencyKey: enq.idempotencyKey,
    action: JobAction.BUILD,
    targetType: JobTargetType.APP,
    applicationId: app.id,
    groupId: app.group_id,
    serverId: app.server_id,
    maxAttempts: profile.attempts,
    triggeredBy,
    payload: {
      buildOnController: true,
      deployServerIds: deployServerIds ?? null,
      serverGroupName: serverGroupName ?? null,
      options,
    },
  }).catch((err) => {
    if (err?.code === 'ER_DUP_ENTRY') return null;
    throw err;
  });

  // Deploy transitions the app to expected=running regardless of fan-out width.
  await applyExpectedState(app.id, JobAction.DEPLOY);

  await writeAudit({
    actor: triggeredBy, action: 'deploy.plan', targetType: 'app', targetId: String(app.id),
    jobId, result: 'info',
    message: serverGroupName
      ? `build-then-deploy for ${app.name} → server-group ${serverGroupName} (${deployServerIds?.length ?? 0} servers)`
      : `build-then-deploy for ${app.name} (build_strategy=controller)`,
    metadata: deployServerIds ? { serverGroupName, serverIds: deployServerIds } : undefined,
  });

  return {
    jobId,
    queueJobId: enq.queueJobId,
    application: { id: app.id, name: app.name },
    action: JobAction.DEPLOY,
    twoPhase: true,
    phase: 'build',
    fanOut: deployServerIds
      ? { serverGroupName, serverIds: deployServerIds }
      : undefined,
  };
}

// server_group deploy: build once on the controller, then fan out one deploy
// per member server. Only supported for controller-built apps — agent-side
// builds already live on a single server and can't be multiplexed.
async function enqueueServerGroupDeploy({ action, serverGroupRef, triggeredBy, options }) {
  if (action !== JobAction.DEPLOY) {
    throw new ValidationError(
      `server_group target supports only action='deploy' (got '${action}')`,
    );
  }
  const appRef = options?.applicationId ?? options?.applicationName;
  if (!appRef) {
    throw new ValidationError('server_group deploy requires options.applicationId');
  }
  const app = await resolveApp(appRef);
  if (!app.enabled) throw new ValidationError(`app ${app.name} is disabled`);
  if (app.build_strategy !== BuildStrategy.CONTROLLER) {
    throw new ValidationError(
      `server_group deploy requires build_strategy='controller' (app ${app.name} uses '${app.build_strategy}')`,
    );
  }

  const sg = await resolveServerGroup(serverGroupRef);
  const memberIds = await serverGroups.listMemberIds(sg.id);
  if (memberIds.length === 0) {
    throw new ValidationError(`server-group ${sg.name} has no members`);
  }

  return enqueueControllerBuild(app, triggeredBy, options, {
    deployServerIds: memberIds,
    serverGroupName: sg.name,
  });
}

async function applyExpectedState(appId, action) {
  const next = EXPECTED_STATE_FOR_ACTION[action];
  if (!next) return;
  await applications.setExpectedState(appId, next).catch(() => {});
}

async function resolveApp(idOrName) {
  if (typeof idOrName === 'number' || /^\d+$/.test(String(idOrName))) {
    return applications.get(Number(idOrName));
  }
  // fallback: linear scan (list is small) — could be optimized with a name index
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
