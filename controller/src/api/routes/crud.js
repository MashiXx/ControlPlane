// CRUD endpoints for applications / groups / servers.
// Mounted under /api by buildHttpApp; sits behind requireAuth.
//
// Writes happen directly on the repository layer — NOT through the
// orchestrator. Metadata mutations aren't jobs; only target-server
// actions (restart/build/deploy) go through enqueueAction.
//
// Every successful mutation writes an audit_logs row via writeAudit
// (actor, action, target, result, httpStatus, metadata). Env values
// and raw tokens are NEVER logged.

import { Router } from 'express';
import crypto from 'node:crypto';
import { ValidationError, ConflictError } from '@cp/shared/errors';
import { sha256Hex } from '@cp/shared/ids';
import {
  AppCreate, AppUpdate,
  GroupCreate, GroupUpdate,
  ServerCreate, ServerUpdate,
  ServerGroupCreate, ServerGroupUpdate,
} from '@cp/shared/schemas';
import {
  applications, groups, servers, serverGroups,
} from '../../db/repositories.js';
import { writeAudit } from '../../audit/audit.js';

const actorOf = (req) => req.actor ?? 'unknown';

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

// Summary of edited field NAMES for audit (never values).
const diffKeys = (patch) => Object.keys(patch).filter((k) => k !== 'env');

// Sanitize env for audit: keys + count + byte size, never values.
const envSummary = (env) => env
  ? { keys: Object.keys(env), count: Object.keys(env).length, bytes: JSON.stringify(env).length }
  : null;

const parseId = (raw) => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('invalid id');
  return id;
};

