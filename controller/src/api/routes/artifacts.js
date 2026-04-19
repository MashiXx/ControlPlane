// Artifact routes:
//
//   POST /api/artifacts/:id/token  → { url, token, expiresAt }
//     Auth: normal API token (this one is gated by /api auth).
//     Used by the worker to prepare a download URL for the agent.
//
//   GET  /artifacts/:id/blob?token=…  → streams the tar.gz
//     Auth: HMAC token (no bearer). Lives OUTSIDE /api so agents can
//     fetch without holding an API token.

import { Router } from 'express';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { issueArtifactToken, verifyArtifactToken } from '../../build/artifactTokens.js';
import { artifacts } from '../../db/repositories.js';
import { ARTIFACT_TOKEN_TTL_SEC } from '@cp/shared/constants';

export function artifactTokenRouter({ secret, publicBaseUrl }) {
  const r = Router();

  r.post('/artifacts/:id/token', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const art = await artifacts.get(id);
      const ttl = Math.min(Number(req.body?.ttlSec ?? ARTIFACT_TOKEN_TTL_SEC),
                           ARTIFACT_TOKEN_TTL_SEC);
      const token = issueArtifactToken({ secret, artifactId: id, ttlSec: ttl });
      res.json({
        url: `${publicBaseUrl}/artifacts/${id}/blob?token=${encodeURIComponent(token)}`,
        token,
        expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
        sha256: art.sha256,
        sizeBytes: Number(art.size_bytes),
      });
    } catch (e) { next(e); }
  });

  return r;
}

export function artifactBlobRouter({ secret }) {
  const r = Router();

  r.get('/artifacts/:id/blob', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      verifyArtifactToken({ secret, token: req.query.token, artifactId: id });

      const art = await artifacts.get(id);
      const stats = await stat(art.path);

      res.setHeader('content-type', 'application/gzip');
      res.setHeader('content-length', stats.size);
      res.setHeader('x-artifact-sha256', art.sha256);
      res.setHeader('cache-control', 'private, no-store');

      const stream = createReadStream(art.path);
      stream.on('error', (err) => next(err));
      stream.pipe(res);
    } catch (e) { next(e); }
  });

  return r;
}
