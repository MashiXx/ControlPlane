// Adapter the in-process Telegram bot uses to talk to the controller.
// Reads go straight to the repositories; enqueue() goes through the
// orchestrator's submitAction (the single chokepoint for state-changing
// actions, same as REST). Returns { accepted, jobs } so format.js's
// fmtEnqueueResult keeps working.

import { applications as appsRepo, applicationServers, servers as serversRepo, groups, jobs as jobsRepo } from '../db/repositories.js';
import { submitAction } from '../orchestrator/orchestrator.js';

export class BotApi {
  listGroups()         { return groups.list(); }
  async listApplications() {
    const apps = await appsRepo.list();
    // Enrich with replica counts.
    const out = [];
    for (const app of apps) {
      const reps = await applicationServers.listForApp(app.id);
      out.push({
        ...app,
        replicaCountTotal: reps.length,
        replicaCountRunning: reps.filter((r) => r.process_state === 'running').length,
      });
    }
    return out;
  }
  async listReplicas(appId) { return applicationServers.listForApp(appId); }
  async listServers()       { return serversRepo.list(); }
  getApplication(id)   { return appsRepo.get(Number(id)); }
  getJob(id)           { return jobsRepo.get(Number(id)); }

  async enqueue({ action, target, options, triggeredBy }) {
    const jobs = await submitAction({ action, target, options, triggeredBy });
    return { accepted: true, jobs };
  }
}
