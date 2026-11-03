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
 *
 * Statements of processes (the example templates) are answered without a tag: SHOW GRANTS ON DATABASE, SHOW GRANTS OF
 * ROLE (from the same grants as GRANTS_TO_ROLES / GRANTS_TO_USERS), and SELECTs from ACCOUNT_USAGE.USERS,
 * GRANTS_TO_USERS, WAREHOUSE_METERING_HISTORY and TASK_HISTORY – the columns by the aliases of the SELECT list.
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

/** For tests: the roles granted to a demo user (a grant revoked in Snowflake). */
export function setSnowflakeUserRoles(user: string, roles: string[]): void {
  for (let i = USER_ROLES.length - 1; i >= 0; i--) if (USER_ROLES[i]![0] === user) USER_ROLES.splice(i, 1);
  for (const r of roles) USER_ROLES.push([user, r]);
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
  { warehouse: 'PBI_WH', credits30: 18.75, credits7: 6.5 },
];
const USED_BY: Record<string, string[]> = { SHOP: ['TRANSFORM_WH', 'BI_WH'], CRM: ['BI_WH'] };
/**
 * Users of the account. The four short names serve the SHOP and CRM databases; the project database
 * PRD_SDC_OPQ_PBI_DEV (#project access review) is used by people with employee ids and two technical users.
 * login: days since the last successful login (null: never).
 */
