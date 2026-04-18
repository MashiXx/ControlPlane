// Read-only endpoints consumed by the web dashboard and Telegram bot.

import { Router } from 'express';
import {
  applications, groups, servers, jobs as jobsRepo, audit,
} from '../../db/repositories.js';

export function readRouter() {
  const r = Router();

  r.get('/servers', async (_req, res, next) => {
    try { res.json(await servers.list()); } catch (e) { next(e); }
  });

  r.get('/groups', async (_req, res, next) => {
    try { res.json(await groups.list()); } catch (e) { next(e); }
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
