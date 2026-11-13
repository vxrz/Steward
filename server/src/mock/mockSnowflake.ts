import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { showWarehouses, usageAnswer } from './mockSnowflakeUsage.js';
import { dataElementAnswer } from './mockDataElements.js';

/**
 * A demo Snowflake account (#115) under /mock/snowflake: the SQL API (POST /api/v2/statements) answering the
 * statements Steward sends (recognised by their leading "steward:" comment) from a small ACCOUNT_USAGE. Requests must
 * carry a key-pair JWT signed with the private key whose public key was registered (setSnowflakePublicKey – like
 * ALTER USER … SET RSA_PUBLIC_KEY), with iss ACCOUNT.USER.SHA256:<fingerprint> and sub ACCOUNT.USER.
 *
 * Statements of processes (the example templates) are answered without a tag: SHOW GRANTS ON DATABASE, SHOW GRANTS OF
 * ROLE (from the same grants as GRANTS_TO_ROLES / GRANTS_TO_USERS), and SELECTs from ACCOUNT_USAGE.USERS,
 * GRANTS_TO_USERS, WAREHOUSE_METERING_HISTORY and TASK_HISTORY – the columns by the aliases of the SELECT list. The
 * cost estimate and the waste check (0.21.0) are answered from mockSnowflakeUsage.ts, with SHOW WAREHOUSES.
 * GRANTS_TO_USERS, WAREHOUSE_METERING_HISTORY and TASK_HISTORY – the columns by the aliases of the SELECT list.
 *
 * Data products discovery (ADR 0036 part 5, tags steward:dp-…) reads a catalogue of its own (CATALOGUE below): the
 * databases SHOP, SHOP_DEV and CRM with tables, views, a secure view, dynamic tables, streams, tasks, stages and pipes,
 * each with a TABLE_ID – from <db>.INFORMATION_SCHEMA (SCHEMATA, TABLES, VIEWS), from ACCOUNT_USAGE (DATABASES,
 * SCHEMATA, TABLES, VIEWS) and from SHOW … IN DATABASE / IN SCHEMA. Large results come in partitions (GET
 * /api/v2/statements/{handle}?partition=n), as the SQL API sends them. Tests add many objects (addSnowflakeBulk),
 * rename or drop one, and read every statement sent (snowflakeStatements) for the metadata-only allow-list.
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
  // a leading /* … */ tag, then SELECT <list> FROM – found with indexOf on normalised whitespace, not a backtracking pattern
  let s = sql.trim();
  if (s.startsWith('/*')) {
    const end = s.indexOf('*/');
    s = end < 0 ? '' : s.slice(end + 2).trim();
  }
  const flat = s.replace(/\s+/g, ' ');
  const upper = flat.toUpperCase();
  const from = upper.indexOf(' FROM ');
  const list = upper.startsWith('SELECT ') && from > 7 ? flat.slice(7, from) : '';
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

/**
 * `NAME RLIKE ?` of the mock, anchored like Snowflake's RLIKE – without building a regular expression from the input:
 * literals, `.`, `.*` and groups of literal alternatives such as `(SVC|TECH|SYS)` (what the templates send), optionally
 * with `^` and `$`. Any other pattern matches nothing.
 */
