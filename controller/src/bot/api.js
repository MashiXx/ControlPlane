// In-process replacement for bot/src/controllerClient.js.
// Same method names + return shapes — direct calls to repos + orchestrator.

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
