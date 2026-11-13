import { PLANT_ID_SCOPE, plantIdPattern, type PlantCatalogueKind, type PlantIdAlias, type PlantIdKind, type PlantPermission } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { me } from '../auth/access.js';
import { currentUser } from '../auth/context.js';
import { HttpError, nowIso } from '../util.js';
import { canManageCatalogue, siteRights, sitePermissions } from './access.js';
import { pointsOf, profileValuesOf, type ProfileRow } from './data-model.js';
import { requirePlant } from './settings.js';
import { catalogueEntryAccess } from './catalogue-access.js';

/**
 * Entries of the plant registry by kind, scope and id (0.11.0, docs/PLANT.md#changing-ids): whether one exists, its
 * name, who may see and change it, its page – and the old ids that keep leading to it (plant_id_aliases). Used by the
 * rename core (rename.ts), the removal core (removal.ts), the import's id mapping and the reads that accept old ids.
 */

export interface Entry {
  kind: PlantIdKind;
  scope: string;
  id: string;
  name: string;
  /** The site whose rights apply (null: a catalogue entry – device profile, interface, data point, KPI definition) */
  siteId: string | null;
}

const one = <T>(sql: string, ...p: unknown[]) => db().get<T>(sql, ...p);

/** The device profile or KPI definition whose rights a catalogue entry follows (null: not one). */
function catalogueEntryOf(e: Partial<Pick<Entry, 'kind' | 'scope' | 'id'>>): { kind: PlantCatalogueKind; id: string } | null {
  if (e.kind === 'profile' && e.id) return { kind: 'device_profile', id: e.id };
  if (e.kind === 'kpi' && e.id) return { kind: 'kpi_definition', id: e.id };
  if ((e.kind === 'interface' || e.kind === 'data_point') && e.scope) return { kind: 'device_profile', id: e.scope };
  return null;
}

/** The entry as stored, whatever the reader may see (null: none). */
export function entryOf(kind: PlantIdKind, scope: string, id: string): Entry | null {
  const e = (name: string, siteId: string | null): Entry => ({ kind, scope, id, name, siteId });
  switch (kind) {
    case 'site': {
      const r = one<{ name: string }>('SELECT name FROM plant_sites WHERE id = ?', id);
      return r ? e(r.name, id) : null;
    }
    case 'asset': {
      const r = one<{ name: string; site_id: string }>('SELECT name, site_id FROM plant_assets WHERE id = ?', id);
      return r ? e(r.name, r.site_id) : null;
    }
    case 'building':
    case 'node':
    case 'vlan':
    case 'zone':
    case 'conduit': {
      const table = { building: 'plant_buildings', node: 'plant_nodes', vlan: 'plant_vlans', zone: 'plant_zones', conduit: 'plant_conduits' }[kind];
      const r = one<{ name: string }>(`SELECT name FROM ${table} WHERE site_id = ? AND id = ?`, scope, id);
      return r ? e(r.name, scope) : null;
    }
    case 'device':
    case 'data_path': {
      const r =
        kind === 'device'
          ? one<{ name: string; site_id: string }>(
              'SELECT d.hostname AS name, a.site_id FROM plant_devices d JOIN plant_assets a ON a.id = d.asset_id WHERE d.asset_id = ? AND d.id = ?',
              scope,
              id,
            )
          : one<{ name: string; site_id: string }>(
              'SELECT p.subject AS name, a.site_id FROM plant_data_paths p JOIN plant_assets a ON a.id = p.asset_id WHERE p.asset_id = ? AND p.id = ?',
              scope,
              id,
            );
      return r ? e(r.name || id, r.site_id) : null;
    }
    case 'profile':
    case 'kpi': {
      const r = one<{ name: string }>(`SELECT name FROM ${kind === 'profile' ? 'plant_profiles' : 'plant_kpis'} WHERE id = ?`, id);
      return r ? e(r.name, null) : null;
    }
    case 'interface':
    case 'data_point': {
      const r = one<ProfileRow>('SELECT * FROM plant_profiles WHERE id = ?', scope);
      if (!r) return null;
      const p = profileValuesOf(r);
      if (kind === 'interface') {
        const i = p.interfaces.find((x) => x.id === id);
        return i ? e(i.name || i.id, null) : null;
      }
      // its own data points, and those it adds to inherited interfaces (0.11.0); inherited ones are renamed in their base
      const d =
        pointsOf(p).find((x) => x.point.id === id)?.point ??
        p.interfaceOverrides.flatMap((o) => o.groups.flatMap((g) => g.dataPoints)).find((x) => x.id === id);
      return d ? e(d.name || d.id, null) : null;
    }
  }
}

