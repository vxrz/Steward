import type { z } from 'zod';
import YAML from 'yaml';
import {
  PLANT_COLLECTION_LIMITS as L,
  type PlantAssetCollections,
  type PlantAssignmentValues,
  type PlantCollectionBrief,
  type PlantCollectionFlow,
  type PlantCollectionSink,
  type PlantSinkDownstream,
  type PlantSinkTarget,
  type DashboardDefinition,
  type PlantCollectionPoint,
  type PlantCollectionValues,
  type PlantCollectionView,
  type PlantProtocol,
  type PlantResolvedProfile,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { me } from '../auth/access.js';
import { resolveTarget } from '../records/links.js';
import { HttpError, nowIso } from '../util.js';
import { canManageCatalogue, requireManage } from './access.js';
import { changedKeys, collectionLinks, removeCollectionLinks } from './model.js';
import { pruneSources } from './collections-sources.js';
import { visibleAsset } from './service.js';
import { visibleAssets } from './catalogue.js';
import { allAssignments, allProfiles, assignmentRowOf, assignmentValuesOf, resolvedProfile } from './data-model.js';
import { dataPathRows } from './network-model.js';
import { itemRef, pathsReadingFrom, refProblems } from './network.js';
import { dashboardVisible, datasetsOf } from '../dashboards/service.js';
import { isOrExtends } from './resolve.js';
import {
  assetPoints,
  collectionInput,
  collectionProblems,
  collectionRowOf,
  collectionRows,
  collectionUpdate,
  collectionValuesOf,
  coverageOf,
  upsertCollection,
  withSinks,
  writes,
  type CollectionRow,
} from './collections-model.js';

/**
 * Data collections of an asset (0.11.0, docs/adr/0019-data-collections.md). They follow the asset's site like its
 * data paths: who sees the site sees them, who manages it changes them. Every change is audited on the asset
 * (plant.collection_created|updated|deleted; the import: plant.collection_imported).
 */

// ---------- reading ----------

export interface AssetContext {
  assignment: PlantAssignmentValues | null;
  profile: PlantResolvedProfile | null;
  points: ReturnType<typeof assetPoints>['points'];
  interfaces: ReturnType<typeof assetPoints>['interfaces'];
  protocolOf: (iface: string | null) => PlantProtocol | null;
}

/** An asset's model with its own addresses, as the collections read it. */
export function assetContext(assetId: string): AssetContext {
  const r = assignmentRowOf(assetId);
  const assignment = r ? assignmentValuesOf(r) : null;
  const profile = resolvedProfile(assignment?.profileId);
  const { points, interfaces } = assetPoints(assignment, profile);
  const protocols = new Map(interfaces.map((i) => [i.id, i.protocol]));
  return { assignment, profile, points, interfaces, protocolOf: (i) => (i ? (protocols.get(i) ?? null) : null) };
}

const briefPoint = (p: AssetContext['points'][number]): PlantCollectionPoint => ({
  id: p.id,
  name: p.name,
  interface: p.interface,
  address: p.address,
  dataType: p.dataType,
  unit: p.unit,
  added: p.added,
});

const destinationRef = (v: PlantCollectionValues) =>
  v.destination && (v.destination.kind === 'system' || v.destination.kind === 'dataset') ? itemRef(v.destination.kind, v.destination.ref) : null;

/** The Steward item a sink names (0.12): a system, platform, application or dataset; null for text and publications. */
export const sinkRef = (s: PlantCollectionValues['sinks'][number]) =>
  s.ref && (s.kind === 'system' || s.kind === 'dataset' || s.kind === 'platform' || s.kind === 'application') ? itemRef(s.kind, s.ref) : null;

function viewOf(r: CollectionRow, asset: { id: string; name: string; site_id: string }, ctx: AssetContext, readByAll: Set<string>): PlantCollectionView {
  const v = collectionValuesOf(r);
  const points = ctx.points.map(briefPoint);
  const byId = new Map(points.map((p) => [p.id, p]));
  return {
    ...v,
    assetId: asset.id,
    assetName: asset.name,
    siteId: asset.site_id,
    collectorRef: v.collector.kind === 'job' ? null : itemRef(v.collector.kind, v.collector.ref),
    collectorHost: v.collector.host ? itemRef('system', v.collector.host) : null,
    destinationRef: destinationRef(v),
    sinkRefs: v.sinks.map(sinkRef),
    points: v.items.map((it) => (it.dataPoint ? (byId.get(it.dataPoint) ?? null) : null)),
    coverage: coverageOf(v, points, readByAll, ctx.protocolOf),
    writes: writes(v),
    importId: r.import_id,
    notInSource: !!r.not_in_source,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

const readBy = (rows: CollectionRow[]) => new Set(rows.flatMap((r) => collectionValuesOf(r).items.flatMap((i) => (i.dataPoint ? [i.dataPoint] : []))));

export function assetCollections(assetId: string): PlantAssetCollections {
  const { row, perms } = visibleAsset(assetId);
  const ctx = assetContext(assetId);
  const rows = collectionRows(assetId);
  const all = readBy(rows);
  const collections = rows.map((r) => viewOf(r, row, ctx, all));
  const points = ctx.points.map(briefPoint);
  return {
    asset: { id: row.id, name: row.name, siteId: row.site_id },
    canManage: perms.includes('manage'),
    canManageCatalogue: canManageCatalogue(),
    collections,
    interfaces: ctx.interfaces.map((i) => ({ id: i.id, name: i.name, protocol: i.protocol, direction: i.direction })),
    points,
    totals: {
      mapped: collections.reduce((n, c) => n + c.coverage.mapped, 0),
      raw: collections.reduce((n, c) => n + c.coverage.raw, 0),
      notCollected: points.filter((p) => !all.has(p.id)).length,
    },
    dataPaths: dataPathRows(assetId).map((p) => ({ id: p.id, subject: p.subject })),
  };
}

export function collectionNotFound(id: string): HttpError {
  return new HttpError(404, `Data collection ${id} not found`, 'PLANT_COLLECTION_NOT_FOUND', { id });
}

export function getCollection(assetId: string, id: string): PlantCollectionView {
  const { row } = visibleAsset(assetId);
  const r = collectionRowOf(assetId, id);
  if (!r) throw collectionNotFound(id);
  return viewOf(r, row, assetContext(assetId), readBy(collectionRows(assetId)));
}

// ---------- writing ----------

function invalid(problems: { path: string; message: string }[]): void {
  if (!problems.length) return;
  const { path, message } = problems[0]!;
  throw new HttpError(400, `${path}: ${message}`, 'PLANT_COLLECTION_INVALID', { path, message });
}

/** The rules of a save: the asset's interfaces, data paths and data points, and the Steward items it names. */
export function checkCollection(assetId: string, v: PlantCollectionValues, before: PlantCollectionValues | null, ctx = assetContext(assetId)) {
  const refs = (x: PlantCollectionValues) => ({
    collector: x.collector,
    destinations: x.destination?.kind === 'system' ? [{ kind: 'system' as const, ref: x.destination.ref, path: x.destination.path, notes: '' }] : [],
  });
  return [
    ...collectionProblems(v, {
      interfaces: new Set(ctx.interfaces.map((i) => i.id)),
      dataPaths: new Set(dataPathRows(assetId).map((p) => p.id)),
      points: new Set(ctx.points.map((p) => p.id)),
    }),
    // the collector and a system destination must be visible to whoever names them anew
    ...refProblems(refs(v), before ? refs(before) : null).map((p) => ({ ...p, path: p.path.replace('destinations[0]', 'destination') })),
    // so must the Steward items the sinks name (0.12)
    ...v.sinks.flatMap((x, i) => {
      if (!x.ref || (x.kind !== 'system' && x.kind !== 'platform' && x.kind !== 'application')) return [];
      if (before?.sinks.some((b) => b.kind === x.kind && b.ref === x.ref)) return [];
      return resolveTarget(x.kind, x.ref) ? [] : [{ path: `sinks[${i}].ref`, message: `There is no ${x.kind} "${x.ref}"` }];
    }),
  ];
}

const nextPosition = (assetId: string) =>
  Number(db().get<{ n: number | null }>('SELECT MAX(position) AS n FROM plant_collections WHERE asset_id = ?', assetId)?.n ?? -1) + 1;

export function createCollection(assetId: string, input: z.infer<typeof collectionInput>): PlantCollectionView {
  const a = visibleAsset(assetId);
  requireManage(a.perms, 'change this asset');
  if (collectionRowOf(assetId, input.id)) throw new HttpError(409, `The asset has a data collection "${input.id}" already`, 'PLANT_ID_TAKEN', { id: input.id });
  if (collectionRows(assetId).length >= L.collectionsPerAsset)
    throw new HttpError(409, `At most ${L.collectionsPerAsset} data collections per asset`, 'PLANT_LIMIT', { max: L.collectionsPerAsset });
  const v: PlantCollectionValues = withSinks(input);
  invalid(checkCollection(assetId, v, null));
  db().tx(() => {
    upsertCollection(assetId, v, nextPosition(assetId), { at: nowIso(), by: me().username });
    audit({
      action: 'plant.collection_created',
      entityType: 'asset',
      entityId: assetId,
      summary: `Data collection "${v.name}" (${v.id}) added to asset "${a.row.name}" with ${v.items.length} items`,
      details: { collection: v.id, collector: v.collector, items: v.items.length, writes: writes(v) },
    });
  });
  return getCollection(assetId, v.id);
}

const pick = <T extends object>(o: T, keys: string[]) => Object.fromEntries(keys.map((k) => [k, (o as Record<string, unknown>)[k]]));

export function updateCollection(assetId: string, id: string, input: z.infer<typeof collectionUpdate>): PlantCollectionView {
  const a = visibleAsset(assetId);
  requireManage(a.perms, 'change this asset');
  const cur = collectionRowOf(assetId, id);
  if (!cur) throw collectionNotFound(id);
  const before = collectionValuesOf(cur);
  const v: PlantCollectionValues = withSinks({ id, ...input });
  invalid(checkCollection(assetId, v, before));
  // a sink that goes takes the links of records to it along (an edit is the person's choice; the audit counts them)
  const goneSinks = before.sinks.filter((x) => !v.sinks.some((y) => y.id === x.id)).map((x) => `${assetId}/${id}/${x.id}`);
  const changes = changedKeys(before, v);
  if (!changes.length) return getCollection(assetId, id);
  db().tx(() => {
    upsertCollection(assetId, v, cur.position, { at: nowIso(), by: me().username });
    const linksRemoved = goneSinks.reduce((n, sk) => n + db().run("DELETE FROM item_links WHERE to_kind = 'data-sink' AND to_id = ?", sk).changes, 0);
    audit({
      action: 'plant.collection_updated',
      entityType: 'asset',
      entityId: assetId,
      summary: `Data collection "${v.name}" (${id}) of asset "${a.row.name}" changed (${changes.join(', ')})`,
      details: {
        collection: id,
        changes,
        old: pick(
          before,
          changes.filter((c) => c !== 'items'),
        ),
        new: pick(
          v,
          changes.filter((c) => c !== 'items'),
        ),
        ...(linksRemoved ? { linksRemoved } : {}),
      },
    });
  });
  return getCollection(assetId, id);
}

/**
 * Removes a collection. Records that link to it (or to its sinks) refuse it, as with the removal core – unless
 * `cascade` ("also remove what belongs to it"): then the links go with it. The kept files of its imports go when no
 * other collection of theirs is left (0.12).
 */
export function deleteCollection(assetId: string, id: string, cascade = false): PlantAssetCollections {
  const a = visibleAsset(assetId);
  requireManage(a.perms, 'change this asset');
  const cur = collectionRowOf(assetId, id);
  if (!cur) throw collectionNotFound(id);
  const links = collectionLinks(assetId, id).length;
  if (links && !cascade)
    throw new HttpError(409, `${links} records link to the data collection – choose "also remove what belongs to it"`, 'PLANT_COLLECTION_LINKED', {
      count: links,
    });
  db().tx(() => {
    db().run('DELETE FROM plant_collections WHERE asset_id = ? AND id = ?', assetId, id);
    const linksRemoved = removeCollectionLinks(assetId, id);
    const sources = pruneSources(assetId);
    audit({
      action: 'plant.collection_deleted',
      entityType: 'asset',
      entityId: assetId,
      summary: `Data collection "${cur.name}" (${id}) removed from asset "${a.row.name}"${linksRemoved ? ` with ${linksRemoved} links of records to it` : ''}`,
      details: {
        collection: id,
        items: collectionValuesOf(cur).items.length,
        ...(linksRemoved ? { linksRemoved } : {}),
        ...(sources ? { sourcesRemoved: sources } : {}),
      },
    });
  });
  return assetCollections(assetId);
}

// ---------- the mapping as a file ----------

/** A collection's current mapping (gateway name and address → data point), as CSV or YAML – an import reads it back. */
export function mappingFile(assetId: string, id: string, format: 'csv' | 'yaml'): { filename: string; content: string; contentType: string } {
  const c = getCollection(assetId, id);
  const rows = c.items.map((it) => ({ gateway_name: it.outputName, address: it.address, data_point: it.dataPoint ?? '' }));
  const base = `${assetId}.${id}.mapping`;
  if (format === 'yaml') return { filename: `${base}.yaml`, content: YAML.stringify({ mapping: rows }), contentType: 'application/yaml; charset=utf-8' };
  const cell = (s: string) => (/[",;\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const content = ['gateway_name,address,data_point', ...rows.map((r) => [r.gateway_name, r.address, r.data_point].map(cell).join(','))].join('\n') + '\n';
  return { filename: `${base}.csv`, content, contentType: 'text/csv; charset=utf-8' };
}

// ---------- where the data goes: sinks, transformations, downstream (0.12) ----------

/** The item as a sink's mapping names it: its output name, else its address. */
const itemKey = (it: { outputName: string; address: string }) => it.outputName || it.address;

/**
 * Where a sink's data goes next, as far as Steward knows it: the data paths that read from its system, the dashboards
 * that show its dataset. What the reader may not see is counted, not named.
 */
function downstreamOf(s: PlantCollectionSink): PlantSinkDownstream {
  const out: PlantSinkDownstream = { paths: [], more: 0, hidden: 0, dashboards: [], hiddenDashboards: 0 };
  if (!s.ref) return out;
  if (s.kind === 'system' && resolveTarget('system', s.ref)) {
    const p = pathsReadingFrom(s.ref);
    out.paths = p.paths.map(({ assetId, assetName, pathId, subject }) => ({ assetId, assetName, pathId, subject }));
    out.more = p.more;
    out.hidden = p.hidden;
  }
  if (s.kind === 'dataset')
    for (const d of db().all<{ id: string; name: string; owner: string | null; definition: string }>(
      'SELECT id, name, owner, definition FROM dashboards ORDER BY name, id',
    )) {
      let def: DashboardDefinition | null;
      try {
        def = JSON.parse(d.definition) as DashboardDefinition;
      } catch {
        continue;
      }
      if (!def || !Array.isArray(def.widgets) || !datasetsOf(def).includes(s.ref)) continue;
      if (dashboardVisible(d)) out.dashboards.push({ id: d.id, name: d.name, path: `/dashboards/${d.id}` });
      else out.hiddenDashboards++;
    }
  return out;
}

/** GET …/collections/:collectionId/flow: items → transformations → sinks → downstream (documentation only). */
export function collectionFlow(assetId: string, id: string): PlantCollectionFlow {
  visibleAsset(assetId);
  const r = collectionRowOf(assetId, id);
  if (!r) throw collectionNotFound(id);
  const v = collectionValuesOf(r);
  const points = new Map(assetContext(assetId).points.map((p) => [p.id, p]));
  return {
    assetId,
    collectionId: id,
    items: v.items.map((it, index) => {
      const p = it.dataPoint ? points.get(it.dataPoint) : undefined;
      return {
        index,
        address: it.address,
        outputName: it.outputName,
        dataPoint: p ? { id: p.id, name: p.name } : null,
        sinks: v.sinks.map((sk) => {
          const m = sk.mappings.find((x) => x.item === itemKey(it));
          return { sink: sk.id, target: m?.target ?? '', transform: m?.transform ?? '' };
        }),
      };
    }),
    sinks: v.sinks.map((sk) => ({ ...sk, targetRef: sinkRef(sk), downstream: downstreamOf(sk) })),
  };
}

/** Where a data point goes through one collection: its sinks, with what the reader may see of their targets. */
function goesTo(v: PlantCollectionValues, pointId: string): PlantSinkTarget[] {
  const keys = new Set(v.items.filter((i) => i.dataPoint === pointId).map(itemKey));
  return v.sinks.map((sk) => {
    const ref = sinkRef(sk);
    return {
      sink: sk.id,
      name: sk.name,
      kind: sk.kind,
      label: ref ? ref.label : sk.ref,
      path: ref?.path ?? null,
      object: sk.object,
      target: sk.mappings.find((m) => keys.has(m.item))?.target ?? '',
    };
  });
}

// ---------- across assets: a collector's collections, a data point's readers ----------

const brief = (r: CollectionRow, asset: { id: string; name: string; site_id: string }): PlantCollectionBrief => {
  const v = collectionValuesOf(r);
  return {
    assetId: asset.id,
    assetName: asset.name,
    siteId: asset.site_id,
    id: v.id,
    name: v.name,
    collector: v.collector,
    collectorLabel: v.collector.kind === 'job' ? v.collector.ref : itemRef(v.collector.kind, v.collector.ref).label || v.collector.ref,
    mode: v.mode,
    intervalMs: v.intervalMs,
    items: v.items.length,
    writes: writes(v),
  };
};

/** The collections a collector runs, on assets the caller may see (the collector's page: an application, platform or process). */
export function collectorCollections(kind: string, ref: string): PlantCollectionBrief[] {
  const v = visibleAssets();
  return db()
    .all<CollectionRow>('SELECT * FROM plant_collections ORDER BY asset_id, position, id')
    .filter((r) => v.assets.has(r.asset_id))
    .filter((r) => {
      const c = collectionValuesOf(r).collector;
      return c.kind === kind && c.ref === ref;
    })
    .map((r) => brief(r, v.assets.get(r.asset_id)!));
}

/** The collections that read a data point of a profile (or of one that extends it), on assets the caller may see. */
export function pointCollections(profileId: string, pointId: string): PlantCollectionBrief[] {
  const v = visibleAssets();
  const profiles = allProfiles();
  const assignments = allAssignments();
  const out: PlantCollectionBrief[] = [];
  for (const r of db().all<CollectionRow>('SELECT * FROM plant_collections ORDER BY asset_id, position, id')) {
    const asset = v.assets.get(r.asset_id);
    const p = profiles.get(assignments.get(r.asset_id)?.profileId ?? '');
    if (!asset || !isOrExtends(p, profileId)) continue;
    const names = collectionValuesOf(r)
      .items.filter((i) => i.dataPoint === pointId)
      .map((i) => i.outputName || i.address);
    if (names.length) out.push({ ...brief(r, asset), outputNames: [...new Set(names)], goesTo: goesTo(collectionValuesOf(r), pointId) });
  }
  return out;
}

export { collectionInput, collectionUpdate };
