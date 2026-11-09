import { ZodError } from 'zod';
import {
  PLANT_CHANGESET_LIMITS,
  PLANT_CHANGESET_OPEN,
  mergeThreeWay,
  resolveMerge,
  sameValue,
  type FourEyesLevel,
  type PlantChangeConflict,
  type PlantChangeEntryDiff,
  type PlantChangeOpKind,
  type PlantChangeOperation,
  type PlantChangeSetDetail,
  type PlantChangeSetPreview,
  type PlantChangeSetSource,
  type PlantChangeSetState,
  type PlantChangeSetSummary,
  type PlantEntryKind,
  type PlantIdKind,
  type PlantImportResult,
  type PlantPermission,
  controlPoint,
  instanceRule,
  plantBulkInput,
} from '@sm/shared';
import { db } from '../../db.js';
import { audit, withAuditDetails, withoutAudit } from '../../audit.js';
import type { AuthUser } from '../../auth/context.js';
import { currentUser } from '../../auth/context.js';
import { me } from '../../auth/access.js';
import { samePerson } from '../../auth/assurance.js';
import { currentPolicy } from '../../auth/assurance-policy.js';
import { readSetting, writeSetting } from '../../settings.js';
import { HttpError, newId, nowIso, parseJson, sha256 } from '../../util.js';
import { asProposer, canCreateSites, canManageCatalogue, plantProposesSome, siteRights } from '../access.js';
import { requirePlant } from '../settings.js';
import { dryRun, renameId } from '../rename.js';
import { fieldDiff } from '../diff.js';
import { applyBulk, bulkNeedsStepUp } from '../bulk.js';
import { applyImport, importInput, importStepUpPoints, type ImportInput } from '../import.js';
import { CATALOGUE_KINDS, KINDS, PER_ASSET, assetSites, bodyOf, entryKey, entryPagePath, readEntry, type EntrySnap } from './entries.js';
import { recordBaselines, tracked, type EntryChange, type Region } from './track.js';
import * as svc from '../service.js';

/**
 * The change sets of the plant registry (0.13.0, docs/adr/0020-plant-change-sets.md, docs/PLANT.md "Change sets"):
 * drafts, proposals, review and the one apply core. Every path that changes plant data ends here – an edit form's
 * save (created and applied in one request, or written into the person's draft where review is required), the
 * import, bulk changes, renames and assistants' proposals.
 *
 * Rights: keeping drafts and proposing needs `propose` on the sites an operation touches (device profiles and KPI
 * definitions: propose on some site); applying needs what the edit form or the import needs (`manage`, the catalogue
 * right) and is done with the rights of whoever applies – the operations run through the services of the routes. Under
 * review (control point plant.changeSet) no author applies: the creator, everyone who changed an operation and, for an
 * assistant's proposal, the token owner – administrators included.
 */

/** A dry run (always rolled back) that audits nothing: what a change would do. */
export const quietDryRun = <T>(fn: () => T): T => dryRun(() => withoutAudit(fn));

// ---------- the policy ----------

const SETTINGS_KEY = 'plant.changeSets';

/** The level of plant.changeSet in the assurance policy. */
export function changeSetLevel(): FourEyesLevel {
  return instanceRule(controlPoint('plant.changeSet')!, currentPolicy()).fourEyes ?? 'off';
}

export const catalogueReview = (): boolean => readSetting<{ catalogueReview?: boolean }>(SETTINGS_KEY, {}).catalogueReview === true;

export function setCatalogueReview(on: boolean): void {
  const before = catalogueReview();
  if (before === on) return;
  writeSetting(SETTINGS_KEY, { ...readSetting<Record<string, unknown>>(SETTINGS_KEY, {}), catalogueReview: on });
  audit({
    action: 'plant.catalogue_review_changed',
    entityType: 'settings',
    entityId: 'plant',
    summary: on
      ? 'Changes to device profiles and KPI definitions need a second person'
      : 'Changes to device profiles and KPI definitions no longer need a second person',
    details: { old: before, new: on },
  });
}

/** Whether changes to these sites (and the catalogue) need a second person. */
export function reviewNeeded(sites: string[], catalogue: boolean): boolean {
  const level = changeSetLevel();
  if (level === 'off') return false;
  if (level === 'required') return true;
  if (catalogue && catalogueReview()) return true;
  const ids = [...new Set(sites.filter(Boolean))];
  if (!ids.length) return false;
  return db()
    .all<{ review: number }>(`SELECT review FROM plant_sites WHERE id IN (${ids.map(() => '?').join(', ')})`, ...ids)
    .some((r) => Number(r.review) === 1);
}

/**
 * A site's switch "Changes need a second person" (plant.changeSet optional): set by who manages the site, confirmed
 * like an access grant (the route's step-up); never by the import format.
 */
export function setSiteReview(siteId: string, on: boolean): ReturnType<typeof svc.getSite> {
  const { row, perms } = svc.visibleSite(siteId);
  if (!perms.includes('manage')) throw new HttpError(403, 'You may not change this site', 'FORBIDDEN', { context: 'managePlant' });
  if (changeSetLevel() !== 'optional')
    throw new HttpError(409, 'Sites decide this themselves only when the assurance policy says "optional" for plant.changeSet', 'PLANT_REVIEW_LEVEL', {
      level: changeSetLevel(),
    });
  const before = Number((row as unknown as { review?: number }).review ?? 0) === 1;
  if (before !== on)
    db().tx(() => {
      db().run('UPDATE plant_sites SET review = ? WHERE id = ?', on ? 1 : 0, siteId);
      audit({
        action: 'site.review_changed',
        entityType: 'site',
        entityId: siteId,
        summary: on ? `Changes to site "${row.name}" need a second person` : `Changes to site "${row.name}" no longer need a second person`,
        details: { old: before, new: on },
      });
    });
  return svc.getSite(siteId);
}

// ---------- rows ----------

