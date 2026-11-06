import { z } from 'zod';

/**
 * Database platforms (0.7.0, #203, docs/DATABASES.md, ADR 0008): Steward connects to a database directly and runs
 * read-only statements – access reviews, account hygiene, monitor checks and datasets. One platform kind with a driver
 * per DBMS; the connection settings are `config.database` (PUT /api/platforms/:id/database), user name and password
 * are credentials of the platform (vault keys `username`, `password`).
 */

export const DATABASE_KIND = 'database';

/** The DBMS Steward speaks (Oracle comes later and fits the same driver interface). `mysql` covers MariaDB and MySQL. */
export const DB_DIALECTS = ['postgresql', 'mysql', 'sqlserver'] as const;
export type DbDialect = (typeof DB_DIALECTS)[number];

export const DB_DIALECT_INFO: Record<DbDialect, { label: string; port: number; placeholder: (n: number) => string }> = {
  postgresql: { label: 'PostgreSQL', port: 5432, placeholder: (n) => `$${n}` },
  mysql: { label: 'MariaDB / MySQL', port: 3306, placeholder: () => '?' },
  sqlserver: { label: 'Microsoft SQL Server', port: 1433, placeholder: (n) => `@p${n}` },
};

/** verify: TLS with the certificate and host name checked (default); require: TLS without checks; off: no TLS. */
export const DB_TLS_MODES = ['verify', 'require', 'off'] as const;
export type DbTlsMode = (typeof DB_TLS_MODES)[number];

export const DB_LIMITS = {
  /** Statement time limit (seconds) */
  timeoutSeconds: { default: 30, max: 300 },
  /** Rows one statement may return */
  maxRows: { default: 1000, max: 50_000 },
  /** Size of one result (MB, as JSON) */
  maxMb: { default: 5, max: 50 },
  /** Connections per platform, closed after idleSeconds */
  poolSize: { default: 2, max: 5 },
  idleSeconds: 60,
  connectTimeoutMs: 15_000,
  /** Parameters of one statement, and characters of the statement */
  params: 100,
  sqlChars: 20_000,
  /** Characters of one parameter value */
  paramChars: 10_000,
} as const;

/** Built-in catalog queries (server/src/dbms/catalog.ts): the same columns for every DBMS. */
export const DB_CATALOGS = ['status', 'accounts', 'role-members', 'privileges', 'replication', 'tables'] as const;
export type DbCatalog = (typeof DB_CATALOGS)[number];

/** The columns each catalog query returns (in this order), whatever the DBMS. */
export const DB_CATALOG_COLUMNS: Record<DbCatalog, readonly string[]> = {
  status: ['product', 'version', 'database', 'currentUser', 'readOnly', 'serverTime', 'canWrite'],
  accounts: [
    'name',
    'host',
    'canLogin',
    'superuser',
    'admin',
    'locked',
    'expiresAt',
    'passwordChangedAt',
    'passwordExpired',
    'defaultAccount',
    'authentication',
    'roles',
    'disable',
  ],
  'role-members': ['scope', 'role', 'member', 'memberType', 'adminOption', 'grantor', 'revoke'],
  privileges: ['grantee', 'privilege', 'objectType', 'schema', 'object', 'grantable', 'grantor', 'revoke'],
  replication: ['role', 'name', 'state', 'lagSeconds'],
  tables: ['schema', 'name', 'type', 'rows', 'bytes'],
};

const HOST_RE = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)$/;

export const dbLimitsSchema = z
  .object({
    timeoutSeconds: z.number().int().min(1).max(DB_LIMITS.timeoutSeconds.max).optional(),
    maxRows: z.number().int().min(1).max(DB_LIMITS.maxRows.max).optional(),
    maxMb: z.number().int().min(1).max(DB_LIMITS.maxMb.max).optional(),
  })
  .strict();
export type DbLimits = z.infer<typeof dbLimitsSchema>;

/** `config.database` of a database platform. Sealed with the connection settings. */
export const databaseSettingsSchema = z
  .object({
    dialect: z.enum(DB_DIALECTS),
    host: z.string().trim().min(1).max(253).regex(HOST_RE, 'A host name or IP address, without scheme or port'),
    /** Default: the DBMS's port */
    port: z.number().int().min(1).max(65535).optional(),
    /** The database (PostgreSQL, SQL Server) or default schema (MariaDB/MySQL) */
    database: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[^\0\r\n;]+$/, 'A database name without line breaks or ;'),
    tls: z
      .object({
        mode: z.enum(DB_TLS_MODES).default('verify'),
        /** Extra CA certificate(s), PEM */
        ca: z
          .string()
          .max(50_000)
          .refine((v) => !v.trim() || v.includes('-----BEGIN CERTIFICATE-----'), 'A PEM certificate (-----BEGIN CERTIFICATE-----)')
          .optional(),
        /** The name the certificate is checked against, when it differs from the host */
        serverName: z.string().trim().max(253).regex(HOST_RE).optional(),
      })
      .strict()
      .default({ mode: 'verify' }),
    /** Ceilings for every statement on this platform (a step can lower them) */
    limits: dbLimitsSchema.default({}),
    poolSize: z.number().int().min(1).max(DB_LIMITS.poolSize.max).optional(),
    /** How Steward signs in: user name and password (Entra ID / IAM tokens later) */
    auth: z.enum(['password']).default('password'),
  })
  .strict();
export type DatabaseSettings = z.infer<typeof databaseSettingsSchema>;
export type DatabaseSettingsInput = z.input<typeof databaseSettingsSchema>;

/** The effective limits of a statement: the step's values, never above the platform's (or the defaults). */
export function effectiveDbLimits(platform: DbLimits | undefined, step: DbLimits & { onLimit?: 'fail' | 'truncate' } = {}) {
  const cap = (k: keyof DbLimits) => {
    const ceiling = platform?.[k] ?? DB_LIMITS[k].default;
    return Math.max(1, Math.min(step[k] ?? ceiling, ceiling, DB_LIMITS[k].max));
  };
  return { timeoutSeconds: cap('timeoutSeconds'), maxRows: cap('maxRows'), maxMb: cap('maxMb'), truncate: step.onLimit === 'truncate' };
}

export const dbPort = (s: Pick<DatabaseSettings, 'dialect' | 'port'>): number => s.port ?? DB_DIALECT_INFO[s.dialect].port;

/** Result of a statement, also the output of a query step. */
export interface DbQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  /** More rows (or bytes) than allowed and the step said onLimit: truncate */
  truncated: boolean;
  durationMs: number;
}
