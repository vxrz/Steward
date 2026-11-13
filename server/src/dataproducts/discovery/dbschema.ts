import { discoveryKeeps, environmentByRules, openLineageDataset, type DbSchemaDoc, type DiscoveredElement, type Platform } from '@sm/shared';
import { db } from '../../db.js';
import { DiscoveryError, type DiscoveryContext } from './common.js';

/**
 * SQL discovery (ADR 0036 part 5): the schemas, tables and views of a database platform (PostgreSQL, MariaDB/MySQL, SQL
 * Server) from its **latest schema snapshot** (docs/DATABASES.md#database-schemas) – no new connection, no statement:
 * the snapshot is read or imported on its own schedule. The scope names schemas (none: all); a snapshot that was cut
 * (more tables than the schema read keeps) makes the run truncated, so nothing is marked missing.
 */

const OL_SCHEME: Record<string, string> = { postgresql: 'postgres', mysql: 'mysql', sqlserver: 'sqlserver' };

/** The OpenLineage namespace and the name prefix of a database platform (`postgres://host:5432`, `shop.`). */
export function sqlOpenLineage(p: Platform): { address: string; prefix: string } | null {
  const d = p.config.database;
  if (!d?.host) return null;
  const scheme = OL_SCHEME[d.dialect];
  if (!scheme) return null;
  const port = d.port ?? { postgresql: 5432, mysql: 3306, sqlserver: 1433 }[d.dialect];
  // MariaDB/MySQL: the schema is the database (`db.table`); the others name the database first (`db.schema.table`)
  return { address: `${scheme}://${d.host.toLowerCase()}:${port}`, prefix: d.dialect === 'mysql' ? '' : `${d.database}.` };
}

interface SnapshotRow {
  id: string;
  taken_at: string;
  database_name: string | null;
  truncated: number;
  schema_doc: string;
}

export async function* readSqlSnapshot(ctx: DiscoveryContext): AsyncGenerator<DiscoveredElement[]> {
  const { source, platform } = ctx;
  const row = db().get<SnapshotRow>(
    "SELECT id, taken_at, database_name, truncated, schema_doc FROM db_schema_snapshots WHERE subject_kind = 'platform' AND subject_id = ? ORDER BY taken_at DESC, id DESC LIMIT 1",
    platform.id,
  );
  if (!row)
    throw new DiscoveryError({
      message: `"${platform.name}" has no schema snapshot yet – read or import its schema first`,
      code: 'DATA_DISCOVERY_NO_SNAPSHOT',
      params: { platform: platform.name },
    });
  let doc: DbSchemaDoc;
  try {
    doc = JSON.parse(row.schema_doc) as DbSchemaDoc;
  } catch {
    throw new DiscoveryError({ message: 'The latest schema snapshot cannot be read', code: 'DATA_DISCOVERY_NO_SNAPSHOT', params: { platform: platform.name } });
  }
  const ol = sqlOpenLineage(platform);
  const fallback = platform.environment ?? '';
  const only = new Set(source.scope.map((s) => s.trim().toLowerCase()).filter(Boolean));
  const keeps = (qn: string, container: boolean) => discoveryKeeps(qn, source.includePrefixes, source.excludePrefixes, container);
  const element = (e: Omit<DiscoveredElement, 'olNamespace' | 'olName'>): DiscoveredElement => {
    const ds = ol ? openLineageDataset(e.kind, ol.address, `${ol.prefix}${e.qualifiedName}`) : null;
    return { ...e, olNamespace: ds?.namespace ?? null, olName: ds?.name ?? null };
  };
  const bySchema = new Map<string, DbSchemaDoc['tables']>();
  for (const t of doc.tables ?? []) {
    const schema = (t.schema ?? doc.database ?? row.database_name ?? '').trim();
    if (!schema || !t.name) continue;
    if (only.size && !only.has(schema.toLowerCase())) continue;
    bySchema.set(schema, [...(bySchema.get(schema) ?? []), t]);
  }
  const snapshotAt = row.taken_at;
  let n = 0;
  for (const [schema, tables] of [...bySchema].sort(([a], [b]) => a.localeCompare(b))) {
    if (!keeps(schema, true)) continue;
    const env = environmentByRules(schema, source.environmentRules, fallback);
    const out: DiscoveredElement[] = [element({ kind: 'sql.schema', qualifiedName: schema, environment: env, readout: { tables: tables.length, snapshotAt } })];
    for (const t of [...tables].sort((a, b) => a.name.localeCompare(b.name))) {
      const qn = `${schema}.${t.name}`;
      if (!keeps(qn, false)) continue;
      const type = String(t.type ?? '').toLowerCase();
      const view = type.includes('view');
      out.push(
        element({
          kind: view ? 'sql.view' : 'sql.table',
          qualifiedName: qn,
          parentQualifiedName: schema,
          environment: env,
          flags: { ...(type.includes('materialized') ? { materialized: true } : {}), ...(type.includes('foreign') ? { foreign: true } : {}) },
          // counts only: the columns' names and types stay in the snapshot (and the contract drafts read them there)
          readout: { columns: t.columns?.length ?? 0, tableType: type.slice(0, 40) || null, snapshotAt },
        }),
      );
    }
    n += out.length;
    yield out;
    if (n >= ctx.max) return;
  }
  if (row.truncated)
    ctx.warn({
      message: 'The latest schema snapshot was cut at the schema read limits: elements it does not hold are not marked missing',
      code: 'DATA_DISCOVERY_TOO_LARGE',
      params: { context: 'snapshot' },
    });
}
