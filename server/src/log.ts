import { pino } from 'pino';
import { config, env } from './config.js';
import { activeTraceIds } from './telemetry.js';
import { BRAND } from '@sm/shared';

/**
 * Operational log (JSON lines on stdout, ready for any log shipper). Separate
 * from the tamper-evident audit log, which records who did what.
 * Level: SM_LOG_LEVEL (fatal|error|warn|info|debug|trace, default info); SM_LOG_LEVEL_FORMAT=label writes it as a word.
 */
export const logger = pino({
  level: env.SM_LOG_LEVEL ?? (process.env.VITEST ? 'silent' : 'info'),
  base: { service: BRAND.slug, version: config.version },
  timestamp: pino.stdTimeFunctions.isoTime,
  messageKey: 'msg',
  // SM_LOG_LEVEL_FORMAT=label: "level":"info" instead of pino's "level":30
  ...(env.SM_LOG_LEVEL_FORMAT === 'label' ? { formatters: { level: (label: string) => ({ level: label }) } } : {}),
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
      '*.secrets',
      '*.token',
      '*.access_token',
      '*.refresh_token',
      '*.id_token',
      '*.client_secret',
      '*.sessionKey',
      '*.linkKey',
      '*.masterPassphrase',
      'req.headers["x-sm-session"]',
      'req.headers["x-api-key"]',
      'req.headers["proxy-authorization"]',
    ],
    censor: '***',
  },
  mixin: () => activeTraceIds(),
});