interface DemoUser {
  name: string;
  login: string;
  type: string;
  disabled: 'true' | 'false';
  displayName?: string;
  email?: string | null;
  lastLogin?: number | null;
  hasPassword?: boolean;
  hasMfa?: boolean;
  rsa?: boolean;
}
const USERS: DemoUser[] = [
  { name: 'ALICE', login: 'alice@example.com', type: 'PERSON', disabled: 'false', email: 'alice@example.com', lastLogin: 3 },
  { name: 'BOB', login: 'bob@example.com', type: 'PERSON', disabled: 'false', email: 'bob@example.com', lastLogin: 1, hasPassword: true, hasMfa: true },
  { name: 'ETL_SVC', login: 'ETL_SVC', type: 'SERVICE', disabled: 'false', lastLogin: 0.1, rsa: true },
  { name: 'OLD_BI', login: 'OLD_BI', type: 'LEGACY_SERVICE', disabled: 'true', lastLogin: 400, hasPassword: true },
  { name: 'Z003ABCD', login: 'Z003ABCD', type: 'PERSON', disabled: 'false', displayName: 'Anna Berger', email: 'anna.berger@example.com', lastLogin: 2 },
  {
    name: 'Z004EFGH',
    login: 'Z004EFGH',
    type: 'PERSON',
    disabled: 'false',
    displayName: 'Hans Ilg',
    email: 'hans.ilg@example.com',
    lastLogin: 200,
    hasPassword: true,
  },
  { name: 'Z005IJKL', login: 'Z005IJKL', type: 'PERSON', disabled: 'true', displayName: 'Karla Lang', email: 'karla.lang@example.com', lastLogin: 380 },
  { name: 'Z006MNOP', login: 'Z006MNOP', type: 'PERSON', disabled: 'false', displayName: 'Mia Neumann', email: 'mia.neumann@example.com', lastLogin: 91 },
  {
    name: 'Z007QRST',
    login: 'Z007QRST',
    type: 'PERSON',
    disabled: 'false',
    displayName: 'Jonas Kraus',
    email: 'jonas.kraus@example.com',
    lastLogin: 1,
    hasPassword: true,
    hasMfa: true,
  },
  {
    name: 'BREAKGLASS_ADMIN',
    login: 'BREAKGLASS_ADMIN',
    type: 'PERSON',
    disabled: 'false',
    displayName: 'Emergency access',
    lastLogin: null,
    hasPassword: true,
    hasMfa: true,
  },
  { name: 'SVC_PBI_GATEWAY', login: 'SVC_PBI_GATEWAY', type: 'SERVICE', disabled: 'false', lastLogin: 0.1, rsa: true },
  { name: 'SVC_PBI_ETL', login: 'SVC_PBI_ETL', type: 'LEGACY_SERVICE', disabled: 'false', lastLogin: 1, hasPassword: true },
];
/** [user, role]: roles granted to users (GRANTS_TO_USERS, SHOW GRANTS OF ROLE … granted_to USER) */
const USER_ROLES = [
  ['ALICE', 'ANALYST'],
  ['BOB', 'SYSADMIN'],
  ['ETL_SVC', 'LOADER'],
  ['OLD_BI', 'REPORTER'],
  ['Z003ABCD', 'PRD_SDC_OPQ_PBI_DEV_READONLY'],
  ['Z003ABCD', 'PBI_REPORTING'],
  ['Z004EFGH', 'PRD_SDC_OPQ_PBI_DEV_READONLY'],
  ['Z005IJKL', 'PRD_SDC_OPQ_PBI_DEV_READWRITE'],
  ['Z006MNOP', 'PBI_REPORTING'],
  ['Z007QRST', 'PRD_SDC_OPQ_PBI_DEV_READWRITE'],
  ['Z007QRST', 'ACCOUNTADMIN'],
  ['Z007QRST', 'SECURITYADMIN'],
  ['BREAKGLASS_ADMIN', 'ACCOUNTADMIN'],
  ['SVC_PBI_GATEWAY', 'PRD_SDC_OPQ_PBI_DEV_READONLY'],
  ['SVC_PBI_ETL', 'PRD_SDC_OPQ_PBI_DEV_READWRITE'],
];
/** NAME (a role) granted to GRANTEE_NAME (a role) */
const ROLE_HIERARCHY = [
  ['REPORTER', 'ANALYST'],
  ['ANALYST', 'SYSADMIN'],
  ['PRD_SDC_OPQ_PBI_DEV_READONLY', 'PRD_SDC_OPQ_PBI_DEV_READWRITE'],
  ['PRD_SDC_OPQ_PBI_DEV_READONLY', 'PBI_REPORTING'],
  ['PRD_SDC_OPQ_PBI_DEV_READWRITE', 'PRD_SDC_OPQ_PBI_DEV_OWNER'],
  ['PRD_SDC_OPQ_PBI_DEV_OWNER', 'SYSADMIN'],
  ['SYSADMIN', 'ACCOUNTADMIN'],
  ['SECURITYADMIN', 'ACCOUNTADMIN'],
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
  { privilege: 'OWNERSHIP', on: 'DATABASE', name: 'PRD_SDC_OPQ_PBI_DEV', catalog: null, schema: null, grantee: 'PRD_SDC_OPQ_PBI_DEV_OWNER' },
  { privilege: 'USAGE', on: 'DATABASE', name: 'PRD_SDC_OPQ_PBI_DEV', catalog: null, schema: null, grantee: 'PRD_SDC_OPQ_PBI_DEV_READONLY' },
  { privilege: 'MONITOR', on: 'DATABASE', name: 'PRD_SDC_OPQ_PBI_DEV', catalog: null, schema: null, grantee: 'PRD_SDC_OPQ_PBI_DEV_READONLY' },
  { privilege: 'USAGE', on: 'DATABASE', name: 'PRD_SDC_OPQ_PBI_DEV', catalog: null, schema: null, grantee: 'PRD_SDC_OPQ_PBI_DEV_READWRITE' },
  { privilege: 'CREATE SCHEMA', on: 'DATABASE', name: 'PRD_SDC_OPQ_PBI_DEV', catalog: null, schema: null, grantee: 'PRD_SDC_OPQ_PBI_DEV_READWRITE' },
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

const DAY = 24 * H;
const bool = (b: boolean | undefined) => (b ? 'true' : 'false');
/** Like the SQL API sends TIMESTAMP_LTZ values: seconds since the epoch with nanoseconds. */
const epoch = (msAgo: number) => `${((Date.now() - msAgo) / 1000).toFixed(3)}000000`;

/** The output columns of a SELECT list – the alias after AS, or the column itself (top-level commas only). */
function selectAliases(sql: string): string[] {
  const list = /^\s*(?:\/\*.*?\*\/\s*)?SELECT\s+([\s\S]+?)\s+FROM\s/i.exec(sql)?.[1] ?? '';
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let quoted = false;
  for (const ch of list) {
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === '(') depth++;
    if (!quoted && ch === ')') depth--;
    if (!quoted && depth === 0 && ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((c) => {
    const t = c.trim();
    const as = /\sAS\s+"?([A-Za-z0-9_]+)"?$/i.exec(t);
    return (as ? as[1]! : (t.split('.').pop() ?? t)).toUpperCase();
  });
}

/** The pattern of `NAME RLIKE ?` – anchored like Snowflake's RLIKE; an invalid pattern matches nothing. */
function rlike(pattern: string): (s: string) => boolean {
  if (!pattern) return () => false;
  try {
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- the mock only, a test or demo input
    const re = new RegExp(`^(?:${pattern})$`, 's');
    return (s) => re.test(s);
  } catch {
    return () => false;
  }
}

/** Untagged statements: SHOW GRANTS ON DATABASE / OF ROLE, SELECTs from the ACCOUNT_USAGE views processes read. */
function untagged(sql: string, arg: (i: number) => string): { names: string[]; rows: Cell[][] } | { error: string } {
  const ident = (raw: string) => (raw.startsWith('"') ? raw.slice(1, -1).replaceAll('""', '"') : raw.toUpperCase());
  const show = /^\s*SHOW\s+GRANTS\s+(ON\s+DATABASE|OF\s+ROLE)\s+("(?:[^"]|"")+"|[A-Za-z0-9_$]+)\s*;?\s*$/i.exec(sql);
  if (show) {
    const name = ident(show[2]!);
    if (/^ON/i.test(show[1]!)) {
      const grants = OBJECT_GRANTS.filter((g) => g.on === 'DATABASE' && g.name === name);
      if (!grants.length) return { error: `SQL compilation error:\nDatabase '${name}' does not exist or not authorized.` };
      return {
        names: ['created_on', 'privilege', 'granted_on', 'name', 'granted_to', 'grantee_name', 'grant_option', 'granted_by'],
        rows: grants.map((g, i) => [epoch((300 + i) * DAY), g.privilege, 'DATABASE', name, 'ROLE', g.grantee, 'false', 'SECURITYADMIN']),
      };
    }
    const known = new Set([...USER_ROLES.map((r) => r[1]), ...ROLE_HIERARCHY.flat(), ...OBJECT_GRANTS.map((g) => g.grantee)]);
    if (!known.has(name)) return { error: `SQL compilation error:\nRole '${name}' does not exist or not authorized.` };
    return {
      names: ['created_on', 'role', 'granted_to', 'grantee_name', 'granted_by'],
      rows: [
        ...ROLE_HIERARCHY.filter(([r]) => r === name).map(([, to], i): Cell[] => [epoch((200 + i) * DAY), name, 'ROLE', to!, 'SECURITYADMIN']),
        ...USER_ROLES.filter(([, r]) => r === name).map(([u], i): Cell[] => [epoch((20 + 30 * i) * DAY), name, 'USER', u!, 'USERADMIN']),
      ],
    };
  }
  const view = /FROM\s+SNOWFLAKE\.ACCOUNT_USAGE\.([A-Z_]+)/i.exec(sql)?.[1]?.toUpperCase();
  const names = selectAliases(sql);
  if (view === 'USERS') {
    const technical = rlike(/\bRLIKE\s+\?/i.test(sql) ? arg(1) : '');
    const cell = (u: DemoUser, c: string): Cell => {
      switch (c) {
        case 'NAME':
          return u.name;
        case 'LOGIN_NAME':
          return u.login;
        case 'DISPLAY_NAME':
          return u.displayName ?? u.name;
        case 'EMAIL':
          return u.email ?? null;
        case 'TYPE':
          return u.type;
        case 'DISABLED':
          return u.disabled;
        case 'LAST_SUCCESS_LOGIN':
          return u.lastLogin === null || u.lastLogin === undefined ? null : iso(u.lastLogin * DAY);
        case 'HAS_PASSWORD':
          return bool(u.hasPassword);
        case 'HAS_MFA':
          return bool(u.hasMfa);
        case 'EXT_AUTHN_DUO':
          return 'false';
        case 'HAS_RSA_PUBLIC_KEY':
          return bool(u.rsa);
        case 'NAME_TECHNICAL':
          return bool(technical(u.name));
        default:
          return null;
      }
    };
    return { names, rows: USERS.map((u) => names.map((c) => cell(u, c))) };
  }
  if (view === 'GRANTS_TO_USERS') return { names, rows: USER_ROLES.map(([u, r]) => names.map((c) => (c === 'GRANTEE_NAME' ? u! : c === 'ROLE' ? r! : null))) };
  if (view === 'WAREHOUSE_METERING_HISTORY')
    return {
      names,
      rows: METERING.map((m) =>
        names.map((c) =>
          c === 'WAREHOUSE_NAME' ? m.warehouse : c === 'CREDITS_7D' ? String(m.credits7) : c.startsWith('CREDITS') ? String(m.credits30) : null,
        ),
      ),
    };
  if (view === 'TASK_HISTORY') {
    const hours = Math.abs(Number(arg(1)) || 24);
    return {
      names,
      rows: TASKS.filter((t) => t.state === 'FAILED' && t.at < hours * H).map((t) =>
        names.map((c) => {
          if (c === 'DATABASE_NAME') return t.database;
          if (c === 'SCHEMA_NAME') return t.schema;
          if (c === 'NAME') return t.name;
          if (c === 'FAILURES') return '3';
          if (c === 'LAST_FAILURE' || c === 'SCHEDULED_TIME') return iso(t.at);
          if (c === 'ERROR_MESSAGE') return t.error;
          return null;
        }),
      ),
    };
  }
  return { error: `SQL compilation error: the demo does not know this statement (${sql.slice(0, 60)})` };
}

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
      case 'users': {
        const r = untagged(sql.replace(/^\/\* steward:users \*\/\s*/, ''), arg);
        return 'error' in r ? reply.code(422).send({ code: '002003', message: r.error }) : result(reply, r.names, r.rows);
      }
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
      default: {
        const r = untagged(sql, arg);
        return 'error' in r ? reply.code(422).send({ code: '002003', message: r.error }) : result(reply, r.names, r.rows);
      }
    }
  });
}
