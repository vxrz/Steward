import { DbError, RowCollector, type ConnectTarget, type DbDriver, type DriverConnection, type RunLimits, type ServerInfo, type Statement } from './types.js';
import { CATALOG } from './catalog.js';
import { SCHEMA_PARTS, SCHEMA_SQL } from './schema-catalog.js';
import { demoSchemaRows } from './demo-schema.js';
import type { DbCatalog } from '@sm/shared';

/**
 * The demo database (ADR 0008): a fake PostgreSQL for the host DEMO_DB_HOST, in demo mode only. It answers Steward's
 * catalog queries and the few statements of the examples with canned rows – it never reads Steward's own database, so
 * the demo platform cannot become a path into the instance's data.
 */

export const DEMO_DB_HOST = 'postgres.demo.invalid';
export const DEMO_DB = { database: 'shop', username: 'steward_reader', password: 'demo-reader-password' };

const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

/** Raw rows as the PostgreSQL statements of catalog.ts return them (snake_case aliases). */
const CANNED: Record<DbCatalog, () => Record<string, unknown>[]> = {
  status: () => [
    {
      product: 'PostgreSQL',
      version: '16.4 (demo)',
      db: DEMO_DB.database,
      current_user_name: DEMO_DB.username,
      read_only: 'on',
      server_time: new Date().toISOString(),
      can_write: false,
    },
  ],
  accounts: () => [
    { name: 'postgres', can_login: true, superuser: true, admin: true, locked: false, expires_at: null, password_expired: false, roles: [] },
    {
      name: 'steward_reader',
      can_login: true,
      superuser: false,
      admin: false,
      locked: false,
      expires_at: days(300),
      password_expired: false,
      roles: ['pg_read_all_stats'],
    },
    { name: 'app_shop', can_login: true, superuser: false, admin: false, locked: false, expires_at: null, password_expired: false, roles: ['shop_writer'] },
    { name: 'ana', can_login: true, superuser: false, admin: false, locked: false, expires_at: days(-12), password_expired: true, roles: ['shop_reader'] },
    { name: 'legacy_batch', can_login: true, superuser: false, admin: true, locked: false, expires_at: null, password_expired: false, roles: ['shop_writer'] },
    {
      name: 'report_viewer',
      can_login: true,
      superuser: false,
      admin: false,
      locked: false,
      expires_at: days(45),
      password_expired: false,
      roles: ['shop_reader'],
    },
  ],
  'role-members': () => [
    { scope: 'server', role_name: 'pg_read_all_stats', member: 'steward_reader', member_type: 'user', admin_option: false, grantor: 'postgres' },
    { scope: 'server', role_name: 'shop_reader', member: 'ana', member_type: 'user', admin_option: false, grantor: 'postgres' },
    { scope: 'server', role_name: 'shop_reader', member: 'report_viewer', member_type: 'user', admin_option: false, grantor: 'postgres' },
    { scope: 'server', role_name: 'shop_writer', member: 'app_shop', member_type: 'user', admin_option: false, grantor: 'postgres' },
    { scope: 'server', role_name: 'shop_writer', member: 'legacy_batch', member_type: 'user', admin_option: true, grantor: 'postgres' },
  ],
  privileges: () => [
    { grantee: 'PUBLIC', privilege: 'CONNECT', object_type: 'database', schema_name: null, object_name: 'shop', grantable: false, grantor: 'postgres' },
    { grantee: 'PUBLIC', privilege: 'SELECT', object_type: 'table', schema_name: 'public', object_name: 'customers', grantable: false, grantor: 'postgres' },
    { grantee: 'shop_reader', privilege: 'USAGE', object_type: 'schema', schema_name: 'public', object_name: null, grantable: false, grantor: 'postgres' },
    { grantee: 'shop_reader', privilege: 'SELECT', object_type: 'table', schema_name: 'public', object_name: 'orders', grantable: false, grantor: 'postgres' },
    { grantee: 'shop_writer', privilege: 'INSERT', object_type: 'table', schema_name: 'public', object_name: 'orders', grantable: false, grantor: 'postgres' },
    { grantee: 'shop_writer', privilege: 'UPDATE', object_type: 'table', schema_name: 'public', object_name: 'orders', grantable: false, grantor: 'postgres' },
    { grantee: 'shop_writer', privilege: 'DELETE', object_type: 'table', schema_name: 'public', object_name: 'orders', grantable: true, grantor: 'postgres' },
  ],
  replication: () => [
    { role: 'primary', name: 'replica-1', state: 'streaming', lag_seconds: 0.4 },
    { role: 'primary', name: 'replica-2', state: 'streaming', lag_seconds: 3.2 + Math.random() },
  ],
  tables: () => [
    { schema_name: 'public', name: 'customers', type: 'table', row_estimate: 1840, bytes: 491_520 },
    { schema_name: 'public', name: 'invoices', type: 'table', row_estimate: 9120, bytes: 2_359_296 },
    { schema_name: 'public', name: 'order_lines', type: 'table', row_estimate: 48_310, bytes: 9_437_184 },
    { schema_name: 'public', name: 'orders', type: 'table', row_estimate: 15_402, bytes: 4_194_304 },
    { schema_name: 'public', name: 'open_orders', type: 'view', row_estimate: null, bytes: 0 },
  ],
};