export interface CsRow {
  id: string;
  state: PlantChangeSetState;
  source: PlantChangeSetSource;
  title: string;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
  authors: string;
  sites: string;
  catalogue: number;
  current_of: string | null;
  mcp_request_id: string | null;
  import_id: string | null;
  reverts: string | null;
  copied_from: string | null;
  preview: string;
  fingerprint: string;
  resolutions: string;
  counts: string;
  bytes: number;
  review: number;
  proposed_at: string | null;
  proposed_by: string | null;
  decided_at: string | null;
  decided_by: string | null;
  comment: string;
  expires_at: string | null;
  ops_sha256: string;
  history_sha256: string;
}

export interface OpRow {
  change_set_id: string;
  seq: number;
  op: PlantChangeOpKind;
  kind: PlantEntryKind | null;
  scope: string;
  entry_id: string;
  name: string;
  origin: 'authored' | 'derived';
  author: string;
  base_revision: number | null;
  base: string;
  value: string;
  updated_at: string;
}

export const rowOf = (id: string): CsRow | undefined => db().get<CsRow>('SELECT * FROM plant_change_sets WHERE id = ?', id);
/** The operations in order (numbers as numbers: PostgreSQL answers BIGINT as text). */
export const opsOf = (id: string): OpRow[] =>
  db()
    .all<OpRow>('SELECT * FROM plant_change_ops WHERE change_set_id = ? ORDER BY seq', id)
    .map((o) => ({ ...o, seq: Number(o.seq), base_revision: o.base_revision === null ? null : Number(o.base_revision) }));
export const sourceOf = (id: string, seq: number): string | null =>
  db().get<{ content: string }>('SELECT content FROM plant_change_sources WHERE change_set_id = ? AND seq = ?', id, seq)?.content ?? null;
const authorsOf = (r: CsRow): string[] => parseJson<string[]>(r.authors, []);
const sitesOf = (r: CsRow): string[] => parseJson<string[]>(r.sites, []);

/** Who wrote it: its authors and everyone who changed an operation. */
export const isAuthor = (r: CsRow, u: AuthUser): boolean => authorsOf(r).some((a) => samePerson(a, u));

const daysFrom = (at: string, days: number) => new Date(new Date(at).getTime() + days * 86_400_000).toISOString();
const notFound = (id: string) => new HttpError(404, `Change set ${id} not found`, 'PLANT_CHANGESET_NOT_FOUND', { id });

export function summaryOf(r: CsRow, u: AuthUser | null = currentUser()): PlantChangeSetSummary {
  const rights = u ? siteRights(db().all<{ id: string; acl: string }>('SELECT id, acl FROM plant_sites'), u) : new Map<string, PlantPermission[]>();
  const known = new Set(rights.keys());
  return {
    id: r.id,
    state: r.state,
    source: r.source,
    title: r.title,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    authors: authorsOf(r),
    // sites the reader may not see are left out (new sites a change set adds are shown)
    sites: sitesOf(r).filter((s) => !known.has(s) || rights.get(s)!.includes('view')),
    catalogue: !!Number(r.catalogue),
    operationCount: Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM plant_change_ops WHERE change_set_id = ?', r.id)?.n ?? 0),
    mcpRequestId: r.mcp_request_id,
    importId: r.import_id,
    reverts: r.reverts,
    proposedAt: r.proposed_at,
    proposedBy: r.proposed_by,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
    comment: r.comment,
    review: reviewNeeded(sitesOf(r), !!Number(r.catalogue)),
    expiresAt: PLANT_CHANGESET_OPEN.includes(r.state) ? r.expires_at : null,
  };
}

/** Whether `u` may see the change set: its authors always; others not a draft, and only when they see one of its sites. */
export function canSee(r: CsRow, u: AuthUser, rights = siteRights(db().all<{ id: string; acl: string }>('SELECT id, acl FROM plant_sites'), u)): boolean {
  if (isAuthor(r, u)) return true;
  if (r.state === 'draft') return false;
  const sites = sitesOf(r);
  if (sites.some((s) => rights.get(s)?.includes('view'))) return true;
  // device profiles and KPI definitions: everyone who sees the registry; new sites: who may add sites
  if (Number(r.catalogue)) return [...rights.values()].some((p) => p.includes('view')) || canCreateSites(u);
  return !sites.some((s) => rights.has(s)) && canCreateSites(u);
}

export function visibleRow(id: string, u: AuthUser = me()): CsRow {
  requirePlant();
  expireChangeSets();
  const r = rowOf(id);
  if (!r || !canSee(r, u)) throw notFound(id);
  return r;
}

/**
 * Whether `u` may apply it, and why not: the rights of every site it touches (and the catalogue's), proposed when it
 * needs review, and – under review – not one of its authors (administrators included).
 */
export function applyBlockedFor(r: CsRow, u: AuthUser): { code: string; message: string } | null {
  if (!PLANT_CHANGESET_OPEN.includes(r.state)) return { code: 'PLANT_CHANGESET_CLOSED', message: 'The change set is no longer open' };
  const review = reviewNeeded(sitesOf(r), !!Number(r.catalogue));
  if (review && r.state === 'draft') return { code: 'PLANT_CHANGESET_PROPOSE_FIRST', message: 'Changes here need a second person: propose the draft first' };
  if (review && isAuthor(r, u)) return { code: 'PLANT_CHANGESET_OWN', message: 'A second person applies it: you wrote it' };
  if (!review && r.state === 'draft' && !isAuthor(r, u)) return { code: 'PLANT_CHANGESET_DRAFT', message: 'A draft is applied by its author' };
  return rightsProblem(r, u);
}

/** The rights applying needs: manage on every site it touches (who may add sites for new ones), the catalogue's right. */
export function rightsProblem(r: Pick<CsRow, 'sites' | 'catalogue'>, u: AuthUser): { code: string; message: string } | null {
  const rights = siteRights(db().all<{ id: string; acl: string }>('SELECT id, acl FROM plant_sites'), u);
  for (const s of parseJson<string[]>(r.sites, [])) {
    const p = rights.get(s);
    if (p ? !p.includes('manage') : !canCreateSites(u)) return { code: 'FORBIDDEN', message: `You may not change site "${s}"` };
  }
  if (Number(r.catalogue) && !canManageCatalogue(u)) return { code: 'FORBIDDEN', message: 'You may not change device profiles and KPI definitions' };
  return null;
}

