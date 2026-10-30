import { SNOWFLAKE_KIND, SNOWFLAKE_LIMITS, SNOWFLAKE_NAME_RE, SNOWFLAKE_SCOPE_RE, type AccessSubject, type Platform, type SnowflakeReadout } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { vault } from '../vault.js';
import { logger } from '../log.js';
import { HttpError, parseJson } from '../util.js';
import { platformFor } from '../monitors/platforms.js';
import { ISO, SnowflakeClient, sfName, type Row } from './client.js';

/**
 * Snowflake (#115). One platform is one Snowflake account, read through the SQL API with a key-pair JWT, from the
 * SNOWFLAKE.ACCOUNT_USAGE views (complete, with up to two hours of delay; the role needs IMPORTED PRIVILEGES on the
 * SNOWFLAKE database). Every value goes into the statements as a binding, never as text.
 *
 *   database components   tables (size, last change), failing tasks of the last day, credits of the warehouses used
 *   access reviews        roles of users (scope empty), or who reaches the objects of a database, schema or table
 *   monitor check         freshness of a table, failing tasks, credits of a warehouse (monitors/checks.ts)
 */

const AU = 'SNOWFLAKE.ACCOUNT_USAGE';
const num = (v: string | null): number | null => (v === null || v === '' ? null : Number(v));

export function snowflakeClient(p: Platform, secrets: Record<string, string>): SnowflakeClient {
  if (p.kind !== SNOWFLAKE_KIND) throw new HttpError(400, `"${p.name}" is not a Snowflake account`, 'SNOWFLAKE_PLATFORM');
  return new SnowflakeClient(p, secrets);
}

export async function readDatabase(c: SnowflakeClient, database: string): Promise<Omit<SnowflakeReadout, 'readAt' | 'error'>> {
  if (!SNOWFLAKE_NAME_RE.test(database))
    throw new HttpError(400, `"${database}" is not a Snowflake database name`, 'SNOWFLAKE_NAME', { name: database.slice(0, 100) });
  const dbName = sfName(database);
  const [account] = await c.query('/* steward:account */ SELECT CURRENT_ACCOUNT() AS ACCOUNT');
  const tables = await c.query(
    `/* steward:tables */ SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, ROW_COUNT, BYTES, TO_VARCHAR(LAST_ALTERED, ${ISO}) AS LAST_ALTERED
     FROM ${AU}.TABLES WHERE TABLE_CATALOG = ? AND DELETED IS NULL AND TABLE_SCHEMA <> 'INFORMATION_SCHEMA'
     ORDER BY LAST_ALTERED ASC NULLS FIRST LIMIT ${SNOWFLAKE_LIMITS.tables}`,
    [dbName],
  );
  const [sizes] = await c.query(
    `/* steward:size */ SELECT COUNT(*) AS N, COALESCE(SUM(BYTES), 0) AS BYTES FROM ${AU}.TABLES WHERE TABLE_CATALOG = ? AND DELETED IS NULL AND TABLE_SCHEMA <> 'INFORMATION_SCHEMA'`,
    [dbName],
  );
  const tasks = await c.query(
    `/* steward:failed-tasks */ SELECT SCHEMA_NAME, NAME, TO_VARCHAR(SCHEDULED_TIME, ${ISO}) AS SCHEDULED_TIME, ERROR_MESSAGE
     FROM ${AU}.TASK_HISTORY WHERE DATABASE_NAME = ? AND STATE = 'FAILED' AND SCHEDULED_TIME > DATEADD(hour, ?, CURRENT_TIMESTAMP())
     ORDER BY SCHEDULED_TIME DESC LIMIT 50`,
    [dbName, -SNOWFLAKE_LIMITS.taskHours],
  );
  const warehouses = await c.query(
    `/* steward:warehouses */ WITH used AS (
       SELECT DISTINCT WAREHOUSE_NAME FROM ${AU}.QUERY_HISTORY
       WHERE DATABASE_NAME = ? AND WAREHOUSE_NAME IS NOT NULL AND START_TIME > DATEADD(day, ?, CURRENT_TIMESTAMP()))
     SELECT m.WAREHOUSE_NAME, SUM(m.CREDITS_USED) AS CREDITS,
            SUM(IFF(m.START_TIME > DATEADD(day, -7, CURRENT_TIMESTAMP()), m.CREDITS_USED, 0)) AS CREDITS_7D
     FROM ${AU}.WAREHOUSE_METERING_HISTORY m JOIN used u ON u.WAREHOUSE_NAME = m.WAREHOUSE_NAME
     WHERE m.START_TIME > DATEADD(day, ?, CURRENT_TIMESTAMP()) GROUP BY m.WAREHOUSE_NAME ORDER BY CREDITS DESC`,
    [dbName, -SNOWFLAKE_LIMITS.creditDays, -SNOWFLAKE_LIMITS.creditDays],
  );
  return {
    account: account?.ACCOUNT ?? null,
    database: dbName,
    tables: tables.map((t) => ({
      schema: t.TABLE_SCHEMA ?? '',
      name: t.TABLE_NAME ?? '',
      type: t.TABLE_TYPE ?? '',
      rows: num(t.ROW_COUNT),
      bytes: num(t.BYTES),
      lastAltered: t.LAST_ALTERED,
    })),
    tableCount: Number(sizes?.N ?? tables.length),
    bytes: Number(sizes?.BYTES ?? 0),
    failedTasks: tasks.map((t) => ({
      schema: t.SCHEMA_NAME ?? '',
      name: t.NAME ?? '',
      scheduledAt: t.SCHEDULED_TIME ?? '',
      error: (t.ERROR_MESSAGE ?? '').slice(0, 500),
    })),
    warehouses: warehouses.map((w) => ({
      warehouse: w.WAREHOUSE_NAME ?? '',
      credits: Math.round(Number(w.CREDITS ?? 0) * 100) / 100,
      credits7d: Math.round(Number(w.CREDITS_7D ?? 0) * 100) / 100,
    })),
  };
}

