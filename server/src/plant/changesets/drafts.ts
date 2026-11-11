import {
  PLANT_CHANGESET_LIMITS,
  PLANT_ENTRY_SCOPE,
  mergeThreeWay,
  plantBulkInput,
  plantMoveInput,
  type PlantChangeOperationInput,
  type PlantEntryChanged,
  type PlantEntryKind,
  type PlantPermission,
} from '@sm/shared';
import { db } from '../../db.js';
import { audit } from '../../audit.js';
import type { AuthUser } from '../../auth/context.js';
import { me } from '../../auth/access.js';
import { HttpError, nowIso } from '../../util.js';
import { canCreateSites, plantProposesSome, siteRights } from '../access.js';
import { requirePlant } from '../settings.js';
import { importInput } from '../import.js';
import { collectionsOperationInput } from '../collections-import.js';
import { CATALOGUE_KINDS, KINDS, PER_ASSET, assetSites, bodyOf, readEntry, type EntrySnap } from './entries.js';
import { insertChangeSet, insertOp, isAuthor, opsOf, rowOf, touch, type CsRow, type NewOp } from './core.js';
import { historyValues } from './values.js';

/**
 * Drafts (0.13.0, ADR 0020): a person's change set they build with the edit forms – where review is required, or where
 * they may propose but not manage – and propose when it is ready. One draft per person is their current one: edit forms
 * write into it. The operations remember what the person saw (the entry's revision and values), the base of the
 * three-way merge when someone else changes the entry meanwhile.
 */

/** The values of an entry at an earlier revision, from its history (null: the history does not reach back that far). */
export function valuesAt(now: EntrySnap, revision: number): Record<string, unknown> | null {
  if (revision === now.revision) return now.values;
  if (revision > now.revision) return null;
  const rows = db().all<{ revision: number; op: string; before_values: string }>(
    'SELECT revision, op, before_values FROM plant_entry_history WHERE kind = ? AND scope = ? AND entry_id = ? AND revision > ? ORDER BY revision DESC',
    now.kind,
    now.scope,
    now.id,
    revision,
  );
  let values = { ...now.values };
  let expect = now.revision;
  for (const r of rows) {
    if (Number(r.revision) !== expect) break;
    if (r.op === 'add') return null;
    values = { ...values, ...historyValues<Record<string, unknown>>(r.before_values, {}) };
    expect--;
  }
  return expect === revision ? values : null;
}

/** The site an entry (or a new one) belongs to; '' for the catalogue; null when unknown (a new site). */
export function siteOfTarget(kind: PlantEntryKind, scope: string, id: string, value: unknown): string | null {
  if (CATALOGUE_KINDS.includes(kind)) return '';
  if (kind === 'site') return id;
  if (PLANT_ENTRY_SCOPE[kind] === 'site') return scope;
  if (kind === 'asset') {
    const v = value as { siteId?: unknown } | null;
    if (v && typeof v.siteId === 'string') return v.siteId;
    return assetSites([id]).get(id) ?? null;
  }
  const asset = PER_ASSET.includes(kind) ? id : scope;
  return assetSites([asset]).get(asset) ?? null;
}

/** Whether `u` may propose this: the propose right on its site (catalogue: on some site; a new site: who may propose). */
export function mayPropose(u: AuthUser, site: string | null, rights?: Map<string, PlantPermission[]>): boolean {
  if (site === '' || site === null) return plantProposesSome(u) || canCreateSites(u);
  const r = rights ?? siteRights(db().all<{ id: string; acl: string }>('SELECT id, acl FROM plant_sites'), u);
  const p = r.get(site);
  return p ? p.includes('propose') : plantProposesSome(u);
}

const draftTitle = (u: AuthUser) => `Changes by ${u.username}`;

/** The person's current draft, if any (an open draft they wrote). */
export function currentDraftRow(u: AuthUser): CsRow | null {
  const r = db().get<CsRow>("SELECT * FROM plant_change_sets WHERE current_of = ? AND state = 'draft'", u.username);
  return r && isAuthor(r, u) ? r : null;
}

function openCount(u: AuthUser): { count: number; bytes: number } {
  const r = db().get<{ n: number; b: number | null }>(
    "SELECT COUNT(*) AS n, SUM(bytes) AS b FROM plant_change_sets WHERE created_by = ? AND state IN ('draft', 'proposed')",
    u.username,
  );
  return { count: Number(r?.n ?? 0), bytes: Number(r?.b ?? 0) };
}

/** Refuses one more open change set of `u` beyond the limits (the inbox of reviewers stays bounded). */
export function checkOpenLimits(u: AuthUser, adding = 1, bytes = 0): void {
  const o = openCount(u);
  if (o.count + adding > PLANT_CHANGESET_LIMITS.openPerUser)
    throw new HttpError(409, `At most ${PLANT_CHANGESET_LIMITS.openPerUser} open change sets per person`, 'PLANT_CHANGESET_LIMIT', {
      max: PLANT_CHANGESET_LIMITS.openPerUser,
    });
  if (o.bytes + bytes > PLANT_CHANGESET_LIMITS.bytesPerUser)
    throw new HttpError(413, 'Your open change sets are too large together – propose or withdraw some first', 'PLANT_CHANGESET_TOO_LARGE', {
      kb: PLANT_CHANGESET_LIMITS.bytesPerUser / 1024,
    });
}

