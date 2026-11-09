import { pino } from 'pino';
import { config, env } from './config.js';
import { activeTraceIds } from './telemetry.js';
import { BRAND } from '@sm/shared';

/**
 * Operational log (JSON lines on stdout, ready for any log shipper). Separate
 * from the tamper-evident audit log, which records who did what.
 * Level: SM_LOG_LEVEL (fatal|error|warn|info|debug|trace, default info); SM_LOG_LEVEL_FORMAT=label writes it as a word.
 */
/**
 * Command-line tools (server/src/cli/*, and `steward admin|migrate|mcp|backup …` of the desktop executable) print their
 * results on stdout, some as JSON for scripts: their log lines go to stderr, so a warning never breaks that output.
 */
const CLI_COMMANDS = new Set(['admin', 'migrate', 'mcp', 'backup', 'library', 'contract', 'validate']);
const runsAsCli =
  /[\\/]cli[\\/][^\\/]+\.[cm]?[jt]s$/.test(process.argv[1] ?? '') || CLI_COMMANDS.has(process.argv.slice(2).find((a) => !a.startsWith('-psn_')) ?? '');

export const logger = pino(
  {
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
  },
  runsAsCli ? pino.destination(2) : undefined,
);