function rlike(pattern: string): (s: string) => boolean {
  type Tok = { lit: string } | { any: true; star: boolean } | { alts: string[] };
  const word = (ch: string | undefined) => !!ch && /^[A-Za-z0-9_$]$/.test(ch);
  let p = pattern.startsWith('^') ? pattern.slice(1) : pattern;
  if (p.endsWith('$') && !p.endsWith('\\$')) p = p.slice(0, -1);
  if (!p || p.length > 200) return () => false;
  const toks: Tok[] = [];
  for (let i = 0; i < p.length;) {
    const ch = p[i]!;
    if (ch === '.') {
      const star = p[i + 1] === '*';
      toks.push({ any: true, star });
      i += star ? 2 : 1;
    } else if (ch === '(') {
      const end = p.indexOf(')', i);
      if (end < 0) return () => false;
      const alts = p.slice(i + 1, end).split('|');
      if (alts.some((a) => ![...a].every(word))) return () => false;
      toks.push({ alts });
      i = end + 1;
    } else if (word(ch)) {
      let j = i;
      while (word(p[j])) j++;
      toks.push({ lit: p.slice(i, j) });
      i = j;
    } else return () => false;
  }
  return (s) => {
    const memo = new Map<number, boolean>();
    const at = (t: number, pos: number): boolean => {
      const k = t * (s.length + 1) + pos;
      const known = memo.get(k);
      if (known !== undefined) return known;
      const tok = toks[t];
      let r: boolean;
      if (!tok) r = pos === s.length;
      else if ('lit' in tok) r = s.startsWith(tok.lit, pos) && at(t + 1, pos + tok.lit.length);
      else if ('alts' in tok) r = tok.alts.some((a) => s.startsWith(a, pos) && at(t + 1, pos + a.length));
      else if (tok.star) {
        r = false;
        for (let q = pos; q <= s.length && !r; q++) r = at(t + 1, q);
      } else r = pos < s.length && at(t + 1, pos + 1);
      memo.set(k, r);
      return r;
    };
    return at(0, 0);
  };
}

/** Untagged statements: SHOW GRANTS ON DATABASE / OF ROLE, SELECTs from the ACCOUNT_USAGE views processes read. */
function untagged(sql: string, arg: (i: number) => string): { names: string[]; rows: Cell[][] } | { error: string } {
  if (/^SHOW WAREHOUSES ?;?$/i.test(sql.trim().replace(/\s+/g, ' '))) return showWarehouses();
  const ident = (raw: string) => (raw.startsWith('"') ? raw.slice(1, -1).replaceAll('""', '"') : raw.toUpperCase());
  // whitespace normalised first; the quoted name's alternatives start differently, so the pattern does not backtrack
  const show = /^SHOW GRANTS (ON DATABASE|OF ROLE) ("(?:[^"]|"")+"|[A-Za-z0-9_$]+) ?;?$/i.exec(sql.trim().replace(/\s+/g, ' '));
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
  const usage = usageAnswer(sql, view, names, arg);
  if (usage) return usage;
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

// ---------- data products discovery (ADR 0036 part 5) ----------

/** One object of the discovery catalogue (database, schema and name upper case, as unquoted identifiers are stored). */
export interface SnowflakeCatalogueObject {
  database: string;
  schema: string;
  name: string;
  /** TABLES.TABLE_TYPE, or what SHOW lists */
  type: 'BASE TABLE' | 'VIEW' | 'MATERIALIZED VIEW' | 'EXTERNAL TABLE' | 'DYNAMIC TABLE' | 'STREAM' | 'TASK' | 'STAGE' | 'PIPE';
  id: number;
  rows?: number | null;
  bytes?: number | null;
  /** hours since the last change */
  alteredHours?: number;
  secure?: boolean;
  transient?: boolean;
  /** stream: its table; task: its schedule; stage: EXTERNAL or INTERNAL */
  detail?: string;
}

const SEEDED_DATABASES = ['SHOP', 'SHOP_DEV', 'CRM', 'PRD_SDC_OPQ_PBI_DEV'];

function seedCatalogue(): SnowflakeCatalogueObject[] {
  let id = 1000;
  const o = (database: string, schema: string, name: string, type: SnowflakeCatalogueObject['type'], more: Partial<SnowflakeCatalogueObject> = {}) => ({
    database,
    schema,
    name,
    type,
    id: ++id,
    rows: type === 'BASE TABLE' || type === 'DYNAMIC TABLE' ? 1000 + id : null,
    bytes: type === 'BASE TABLE' || type === 'DYNAMIC TABLE' ? 64_000 + id * 10 : null,
    alteredHours: 2,
    ...more,
  });
  const out: SnowflakeCatalogueObject[] = TABLES.map((t) =>
    o(t.catalog, t.schema, t.name, t.type as SnowflakeCatalogueObject['type'], { rows: t.rows, bytes: t.bytes, alteredHours: t.altered / H }),
  );
  // the pipeline of the demo's Orders product, in dev and prod (the environment rule SHOP_DEV → dev)
  for (const db of ['SHOP', 'SHOP_DEV'])
    out.push(
      o(db, 'RAW', 'ORDERS_RAW', 'BASE TABLE', { transient: true }),
      o(db, 'RAW', 'ORDERS_RAW_CHANGES', 'STREAM', { detail: `${db}.RAW.ORDERS_RAW` }),
      o(db, 'RAW', 'LANDING', 'STAGE', { detail: 'EXTERNAL' }),
      o(db, 'RAW', 'ORDERS_PIPE', 'PIPE'),
      o(db, 'STAGED', 'ORDERS', 'BASE TABLE'),
      o(db, 'STAGED', 'LOAD_ORDERS', 'TASK', { detail: 'USING CRON 0 * * * * UTC' }),
      o(db, 'CURATED', 'ORDERS', 'DYNAMIC TABLE'),
      o(db, 'CURATED', 'CUSTOMERS', 'BASE TABLE'),
      o(db, 'MART', 'DAILY_SALES', 'VIEW', { secure: true }),
      o(db, 'MART', 'ORDERS_BY_REGION', 'MATERIALIZED VIEW'),
    );
  return out;
}