/** The person's current draft, created when they have none. */
export function ensureDraft(u: AuthUser, title?: string): CsRow {
  const cur = currentDraftRow(u);
  if (cur) return cur;
  checkOpenLimits(u);
  const id = insertChangeSet({ state: 'draft', source: 'draft', title: title ?? draftTitle(u), by: u.username, current: true });
  audit({
    action: 'plant.change_set_created',
    entityType: 'plant_change_set',
    entityId: id,
    summary: `Plant change set "${title ?? draftTitle(u)}" started (draft)`,
    details: { source: 'draft' },
  });
  return rowOf(id)!;
}

/** An editable draft of `u` (404 for others' drafts, 409 when it is no longer a draft). */
export function editableDraft(id: string, u: AuthUser): CsRow {
  const r = rowOf(id);
  if (!r || !isAuthor(r, u)) throw new HttpError(404, `Change set ${id} not found`, 'PLANT_CHANGESET_NOT_FOUND', { id });
  if (r.state !== 'draft' || r.source === 'assistant') throw new HttpError(409, 'Only a draft is changed', 'PLANT_CHANGESET_NOT_DRAFT', { id });
  return r;
}

/** Parses a route body (zod), as a 400 with the path of what is wrong. */
const parse = (schema: { parse: (v: unknown) => unknown }, v: unknown): Record<string, unknown> => schema.parse(v) as Record<string, unknown>;

/** The operation an edit form's save becomes, checked: the entry, its body, the right to propose it, its base. */
export function operationOf(input: PlantChangeOperationInput, u: AuthUser): NewOp {
  requirePlant();
  const { op, kind } = input;
  const scope = PLANT_ENTRY_SCOPE[kind] === 'none' ? '' : input.scope;
  const id = input.id;
  const d = KINDS[kind];
  const value = input.value as Record<string, unknown> | null;
  if (op === 'add') {
    if (!d.create) throw new HttpError(400, `A ${kind} is added with its asset`, 'PLANT_CHANGESET_OPERATION');
    const body = parse(d.create, PER_ASSET.includes(kind) ? value : { ...(value ?? {}), id });
    const site = siteOfTarget(kind, scope, id, body);
    if (!mayPropose(u, site)) throw new HttpError(403, 'You may not propose changes here', 'FORBIDDEN', { context: 'proposePlant' });
    return {
      op,
      kind,
      scope,
      id,
      name: String(body.name ?? body.hostname ?? body.subject ?? id),
      origin: 'authored',
      baseRevision: null,
      base: null,
      value: body,
    };
  }
  const now = readEntry(kind, scope, id);
  const site = now ? now.siteId || (CATALOGUE_KINDS.includes(kind) ? '' : null) : null;
  // an entry the person may not see reads as missing
  const sees =
    now &&
    (site === '' ||
      !!siteRights(db().all<{ id: string; acl: string }>('SELECT id, acl FROM plant_sites'), u)
        .get(site ?? '')
        ?.includes('view'));
  if (!now || !sees) throw new HttpError(404, `There is no ${kind} "${id}"`, 'PLANT_ENTRY_NOT_FOUND', { kind, id });
  if (!mayPropose(u, site)) throw new HttpError(403, 'You may not propose changes here', 'FORBIDDEN', { context: 'proposePlant' });
  if (op === 'set') {
    const body = parse(d.update, value);
    if (body.siteId && body.siteId !== site && !mayPropose(u, String(body.siteId)))
      throw new HttpError(403, 'You may not propose changes here', 'FORBIDDEN', { context: 'proposePlant' });
    // the base is what the form loaded: the revision it names, read back from the history
    const revision = input.revision ?? now.revision;
    const base = valuesAt(now, revision) ?? now.values;
    return { op, kind, scope, id, name: now.name, origin: 'authored', baseRevision: revision, base: bodyOf(kind, base), value: body };
  }
  if (op === 'remove')
    return { op, kind, scope, id, name: now.name, origin: 'authored', baseRevision: now.revision, base: null, value: { cascade: !!value?.cascade } };
  // rename
  const newId = String(value?.newId ?? '').trim();
  if (!newId) throw new HttpError(400, 'Give the new id', 'PLANT_ID_FORMAT', { kind, id });
  return { op: 'rename', kind, scope, id, name: now.name, origin: 'authored', baseRevision: now.revision, base: null, value: { newId } };
}

