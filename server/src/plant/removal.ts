import type { PlantPermission, PlantReferenceCount, PlantRemovableKind, PlantRemovalItem, PlantRemovalPlan } from '@sm/shared';
import { db } from '../db.js';
import { parseJson } from '../util.js';
import { allAssignments, removeKpiRow, removeProfileRow, upsertAssignment } from './data-model.js';
import { allSiteRights, entryOf, entryPermissions, pruneAliases, type Entry } from './ids.js';
import { removeAssetRow, removeSiteRows } from './model.js';

/**
 * The removal core of the plant registry (0.11.0, docs/PLANT.md#changing-many-entries-at-once): what goes with an
 * entry, what refuses its removal, and the removal itself – used by "Remove selected" in the lists and by the import
 * (`remove:` and "Remove entries that are not in the files").
 *
 * - **What belongs to an entry** goes with it, but only when the person asks for it ("also remove what belongs to it"):
 *   a site's hierarchy, buildings, assets and OT network; an asset's parts (the assets that are part of it), its
 *   assignment and KPI instances, devices, data paths, linked checks and links; a node's nodes below it and the assets
 *   in them; a building's floors and rooms; a zone's conduits; the KPI instances of a KPI definition; the links of
 *   records to it. Without it, an entry that has any of these is refused and the preview says what it has.
 * - **References from other entries** always refuse a removal – a node or asset in a building, an assignment of a
 *   device profile, a zone or device naming a VLAN, a data path naming a device – unless those entries go too.
 * - External references, owning teams and the image are details of the entry: they go with it and never refuse it.
 * - Aliases that lead to a removed entry are removed: its id and its old ids are free again.
 */

export interface Target {
  kind: PlantRemovableKind;
  scope: string;
  id: string;
}

const key = (t: Target) => `${t.kind}|${t.scope}|${t.id}`;
const all = <R>(sql: string, ...p: unknown[]) => db().all<R>(sql, ...p);
const n = (sql: string, ...p: unknown[]) => Number(db().get<{ n: number }>(sql, ...p)?.n ?? 0);

/** What belongs to an entry: entries (that go with it) and details (counted only). */
interface Belongings {
  entries: Target[];
  /** Links, assignments, KPI instances, linked checks … that go with it and refuse it without "also remove" */
  parts: PlantReferenceCount[];
  /** Details that go with it and never refuse it (external references, owning teams, the image) */
  details: PlantReferenceCount[];
}

const DETAILS = new Set(['external_ref', 'owning_team', 'image']);
const part = (what: string, count: number): PlantReferenceCount[] => (count ? [{ what, count }] : []);