let catalogue = seedCatalogue();
let bulk: SnowflakeCatalogueObject[] = [];
let catalogueDatabases = [...SEEDED_DATABASES];
let nextObjectId = 900_000;
/** SCHEMA_IDs and DATABASE_IDs (key `#DB`), unique in the account (an object keeps its id while it exists) */
const schemaIds = new Map<string, number>();
const schemaId = (qualified: string): number => {
  let id = schemaIds.get(qualified);
  if (id === undefined) schemaIds.set(qualified, (id = 100 + schemaIds.size));
  return id;
};

/** Every object of the discovery catalogue (the seeded ones and the bulk ones). */
const objects = (): SnowflakeCatalogueObject[] => (bulk.length ? [...catalogue, ...bulk] : catalogue);

/** For tests: the seeded catalogue again, without bulk objects. */
export function resetSnowflakeCatalogue(): void {
  catalogue = seedCatalogue();
  bulk = [];
  catalogueDatabases = [...SEEDED_DATABASES];
  statements = [];
}

/** TABLE_IDs of bulk objects: never used twice in a process (a dropped table's id is not given to another) */
let bulkId = 2_000_000;

/** For tests at scale: a database with `schemas` × `tablesPerSchema` tables (TABLE_IDs from 2,000,000). */
export function addSnowflakeBulk(database: string, schemas: number, tablesPerSchema: number): void {
  if (!catalogueDatabases.includes(database)) catalogueDatabases.push(database);
  for (let s = 0; s < schemas; s++)
    for (let t = 0; t < tablesPerSchema; t++)
      bulk.push({ database, schema: `S${s}`, name: `T${t}`, type: 'BASE TABLE', id: ++bulkId, rows: t, bytes: t * 100, alteredHours: 1 });
}

/** For tests: an object renamed in Snowflake (ALTER … RENAME: the same TABLE_ID under a new name). */
export function renameSnowflakeObject(qualified: string, newName: string): void {
  const x = objects().find((o) => `${o.database}.${o.schema}.${o.name}` === qualified);
  if (x) x.name = newName;
}

/** For tests: an object dropped in Snowflake. */
export function dropSnowflakeObject(qualified: string): void {
  catalogue = catalogue.filter((o) => `${o.database}.${o.schema}.${o.name}` !== qualified);
  bulk = bulk.filter((o) => `${o.database}.${o.schema}.${o.name}` !== qualified);
}

/** For tests: a new object (a new TABLE_ID). */
export function addSnowflakeObject(x: Omit<SnowflakeCatalogueObject, 'id'>): void {
  catalogue.push({ ...x, id: ++nextObjectId });
}

/** Statements sent since the last reset, with their bindings (the metadata-only allow-list of discovery). */
let statements: { sql: string; bindings: string[] }[] = [];
export function snowflakeStatements(): { sql: string; bindings: string[] }[] {
  return [...statements];
}
export function resetSnowflakeStatements(): void {
  statements = [];
}

