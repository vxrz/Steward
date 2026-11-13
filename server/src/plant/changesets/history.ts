import { presentEntryValues, seesEntry } from '../catalogue-access.js';
import type { PlantChangeSetSource, PlantEntryHistory, PlantEntryHistoryItem, PlantEntryKind, PlantMoveInput, PlantMovedKind } from '@sm/shared';
import { PLANT_CHANGESET_LIMITS, PLANT_ENTRY_SCOPE } from '@sm/shared';
import { db } from '../../db.js';
import { audit } from '../../audit.js';
import type { AuthUser } from '../../auth/context.js';
import { HttpError } from '../../util.js';
import { plantProposesSome, siteRights } from '../access.js';
import { requirePlant } from '../settings.js';
import { fieldDiff } from '../diff.js';
import { CATALOGUE_KINDS, KINDS, PER_ASSET, assetSites, bodyOf, entryKey, readEntry } from './entries.js';
import { insertChangeSet, insertOp, rowOf, type NewOp } from './core.js';
import { checkOpenLimits, siteOfTarget } from './drafts.js';
import { historyValues } from './values.js';

/**
 * The history of an entry (0.13.0, ADR 0020): one row per applied change set that touched it, with the full values of
 * its changed fields before and after. Undo never rewrites it: Revert writes a new draft with the inverse operations
 * (set back, remove what was added, rename back; 0.16: move back; 0.19: add a removed entry again from the snapshot
 * its removal kept), based on now – later edits conflict instead of being overwritten.
 */

interface HistoryRow {
  id: string;
  kind: PlantEntryKind;
  scope: string;
  entry_id: string;
  revision: number;
  change_set_id: string;
  op: 'add' | 'set' | 'remove' | 'rename' | 'move';
  at: string;
  author: string;
  applied_by: string;
  before_values: string;
  after_values: string;
  title: string | null;
  source: PlantChangeSetSource | null;
  import_id: string | null;
}

/** Whether `u` sees the entry (or saw it: the site of a removed one) – 404 otherwise. */
function checkVisible(kind: PlantEntryKind, scope: string, id: string, u: AuthUser): void {
  requirePlant();
  const now = readEntry(kind, scope, id);
  const site = now
    ? now.siteId
    : CATALOGUE_KINDS.includes(kind)
      ? ''
      : PLANT_ENTRY_SCOPE[kind] === 'site'
        ? scope
        : (siteOfTarget(kind, scope, id, null) ?? null);
  const rights = siteRights(db().all<{ id: string; acl: string }>('SELECT id, acl FROM plant_sites'), u);
  const sees =
    site === '' ? [...rights.values()].some((p) => p.includes('view')) || plantProposesSome(u) : site !== null && !!rights.get(site)?.includes('view');
  if (!sees) throw new HttpError(404, `There is no ${kind} "${id}"`, 'PLANT_ENTRY_NOT_FOUND', { kind, id });
  // 0.21.0 (#293): a device profile or KPI definition the reader may not see has no history for them
  if (CATALOGUE_KINDS.includes(kind) && !seesEntry(u, kind === 'profile' ? 'device_profile' : 'kpi_definition', id))
    throw new HttpError(404, `There is no ${kind} "${id}"`, 'PLANT_ENTRY_NOT_FOUND', { kind, id });
}

const valuesOf = (stored: string) => historyValues<Record<string, unknown> | null>(stored, null) ?? {};
/** The diff as the reader may see it: hidden profiles and KPI definitions by their placeholders (0.21.0). */
const shownDiff = (r: Pick<HistoryRow, 'op' | 'before_values' | 'after_values' | 'kind' | 'entry_id'>) =>
  fieldDiff(presentEntryValues(r.kind, r.entry_id, valuesOf(r.before_values)), presentEntryValues(r.kind, r.entry_id, valuesOf(r.after_values)));

const ROWS = `SELECT h.*, c.title AS title, c.source AS source, c.import_id AS import_id
  FROM plant_entry_history h LEFT JOIN plant_change_sets c ON c.id = h.change_set_id`;

/**
 * The history of an entry, newest first; `children`: with what belongs to it – a site's hierarchy, buildings and OT
 * network, an asset's assignment, linked checks, devices, data paths and data collections.
 */
