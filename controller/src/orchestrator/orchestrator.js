// Orchestrator: takes a user-facing action request (from REST / bot / web),
// validates the target, enqueues in-process job(s), writes the corresponding
// rows into the `jobs` table, and records an audit entry.
//
// For group actions it fans out to one job per application in the group.

import { enqueueAction, enqueueGroupAction } from '@cp/queue';
import {
  BuildStrategy,
  JobAction, JobActions, JobTargetType, ProcessState, RetryProfile,
} from '@cp/shared/constants';
import { NotFoundError, ValidationError } from '@cp/shared/errors';
import { applications, groups, jobs as jobsRepo } from '../db/repositories.js';
import { writeAudit } from '../audit/audit.js';

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

  throw new ValidationError(`unsupported target.type: ${target.type}`);
}

async function enqueueOne(action, app, triggeredBy, options) {
  // Refuse obviously-invalid combinations up-front (saves a queue round-trip).
  if (action === JobAction.RESTART && app.process_state === ProcessState.UNKNOWN) {
    // Allowed, but logged — the agent will sort it out.
  }
  if (action === JobAction.START && !app.start_cmd) {
    throw new ValidationError(`app ${app.name} has no start_cmd`);
  }
  if (!app.enabled) throw new ValidationError(`app ${app.name} is disabled`);

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

async function enqueueControllerBuild(app, triggeredBy, options) {
  const profile = RetryProfile[JobAction.BUILD];
  const enq = await enqueueAction({
    action: JobAction.BUILD,
    targetType: JobTargetType.APP,
    targetId: app.id,
    triggeredBy,
    payload: {
      appName: app.name,
      serverId: app.server_id,
      buildOnController: true,    // processor branches on this
      commitSha: options?.commitSha,
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
    payload: { buildOnController: true, options },
  }).catch((err) => {
    if (err?.code === 'ER_DUP_ENTRY') return null;
    throw err;
  });

  await writeAudit({
    actor: triggeredBy, action: 'deploy.plan', targetType: 'app', targetId: String(app.id),
    jobId, result: 'info',
    message: `build-then-deploy for ${app.name} (build_strategy=controller)`,
  });

  return {
    jobId,
    queueJobId: enq.queueJobId,
    application: { id: app.id, name: app.name },
    action: JobAction.DEPLOY,
    twoPhase: true,
    phase: 'build',
  };
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