// ---------- expiry and clean-up ----------

/** Drafts expire after 30 days without a change, proposed change sets at their date (14 days, an assistant's with its request). */
export function expireChangeSets(now = nowIso()): number {
  let n = 0;
  // an assistant's proposal follows its AI request (expired, rejected or withdrawn there)
  for (const x of db().all<{ id: string; status: string; decided_by: string | null; decided_at: string | null; comment: string | null }>(
    `SELECT c.id AS id, r.status AS status, r.decided_by AS decided_by, r.decided_at AS decided_at, r.comment AS comment
     FROM plant_change_sets c JOIN mcp_requests r ON r.id = c.mcp_request_id WHERE c.state = 'proposed' AND r.status IN ('expired', 'rejected', 'withdrawn')`,
  ))
    db().run(
      "UPDATE plant_change_sets SET state = ?, decided_by = ?, decided_at = ?, comment = ?, updated_at = ?, expires_at = NULL WHERE id = ? AND state = 'proposed'",
      x.status,
      x.decided_by,
      x.decided_at,
      x.comment ?? '',
      now,
      x.id,
    );
  for (const r of db().all<CsRow>("SELECT * FROM plant_change_sets WHERE state IN ('draft', 'proposed') AND expires_at IS NOT NULL AND expires_at <= ?", now)) {
    if (
      db().run("UPDATE plant_change_sets SET state = 'expired', current_of = NULL, updated_at = ? WHERE id = ? AND state = ?", now, r.id, r.state).changes !== 1
    )
      continue;
    n++;
    audit({
      actor: 'system',
      action: 'plant.change_set_expired',
      entityType: 'plant_change_set',
      entityId: r.id,
      summary: `Plant change set "${r.title}" expired without a decision (${r.state})`,
      details: { state: r.state, source: r.source, createdBy: r.created_by },
    });
  }
  return n;
}

/** The daily clean-up: closed change sets after 90 days (their audit entries stay), the history of removed entries after 3 years. */
export function cleanUpChangeSets(now = new Date()): { changeSets: number; history: number } {
  expireChangeSets(now.toISOString());
  const closedBefore = new Date(now.getTime() - PLANT_CHANGESET_LIMITS.closedDays * 86_400_000).toISOString();
  const ids = db()
    .all<{ id: string }>("SELECT id FROM plant_change_sets WHERE state IN ('rejected', 'withdrawn', 'expired') AND updated_at < ?", closedBefore)
    .map((r) => r.id);
  db().tx(() => {
    for (const id of ids) {
      db().run('DELETE FROM plant_change_ops WHERE change_set_id = ?', id);
      db().run('DELETE FROM plant_change_sources WHERE change_set_id = ?', id);
      db().run('DELETE FROM plant_change_sets WHERE id = ?', id);
    }
  });
  const removedBefore = new Date(now.getTime() - PLANT_CHANGESET_LIMITS.historyYears * 365 * 86_400_000).toISOString();
  const history = db().run('DELETE FROM plant_entry_history WHERE removed_at IS NOT NULL AND removed_at < ?', removedBefore).changes;
  return { changeSets: ids.length, history };
}

// ---------- fingerprints ----------