/** Reads the database component now, with the rights of `actor` on the platform; a failed read keeps the last one. */
export async function refreshSnowflakeComponent(componentId: string, actor: string, now = Date.now()): Promise<SnowflakeReadout> {
  const c = db().get<{ id: string; application_id: string; name: string; platform_id: string | null; snowflake_state: string | null }>(
    "SELECT id, application_id, name, platform_id, snowflake_state FROM application_components WHERE id = ? AND type = 'snowflake-database'",
    componentId,
  );
  if (!c) throw new HttpError(404, `Component ${componentId} not found`, 'COMPONENT_NOT_FOUND', { id: componentId });
  if (!c.platform_id) throw new HttpError(400, 'Choose the Snowflake platform of the database first', 'COMPONENT_SNOWFLAKE_REQUIRED');
  const at = new Date(now).toISOString();
  const before = parseJson<SnowflakeReadout | null>(c.snowflake_state, null);
  let readout: SnowflakeReadout;
  try {
    const { platform, secrets } = platformFor(actor, c.platform_id);
    readout = { readAt: at, error: null, ...(await readDatabase(snowflakeClient(platform, secrets), c.name)) };
  } catch (e) {
    readout = {
      ...(before ?? { account: null, database: sfName(c.name), tables: [], tableCount: 0, bytes: 0, failedTasks: [], warehouses: [] }),
      readAt: at,
      error: (e as Error).message.slice(0, 500),
    };
  }
  db().run('UPDATE application_components SET snowflake_state = ? WHERE id = ?', JSON.stringify(readout), componentId);
  // failing tasks that were not failing before are worth a line in the application's history
  if (!readout.error && before && !before.error) {
    const was = new Set(before.failedTasks.map((t) => `${t.schema}.${t.name}`));
    const fresh = [...new Set(readout.failedTasks.map((t) => `${t.schema}.${t.name}`))].filter((t) => !was.has(t));
    if (fresh.length)
      audit({
        action: 'application.snowflake_tasks_failed',
        entityType: 'application',
        entityId: c.application_id,
        actor,
        summary: `Snowflake tasks of ${readout.database} failed: ${fresh.slice(0, 10).join(', ')}`,
        details: { componentId, tasks: fresh.slice(0, 50) },
      });
  }
  return readout;
}