/** Snowflake's ORDER BY on names without a collation: by code points (and quick for a large catalogue). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const TABLE_KINDS = new Set(['BASE TABLE', 'VIEW', 'MATERIALIZED VIEW', 'EXTERNAL TABLE']);

/** The scope of a discovery statement from its bindings: databases (`DB`) and schemas (`DB.SCHEMA`); '' is nothing. */
function scopeOf(bindings: string[]): (o: { database: string; schema: string }) => boolean {
  const dbs = new Set(bindings.filter((b) => b && !b.includes('.')));
  const schemas = new Set(bindings.filter((b) => b.includes('.') && b.split('.').length === 2));
  return (o) => dbs.has(o.database) || schemas.has(`${o.database}.${o.schema}`);
}

/**
 * Answers of the discovery statements (tags dp-…), as rows by column name; an unknown database is the SQL API's
 * "does not exist or not authorized". `arg(1)` of the information schema statements is `<DB>.INFORMATION_SCHEMA.<VIEW>`.
 */
function discoveryAnswer(tag: string, sql: string, args: string[]): { names: string[]; rows: Cell[][] } | { error: string } {
  const inInfoSchema = (): { database: string; rest: string[] } | { error: string } => {
    const [database] = (args[0] ?? '').split('.');
    if (!database || !catalogueDatabases.includes(database))
      return { error: `SQL compilation error:\nDatabase '${database ?? ''}' does not exist or not authorized.` };
    return { database, rest: args.slice(1) };
  };
  const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? 1_000_000);
  const ts = (h: number | undefined) => iso((h ?? 1) * H);
  const n = (v: number | null | undefined) => (v === null || v === undefined ? null : String(v));
  switch (tag) {
    case 'dp-schemata': {
      const s = inInfoSchema();
      if ('error' in s) return s;
      const names = [
        ...new Set(
          objects()
            .filter((o) => o.database === s.database)
            .map((o) => o.schema),
        ),
      ]
        .filter((x) => !s.rest.length || s.rest.includes(x))
        .sort();
      return { names: ['SCHEMA_NAME', 'LAST_ALTERED'], rows: names.slice(0, limit).map((x) => [x, ts(24)]) };
    }
    case 'dp-secure-views': {
      const s = inInfoSchema();
      if ('error' in s) return s;
      return {
        names: ['TABLE_SCHEMA', 'TABLE_NAME'],
        rows: objects()
          .filter((o) => o.database === s.database && o.secure && (!s.rest.length || s.rest.includes(o.schema)))
          .slice(0, limit)
          .map((o) => [o.schema, o.name]),
      };
    }
    case 'dp-tables': {
      const s = inInfoSchema();
      if ('error' in s) return s;
      return {
        names: ['TABLE_SCHEMA', 'TABLE_NAME', 'TABLE_TYPE', 'IS_TRANSIENT', 'ROW_COUNT', 'BYTES', 'LAST_ALTERED'],
        rows: objects()
          .filter((o) => o.database === s.database && (TABLE_KINDS.has(o.type) || o.type === 'DYNAMIC TABLE') && (!s.rest.length || s.rest.includes(o.schema)))
          .sort((a, b) => cmp(a.schema, b.schema) || cmp(a.name, b.name))
          .slice(0, limit)
          .map((o) => [
            o.schema,
            o.name,
            o.type === 'DYNAMIC TABLE' ? 'BASE TABLE' : o.type,
            o.transient ? 'YES' : 'NO',
            n(o.rows),
            n(o.bytes),
            ts(o.alteredHours),
          ]),
      };
    }
    case 'dp-au-databases':
      return {
        names: ['DATABASE_ID', 'DATABASE_NAME'],
        rows: catalogueDatabases.flatMap((d) => (args.includes(d) ? [[String(schemaId(`#${d}`)), d]] : [])),
      };
    case 'dp-au-schemata': {
      const inScope = scopeOf(args);
      const seen = new Map<string, Cell[]>();
      for (const o of objects()) {
        const k = `${o.database}.${o.schema}`;
        if (inScope(o) && !seen.has(k)) seen.set(k, [String(schemaId(k)), o.database, o.schema]);
      }
      return { names: ['SCHEMA_ID', 'CATALOG_NAME', 'SCHEMA_NAME'], rows: [...seen.values()].slice(0, limit) };
    }
    case 'dp-au-secure-views': {
      const inScope = scopeOf(args);
      return {
        names: ['TABLE_CATALOG', 'TABLE_SCHEMA', 'TABLE_NAME'],
        rows: objects()
          .filter((o) => o.secure && inScope(o))
          .slice(0, limit)
          .map((o) => [o.database, o.schema, o.name]),
      };
    }
    case 'dp-au-tables': {
      const inScope = scopeOf(args);
      return {
        names: ['TABLE_ID', 'TABLE_CATALOG', 'TABLE_SCHEMA', 'TABLE_NAME', 'TABLE_TYPE', 'IS_TRANSIENT', 'ROW_COUNT', 'BYTES', 'LAST_ALTERED'],
        rows: objects()
          .filter((o) => (TABLE_KINDS.has(o.type) || o.type === 'DYNAMIC TABLE') && inScope(o))
          .sort((a, b) => cmp(a.database, b.database) || cmp(a.schema, b.schema) || cmp(a.name, b.name))
          .slice(0, limit)
          .map((o) => [
            String(o.id),
            o.database,
            o.schema,
            o.name,
            o.type === 'DYNAMIC TABLE' ? 'BASE TABLE' : o.type,
            o.transient ? 'YES' : 'NO',
            n(o.rows),
            n(o.bytes),
            ts(o.alteredHours),
          ]),
      };
    }
    case 'dp-au-dependencies': {
      // 0.24.0: which object of the catalogue references which (the demo's pipeline, and one source outside it)
      const inScope = scopeOf(args);
      const has = (q: string) => objects().some((o) => `${o.database}.${o.schema}.${o.name}` === q);
      const domain = (q: string) => {
        const t = objects().find((o) => `${o.database}.${o.schema}.${o.name}` === q)?.type ?? 'BASE TABLE';
        return t === 'BASE TABLE' ? 'TABLE' : t;
      };
      const rows: Cell[][] = [];
      const dep = (referenced: string, referencing: string) => {
        const [rd, rs, rn] = referenced.split('.') as [string, string, string];
        const [fd, fs, fn] = referencing.split('.') as [string, string, string];
        if (!has(referencing) || !inScope({ database: fd, schema: fs })) return;
        rows.push([rd, rs, rn, fd, fs, fn, domain(referencing)]);
      };
      for (const db of ['SHOP', 'SHOP_DEV']) {
        dep(`${db}.STAGED.ORDERS`, `${db}.CURATED.ORDERS`);
        dep(`${db}.CURATED.ORDERS`, `${db}.MART.ORDERS_BY_REGION`);
        dep(`${db}.CURATED.CUSTOMERS`, `${db}.MART.ORDERS_BY_REGION`);
        dep(`${db}.MART.ORDERS_BY_REGION`, `${db}.MART.DAILY_SALES`);
      }
      dep('SHOP.SALES.ORDERS', 'SHOP.REPORTING.DAILY_REVENUE');
      dep('FINANCE.PUBLIC.FX_RATES', 'SHOP.REPORTING.DAILY_REVENUE');
      return {
        names: [
          'REFERENCED_DATABASE',
          'REFERENCED_SCHEMA',
          'REFERENCED_OBJECT_NAME',
          'REFERENCING_DATABASE',
          'REFERENCING_SCHEMA',
          'REFERENCING_OBJECT_NAME',
          'REFERENCING_OBJECT_DOMAIN',
        ],
        rows: rows.slice(0, limit),
      };
    }
    case 'dp-show': {
      // SHOW <WHAT> IN DATABASE "DB" | IN SCHEMA "DB"."S" – quoted identifiers, as discovery sends them
      const m = /SHOW (DYNAMIC TABLES|STREAMS|TASKS|STAGES|PIPES) IN (DATABASE|SCHEMA) "([A-Z0-9_$]+)"(?:\."([A-Z0-9_$]+)")?$/.exec(
        sql.replace(/^\/\*[^*]*\*\/\s*/, '').trim(),
      );
      if (!m) return { error: `SQL compilation error: the demo does not know this statement (${sql.slice(0, 80)})` };
      const [, what, , database, schema] = m;
      if (!catalogueDatabases.includes(database!)) return { error: `SQL compilation error:\nDatabase '${database}' does not exist or not authorized.` };
      const types: Record<string, SnowflakeCatalogueObject['type']> = {
        'DYNAMIC TABLES': 'DYNAMIC TABLE',
        STREAMS: 'STREAM',
        TASKS: 'TASK',
        STAGES: 'STAGE',
        PIPES: 'PIPE',
      };
      const type = types[what!]!;
      const of = objects().filter((o) => o.type === type && o.database === database && (!schema || o.schema === schema));
      const created = epoch(30 * DAY);
      switch (type) {
        case 'DYNAMIC TABLE':
          return {
            names: [
              'created_on',
              'name',
              'database_name',
              'schema_name',
              'rows',
              'bytes',
              'owner',
              'target_lag',
              'refresh_mode',
              'warehouse',
              'scheduling_state',
              'text',
            ],
            rows: of.map((o) => [
              created,
              o.name,
              o.database,
              o.schema,
              n(o.rows),
              n(o.bytes),
              'TRANSFORMER',
              '1 hour',
              'INCREMENTAL',
              'TRANSFORM_WH',
              'RUNNING',
              `create or replace dynamic table ${o.name} as select * from secret_source`,
            ]),
          };
        case 'STREAM':
          return {
            names: ['created_on', 'name', 'database_name', 'schema_name', 'owner', 'table_name', 'source_type', 'type', 'stale', 'mode'],
            rows: of.map((o) => [created, o.name, o.database, o.schema, 'LOADER', o.detail ?? null, 'Table', 'DELTA', 'false', 'APPEND_ONLY']),
          };
        case 'TASK':
          return {
            names: ['created_on', 'name', 'id', 'database_name', 'schema_name', 'owner', 'warehouse', 'schedule', 'state', 'definition'],
            rows: of.map((o) => [
              created,
              o.name,
              `01b2c3d4-0000-0000-0000-${String(o.id).padStart(12, '0')}`,
              o.database,
              o.schema,
              'LOADER',
              'TRANSFORM_WH',
              o.detail ?? null,
              'started',
              'insert into staged.orders select * from raw.orders_raw',
            ]),
          };
        case 'STAGE':
          return {
            names: ['created_on', 'name', 'database_name', 'schema_name', 'url', 'has_credentials', 'owner', 'region', 'type', 'cloud'],
            rows: of.map((o) => [
              created,
              o.name,
              o.database,
              o.schema,
              's3://invented-landing.example/orders/',
              'true',
              'LOADER',
              'eu-central-1',
              o.detail ?? 'INTERNAL',
              'AWS',
            ]),
          };
        case 'PIPE':
          return {
            names: ['created_on', 'name', 'database_name', 'schema_name', 'definition', 'owner', 'notification_channel'],
            rows: of.map((o) => [
              created,
              o.name,
              o.database,
              o.schema,
              'copy into raw.orders_raw from @landing',
              'LOADER',
              'arn:aws:sqs:eu-central-1:000000000000:invented',
            ]),
          };
        default:
          return { names: [], rows: [] };
      }
    }
    default:
      return { error: `SQL compilation error: the demo does not know this statement (${sql.slice(0, 60)})` };
  }
}