/**
 * The rights of the current user on an entry: view and manage. Catalogue entries (0.21.0, #293): those of the device
 * profile or KPI definition – an interface or data point follows its profile; renaming or removing it needs Manage on it.
 */
export function entryPermissions(e: Pick<Entry, 'siteId'> & Partial<Pick<Entry, 'kind' | 'scope' | 'id'>>, rights?: Map<string, PlantPermission[]>): PlantPermission[] {
  if (e.siteId === null) {
    const of = catalogueEntryOf(e);
    if (!of) return canManageCatalogue() ? ['view', 'manage'] : ['view'];
    const r = catalogueEntryAccess(currentUser(), of.kind, of.id).permissions;
    return [...(r.includes('view') ? (['view'] as const) : []), ...(r.includes('manage') ? (['manage'] as const) : [])];
  }
  if (rights) return rights.get(e.siteId) ?? [];
  const s = one<{ id: string; acl: string }>('SELECT id, acl FROM plant_sites WHERE id = ?', e.siteId);
  return s ? sitePermissions(s) : [];
}

/** Rights on every site, read once (many entries). */
export const allSiteRights = (): Map<string, PlantPermission[]> => siteRights(db().all<{ id: string; acl: string }>('SELECT id, acl FROM plant_sites'));

/** The page of an entry in the web app (null: it has none of its own and no page shows it). */
export function entryPath(kind: PlantIdKind, scope: string, id: string): string | null {
  const enc = encodeURIComponent;
  switch (kind) {
    case 'site':
      return `/plant/sites/${enc(id)}`;
    case 'asset':
      return `/plant/assets/${enc(id)}`;
    case 'profile':
      return `/plant/profiles/${enc(id)}`;
    case 'kpi':
      return `/plant/kpis/${enc(id)}`;
    case 'data_point':
      return `/plant/profiles/${enc(scope)}/points/${enc(id)}`;
    case 'interface':
      return `/plant/profiles/${enc(scope)}`;
    case 'building':
    case 'node':
      return `/plant/sites/${enc(scope)}`;
    case 'vlan':
    case 'zone':
    case 'conduit':
      return `/plant/sites/${enc(scope)}/network`;
    case 'device':
    case 'data_path':
      return `/plant/assets/${enc(scope)}`;
  }
}

/** The id rules of a kind, as for a new entry (format only). */
export function idFormatProblem(kind: PlantIdKind, id: string): string | null {
  if (!plantIdPattern(kind).test(id))
    return kind === 'interface' || kind === 'data_point'
      ? 'Use letters, digits, ".", "_" and "-", starting with a letter, digit or "_" (at most 120)'
      : 'Use lower-case letters, digits, ".", "_" and "-", starting with a letter or digit (at most 80)';
  if (['__proto__', 'constructor', 'prototype'].includes(id)) return 'This name is reserved';
  return null;
}

/** The scope a kind's id is unique in must be given (and only then). */
export function checkScope(kind: PlantIdKind, scope: string): void {
  if ((PLANT_ID_SCOPE[kind] === 'none') !== (scope === ''))
    throw new HttpError(400, PLANT_ID_SCOPE[kind] === 'none' ? `A ${kind} has no scope` : `Name the ${PLANT_ID_SCOPE[kind]} of the ${kind}`, 'PLANT_ID_SCOPE', {
      kind,
      scope: PLANT_ID_SCOPE[kind],
    });
}

// ---------- aliases ----------

interface AliasRow {
  kind: PlantIdKind;
  scope: string;
  old_id: string;
  new_id: string;
  renamed_at: string;
  renamed_by: string;
}

/**
 * The entry an old id leads to now (null: none). An alias whose entry is gone is dead: it leads nowhere, the id is free
 * again (and the alias is removed the next time aliases are pruned).
 */
