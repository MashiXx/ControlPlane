// In-process worker that processes queued actions.
//
// Three branches per job, selected from job.data:
//
//   1. build (on controller): run builder.runBuild locally; on success,
//      enqueue a follow-up deploy job carrying the artifactId.
//
//   2. deploy with controller-built artifact: prepare the transfer
//      (HTTP token or rsync push), then dispatch to the agent with an
//      artifact descriptor. Agent handles swap+restart.
//
//   3. Anything else (start/stop/restart/healthcheck/target-build deploy):
//      dispatch to the agent over the WS hub. This is the original flow.
//
// Shared semantics:
//   - Mark `jobs` row running on entry, final state on exit.
//   - Agent-unavailable bubbles as TransientError → the queue retries once
//     the agent reconnects.
//   - Permanent errors (wrapped upstream by createWorker) fail the job.

import { createWorker, enqueueAction } from '@cp/queue';
import {
  BuildStrategy, JobAction, JobTargetType, QueueName, RetryProfile,
} from '@cp/shared/constants';
import {
  AgentUnavailableError, PermanentError, ValidationError, serializeError,
} from '@cp/shared/errors';
import {
  applications, servers, artifacts as artifactsRepo, jobs as jobsRepo, deployments,
} from '../db/repositories.js';
import { writeAudit } from '../audit/audit.js';
import { createLogger } from '@cp/shared/logger';

import { ArtifactStore } from '../build/artifactStore.js';
import { runBuild } from '../build/builder.js';
import { prepareArtifactForTarget } from '../transport/artifactTransfer.js';

const logger = createLogger({ service: 'controller.worker' });

export function startWorkers({ hub, dispatchTimeoutMs, config }) {
  const store = new ArtifactStore({ baseDir: config.artifactStoreDir });
  store.ensure().catch((err) => logger.error({ err: err.message }, 'store:ensure-failed'));

  const processor = async (job) => {
    const { action, targetId, triggeredBy, payload } = job.data;
    const queueJobId = job.id;
    await jobsRepo.markRunning(queueJobId, job.attemptsMade + 1).catch(() => {});

    const app = await applications.get(Number(targetId));
    if (!app.enabled) {
      throw new PermanentError(`app ${app.name} is disabled`, { code: 'E_APP_DISABLED' });
    }

    try {
      // Branch 1: build on controller host
      if (action === JobAction.BUILD && payload?.buildOnController) {
        const r = await runControllerBuild({ job, app, triggeredBy, payload, store });
        await jobsRepo.markFinished(queueJobId, 'success', { result: r });
        await writeAudit({
          actor: triggeredBy, action: 'build.controller', targetType: 'app',
          targetId: String(app.id), result: 'success',
          message: `artifact #${r.artifactId} sha=${r.sha256?.slice(0, 12)} reused=${r.reused}`,
        });
        return r;
      }

      // Branch 2: deploy an already-built artifact to a target server
      if (action === JobAction.DEPLOY && payload?.artifactId) {
        const r = await runControllerDeploy({
          job, app, triggeredBy, payload, hub, dispatchTimeoutMs, config,
        });
        await jobsRepo.markFinished(queueJobId, 'success', { result: r });
        await writeAudit({
          actor: triggeredBy, action: 'deploy.controller', targetType: 'app',
          targetId: String(app.id), result: 'success',
          message: `release=${r.releaseId} artifact=${r.artifactId}`,
        });
        return r;
      }

      // Branch 3: anything else — dispatch to agent unchanged
      const result = await dispatchToAgent({
        job, app, triggeredBy, hub, dispatchTimeoutMs,
      });
      await jobsRepo.markFinished(queueJobId, 'success', {
        result: {
          exitCode:   result.exitCode ?? 0,
          durationMs: result.durationMs ?? 0,
          stdoutTail: result.stdoutTail?.slice(-4096),
          stderrTail: result.stderrTail?.slice(-4096),
        },
      });
      await writeAudit({
        actor: triggeredBy, action, targetType: 'app', targetId: String(app.id),
        result: 'success', message: combine(result.stdoutTail, result.stderrTail),
      });
      return result;
    } catch (err) {
      const s = serializeError(err);
      await jobsRepo.markFinished(queueJobId, 'failed', {
        errorCode: s.code, errorMessage: s.message,
      });
      await writeAudit({
        actor: triggeredBy, action, targetType: 'app', targetId: String(app.id),
        result: 'failure', message: s.message,
        metadata: { code: s.code, transient: s.transient, attempt: job.attemptsMade + 1 },
      });
      throw err;
    }
  };

  const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 4);
  const workers = Object.values(QueueName).map((name) =>
    createWorker(name, processor, { concurrency }),
  );
  logger.info({ queues: Object.values(QueueName), concurrency }, 'workers:started');
  return workers;
}

