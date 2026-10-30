import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * A demo Snowflake account (#115) under /mock/snowflake: the SQL API (POST /api/v2/statements) answering the
 * statements Steward sends (recognised by their leading "steward:" comment) from a small ACCOUNT_USAGE. Requests must
 * carry a key-pair JWT signed with the private key whose public key was registered (setSnowflakePublicKey – like
 * ALTER USER … SET RSA_PUBLIC_KEY), with iss ACCOUNT.USER.SHA256:<fingerprint> and sub ACCOUNT.USER.
 */

export const DEMO_SNOWFLAKE = { account: 'DEMO12345', user: 'STEWARD_READER', role: 'STEWARD_READ', warehouse: 'STEWARD_WH' };

let publicKey: crypto.KeyObject | null = null;
/** The demo user's public key – kept in the data folder, so the demo account still signs in after a restart. */
const keyFile = () => path.join(config.dataDir, 'mock-snowflake-public-key.pem');
export function setSnowflakePublicKey(pem: string | null): void {
  publicKey = pem ? crypto.createPublicKey(pem) : null;
  if (pem) fs.writeFileSync(keyFile(), pem, { mode: 0o600 });
  else fs.rmSync(keyFile(), { force: true });
}
function registeredKey(): crypto.KeyObject | null {
  if (!publicKey && fs.existsSync(keyFile())) publicKey = crypto.createPublicKey(fs.readFileSync(keyFile(), 'utf8'));
  return publicKey;
}

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().replace('Z', '+00:00');
const H = 3_600_000;

/** Tables can be changed by tests (setSnowflakeTable). */
const TABLES = [
  { catalog: 'SHOP', schema: 'SALES', name: 'ORDERS', type: 'BASE TABLE', rows: 1_250_000, bytes: 412_000_000, altered: 0.2 * H },
  { catalog: 'SHOP', schema: 'SALES', name: 'CUSTOMERS', type: 'BASE TABLE', rows: 84_000, bytes: 21_000_000, altered: 5 * H },
  { catalog: 'SHOP', schema: 'STAGING', name: 'RAW_EVENTS', type: 'BASE TABLE', rows: 9_800_000, bytes: 1_900_000_000, altered: 72 * H },
  { catalog: 'SHOP', schema: 'REPORTING', name: 'DAILY_REVENUE', type: 'VIEW', rows: null, bytes: null, altered: 30 * 24 * H },
  { catalog: 'CRM', schema: 'CORE', name: 'CONTACTS', type: 'BASE TABLE', rows: 52_000, bytes: 9_000_000, altered: 1 * H },
];
export function setSnowflakeTableAge(name: string, hours: number): void {
  const t = TABLES.find((x) => `${x.catalog}.${x.schema}.${x.name}` === name);
  if (t) t.altered = hours * H;
}

const TASKS = [
  {
    database: 'SHOP',
    schema: 'STAGING',
    name: 'LOAD_EVENTS',
    state: 'FAILED',
    at: 2 * H,
    error: "SQL compilation error: Object 'SHOP.STAGING.EVENTS_EXT' does not exist",
  },
];
const METERING = [
  { warehouse: 'TRANSFORM_WH', credits30: 120.5, credits7: 31.25 },
  { warehouse: 'BI_WH', credits30: 40, credits7: 9.5 },
  { warehouse: 'UNUSED_WH', credits30: 3, credits7: 0 },
];
const USED_BY: Record<string, string[]> = { SHOP: ['TRANSFORM_WH', 'BI_WH'], CRM: ['BI_WH'] };
const USERS = [
  { name: 'ALICE', login: 'alice@example.com', type: 'PERSON', disabled: 'false' },
  { name: 'BOB', login: 'bob@example.com', type: 'PERSON', disabled: 'false' },
  { name: 'ETL_SVC', login: 'ETL_SVC', type: 'SERVICE', disabled: 'false' },
  { name: 'OLD_BI', login: 'OLD_BI', type: 'LEGACY_SERVICE', disabled: 'true' },
];
const USER_ROLES = [
  ['ALICE', 'ANALYST'],
  ['BOB', 'SYSADMIN'],
  ['ETL_SVC', 'LOADER'],
  ['OLD_BI', 'REPORTER'],
];
/** NAME (a role) granted to GRANTEE_NAME (a role) */
const ROLE_HIERARCHY = [
  ['REPORTER', 'ANALYST'],
  ['ANALYST', 'SYSADMIN'],
];
const OBJECT_GRANTS = [
  { privilege: 'OWNERSHIP', on: 'DATABASE', name: 'SHOP', catalog: null, schema: null, grantee: 'SYSADMIN' },
  { privilege: 'USAGE', on: 'DATABASE', name: 'SHOP', catalog: null, schema: null, grantee: 'REPORTER' },
  { privilege: 'USAGE', on: 'DATABASE', name: 'SHOP', catalog: null, schema: null, grantee: 'LOADER' },
  { privilege: 'USAGE', on: 'SCHEMA', name: 'SALES', catalog: 'SHOP', schema: null, grantee: 'REPORTER' },
  { privilege: 'SELECT', on: 'TABLE', name: 'ORDERS', catalog: 'SHOP', schema: 'SALES', grantee: 'REPORTER' },
  { privilege: 'SELECT', on: 'VIEW', name: 'DAILY_REVENUE', catalog: 'SHOP', schema: 'REPORTING', grantee: 'REPORTER' },
  { privilege: 'USAGE', on: 'SCHEMA', name: 'STAGING', catalog: 'SHOP', schema: null, grantee: 'LOADER' },
  { privilege: 'INSERT', on: 'TABLE', name: 'RAW_EVENTS', catalog: 'SHOP', schema: 'STAGING', grantee: 'LOADER' },
  { privilege: 'SELECT', on: 'TABLE', name: 'CONTACTS', catalog: 'CRM', schema: 'CORE', grantee: 'ANALYST' },
];

function fingerprint(k: crypto.KeyObject): string {
  return `SHA256:${crypto
    .createHash('sha256')
    .update(k.export({ type: 'spki', format: 'der' }))
    .digest('base64')}`;
}

function authProblem(req: FastifyRequest): string | null {
  if (req.headers['x-snowflake-authorization-token-type'] !== 'KEYPAIR_JWT') return 'X-Snowflake-Authorization-Token-Type must be KEYPAIR_JWT';
  const jwt = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
  const [h, p, sig] = jwt.split('.');
  const publicKey = registeredKey();
  if (!h || !p || !sig || !publicKey) return 'JWT token is invalid.';
  if (!crypto.verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, 'base64url'))) return 'JWT token is invalid.';
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as { iss?: string; sub?: string; exp?: number };
  const who = `${DEMO_SNOWFLAKE.account}.${DEMO_SNOWFLAKE.user}`;
  if (claims.sub !== who || claims.iss !== `${who}.${fingerprint(publicKey)}`) return 'JWT token is invalid (iss or sub).';
  if (!claims.exp || claims.exp * 1000 < Date.now()) return 'JWT token has expired.';
  return null;
}