export async function runSnowflakeJob(now = Date.now()): Promise<number> {
  if (!vault().unlocked) return 0;
  const rows = db().all<{ id: string; updated_by: string; snowflake_state: string | null }>(
    `SELECT c.id, c.updated_by, c.snowflake_state FROM application_components c
     JOIN applications a ON a.id = c.application_id JOIN platforms p ON p.id = c.platform_id
     WHERE c.type = 'snowflake-database' AND p.kind = ? AND a.archived = 0`,
    SNOWFLAKE_KIND,
  );
  let n = 0;
  for (const r of rows) {
    const last = parseJson<SnowflakeReadout | null>(r.snowflake_state, null);
    const age = last ? now - Date.parse(last.readAt) : -1;
    if (last && age >= 0 && age < SNOWFLAKE_LIMITS.refreshHours * 3_600_000) continue;
    try {
      await refreshSnowflakeComponent(r.id, r.updated_by, now);
      n++;
    } catch (err) {
      logger.warn({ err, component: r.id }, 'reading a Snowflake database failed');
    }
  }
  return n;
}

/** Connection test: who Steward is in which account, and whether the ACCOUNT_USAGE views can be read. */
export async function testSnowflake(platform: Platform, secrets: Record<string, string>): Promise<string> {
  const c = snowflakeClient(platform, secrets);
  const [me] = await c.query(
    '/* steward:whoami */ SELECT CURRENT_ACCOUNT() AS ACCOUNT, CURRENT_USER() AS USER_NAME, CURRENT_ROLE() AS ROLE_NAME, CURRENT_WAREHOUSE() AS WAREHOUSE',
  );
  let views = 'the ACCOUNT_USAGE views can be read';
  try {
    await c.query(`/* steward:probe */ SELECT COUNT(*) AS N FROM ${AU}.USERS WHERE DELETED_ON IS NULL`);
  } catch (e) {
    views = `the ACCOUNT_USAGE views cannot be read (grant IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE to the role): ${(e as Error).message.slice(0, 200)}`;
  }
  return `Snowflake account ${me?.ACCOUNT ?? '?'} as ${me?.USER_NAME ?? '?'} (role ${me?.ROLE_NAME ?? '?'}, warehouse ${me?.WAREHOUSE ?? 'none'}) – ${views}`;
}

// ---------- access reviews ----------

const TECHNICAL = new Set(['SERVICE', 'LEGACY_SERVICE']);

/**
 * Who has what, for an access review (source "snowflake"):
 *   scope ""                      every user with the roles granted to them directly (rights "role:NAME")
 *   scope DB, DB.SCHEMA, DB.S.T   every user who reaches objects in the scope, through their roles and the roles
 *                                 granted to those (rights "PRIVILEGE OBJECT_TYPE NAME", e.g. "SELECT TABLE SHOP.SALES.ORDERS")
 * Technical users (TYPE SERVICE or LEGACY_SERVICE) get the type "technical", disabled users "disabled".
 */
