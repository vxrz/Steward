import {
  DATA_DISCOVERY_LIMITS,
  discoveryKeeps,
  environmentByRules,
  openLineageDataset,
  SNOWFLAKE_DISCOVERY_SCOPE_RE,
  type DataElementKind,
  type DiscoveredElement,
} from '@sm/shared';
import { ISO, SnowflakeClient, sfName, type Row } from '../../snowflake/client.js';
import { buildUrl } from '../../platforms/http.js';
import { assertOutboundAllowed } from '../../platforms/outbound.js';
import { outboundContext } from '../../platforms/policyContext.js';
import { DiscoveryError, num, short, type DiscoveryContext } from './common.js';

/**
 * Snowflake discovery (ADR 0036 part 5, decision 12): databases, schemas, tables, views, dynamic tables, streams,
 * tasks, stages and pipes of the databases and schemas in the source's scope – metadata only.
 *
 *   information schema (default)  per database: <DB>.INFORMATION_SCHEMA.SCHEMATA, .VIEWS (secure ones), .TABLES –
 *                                 current, and only what Steward's role has a privilege on (USAGE and REFERENCES
 *                                 show metadata, not data); no TABLE_ID there, so a renamed table is a new element
 *   account usage                 SNOWFLAKE.ACCOUNT_USAGE.DATABASES, SCHEMATA, VIEWS and TABLES for the whole scope in
 *                                 one statement each – up to about 90 minutes behind, needs IMPORTED PRIVILEGES on the
 *                                 SNOWFLAKE database; TABLE_ID makes a renamed table the same element
 *
 * and in both modes SHOW DYNAMIC TABLES, STREAMS, TASKS, STAGES and PIPES IN DATABASE (or IN SCHEMA) for what the views
 * do not hold – of their output only metadata columns are kept (never a definition). Names from the scope go into the
 * information schema statements as a bound IDENTIFIER(?), into SHOW as a quoted identifier (checked against
 * SNOWFLAKE_DISCOVERY_SCOPE_RE, `"` doubled); every other value is a binding. Large results are read partition by
 * partition (SnowflakeClient.queryPartitions) and handed on before the next partition is fetched. The account's origin is
 * checked against the outbound policy first (like Confluent Cloud's), every request then by the platform's request path.
 */

const AU = 'SNOWFLAKE.ACCOUNT_USAGE';

/**
 * The statements discovery may send (the allow-list of the metadata-only test): each starts with its tag and reads a
 * catalogue view or SHOWs metadata. Nothing else – no SELECT on a table of the account, no SAMPLE.
 */