/** Statements of the examples the demo answers (whitespace and case do not matter). */
const STATEMENTS: { sql: string; rows: () => Record<string, unknown>[] }[] = [
  { sql: "SELECT count(*) AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock'", rows: () => [{ waiting: Math.random() < 0.9 ? 0 : 2 }] },
  { sql: 'SELECT count(*) AS connections FROM pg_stat_activity', rows: () => [{ connections: 12 + Math.floor(Math.random() * 6) }] },
  { sql: 'SELECT 1', rows: () => [{ '?column?': 1 }] },
  {
    sql: 'SELECT datname AS database, state, count(*) AS connections FROM pg_stat_activity WHERE backend_type = $1 AND datname IS NOT NULL GROUP BY datname, state ORDER BY datname, state',
    rows: () => [
      { database: 'shop', state: 'active', connections: 2 + Math.floor(Math.random() * 3) },
      { database: 'shop', state: 'idle', connections: 9 },
      { database: 'shop', state: 'idle in transaction', connections: Math.random() < 0.8 ? 0 : 1 },
    ],
  },
];

const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim().toLowerCase();

function answer(stmt: Statement): Record<string, unknown>[] {
  if (stmt.trusted) {
    const name = (Object.keys(CATALOG) as DbCatalog[]).find((k) => CATALOG[k].sql.postgresql === stmt.sql);
    if (name) return CANNED[name]();
    // the schema read (#222)
    const part = SCHEMA_PARTS.find((k) => SCHEMA_SQL.postgresql[k] === stmt.sql);
    if (part) return demoSchemaRows(part);
  }
  const hit = STATEMENTS.find((s) => norm(s.sql) === norm(stmt.sql));
  if (hit) return hit.rows();
  throw new DbError(
    'DB_QUERY_FAILED',
    'The demo database answers only the catalog queries and the statements of the examples (it holds no real data) – connect a database of your own to run this statement',
    undefined,
    422,
  );
}

export const demoDriver: DbDriver = {
  async connect(t: ConnectTarget): Promise<DriverConnection> {
    if (t.user !== DEMO_DB.username || t.password !== DEMO_DB.password)
      throw new DbError(
        'DB_AUTH_FAILED',
        `The demo database refused the sign-in of "${t.user}" – the demo credentials are ${DEMO_DB.username} and its password`,
      );
    const server: ServerInfo = { flavour: 'postgresql', version: '16.4 (demo)' };
    return {
      server,
      usable: true,
      async run(stmt: Statement, limits: RunLimits) {
        const t0 = Date.now();
        const rows = answer(stmt);
        const c = new RowCollector(limits);
        c.setColumns(Object.keys(rows[0] ?? {}));
        for (const r of rows) if (!c.add(r)) break;
        return c.result(Date.now() - t0 + 3);
      },
      async close() {
        /* nothing to close */
      },
    };
  },
};
