// Read-only endpoints consumed by the web dashboard and Telegram bot.

import { Router } from 'express';
import {
  applications, groups, servers, serverGroups, jobs as jobsRepo, audit,
} from '../../db/repositories.js';

export function readRouter() {
  const r = Router();

  r.get('/servers', async (_req, res, next) => {
    try { res.json(await servers.list()); } catch (e) { next(e); }
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
    try { res.json(await applications.list()); } catch (e) { next(e); }
  });

  r.get('/applications/:id', async (req, res, next) => {
    try { res.json(await applications.get(Number(req.params.id))); } catch (e) { next(e); }
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
