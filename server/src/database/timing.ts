import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { Counter, Histogram, type Registry } from 'prom-client';
import { env } from '../config.js';
import { logger } from '../log.js';

/**
 * Database timing (A8 of the 0.10 review). Steward's database API is synchronous – on SQLite and, through the bridge, on
 * PostgreSQL – so the time a statement takes is time every request waits (ADR 0001). Every statement and transaction
 * of Db is measured (one performance.now() pair):
 *   sm_db_statement_duration_seconds{dialect,operation}  histogram; operation is the statement's first keyword
 *                                                        (select, insert, update, delete, with, ddl, pragma, other) –
 *                                                        never the SQL itself, so the label set stays small
 *   sm_db_transaction_duration_seconds{dialect}          histogram of outermost transactions
 *   sm_db_slow_statements_total{dialect,operation}       statements over SM_DB_SLOW_MS
 * A statement over SM_DB_SLOW_MS (default 200, 0 = off) is logged as "slow database statement" with the start of its
 * SQL (placeholders, no parameter values), at most once a minute per statement. Within a request the statement count
 * and the database time add up (requestDbStats), for the request's log line and trace span.
 */

const BUCKETS = [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const statements = new Histogram({
  name: 'sm_db_statement_duration_seconds',
  help: 'Duration of database statements by statement kind (the time the event loop waited)',
  labelNames: ['dialect', 'operation'] as const,
  buckets: BUCKETS,
  registers: [],
});
const transactions = new Histogram({
  name: 'sm_db_transaction_duration_seconds',
  help: 'Duration of database transactions (outermost), including the work between their statements',
  labelNames: ['dialect'] as const,
  buckets: BUCKETS,
  registers: [],
});
const slowStatements = new Counter({
  name: 'sm_db_slow_statements_total',
  help: 'Database statements that took longer than SM_DB_SLOW_MS',
  labelNames: ['dialect', 'operation'] as const,
  registers: [],
});

export function registerDbMetrics(registry: Registry): void {
  for (const [name, m] of [
    ['sm_db_statement_duration_seconds', statements],
    ['sm_db_transaction_duration_seconds', transactions],
    ['sm_db_slow_statements_total', slowStatements],
  ] as const)
    if (!registry.getSingleMetric(name)) registry.registerMetric(m);
}

const KINDS = new Set([
  'select',
  'insert',
  'update',
  'delete',
  'with',
  'pragma',
  'begin',
  'commit',
  'rollback',
  'savepoint',
  'release',
  'declare',
  'fetch',
  'close',
]);
const DDL = new Set(['create', 'alter', 'drop', 'vacuum', 'analyze', 'reindex', 'truncate']);
const kindCache = new Map<string, string>();
/** The statement's first keyword, from a small fixed set (comments and leading parentheses skipped). */
export function statementKind(sql: string): string {
  let k = kindCache.get(sql);
  if (k === undefined) {
    const word = /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/|\()*([a-z]+)/i.exec(sql)?.[1]?.toLowerCase() ?? '';
    k = KINDS.has(word) ? (['begin', 'commit', 'rollback', 'savepoint', 'release'].includes(word) ? 'transaction' : word) : DDL.has(word) ? 'ddl' : 'other';
    if (['declare', 'fetch', 'close'].includes(k)) k = 'cursor';
    if (kindCache.size > 5000) kindCache.clear();
    kindCache.set(sql, k);
  }
  return k;
}

/** Statement count and database time of the current request (set by http-observability.ts). */
export const requestDbStats = new AsyncLocalStorage<{ statements: number; ms: number }>();

const SLOW_LOG_EVERY_MS = 60_000;
const lastSlowLog = new Map<string, number>();
/** The SQL as it may appear in a log: whitespace collapsed, the first 120 characters. */
const sqlForLog = (sql: string) => sql.replace(/\s+/g, ' ').trim().slice(0, 120);

function slow(dialect: string, operation: string, sql: string, ms: number, what: 'statement' | 'transaction', extra: Record<string, unknown> = {}): void {
  if (what === 'statement') slowStatements.inc({ dialect, operation });
  const key = `${what}:${sql}`;
  const now = Date.now();
  if (now - (lastSlowLog.get(key) ?? 0) < SLOW_LOG_EVERY_MS) return;
  if (lastSlowLog.size > 1000) lastSlowLog.clear();
  lastSlowLog.set(key, now);
  logger.warn(
    { dialect, operation, ms: Math.round(ms), sql: sqlForLog(sql), slowMs: env.SM_DB_SLOW_MS, ...extra },
    what === 'statement' ? 'slow database statement' : 'slow database transaction',
  );
}

/** Runs one statement and measures it. */
export function timedStatement<T>(dialect: 'sqlite' | 'postgres', sql: string, fn: () => T): T {
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    const ms = performance.now() - t0;
    const operation = statementKind(sql);
    statements.observe({ dialect, operation }, ms / 1000);
    const st = requestDbStats.getStore();
    if (st) {
      st.statements++;
      st.ms += ms;
    }
    const limit = env.SM_DB_SLOW_MS;
    if (limit > 0 && ms > limit) slow(dialect, operation, sql, ms, 'statement');
  }
}

/** Measures an outermost transaction (its first statement names it in the slow log). */
export function timedTransaction<T>(dialect: 'sqlite' | 'postgres', fn: () => T): T {
  const t0 = performance.now();
  const st = requestDbStats.getStore();
  const before = st?.statements;
  try {
    return fn();
  } finally {
    const ms = performance.now() - t0;
    transactions.observe({ dialect }, ms / 1000);
    const limit = env.SM_DB_SLOW_MS;
    // a transaction is synchronous: the event loop waits for all of it (and on SQLite it holds the write lock)
    if (limit > 0 && ms > limit)
      slow(dialect, 'transaction', 'transaction', ms, 'transaction', st && before !== undefined ? { statements: st.statements - before } : {});
  }
}