export function aliasTarget(kind: PlantIdKind, scope: string, oldId: string): string | null {
  const a = one<AliasRow>('SELECT * FROM plant_id_aliases WHERE kind = ? AND scope = ? AND old_id = ?', kind, scope, oldId);
  if (!a || !entryOf(kind, scope, a.new_id)) return null;
  return a.new_id;
}

/** The id an entry has now: itself when it exists, else the target of a live alias, else the id as given. */
export function currentId(kind: PlantIdKind, scope: string, id: string): string {
  if (!id || entryOf(kind, scope, id)) return id;
  return aliasTarget(kind, scope, id) ?? id;
}

/** Old ids that lead to an entry. */
export const aliasesOf = (kind: PlantIdKind, scope: string, id: string): string[] =>
  db()
    .all<{ old_id: string }>('SELECT old_id FROM plant_id_aliases WHERE kind = ? AND scope = ? AND new_id = ? ORDER BY old_id', kind, scope, id)
    .map((r) => r.old_id);

/** A new entry may not take an id that is still an old id of another entry (409 PLANT_ID_ALIAS). */
export function refuseAliasId(kind: PlantIdKind, scope: string, id: string): void {
  const to = aliasTarget(kind, scope, id);
  if (to)
    throw new HttpError(
      409,
      `"${id}" is an old id of "${to}" and still leads to it – an administrator can remove that alias first (Settings → Modules → Plant registry)`,
      'PLANT_ID_ALIAS',
      { id, target: to },
    );
}

/**
 * After a rename a → b: the old id leads to b, aliases that led to a lead to b (chains collapse), an alias b → … that
 * named the new id is gone (renaming back). Aliases of entries in the renamed scope move with it (scope renames).
 */
export function writeAlias(kind: PlantIdKind, scope: string, from: string, to: string, by: string): number {
  const at = nowIso();
  let n = db().run('DELETE FROM plant_id_aliases WHERE kind = ? AND scope = ? AND old_id = ?', kind, scope, to).changes;
  n += db().run('UPDATE plant_id_aliases SET new_id = ? WHERE kind = ? AND scope = ? AND new_id = ?', to, kind, scope, from).changes;
  db().run(
    `INSERT INTO plant_id_aliases (kind, scope, old_id, new_id, renamed_at, renamed_by) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (kind, scope, old_id) DO UPDATE SET new_id = excluded.new_id, renamed_at = excluded.renamed_at, renamed_by = excluded.renamed_by`,
    kind,
    scope,
    from,
    to,
    at,
    by,
  );
  return n;
}

/**
 * 0.16: an entry moved to another scope (a device or data path to another asset): its old ids lead to it there, where
 * the new scope has them free (no entry and no alias of its own); the others are dropped – an id of the old asset says
 * nothing on another. Its id in the old scope becomes free (no alias across scopes). Returns how many moved or went.
 */
export function moveAliases(kind: PlantIdKind, scope: string, from: string, toScope: string, to: string): number {
  let n = 0;
  // an alias of the new scope that named the new id is no old id any more
  n += db().run('DELETE FROM plant_id_aliases WHERE kind = ? AND scope = ? AND old_id = ?', kind, toScope, to).changes;
  for (const a of db().all<AliasRow>('SELECT * FROM plant_id_aliases WHERE kind = ? AND scope = ? AND new_id = ?', kind, scope, from)) {
    const free =
      a.old_id !== to &&
      !entryOf(kind, toScope, a.old_id) &&
      !one('SELECT 1 AS x FROM plant_id_aliases WHERE kind = ? AND scope = ? AND old_id = ?', kind, toScope, a.old_id);
    n += free
      ? db().run('UPDATE plant_id_aliases SET scope = ?, new_id = ? WHERE kind = ? AND scope = ? AND old_id = ?', toScope, to, kind, scope, a.old_id).changes
      : db().run('DELETE FROM plant_id_aliases WHERE kind = ? AND scope = ? AND old_id = ?', kind, scope, a.old_id).changes;
  }
  return n;
}

