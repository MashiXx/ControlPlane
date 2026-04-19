// Centralized structured logger built on pino.
//
// Every service calls `createLogger({ service: 'controller' })`.
// Output is JSON in production, pretty in dev (if pino-pretty is installed).

import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const isDev = (process.env.NODE_ENV ?? 'development') !== 'production';

const baseOptions = {
  level,
  base: undefined, // we inject our own base via child()
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'headers.authorization',
      'authToken',
      '*.authToken',
      'password',
      '*.password',
    ],
    censor: '[REDACTED]',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
};

let transport;
if (isDev) {
  try {
    transport = pino.transport({
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
    });
  } catch {
    transport = undefined; // pino-pretty optional
  }
}

const root = pino(baseOptions, transport);

export function createLogger(bindings = {}) {
  return root.child(bindings);
}

export function childLogger(parent, bindings = {}) {
  return parent.child(bindings);
}

export { root as rootLogger };