// ─── Branch 1: build on controller ──────────────────────────────────────
async function runControllerBuild({ job, app, triggeredBy, payload, store }) {
  if (app.build_strategy !== BuildStrategy.CONTROLLER) {
    throw new PermanentError(
      `build-on-controller requested but app.build_strategy=${app.build_strategy}`,
    );
  }

  const buildJobDbRow = await jobsRepo.getByQueueJobId(job.id);
  const buildJobDbId = buildJobDbRow?.id ?? 0;

  const { artifact, reused, buildId } = await runBuild({
    app, store,
    artifactRepo: artifactsRepo,
    buildJobDbId,
    commitSha: payload?.commitSha,
  });

  const releaseId = buildId ?? `${Math.floor(Date.now() / 1000)}-${(artifact.commit_sha ?? 'na').slice(0, 7)}`;

  // When the orchestrator targeted a server_group, payload.deployServerIds
  // carries the fan-out list. Otherwise we deploy to the app's home server
  // (classic single-target flow). Either way the same artifact is reused;
  // the artifact store is content-addressed, not server-scoped.
  const targetServerIds = Array.isArray(payload?.deployServerIds) && payload.deployServerIds.length
    ? payload.deployServerIds
    : [app.server_id];

  const deployEnqueues = [];
  for (const targetServerId of targetServerIds) {
    const deployEnq = await enqueueAction({
      action: JobAction.DEPLOY,
      targetType: JobTargetType.APP,
      // Include the target server in the id so fan-out to N servers produces
      // N distinct queue job ids. Without this the idempotency key collapses
      // all N deploys into one for a single-app fan-out.
      targetId: `${app.id}@${targetServerId}`,
      triggeredBy,
      payload: {
        artifactId: artifact.id,
        releaseId,
        parentBuildQueueJobId: job.id,
        serverIdOverride: targetServerId,
      },
    });
    await jobsRepo.insert({
      queueJobId: deployEnq.queueJobId,
      parentJobId: buildJobDbId,
      idempotencyKey: deployEnq.idempotencyKey,
      action: JobAction.DEPLOY,
      targetType: JobTargetType.APP,
      applicationId: app.id,
      groupId: app.group_id,
      serverId: targetServerId,
      maxAttempts: RetryProfile[JobAction.DEPLOY].attempts,
      triggeredBy,
      payload: {
        artifactId: artifact.id,
        releaseId,
        serverIdOverride: targetServerId,
      },
    }).catch((err) => {
      if (err?.code !== 'ER_DUP_ENTRY') throw err;
    });
    deployEnqueues.push({ serverId: targetServerId, queueJobId: deployEnq.queueJobId });
  }

  return {
    artifactId: artifact.id,
    sha256: artifact.sha256,
    reused,
    releaseId,
    deploys: deployEnqueues,
    fanOut: payload?.serverGroupName
      ? { serverGroupName: payload.serverGroupName, count: targetServerIds.length }
      : undefined,
  };
}

