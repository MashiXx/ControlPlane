// BullMQ worker that executes queued actions by dispatching them to the
// appropriate agent over the WS hub.
//
// Flow per job:
//   1. Mark jobs row `running`, bump attempts.
//   2. Resolve the application + server.
//   3. Fail PermanentError if the agent is not connected? No — we treat
//      agent-unavailable as TRANSIENT so BullMQ retries once the agent
//      reconnects. This is the key trick that lets deployments be robust
//      to brief agent restarts.
//   4. Send EXECUTE and await JOB_RESULT.
//   5. Update jobs row, write audit with stdout/stderr tail.

import { createWorker } from '@cp/queue';
import { QueueName } from '@cp/shared/constants';
import { AgentUnavailableError, PermanentError, serializeError } from '@cp/shared/errors';
import { applications, servers, jobs as jobsRepo } from '../db/repositories.js';
import { writeAudit } from '../audit/audit.js';
import { createLogger } from '@cp/shared/logger';

const logger = createLogger({ service: 'controller.worker' });

export function startWorkers({ hub, dispatchTimeoutMs }) {
  const processor = async (job) => {
    const { action, targetType, targetId, triggeredBy } = job.data;
    const queueJobId = job.id;

    await jobsRepo.markRunning(queueJobId, job.attemptsMade + 1).catch(() => {});

    const app = await applications.get(Number(targetId));
    if (!app.enabled) {
      throw new PermanentError(`app ${app.name} is disabled`, { code: 'E_APP_DISABLED' });
    }
    const server = await servers.get(app.server_id);

    const executeFrame = {
      jobId: queueJobId,
      action,
      app: {
        id: app.id,
        name: app.name,
        runtime: app.runtime,
        workdir: app.workdir,
        installCmd: app.install_cmd ?? undefined,
        buildCmd:   app.build_cmd   ?? undefined,
        startCmd:   app.start_cmd,
        stopCmd:    app.stop_cmd    ?? undefined,
        healthCmd:  app.health_cmd  ?? undefined,
        repoUrl:    app.repo_url    ?? undefined,
        branch:     app.branch,
        env:        app.env ? safeJson(app.env) : undefined,
        trusted:    Boolean(app.trusted),
      },
      timeoutMs: dispatchTimeoutMs,
    };

    try {
      const result = await hub.executeAndWait(server.id, executeFrame, {
        timeoutMs: dispatchTimeoutMs,
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
        jobId: null, result: 'success',
        message: combine(result.stdoutTail, result.stderrTail),
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
      // Re-throw: createWorker wraps permanent errors in UnrecoverableError.
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

function combine(a, b) {
  return [a, b].filter(Boolean).join('\n---stderr---\n');
}

function safeJson(v) {
  if (v == null) return undefined;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return undefined; }
  }
  return v;
}