export const SNOWFLAKE_DISCOVERY_STATEMENTS: readonly RegExp[] = [
  /^\/\* steward:dp-(schemata|secure-views|tables) \*\/ SELECT [A-Z_, ()."'\-:+0-9]+ FROM IDENTIFIER\(\?\) WHERE /,
  /^\/\* steward:dp-au-(databases|schemata|secure-views|tables) \*\/ SELECT [A-Z_, ()."'\-:+0-9]+ FROM SNOWFLAKE\.ACCOUNT_USAGE\.(DATABASES|SCHEMATA|VIEWS|TABLES) WHERE /,
  /^\/\* steward:dp-show \*\/ SHOW (DYNAMIC TABLES|STREAMS|TASKS|STAGES|PIPES) IN (DATABASE "[A-Z0-9_$]+"|SCHEMA "[A-Z0-9_$]+"\."[A-Z0-9_$]+")$/,
];

/** A quoted identifier for SHOW (the name is checked before: letters, digits, _ and $; `"` would be doubled). */
const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** The scope: database → its schemas (null: the whole database), names as Snowflake stores unquoted ones. */
export function snowflakeScope(entries: readonly string[]): Map<string, Set<string> | null> {
  const out = new Map<string, Set<string> | null>();
  for (const raw of entries) {
    const e = raw.trim();
    if (!SNOWFLAKE_DISCOVERY_SCOPE_RE.test(e))
      throw new DiscoveryError({
        message: `"${e.slice(0, 100)}" is not a Snowflake database or DATABASE.SCHEMA`,
        code: 'DATA_DISCOVERY_SCOPE',
        params: { context: 'snowflake', value: e.slice(0, 100) },
      });
    const [d, s] = e.split('.').map(sfName) as [string, string?];
    if (!s) out.set(d, null);
    else if (out.get(d) !== null) out.set(d, new Set([...(out.get(d) ?? []), s]));
  }
  return out;
}

interface Emitted {
  kind: DataElementKind;
  qualifiedName: string;
  parent: string | null;
  env: string;
  externalId?: string | null;
  flags?: Record<string, string | number | boolean>;
  readout?: DiscoveredElement['readout'];
}

export async function* readSnowflake(ctx: DiscoveryContext): AsyncGenerator<DiscoveredElement[]> {
  const { source, platform } = ctx;
  const scope = snowflakeScope(source.scope);
  if (!scope.size)
    throw new DiscoveryError({ message: 'Name at least one Snowflake database in the scope', code: 'DATA_DISCOVERY_SCOPE', params: { context: 'snowflakeEmpty' } });
  // the account's origin itself must be allowed by the outbound policy (an allow-list may leave it out); every statement
  // then goes through the platform's request path (the policy for redirects, address pinning, the read-only identity)
  await assertOutboundAllowed(await buildUrl(platform, ctx.secrets, '/'), outboundContext());
  const c = new SnowflakeClient(platform, ctx.secrets, ctx.signal);
  const account = String(platform.config.variables?.account ?? '').trim() || null;
  const fallback = platform.environment ?? '';
  const timeout = DATA_DISCOVERY_LIMITS.statementTimeoutSeconds;
  const limit = ctx.max;
  const envOf = (database: string) => environmentByRules(database, source.environmentRules, fallback);
  const keeps = (qn: string, container: boolean) => discoveryKeeps(qn, source.includePrefixes, source.excludePrefixes, container);
  const element = (e: Emitted): DiscoveredElement => {
    const ol = openLineageDataset(e.kind, account, e.qualifiedName);
    return {
      kind: e.kind,
      qualifiedName: e.qualifiedName,
      parentQualifiedName: e.parent,
      environment: e.env,
      externalId: e.externalId ?? null,
      flags: e.flags ?? {},
      readout: e.readout ?? null,
      olNamespace: ol?.namespace ?? null,
      olName: ol?.name ?? null,
    };
  };
  /** Kept schemas (a table whose schema was left out is left out too: its parent would be missing) */
  const schemasKept = new Set<string>();

  const all = async (statement: string, bindings: (string | number)[]): Promise<Row[]> => {
    const out: Row[] = [];
    for await (const part of c.queryPartitions(statement, bindings, limit, timeout)) out.push(...part);
    return out;
  };
  const show = async (what: 'DYNAMIC TABLES' | 'STREAMS' | 'TASKS' | 'STAGES' | 'PIPES', database: string, schemas: Set<string> | null): Promise<Row[]> => {
    const where = schemas ? [...schemas].map((s) => `SCHEMA ${quoted(database)}.${quoted(s)}`) : [`DATABASE ${quoted(database)}`];
    const out: Row[] = [];
    for (const w of where) out.push(...(await all(`/* steward:dp-show */ SHOW ${what} IN ${w}`, [])));
    return out;
  };
  const table = (database: string, r: Row, secure: Set<string>, dynamic: Map<string, Row>, externalId: string | null): Emitted | null => {
    const schema = r.TABLE_SCHEMA ?? '';
    const name = r.TABLE_NAME ?? '';
    const qn = `${database}.${schema}.${name}`;
    if (!schema || !name || !schemasKept.has(`${database}.${schema}`) || !keeps(qn, false)) return null;
    const type = String(r.TABLE_TYPE ?? '').toUpperCase();
    const base = { qualifiedName: qn, parent: `${database}.${schema}`, env: envOf(database), externalId };
    const dyn = dynamic.get(qn);
    if (dyn) {
      dynamic.delete(qn);
      return {
        ...base,
        kind: 'snowflake.dynamicTable',
        readout: {
          rowCount: num(r.ROW_COUNT ?? dyn.rows),
          bytes: num(r.BYTES ?? dyn.bytes),
          lastAltered: r.LAST_ALTERED ?? null,
          targetLag: short(dyn.target_lag, 60),
          refreshMode: short(dyn.refresh_mode, 40),
          schedulingState: short(dyn.scheduling_state, 40),
        },
      };
    }
    if (type === 'VIEW' || type === 'MATERIALIZED VIEW')
      return {
        ...base,
        kind: 'snowflake.view',
        flags: { ...(secure.has(qn) ? { secure: true } : {}), ...(type === 'MATERIALIZED VIEW' ? { materialized: true } : {}) },
        readout: { lastAltered: r.LAST_ALTERED ?? null, ...(type === 'MATERIALIZED VIEW' ? { rowCount: num(r.ROW_COUNT), bytes: num(r.BYTES) } : {}) },
      };
    return {
      ...base,
      kind: 'snowflake.table',
      flags: {
        ...(String(r.IS_TRANSIENT ?? '').toUpperCase() === 'YES' ? { transient: true } : {}),
        ...(type === 'EXTERNAL TABLE' ? { external: true } : {}),
        ...(type === 'EVENT TABLE' ? { event: true } : {}),
      },
      readout: { rowCount: num(r.ROW_COUNT), bytes: num(r.BYTES), lastAltered: r.LAST_ALTERED ?? null },
    };
  };
  /** Dynamic tables, streams, tasks, stages and pipes of one database (SHOW output: metadata columns only). */
  async function* shown(database: string, schemas: Set<string> | null, dynamicLeft: Map<string, Row>): AsyncGenerator<Emitted[]> {
    const env = envOf(database);
    const inScope = (r: Row) => {
      const schema = r.schema_name ?? '';
      const qn = `${database}.${schema}.${r.name ?? ''}`;
      return schema && r.name && schemasKept.has(`${database}.${schema}`) && keeps(qn, false) ? qn : null;
    };
    // dynamic tables the views did not list (a role that sees them only through SHOW)
    const dyn: Emitted[] = [];
    for (const [qn, r] of dynamicLeft)
      if (inScope(r))
        dyn.push({
          kind: 'snowflake.dynamicTable',
          qualifiedName: qn,
          parent: `${database}.${r.schema_name}`,
          env,
          readout: {
            rowCount: num(r.rows),
            bytes: num(r.bytes),
            targetLag: short(r.target_lag, 60),
            refreshMode: short(r.refresh_mode, 40),
            schedulingState: short(r.scheduling_state, 40),
          },
        });
    yield dyn;
    const streams = await show('STREAMS', database, schemas);
    yield streams.flatMap((r): Emitted[] => {
      const qn = inScope(r);
      return qn
        ? [
            {
              kind: 'snowflake.stream',
              qualifiedName: qn,
              parent: `${database}.${r.schema_name}`,
              env,
              flags: r.mode ? { mode: String(r.mode).slice(0, 40) } : {},
              readout: { sourceType: short(r.source_type, 40), table: short(r.table_name, 1000), stale: r.stale === 'true' },
            },
          ]
        : [];
    });
    const tasks = await show('TASKS', database, schemas);
    yield tasks.flatMap((r): Emitted[] => {
      const qn = inScope(r);
      return qn
        ? [
            {
              kind: 'snowflake.task',
              qualifiedName: qn,
              parent: `${database}.${r.schema_name}`,
              env,
              externalId: short(r.id, 100),
              readout: { state: short(r.state, 40), schedule: short(r.schedule, 200), warehouse: short(r.warehouse, 255) },
            },
          ]
        : [];
    });
    const stages = await show('STAGES', database, schemas);
    yield stages.flatMap((r): Emitted[] => {
      const qn = inScope(r);
      return qn
        ? [
            {
              kind: 'snowflake.stage',
              qualifiedName: qn,
              parent: `${database}.${r.schema_name}`,
              env,
              flags: { external: String(r.type ?? '').toUpperCase().startsWith('EXTERNAL') },
              readout: { stageType: short(r.type, 40), cloud: short(r.cloud, 40), region: short(r.region, 60) },
            },
          ]
        : [];
    });
    const pipes = await show('PIPES', database, schemas);
    yield pipes.flatMap((r): Emitted[] => {
      const qn = inScope(r);
      return qn
        ? [
            {
              kind: 'snowflake.pipe',
              qualifiedName: qn,
              parent: `${database}.${r.schema_name}`,
              env,
              flags: { autoIngest: !!r.notification_channel },
            },
          ]
        : [];
    });
  }
  const dynamicOf = async (database: string, schemas: Set<string> | null) =>
    new Map((await show('DYNAMIC TABLES', database, schemas)).filter((r) => r.name && r.schema_name).map((r) => [`${database}.${r.schema_name}.${r.name}`, r]));

  if (source.mode === 'accountUsage') {
    const names = [...scope.keys()];
    const wholeDbs = names.filter((d) => scope.get(d) === null);
    const pairs = names.flatMap((d) => [...(scope.get(d) ?? [])].map((s) => `${d}.${s}`));
    // '' stands for an empty list (IN () is not SQL)
    const dbList = wholeDbs.length ? wholeDbs : [''];
    const pairList = pairs.length ? pairs : [''];
    const scopeSql = (cat: string, sch: string) => `(${cat} IN (${marks(dbList.length)}) OR CONCAT(${cat}, '.', ${sch}) IN (${marks(pairList.length)}))`;
    const dbs = await all(
      `/* steward:dp-au-databases */ SELECT DATABASE_ID, DATABASE_NAME FROM ${AU}.DATABASES WHERE DELETED IS NULL AND DATABASE_NAME IN (${marks(names.length)})`,
      names,
    );
    const found = new Map(dbs.map((r) => [r.DATABASE_NAME ?? '', r.DATABASE_ID ?? null]));
    const missingDb = names.find((d) => !found.has(d));
    if (missingDb)
      throw new DiscoveryError({
        message: `Snowflake database ${missingDb} does not exist or the role may not see it`,
        code: 'DATA_DISCOVERY_FAILED',
        params: { context: 'snowflakeDatabase', database: missingDb },
      });
    yield names
      .filter((d) => keeps(d, true))
      .map((d) => element({ kind: 'snowflake.database', qualifiedName: d, parent: null, env: envOf(d), externalId: found.get(d) ?? null }));
    const schemata = await all(
      `/* steward:dp-au-schemata */ SELECT SCHEMA_ID, CATALOG_NAME, SCHEMA_NAME FROM ${AU}.SCHEMATA WHERE DELETED IS NULL AND SCHEMA_NAME <> 'INFORMATION_SCHEMA' AND ${scopeSql('CATALOG_NAME', 'SCHEMA_NAME')} ORDER BY CATALOG_NAME, SCHEMA_NAME LIMIT ${limit}`,
      [...dbList, ...pairList],
    );
    const schemaElements: DiscoveredElement[] = [];
    for (const r of schemata) {
      const qn = `${r.CATALOG_NAME}.${r.SCHEMA_NAME}`;
      if (!r.CATALOG_NAME || !r.SCHEMA_NAME || !keeps(r.CATALOG_NAME, true) || !keeps(qn, true)) continue;
      schemasKept.add(qn);
      schemaElements.push(element({ kind: 'snowflake.schema', qualifiedName: qn, parent: r.CATALOG_NAME, env: envOf(r.CATALOG_NAME), externalId: r.SCHEMA_ID }));
    }
    yield schemaElements;
    const secure = new Set(
      (
        await all(
          `/* steward:dp-au-secure-views */ SELECT TABLE_CATALOG, TABLE_SCHEMA, TABLE_NAME FROM ${AU}.VIEWS WHERE DELETED IS NULL AND IS_SECURE = 'YES' AND ${scopeSql('TABLE_CATALOG', 'TABLE_SCHEMA')} LIMIT ${limit}`,
          [...dbList, ...pairList],
        )
      ).map((r) => `${r.TABLE_CATALOG}.${r.TABLE_SCHEMA}.${r.TABLE_NAME}`),
    );
    const dynamic = new Map<string, Row>();
    for (const d of names) for (const [k, v] of await dynamicOf(d, scope.get(d) ?? null)) dynamic.set(k, v);
    for await (const part of c.queryPartitions(
      `/* steward:dp-au-tables */ SELECT TABLE_ID, TABLE_CATALOG, TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, IS_TRANSIENT, ROW_COUNT, BYTES, TO_VARCHAR(LAST_ALTERED, ${ISO}) AS LAST_ALTERED
       FROM ${AU}.TABLES WHERE DELETED IS NULL AND TABLE_SCHEMA <> 'INFORMATION_SCHEMA' AND ${scopeSql('TABLE_CATALOG', 'TABLE_SCHEMA')}
       ORDER BY TABLE_CATALOG, TABLE_SCHEMA, TABLE_NAME LIMIT ${limit}`.replace(/\s+/g, ' '),
      [...dbList, ...pairList],
      limit,
      timeout,
    ))
      yield part.flatMap((r) => {
        const e = r.TABLE_CATALOG ? table(r.TABLE_CATALOG, r, secure, dynamic, r.TABLE_ID ?? null) : null;
        return e ? [element(e)] : [];
      });
    for (const d of names) {
      const left = new Map([...dynamic].filter(([k]) => k.startsWith(`${d}.`)));
      for await (const part of shown(d, scope.get(d) ?? null, left)) yield part.map(element);
    }
    return;
  }

  // information schema: one database at a time
  for (const [database, schemas] of scope) {
    if (!keeps(database, true)) continue;
    const env = envOf(database);
    const info = (view: string) => `${database}.INFORMATION_SCHEMA.${view}`;
    const only = schemas ? ` AND TABLE_SCHEMA IN (${marks(schemas.size)})` : '';
    const schemaArgs = schemas ? [...schemas] : [];
    const schemata = await all(
      `/* steward:dp-schemata */ SELECT SCHEMA_NAME, TO_VARCHAR(LAST_ALTERED, ${ISO}) AS LAST_ALTERED FROM IDENTIFIER(?) WHERE SCHEMA_NAME <> 'INFORMATION_SCHEMA'${schemas ? ` AND SCHEMA_NAME IN (${marks(schemas.size)})` : ''} ORDER BY SCHEMA_NAME LIMIT ${limit}`,
      [info('SCHEMATA'), ...schemaArgs],
    );
    const out: DiscoveredElement[] = [element({ kind: 'snowflake.database', qualifiedName: database, parent: null, env })];
    for (const r of schemata) {
      const qn = `${database}.${r.SCHEMA_NAME}`;
      if (!r.SCHEMA_NAME || !keeps(qn, true)) continue;
      schemasKept.add(qn);
      out.push(element({ kind: 'snowflake.schema', qualifiedName: qn, parent: database, env, readout: { lastAltered: r.LAST_ALTERED ?? null } }));
    }
    yield out;
    const secure = new Set(
      (
        await all(
          `/* steward:dp-secure-views */ SELECT TABLE_SCHEMA, TABLE_NAME FROM IDENTIFIER(?) WHERE IS_SECURE = 'YES' AND TABLE_SCHEMA <> 'INFORMATION_SCHEMA'${only} LIMIT ${limit}`,
          [info('VIEWS'), ...schemaArgs],
        )
      ).map((r) => `${database}.${r.TABLE_SCHEMA}.${r.TABLE_NAME}`),
    );
    const dynamic = await dynamicOf(database, schemas);
    for await (const part of c.queryPartitions(
      `/* steward:dp-tables */ SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, IS_TRANSIENT, ROW_COUNT, BYTES, TO_VARCHAR(LAST_ALTERED, ${ISO}) AS LAST_ALTERED FROM IDENTIFIER(?) WHERE TABLE_SCHEMA <> 'INFORMATION_SCHEMA'${only} ORDER BY TABLE_SCHEMA, TABLE_NAME LIMIT ${limit}`,
      [info('TABLES'), ...schemaArgs],
      limit,
      timeout,
    ))
      yield part.flatMap((r) => {
        const e = table(database, r, secure, dynamic, null);
        return e ? [element(e)] : [];
      });
    for await (const part of shown(database, schemas, dynamic)) yield part.map(element);
  }
}