/** A document operation (an import, a bulk change, – 0.16 – a move or – 0.19 – a collection import added to a draft). */
export function documentOperation(op: 'import' | 'bulk' | 'move' | 'collections', value: unknown, u: AuthUser): NewOp {
  requirePlant();
  if (!plantProposesSome(u)) throw new HttpError(403, 'You may not propose changes to the plant registry', 'FORBIDDEN', { context: 'proposePlant' });
  if (op === 'collections') {
    const { files, mappingFile, assetId, ...options } = collectionsOperationInput.parse(value);
    // the asset as the person sees it: one of a site they may not see reads as missing
    const site = assetSites([assetId]).get(assetId) ?? null;
    const sees = site !== null && !!siteRights(db().all<{ id: string; acl: string }>('SELECT id, acl FROM plant_sites'), u).get(site)?.includes('view');
    if (!sees) throw new HttpError(404, `There is no asset "${assetId}"`, 'PLANT_ENTRY_NOT_FOUND', { kind: 'asset', id: assetId });
    if (!mayPropose(u, site)) throw new HttpError(403, 'You may not propose changes here', 'FORBIDDEN', { context: 'proposePlant' });
    return {
      op,
      kind: null,
      scope: '',
      id: '',
      name: `collections of ${assetId}: ${files.map((f) => f.name).join(', ')}`.slice(0, 200),
      origin: 'derived',
      baseRevision: null,
      base: null,
      value: { assetId, ...options },
      source: JSON.stringify({ files, mappingFile }),
    };
  }
  if (op === 'move') {
    const { fingerprint: _f, ...rest } = plantMoveInput.parse(value);
    return {
      op,
      kind: null,
      scope: '',
      id: '',
      name: `move ${rest.items.length} ${rest.kind} to ${rest.toAsset}`,
      origin: 'derived',
      baseRevision: null,
      base: null,
      value: rest,
    };
  }
  if (op === 'bulk') {
    const b = plantBulkInput.parse(value);
    const { fingerprint: _f, ...rest } = b as typeof b & { fingerprint?: string };
    return {
      op,
      kind: null,
      scope: '',
      id: '',
      name: `${rest.action} ${rest.items.length} ${rest.kind}`,
      origin: 'derived',
      baseRevision: null,
      base: null,
      value: rest,
    };
  }
  const input = importInput.parse(value);
  const { files, fingerprint: _f, ...options } = input as typeof input & { fingerprint?: string };
  return {
    op,
    kind: null,
    scope: '',
    id: '',
    name: files.map((f) => f.name).join(', '),
    origin: 'derived',
    baseRevision: null,
    base: null,
    value: options,
    source: JSON.stringify(files),
  };
}

/** Adds an operation to a draft – one `set` per entry: a second save of the same entry changes it (its base stays). */
export function addOperation(cs: CsRow, o: NewOp, u: AuthUser): number {
  const ops = opsOf(cs.id);
  const size = JSON.stringify(o.value ?? null).length + (o.source?.length ?? 0);
  if (size > PLANT_CHANGESET_LIMITS.operationBytes + (o.op === 'import' || o.op === 'collections' ? 2 * 1024 * 1024 : 0))
    throw new HttpError(413, 'The operation is too large', 'PLANT_CHANGESET_TOO_LARGE', { kb: PLANT_CHANGESET_LIMITS.operationBytes / 1024 });
  checkOpenLimits(u, 0, size);
  if (o.op === 'set') {
    const same = ops.find((x) => x.op === 'set' && x.kind === o.kind && x.scope === o.scope && x.entry_id === o.id);
    if (same) {
      db().run(
        'UPDATE plant_change_ops SET value = ?, author = ?, updated_at = ? WHERE change_set_id = ? AND seq = ?',
        JSON.stringify(o.value),
        u.username,
        nowIso(),
        cs.id,
        same.seq,
      );
      touch(cs.id, u.username);
      return Number(same.seq);
    }
  }
  if (ops.length >= PLANT_CHANGESET_LIMITS.operations)
    throw new HttpError(409, `At most ${PLANT_CHANGESET_LIMITS.operations} changes per change set`, 'PLANT_CHANGESET_LIMIT', {
      max: PLANT_CHANGESET_LIMITS.operations,
    });
  return insertOp(cs.id, o, u.username);
}

/** 409 PLANT_ENTRY_CHANGED: what the form needs to offer "Keep mine" or "Take theirs" per field. */
export function entryChanged(now: EntrySnap, revision: number, mine: Record<string, unknown>): HttpError & { entryChanged: PlantEntryChanged } {
  const base = bodyOf(now.kind, valuesAt(now, revision) ?? mine);
  const current = bodyOf(now.kind, now.values);
  const m = mergeThreeWay(base, current, mine);
  const err = new HttpError(409, `${now.kind} "${now.id}" was changed by someone else since you opened it – choose per field`, 'PLANT_ENTRY_CHANGED', {
    kind: now.kind,
    id: now.id,
    count: m.conflicts.length,
  }) as HttpError & { entryChanged: PlantEntryChanged };
  err.entryChanged = { kind: now.kind, scope: now.scope, id: now.id, revision: now.revision, base, current, conflicts: m.conflicts };
  return err;
}

export const meOrNull = (): AuthUser => me();
