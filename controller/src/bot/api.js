// Adapter the in-process Telegram bot uses to talk to the controller.
// Reads go straight to the repositories; enqueue() goes through the
// orchestrator's submitAction (the single chokepoint for state-changing
// actions, same as REST). Returns { accepted, jobs } so format.js's
// fmtEnqueueResult keeps working.

import { applications, groups, servers, jobs as jobsRepo } from '../db/repositories.js';
import { submitAction } from '../orchestrator/orchestrator.js';

export class BotApi {
  listGroups()         { return groups.list(); }
  listApplications()   { return applications.list(); }
  listServers()        { return servers.list(); }
  getApplication(id)   { return applications.get(Number(id)); }
  getJob(id)           { return jobsRepo.get(Number(id)); }

  async enqueue({ action, target, options, triggeredBy }) {
    const jobs = await submitAction({ action, target, options, triggeredBy });
    return { accepted: true, jobs };
  }
}