/** Rows per partition of a large result (the SQL API cuts by size; the demo by rows). */
const PARTITION_ROWS = 2_000;
/** Partitions of large results not fetched yet, by statement handle (the newest few). */
const partitions = new Map<string, Cell[][][]>();

const resultInPartitions = (reply: FastifyReply, names: string[], rows: Cell[][]) => {
  if (rows.length <= PARTITION_ROWS) return result(reply, names, rows);
  const parts: Cell[][][] = [];
  for (let i = 0; i < rows.length; i += PARTITION_ROWS) parts.push(rows.slice(i, i + PARTITION_ROWS));
  const handle = crypto.randomUUID();
  partitions.set(handle, parts);
  while (partitions.size > 20) partitions.delete(partitions.keys().next().value!);
  return reply.send({
    code: '090001',
    statementHandle: handle,
    message: 'Statement executed successfully.',
    resultSetMetaData: { numRows: rows.length, rowType: names.map((name) => ({ name })), partitionInfo: parts.map((p) => ({ rowCount: p.length })) },
    data: parts[0],
  });
};

// ---------- costs (#226) ----------

/** For tests: whether the organisation's usage views can be read (false: a reseller contract, no ORGANIZATION_USAGE). */
let orgUsage = true;
export function setSnowflakeOrgUsage(on: boolean): void {
  orgUsage = on;
}

