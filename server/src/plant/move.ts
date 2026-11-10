import {
  DEVICE_DUPLICATE_CLEARED,
  PLANT_COLLECTION_LIMITS,
  PLANT_ID_RE,
  PLANT_MOVE,
  PLANT_NETWORK_LIMITS as L,
  type PlantDeviceValues,
  type PlantMoveEntry,
  type PlantMoveInput,
  type PlantMovePreview,
  type PlantMovedKind,
  type PlantPermission,
  type PlantReferenceCount,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { me } from '../auth/access.js';
import { HttpError, nowIso, parseJson, sha256 } from '../util.js';
import { aliasTarget, allSiteRights, idFormatProblem } from './ids.js';
import { requirePlant } from './settings.js';
import { assetRowOf, type AssetRow } from './model.js';
import { dataPathRows, dataPathValuesOf, deviceInput, deviceValuesOf, vlanRows, type DeviceRow } from './network-model.js';
import { collectionRows, collectorKey } from './collections-model.js';
import { moveCollectionRefs, moveEntry } from './rename.js';
import type { Region } from './changesets/track.js';

/**
 * Moving devices and data collections to another asset (0.16, docs/PLANT.md "Moving devices and data collections").
 *
 * - **Devices** (one or several) go to the target asset with their id (`<asset>/<device>`) or, where the id is taken
 *   there, a new one the request names. Their **data paths** follow: a data path of the asset they leave that names
 *   only moving devices (as covered devices or transfer peers) moves too; one that also names a device that stays is a
 *   problem – move that device too, or change the data path first (nothing is cut in two on its own). The **data
 *   collections** of the moving data paths stay on their asset and lose the link to the data path (`leave`, the
 *   default: their items are mapped to that asset's model), or move with it (`move`).
 * - A **data collection** moves on its own (its collector was reassigned) with its items, sinks, Insights Hub check
 *   and monitor links; its data path stays and the link to it goes.
 *
 * What names a moved entry follows through the rename core's registry (rename.ts REFERENCES and
 * COLLECTION_REFERENCES): data paths' devices and peers, collections' data paths, maintenance windows, links of
 * records, the Insights Hub state, its history, baselines, open change set operations and old ids. A device that goes
 * to another site leaves its VLAN (and so its zones). Rights: manage on the sites the entries leave and on the target's
 * (under a proposer's preview, propose). Applying is one transaction, audited as `plant.moved`; the routes and the
 * change set's operation `move` make it a change set.
 */

export const moveNeedsStepUp = (b: Pick<PlantMoveInput, 'items'>): boolean => b.items.length > PLANT_MOVE.stepUp;

/** What a move reaches: the assets the entries leave and the target (their devices, data paths and collections). */
export const moveRegion = (b: Pick<PlantMoveInput, 'items' | 'toAsset'>): Region => ({ assets: [...new Set([...b.items.map((i) => i.asset), b.toAsset])] });

type Problem = PlantMovePreview['problems'][number];

interface Plan {
  result: Omit<PlantMovePreview, 'changes' | 'fingerprint' | 'stepUp' | 'references' | 'applied'>;
  apply: () => PlantReferenceCount[];
}

const notFound = (kind: string, id: string) => new HttpError(404, `There is no ${kind} "${id}"`, 'PLANT_ENTRY_NOT_FOUND', { kind, id });
const forbidden = (id: string) => new HttpError(403, `You may not change asset "${id}"`, 'FORBIDDEN', { context: 'managePlant' });

const TABLE: Record<PlantMovedKind, string> = { device: 'plant_devices', data_path: 'plant_data_paths', collection: 'plant_collections' };
const KIND_TEXT: Record<PlantMovedKind, string> = { device: 'device', data_path: 'data path', collection: 'data collection' };
const exists = (kind: PlantMovedKind, asset: string, id: string) => !!db().get(`SELECT 1 AS x FROM ${TABLE[kind]} WHERE asset_id = ? AND id = ?`, asset, id);
const countOf = (kind: PlantMovedKind, asset: string) =>
  Number(db().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${TABLE[kind]} WHERE asset_id = ?`, asset)?.n ?? 0);
const nextPosition = (kind: PlantMovedKind, asset: string) =>
  Number(db().get<{ n: number | null }>(`SELECT MAX(position) AS n FROM ${TABLE[kind]} WHERE asset_id = ?`, asset)?.n ?? -1) + 1;

/** The asset an entry is on, with the rights of the reader – 404 when they may not see it, 403 when they may not change it. */
function manageable(id: string, rights: Map<string, PlantPermission[]>, cache: Map<string, AssetRow>): AssetRow {
  const hit = cache.get(id);
  if (hit) return hit;
  const row = assetRowOf(id);
  const perms = row ? (rights.get(row.site_id) ?? []) : [];
  if (!row || !perms.includes('view')) throw notFound('asset', id);
  if (!perms.includes('manage')) throw forbidden(id);
  cache.set(id, row);
  return row;
}

/** The devices a data path names: those it covers and its transfers' device peers. */
function pathDevices(v: ReturnType<typeof dataPathValuesOf>): Set<string> {
  return new Set([...v.devices, ...v.transfers.filter((t) => t.peerKind === 'device').map((t) => t.peer)]);
}

function plan(input: PlantMoveInput): Plan {
  requirePlant();
  const by = me().username;
  const rights = allSiteRights();
  const assets = new Map<string, AssetRow>();
  const target = manageable(input.toAsset, rights, assets);
  const problems: Problem[] = [];
  const seen = new Set<string>();
  const items = input.items.filter((i) => {
    const k = `${i.asset}\u0000${i.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const newIdOf = (kind: PlantMovedKind, asset: string, id: string) => input.ids.find((x) => x.kind === kind && x.asset === asset && x.id === id)?.newId ?? id;
  const entries: PlantMoveEntry[] = [];
  const unlinked: PlantMovePreview['unlinked'] = [];
  const entry = (kind: PlantMovedKind, asset: string, id: string, name: string, why: PlantMoveEntry['why'], extra: Partial<PlantMoveEntry> = {}) =>
    entries.push({
      kind,
      asset,
      id,
      name,
      newId: newIdOf(kind, asset, id),
      why,
      taken: false,
      suggested: null,
      leavesVlan: null,
      leavesDataPath: null,
      ...extra,
    });
  let crossSite = false;
  for (const i of items) {
    const from = manageable(i.asset, rights, assets);
    if (from.id === target.id) {
      problems.push({
        code: 'PLANT_MOVE_SAME_ASSET',
        message: `${KIND_TEXT[input.kind]} "${i.id}" is on asset "${target.name}" already`,
        asset: i.asset,
        id: i.id,
      });
      continue;
    }
    if (from.site_id !== target.site_id) crossSite = true;
    if (input.kind === 'device') {
      const d = db().get<DeviceRow>('SELECT * FROM plant_devices WHERE asset_id = ? AND id = ?', i.asset, i.id);
      if (!d) throw notFound('device', i.id);
      entry('device', i.asset, i.id, d.hostname || d.id, 'chosen', { leavesVlan: from.site_id !== target.site_id && d.vlan_id ? d.vlan_id : null });
    } else {
      const c = db().get<{ name: string; data_path_id: string | null }>(
        'SELECT name, data_path_id FROM plant_collections WHERE asset_id = ? AND id = ?',
        i.asset,
        i.id,
      );
      if (!c) throw notFound('data collection', i.id);
      entry('collection', i.asset, i.id, c.name, 'chosen', { leavesDataPath: c.data_path_id });
    }
  }
  // the data paths of the moving devices, and their collections
  if (input.kind === 'device') {
    const byAsset = new Map<string, Set<string>>();
    for (const e of entries) byAsset.set(e.asset, (byAsset.get(e.asset) ?? new Set()).add(e.id));
    for (const [asset, moving] of byAsset) {
      const paths: string[] = [];
      for (const p of dataPathRows(asset)) {
        const names = pathDevices(dataPathValuesOf(p));
        if (![...names].some((d) => moving.has(d))) continue;
        const stay = [...names].filter((d) => !moving.has(d));
        if (stay.length) {
          problems.push({
            code: 'PLANT_MOVE_PATH_SPLIT',
            message: `Data path "${p.subject}" (${p.id}) also names ${stay.map((d) => `"${d}"`).join(', ')}, which stay${stay.length === 1 ? 's' : ''} – move ${stay.length === 1 ? 'it' : 'them'} too, or change the data path first`,
            kind: 'data_path',
            asset,
            id: p.id,
          });
          continue;
        }
        entry('data_path', asset, p.id, p.subject || p.id, 'follows');
        paths.push(p.id);
      }
      for (const c of collectionRows(asset)) {
        if (!c.data_path_id || !paths.includes(c.data_path_id)) continue;
        if (input.collections === 'move') entry('collection', asset, c.id, c.name, 'follows');
        else unlinked.push({ asset, id: c.id, name: c.name, dataPath: c.data_path_id });
      }
    }
  }
  // the ids under the target asset: free there (no entry, no old id of another) and not given twice
  const claimed = new Set<string>();
  const free = (kind: PlantMovedKind, id: string) =>
    !exists(kind, target.id, id) && !(kind !== 'collection' && aliasTarget(kind, target.id, id)) && !claimed.has(`${kind}\u0000${id}`);
  for (const e of entries) {
    const format = e.kind === 'collection' ? (PLANT_ID_RE.test(e.newId) ? null : idFormatProblem('device', e.newId)) : idFormatProblem(e.kind, e.newId);
    if (format) problems.push({ code: 'PLANT_ID_FORMAT', message: `${e.newId}: ${format}`, kind: e.kind, asset: e.asset, id: e.id });
    else if (!free(e.kind, e.newId)) {
      e.taken = true;
      problems.push({
        code: 'PLANT_ID_TAKEN',
        message: `Asset "${target.name}" has a ${KIND_TEXT[e.kind]} "${e.newId}" already – give ${e.kind === 'device' ? 'the device' : `${KIND_TEXT[e.kind]} "${e.id}"`} a new id`,
        kind: e.kind,
        asset: e.asset,
        id: e.id,
      });
    }
    claimed.add(`${e.kind}\u0000${e.newId}`);
  }
  for (const e of entries.filter((x) => x.taken)) {
    const base = e.newId.replace(/-\d+$/, '').slice(0, 74);
    for (let n = 2; n < 100 && !e.suggested; n++) if (free(e.kind, `${base}-${n}`)) e.suggested = `${base}-${n}`;
  }
  // the target's limits
  const limits: Record<PlantMovedKind, number> = {
    device: L.devicesPerAsset,
    data_path: L.pathsPerAsset,
    collection: PLANT_COLLECTION_LIMITS.collectionsPerAsset,
  };
  for (const kind of ['device', 'data_path', 'collection'] as const) {
    const adding = entries.filter((e) => e.kind === kind).length;
    if (adding && countOf(kind, target.id) + adding > limits[kind])
      problems.push({ code: 'PLANT_LIMIT', message: `At most ${limits[kind]} ${KIND_TEXT[kind]}s per asset`, kind });
  }
  const result = {
    kind: input.kind,
    toAsset: { id: target.id, name: target.name, siteId: target.site_id },
    crossSite,
    entries,
    unlinked,
    problems,
    ok: problems.length === 0 && entries.length > 0,
  };
  const apply = (): PlantReferenceCount[] => {
    const at = nowIso();
    const counts = new Map<string, number>();
    const add = (list: PlantReferenceCount[]) => list.forEach((x) => counts.set(x.what, (counts.get(x.what) ?? 0) + x.count));
    const stamp = (kind: PlantMovedKind, id: string, extra = '', ...params: unknown[]) =>
      db().run(
        `UPDATE ${TABLE[kind]} SET position = ?, updated_at = ?, updated_by = ?${extra} WHERE asset_id = ? AND id = ?`,
        nextPosition(kind, target.id),
        at,
        by,
        ...params,
        target.id,
        id,
      );
    // collections that stay lose the link to their data path first (they are no longer named when it moves)
    for (const c of unlinked)
      db().run('UPDATE plant_collections SET data_path_id = NULL, updated_at = ?, updated_by = ? WHERE asset_id = ? AND id = ?', at, by, c.asset, c.id);
    for (const kind of ['device', 'data_path'] as const)
      for (const e of entries.filter((x) => x.kind === kind)) {
        add(moveEntry({ kind, scope: e.asset, from: e.id, to: e.newId, toScope: target.id }));
        // a device on another site leaves its VLAN (a VLAN is the site's)
        if (e.leavesVlan) stamp(kind, e.newId, ', vlan_id = NULL');
        else stamp(kind, e.newId);
      }
    const movedCollections = new Map<string, Map<string, string>>();
    for (const e of entries.filter((x) => x.kind === 'collection')) {
      const row = db().get<{ collector: string }>('SELECT collector FROM plant_collections WHERE asset_id = ? AND id = ?', e.asset, e.id);
      add(moveCollectionRefs({ asset: e.asset, id: e.id, toAsset: target.id, toId: e.newId }));
      // on its own its data path stays behind; with it, the data path moved already (and is named by its new id)
      if (e.why === 'chosen' && e.leavesDataPath) stamp('collection', e.newId, ', data_path_id = NULL');
      else stamp('collection', e.newId);
      movedCollections.set(e.asset, (movedCollections.get(e.asset) ?? new Map()).set(e.id, e.newId));
      // the gateway names remembered for its collector on the asset are remembered on the target too
      const key = row ? collectorKey(parseJson(row.collector, { kind: 'job', ref: '', host: null })) : null;
      if (key)
        db().run(
          `INSERT INTO plant_collection_mappings (collector_key, asset_id, gateway_name, data_point, created_at, created_by)
           SELECT collector_key, ?, gateway_name, data_point, ?, ? FROM plant_collection_mappings WHERE collector_key = ? AND asset_id = ?
           ON CONFLICT (collector_key, asset_id, gateway_name) DO NOTHING`,
          target.id,
          at,
          by,
          key,
          e.asset,
        );
    }
    // the kept files of collection imports go along when every collection they wrote goes (else they stay)
    for (const [asset, moved] of movedCollections)
      for (const s of db().all<{ id: string; collector_key: string; collections: string }>(
        'SELECT id, collector_key, collections FROM plant_collection_sources WHERE asset_id = ?',
        asset,
      )) {
        const list = parseJson<string[]>(s.collections, []);
        if (!list.length || !list.every((c) => moved.has(c))) continue;
        const version =
          Number(
            db().get<{ n: number | null }>(
              'SELECT MAX(version) AS n FROM plant_collection_sources WHERE asset_id = ? AND collector_key = ?',
              target.id,
              s.collector_key,
            )?.n ?? 0,
          ) + 1;
        db().run(
          'UPDATE plant_collection_sources SET asset_id = ?, version = ?, collections = ? WHERE id = ?',
          target.id,
          version,
          JSON.stringify(list.map((c) => moved.get(c)!)),
          s.id,
        );
        counts.set('collection_source', (counts.get('collection_source') ?? 0) + 1);
      }
    db().run('UPDATE plant_assets SET updated_at = ?, updated_by = ? WHERE id = ?', at, by, target.id);
    const references = [...counts].map(([what, count]) => ({ what, count })).sort((a, b) => a.what.localeCompare(b.what));
    const list = entries.map((e) => ({ kind: e.kind, from: `${e.asset}/${e.id}`, to: `${target.id}/${e.newId}` }));
    const n = entries.filter((e) => e.why === 'chosen').length;
    const followed = entries.length - n;
    audit({
      action: 'plant.moved',
      entityType: 'asset',
      entityId: target.id,
      summary: `${n} ${KIND_TEXT[input.kind]}${n === 1 ? '' : 's'} moved to asset "${target.name}"${followed ? ` with ${followed} data paths and collections` : ''}${
        unlinked.length ? `; ${unlinked.length} data collections stay and lose their data path` : ''
      }${crossSite ? ' (from another site: devices leave their VLAN)' : ''}`,
      details: {
        kind: input.kind,
        toAsset: target.id,
        crossSite,
        collections: input.collections,
        count: entries.length,
        sha256: sha256(JSON.stringify(list)),
        entries: list.slice(0, 150),
        unlinked: unlinked.slice(0, 50).map((c) => `${c.asset}/${c.id}`),
        references,
      },
    });
    return references;
  };
  return { result, apply };
}

/** The preview of a move without writing anything (the route adds what applying writes, field by field). */
export function previewMove(input: PlantMoveInput): Plan['result'] & { stepUp: boolean } {
  return { ...plan(input).result, stepUp: moveNeedsStepUp(input) };
}

/** Applies a move (inside the caller's transaction or its own); refused with the first problem. */
export function applyMove(input: PlantMoveInput): Omit<PlantMovePreview, 'changes' | 'fingerprint'> {
  return db().tx(() => {
    const p = plan(input);
    const first = p.result.problems[0];
    if (first)
      throw new HttpError(first.code === 'PLANT_ID_FORMAT' ? 400 : 409, first.message, first.code, { kind: first.kind ?? input.kind, id: first.id ?? '' });
    if (!p.result.entries.length) throw new HttpError(409, 'Nothing to move', 'PLANT_MOVE_NOTHING');
    const references = p.apply();
    return { ...p.result, references, stepUp: moveNeedsStepUp(input), applied: true };
  });
}

// ---------- duplicating a device ----------

/**
 * The body of a duplicate of a device (0.16): its fields, on this asset or another – not what identifies the original
 * (DEVICE_DUPLICATE_CLEARED: host name, address, MAC, serial number, its port and outlet) and not what watches it (its
 * checks, its monitoring). Its VLAN stays on the same site and is left empty on another. Who sees the device may copy
 * it; adding it to the target needs the target's rights (the device route's rules).
 */
export function duplicateDeviceBody(assetId: string, deviceId: string, toAsset: string, id: string): ReturnType<typeof deviceInput.parse> {
  requirePlant();
  const rights = allSiteRights();
  const from = assetRowOf(assetId);
  if (!from || !rights.get(from.site_id)?.includes('view')) throw notFound('asset', assetId);
  const row = db().get<DeviceRow>('SELECT * FROM plant_devices WHERE asset_id = ? AND id = ?', assetId, deviceId);
  if (!row) throw notFound('device', deviceId);
  const to = assetRowOf(toAsset);
  if (!to || !rights.get(to.site_id)?.includes('view')) throw notFound('asset', toAsset);
  const v: PlantDeviceValues = deviceValuesOf(row);
  const copy: Record<string, unknown> = { ...v, id };
  for (const k of DEVICE_DUPLICATE_CLEARED) copy[k] = k === 'checks' ? [] : '';
  const sameSite = from.site_id === to.site_id && vlanRows(to.site_id).some((x) => x.id === v.vlan);
  copy.vlan = sameSite ? v.vlan : null;
  // its address type stays (how the copy gets an address of its own)
  return deviceInput.parse(copy);
}