export async function snowflakeAccess(p: Platform, secrets: Record<string, string>, scope: string): Promise<AccessSubject[]> {
  const s = scope.trim();
  if (s && !SNOWFLAKE_SCOPE_RE.test(s))
    throw new HttpError(400, 'The scope is empty (roles of users), DATABASE, DATABASE.SCHEMA or DATABASE.SCHEMA.TABLE', 'SNOWFLAKE_SCOPE');
  const c = snowflakeClient(p, secrets);
  const users = await c.query(`/* steward:users */ SELECT NAME, LOGIN_NAME, TYPE, DISABLED FROM ${AU}.USERS WHERE DELETED_ON IS NULL`);
  const userRoles = await c.query(`/* steward:user-roles */ SELECT GRANTEE_NAME, ROLE FROM ${AU}.GRANTS_TO_USERS WHERE DELETED_ON IS NULL`);
  const typeOf = (u: Row) => (u.DISABLED === 'true' ? 'disabled' : TECHNICAL.has(String(u.TYPE ?? '').toUpperCase()) ? 'technical' : 'user');
  const rolesOf = new Map<string, Set<string>>();
  for (const g of userRoles) {
    if (!g.GRANTEE_NAME || !g.ROLE) continue;
    if (!rolesOf.has(g.GRANTEE_NAME)) rolesOf.set(g.GRANTEE_NAME, new Set());
    rolesOf.get(g.GRANTEE_NAME)!.add(g.ROLE);
  }
  if (!s) {
    return users.map((u) => ({
      id: u.NAME ?? '',
      name: u.LOGIN_NAME || u.NAME || '',
      type: typeOf(u),
      rights: [...(rolesOf.get(u.NAME ?? '') ?? [])].map((r) => `role:${r}`).sort(),
    }));
  }
  const [dbName, schema, table] = s.split('.').map(sfName) as [string, string?, string?];
  // the role hierarchy: a role has what the roles granted to it have
  const roleGrants = await c.query(
    `/* steward:role-hierarchy */ SELECT NAME, GRANTEE_NAME FROM ${AU}.GRANTS_TO_ROLES WHERE GRANTED_ON = 'ROLE' AND PRIVILEGE = 'USAGE' AND DELETED_ON IS NULL`,
  );
  const childrenOf = new Map<string, Set<string>>();
  for (const g of roleGrants) {
    if (!g.NAME || !g.GRANTEE_NAME) continue;
    if (!childrenOf.has(g.GRANTEE_NAME)) childrenOf.set(g.GRANTEE_NAME, new Set());
    childrenOf.get(g.GRANTEE_NAME)!.add(g.NAME);
  }
  const objectGrants = await c.query(
    `/* steward:object-grants */ SELECT PRIVILEGE, GRANTED_ON, NAME, TABLE_CATALOG, TABLE_SCHEMA, GRANTEE_NAME FROM ${AU}.GRANTS_TO_ROLES
     WHERE DELETED_ON IS NULL AND GRANTED_TO = 'ROLE' AND GRANTED_ON <> 'ROLE' AND ((GRANTED_ON = 'DATABASE' AND NAME = ?) OR TABLE_CATALOG = ?)`,
    [dbName, dbName],
  );
  const inScope = (g: Row): string | null => {
    const on = g.GRANTED_ON ?? '';
    if (on === 'DATABASE') return `${on} ${g.NAME}`;
    if (on === 'SCHEMA') return !schema || g.NAME === schema ? `${on} ${dbName}.${g.NAME}` : null;
    if (schema && g.TABLE_SCHEMA !== schema) return null;
    if (table && g.NAME !== table) return null;
    return `${on} ${dbName}.${g.TABLE_SCHEMA}.${g.NAME}`;
  };
  const rightsOfRole = new Map<string, Set<string>>();
  for (const g of objectGrants) {
    const what = inScope(g);
    if (!what || !g.GRANTEE_NAME) continue;
    if (!rightsOfRole.has(g.GRANTEE_NAME)) rightsOfRole.set(g.GRANTEE_NAME, new Set());
    rightsOfRole.get(g.GRANTEE_NAME)!.add(`${g.PRIVILEGE} ${what}`);
  }
  // every role a user has, through the hierarchy (visited set: grants can form cycles only by mistake, but never loop)
  const reach = (start: Iterable<string>): Set<string> => {
    const seen = new Set<string>();
    const todo = [...start];
    while (todo.length) {
      const r = todo.pop()!;
      if (seen.has(r)) continue;
      seen.add(r);
      for (const child of childrenOf.get(r) ?? []) todo.push(child);
    }
    return seen;
  };
  const out: AccessSubject[] = [];
  for (const u of users) {
    const rights = new Set<string>();
    for (const r of reach(rolesOf.get(u.NAME ?? '') ?? [])) for (const x of rightsOfRole.get(r) ?? []) rights.add(x);
    if (rights.size) out.push({ id: u.NAME ?? '', name: u.LOGIN_NAME || u.NAME || '', type: typeOf(u), rights: [...rights].sort() });
  }
  return out;
}

// ---------- monitor check ----------

export interface SnowflakeCheckInput {
  mode: 'freshness' | 'tasks' | 'credits';
  object: string;
  maxAgeMinutes?: number;
  withinHours?: number;
  maxCredits?: number;
  failAs: 'down' | 'degraded';
}

const objectError = (what: string) => new Error(`"${what}" – expected ${what}`);