/** Removes aliases whose entry is gone: their old ids are free again. Returns how many. */
export function pruneAliases(): number {
  let n = 0;
  for (const a of db().all<AliasRow>('SELECT * FROM plant_id_aliases'))
    if (!entryOf(a.kind, a.scope, a.new_id))
      n += db().run('DELETE FROM plant_id_aliases WHERE kind = ? AND scope = ? AND old_id = ?', a.kind, a.scope, a.old_id).changes;
  return n;
}

/** GET /api/plant/aliases: the old ids of entries the reader may see (administrators manage them). */
export function listAliases(): PlantIdAlias[] {
  requirePlant();
  const rights = allSiteRights();
  return db()
    .all<AliasRow>('SELECT * FROM plant_id_aliases ORDER BY kind, scope, old_id')
    .flatMap((a) => {
      const e = entryOf(a.kind, a.scope, a.new_id);
      if (!e || !entryPermissions(e, rights).includes('view')) return [];
      return [
        {
          kind: a.kind,
          scope: a.scope,
          oldId: a.old_id,
          newId: a.new_id,
          renamedAt: a.renamed_at,
          renamedBy: a.renamed_by,
          path: entryPath(a.kind, a.scope, a.new_id),
        },
      ];
    });
}

/** DELETE /api/plant/aliases: the old id stops leading to its entry and is free for a new one (administrators). */
export function removeAlias(kind: PlantIdKind, scope: string, oldId: string): void {
  requirePlant();
  const a = one<AliasRow>('SELECT * FROM plant_id_aliases WHERE kind = ? AND scope = ? AND old_id = ?', kind, scope, oldId);
  if (!a) throw new HttpError(404, `There is no old id ${oldId}`, 'PLANT_ALIAS_NOT_FOUND', { id: oldId });
  db().tx(() => {
    db().run('DELETE FROM plant_id_aliases WHERE kind = ? AND scope = ? AND old_id = ?', kind, scope, oldId);
    audit({
      action: 'plant.id_alias_removed',
      entityType: kind,
      entityId: scope ? `${scope}/${a.new_id}` : a.new_id,
      summary: `Old id "${oldId}" of ${kind} "${a.new_id}" removed – it no longer leads there and is free for a new entry`,
      details: { kind, scope, oldId, newId: a.new_id, renamedAt: a.renamed_at, renamedBy: a.renamed_by, by: me().username },
    });
  });
}

// ---------- old ids in requests ----------

/** Route parameters that hold plant ids: their kind and the parameter that holds their scope. */
const PARAMS: Record<string, { kind: PlantIdKind; scope?: string }> = {
  siteId: { kind: 'site' },
  assetId: { kind: 'asset' },
  profileId: { kind: 'profile' },
  kpiId: { kind: 'kpi' },
  pointId: { kind: 'data_point', scope: 'profileId' },
  nodeId: { kind: 'node', scope: 'siteId' },
  buildingId: { kind: 'building', scope: 'siteId' },
  vlanId: { kind: 'vlan', scope: 'siteId' },
  zoneId: { kind: 'zone', scope: 'siteId' },
  conduitId: { kind: 'conduit', scope: 'siteId' },
  deviceId: { kind: 'device', scope: 'assetId' },
  pathId: { kind: 'data_path', scope: 'assetId' },
};
/** Query keys of reads that name an entry (export, lists). */
const QUERY: Record<string, PlantIdKind> = { site: 'site', asset: 'asset', profile: 'profile', kpi: 'kpi' };

/**
 * The ids of a read as the entries have them now: an old id (alias) is read as the entry it leads to (0.11.0). Global
 * kinds first, then the kinds in their scope. Writes never follow aliases: they name the entry by its id.
 */
export function currentParams(params: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = { ...params };
  for (const pass of [false, true])
    for (const [k, def] of Object.entries(PARAMS)) {
      if (!out[k] || !!def.scope !== pass) continue;
      out[k] = currentId(def.kind, def.scope ? (out[def.scope] ?? '') : '', out[k]);
    }
  return out;
}

export function currentQuery<Q extends Record<string, unknown>>(q: Q): Q {
  const out: Record<string, unknown> = { ...q };
  for (const [k, kind] of Object.entries(QUERY)) if (typeof out[k] === 'string' && out[k]) out[k] = currentId(kind, '', out[k]);
  return out as Q;
}