function belongings(t: Target): Belongings {
  const s = t.scope;
  switch (t.kind) {
    case 'site':
      return {
        entries: [
          ...all<{ id: string }>('SELECT id FROM plant_nodes WHERE site_id = ? AND parent_id IS NULL', t.id).map((r) => ({
            kind: 'node' as const,
            scope: t.id,
            id: r.id,
          })),
          ...all<{ id: string }>('SELECT id FROM plant_buildings WHERE site_id = ? AND parent_id IS NULL', t.id).map((r) => ({
            kind: 'building' as const,
            scope: t.id,
            id: r.id,
          })),
          ...all<{ id: string }>('SELECT id FROM plant_assets WHERE site_id = ?', t.id).map((r) => ({ kind: 'asset' as const, scope: '', id: r.id })),
          ...all<{ id: string }>('SELECT id FROM plant_conduits WHERE site_id = ?', t.id).map((r) => ({ kind: 'conduit' as const, scope: t.id, id: r.id })),
          ...all<{ id: string }>('SELECT id FROM plant_zones WHERE site_id = ?', t.id).map((r) => ({ kind: 'zone' as const, scope: t.id, id: r.id })),
          ...all<{ id: string }>('SELECT id FROM plant_vlans WHERE site_id = ?', t.id).map((r) => ({ kind: 'vlan' as const, scope: t.id, id: r.id })),
        ],
        parts: [
          ...part('link', n("SELECT COUNT(*) AS n FROM item_links WHERE (from_kind = 'site' AND from_id = ?) OR (to_kind = 'site' AND to_id = ?)", t.id, t.id)),
        ],
        details: [
          ...part('external_ref', n("SELECT COUNT(*) AS n FROM plant_refs WHERE kind = 'site' AND item_id = ?", t.id)),
          ...part('owning_team', n("SELECT COUNT(*) AS n FROM resource_teams WHERE kind = 'site' AND resource_id = ?", t.id)),
        ],
      };
    case 'asset': {
      const a = allAssignments().get(t.id);
      return {
        entries: [
          ...all<{ id: string }>('SELECT id FROM plant_assets WHERE parent_id = ?', t.id).map((r) => ({ kind: 'asset' as const, scope: '', id: r.id })),
          ...all<{ id: string }>('SELECT id FROM plant_data_paths WHERE asset_id = ?', t.id).map((r) => ({
            kind: 'data_path' as const,
            scope: t.id,
            id: r.id,
          })),
          ...all<{ id: string }>('SELECT id FROM plant_devices WHERE asset_id = ?', t.id).map((r) => ({ kind: 'device' as const, scope: t.id, id: r.id })),
        ],
        parts: [
          ...part('assignment', a ? 1 : 0),
          ...part('kpi_instance', a?.kpis.length ?? 0),
          ...part(
            'asset_checks',
            parseJson<unknown[]>(db().get<{ checks: string }>('SELECT checks FROM plant_asset_checks WHERE asset_id = ?', t.id)?.checks ?? '[]', []).length,
          ),
          ...part(
            'link',
            n("SELECT COUNT(*) AS n FROM item_links WHERE (from_kind = 'asset' AND from_id = ?) OR (to_kind = 'asset' AND to_id = ?)", t.id, t.id),
          ),
        ],
        details: [
          ...part('external_ref', n("SELECT COUNT(*) AS n FROM plant_refs WHERE kind = 'asset' AND item_id = ?", t.id)),
          ...part('image', n('SELECT COUNT(*) AS n FROM plant_asset_images WHERE asset_id = ?', t.id)),
        ],
      };
    }
    case 'node':
      return {
        entries: [
          ...all<{ id: string }>('SELECT id FROM plant_nodes WHERE site_id = ? AND parent_id = ?', s, t.id).map((r) => ({
            kind: 'node' as const,
            scope: s,
            id: r.id,
          })),
          ...all<{ id: string }>(
            'SELECT id FROM plant_assets WHERE site_id = ? AND (area_id = ? OR work_center_id = ? OR work_unit_id = ?)',
            s,
            t.id,
            t.id,
            t.id,
          ).map((r) => ({ kind: 'asset' as const, scope: '', id: r.id })),
        ],
        parts: [],
        details: [],
      };
    case 'building':
      return {
        entries: all<{ id: string }>('SELECT id FROM plant_buildings WHERE site_id = ? AND parent_id = ?', s, t.id).map((r) => ({
          kind: 'building' as const,
          scope: s,
          id: r.id,
        })),
        parts: [],
        details: [],
      };
    case 'zone':
      return {
        entries: all<{ id: string }>('SELECT id FROM plant_conduits WHERE site_id = ? AND (zone_a = ? OR zone_b = ?)', s, t.id, t.id).map((r) => ({
          kind: 'conduit' as const,
          scope: s,
          id: r.id,
        })),
        parts: [],
        details: [],
      };
    case 'conduit':
      return {
        entries: [],
        parts: part('link', n("SELECT COUNT(*) AS n FROM item_links WHERE to_kind = 'conduit' AND to_id = ?", `${s}/${t.id}`)),
        details: [],
      };
    case 'kpi':
      return {
        entries: [],
        parts: part(
          'kpi_instance',
          [...allAssignments().values()].reduce((c, a) => c + a.kpis.filter((k) => k.kpi === t.id).length, 0),
        ),
        details: [],
      };
    case 'profile':
    case 'vlan':
    case 'device':
    case 'data_path':
      return { entries: [], parts: [], details: [] };
  }
}

/** References from other entries: they refuse the removal unless they go too (keys of the entries that name it). */
function referrers(t: Target): { what: string; keys: string[] }[] {
  const s = t.scope;
  const keys = (kind: PlantRemovableKind, scope: (r: Record<string, string>) => string, rows: Record<string, string>[]) =>
    rows.map((r) => key({ kind, scope: scope(r), id: r.id! }));
  switch (t.kind) {
    case 'building':
      return [
        { what: 'node', keys: keys('node', () => s, all('SELECT id FROM plant_nodes WHERE site_id = ? AND building_id = ?', s, t.id)) },
        { what: 'asset', keys: keys('asset', () => '', all('SELECT id FROM plant_assets WHERE site_id = ? AND building_id = ?', s, t.id)) },
      ];
    case 'profile':
      return [{ what: 'assignment', keys: keys('asset', () => '', all('SELECT asset_id AS id FROM plant_assignments WHERE profile_id = ?', t.id)) }];
    case 'vlan':
      return [
        {
          what: 'zone',
          keys: keys(
            'zone',
            () => s,
            all<{ id: string; vlans: string }>('SELECT id, vlans FROM plant_zones WHERE site_id = ?', s).filter((z) =>
              parseJson<string[]>(z.vlans, []).includes(t.id),
            ),
          ),
        },
        {
          what: 'device',
          keys: keys(
            'device',
            (r) => r.asset_id!,
            all('SELECT d.asset_id, d.id FROM plant_devices d JOIN plant_assets a ON a.id = d.asset_id WHERE a.site_id = ? AND d.vlan_id = ?', s, t.id),
          ),
        },
      ];
    case 'device':
      return [
        {
          what: 'data_path',
          keys: keys(
            'data_path',
            () => s,
            all<{ id: string; devices: string; transfers: string }>('SELECT id, devices, transfers FROM plant_data_paths WHERE asset_id = ?', s).filter(
              (p) =>
                parseJson<string[]>(p.devices, []).includes(t.id) ||
                parseJson<{ peerKind: string; peer: string }[]>(p.transfers, []).some((x) => x.peerKind === 'device' && x.peer === t.id),
            ),
          ),
        },
      ];
    default:
      return [];
  }
}