export function entryHistory(kind: PlantEntryKind, scope: string, id: string, u: AuthUser, children = false): PlantEntryHistory {
  const sc = PLANT_ENTRY_SCOPE[kind] === 'none' ? '' : scope;
  checkVisible(kind, sc, id, u);
  const where = ['(h.kind = ? AND h.scope = ? AND h.entry_id = ?)'];
  const params: unknown[] = [kind, sc, id];
  if (children && kind === 'site') {
    where.push("(h.kind IN ('node', 'building', 'vlan', 'zone', 'conduit') AND h.scope = ?)");
    params.push(id);
  }
  if (children && kind === 'asset') {
    where.push("(h.kind IN ('assignment', 'asset_checks') AND h.entry_id = ?)", "(h.kind IN ('device', 'data_path', 'collection') AND h.scope = ?)");
    params.push(id, id);
  }
  const rows = db().all<HistoryRow>(
    `${ROWS} WHERE ${where.join(' OR ')} ORDER BY h.at DESC, h.revision DESC, h.kind, h.scope, h.entry_id, h.id LIMIT ${PLANT_CHANGESET_LIMITS.historyPage}`,
    ...params,
  );
  const revert = plantProposesSome(u);
  const items: PlantEntryHistoryItem[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    scope: r.scope,
    entryId: r.entry_id,
    revision: Number(r.revision),
    op: r.op,
    at: r.at,
    by: r.author,
    appliedBy: r.applied_by,
    changeSet: r.title !== null ? { id: r.change_set_id, title: r.title, source: r.source!, importId: r.import_id } : null,
    diff: shownDiff(r),
    // 0.19.0: a removal is reverted by adding the entry again – while it is not there (a site is added again by hand)
    canRevert:
      revert &&
      (r.op === 'remove' ? r.kind !== 'site' && !readEntry(r.kind, r.scope, r.entry_id) : !(r.op === 'set' && !Object.keys(valuesOf(r.before_values)).length)),
  }));
  // before 0.13 the audit log has it (searched by the id; old ids are aliases)
  return { items, auditPath: `/audit?q=${encodeURIComponent(id)}` };
}

/**
 * 0.16: moves back – per kind, the asset the entries are on and the one they came from, one `move` (first: what it
 * brings back is where the other operations find it). Devices bring their data paths back again and, with
 * `collections: move`, the data collections of those paths that moved with them; a collection that moved on its own
 * goes back on its own. Ids they got on the way are given back.
 */
function moveBack(rows: HistoryRow[]): NewOp[] {
  const moved = rows
    .map((r) => ({ r, before: valuesOf(r.before_values) }))
    .filter(
      (x): x is { r: HistoryRow; before: Record<string, unknown> & { asset: string } } =>
        typeof x.before.asset === 'string' && !!readEntry(x.r.kind, x.r.scope, x.r.entry_id),
    );
  const idBack = (x: (typeof moved)[number]) =>
    typeof x.before.id === 'string' && x.before.id !== x.r.entry_id
      ? [{ kind: x.r.kind as PlantMovedKind, asset: x.r.scope, id: x.r.entry_id, newId: x.before.id }]
      : [];
  const ops: NewOp[] = [];
  const op = (input: PlantMoveInput, name: string): NewOp => ({
    op: 'move',
    kind: null,
    scope: '',
    id: '',
    name,
    origin: 'derived',
    baseRevision: null,
    base: null,
    value: input,
  });
  const pairs = new Map<string, (typeof moved)[number][]>();
  for (const x of moved) pairs.set(`${x.r.scope}\u0000${x.before.asset}`, [...(pairs.get(`${x.r.scope}\u0000${x.before.asset}`) ?? []), x]);
  for (const list of pairs.values()) {
    const { before } = list[0]!;
    const devices = list.filter((x) => x.r.kind === 'device');
    const paths = new Set(list.filter((x) => x.r.kind === 'data_path').map((x) => x.r.entry_id));
    // a collection of a data path that goes back goes with it; others on their own
    const withPath = list.filter(
      (x) => x.r.kind === 'collection' && devices.length && paths.has(String(readEntry('collection', x.r.scope, x.r.entry_id)?.values.dataPathId ?? '')),
    );
    const alone = list.filter((x) => x.r.kind === 'collection' && !withPath.includes(x));
    if (devices.length)
      ops.push(
        op(
          {
            kind: 'device',
            items: devices.map((x) => ({ asset: x.r.scope, id: x.r.entry_id })),
            toAsset: before.asset,
            collections: withPath.length ? 'move' : 'leave',
            ids: list.filter((x) => x.r.kind !== 'collection' || withPath.includes(x)).flatMap(idBack),
          },
          `move ${devices.length} device back to ${before.asset}`,
        ),
      );
    if (alone.length)
      ops.push(
        op(
          {
            kind: 'collection',
            items: alone.map((x) => ({ asset: x.r.scope, id: x.r.entry_id })),
            toAsset: before.asset,
            collections: 'leave',
            ids: alone.flatMap(idBack),
          },
          `move ${alone.length} collection back to ${before.asset}`,
        ),
      );
  }
  return ops;
}

