// Read-only replica listing for an application.
//
// Since placement became single-valued (applications.server_id XOR
// applications.server_group_id), replica rows are derived by the controller
// from that placement — operators no longer add or remove replicas directly.
// To change where an app runs, edit the application's placement (PATCH
// /api/applications/:id) or the server-group's membership (PATCH
// /api/server-groups/:id); `application_servers` rows are re-synced
// automatically in both cases.

import { Router } from 'express';
import { ValidationError } from '@cp/shared/errors';
import {
  applications, applicationServers,
} from '../../db/repositories.js';

const parseId = (raw) => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('invalid id');
  return id;
};

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

  return r;
}
