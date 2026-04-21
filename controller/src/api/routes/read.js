// Read-only endpoints consumed by the web dashboard and Telegram bot.

import { Router } from 'express';
import {
  applications, applicationServers, groups, servers, serverGroups,
  jobs as jobsRepo, audit,
} from '../../db/repositories.js';

export function readRouter() {
  const r = Router();

  r.get('/servers', async (_req, res, next) => {
    try { res.json(await servers.list()); } catch (e) { next(e); }
  });

  r.get('/servers/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const [server, apps] = await Promise.all([
        servers.get(id),
        applicationServers.listForServer(id),
      ]);
      res.json({ ...server, applications: apps });
    } catch (e) { next(e); }
  });

  r.get('/groups', async (_req, res, next) => {
    try { res.json(await groups.list()); } catch (e) { next(e); }
  });

  // Server-groups (fan-out deploy targets) — list returns member_count; the
  // detail endpoint attaches the full member rows so the UI can render the
  // group's servers without a second round-trip.
  r.get('/server-groups', async (_req, res, next) => {
    try { res.json(await serverGroups.list()); } catch (e) { next(e); }
  });

  r.get('/server-groups/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const [group, members] = await Promise.all([
        serverGroups.get(id),
        serverGroups.listMembers(id),
      ]);
      res.json({ ...group, members });
    } catch (e) { next(e); }
  });

  r.get('/applications', async (_req, res, next) => {
    try { res.json(await applications.listWithReplicaCounts()); } catch (e) { next(e); }
  });

  r.get('/applications/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const [app, replicas] = await Promise.all([
        applications.get(id),
        applicationServers.listForApp(id),
      ]);
      // Enrich with human-readable placement names so the SPA can render
      // "runs on server X" / "runs on server-group Y" without a join.
      const [server, group] = await Promise.all([
        app.server_id != null
          ? servers.get(app.server_id).catch(() => null) : null,
        app.server_group_id != null
          ? serverGroups.get(app.server_group_id).catch(() => null) : null,
      ]);
      res.json({
        ...app,
        server_name: server?.name ?? null,
        server_group_name: group?.name ?? null,
        replicas,
      });
    } catch (e) { next(e); }
  });

  r.get('/jobs', async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit ?? 100), 500);
      res.json(await jobsRepo.listRecent(limit));
    } catch (e) { next(e); }
  });

  r.get('/jobs/:id', async (req, res, next) => {
    try {
      const job = await jobsRepo.get(Number(req.params.id));
      if (!job) return res.status(404).json({ error: { code: 'E_NOT_FOUND', message: 'job not found' } });
      res.json(job);
    } catch (e) { next(e); }
  });

  r.get('/audit', async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit ?? 200), 1000);
      res.json(await audit.listRecent(limit));
    } catch (e) { next(e); }
  });

  return r;
}
