import {
  PLANT_ID_SCOPE,
  type PlantIdKind,
  type PlantInterface,
  type PlantReferenceCount,
  type PlantRenameInput,
  type PlantRenamePreview,
  type PlantRenameResult,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { me } from '../auth/access.js';
import { HttpError, parseJson, sha256 } from '../util.js';
import { aliasesOf, aliasTarget, checkScope, entryOf, entryPath, entryPermissions, idFormatProblem, writeAlias, type Entry } from './ids.js';
import { requirePlant } from './settings.js';

/**
 * The one rename core of the plant registry (0.11.0, docs/PLANT.md#changing-ids): an entry gets a new id and every
 * reference to it follows, in one transaction – the plant tables, the links of records, services and tickets, owning
 * teams, credentials' "used by", where copies came from, earlier imports and the aliases. The old id stays an alias.
 *
 * REFERENCES is the registry of every column (and JSON field) that holds a plant id; server/test/plant-rename.test.ts
 * walks the schema and fails when a column that may hold one is not listed here or in its list of other columns.
 * The audit log is history and is never rewritten; dataset filters of live-status checks (`value: rvs-mill-01`) name
 * rows of an outside dataset, not the entry, and stay as they are.
 */

export interface RenameOf {
  kind: PlantIdKind;
  scope: string;
  from: string;
  to: string;
}

export interface RefSpec {
  table: string;
  /** The column; JSON columns are written `column[field]` */
  column: string;
  /** The kind whose ids it holds */
  kind: PlantIdKind;
  /** What the preview counts it as */
  what: string;
  /** Updates the references of one rename; the number of rows changed */
  apply(r: RenameOf): number;
}

const run = (sql: string, ...p: unknown[]) => db().run(sql, ...p).changes;

/** A plain column; `scoped`: the column that holds the entry's scope (site, asset or profile id). */
const col = (table: string, column: string, kind: PlantIdKind, what: string, scoped?: string): RefSpec => ({
  table,
  column,
  kind,
  what,
  apply: (r) => run(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?${scoped ? ` AND ${scoped} = ?` : ''}`, r.to, r.from, ...(scoped ? [r.scope] : [])),
});

/** A (kind, id) pair: links, owning teams, copies, external references. */
const pair = (table: string, kindCol: string, kindValue: string, idCol: string, kind: PlantIdKind, what: string): RefSpec => ({
  table,
  column: `${idCol}[${kindCol}=${kindValue}]`,
  kind,
  what,
  apply: (r) => run(`UPDATE ${table} SET ${idCol} = ? WHERE ${kindCol} = ? AND ${idCol} = ?`, r.to, kindValue, r.from),
});

/**
 * A JSON column: the rows (of the scope) are read, rewritten and written back when they change. No pattern prefilter: it
 * matches case differently on SQLite and PostgreSQL, and ids may hold `_` (the tables are small).
 * `where` narrows the rows (the scope); `keys` are the primary key columns.
 */
function json<T>(
  table: string,
  column: string,
  field: string,
  kind: PlantIdKind,
  what: string,
  keys: string[],
  rewrite: (v: T, r: RenameOf) => boolean,
  where?: { sql: string; params: (r: RenameOf) => unknown[] },
): RefSpec {
  return {
    table,
    column: `${column}[${field}]`,
    kind,
    what,
    apply: (r) => {
      const rows = db().all<Record<string, string>>(
        `SELECT ${keys.join(', ')}, ${column} AS v FROM ${table}${where ? ` WHERE ${where.sql}` : ''}`,
        ...(where?.params(r) ?? []),
      );
      let n = 0;
      for (const row of rows) {
        const v = parseJson<T | null>(row.v ?? '', null);
        if (v === null || !rewrite(v, r)) continue;
        n += run(`UPDATE ${table} SET ${column} = ? WHERE ${keys.map((k) => `${k} = ?`).join(' AND ')}`, JSON.stringify(v), ...keys.map((k) => row[k]));
      }
      return n;
    },
  };
}

/** Replaces every element equal to the old id in a list (in place); whether one was. */
const inList = (list: unknown, r: RenameOf): boolean => {
  if (!Array.isArray(list)) return false;
  let hit = false;
  list.forEach((x, i) => {
    if (x === r.from) {
      list[i] = r.to;
      hit = true;
    }
  });
  return hit;
};
/** Sets field `k` of every object in a list that holds the old id there. */
const inObjects =
  <O extends Record<string, unknown>>(k: keyof O, when: (o: O) => boolean = () => true) =>
  (list: unknown, r: RenameOf): boolean => {
    if (!Array.isArray(list)) return false;
    let hit = false;
    for (const o of list as O[])
      if (o && o[k] === r.from && when(o)) {
        (o as Record<string, unknown>)[k as string] = r.to;
        hit = true;
      }
    return hit;
  };

const SITE_KINDS = ['building', 'node', 'vlan', 'zone', 'conduit'];
const conduitId = (site: string, id: string) => `${site}/${id}`;

/** Credentials' "used by" links ({ text, links: [{ kind, id }], urls }). */
const usedBy = (kind: PlantIdKind, linkKind: string, id: (r: RenameOf, side: 'from' | 'to') => string, prefix = false): RefSpec => ({
  table: 'credentials',
  column: `used_by[links.${linkKind}]`,
  kind,
  what: 'credential',
  apply: (r) => {
    const from = id(r, 'from');
    const rows = db().all<{ id: string; used_by: string }>("SELECT id, used_by FROM credentials WHERE used_by <> '{}'");
    let n = 0;
    for (const row of rows) {
      const v = parseJson<{ links?: { kind: string; id: string }[] } | null>(row.used_by, null);
      let hit = false;
      for (const l of v?.links ?? []) {
        if (l.kind !== linkKind) continue;
        if (l.id === from) {
          l.id = id(r, 'to');
          hit = true;
        } else if (prefix && l.id.startsWith(`${from}/`)) {
          l.id = `${id(r, 'to')}${l.id.slice(from.length)}`;
          hit = true;
        }
      }
      if (hit) n += run('UPDATE credentials SET used_by = ? WHERE id = ?', JSON.stringify(v), row.id);
    }
    return n;
  },
});

/** The data points of a profile's interfaces (in place). */
const eachPoint = (ifaces: PlantInterface[], fn: (p: { id: string }) => void) => {
  for (const i of ifaces) {
    for (const g of i.groups ?? []) for (const d of g.dataPoints ?? []) fn(d);
    for (const d of (i as { dataPoints?: { id: string }[] }).dataPoints ?? []) fn(d);
  }
};

const byProfile = { sql: 'profile_id = ?', params: (r: RenameOf) => [r.scope] };
const bySite = { sql: 'site_id = ?', params: (r: RenameOf) => [r.scope] };
const byAsset = { sql: 'asset_id = ?', params: (r: RenameOf) => [r.scope] };

export const REFERENCES: readonly RefSpec[] = [
  // ---- sites
  col('plant_sites', 'id', 'site', 'site'),
  col('plant_nodes', 'site_id', 'site', 'node'),
  col('plant_buildings', 'site_id', 'site', 'building'),
  col('plant_assets', 'site_id', 'site', 'asset'),
  col('plant_vlans', 'site_id', 'site', 'vlan'),
  col('plant_zones', 'site_id', 'site', 'zone'),
  col('plant_conduits', 'site_id', 'site', 'conduit'),
  json<string[]>('plant_vlans', 'sites', '[]', 'site', 'vlan', ['site_id', 'id'], inList),
  pair('plant_refs', 'kind', 'site', 'item_id', 'site', 'external_ref'),
  pair('item_links', 'from_kind', 'site', 'from_id', 'site', 'link'),
  pair('item_links', 'to_kind', 'site', 'to_id', 'site', 'link'),
  {
    // a conduit is linked as <site>/<conduit>
    table: 'item_links',
    column: 'to_id[to_kind=conduit, site part]',
    kind: 'site',
    what: 'link',
    apply: (r) =>
      db()
        .all<{ id: string; to_id: string }>(
          // an exact prefix (no pattern: ids may hold "_")
          "SELECT id, to_id FROM item_links WHERE to_kind = 'conduit' AND substr(to_id, 1, ?) = ?",
          r.from.length + 1,
          `${r.from}/`,
        )
        .reduce((n, l) => n + run('UPDATE item_links SET to_id = ? WHERE id = ?', `${r.to}${l.to_id.slice(r.from.length)}`, l.id), 0),
  },
  pair('resource_teams', 'kind', 'site', 'resource_id', 'site', 'owning_team'),
  usedBy('site', 'site', (r, s) => r[s]),
  usedBy('site', 'conduit', (r, s) => r[s], true),
  json<string[]>('plant_imports', 'sites', '[]', 'site', 'import', ['id'], inList),
  {
    table: 'plant_id_aliases',
    column: 'scope[site-scoped kinds]',
    kind: 'site',
    what: 'alias',
    apply: (r) =>
      run(`UPDATE plant_id_aliases SET scope = ? WHERE scope = ? AND kind IN (${SITE_KINDS.map(() => '?').join(', ')})`, r.to, r.from, ...SITE_KINDS),
  },
  // ---- buildings and hierarchy nodes of a site
  col('plant_buildings', 'id', 'building', 'building', 'site_id'),
  col('plant_buildings', 'parent_id', 'building', 'building', 'site_id'),
  col('plant_nodes', 'building_id', 'building', 'node', 'site_id'),
  col('plant_assets', 'building_id', 'building', 'asset', 'site_id'),
  col('plant_nodes', 'id', 'node', 'node', 'site_id'),
  col('plant_nodes', 'parent_id', 'node', 'node', 'site_id'),
  col('plant_assets', 'area_id', 'node', 'asset', 'site_id'),
  col('plant_assets', 'work_center_id', 'node', 'asset', 'site_id'),
  col('plant_assets', 'work_unit_id', 'node', 'asset', 'site_id'),
  // ---- assets
  col('plant_assets', 'id', 'asset', 'asset'),
  col('plant_assets', 'parent_id', 'asset', 'asset'),
  col('plant_asset_images', 'asset_id', 'asset', 'image'),
  pair('plant_refs', 'kind', 'asset', 'item_id', 'asset', 'external_ref'),
  col('plant_assignments', 'asset_id', 'asset', 'assignment'),
  col('plant_devices', 'asset_id', 'asset', 'device'),
  col('plant_data_paths', 'asset_id', 'asset', 'data_path'),
  col('plant_asset_checks', 'asset_id', 'asset', 'asset_checks'),
  pair('item_links', 'from_kind', 'asset', 'from_id', 'asset', 'link'),
  pair('item_links', 'to_kind', 'asset', 'to_id', 'asset', 'link'),
  usedBy('asset', 'asset', (r, s) => r[s]),
  pair('copied_from', 'kind', 'asset', 'id', 'asset', 'copy'),
  pair('copied_from', 'kind', 'asset', 'source_id', 'asset', 'copy'),
  {
    table: 'plant_id_aliases',
    column: 'scope[device, data_path]',
    kind: 'asset',
    what: 'alias',
    apply: (r) => run("UPDATE plant_id_aliases SET scope = ? WHERE scope = ? AND kind IN ('device', 'data_path')", r.to, r.from),
  },
  // ---- device profiles, their interfaces and data points
  col('plant_profiles', 'id', 'profile', 'profile'),
  col('plant_assignments', 'profile_id', 'profile', 'assignment'),
  json<{ profile: string }[]>('plant_kpis', 'inputs', 'profile', 'profile', 'kpi', ['id'], inObjects('profile')),
  pair('copied_from', 'kind', 'device-profile', 'id', 'profile', 'copy'),
  pair('copied_from', 'kind', 'device-profile', 'source_id', 'profile', 'copy'),
  {
    table: 'plant_id_aliases',
    column: 'scope[interface, data_point]',
    kind: 'profile',
    what: 'alias',
    apply: (r) => run("UPDATE plant_id_aliases SET scope = ? WHERE scope = ? AND kind IN ('interface', 'data_point')", r.to, r.from),
  },
  json<PlantInterface[]>('plant_profiles', 'interfaces', 'id', 'interface', 'profile', ['id'], inObjects('id'), { sql: 'id = ?', params: (r) => [r.scope] }),
  json<{ interface: string }[]>('plant_assignments', 'interfaces', 'interface', 'interface', 'assignment', ['asset_id'], inObjects('interface'), byProfile),
  json<PlantInterface[]>(
    'plant_profiles',
    'interfaces',
    'groups.dataPoints.id',
    'data_point',
    'profile',
    ['id'],
    (v, r) => {
      let hit = false;
      eachPoint(v, (p) => {
        if (p.id === r.from) {
          p.id = r.to;
          hit = true;
        }
      });
      return hit;
    },
    { sql: 'id = ?', params: (r) => [r.scope] },
  ),
  json<{ dataPoint: string }[]>('plant_assignments', 'overrides', 'dataPoint', 'data_point', 'assignment', ['asset_id'], inObjects('dataPoint'), byProfile),
  json<{ dataPoint: string }[]>('plant_assignments', 'publications', 'dataPoint', 'data_point', 'assignment', ['asset_id'], inObjects('dataPoint'), byProfile),
  // inputs that name the profile; an input without a profile names a data point of whatever profile an asset has: kept
  json<{ profile: string; dataPoints: string[] }[]>('plant_kpis', 'inputs', 'dataPoints', 'data_point', 'kpi', ['id'], (v, r) =>
    v.reduce((hit, i) => (i.profile === r.scope && inList(i.dataPoints, r)) || hit, false),
  ),
  // ---- KPI definitions
  col('plant_kpis', 'id', 'kpi', 'kpi'),
  json<{ kpi: string }[]>('plant_assignments', 'kpis', 'kpi', 'kpi', 'assignment', ['asset_id'], inObjects('kpi')),
  pair('copied_from', 'kind', 'kpi-definition', 'id', 'kpi', 'copy'),
  pair('copied_from', 'kind', 'kpi-definition', 'source_id', 'kpi', 'copy'),
  // ---- the OT network of a site
  col('plant_vlans', 'id', 'vlan', 'vlan', 'site_id'),
  json<string[]>('plant_zones', 'vlans', '[]', 'vlan', 'zone', ['site_id', 'id'], inList, bySite),
  {
    // a device names a VLAN of its asset's site
    table: 'plant_devices',
    column: 'vlan_id',
    kind: 'vlan',
    what: 'device',
    apply: (r) =>
      run('UPDATE plant_devices SET vlan_id = ? WHERE vlan_id = ? AND asset_id IN (SELECT id FROM plant_assets WHERE site_id = ?)', r.to, r.from, r.scope),
  },
  col('plant_zones', 'id', 'zone', 'zone', 'site_id'),
  col('plant_conduits', 'zone_a', 'zone', 'conduit', 'site_id'),
  col('plant_conduits', 'zone_b', 'zone', 'conduit', 'site_id'),
  col('plant_conduits', 'id', 'conduit', 'conduit', 'site_id'),
  {
    table: 'item_links',
    column: 'to_id[to_kind=conduit]',
    kind: 'conduit',
    what: 'link',
    apply: (r) => run("UPDATE item_links SET to_id = ? WHERE to_kind = 'conduit' AND to_id = ?", conduitId(r.scope, r.to), conduitId(r.scope, r.from)),
  },
  usedBy('conduit', 'conduit', (r, s) => conduitId(r.scope, r[s])),
  // ---- the OT network of an asset
  col('plant_devices', 'id', 'device', 'device', 'asset_id'),
  json<string[]>('plant_data_paths', 'devices', '[]', 'device', 'data_path', ['asset_id', 'id'], inList, byAsset),
  json<{ peerKind: string; peer: string }[]>(
    'plant_data_paths',
    'transfers',
    'peer',
    'device',
    'data_path',
    ['asset_id', 'id'],
    inObjects('peer', (t) => t.peerKind === 'device'),
    byAsset,
  ),
  col('plant_data_paths', 'id', 'data_path', 'data_path', 'asset_id'),
];

/** The table and column of the entry itself, per kind (the rest are references). */
const SELF: Record<PlantIdKind, string> = {
  site: 'plant_sites.id',
  building: 'plant_buildings.id',
  node: 'plant_nodes.id',
  asset: 'plant_assets.id',
  profile: 'plant_profiles.id',
  interface: 'plant_profiles.interfaces[id]',
  data_point: 'plant_profiles.interfaces[groups.dataPoints.id]',
  kpi: 'plant_kpis.id',
  vlan: 'plant_vlans.id',
  zone: 'plant_zones.id',
  conduit: 'plant_conduits.id',
  device: 'plant_devices.id',
  data_path: 'plant_data_paths.id',
};

/** Updates every reference of a rename (inside a transaction); counts per kind of holder, the entry itself left out. */
function applyReferences(r: RenameOf): PlantReferenceCount[] {
  const counts = new Map<string, number>();
  for (const ref of REFERENCES) {
    if (ref.kind !== r.kind) continue;
    const n = ref.apply(r);
    if (`${ref.table}.${ref.column}` === SELF[r.kind]) continue;
    if (n) counts.set(ref.what, (counts.get(ref.what) ?? 0) + n);
  }
  return [...counts].map(([what, count]) => ({ what, count })).sort((a, b) => a.what.localeCompare(b.what));
}

// ---------- checking ----------

export interface RenameCheck {
  entry: Entry | null;
  problem: { code: string; message: string } | null;
}

/**
 * Whether an entry may get the new id: it exists and the caller may change it, the id follows the kind's rules, no
 * other entry of the kind (in its scope) has it, and it is no live old id of another entry. Entries the caller may not
 * see read as missing. `taken` lets a bulk rename treat ids that other renames free or take.
 */
export function checkRename(kind: PlantIdKind, scope: string, from: string, to: string, taken?: (id: string) => boolean | undefined): RenameCheck {
  checkScope(kind, scope);
  const entry = entryOf(kind, scope, from);
  const perms = entry ? entryPermissions(entry) : [];
  if (!entry || !perms.includes('view')) return { entry: null, problem: { code: 'PLANT_ENTRY_NOT_FOUND', message: `There is no ${kind} "${from}"` } };
  if (!perms.includes('manage')) return { entry, problem: { code: 'FORBIDDEN', message: `You may not change ${kind} "${from}"` } };
  if (from === to) return { entry, problem: { code: 'PLANT_ID_SAME', message: 'The new id is the id it has' } };
  const format = idFormatProblem(kind, to);
  if (format) return { entry, problem: { code: 'PLANT_ID_FORMAT', message: format } };
  const busy = taken?.(to) ?? !!entryOf(kind, scope, to);
  if (busy) return { entry, problem: { code: 'PLANT_ID_TAKEN', message: `Another ${kind} has the id "${to}" already` } };
  const alias = aliasTarget(kind, scope, to);
  if (alias && alias !== from)
    return {
      entry,
      problem: { code: 'PLANT_ID_ALIAS', message: `"${to}" is an old id of "${alias}" and still leads to it – an administrator can remove that alias first` },
    };
  return { entry, problem: null };
}

/**
 * Renames one entry and every reference to it; writes the alias. No rights or rules are checked here (checkRename);
 * call it inside a transaction. The counts leave the entry itself out.
 */
export function renameEntry(r: RenameOf, by: string): PlantReferenceCount[] {
  const counts = applyReferences(r);
  const aliases = writeAlias(r.kind, r.scope, r.from, r.to, by);
  if (aliases) counts.push({ what: 'alias', count: aliases });
  return counts;
}

class Rollback extends Error {}

/** Runs fn in a transaction that is always rolled back: what a change would do, without doing it. */
export function dryRun<T>(fn: () => T): T {
  let out: T | undefined;
  try {
    db().tx(() => {
      out = fn();
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out!;
}

const preview = (input: PlantRenameInput): PlantRenamePreview & { entry: Entry | null } => {
  requirePlant();
  const { kind, scope, id, newId } = input;
  const c = checkRename(kind, scope, id, newId);
  if (!c.entry) throw new HttpError(404, c.problem!.message, 'PLANT_ENTRY_NOT_FOUND', { kind, id });
  // only who may change the entry sees what refers to it
  if (c.problem?.code === 'FORBIDDEN') throw new HttpError(403, c.problem.message, 'FORBIDDEN', { context: 'managePlant' });
  const references = c.problem ? [] : dryRun(() => renameEntry({ kind, scope, from: id, to: newId }, me().username));
  return {
    kind,
    scope,
    id,
    newId,
    name: c.entry.name,
    problem: c.problem,
    references,
    aliases: [...new Set([...aliasesOf(kind, scope, id), ...(c.problem ? [] : [id])])].filter((a) => a !== newId).sort(),
    entry: c.entry,
  };
};

/** POST /api/plant/ids/rename/preview: whether the rename can go ahead, and what refers to the entry. */
export function previewRename(input: PlantRenameInput): PlantRenamePreview {
  const { entry: _e, ...p } = preview(input);
  return p;
}

const where = (kind: PlantIdKind, scope: string, id: string) => (scope ? `${PLANT_ID_SCOPE[kind]} ${scope}, ${kind} ${id}` : `${kind} ${id}`);

/** A rename checkRename refused, as the route's answer. */
function refuse(p: { code: string; message: string }, kind: PlantIdKind, id: string): never {
  const params = { kind, id };
  switch (p.code) {
    case 'FORBIDDEN':
      throw new HttpError(403, p.message, 'FORBIDDEN', { context: 'managePlant' });
    case 'PLANT_ID_FORMAT':
      throw new HttpError(400, p.message, 'PLANT_ID_FORMAT', params);
    case 'PLANT_ID_SAME':
      throw new HttpError(409, p.message, 'PLANT_ID_SAME', params);
    case 'PLANT_ID_TAKEN':
      throw new HttpError(409, p.message, 'PLANT_ID_TAKEN', params);
    default:
      throw new HttpError(409, p.message, 'PLANT_ID_ALIAS', params);
  }
}

/** POST /api/plant/ids/rename: renames the entry, its references follow; audited as plant.id_changed. */
export function renameId(input: PlantRenameInput): PlantRenameResult {
  requirePlant();
  const { kind, scope, id, newId } = input;
  const by = me().username;
  const out = db().tx(() => {
    const c = checkRename(kind, scope, id, newId);
    if (!c.entry) throw new HttpError(404, c.problem!.message, 'PLANT_ENTRY_NOT_FOUND', { kind, id });
    if (c.problem) refuse(c.problem, kind, newId);
    const references = renameEntry({ kind, scope, from: id, to: newId }, by);
    const total = references.reduce((n, x) => n + x.count, 0);
    audit({
      action: 'plant.id_changed',
      entityType: kind,
      entityId: scope ? `${scope}/${newId}` : newId,
      summary: `Id of ${kind} "${c.entry.name}" changed: ${where(kind, scope, id)} → ${newId} (${total} references updated; the old id still leads to it)`,
      details: { kind, scope, old: id, new: newId, references },
    });
    return { name: c.entry.name, references };
  });
  return {
    kind,
    scope,
    id,
    newId,
    name: out.name,
    problem: null,
    references: out.references,
    aliases: aliasesOf(kind, scope, newId),
    path: entryPath(kind, scope, newId),
  };
}

/** A bulk rename's audit entry (an import with an id mapping): one entry, the renames in its details. */
export function auditBulkRenames(done: { kind: PlantIdKind; scope: string; from: string; to: string; references: PlantReferenceCount[] }[], via: string): void {
  if (!done.length) return;
  const list = done.map((d) => ({ kind: d.kind, scope: d.scope, old: d.from, new: d.to, references: d.references.reduce((n, x) => n + x.count, 0) }));
  audit({
    action: 'plant.ids_changed',
    entityType: 'plant',
    entityId: via,
    summary: `${done.length} plant ids changed (${via}): ${list
      .slice(0, 10)
      .map((d) => `${d.kind} ${d.old} → ${d.new}`)
      .join(', ')}${done.length > 10 ? ' …' : ''}`,
    details: { count: done.length, sha256: sha256(JSON.stringify(list)), renames: list.slice(0, 150) },
  });
}
