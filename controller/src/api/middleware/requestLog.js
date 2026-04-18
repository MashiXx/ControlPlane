import { createLogger } from '@cp/shared/logger';

const logger = createLogger({ service: 'api.http' });

export function requestLog() {
  return (req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      logger.info({
        method: req.method, path: req.path,
        status: res.statusCode, ms: Date.now() - started,
        actor: req.actor,
      }, 'http');
    });
    next();
  };
}