/** Daily usage of the demo account from `from` (YYYY-MM-DD) to yesterday: warehouses, storage and cloud services. */
function dailyUsage(from: string): { day: string; service: string; credits: number; amount: number }[] {
  const out: { day: string; service: string; credits: number; amount: number }[] = [];
  const start = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(start)) return out;
  for (let t = Math.max(start, today - 400 * DAY); t < today; t += DAY) {
    const day = new Date(t).toISOString().slice(0, 10);
    // a little more every month, weekends quieter
    const growth = 1 + (t - (today - 400 * DAY)) / (400 * DAY) / 4;
    const weekend = [0, 6].includes(new Date(t).getUTCDay()) ? 0.5 : 1;
    const credits = Math.round(14 * growth * weekend * 100) / 100;
    out.push({ day, service: 'WAREHOUSE_METERING', credits, amount: Math.round(credits * 3 * 100) / 100 });
    out.push({ day, service: 'CLOUD_SERVICES', credits: 0.4, amount: 1.2 });
    out.push({ day, service: 'STORAGE', credits: 0, amount: 2.35 });
  }
  return out;
}

export async function mockSnowflake(app: FastifyInstance): Promise<void> {
  // the further partitions of a large result
  app.get('/snowflake/api/v2/statements/:handle', async (req, reply) => {
    const bad = authProblem(req);
    if (bad) return reply.code(401).send({ code: '390144', message: bad });
    const parts = partitions.get((req.params as { handle: string }).handle);
    const i = Number((req.query as { partition?: string }).partition ?? 0);
    if (!parts || !Number.isInteger(i) || !parts[i]) return reply.code(404).send({ code: '000709', message: 'Statement not found' });
    if (i === parts.length - 1) partitions.delete((req.params as { handle: string }).handle);
    return reply.send({ data: parts[i] });
  });
  app.post('/snowflake/api/v2/statements', async (req, reply) => {
    const bad = authProblem(req);
    if (bad) return reply.code(401).send({ code: '390144', message: bad });
    const body = (req.body ?? {}) as { statement?: string; bindings?: Record<string, { value: string }> };
    const sql = String(body.statement ?? '');
    const arg = (i: number) => body.bindings?.[String(i)]?.value ?? '';
    const tag = /^\/\* steward:([a-z-]+) \*\//.exec(sql)?.[1];
    const bindings = Object.keys(body.bindings ?? {})
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => body.bindings![k]!.value);
    if (statements.length < 50_000) statements.push({ sql, bindings });
    if (tag?.startsWith('dp-')) {
      // the data products checks (ADR 0036 part 10, mockDataElements.ts) first, then discovery (part 5): both tag dp-…
      const check = dataElementAnswer(tag, sql, arg, TABLES);
      if (check) return result(reply, check.names, check.rows);
      const r = discoveryAnswer(tag, sql, bindings);
      return 'error' in r ? reply.code(422).send({ code: '002003', message: r.error }) : resultInPartitions(reply, r.names, r.rows);
    }
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
      case 'costs-currency':
        if (!orgUsage)
          return reply.code(422).send({
            code: '002003',
            message: "SQL compilation error:\nObject 'SNOWFLAKE.ORGANIZATION_USAGE.USAGE_IN_CURRENCY_DAILY' does not exist or not authorized.",
          });
        if (arg(2) !== DEMO_SNOWFLAKE.account && arg(3) !== DEMO_SNOWFLAKE.account)
          return result(reply, ['USAGE_DATE', 'SERVICE_TYPE', 'BILLING_TYPE', 'CURRENCY', 'AMOUNT'], []);
        return result(
          reply,
          ['USAGE_DATE', 'SERVICE_TYPE', 'BILLING_TYPE', 'CURRENCY', 'AMOUNT'],
          dailyUsage(arg(1)).map((u) => [u.day, u.service, 'consumption', 'USD', u.amount.toFixed(6)]),
        );
      case 'costs-credits':
        return result(
          reply,
          ['USAGE_DATE', 'SERVICE_TYPE', 'CREDITS'],
          dailyUsage(arg(1))
            .filter((u) => u.credits > 0)
            .map((u) => [u.day, u.service, u.credits.toFixed(9)]),
        );
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
