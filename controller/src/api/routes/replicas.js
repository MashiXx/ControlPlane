// Replica CRUD — GET / POST / DELETE under /api/applications/:id/servers.
//
// The "replica" is the (application, server) pair. The row it reads/writes
// is application_servers. Membership mutations are NOT jobs (same as every
// other CRUD endpoint) — they write directly through the repo.

import { Router } from 'express';
import {
  NotFoundError, ValidationError, ConflictError,
} from '@cp/shared/errors';
import { ServerStatus } from '@cp/shared/constants';
import { ReplicaAddInput } from '@cp/shared/schemas';
import {
  applications, applicationServers, servers, jobs as jobsRepo,
} from '../../db/repositories.js';
import { writeAudit } from '../../audit/audit.js';

const actorOf = (req) => req.actor ?? 'unknown';
const parseId = (raw) => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('invalid id');
  return id;
};

function parse(schema, body) {
  const r = schema.safeParse(body);
  if (!r.success) {
    const msg = r.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new ValidationError(msg, { issues: r.error.issues });
  }
  return r.data;
}

export function replicasRouter() {
  const r = Router();

  // GET /api/applications/:id/servers — list replicas of an app.
  r.get('/applications/:id/servers', async (req, res, next) => {
    try {
      const appId = parseId(req.params.id);
      await applications.get(appId);                     // 404 if app missing
      const rows = await applicationServers.listForApp(appId);
      res.json(rows);
    } catch (e) { next(e); }
  });

  // POST /api/applications/:id/servers {serverId} — register a replica.
  r.post('/applications/:id/servers', async (req, res, next) => {
    try {
      const appId = parseId(req.params.id);
      const { serverId } = parse(ReplicaAddInput, req.body);
      await applications.get(appId);                     // 404 if app missing
      const server = await servers.get(serverId);        // 404 if server missing
      if (server.status === ServerStatus.DRAINING) {
        throw new ValidationError(`server '${server.name}' is draining; cannot register as replica`);
      }
      try {
        await applicationServers.insert({ applicationId: appId, serverId });
      } catch (err) {
        if (err?.code === 'ER_DUP_ENTRY') {
          throw new ConflictError(`server ${serverId} is already a replica of app ${appId}`);
        }
        throw err;
      }
      await writeAudit({
        actor: actorOf(req), action: 'replica.added',
        targetType: 'application_server', targetId: `${appId}@${serverId}`,
        result: 'success', httpStatus: 201,
        metadata: { applicationId: appId, serverId },
      });
      const row = await applicationServers.get(appId, serverId);
      res.status(201).json(row);
    } catch (e) { next(e); }
  });

  // DELETE /api/applications/:id/servers/:serverId — unregister a replica.
  r.delete('/applications/:id/servers/:serverId', async (req, res, next) => {
    try {
      const appId    = parseId(req.params.id);
      const serverId = parseId(req.params.serverId);

      // Reject if any job for this (app, server) is still queued/running.
      const pending = await jobsRepo.countPendingForReplica(appId, serverId).catch(() => 0);
      if (pending > 0) {
        throw new ConflictError(
          `${pending} job(s) are still queued/running for this replica; wait or cancel them first`,
          { pending },
        );
      }

      try {
        await applicationServers.remove(appId, serverId);
      } catch (err) {
        if (err instanceof NotFoundError) throw err;
        throw err;
      }
      await writeAudit({
        actor: actorOf(req), action: 'replica.removed',
        targetType: 'application_server', targetId: `${appId}@${serverId}`,
        result: 'success', httpStatus: 204,
        metadata: { applicationId: appId, serverId },
      });
      res.status(204).end();
    } catch (e) { next(e); }
  });

  return r;
}
