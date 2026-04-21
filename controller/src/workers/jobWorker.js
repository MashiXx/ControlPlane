// In-process worker. Post-agentless there are two branches:
//
//   1. BUILD  (on controller): run builder.runBuild locally; on success,
//      enqueue one DEPLOY per target server carrying artifactId+releaseId.
//
//   2. DEPLOY / START / STOP / RESTART / HEALTHCHECK: call the matching
//      remoteExec function. deploy additionally reads the artifact row and
//      passes it to deployAction; everything else is a direct dispatch.
//
// Shared semantics (unchanged from the agent era):
//   - Mark `jobs` row running on entry, final state on exit.
//   - Retry on TransientError via the queue; PermanentError fails fast.
//   - Every terminal status writes an audit_logs row.

import { createWorker, enqueueAction, jobIdentity } from '@cp/queue';
import {
  JobAction, JobTargetType, QueueName, RetryProfile,
} from '@cp/shared/constants';
import { PermanentError, serializeError } from '@cp/shared/errors';
import { createLogger } from '@cp/shared/logger';

import {
  applications, servers, artifacts as artifactsRepo, jobs as jobsRepo, deployments,
} from '../db/repositories.js';
import { writeAudit } from '../audit/audit.js';

import { ArtifactStore } from '../build/artifactStore.js';
import { runBuild } from '../build/builder.js';
import {
  startAction, stopAction, restartAction, healthcheckAction, deployAction,
} from '../exec/remoteExec.js';

const logger = createLogger({ service: 'controller.worker' });

// Maps a job.action to the matching remoteExec function. Excludes BUILD
// (handled inline) and DEPLOY (needs artifact hydration first).
const EXEC_FOR_ACTION = Object.freeze({
  [JobAction.START]:       startAction,
  [JobAction.STOP]:        stopAction,
  [JobAction.RESTART]:     restartAction,
  [JobAction.HEALTHCHECK]: healthcheckAction,
});

