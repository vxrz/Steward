import { pino } from 'pino';
import { config } from './config.js';
import { activeTraceIds } from './telemetry.js';
import { BRAND } from '@sm/shared';

/**
 * Operational log (JSON lines on stdout, ready for any log shipper). Separate
 * from the tamper-evident audit log, which records who did what.
 * Level: SM_LOG_LEVEL (fatal|error|warn|info|debug|trace, default info).
 */
export const logger = pino({
  level: process.env.SM_LOG_LEVEL ?? (process.env.VITEST ? 'silent' : 'info'),
  base: { service: BRAND.slug, version: config.version },
  timestamp: pino.stdTimeFunctions.isoTime,
  messageKey: 'msg',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-space-auth-key"]',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passphrase',
      '*.clientSecret',
      '*.secret',
      '*.token',
    ],
    censor: '***',
  },
  mixin: () => activeTraceIds(),
});