/** The order removed entries are added again in: what others name first (a node's parent, an asset's parent asset). */
const RESTORE_ORDER: Record<string, number> = {
  building: 1,
  node: 2,
  profile: 3,
  kpi: 4,
  vlan: 5,
  zone: 6,
  conduit: 7,
  asset: 8,
  assignment: 9,
  asset_checks: 10,
  device: 11,
  data_path: 12,
  collection: 13,
};
const LEVELS = ['area', 'work_center', 'work_unit'];

/**
 * 0.19.0: removed entries added again from the snapshot their removal kept (ADR 0020 section 4) – while they are not
 * there: with the body of their edit form's POST, in an order that lets each find what it names (buildings, the
 * hierarchy level by level, the catalogue, assets parents first, then what belongs to an asset). A removed site is not
 * added again: its access list and owning teams are not in the history (add it by hand, then revert to restore what it
 * held). A snapshot the form's rules no longer take is skipped.
 */
function restores(rows: HistoryRow[]): { ops: NewOp[]; skipped: number } {
  let skipped = 0;
  const list: { r: HistoryRow; before: Record<string, unknown>; body: Record<string, unknown> }[] = [];
  for (const r of rows) {
    const create = KINDS[r.kind].create;
    if (r.kind === 'site' || !create || readEntry(r.kind, r.scope, r.entry_id)) {
      skipped++;
      continue;
    }
    const before = valuesOf(r.before_values);
    const shape = (create as unknown as { shape?: Record<string, unknown> }).shape ?? {};
    const picked: Record<string, unknown> = Object.fromEntries(Object.keys(shape).flatMap((k) => (k in before ? [[k, before[k]]] : [])));
    if (!PER_ASSET.includes(r.kind)) picked.id = r.entry_id;
    const parsed = create.safeParse(picked);
    if (!parsed.success) {
      skipped++;
      continue;
    }
    list.push({ r, before, body: parsed.data as Record<string, unknown> });
  }
  // assets after their parent asset (when it comes back too)
  const parentOf = new Map(
    list.filter((x) => x.r.kind === 'asset').map((x) => [x.r.entry_id, typeof x.before.parentId === 'string' ? x.before.parentId : null] as const),
  );
  const depth = (id: string, seen = new Set<string>()): number => {
    const p = parentOf.get(id);
    if (!p || !parentOf.has(p) || seen.has(p)) return 0;
    seen.add(p);
    return 1 + depth(p, seen);
  };
  const rank = (x: (typeof list)[number]) =>
    (RESTORE_ORDER[x.r.kind] ?? 20) * 1000 +
    (x.r.kind === 'node' ? Math.max(0, LEVELS.indexOf(String(x.before.level))) * 100 : 0) +
    (x.r.kind === 'asset' ? Math.min(depth(x.r.entry_id), 99) : 0);
  const key = (x: (typeof list)[number]) => entryKey({ kind: x.r.kind, scope: x.r.scope, id: x.r.entry_id });
  list.sort((a, b) => rank(a) - rank(b) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return {
    ops: list.map(({ r, before, body }) => ({
      op: 'add',
      kind: r.kind,
      scope: r.scope,
      id: r.entry_id,
      name: String(before.name ?? before.hostname ?? before.subject ?? r.entry_id),
      origin: 'authored',
      baseRevision: null,
      base: null,
      value: body,
    })),
    skipped,
  };
}

/** The inverse operations of history rows, against the entries now (0.19.0: removed entries are added again). */
function inverse(rows: HistoryRow[]): { ops: NewOp[]; skipped: number } {
  const ops: NewOp[] = [];
  const restored = restores(rows.filter((r) => r.op === 'remove'));
  let skipped = restored.skipped;
  const order = { set: 0, add: 1, rename: 2, move: 2, remove: 3 } as const;
  for (const r of [...rows].sort((a, b) => order[a.op] - order[b.op] || (a.at < b.at ? 1 : -1))) {
    const before = valuesOf(r.before_values);
    const after = valuesOf(r.after_values);
    if (r.op === 'remove') continue;
    const now = readEntry(r.kind, r.scope, r.entry_id);
    if (!now) {
      skipped++;
      continue;
    }
    if (r.op === 'move') {
      // moved back first (moveBack); fields that changed with the move (a VLAN left) are set back where it is then
      const fields = Object.keys(before).filter((k) => k !== 'id' && k !== 'asset');
      if (fields.length && typeof before.asset === 'string')
        ops.push({
          op: 'set',
          kind: r.kind,
          scope: before.asset,
          id: typeof before.id === 'string' ? before.id : r.entry_id,
          name: now.name,
          origin: 'authored',
          baseRevision: Number(r.revision),
          base: bodyOf(r.kind, { ...now.values, ...Object.fromEntries(fields.map((k) => [k, after[k]])) }),
          value: bodyOf(r.kind, { ...now.values, ...Object.fromEntries(fields.map((k) => [k, before[k]])) }),
        });
      continue;
    }
    if (r.op === 'add') {
      ops.push({
        op: 'remove',
        kind: r.kind,
        scope: r.scope,
        id: r.entry_id,
        name: now.name,
        origin: 'authored',
        baseRevision: now.revision,
        base: null,
        value: { cascade: false },
      });
      continue;
    }
    const fields = Object.keys(before).filter((k) => k !== 'id');
    if (fields.length) {
      // base: what the change set wrote; mine: what was there before – a field changed since conflicts
      const base = bodyOf(r.kind, { ...now.values, ...Object.fromEntries(fields.map((k) => [k, after[k]])) });
      const mine = bodyOf(r.kind, { ...now.values, ...Object.fromEntries(fields.map((k) => [k, before[k]])) });
      ops.push({
        op: 'set',
        kind: r.kind,
        scope: r.scope,
        id: r.entry_id,
        name: now.name,
        origin: 'authored',
        baseRevision: Number(r.revision),
        base,
        value: mine,
      });
    }
    if (r.op === 'rename' && typeof before.id === 'string' && before.id !== r.entry_id)
      ops.push({
        op: 'rename',
        kind: r.kind,
        scope: r.scope,
        id: r.entry_id,
        name: now.name,
        origin: 'authored',
        baseRevision: now.revision,
        base: null,
        value: { newId: before.id },
      });
  }
  // what comes back first: the other operations (a reference set back) may name it
  return { ops: [...restored.ops, ...moveBack(rows.filter((r) => r.op === 'move')), ...ops], skipped };
}

/** Revert: a new draft (the person's current one) with the inverse of a change set, or of one history row. */
export function revert(o: { changeSetId?: string; historyId?: string }, u: AuthUser): { id: string; skipped: number } {
  requirePlant();
  if (!plantProposesSome(u)) throw new HttpError(403, 'You may not propose changes to the plant registry', 'FORBIDDEN', { context: 'proposePlant' });
  const rows = o.historyId
    ? db().all<HistoryRow>(`${ROWS} WHERE h.id = ?`, o.historyId)
    : db().all<HistoryRow>(`${ROWS} WHERE h.change_set_id = ? ORDER BY h.at, h.revision, h.kind, h.scope, h.entry_id, h.id`, o.changeSetId);
  if (!rows.length) throw new HttpError(404, 'Nothing to revert', 'PLANT_CHANGESET_NOT_FOUND', { id: o.changeSetId ?? o.historyId ?? '' });
  // only what the person may see
  const rights = siteRights(db().all<{ id: string; acl: string }>('SELECT id, acl FROM plant_sites'), u);
  const assets = assetSites(rows.map((r) => (PLANT_ENTRY_SCOPE[r.kind] === 'asset' ? r.scope : r.entry_id)));
  // 0.19.0: removed assets are found through the site their snapshot names (what they held follows them)
  const removedAssets = new Map(
    rows.filter((r) => r.op === 'remove' && r.kind === 'asset').map((r) => [r.entry_id, String(valuesOf(r.before_values).siteId ?? '')] as const),
  );
  const visible = rows.filter((r) => {
    if (CATALOGUE_KINDS.includes(r.kind)) return true;
    const asset = PLANT_ENTRY_SCOPE[r.kind] === 'asset' ? r.scope : r.entry_id;
    const site =
      r.kind === 'site'
        ? r.entry_id
        : PLANT_ENTRY_SCOPE[r.kind] === 'site'
          ? r.scope
          : (assets.get(asset) ?? (r.op === 'remove' ? removedAssets.get(asset) : undefined));
    // a removed entry comes back only where the person sees its site now (fail closed: its site unknown or gone)
    if (r.op === 'remove') return !!site && !!rights.get(site)?.includes('view');
    return !site || !!rights.get(site)?.includes('view');
  });
  const csId = rows[0]!.change_set_id;
  const original = rowOf(csId);
  if (!original || original.state !== 'applied')
    throw new HttpError(409, 'Only an applied change set is reverted', 'PLANT_CHANGESET_NOT_APPLIED', { id: csId });
  const { ops, skipped } = inverse(visible);
  if (!ops.length) throw new HttpError(409, 'Nothing of it can be reverted now', 'PLANT_CHANGESET_NOTHING', { id: csId });
  checkOpenLimits(u);
  const title = `Revert "${original.title}"`;
  return db().tx(() => {
    const id = insertChangeSet({ state: 'draft', source: 'revert', title, by: u.username, current: true, reverts: csId });
    for (const op of ops) insertOp(id, op, u.username);
    audit({
      action: 'plant.change_set_created',
      entityType: 'plant_change_set',
      entityId: id,
      summary: `Plant change set "${title}" started (a draft that reverts ${csId})`,
      details: { source: 'revert', reverts: csId, historyId: o.historyId ?? null, operations: ops.length, skipped },
    });
    return { id, skipped };
  });
}
