import { ControlPlaneError, serializeError } from '@cp/shared/errors';
import { createLogger } from '@cp/shared/logger';

const logger = createLogger({ service: 'api.error' });

const codeToStatus = {
  E_VALIDATION:      400,
  E_NOT_FOUND:       404,
  E_AUTH:            401,
  E_CONFLICT:        409,
  E_CMD_NOT_ALLOWED: 400,
  E_SSH_CONNECT:     503,
  E_SSH_TIMEOUT:     504,
  E_TIMEOUT:         504,
};

export function errorHandler(err, req, res, _next) {
  const status = err instanceof ControlPlaneError
    ? (codeToStatus[err.code] ?? 400)
    : 500;
  const body = serializeError(err);
  if (status >= 500) {
    logger.error({ path: req.path, err: body }, 'api:error');
  } else {
    logger.warn({ path: req.path, code: body.code }, 'api:client-error');
  }
  res.status(status).json({ error: body });
}
