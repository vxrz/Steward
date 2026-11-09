import type { PlantChangeSetSource, PlantEntryHistory, PlantEntryHistoryItem, PlantEntryKind } from '@sm/shared';
import { PLANT_CHANGESET_LIMITS, PLANT_ENTRY_SCOPE } from '@sm/shared';
import { db } from '../../db.js';
import { audit } from '../../audit.js';
import type { AuthUser } from '../../auth/context.js';
import { HttpError, parseJson } from '../../util.js';
import { plantProposesSome, siteRights } from '../access.js';
import { requirePlant } from '../settings.js';
import { fieldDiff } from '../diff.js';
import { CATALOGUE_KINDS, assetSites, bodyOf, readEntry } from './entries.js';
import { insertChangeSet, insertOp, rowOf, type NewOp } from './core.js';
import { checkOpenLimits, siteOfTarget } from './drafts.js';

/**
 * The history of an entry (0.13.0, ADR 0020): one row per applied change set that touched it, with the full values of
 * its changed fields before and after. Undo never rewrites it: Revert writes a new draft with the inverse operations
 * (set back, remove what was added, rename back), based on now – later edits conflict instead of being overwritten.
 */

interface HistoryRow {
  id: string;
  kind: PlantEntryKind;
  scope: string;
  entry_id: string;
  revision: number;
  change_set_id: string;
  op: 'add' | 'set' | 'remove' | 'rename';
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
}

const diffOf = (r: Pick<HistoryRow, 'op' | 'before_values' | 'after_values'>) => {
  const before = parseJson<Record<string, unknown> | null>(r.before_values, null) ?? {};
  const after = parseJson<Record<string, unknown> | null>(r.after_values, null) ?? {};
  return fieldDiff(before, after);
};

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
    `${ROWS} WHERE ${where.join(' OR ')} ORDER BY h.at DESC, h.revision DESC LIMIT ${PLANT_CHANGESET_LIMITS.historyPage}`,
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
    diff: diffOf(r),
    canRevert: revert && r.op !== 'remove' && !(r.op === 'set' && r.before_values === '{}'),
  }));
  // before 0.13 the audit log has it (searched by the id; old ids are aliases)
  return { items, auditPath: `/audit?q=${encodeURIComponent(id)}` };
}

/** The inverse operations of history rows, against the entries now (removals are restored in phase 2). */
function inverse(rows: HistoryRow[]): { ops: NewOp[]; skipped: number } {
  const ops: NewOp[] = [];
  let skipped = 0;
  const order = { set: 0, add: 1, rename: 2, remove: 3 } as const;
  for (const r of [...rows].sort((a, b) => order[a.op] - order[b.op] || (a.at < b.at ? 1 : -1))) {
    const before = parseJson<Record<string, unknown> | null>(r.before_values, null) ?? {};
    const after = parseJson<Record<string, unknown> | null>(r.after_values, null) ?? {};
    const now = readEntry(r.kind, r.scope, r.entry_id);
    if (r.op === 'remove' || !now) {
      skipped++;
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
  return { ops, skipped };
}

/** Revert: a new draft (the person's current one) with the inverse of a change set, or of one history row. */
export function revert(o: { changeSetId?: string; historyId?: string }, u: AuthUser): { id: string; skipped: number } {
  requirePlant();
  if (!plantProposesSome(u)) throw new HttpError(403, 'You may not propose changes to the plant registry', 'FORBIDDEN', { context: 'proposePlant' });
  const rows = o.historyId
    ? db().all<HistoryRow>(`${ROWS} WHERE h.id = ?`, o.historyId)
    : db().all<HistoryRow>(`${ROWS} WHERE h.change_set_id = ? ORDER BY h.at, h.revision`, o.changeSetId);
  if (!rows.length) throw new HttpError(404, 'Nothing to revert', 'PLANT_CHANGESET_NOT_FOUND', { id: o.changeSetId ?? o.historyId ?? '' });
  // only what the person may see
  const rights = siteRights(db().all<{ id: string; acl: string }>('SELECT id, acl FROM plant_sites'), u);
  const assets = assetSites(rows.map((r) => (PLANT_ENTRY_SCOPE[r.kind] === 'asset' ? r.scope : r.entry_id)));
  const visible = rows.filter((r) => {
    if (CATALOGUE_KINDS.includes(r.kind)) return true;
    const site =
      r.kind === 'site'
        ? r.entry_id
        : PLANT_ENTRY_SCOPE[r.kind] === 'site'
          ? r.scope
          : assets.get(PLANT_ENTRY_SCOPE[r.kind] === 'asset' ? r.scope : r.entry_id);
    return !site || !!rights.get(site)?.includes('view');
  });
  const csId = rows[0]!.change_set_id;
  const original = rowOf(csId);
  if (!original || original.state !== 'applied')
    throw new HttpError(409, 'Only an applied change set is reverted', 'PLANT_CHANGESET_NOT_APPLIED', { id: csId });
  const { ops, skipped } = inverse(visible);
  if (!ops.length)
    throw new HttpError(409, 'Nothing of it can be reverted now (removed entries are restored in a later version)', 'PLANT_CHANGESET_NOTHING', { id: csId });
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
