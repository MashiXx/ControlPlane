import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { schemas } from '@cp/shared';
import { ValidationError } from '@cp/shared/errors';
import { submitAction } from '../../orchestrator/orchestrator.js';

export function actionsRouter() {
  const r = Router();

  // Tight limit on destructive actions: 30 req/min/actor.
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    keyGenerator: (req) => req.actor ?? req.ip,
    standardHeaders: true, legacyHeaders: false,
  });

  r.post('/actions', limiter, async (req, res, next) => {
    try {
      const parsed = schemas.EnqueueActionBody.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('invalid action request', parsed.error.flatten());
      }
      const { action, target, options } = parsed.data;
      const results = await submitAction({
        action, target, options, triggeredBy: req.actor,
      });
      res.status(202).json({ accepted: true, jobs: results });
    } catch (e) { next(e); }
  });

  return r;
}