/** The monitor check type snowflake (monitors/checks.ts): up, or failAs with the reason. */
export async function snowflakeCheck(
  p: Platform,
  secrets: Record<string, string>,
  c: SnowflakeCheckInput,
): Promise<{ status: 'up' | 'down' | 'degraded' | 'unknown'; message: string; value?: unknown }> {
  const sf = snowflakeClient(p, secrets);
  const parts = c.object.trim().split('.');
  if (!SNOWFLAKE_SCOPE_RE.test(c.object.trim())) throw objectError(c.mode === 'credits' ? 'a warehouse name' : 'DATABASE.SCHEMA.TABLE');
  if (c.mode === 'freshness') {
    if (parts.length !== 3) throw objectError('DATABASE.SCHEMA.TABLE');
    const [d, s, t] = parts.map(sfName) as [string, string, string];
    const maxAge = c.maxAgeMinutes ?? 1440;
    const [row] = await sf.query(
      `/* steward:freshness */ SELECT TO_VARCHAR(LAST_ALTERED, ${ISO}) AS LAST_ALTERED, ROW_COUNT FROM IDENTIFIER(?) WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [`${d}.INFORMATION_SCHEMA.TABLES`, s, t],
    );
    if (!row?.LAST_ALTERED) return { status: 'unknown', message: `Snowflake: no table ${d}.${s}.${t} (or no access to it)` };
    const minutes = Math.floor((Date.now() - Date.parse(row.LAST_ALTERED)) / 60_000);
    const value = { lastAltered: row.LAST_ALTERED, minutes, rows: num(row.ROW_COUNT) };
    return minutes > maxAge
      ? { status: c.failAs, message: `Snowflake: ${d}.${s}.${t} last changed ${minutes} minutes ago (at most ${maxAge})`, value }
      : { status: 'up', message: `Snowflake: ${d}.${s}.${t} changed ${minutes} minutes ago`, value };
  }
  const hours = c.withinHours ?? 24;
  if (c.mode === 'tasks') {
    if (parts.length > 2) throw objectError('DATABASE or DATABASE.SCHEMA');
    const [d, s] = parts.map(sfName) as [string, string?];
    const failed = await sf.query(
      `/* steward:task-failures */ SELECT DATABASE_NAME, SCHEMA_NAME, NAME, TO_VARCHAR(SCHEDULED_TIME, ${ISO}) AS SCHEDULED_TIME, ERROR_MESSAGE
       FROM ${AU}.TASK_HISTORY WHERE DATABASE_NAME = ? AND SCHEMA_NAME = COALESCE(NULLIF(?, ''), SCHEMA_NAME) AND STATE = 'FAILED'
       AND SCHEDULED_TIME > DATEADD(hour, ?, CURRENT_TIMESTAMP()) ORDER BY SCHEDULED_TIME DESC LIMIT 50`,
      [d, s ?? '', -hours],
    );
    const names = [...new Set(failed.map((f) => `${f.SCHEMA_NAME}.${f.NAME}`))];
    const value = { failed: names.length };
    return names.length
      ? {
          status: c.failAs,
          message:
            `Snowflake: ${names.length} task(s) of ${c.object} failed in ${hours} h: ${names.slice(0, 5).join(', ')} – ${(failed[0]?.ERROR_MESSAGE ?? '').slice(0, 200)}`.slice(
              0,
              500,
            ),
          value,
        }
      : { status: 'up', message: `Snowflake: no task of ${c.object} failed in ${hours} h`, value };
  }
  if (parts.length !== 1) throw objectError('a warehouse name');
  const w = sfName(parts[0]!);
  const [row] = await sf.query(
    `/* steward:warehouse-credits */ SELECT COALESCE(SUM(CREDITS_USED), 0) AS CREDITS FROM ${AU}.WAREHOUSE_METERING_HISTORY WHERE WAREHOUSE_NAME = ? AND START_TIME > DATEADD(hour, ?, CURRENT_TIMESTAMP())`,
    [w, -hours],
  );
  const credits = Math.round(Number(row?.CREDITS ?? 0) * 100) / 100;
  const value = { credits };
  if (c.maxCredits === undefined) return { status: 'up', message: `Snowflake: ${w} used ${credits} credits in ${hours} h`, value };
  return credits > c.maxCredits
    ? { status: c.failAs, message: `Snowflake: ${w} used ${credits} credits in ${hours} h (at most ${c.maxCredits})`, value }
    : { status: 'up', message: `Snowflake: ${w} used ${credits} credits in ${hours} h (at most ${c.maxCredits})`, value };
}