const sum = (lists: PlantReferenceCount[][]): PlantReferenceCount[] => {
  const m = new Map<string, number>();
  for (const l of lists) for (const x of l) m.set(x.what, (m.get(x.what) ?? 0) + x.count);
  return [...m].map(([what, count]) => ({ what, count })).sort((a, b) => a.what.localeCompare(b.what));
};

export interface PlannedRemoval {
  plan: PlantRemovalPlan;
  /** Every entry that goes (the chosen ones and, with cascade, what belongs to them), in a safe order */
  entries: Target[];
  /** Removes them (inside a transaction) */
  apply(): void;
}

/**
 * What removing these entries does. Entries the caller may not see read as missing, entries they may not change are
 * refused (FORBIDDEN), and so is everything that belongs to one when they may not change that.
 */
export function planRemoval(targets: Target[], opts: { cascade: boolean; rights?: Map<string, PlantPermission[]> }): PlannedRemoval {
  const rights = opts.rights ?? allSiteRights();
  const items = new Map<
    string,
    { t: Target; entry: Entry | null; closure: Map<string, Target>; with: PlantReferenceCount[]; refused: PlantRemovalItem['refused'] }
  >();
  for (const t of targets) {
    if (items.has(key(t))) continue;
    const entry = entryOf(t.kind, t.scope, t.id);
    const perms = entry ? entryPermissions(entry, rights) : [];
    if (!entry || !perms.includes('view')) {
      items.set(key(t), {
        t,
        entry: null,
        closure: new Map(),
        with: [],
        refused: { code: 'PLANT_ENTRY_NOT_FOUND', message: `There is no ${t.kind} "${t.id}"` },
      });
      continue;
    }
    if (!perms.includes('manage')) {
      items.set(key(t), { t, entry, closure: new Map(), with: [], refused: { code: 'FORBIDDEN', message: `You may not remove ${t.kind} "${t.id}"` } });
      continue;
    }
    // what belongs to it, all the way down
    const closure = new Map<string, Target>([[key(t), t]]);
    const counts: PlantReferenceCount[][] = [];
    const queue: Target[] = [t];
    let forbidden = false;
    while (queue.length) {
      const x = queue.shift()!;
      const b = belongings(x);
      counts.push(b.parts, b.details);
      for (const e of b.entries) {
        if (closure.has(key(e))) continue;
        closure.set(key(e), e);
        counts.push([{ what: e.kind, count: 1 }]);
        queue.push(e);
      }
      if (x.kind === 'kpi' && b.parts.length) {
        // its instances are on assets of sites the caller may have to change
        for (const [assetId, a] of allAssignments())
          if (a.kpis.some((k) => k.kpi === x.id)) {
            const ae = entryOf('asset', '', assetId);
            if (!ae || !entryPermissions(ae, rights).includes('manage')) forbidden = true;
          }
      }
    }
    const blocking = sum(counts.map((c) => c.filter((x) => !DETAILS.has(x.what))));
    const withIt = sum(counts);
    const refused: PlantRemovalItem['refused'] = forbidden
      ? { code: 'FORBIDDEN', message: `${t.kind} "${t.id}" has KPI instances on assets you may not change` }
      : !opts.cascade && blocking.length
        ? {
            code: 'PLANT_REMOVE_HAS_ENTRIES',
            message: `${t.kind} "${t.id}" still has ${blocking.map((x) => `${x.count} ${x.what}`).join(', ')} – choose "also remove what belongs to it"`,
          }
        : null;
    items.set(key(t), { t, entry, closure: refused ? new Map() : closure, with: withIt, refused });
  }
  // references from entries that stay refuse a removal; refusing one can make another refused: until nothing changes
  for (let round = 0; round < 10; round++) {
    const going = new Map<string, Target>();
    for (const i of items.values()) for (const [k, e] of i.closure) going.set(k, e);
    let changed = false;
    for (const i of items.values()) {
      if (i.refused) continue;
      for (const e of i.closure.values()) {
        const stays = referrers(e).flatMap((r) => r.keys.filter((k) => !going.has(k)).map(() => r.what));
        if (stays.length) {
          const what = sum([stays.map((w) => ({ what: w, count: 1 }))]);
          i.refused = {
            code: 'PLANT_REMOVE_REFERENCED',
            message: `${e.kind} "${e.id}" is named by ${what.map((x) => `${x.count} ${x.what}`).join(', ')} that stay`,
          };
          i.closure = new Map();
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }
  const going = new Map<string, Target>();
  for (const i of items.values()) for (const [k, e] of i.closure) going.set(k, e);
  const ORDER: PlantRemovableKind[] = ['data_path', 'device', 'asset', 'conduit', 'zone', 'vlan', 'node', 'building', 'site', 'kpi', 'profile'];
  const entries = ORDER.flatMap((k) => [...going.values()].filter((e) => e.kind === k));
  const list: PlantRemovalItem[] = [...items.values()].map((i) => ({
    kind: i.t.kind,
    scope: i.t.scope,
    id: i.t.id,
    name: i.entry?.name ?? i.t.id,
    with: i.with,
    refused: i.refused,
  }));
  return {
    plan: { items: list, counts: sum([entries.map((e) => ({ what: e.kind, count: 1 }))]) },
    entries,
    apply: () => removeEntries(entries),
  };
}

/** Removes entries and what belongs to them alone (call it inside a transaction, in the order planRemoval gives). */
export function removeEntries(entries: Target[]): void {
  const ids = new Set(entries.map((e) => key(e)));
  for (const e of entries) {
    const s = e.scope;
    switch (e.kind) {
      case 'data_path':
        db().run('DELETE FROM plant_data_paths WHERE asset_id = ? AND id = ?', s, e.id);
        break;
      case 'device':
        db().run('DELETE FROM plant_devices WHERE asset_id = ? AND id = ?', s, e.id);
        break;
      case 'asset':
        db().run("DELETE FROM item_links WHERE to_kind = 'asset' AND to_id = ?", e.id);
        removeAssetRow(e.id);
        break;
      case 'conduit':
        db().run("DELETE FROM item_links WHERE to_kind = 'conduit' AND to_id = ?", `${s}/${e.id}`);
        db().run('DELETE FROM plant_conduits WHERE site_id = ? AND id = ?', s, e.id);
        break;
      case 'zone':
        db().run('DELETE FROM plant_zones WHERE site_id = ? AND id = ?', s, e.id);
        break;
      case 'vlan':
        db().run('DELETE FROM plant_vlans WHERE site_id = ? AND id = ?', s, e.id);
        break;
      case 'node':
        db().run('DELETE FROM plant_nodes WHERE site_id = ? AND id = ?', s, e.id);
        break;
      case 'building':
        db().run('DELETE FROM plant_buildings WHERE site_id = ? AND id = ?', s, e.id);
        break;
      case 'site':
        db().run("DELETE FROM item_links WHERE to_kind = 'site' AND to_id = ?", e.id);
        // other sites' VLANs that reach it no longer name it
        for (const v of all<{ site_id: string; id: string; sites: string }>(
          "SELECT site_id, id, sites FROM plant_vlans WHERE sites LIKE ? ESCAPE '\\'",
          `%${e.id}%`,
        )) {
          const list = parseJson<string[]>(v.sites, []);
          if (list.includes(e.id))
            db().run('UPDATE plant_vlans SET sites = ? WHERE site_id = ? AND id = ?', JSON.stringify(list.filter((x) => x !== e.id)), v.site_id, v.id);
        }
        removeSiteRows(e.id);
        break;
      case 'kpi':
        // its instances go with it (planRemoval refuses them without "also remove")
        for (const [assetId, a] of allAssignments())
          if (a.kpis.some((k) => k.kpi === e.id) && !ids.has(key({ kind: 'asset', scope: '', id: assetId }))) {
            const row = db().get<{ import_id: string | null; not_in_source: number; updated_at: string; updated_by: string }>(
              'SELECT import_id, not_in_source, updated_at, updated_by FROM plant_assignments WHERE asset_id = ?',
              assetId,
            )!;
            upsertAssignment(
              assetId,
              { ...a, kpis: a.kpis.filter((k) => k.kpi !== e.id) },
              { importId: row.import_id, notInSource: !!row.not_in_source, at: row.updated_at, by: row.updated_by },
              { keepSource: true },
            );
          }
        removeKpiRow(e.id);
        break;
      case 'profile':
        removeProfileRow(e.id);
        break;
    }
  }
  pruneAliases();
}