/** What applying writes, entry by entry and field by field: the same fingerprint means the same result. */
export function fingerprintOf(changes: EntryChange[]): string {
  const rows = changes
    .map((c) => [entryKey(c), c.op, c.from ? `${c.from.scope}/${c.from.id}` : '', c.before, c.after] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256(JSON.stringify(rows)).slice(0, 32);
}

const opsSha = (ops: { op: string; kind: string | null; scope: string; entry_id: string; base: string; value: string }[]) =>
  sha256(JSON.stringify(ops.map((o) => [o.op, o.kind, o.scope, o.entry_id, o.base, o.value])));

// ---------- creating ----------

export interface NewOp {
  op: PlantChangeOpKind;
  kind: PlantEntryKind | null;
  scope: string;
  id: string;
  name: string;
  origin: 'authored' | 'derived';
  baseRevision: number | null;
  base: unknown;
  value: unknown;
  /** import / bulk: the document (kept apart, plant_change_sources) */
  source?: string;
}

export function insertChangeSet(o: {
  id?: string;
  state: PlantChangeSetState;
  source: PlantChangeSetSource;
  title: string;
  by: string;
  current?: boolean;
  mcpRequestId?: string | null;
  reverts?: string | null;
  copiedFrom?: string | null;
  sites?: string[];
  catalogue?: boolean;
  expiresAt?: string | null;
}): string {
  const id = o.id ?? newId('pcs_');
  const at = nowIso();
  if (o.current) db().run('UPDATE plant_change_sets SET current_of = NULL WHERE current_of = ?', o.by);
  db().run(
    `INSERT INTO plant_change_sets (id, state, source, title, created_by, created_at, updated_by, updated_at, authors, sites, catalogue, current_of, mcp_request_id, reverts, copied_from, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    o.state,
    o.source,
    o.title.slice(0, PLANT_CHANGESET_LIMITS.title),
    o.by,
    at,
    o.by,
    at,
    JSON.stringify([o.by]),
    JSON.stringify(o.sites ?? []),
    o.catalogue ? 1 : 0,
    o.current ? o.by : null,
    o.mcpRequestId ?? null,
    o.reverts ?? null,
    o.copiedFrom ?? null,
    o.expiresAt === undefined
      ? o.state === 'draft'
        ? daysFrom(at, PLANT_CHANGESET_LIMITS.draftDays)
        : o.state === 'proposed'
          ? daysFrom(at, PLANT_CHANGESET_LIMITS.proposedDays)
          : null
      : o.expiresAt,
  );
  return id;
}

export function insertOp(csId: string, o: NewOp, author: string): number {
  const seq = Number(db().get<{ n: number | null }>('SELECT MAX(seq) AS n FROM plant_change_ops WHERE change_set_id = ?', csId)?.n ?? 0) + 1;
  if (o.source !== undefined)
    db().run('INSERT INTO plant_change_sources (change_set_id, seq, content, sha256) VALUES (?, ?, ?, ?)', csId, seq, o.source, sha256(o.source));
  db().run(
    `INSERT INTO plant_change_ops (change_set_id, seq, op, kind, scope, entry_id, name, origin, author, base_revision, base, value, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    csId,
    seq,
    o.op,
    o.kind,
    o.scope,
    o.id,
    o.name.slice(0, 200),
    o.origin,
    author,
    o.baseRevision,
    JSON.stringify(o.base ?? null),
    JSON.stringify(o.value ?? null),
    nowIso(),
  );
  touch(csId, author);
  return seq;
}

/** A change set was changed by `by`: they are an author now; a draft's expiry starts again. */
export function touch(csId: string, by: string): void {
  const r = rowOf(csId);
  if (!r) return;
  const authors = authorsOf(r);
  if (!authors.some((a) => a.toLowerCase() === by.toLowerCase())) authors.push(by);
  const at = nowIso();
  const bytes =
    Number(db().get<{ n: number | null }>('SELECT SUM(LENGTH(value) + LENGTH(base)) AS n FROM plant_change_ops WHERE change_set_id = ?', csId)?.n ?? 0) +
    Number(db().get<{ n: number | null }>('SELECT SUM(LENGTH(content)) AS n FROM plant_change_sources WHERE change_set_id = ?', csId)?.n ?? 0);
  // where its operations reach (a document's: what its last preview found, too)
  const ops = opsOf(csId);
  const w = whereOfOps(ops);
  const docs = ops.some((o) => o.op === 'import' || o.op === 'bulk' || o.op === 'rename');
  const sites = docs ? [...new Set([...sitesOf(r), ...w.sites])].sort() : w.sites;
  db().run(
    'UPDATE plant_change_sets SET authors = ?, updated_by = ?, updated_at = ?, bytes = ?, expires_at = ?, sites = ?, catalogue = ? WHERE id = ?',
    JSON.stringify(authors),
    by,
    at,
    bytes,
    r.state === 'draft' ? daysFrom(at, PLANT_CHANGESET_LIMITS.draftDays) : r.expires_at,
    JSON.stringify(sites),
    w.catalogue || (docs && !!Number(r.catalogue)) ? 1 : 0,
    csId,
  );
}

/** The sites and the catalogue a change set's operations name (before a preview has found what they touch). */
export function whereOfOps(ops: Pick<OpRow, 'op' | 'kind' | 'scope' | 'entry_id' | 'value'>[]): { sites: string[]; catalogue: boolean } {
  const out = new Set<string>();
  const assets: string[] = [];
  let catalogue = false;
  for (const o of ops) {
    if (!o.kind) continue;
    if (o.kind === 'site') out.add(o.entry_id);
    else if (['node', 'building', 'vlan', 'zone', 'conduit'].includes(o.kind)) out.add(o.scope);
    else if (CATALOGUE_KINDS.includes(o.kind)) catalogue = true;
    else if (o.kind === 'asset' || PER_ASSET.includes(o.kind)) assets.push(o.entry_id);
    else assets.push(o.scope);
    const v = parseJson<{ siteId?: unknown } | null>(o.value, null);
    if (o.kind === 'asset' && v && typeof v.siteId === 'string') out.add(v.siteId);
  }
  for (const site of assetSites(assets).values()) out.add(site);
  return { sites: [...out].sort(), catalogue };
}

// ---------- the region of operations ----------

/** What a change set's operations can reach (the tracker reads it before and after). */
export function regionOf(ops: Pick<OpRow, 'op' | 'kind' | 'scope' | 'entry_id' | 'value'>[]): Region {
  const sites = new Set<string>();
  const assets = new Set<string>();
  let catalogue = false;
  for (const o of ops) {
    if (o.op === 'import' || o.op === 'bulk' || o.op === 'rename' || !o.kind) return { all: true };
    if (o.kind === 'site') sites.add(o.entry_id);
    else if (['node', 'building', 'vlan', 'zone', 'conduit'].includes(o.kind)) sites.add(o.scope);
    else if (o.kind === 'asset' || PER_ASSET.includes(o.kind)) assets.add(o.entry_id);
    else if (CATALOGUE_KINDS.includes(o.kind)) catalogue = true;
    else assets.add(o.scope);
    // an asset that moves, or a new one: its site (its old site comes with the asset)
    const v = parseJson<{ siteId?: unknown } | null>(o.value, null);
    if (o.kind === 'asset' && v && typeof v.siteId === 'string') sites.add(v.siteId);
  }
  for (const s of assetSites([...assets]).values()) sites.add(s);
  return { sites: [...sites], assets: [...assets], catalogue, assignments: catalogue };
}

// ---------- running operations ----------

export interface RunOutcome {
  problems: { seq: number | null; code: string; message: string }[];
  conflicts: PlantChangeConflict[];
  stale: number[];
  importIds: string[];
  imports: PlantImportResult[];
}

interface Choice {
  seq: number;
  path: string;
  choice: 'mine' | 'theirs';
}

const problemOf = (e: unknown): { code: string; message: string } | null => {
  if (e instanceof HttpError && e.statusCode < 500) return { code: e.code ?? 'PLANT_CHANGESET_INVALID', message: e.message };
  if (e instanceof ZodError) return { code: 'PLANT_CHANGESET_INVALID', message: e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  return null;
};

/** Why applying is refused, as the route's answer. */
function blockedError(b: { code: string; message: string }, id: string): HttpError {
  switch (b.code) {
    case 'FORBIDDEN':
      return new HttpError(403, b.message, 'FORBIDDEN', { context: 'managePlant' });
    case 'PLANT_CHANGESET_CLOSED':
      return new HttpError(409, b.message, 'PLANT_CHANGESET_CLOSED', { id });
    case 'PLANT_CHANGESET_PROPOSE_FIRST':
      return new HttpError(409, b.message, 'PLANT_CHANGESET_PROPOSE_FIRST', { id });
    case 'PLANT_CHANGESET_DRAFT':
      return new HttpError(409, b.message, 'PLANT_CHANGESET_DRAFT', { id });
    default:
      return new HttpError(409, b.message, 'PLANT_CHANGESET_OWN', { id });
  }
}

/** A result that is not what the preview showed, in the words of the path that applies it. */
function changedError(code: string | undefined): HttpError {
  const message = 'What it writes is no longer what the preview showed – look at the preview again';
  if (code === 'PLANT_IMPORT_CHANGED') return new HttpError(409, message, 'PLANT_IMPORT_CHANGED');
  if (code === 'PLANT_BULK_CHANGED') return new HttpError(409, message, 'PLANT_BULK_CHANGED');
  if (code === 'PLANT_RENAME_CHANGED') return new HttpError(409, message, 'PLANT_RENAME_CHANGED');
  return new HttpError(409, message, 'PLANT_CHANGESET_CHANGED');
}

/** The three-way merge of a `set` operation against the entry now. */
export function mergeOf(o: OpRow, now: EntrySnap, choices: Choice[]): { body: unknown; conflicts: PlantChangeConflict[]; unresolved: number; stale: boolean } {
  const mine = parseJson<unknown>(o.value, null);
  if (o.base_revision === null || Number(o.base_revision) === now.revision) return { body: mine, conflicts: [], unresolved: 0, stale: false };
  const base = parseJson<unknown>(o.base, null);
  const theirs = bodyOf(now.kind, now.values);
  const m = mergeThreeWay(base, theirs, mine);
  const choiceOf = (keys: string[]) => choices.find((c) => c.seq === o.seq && c.path === keys.join('.'))?.choice ?? null;
  const conflicts: PlantChangeConflict[] = m.conflicts.map((c) => ({ seq: o.seq, ...c, choice: choiceOf(c.keys) }));
  return {
    body: resolveMerge(m.merged, m.conflicts, (c) => choiceOf(c.keys)),
    conflicts,
    unresolved: conflicts.filter((c) => !c.choice).length,
    stale: true,
  };
}

/** Runs the operations in order, as the person they run for (inside a transaction). Refusals become problems. */
export function runOps(cs: Pick<CsRow, 'id' | 'resolutions'>, ops: OpRow[]): RunOutcome {
  const out: RunOutcome = { problems: [], conflicts: [], stale: [], importIds: [], imports: [] };
  const choices = parseJson<Choice[]>(cs.resolutions, []);
  for (const o of ops) {
    try {
      const d = o.kind ? KINDS[o.kind] : null;
      const value = parseJson<Record<string, unknown> | null>(o.value, null);
      switch (o.op) {
        case 'set': {
          const now = readEntry(o.kind!, o.scope, o.entry_id);
          if (!now) {
            out.problems.push({ seq: o.seq, code: 'PLANT_CHANGESET_ENTRY_GONE', message: `${o.kind} "${o.entry_id}" is no longer there` });
            continue;
          }
          const m = mergeOf(o, now, choices);
          if (m.stale) out.stale.push(o.seq);
          out.conflicts.push(...m.conflicts);
          if (m.unresolved) {
            out.problems.push({
              seq: o.seq,
              code: 'PLANT_CHANGESET_CONFLICT',
              message: `${o.kind} "${o.entry_id}" was changed since: choose for ${m.conflicts
                .filter((c) => !c.choice)
                .map((c) => c.path)
                .join(', ')}`,
            });
            continue;
          }
          d!.set(o.scope, o.entry_id, d!.update.parse(m.body));
          break;
        }
        case 'add':
          if (!d!.create) throw new HttpError(400, `A ${o.kind} cannot be added on its own`, 'PLANT_CHANGESET_OPERATION');
          d!.add(o.scope, d!.create.parse(value), o.entry_id);
          break;
        case 'remove':
          if (!readEntry(o.kind!, o.scope, o.entry_id)) {
            out.problems.push({ seq: o.seq, code: 'PLANT_CHANGESET_ENTRY_GONE', message: `${o.kind} "${o.entry_id}" is no longer there` });
            continue;
          }
          d!.remove(o.scope, o.entry_id, { cascade: !!value?.cascade });
          break;
        case 'rename':
          renameId({ kind: o.kind as PlantIdKind, scope: o.scope, id: o.entry_id, newId: String(value?.newId ?? '') });
          break;
        case 'import': {
          const r = applyImport(importOf(o));
          out.importIds.push(r.import.id);
          out.imports.push(r);
          recordBaselines(r.import.id);
          break;
        }
        case 'bulk':
          applyBulk(plantBulkInput.parse(value));
          break;
      }
    } catch (e) {
      const p = problemOf(e);
      if (!p) throw e;
      out.problems.push({ seq: o.seq, ...p });
    }
  }
  return out;
}

/**
 * The import of an `import` operation: its options and the files kept with it – or, for an assistant's proposal, its
 * document, adding and changing only (the 0.12 rules: never replace, remove or rename).
 */
export function importOf(o: Pick<OpRow, 'change_set_id' | 'seq' | 'value'>): ImportInput {
  const value = parseJson<Record<string, unknown>>(o.value, {});
  const doc = sourceOf(o.change_set_id, o.seq) ?? '';
  if (value.proposal === true)
    return importInput.parse({ files: [{ name: 'proposal.json', content: doc }], mode: 'update', removeMissing: false, cascade: false });
  const { proposal: _p, ...options } = value;
  return importInput.parse({ ...options, files: parseJson<unknown>(doc, []) });
}

/** The step-up of applying (0.11's rules per source): more than one removal or rename, many edits, one rename. */
export function stepUpPointsOf(ops: OpRow[], source: PlantChangeSetSource): string[] {
  if (source === 'assistant') return [];
  const removes = ops.filter((o) => o.op === 'remove').length;
  const renames = ops.filter((o) => o.op === 'rename').length;
  const sets = new Set(ops.filter((o) => o.op === 'set').map((o) => entryKey({ kind: o.kind ?? '', scope: o.scope, id: o.entry_id }))).size;
  const points = new Set<string>();
  if (removes > 1 || renames > 1 || sets > 25) points.add('plant.bulkChange');
  else if (renames === 1) points.add('plant.renameId');
  for (const o of ops) {
    if (o.op === 'bulk') {
      const b = plantBulkInput.safeParse(parseJson(o.value, null));
      if (b.success && bulkNeedsStepUp(b.data)) points.add('plant.bulkChange');
    }
    if (o.op === 'import') for (const p of importStepUpPoints(importOf(o))) points.add(p);
  }
  if (points.has('plant.bulkChange')) points.delete('plant.renameId');
  return [...points];
}

// ---------- preview ----------

const counts = (changes: EntryChange[]) => ({
  add: changes.filter((c) => c.op === 'add').length,
  change: changes.filter((c) => c.op === 'set').length,
  remove: changes.filter((c) => c.op === 'remove').length,
  rename: changes.filter((c) => c.op === 'rename').length,
});

function entryDiffs(changes: EntryChange[], u: AuthUser, staleKeys: Set<string>): { entries: PlantChangeEntryDiff[]; hidden: number } {
  const rights = siteRights(db().all<{ id: string; acl: string }>('SELECT id, acl FROM plant_sites'), u);
  const sees = (siteId: string) => !siteId || !rights.has(siteId) || !!rights.get(siteId)?.includes('view');
  const visible = changes.filter((c) => sees(c.siteId));
  return {
    entries: visible.map((c) => ({
      kind: c.kind,
      scope: c.scope,
      id: c.id,
      name: c.name,
      action: c.op === 'set' ? 'change' : c.op,
      ...(c.from ? { from: c.from.id } : {}),
      diff: c.op === 'add' ? fieldDiff({}, c.after ?? {}) : c.op === 'remove' ? fieldDiff(c.before ?? {}, {}) : fieldDiff(c.before ?? {}, c.after ?? {}),
      ...(staleKeys.has(entryKey(c)) ? { stale: true } : {}),
    })),
    hidden: changes.length - visible.length,
  };
}

/** Sites and the catalogue the changes touch. */
function touched(changes: EntryChange[], ops: OpRow[]): { sites: string[]; catalogue: boolean } {
  const sites = new Set(changes.map((c) => c.siteId).filter(Boolean));
  for (const o of ops) {
    if (o.kind === 'site') sites.add(o.entry_id);
    else if (o.kind && ['node', 'building', 'vlan', 'zone', 'conduit'].includes(o.kind)) sites.add(o.scope);
  }
  return {
    sites: [...sites].sort(),
    catalogue: changes.some((c) => CATALOGUE_KINDS.includes(c.kind)) || ops.some((o) => !!o.kind && CATALOGUE_KINDS.includes(o.kind)),
  };
}

/**
 * What applying the change set now would do (a dry run, always rolled back): the entries field by field, conflicts,
 * problems, the fingerprint the apply needs and whether `u` may apply it. An author who may only propose sees what
 * their draft would do (their propose right counts as manage, in the rolled-back transaction only).
 */
export function previewOf(r: CsRow, u: AuthUser = me()): PlantChangeSetPreview & { sites: string[]; catalogue: boolean } {
  const ops = opsOf(r.id);
  const run = () => tracked(regionOf(ops), { changeSetId: r.id, author: r.created_by, appliedBy: u.username, dryRun: true }, () => runOps(r, ops));
  const t = quietDryRun(() => asProposer(run));
  const staleKeys = new Set(
    t.result.stale.map((seq) => {
      const o = ops.find((x) => x.seq === seq)!;
      return entryKey({ kind: o.kind!, scope: o.scope, id: o.entry_id });
    }),
  );
  const { entries, hidden } = entryDiffs(t.changes, u, staleKeys);
  const where = touched(t.changes, ops);
  // what the preview shows is what the reader may apply: sites and catalogue as they are now
  const blocked = applyBlockedFor({ ...r, sites: JSON.stringify(where.sites), catalogue: where.catalogue ? 1 : 0 }, u);
  return {
    ok: !t.result.problems.length && t.changes.length > 0,
    problems: t.result.problems.length || t.changes.length ? t.result.problems : [{ seq: null, code: 'PLANT_CHANGESET_EMPTY', message: 'It changes nothing' }],
    entries,
    hidden,
    conflicts: t.result.conflicts,
    stale: t.result.stale.length > 0,
    fingerprint: fingerprintOf(t.changes),
    stepUp: stepUpPointsOf(ops, r.source).length > 0,
    applyBlocked: blocked,
    review: reviewNeeded(where.sites, where.catalogue),
    counts: counts(t.changes),
    sites: where.sites,
    catalogue: where.catalogue,
  };
}

/** Keeps what the preview found: the sites and the catalogue it touches (who sees it, who may apply it). */
export function rememberWhere(r: CsRow, where: { sites: string[]; catalogue: boolean }): void {
  if (sameValue(sitesOf(r), where.sites) && !!Number(r.catalogue) === where.catalogue) return;
  db().run('UPDATE plant_change_sets SET sites = ?, catalogue = ? WHERE id = ?', JSON.stringify(where.sites), where.catalogue ? 1 : 0, r.id);
}

// ---------- applying ----------

/**
 * Applies a stored change set as `u`, in one transaction: the operations through the services of the routes, the
 * three-way merge for authored operations, history and revisions, the import's baselines; refused when what it writes
 * differs from the preview `u` saw (PLANT_CHANGESET_CHANGED) or anything is refused.
 */
export function applyStored(
  id: string,
  fingerprint: string | null,
  u: AuthUser = me(),
  o: { viaRequest?: boolean; check?: (imports: PlantImportResult[]) => void } = {},
): { changes: EntryChange[]; importIds: string[]; imports: PlantImportResult[] } {
  return db().tx(() => {
    const r = rowOf(id);
    if (!r) throw notFound(id);
    const ops = opsOf(id);
    // where it reaches now
    const blocked = applyBlockedFor(r, u);
    if (blocked) throw blockedError(blocked, id);
    if (r.source === 'assistant' && !o.viaRequest)
      throw new HttpError(409, 'An assistant’s proposal is applied through its AI request', 'PLANT_CHANGESET_VIA_REQUEST', { id });
    const authors = authorsOf(r);
    const t = withAuditDetails({ changeSetId: id }, () =>
      tracked(regionOf(ops), { changeSetId: id, author: authors.join(', '), appliedBy: u.username }, () => runOps(r, ops)),
    );
    const p = t.result.problems[0];
    if (p)
      throw new HttpError(
        409,
        `The change set cannot be applied: ${p.message}`,
        p.code === 'PLANT_CHANGESET_CONFLICT' ? 'PLANT_CHANGESET_CONFLICT' : 'PLANT_CHANGESET_INVALID',
        {
          seq: p.seq ?? 0,
        },
      );
    // an assistant's proposal keeps the 0.12 check (its preview's fingerprint, the refusals of what it may not do)
    o.check?.(t.result.imports);
    if (fingerprint !== null && fingerprintOf(t.changes) !== fingerprint)
      throw new HttpError(409, 'What the change set writes is no longer what the preview showed – look at the preview again', 'PLANT_CHANGESET_CHANGED', {
        id,
      });
    const where = touched(t.changes, ops);
    // under review the sites it really touched decide (an import may reach a site with review)
    if (reviewNeeded(where.sites, where.catalogue) && (r.state !== 'proposed' || isAuthor(r, u)))
      throw new HttpError(409, 'Changes here need a second person: propose it, and someone else applies it', 'PLANT_CHANGESET_OWN', { id });
    const at = nowIso();
    db().run(
      `UPDATE plant_change_sets SET state = 'applied', current_of = NULL, decided_at = ?, decided_by = ?, updated_at = ?, sites = ?, catalogue = ?, counts = ?, review = ?,
         import_id = COALESCE(import_id, ?), fingerprint = ?, ops_sha256 = ?, history_sha256 = ?, expires_at = NULL WHERE id = ?`,
      at,
      u.username,
      at,
      JSON.stringify(where.sites),
      where.catalogue ? 1 : 0,
      JSON.stringify(counts(t.changes)),
      reviewNeeded(where.sites, where.catalogue) ? 1 : 0,
      t.result.importIds[0] ?? null,
      fingerprint ?? fingerprintOf(t.changes),
      opsSha(ops),
      t.historySha256,
      id,
    );
    auditApplied({ ...r, sites: JSON.stringify(where.sites) }, ops, t.changes, t.historySha256, u);
    return { changes: t.changes, importIds: t.result.importIds, imports: t.result.imports };
  });
}

function auditApplied(
  r: Pick<CsRow, 'id' | 'title' | 'source' | 'created_by' | 'sites'>,
  ops: { op: string; kind: string | null; scope: string; entry_id: string; base: string; value: string }[],
  changes: EntryChange[],
  historySha256: string,
  u: AuthUser,
): void {
  const c = counts(changes);
  audit({
    action: 'plant.change_set_applied',
    entityType: 'plant_change_set',
    entityId: r.id,
    summary: `Plant change set "${r.title}" (${r.source}) applied by ${u.username}: ${c.add} added, ${c.change} changed, ${c.rename} renamed, ${c.remove} removed`,
    details: {
      changeSetId: r.id,
      source: r.source,
      createdBy: r.created_by,
      sites: sitesOf(r as CsRow).slice(0, 50),
      counts: c,
      operations: ops.length,
      // tamper evidence: a history row changed in the database no longer matches the chained audit log (ADR 0003)
      operationsSha256: opsSha(ops),
      historySha256,
      entries: changes.slice(0, 150).map((x) => `${x.op}:${x.kind}:${x.scope ? `${x.scope}/` : ''}${x.id}`),
    },
  });
}

/**
 * A change of one request (an edit form, the import, a bulk change, a rename without review): a change set created and
 * applied at once. The route's own audit entries carry its id; nothing is kept when nothing changed.
 */
export function applyDirect<T>(o: {
  source: PlantChangeSetSource;
  title: string;
  region: Region;
  ops: NewOp[];
  fn: () => T;
  /** The preview's fingerprint the caller saw (refused with `changedCode` when the result differs) */
  fingerprint?: string;
  changedCode?: string;
  /** The import's id, for its baselines */
  importIdOf?: (result: T) => string | null;
  mcpRequestId?: string;
  author?: string;
}): { result: T; changeSetId: string | null; changes: EntryChange[] } {
  const u = me();
  return db().tx(() => {
    const id = newId('pcs_');
    const author = o.author ?? u.username;
    const t = withAuditDetails({ changeSetId: id }, () => tracked(o.region, { changeSetId: id, author, appliedBy: u.username }, o.fn));
    if (o.fingerprint !== undefined && fingerprintOf(t.changes) !== o.fingerprint) throw changedError(o.changedCode);
    const importId = o.importIdOf?.(t.result) ?? null;
    if (importId) recordBaselines(importId);
    if (!t.changes.length) return { result: t.result, changeSetId: null, changes: [] };
    const where = touched(t.changes, []);
    insertChangeSet({
      id,
      state: 'applied',
      source: o.source,
      title: o.title,
      by: author,
      sites: where.sites,
      catalogue: where.catalogue,
      mcpRequestId: o.mcpRequestId ?? null,
      expiresAt: null,
    });
    for (const op of o.ops) insertOp(id, op, author);
    const ops = opsOf(id);
    const at = nowIso();
    db().run(
      `UPDATE plant_change_sets SET decided_at = ?, decided_by = ?, counts = ?, import_id = ?, fingerprint = ?, ops_sha256 = ?, history_sha256 = ?, updated_at = ? WHERE id = ?`,
      at,
      u.username,
      JSON.stringify(counts(t.changes)),
      importId,
      fingerprintOf(t.changes),
      opsSha(ops),
      t.historySha256,
      at,
      id,
    );
    auditApplied({ id, title: o.title, source: o.source, created_by: author, sites: JSON.stringify(where.sites) }, ops, t.changes, t.historySha256, u);
    return { result: t.result, changeSetId: id, changes: t.changes };
  });
}

/** The fingerprint of what fn would write (a dry run, rolled back), with fn's own result. */
export function previewFingerprint<T>(region: Region, fn: () => T): { result: T; fingerprint: string; changes: EntryChange[] } {
  let out: { result: T; fingerprint: string; changes: EntryChange[] } | undefined;
  quietDryRun(() => {
    const t = tracked(region, { changeSetId: 'preview', author: '', appliedBy: '', dryRun: true }, fn);
    out = { result: t.result, fingerprint: fingerprintOf(t.changes), changes: t.changes };
  });
  return out!;
}

// ---------- detail ----------

export function operationsFor(r: CsRow, u: AuthUser): { operations: PlantChangeOperation[]; hidden: number } {
  const rights = siteRights(db().all<{ id: string; acl: string }>('SELECT id, acl FROM plant_sites'), u);
  const ops = opsOf(r.id);
  const assetSite = assetSites(ops.filter((o) => o.kind === 'asset' || (o.kind && PER_ASSET.includes(o.kind))).map((o) => o.entry_id));
  const scopeSite = assetSites(ops.filter((o) => o.kind && ['device', 'data_path', 'collection'].includes(o.kind)).map((o) => o.scope));
  const siteOf = (o: OpRow): string | null =>
    !o.kind
      ? null
      : o.kind === 'site'
        ? o.entry_id
        : ['node', 'building', 'vlan', 'zone', 'conduit'].includes(o.kind)
          ? o.scope
          : o.kind === 'asset' || PER_ASSET.includes(o.kind)
            ? (assetSite.get(o.entry_id) ?? null)
            : CATALOGUE_KINDS.includes(o.kind)
              ? null
              : (scopeSite.get(o.scope) ?? null);
  const author = isAuthor(r, u);
  const visible = ops.filter((o) => {
    if (author) return true;
    const s = siteOf(o);
    return !s || !rights.has(s) || !!rights.get(s)?.includes('view');
  });
  return {
    operations: visible.map((o) => {
      const value = parseJson<unknown>(o.value, null);
      return {
        seq: Number(o.seq),
        op: o.op,
        kind: o.kind,
        scope: o.scope,
        id: o.entry_id,
        name: o.name,
        origin: o.origin,
        author: o.author,
        baseRevision: o.base_revision === null ? null : Number(o.base_revision),
        base: parseJson<unknown>(o.base, null),
        // a document is shown by its size and hash (the files themselves are in the import's preview)
        value: o.op === 'import' ? { ...(value as object), files: undefined } : value,
        path: o.kind ? entryPagePath(o.kind, o.scope, o.entry_id) : null,
      };
    }),
    hidden: ops.length - visible.length,
  };
}

export function detailOf(r: CsRow, u: AuthUser = me()): PlantChangeSetDetail {
  const { operations, hidden } = operationsFor(r, u);
  const author = isAuthor(r, u);
  const open = PLANT_CHANGESET_OPEN.includes(r.state);
  const blocked = applyBlockedFor(r, u);
  const choices = parseJson<Choice[]>(r.resolutions, []);
  // the conflicts known now (the preview finds them; kept with their choices)
  const conflicts: PlantChangeConflict[] = [];
  if (open)
    for (const o of opsOf(r.id)) {
      if (o.op !== 'set' || !o.kind) continue;
      const now = readEntry(o.kind, o.scope, o.entry_id);
      if (now) conflicts.push(...mergeOf(o, now, choices).conflicts);
    }
  return {
    ...summaryOf(r, u),
    operations,
    hiddenOperations: hidden,
    conflicts,
    canEdit: r.state === 'draft' && author,
    canPropose: r.state === 'draft' && author && operations.length > 0 && r.source !== 'assistant',
    canWithdraw: open && author && r.source !== 'assistant' ? true : open && r.source === 'assistant' && samePersonAny([r.created_by], u),
    canApply: !blocked,
    canReject: r.state === 'proposed' && !author && !rightsProblem(r, u),
    canReturn: r.state === 'proposed' && !author && !blocked && r.source !== 'assistant',
    canRevert: r.state === 'applied' && plantProposesSome(u),
    canCopy: (r.state === 'rejected' || r.state === 'withdrawn' || r.state === 'expired') && plantProposesSome(u) && r.source !== 'assistant',
    copiedFrom: r.copied_from,
    ...(r.state === 'applied' ? { applied: appliedEntries(r.id, u) } : {}),
  };
}

/** What an applied change set changed, from the history (entries of sites the reader may not see left out). */
function appliedEntries(id: string, u: AuthUser): PlantChangeEntryDiff[] {
  const rows = db().all<{ kind: PlantEntryKind; scope: string; entry_id: string; op: EntryChange['op']; before_values: string; after_values: string }>(
    'SELECT kind, scope, entry_id, op, before_values, after_values FROM plant_entry_history WHERE change_set_id = ? ORDER BY kind, scope, entry_id',
    id,
  );
  const assets = assetSites(rows.map((x) => (['device', 'data_path', 'collection'].includes(x.kind) ? x.scope : x.entry_id)));
  const changes: EntryChange[] = rows.map((x) => {
    const before = parseJson<Record<string, unknown> | null>(x.before_values, null);
    const after = parseJson<Record<string, unknown> | null>(x.after_values, null);
    const siteId =
      x.kind === 'site'
        ? x.entry_id
        : ['node', 'building', 'vlan', 'zone', 'conduit'].includes(x.kind)
          ? x.scope
          : CATALOGUE_KINDS.includes(x.kind)
            ? ''
            : (assets.get(['device', 'data_path', 'collection'].includes(x.kind) ? x.scope : x.entry_id) ?? '');
    const name = String((after ?? before ?? {}).name ?? (after ?? before ?? {}).hostname ?? x.entry_id);
    return {
      kind: x.kind,
      scope: x.scope,
      id: x.entry_id,
      name,
      siteId,
      op: x.op,
      ...(x.op === 'rename' && typeof before?.id === 'string' ? { from: { scope: x.scope, id: before.id } } : {}),
      before,
      after,
      revision: 0,
    };
  });
  return entryDiffs(changes, u, new Set()).entries;
}

const samePersonAny = (names: string[], u: AuthUser) => names.some((n) => samePerson(n, u));