export function crudRouter({ getWsHub }) {
  const r = Router();

  // ─── applications ─────────────────────────────────────────────────────
  r.post('/applications', async (req, res, next) => {
    try {
      const body = parse(AppCreate, req.body);
      const row = await applications.create(body);
      await writeAudit({
        actor: actorOf(req), action: 'app.create',
        targetType: 'app', targetId: String(row.id),
        result: 'success', httpStatus: 201,
        metadata: { fields: diffKeys(body), env: envSummary(body.env) },
      });
      res.status(201).json(row);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return next(new ConflictError('application name already exists on this server'));
      next(e);
    }
  });

  r.patch('/applications/:id', async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      const patch = parse(AppUpdate, req.body);
      const before = await applications.get(id);
      const row = await applications.update(id, patch);
      await writeAudit({
        actor: actorOf(req), action: 'app.update',
        targetType: 'app', targetId: String(id),
        result: 'success', httpStatus: 200,
        metadata: { fields: diffKeys(patch), env: envSummary(patch.env) },
      });
      if (typeof patch.trusted === 'boolean' && patch.trusted !== Boolean(before.trusted)) {
        await writeAudit({
          actor: actorOf(req), action: 'app.trusted.toggle',
          targetType: 'app', targetId: String(id),
          result: 'success', httpStatus: 200,
          metadata: { from: Boolean(before.trusted), to: patch.trusted },
        });
      }
      res.json(row);
    } catch (e) { next(e); }
  });

  r.delete('/applications/:id', async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      await applications.delete(id);
      await writeAudit({
        actor: actorOf(req), action: 'app.delete',
        targetType: 'app', targetId: String(id),
        result: 'success', httpStatus: 204,
      });
      res.status(204).end();
    } catch (e) { next(e); }
  });

  // ─── groups ───────────────────────────────────────────────────────────
  r.post('/groups', async (req, res, next) => {
    try {
      const body = parse(GroupCreate, req.body);
      const row = await groups.create(body);
      await writeAudit({
        actor: actorOf(req), action: 'group.create',
        targetType: 'group', targetId: String(row.id),
        result: 'success', httpStatus: 201, metadata: { name: body.name },
      });
      res.status(201).json(row);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return next(new ConflictError('group name already exists'));
      next(e);
    }
  });

  r.patch('/groups/:id', async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      const patch = parse(GroupUpdate, req.body);
      const row = await groups.update(id, patch);
      await writeAudit({
        actor: actorOf(req), action: 'group.update',
        targetType: 'group', targetId: String(id),
        result: 'success', httpStatus: 200, metadata: { fields: diffKeys(patch) },
      });
      res.json(row);
    } catch (e) { next(e); }
  });

  r.delete('/groups/:id', async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      await groups.delete(id);
      await writeAudit({
        actor: actorOf(req), action: 'group.delete',
        targetType: 'group', targetId: String(id),
        result: 'success', httpStatus: 204,
      });
      res.status(204).end();
    } catch (e) { next(e); }
  });

  // ─── server-groups (deploy fan-out targets) ──────────────────────────
  //
  // `serverIds` is optional on create/update. When present it fully
  // replaces the membership — simpler for the UI and matches how the
  // dashboard posts the edited form. Membership is wiped automatically on
  // DELETE via the ON DELETE CASCADE FK, no manual cleanup needed.
  r.post('/server-groups', async (req, res, next) => {
    try {
      const body = parse(ServerGroupCreate, req.body);
      const row = await serverGroups.create({
        name: body.name, description: body.description,
      });
      if (body.serverIds) {
        await serverGroups.replaceMembers(row.id, body.serverIds);
      }
      await writeAudit({
        actor: actorOf(req), action: 'server-group.create',
        targetType: 'server_group', targetId: String(row.id),
        result: 'success', httpStatus: 201,
        metadata: { name: body.name, members: body.serverIds?.length ?? 0 },
      });
      res.status(201).json(row);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return next(new ConflictError('server-group name already exists'));
      next(e);
    }
  });

  r.patch('/server-groups/:id', async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      const patch = parse(ServerGroupUpdate, req.body);
      const { serverIds, ...metaPatch } = patch;
      const row = await serverGroups.update(id, metaPatch);
      if (serverIds) await serverGroups.replaceMembers(id, serverIds);
      await writeAudit({
        actor: actorOf(req), action: 'server-group.update',
        targetType: 'server_group', targetId: String(id),
        result: 'success', httpStatus: 200,
        metadata: {
          fields: diffKeys(metaPatch),
          members: serverIds ? serverIds.length : undefined,
        },
      });
      res.json(row);
    } catch (e) { next(e); }
  });

  r.delete('/server-groups/:id', async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      await serverGroups.delete(id);
      await writeAudit({
        actor: actorOf(req), action: 'server-group.delete',
        targetType: 'server_group', targetId: String(id),
        result: 'success', httpStatus: 204,
      });
      res.status(204).end();
    } catch (e) { next(e); }
  });

  // ─── servers ──────────────────────────────────────────────────────────
  r.post('/servers', async (req, res, next) => {
    try {
      const body = parse(ServerCreate, req.body);
      const rawToken = crypto.randomBytes(32).toString('base64url');
      const tokenHash = sha256Hex(rawToken);
      const row = await servers.create({ row: body, tokenHash });
      await writeAudit({
        actor: actorOf(req), action: 'server.create',
        targetType: 'server', targetId: String(row.id),
        result: 'success', httpStatus: 201,
        metadata: { name: body.name, hostname: body.hostname, artifact_transfer: body.artifact_transfer },
      });
      res.status(201).json({ server: row, rawToken });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return next(new ConflictError('server name already exists'));
      next(e);
    }
  });

  r.patch('/servers/:id', async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      const patch = parse(ServerUpdate, req.body);
      const row = await servers.update(id, patch);
      await writeAudit({
        actor: actorOf(req), action: 'server.update',
        targetType: 'server', targetId: String(id),
        result: 'success', httpStatus: 200, metadata: { fields: diffKeys(patch) },
      });
      res.json(row);
    } catch (e) { next(e); }
  });

  r.post('/servers/:id/rotate-token', async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      // Throws NotFoundError if the server is gone.
      await servers.get(id);
      const rawToken = crypto.randomBytes(32).toString('base64url');
      const tokenHash = sha256Hex(rawToken);
      await servers.rotateToken(id, tokenHash);
      const hub = getWsHub?.();
      const disconnected = hub?.disconnectServer(id, 'token-rotated') ?? false;
      await writeAudit({
        actor: actorOf(req), action: 'server.rotate-token',
        targetType: 'server', targetId: String(id),
        result: 'success', httpStatus: 200, metadata: { disconnected },
      });
      res.json({ rawToken });
    } catch (e) { next(e); }
  });

  r.delete('/servers/:id', async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      await servers.delete(id);
      await writeAudit({
        actor: actorOf(req), action: 'server.delete',
        targetType: 'server', targetId: String(id),
        result: 'success', httpStatus: 204,
      });
      res.status(204).end();
    } catch (e) { next(e); }
  });

  return r;
}