export function startWorkers({ broadcastUi, config }) {
  const store = new ArtifactStore({ baseDir: config.artifactStoreDir });
  store.ensure().catch((err) => logger.error({ err: err.message }, 'store:ensure-failed'));

  const makeLogStreamer = (queueJobId) => ({ stream, data }) => {
    try {
      broadcastUi?.({
        op: 'log:chunk',
        jobId: queueJobId,
        stream,
        dataB64: Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(String(data)).toString('base64'),
      });
    } catch { /* noop */ }
  };

  const processor = async (job) => {
    const { action, targetId, triggeredBy, payload } = job.data;
    const queueJobId = job.id;
    await jobsRepo.markRunning(queueJobId, job.attemptsMade + 1).catch(() => {});

    // Fan-out deploys encode targetId as `${appId}@${serverId}` so the queue
    // idempotency key stays unique per target server. Prefer an explicit
    // payload.applicationId so we never have to parse that composite here.
    const appId = payload?.applicationId ?? Number(targetId);
    const app = await applications.get(appId);
    if (!app.enabled) {
      throw new PermanentError(`app ${app.name} is disabled`, { code: 'E_APP_DISABLED' });
    }

    const onChunk = makeLogStreamer(queueJobId);

    try {
      // ─── BUILD ──────────────────────────────────────────────────────
      if (action === JobAction.BUILD) {
        const r = await runControllerBuild({ job, app, triggeredBy, payload, store, config, onChunk });
        await jobsRepo.markFinished(queueJobId, 'success', { result: r });
        await writeAudit({
          actor: triggeredBy, action: 'build.controller', targetType: 'app',
          targetId: String(app.id), result: 'success',
          message: `artifact #${r.artifactId} sha=${r.sha256?.slice(0, 12)} reused=${r.reused}`,
        });
        return r;
      }

      // ─── DEPLOY ─────────────────────────────────────────────────────
      if (action === JobAction.DEPLOY) {
        const r = await runDeploy({ job, app, triggeredBy, payload, onChunk });
        await jobsRepo.markFinished(queueJobId, 'success', { result: r });
        await writeAudit({
          actor: triggeredBy, action: 'deploy', targetType: 'app',
          targetId: String(app.id), result: 'success',
          message: `release=${r.releaseId} artifact=${r.artifactId}`,
        });
        return r;
      }

      // ─── START / STOP / RESTART / HEALTHCHECK ───────────────────────
      const exec = EXEC_FOR_ACTION[action];
      if (!exec) {
        throw new PermanentError(`unsupported action: ${action}`, { code: 'E_UNSUPPORTED_ACTION' });
      }
      // serverIdOverride is carried through for server-group fan-outs
      // (restart-after-failed-deploy style flows). For single-app actions
      // the app's home server is used.
      const server = await servers.get(
        payload?.serverIdOverride ?? app.server_id,
      );
      const effectiveApp = { ...app, server_id: server.id };
      const result = await exec(effectiveApp, { onChunk });
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

// ─── BUILD branch ───────────────────────────────────────────────────────
async function runControllerBuild({ job, app, triggeredBy, payload, store, config, onChunk }) {
  const buildJobDbRow = await jobsRepo.getByQueueJobId(job.id);
  const buildJobDbId = buildJobDbRow?.id ?? 0;

  // builder.runBuild calls its onChunk as (buf, stream); our downstream
  // broadcast expects ({ stream, data }). Bridge between the two shapes.
  const builderChunk = onChunk
    ? (buf, stream) => onChunk({ stream: stream ?? 'stdout', data: buf })
    : undefined;

  const { artifact, reused, buildId } = await runBuild({
    app, store,
    artifactRepo: artifactsRepo,
    buildJobDbId,
    commitSha: payload?.commitSha,
    workdirBase: config?.buildWorkdirBase,
    onChunk: builderChunk,
  });

  const releaseId = buildId ?? `${Math.floor(Date.now() / 1000)}-${(artifact.commit_sha ?? 'na').slice(0, 7)}`;

  // When the orchestrator targeted a server_group, payload.deployServerIds
  // carries the fan-out list. Otherwise deploy to the app's home server.
  const targetServerIds = Array.isArray(payload?.deployServerIds) && payload.deployServerIds.length
    ? payload.deployServerIds
    : [app.server_id];

  const deployEnqueues = [];
  for (const targetServerId of targetServerIds) {
    const enqInput = {
      action: JobAction.DEPLOY,
      targetType: JobTargetType.APP,
      targetId: `${app.id}@${targetServerId}`,
      triggeredBy,
      payload: {
        applicationId: app.id,
        artifactId: artifact.id,
        releaseId,
        parentBuildQueueJobId: job.id,
        serverIdOverride: targetServerId,
      },
    };
    const identity = jobIdentity(enqInput);
    await jobsRepo.insert({
      queueJobId: identity.queueJobId,
      parentJobId: buildJobDbId,
      idempotencyKey: identity.idempotencyKey,
      action: JobAction.DEPLOY,
      targetType: JobTargetType.APP,
      applicationId: app.id,
      groupId: app.group_id,
      serverId: targetServerId,
      maxAttempts: RetryProfile[JobAction.DEPLOY].attempts,
      triggeredBy,
      payload: {
        applicationId: app.id,
        artifactId: artifact.id,
        releaseId,
        serverIdOverride: targetServerId,
      },
    }).catch((err) => {
      if (err?.code !== 'ER_DUP_ENTRY') throw err;
    });
    const deployEnq = await enqueueAction(enqInput);
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

// ─── DEPLOY branch ──────────────────────────────────────────────────────
async function runDeploy({ job, app, triggeredBy, payload, onChunk }) {
  if (!payload?.artifactId) {
    throw new PermanentError('deploy job missing artifactId — build chaining broken', {
      code: 'E_DEPLOY_NO_ARTIFACT',
    });
  }
  const targetServerId = payload.serverIdOverride ?? app.server_id;
  const server = await servers.get(targetServerId);
  const artifact = await artifactsRepo.get(payload.artifactId);
  const releaseId = payload.releaseId
    ?? `${Math.floor(Date.now() / 1000)}-${(artifact.commit_sha ?? 'na').slice(0, 7)}`;

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

  try {
    // deployAction resolves the host from app.server_id; override just for
    // this invocation so fan-out deploys hit the right server.
    const result = await deployAction(
      { ...app, server_id: server.id },
      artifact,
      releaseId,
      { onChunk },
    );
    if (deployId) await deployments.markDeployed(deployId).catch(() => {});
    return {
      artifactId: artifact.id,
      releaseId,
      exitCode: result.exitCode ?? 0,
      stdoutTail: result.stdoutTail?.slice(-4096),
      stderrTail: result.stderrTail?.slice(-4096),
    };
  } catch (err) {
    if (deployId) await deployments.markFailed(deployId).catch(() => {});
    throw err;
  }
}

function combine(a, b) {
  return [a, b].filter(Boolean).join('\n---stderr---\n');
}
