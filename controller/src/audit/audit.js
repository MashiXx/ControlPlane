// Central audit writer. Always non-throwing: an audit write failure must
// never break the request path. Errors surface through the logger.

import { audit } from '../db/repositories.js';
import { createLogger } from '@cp/shared/logger';
import { AUDIT_OUTPUT_LIMIT } from '@cp/shared/constants';

const logger = createLogger({ service: 'audit' });

export async function writeAudit(row) {
  const clipped = {
    ...row,
    message: row.message ? clip(row.message, AUDIT_OUTPUT_LIMIT) : null,
  };
  try {
    await audit.write(clipped);
  } catch (err) {
    logger.error({ err: err.message, row: clipped }, 'audit:write-failed');
  }
}

function clip(s, n) {
  if (!s) return s;
  if (s.length <= n) return s;
  return s.slice(0, n - 20) + `…[truncated ${s.length - n} chars]`;
}