type Cell = string | null;
const result = (reply: FastifyReply, names: string[], rows: Cell[][]) =>
  reply.send({
    code: '090001',
    statementHandle: crypto.randomUUID(),
    message: 'Statement executed successfully.',
    resultSetMetaData: { numRows: rows.length, rowType: names.map((name) => ({ name })), partitionInfo: [{ rowCount: rows.length }] },
    data: rows,
  });

export async function mockSnowflake(app: FastifyInstance): Promise<void> {
  app.post('/snowflake/api/v2/statements', async (req, reply) => {
    const bad = authProblem(req);
    if (bad) return reply.code(401).send({ code: '390144', message: bad });
    const body = (req.body ?? {}) as { statement?: string; bindings?: Record<string, { value: string }> };
    const sql = String(body.statement ?? '');
    const arg = (i: number) => body.bindings?.[String(i)]?.value ?? '';
    const tag = /^\/\* steward:([a-z-]+) \*\//.exec(sql)?.[1];
    switch (tag) {
      case 'whoami':
        return result(
          reply,
          ['ACCOUNT', 'USER_NAME', 'ROLE_NAME', 'WAREHOUSE'],
          [[DEMO_SNOWFLAKE.account, DEMO_SNOWFLAKE.user, DEMO_SNOWFLAKE.role, DEMO_SNOWFLAKE.warehouse]],
        );
      case 'account':
        return result(reply, ['ACCOUNT'], [[DEMO_SNOWFLAKE.account]]);
      case 'probe':
        return result(reply, ['N'], [[String(USERS.length)]]);
      case 'tables':
        return result(
          reply,
          ['TABLE_SCHEMA', 'TABLE_NAME', 'TABLE_TYPE', 'ROW_COUNT', 'BYTES', 'LAST_ALTERED'],
          TABLES.filter((t) => t.catalog === arg(1))
            .sort((a, b) => b.altered - a.altered)
            .map((t) => [t.schema, t.name, t.type, t.rows === null ? null : String(t.rows), t.bytes === null ? null : String(t.bytes), iso(t.altered)]),
        );
      case 'size': {
        const ts = TABLES.filter((t) => t.catalog === arg(1));
        return result(reply, ['N', 'BYTES'], [[String(ts.length), String(ts.reduce((n, t) => n + (t.bytes ?? 0), 0))]]);
      }
      case 'failed-tasks':
        return result(
          reply,
          ['SCHEMA_NAME', 'NAME', 'SCHEDULED_TIME', 'ERROR_MESSAGE'],
          TASKS.filter((t) => t.database === arg(1) && t.state === 'FAILED' && t.at < -Number(arg(2)) * H).map((t) => [t.schema, t.name, iso(t.at), t.error]),
        );
      case 'warehouses':
        return result(
          reply,
          ['WAREHOUSE_NAME', 'CREDITS', 'CREDITS_7D'],
          METERING.filter((m) => (USED_BY[arg(1)] ?? []).includes(m.warehouse)).map((m) => [m.warehouse, String(m.credits30), String(m.credits7)]),
        );
      case 'freshness': {
        const dbName = arg(1).split('.')[0];
        const t = TABLES.find((x) => x.catalog === dbName && x.schema === arg(2) && x.name === arg(3));
        return result(reply, ['LAST_ALTERED', 'ROW_COUNT'], t ? [[iso(t.altered), t.rows === null ? null : String(t.rows)]] : []);
      }
      case 'task-failures':
        return result(
          reply,
          ['DATABASE_NAME', 'SCHEMA_NAME', 'NAME', 'SCHEDULED_TIME', 'ERROR_MESSAGE'],
          TASKS.filter((t) => t.database === arg(1) && (!arg(2) || t.schema === arg(2)) && t.at < -Number(arg(3)) * H).map((t) => [
            t.database,
            t.schema,
            t.name,
            iso(t.at),
            t.error,
          ]),
        );
      case 'warehouse-credits': {
        const m = METERING.find((x) => x.warehouse === arg(1));
        const hours = -Number(arg(2));
        return result(reply, ['CREDITS'], [[m ? String(hours <= 7 * 24 ? m.credits7 : m.credits30) : '0']]);
      }
      case 'users':
        return result(
          reply,
          ['NAME', 'LOGIN_NAME', 'TYPE', 'DISABLED'],
          USERS.map((u) => [u.name, u.login, u.type, u.disabled]),
        );
      case 'user-roles':
        return result(reply, ['GRANTEE_NAME', 'ROLE'], USER_ROLES);
      case 'role-hierarchy':
        return result(reply, ['NAME', 'GRANTEE_NAME'], ROLE_HIERARCHY);
      case 'object-grants':
        return result(
          reply,
          ['PRIVILEGE', 'GRANTED_ON', 'NAME', 'TABLE_CATALOG', 'TABLE_SCHEMA', 'GRANTEE_NAME'],
          OBJECT_GRANTS.filter((g) => (g.on === 'DATABASE' && g.name === arg(1)) || g.catalog === arg(2)).map((g) => [
            g.privilege,
            g.on,
            g.name,
            g.catalog,
            g.schema,
            g.grantee,
          ]),
        );
      default:
        return reply.code(422).send({ code: '002003', message: `SQL compilation error: the demo does not know this statement (${sql.slice(0, 60)})` });
    }
  });
}