// ─── Branch 2: deploy controller-built artifact ─────────────────────────
async function runControllerDeploy({ job, app, triggeredBy, payload, hub, dispatchTimeoutMs, config }) {
  // serverIdOverride is set by the build phase when the orchestrator targeted
  // a server_group, so the same artifact can be delivered to several servers
  // without each deploy re-reading the app row for app.server_id.
  const targetServerId = payload.serverIdOverride ?? app.server_id;
  const server = await servers.get(targetServerId);
  const artifact = await artifactsRepo.get(payload.artifactId);
  const releaseId = payload.releaseId ?? `${Math.floor(Date.now() / 1000)}-${(artifact.commit_sha ?? 'na').slice(0, 7)}`;

  const descriptor = await prepareArtifactForTarget({
    server, app, artifact, releaseId,
    secret:        config.artifactSecret,
    publicBaseUrl: config.publicBaseUrl,
  });

  const jobDbRow = await jobsRepo.getByQueueJobId(job.id);
  const deployId = await deployments.insert({
    applicationId: app.id,
    jobId:         jobDbRow?.id ?? 0,
    commitSha:     artifact.commit_sha,
    branch:        artifact.branch,
    artifactId:    artifact.id,
    releaseId,
    status:        'pending',
  }).catch((err) => {
    if (err?.code === 'ER_DUP_ENTRY') return null; throw err;
  });

  const executeFrame = {
    jobId:  job.id,
    action: JobAction.DEPLOY,
    app:    appToFrame(app),
    artifact: descriptor,
    timeoutMs: dispatchTimeoutMs,
  };

  try {
    const result = await hub.executeAndWait(server.id, executeFrame, {
      timeoutMs: dispatchTimeoutMs,
    });
    if (deployId) await deployments.markDeployed(deployId).catch(() => {});
    return {
      artifactId: artifact.id,
      releaseId,
      exitCode: result.exitCode ?? 0,
      stdoutTail: result.stdoutTail?.slice(-4096),
    };
  } catch (err) {
    if (deployId) await deployments.markFailed(deployId).catch(() => {});
    throw err;
  }
}

// ─── Branch 3: generic dispatch (start/stop/restart/etc) ────────────────
async function dispatchToAgent({ job, app, hub, dispatchTimeoutMs }) {
  // serverIdOverride is carried through for actions invoked as part of a
  // server-group fan-out; for the normal single-target case it's unset and
  // we fall back to the app's home server.
  const targetServerId = job.data.payload?.serverIdOverride ?? app.server_id;
  const server = await servers.get(targetServerId);
  const executeFrame = {
    jobId: job.id,
    action: job.data.action,
    app: appToFrame(app),
    timeoutMs: dispatchTimeoutMs,
  };
  return hub.executeAndWait(server.id, executeFrame, { timeoutMs: dispatchTimeoutMs });
}

// ─── helpers ────────────────────────────────────────────────────────────
function appToFrame(app) {
  return {
    id: app.id,
    name: app.name,
    runtime: app.runtime,
    workdir: app.workdir,
    remoteInstallPath: app.remote_install_path ?? undefined,
    buildStrategy:     app.build_strategy ?? 'target',
    launchMode:        app.launch_mode ?? 'wrapped',
    installCmd: app.install_cmd ?? undefined,
    buildCmd:   app.build_cmd   ?? undefined,
    startCmd:   app.start_cmd,
    stopCmd:    app.stop_cmd    ?? undefined,
    statusCmd:  app.status_cmd  ?? undefined,
    logsCmd:    app.logs_cmd    ?? undefined,
    healthCmd:  app.health_cmd  ?? undefined,
    repoUrl:    app.repo_url    ?? undefined,
    branch:     app.branch,
    env:        app.env ? safeJson(app.env) : undefined,
    trusted:    Boolean(app.trusted),
  };
}

function combine(a, b) {
  return [a, b].filter(Boolean).join('\n---stderr---\n');
}

function safeJson(v) {
  if (v == null) return undefined;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return undefined; } }
  return v;
}
