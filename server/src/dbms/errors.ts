import type { DbDialect } from '@sm/shared';
import { DbError, type DbErrorCode } from './types.js';

/**
 * Driver errors → DbError with a stable code. The DBMS's own message is kept (cut, one line): it names the object or
 * privilege that is missing, which is what the person needs. Passwords never appear in driver messages; the caller
 * still redacts the platform's secrets before anything is stored.
 */

const NET_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ESOCKET']);
const TLS_RE = /certificate|self[- ]signed|SSL|TLS|altname|hostname\/IP does not match|unable to verify|does not support SSL/i;

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 500);

/** Error codes of PostgreSQL (SQLSTATE), MariaDB/MySQL (errno) and SQL Server (number) that mean the same. */
function codeFor(dialect: DbDialect, e: { code?: unknown; errno?: unknown; number?: unknown; sqlState?: unknown }): DbErrorCode | null {
  const code = String(e.code ?? '');
  if (dialect === 'postgresql') {
    if (code === '28P01' || code === '28000') return 'DB_AUTH_FAILED';
    if (code === '25006') return 'DB_READ_ONLY_VIOLATION';
    if (code === '42501') return 'DB_PERMISSION_DENIED';
    if (code === '57014') return 'DB_TIMEOUT';
    if (code === '3D000') return 'DB_CONNECT_FAILED';
  }
  if (dialect === 'mysql') {
    const errno = Number(e.errno ?? 0);
    if (errno === 1045 || errno === 1044) return 'DB_AUTH_FAILED';
    if (errno === 1792 || errno === 1290) return 'DB_READ_ONLY_VIOLATION';
    if ([1142, 1143, 1227, 1370, 1449].includes(errno)) return 'DB_PERMISSION_DENIED';
    if (errno === 3024 || errno === 1969 || errno === 1317) return 'DB_TIMEOUT';
    if (errno === 1049) return 'DB_CONNECT_FAILED';
    if (code === 'PROTOCOL_SEQUENCE_TIMEOUT') return 'DB_TIMEOUT';
  }
  if (dialect === 'sqlserver') {
    const num = Number(e.number ?? 0);
    if (code === 'ELOGIN' || num === 18456) return 'DB_AUTH_FAILED';
    if (num === 229 || num === 230 || num === 262 || num === 300 || num === 297) return 'DB_PERMISSION_DENIED';
    if (num === 3906 || num === 3908) return 'DB_READ_ONLY_VIOLATION';
    if (code === 'ETIMEOUT' && num === 0) return 'DB_TIMEOUT';
    if (code === 'ECANCEL') return 'DB_CANCELLED';
    if (num === 4060) return 'DB_CONNECT_FAILED';
  }
  if (NET_CODES.has(code)) return 'DB_CONNECT_FAILED';
  return null;
}

/** What each code of a driver error means (the DBMS's own message follows it). */
const TEXT: { code: DbErrorCode; message: string }[] = [
  { code: 'DB_AUTH_FAILED', message: 'The database refused the sign-in – check the user name and password (credentials of the platform)' },
  { code: 'DB_READ_ONLY_VIOLATION', message: 'The statement tried to write – Steward runs read-only statements only' },
  { code: 'DB_PERMISSION_DENIED', message: 'The database account may not read this – grant the read-only role of docs/DATABASES.md' },
  { code: 'DB_TIMEOUT', message: 'The statement ran longer than its time limit' },
  { code: 'DB_CANCELLED', message: 'The statement was cancelled' },
  { code: 'DB_CONNECT_FAILED', message: 'Steward could not connect to the database' },
  { code: 'DB_TLS_FAILED', message: 'The TLS connection to the database failed – check the TLS mode, the CA certificate and the server name' },
  { code: 'DB_QUERY_FAILED', message: 'The database answered with an error' },
];

export function mapDriverError(dialect: DbDialect, e: unknown, phase: 'connect' | 'query'): DbError {
  if (e instanceof DbError) return e;
  const err = (e ?? {}) as { message?: unknown; code?: unknown; errno?: unknown; number?: unknown };
  const raw = oneLine(String(err.message ?? e ?? 'unknown error'));
  let code = codeFor(dialect, err);
  if (!code && phase === 'connect' && TLS_RE.test(raw)) code = 'DB_TLS_FAILED';
  if (!code) code = phase === 'connect' ? 'DB_CONNECT_FAILED' : 'DB_QUERY_FAILED';
  const status = code === 'DB_TIMEOUT' ? 504 : code === 'DB_PERMISSION_DENIED' || code === 'DB_READ_ONLY_VIOLATION' ? 422 : 502;
  const text = TEXT.find((t) => t.code === code)?.message ?? 'The database answered with an error';
  return new DbError(code, `${text}: ${raw}`, { detail: raw }, status);
}
