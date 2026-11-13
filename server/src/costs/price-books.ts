import {
  COST_PRICE_CSV_FIELDS,
  COST_PRICE_LIMITS,
  costPriceBookInput,
  costPriceEntriesInput,
  costPriceEntryInput,
  costPriceImportInput,
  changePct,
  entryKey,
  normaliseEntry,
  parseQuantity,
  versionProblems,
  type AclEntry,
  type CostPriceBook,
  type CostPriceBookDetail,
  type CostPriceBookKind,
  type CostPriceCharge,
  type CostPriceDiff,
  type CostPriceDiffItem,
  type CostPriceEntry,
  type CostPriceImportPreview,
  type CostPriceImportProblem,
  type CostPriceVersion,
  type CostPriceVersionSource,
  type CostPriceCsvField,
  type CostTierMode,
  type Locale,
  type PlatformPermission,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { currentActor, currentUser, type AuthUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { assignCreatorTeams, forgetOwningTeams, memberships, owningTeams, teamRoles } from '../auth/policy.js';
import { listUsers, toAuthUser } from '../auth/users.js';
import { visibleContracts } from '../suppliers/links.js';
import { notify, titleName } from '../notifications/service.js';
import { t } from '../i18n/index.js';
import { canonicalJson, HttpError, newId, nowIso, parseJson, sha256 } from '../util.js';
import { scopeInfo } from './access.js';
import { decodeCursor, pageRows } from '../api/v1/pagination.js';
import { readCsv } from './csv.js';

/**
 * Price books (0.21.0, ADR 0035 parts 1, 2 and 8, docs/PRICE-BOOKS.md): books of item prices in immutable versions,
 * written by hand or from a CSV file, each version with its difference to the one before; the review reminder for books
 * kept by hand; and the Snowflake fallback's price per credit, which lives in the platform's contracted book since the
 * upgrade (decision 15).
 *
 * Who (the rights table of part 8, phase 1 – shares come with ADR 0033):
 * - A **list** book: every reader of the Costs module reads it (list prices are public).
 * - A **contracted** book of a platform: who sees the platform's amounts reads it; who may change the platform's cost
 *   plan (its managers and owning teams' members) maintains it.
 * - Any other contracted book: its owning teams' members, administrators and auditors read it – and, when it names a
 *   supplier contract, who sees that contract; without owning teams the costs managers.
 * - Maintaining a book without a platform: with owning teams their members with the designer role; without, the costs
 *   managers (administrators and designers, until the Costs module's manager role of ADR 0034).
 * - Every write is a signed-in session's (the routes), audited with before and after.
 */

export interface BookRow {
  id: string;
  name: string;
  kind: CostPriceBookKind;
  provider: string;
  supplier_id: string | null;
  supplier_contract_id: string | null;
  platform_id: string | null;
  currency: string;
  description: string;
  source: string;
  review_days: number;
  checked_at: string | null;
  checked_by: string | null;
  current_version: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

interface VersionRow {
  id: string;
  book_id: string;
  number: number;
  sha256: string;
  entry_count: number;
  diff: string | null;
  source: CostPriceVersionSource;
  note: string;
  created_at: string;
  created_by: string;
}

export interface ItemRow {
  version_id: string;
  sku_id: string;
  sku_price_id: string;
  name: string;
  service: string;
  category: string;
  driver: string;
  unit: string;
  charge: CostPriceCharge;
  price: string;
  block: number;
  currency: string | null;
  credit_sku: string | null;
  tiers: string | null;
  tier_mode: CostTierMode;
  included: string | null;
  minimum: string | null;
  valid_from: string | null;
  valid_to: string | null;
  attributes: string;
  source_note: string;
}

const ITEM_COLUMNS =
  'version_id, sku_id, sku_price_id, name, service, category, driver, unit, charge, price, block, currency, credit_sku, tiers, tier_mode, included, minimum, valid_from, valid_to, attributes, source_note';

export const entryOfRow = (r: ItemRow): CostPriceEntry => ({
  sku: r.sku_id,
  priceId: r.sku_price_id,
  name: r.name,
  service: r.service,
  category: r.category,
  driver: r.driver,
  unit: r.unit,
  charge: r.charge,
  price: r.price,
  block: Number(r.block) as CostPriceEntry['block'],
  currency: r.currency,
  creditSku: r.credit_sku,
  tiers: parseJson(r.tiers, null),
  tierMode: r.tier_mode,
  included: r.included,
  minimum: r.minimum,
  validFrom: r.valid_from,
  validTo: r.valid_to,
  attributes: parseJson(r.attributes, []),
  sourceNote: r.source_note,
});

const notFound = (id: string) => new HttpError(404, `Price book ${id} not found`, 'COST_PRICE_BOOK_NOT_FOUND', { id });

// ---------- rights ----------

/** The costs managers (ADR 0035 part 8): administrators and designers until the Costs module's manager role exists. */
export const isCostsManager = (u: AuthUser | null): boolean => !u || isAdmin(u) || u.roles.includes('designer');
/** Who uses the Costs module at all: every role that works in Steward (not status or plant viewers alone). */
export const usesCosts = (u: AuthUser | null): boolean => !u || u.roles.some((r) => r !== 'status' && r !== 'plant');

export interface BookRights {
  view: boolean;
  edit: boolean;
}

/** What `u` may do with a book (null: a job – everything). */
export function bookRights(r: BookRow, u: AuthUser | null = currentUser()): BookRights {
  if (!u) return { view: true, edit: true };
  if (!usesCosts(u)) return { view: false, edit: false };
  if (r.platform_id) {
    const info = scopeInfo('platform', r.platform_id, u);
    const edit = !!info?.canEditPlan;
    // a contracted book of a platform: who sees the platform's amounts (they read its bill already)
    const view = r.kind === 'list' ? true : edit || (!!info && info.amounts);
    return { view, edit };
  }
  const teams = owningTeams('cost_price_book', r.id);
  const edit = isAdmin(u) || (teams.length ? teamRoles(u, teams).some((m) => m.roles.includes('designer')) : isCostsManager(u));
  if (r.kind === 'list' || edit || u.roles.includes('auditor')) return { view: true, edit };
  const member = teams.length > 0 && teamRoles(u, teams).length > 0;
  const contract = !!r.supplier_contract_id && visibleContracts([r.supplier_contract_id], u).has(r.supplier_contract_id);
  return { view: member || contract || (!teams.length && isCostsManager(u)), edit };
}

/** A designer in one of their teams (adds books and calculators that its team then owns). */
export function teamDesigner(u: AuthUser | null): boolean {
  if (!u) return true;
  return [...memberships(u).values()].some((m) => m.roles.includes('designer'));
}

/**
 * Who may add a book: the costs managers and the designers of a team (the book is their team's); for a platform's
 * contracted book who may change the platform's cost plan.
 */
function mayAdd(x: { platformId: string | null }, u: AuthUser | null): boolean {
  if (x.platformId) return !!scopeInfo('platform', x.platformId, u)?.canEditPlan;
  return isCostsManager(u) || teamDesigner(u);
}

export const bookRow = (id: string): BookRow | undefined => db().get<BookRow>('SELECT * FROM cost_price_books WHERE id = ?', id);

export function requireBook(id: string, need: 'view' | 'edit' = 'view'): { row: BookRow; rights: BookRights } {
  const row = bookRow(id);
  if (!row) throw notFound(id);
  const rights = bookRights(row);
  if (!rights.view) throw notFound(id);
  if (need === 'edit' && !rights.edit)
    throw new HttpError(403, `You are not allowed to change the price book "${row.name}"`, 'FORBIDDEN', { context: 'priceBook' });
  return { row, rights };
}

/** Every book `u` may read (one statement for the books; owning teams are read once per request). */
export function visibleBooks(u: AuthUser | null = currentUser()): { row: BookRow; rights: BookRights }[] {
  return db()
    .all<BookRow>('SELECT * FROM cost_price_books ORDER BY name, id')
    .map((row) => ({ row, rights: bookRights(row, u) }))
    .filter((b) => b.rights.view);
}

// ---------- reading ----------

const reviewDue = (r: BookRow, now = Date.now()): boolean =>
  (r.source === 'manual' || r.source === 'csv') && Date.parse(r.checked_at ?? r.created_at) + Number(r.review_days) * 86_400_000 < now;

const versionIdOf = (bookId: string, n: number): string | null =>
  n > 0 ? (db().get<{ id: string }>('SELECT id FROM cost_price_book_versions WHERE book_id = ? AND number = ?', bookId, n)?.id ?? null) : null;

function names(rows: BookRow[]): { platforms: Map<string, string>; suppliers: Map<string, string>; contracts: Map<string, string> } {
  const ids = (k: 'platform_id' | 'supplier_id' | 'supplier_contract_id') => [...new Set(rows.map((r) => r[k]).filter((x): x is string => !!x))];
  const read = (table: string, col: string, list: string[]) => {
    const out = new Map<string, string>();
    for (let i = 0; i < list.length; i += 500) {
      const part = list.slice(i, i + 500);
      for (const r of db().all<{ id: string; n: string }>(`SELECT id, ${col} AS n FROM ${table} WHERE id IN (${part.map(() => '?').join(', ')})`, ...part))
        out.set(r.id, r.n);
    }
    return out;
  };
  return {
    platforms: read('platforms', 'name', ids('platform_id')),
    suppliers: read('suppliers', 'name', ids('supplier_id')),
    contracts: read('supplier_contracts', 'title', ids('supplier_contract_id')),
  };
}

function toBook(r: BookRow, rights: BookRights, n: ReturnType<typeof names>, entries: number): CostPriceBook {
  const u = currentUser();
  const contract = r.supplier_contract_id && visibleContracts([r.supplier_contract_id], u).has(r.supplier_contract_id);
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    provider: r.provider,
    currency: r.currency,
    description: r.description,
    platform: r.platform_id ? { id: r.platform_id, name: n.platforms.get(r.platform_id) ?? r.platform_id } : null,
    supplier: r.supplier_id && n.suppliers.has(r.supplier_id) ? { id: r.supplier_id, name: n.suppliers.get(r.supplier_id)! } : null,
    supplierContract: contract ? { id: r.supplier_contract_id!, title: n.contracts.get(r.supplier_contract_id!) ?? '' } : null,
    source: r.source === 'csv' ? 'csv' : 'manual',
    reviewDays: Number(r.review_days),
    checkedAt: r.checked_at,
    checkedBy: r.checked_by,
    reviewDue: reviewDue(r),
    version: Number(r.current_version),
    entries,
    owningTeams: owningTeams('cost_price_book', r.id),
    canEdit: rights.edit,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

/** The books the reader may see, with their entry counts – three statements whatever their number. */
export function listBooks(): CostPriceBook[] {
  const list = visibleBooks();
  const rows = list.map((b) => b.row);
  const counts = new Map(
    db()
      .all<{ book_id: string; number: number; entry_count: number }>('SELECT book_id, number, entry_count FROM cost_price_book_versions')
      .map((v) => [`${v.book_id}#${v.number}`, Number(v.entry_count)]),
  );
  const n = names(rows);
  return list.map((b) => toBook(b.row, b.rights, n, counts.get(`${b.row.id}#${b.row.current_version}`) ?? 0));
}

const toVersion = (v: VersionRow, inUse: Set<string>): CostPriceVersion => ({
  number: Number(v.number),
  source: v.source,
  sha256: v.sha256,
  entries: Number(v.entry_count),
  note: v.note,
  diff: summaryDiff(parseJson<CostPriceDiff | null>(v.diff, null)),
  createdAt: v.created_at,
  createdBy: v.created_by,
  inUse: inUse.has(v.id),
});

/** The list of versions carries the counts only; one version's page has the items. */
const summaryDiff = (d: CostPriceDiff | null): CostPriceDiff | null =>
  d && { ...d, items: { added: d.items.added.slice(0, 5), removed: d.items.removed.slice(0, 5), changed: d.items.changed.slice(0, 5) } };

export const ITEMS_PAGE = 500;

/**
 * One book with a page of its current items (by SKU; `q` searches SKU, name, service and driver) and its versions.
 * A fixed number of statements, whatever the number of items or versions.
 */
export function getBook(id: string, o: { offset?: number; q?: string } = {}): CostPriceBookDetail {
  const { row, rights } = requireBook(id);
  const versions = db().all<VersionRow>('SELECT * FROM cost_price_book_versions WHERE book_id = ? ORDER BY number DESC', id);
  const cur = versions.find((v) => Number(v.number) === Number(row.current_version));
  const inUse = new Set(
    db()
      .all<{ version_id: string }>(
        'SELECT DISTINCT b.version_id FROM cost_estimate_books b JOIN cost_price_book_versions v ON v.id = b.version_id WHERE v.book_id = ?',
        id,
      )
      .map((r) => r.version_id),
  );
  const offset = Math.max(0, o.offset ?? 0);
  const q = o.q?.trim().toLowerCase();
  const like = q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : null;
  const items = cur
    ? db().all<ItemRow>(
        `SELECT ${ITEM_COLUMNS} FROM cost_price_items WHERE version_id = ?${
          like
            ? " AND (LOWER(sku_id) LIKE ? ESCAPE '\\' OR LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(service) LIKE ? ESCAPE '\\' OR LOWER(driver) LIKE ? ESCAPE '\\')"
            : ''
        } ORDER BY sku_id, sku_price_id, valid_from LIMIT ? OFFSET ?`,
        cur.id,
        ...(like ? [like, like, like, like] : []),
        ITEMS_PAGE + 1,
        offset,
      )
    : [];
  return {
    ...toBook(row, rights, names([row]), cur ? Number(cur.entry_count) : 0),
    items: items.slice(0, ITEMS_PAGE).map(entryOfRow),
    more: items.length > ITEMS_PAGE,
    versions: versions.map((v) => toVersion(v, inUse)),
  };
}

/** One version: its difference to the one before (all items listed, up to the stored limit) and, optionally, its entries. */
export function getVersion(id: string, n: number): CostPriceVersion & { items: CostPriceEntry[] } {
  requireBook(id);
  const v = db().get<VersionRow>('SELECT * FROM cost_price_book_versions WHERE book_id = ? AND number = ?', id, n);
  if (!v) throw new HttpError(404, `Version ${n} not found`, 'COST_PRICE_BOOK_NOT_FOUND', { id });
  const inUse = new Set(
    db()
      .all<{ version_id: string }>('SELECT version_id FROM cost_estimate_books WHERE version_id = ?', v.id)
      .map((r) => r.version_id),
  );
  const items = db()
    .all<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM cost_price_items WHERE version_id = ? ORDER BY sku_id, sku_price_id, valid_from LIMIT ?`, v.id, ITEMS_PAGE)
    .map(entryOfRow);
  return { ...toVersion(v, inUse), diff: parseJson<CostPriceDiff | null>(v.diff, null), items };
}

/** A page of a book's current items in the order of their key (the public API and MCP): by the row id, which follows it. */
export function entriesPage(row: BookRow, q: { cursor?: string; limit: number; q?: string }): { items: CostPriceEntry[]; nextCursor: string | null } {
  const vid = versionIdOf(row.id, Number(row.current_version));
  if (!vid) return { items: [], nextCursor: null };
  const filters = { book: row.id, version: Number(row.current_version), q: q.q ?? null };
  const after = decodeCursor(q.cursor, filters);
  const needle = q.q?.trim().toLowerCase();
  const like = needle ? `%${needle.replace(/[\\%_]/g, '\\$&')}%` : null;
  const rows = db().all<ItemRow & { id: number }>(
    `SELECT id, ${ITEM_COLUMNS} FROM cost_price_items WHERE version_id = ? AND id > ?${
      like
        ? " AND (LOWER(sku_id) LIKE ? ESCAPE '\\' OR LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(service) LIKE ? ESCAPE '\\' OR LOWER(driver) LIKE ? ESCAPE '\\')"
        : ''
    } ORDER BY id LIMIT ?`,
    vid,
    after ? Number(after[0]) : 0,
    ...(like ? [like, like, like, like] : []),
    q.limit + 1,
  );
  const page = pageRows(rows, q.limit, (r) => [Number(r.id)], filters);
  return { items: page.items.map(entryOfRow), nextCursor: page.nextCursor };
}

/** Every entry of a version (writing a new version, the CSV preview). */
function entriesOf(versionId: string | null): CostPriceEntry[] {
  if (!versionId) return [];
  return db().all<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM cost_price_items WHERE version_id = ? ORDER BY sku_id, sku_price_id, valid_from`, versionId).map(entryOfRow);
}

/** The entries of the given SKUs in a version – one statement (a calculation reads each book once per round). */
export function entriesForSkus(versionId: string, skus: readonly string[]): CostPriceEntry[] {
  const want = [...new Set(skus)];
  const out: CostPriceEntry[] = [];
  for (let i = 0; i < want.length; i += 500) {
    const part = want.slice(i, i + 500);
    out.push(
      ...db()
        .all<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM cost_price_items WHERE version_id = ? AND sku_id IN (${part.map(() => '?').join(', ')})`, versionId, ...part)
        .map(entryOfRow),
    );
  }
  return out;
}

/** The ids of books' current versions (one statement). */
export function currentVersionIds(rows: readonly BookRow[]): Map<string, string> {
  const out = new Map<string, string>();
  const ids = rows.filter((r) => Number(r.current_version) > 0).map((r) => r.id);
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    for (const v of db().all<{ id: string; book_id: string }>(
      `SELECT v.id, v.book_id FROM cost_price_book_versions v JOIN cost_price_books b ON b.id = v.book_id AND v.number = b.current_version WHERE v.book_id IN (${part.map(() => '?').join(', ')})`,
      ...part,
    ))
      out.set(v.book_id, v.id);
  }
  return out;
}

// ---------- differences ----------

const diffItem = (e: CostPriceEntry, before: string | null, after: string | null, fields: string[] = []): CostPriceDiffItem => ({
  sku: e.sku,
  priceId: e.priceId,
  validFrom: e.validFrom,
  name: e.name,
  unit: e.unit,
  currency: e.currency,
  creditSku: e.creditSku,
  block: e.block,
  before,
  after,
  pct: before !== null && after !== null ? changePct(before, after) : null,
  fields,
});

const COMPARED: (keyof CostPriceEntry)[] = [
  'name',
  'service',
  'category',
  'driver',
  'unit',
  'charge',
  'block',
  'currency',
  'creditSku',
  'tiers',
  'tierMode',
  'included',
  'minimum',
  'validTo',
  'attributes',
  'sourceNote',
];

/** What changed from `before` to `after`: items added and removed, prices and other fields changed. */
export function diffEntries(before: readonly CostPriceEntry[], after: readonly CostPriceEntry[]): CostPriceDiff {
  const old = new Map(before.map((e) => [entryKey(e), e]));
  const out: CostPriceDiff = { added: 0, removed: 0, changed: 0, unchanged: 0, items: { added: [], removed: [], changed: [] } };
  const cap = COST_PRICE_LIMITS.diffListed;
  for (const e of after) {
    const k = entryKey(e);
    const was = old.get(k);
    old.delete(k);
    if (!was) {
      out.added++;
      if (out.items.added.length < cap) out.items.added.push(diffItem(e, null, e.price));
      continue;
    }
    const fields = COMPARED.filter((f) => canonicalJson(was[f]) !== canonicalJson(e[f]));
    if (was.price !== e.price || fields.length) {
      out.changed++;
      if (out.items.changed.length < cap) out.items.changed.push(diffItem(e, was.price, e.price, fields));
    } else out.unchanged++;
  }
  for (const e of old.values()) {
    out.removed++;
    if (out.items.removed.length < cap) out.items.removed.push(diffItem(e, e.price, null));
  }
  return out;
}

const hashOf = (entries: readonly CostPriceEntry[]) => sha256(canonicalJson([...entries].sort((a, b) => entryKey(a).localeCompare(entryKey(b)))));

// ---------- writing ----------

function refuseProblems(entries: readonly CostPriceEntry[]): void {
  if (entries.length > COST_PRICE_LIMITS.entriesPerVersion)
    throw new HttpError(400, `A version holds at most ${COST_PRICE_LIMITS.entriesPerVersion} entries`, 'COST_PRICE_BOOK_LIMIT', {
      max: COST_PRICE_LIMITS.entriesPerVersion,
    });
  const p = versionProblems(entries);
  const chain = p.find((x) => x.code === 'chain');
  if (chain) throw new HttpError(400, chain.message, 'COST_PRICE_CHAIN', { sku: chain.sku });
  if (p.length) throw new HttpError(400, p[0]!.message, 'COST_PRICE_ENTRIES', { sku: p[0]!.sku, message: p[0]!.message });
}

function insertItems(versionId: string, entries: readonly CostPriceEntry[]): void {
  const per = 200;
  for (let i = 0; i < entries.length; i += per) {
    const part = entries.slice(i, i + per);
    const params: unknown[] = [];
    for (const e of part)
      params.push(
        versionId,
        e.sku,
        e.priceId,
        e.name,
        e.service,
        e.category,
        e.driver,
        e.unit,
        e.charge,
        e.price,
        e.block,
        e.currency,
        e.creditSku,
        e.tiers ? JSON.stringify(e.tiers) : null,
        e.tierMode,
        e.included,
        e.minimum,
        e.validFrom,
        e.validTo,
        JSON.stringify(e.attributes),
        e.sourceNote,
      );
    db().run(
      `INSERT INTO cost_price_items (${ITEM_COLUMNS}) VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      ...params,
    );
  }
}

/** Removes the oldest versions beyond fifty, except those an estimate uses (and the current one). */
function pruneVersions(bookId: string): number {
  const old = db().all<{ id: string }>(
    `SELECT v.id FROM cost_price_book_versions v WHERE v.book_id = ? AND NOT EXISTS (SELECT 1 FROM cost_estimate_books b WHERE b.version_id = v.id)
      ORDER BY v.number DESC`,
    bookId,
  );
  const drop = old.slice(COST_PRICE_LIMITS.versionsKept).map((r) => r.id);
  for (const id of drop) {
    db().run('DELETE FROM cost_price_items WHERE version_id = ?', id);
    db().run('DELETE FROM cost_price_book_versions WHERE id = ?', id);
  }
  return drop.length;
}

export interface VersionWritten {
  version: number;
  created: boolean;
  diff: CostPriceDiff;
}

/**
 * Writes a new version when the entries differ from the current one (SHA-256 of the normalised entries); an unchanged
 * save writes nothing. Audited with the counts and the prices changed, before and after.
 */
export function writeVersion(row: BookRow, unsorted: CostPriceEntry[], source: CostPriceVersionSource, note: string, extra: Record<string, unknown> = {}): VersionWritten {
  // stored in the order of their key: pages of items follow the row id
  const entries = [...unsorted].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : entryKey(a) < entryKey(b) ? -1 : entryKey(a) > entryKey(b) ? 1 : 0));
  refuseProblems(entries);
  const curId = versionIdOf(row.id, Number(row.current_version));
  const before = entriesOf(curId);
  const sha = hashOf(entries);
  const diff = diffEntries(before, entries);
  if (curId && hashOf(before) === sha) return { version: Number(row.current_version), created: false, diff };
  const number = Number(row.current_version) + 1;
  const id = newId('cpv_');
  const now = nowIso();
  db().tx(() => {
    db().run(
      'INSERT INTO cost_price_book_versions (id, book_id, number, sha256, entry_count, diff, source, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      row.id,
      number,
      sha,
      entries.length,
      JSON.stringify(diff),
      source,
      note.slice(0, 500),
      now,
      currentActor(),
    );
    insertItems(id, entries);
    db().run('UPDATE cost_price_books SET current_version = ?, updated_at = ?, updated_by = ? WHERE id = ?', number, now, currentActor(), row.id);
    const pruned = pruneVersions(row.id);
    audit({
      action: 'cost.price_book_version_added',
      entityType: 'cost_price_book',
      entityId: row.id,
      summary: `Price book "${row.name}" version ${number} (${source}): ${diff.added} added, ${diff.changed} changed, ${diff.removed} removed`,
      details: {
        version: number,
        source,
        sha256: sha,
        entries: entries.length,
        added: diff.added,
        changed: diff.changed,
        removed: diff.removed,
        // every change of a price, before and after (the first 200; the version keeps the rest)
        prices: diff.items.changed.slice(0, 200).map((c) => ({ sku: c.sku, priceId: c.priceId, validFrom: c.validFrom, before: c.before, after: c.after })),
        addedItems: diff.items.added.slice(0, 200).map((c) => ({ sku: c.sku, priceId: c.priceId, price: c.after })),
        removedItems: diff.items.removed.slice(0, 200).map((c) => ({ sku: c.sku, priceId: c.priceId, price: c.before })),
        pruned,
        ...extra,
      },
    });
  });
  return { version: number, created: true, diff };
}

function checkBookInput(x: ReturnType<typeof costPriceBookInput.parse>): void {
  if (x.platformId) {
    const info = scopeInfo('platform', x.platformId);
    if (!info) throw new HttpError(404, `Platform ${x.platformId} not found`, 'COST_SCOPE_NOT_FOUND', { scope: 'platform', id: x.platformId });
    if (x.kind !== 'contracted') throw new HttpError(400, "A platform's book holds the prices of its contract: kind contracted", 'COST_PRICE_BOOK_KIND');
  }
  if (x.supplierContractId) {
    const c = visibleContracts([x.supplierContractId]).get(x.supplierContractId);
    if (!c) throw new HttpError(404, 'Contract not found', 'SUPPLIER_CONTRACT_NOT_FOUND', { id: x.supplierContractId });
    if (x.supplierId && c.supplierId !== x.supplierId) throw new HttpError(400, 'The contract is one of another supplier', 'COST_PRICE_BOOK_KIND');
  }
  if (x.supplierId && !db().get('SELECT 1 FROM suppliers WHERE id = ?', x.supplierId))
    throw new HttpError(404, 'Supplier not found', 'SUPPLIER_NOT_FOUND', { id: x.supplierId });
}

const snapshot = (r: Pick<BookRow, 'name' | 'kind' | 'provider' | 'currency' | 'platform_id' | 'supplier_id' | 'supplier_contract_id' | 'review_days' | 'description'>) => ({
  name: r.name,
  kind: r.kind,
  provider: r.provider,
  currency: r.currency,
  platformId: r.platform_id,
  supplierId: r.supplier_id,
  supplierContractId: r.supplier_contract_id,
  reviewDays: Number(r.review_days),
  description: r.description,
});

export function createBook(body: unknown): CostPriceBookDetail {
  const x = costPriceBookInput.parse(body);
  const u = currentUser();
  if (!mayAdd(x, u)) throw new HttpError(403, 'You are not allowed to add price books', 'FORBIDDEN', { context: 'priceBook' });
  checkBookInput(x);
  const count = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_price_books')?.n ?? 0);
  if (count >= COST_PRICE_LIMITS.books)
    throw new HttpError(409, `Steward keeps at most ${COST_PRICE_LIMITS.books} price books`, 'COST_PRICE_BOOK_LIMIT', { max: COST_PRICE_LIMITS.books });
  const id = newId('cpb_');
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO cost_price_books (id, name, kind, provider, supplier_id, supplier_contract_id, platform_id, currency, description, source, review_days, current_version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, 0, ?, ?, ?, ?)`,
      id,
      x.name,
      x.kind,
      x.provider,
      x.supplierId,
      x.supplierContractId,
      x.platformId,
      x.currency,
      x.description,
      x.reviewDays,
      now,
      currentActor(),
      now,
      currentActor(),
    );
    // a platform's book follows the platform's rights; any other gets its maker's teams
    if (!x.platformId) assignCreatorTeams('cost_price_book', id, u);
    audit({
      action: 'cost.price_book_added',
      entityType: 'cost_price_book',
      entityId: id,
      summary: `Price book "${x.name}" (${x.kind}, ${x.provider}, ${x.currency}) added`,
      details: { after: snapshot({ ...x, platform_id: x.platformId, supplier_id: x.supplierId, supplier_contract_id: x.supplierContractId, review_days: x.reviewDays }) },
    });
  });
  return getBook(id);
}

export function updateBook(id: string, body: unknown): CostPriceBookDetail {
  const { row } = requireBook(id, 'edit');
  const x = costPriceBookInput.parse(body);
  if ((x.platformId ?? null) !== (row.platform_id ?? null))
    throw new HttpError(400, 'The platform of a book cannot change – add a book for the other platform', 'COST_PRICE_BOOK_KIND');
  checkBookInput(x);
  const now = nowIso();
  db().tx(() => {
    db().run(
      `UPDATE cost_price_books SET name = ?, kind = ?, provider = ?, supplier_id = ?, supplier_contract_id = ?, currency = ?, description = ?, review_days = ?,
         updated_at = ?, updated_by = ? WHERE id = ?`,
      x.name,
      x.kind,
      x.provider,
      x.supplierId,
      x.supplierContractId,
      x.currency,
      x.description,
      x.reviewDays,
      now,
      currentActor(),
      id,
    );
    audit({
      action: 'cost.price_book_changed',
      entityType: 'cost_price_book',
      entityId: id,
      summary: `Price book "${x.name}" changed`,
      details: {
        before: snapshot(row),
        after: snapshot({ ...x, platform_id: x.platformId, supplier_id: x.supplierId, supplier_contract_id: x.supplierContractId, review_days: x.reviewDays }),
      },
    });
  });
  return getBook(id);
}

export function removeBook(id: string): void {
  const { row } = requireBook(id, 'edit');
  const used = Number(
    db().get<{ n: number }>(
      'SELECT COUNT(DISTINCT b.estimate_id) AS n FROM cost_estimate_books b JOIN cost_price_book_versions v ON v.id = b.version_id WHERE v.book_id = ?',
      id,
    )?.n ?? 0,
  );
  if (used) throw new HttpError(409, `${used} estimate(s) use this price book`, 'COST_PRICE_BOOK_IN_USE', { count: used });
  db().tx(() => {
    const versions = db().all<{ id: string }>('SELECT id FROM cost_price_book_versions WHERE book_id = ?', id);
    for (const v of versions) db().run('DELETE FROM cost_price_items WHERE version_id = ?', v.id);
    db().run('DELETE FROM cost_price_book_versions WHERE book_id = ?', id);
    db().run('DELETE FROM cost_price_review_notices WHERE book_id = ?', id);
    db().run('DELETE FROM cost_price_books WHERE id = ?', id);
    forgetOwningTeams('cost_price_book', id);
    audit({
      action: 'cost.price_book_removed',
      entityType: 'cost_price_book',
      entityId: id,
      summary: `Price book "${row.name}" removed (${versions.length} version(s))`,
      details: { before: snapshot(row), versions: versions.length },
    });
  });
}

/** A new version by hand: entries added or replaced (by SKU, price id and first day), removed – or the whole book. */
export function saveEntries(id: string, body: unknown): CostPriceBookDetail & { written: VersionWritten } {
  const { row } = requireBook(id, 'edit');
  const x = costPriceEntriesInput.parse(body);
  const incoming = x.entries.map((e) => normaliseEntry(costPriceEntryInput.parse(e)));
  let next: CostPriceEntry[];
  if (x.mode === 'replace') next = incoming;
  else {
    const map = new Map(entriesOf(versionIdOf(id, Number(row.current_version))).map((e) => [entryKey(e), e]));
    for (const r of x.remove) map.delete(entryKey(r));
    for (const e of incoming) map.set(entryKey(e), e);
    next = [...map.values()];
  }
  const written = writeVersion(row, next, 'manual', x.note);
  if (written.created) db().run("UPDATE cost_price_books SET source = 'manual' WHERE id = ? AND source = 'csv'", id);
  return { ...getBook(id), written };
}

/** "Mark as checked": the prices are still right – recorded without a new version. */
export function checkBook(id: string): CostPriceBookDetail {
  const { row } = requireBook(id, 'edit');
  const now = nowIso();
  db().tx(() => {
    db().run('UPDATE cost_price_books SET checked_at = ?, checked_by = ? WHERE id = ?', now, currentActor(), id);
    audit({
      action: 'cost.price_book_checked',
      entityType: 'cost_price_book',
      entityId: id,
      summary: `Price book "${row.name}" marked as checked (version ${row.current_version})`,
      details: { version: Number(row.current_version), before: row.checked_at },
    });
  });
  return getBook(id);
}

// ---------- the CSV import ----------

const CHARGES: ReadonlyMap<string, CostPriceCharge> = new Map([
  ['usage', 'usage'],
  ['recurring', 'recurring'],
  ['oneoff', 'oneOff'],
  ['one-off', 'oneOff'],
  ['once', 'oneOff'],
  ['setup', 'oneOff'],
]);
const BLOCKS: ReadonlyMap<string, number> = new Map([
  ['', 1],
  ['1', 1],
  ['1000', 1000],
  ['1k', 1000],
  ['1000000', 1_000_000],
  ['1m', 1_000_000],
]);

/** A decimal with the chosen separator ("1.234,50" with ",") → "1234.50"; the other separator is dropped. */
function decimalOf(s: string, decimal: '.' | ','): string {
  let out = '';
  for (const c of s.trim()) {
    if (c === decimal) out += '.';
    else if (c === (decimal === '.' ? ',' : '.') || c === ' ' || c === ' ' || c === "'") continue;
    else out += c;
  }
  return out;
}

interface ParsedFile {
  sha256: string;
  rows: number;
  columns: string[];
  entries: CostPriceEntry[];
  problems: CostPriceImportProblem[];
}

/** Reads the file with the mapping (one pass); rows with problems are reported, never stored. */
function parseFile(x: ReturnType<typeof costPriceImportInput.parse>, bookCurrency: string): ParsedFile {
  const m = x.mapping;
  let cols = new Map<CostPriceCsvField, number>();
  let columns: string[] = [];
  const entries: CostPriceEntry[] = [];
  const problems: CostPriceImportProblem[] = [];
  const rows = readCsv(x.csv, { rows: COST_PRICE_LIMITS.entriesPerVersion, columns: COST_PRICE_LIMITS.csvColumns, cellChars: 4000 }, (cells, line, index) => {
    if (index < 0) {
      columns = cells.map((c) => c.trim());
      const at = (h: string | null) => (h ? columns.findIndex((c) => c.toLowerCase() === h.toLowerCase()) : -1);
      cols = new Map();
      for (const f of COST_PRICE_CSV_FIELDS) {
        const h = m[f];
        if (!h) continue;
        const i = at(h);
        if (i < 0) throw new HttpError(400, `The file has no column "${h}"`, 'COST_PRICE_IMPORT', { column: h });
        cols.set(f, i);
      }
      return;
    }
    const cell = (f: CostPriceCsvField) => {
      const i = cols.get(f);
      return i === undefined ? '' : (cells[i] ?? '').trim();
    };
    const fail = (message: string) => problems.length < 500 && problems.push({ row: index, line, message });
    const charge = cell('charge') ? CHARGES.get(cell('charge').toLowerCase()) : 'usage';
    if (!charge) return void fail(`Charge "${cell('charge').slice(0, 40)}" is not usage, recurring or one-off`);
    const block = BLOCKS.get(cell('block').toLowerCase().replace(/[.,\s]/g, ''));
    if (!block) return void fail(`Block "${cell('block').slice(0, 40)}" is not 1, 1000 or 1000000`);
    let tiers: { from: string; price: string }[] | null = null;
    if (cell('tiers')) {
      tiers = [];
      for (const band of cell('tiers').split(';')) {
        if (!band.trim()) continue;
        const colon = band.indexOf(':');
        if (colon < 0) return void fail('Tiers are written as from:price;from:price (0:0.10;1000:0.08)');
        tiers.push({ from: decimalOf(band.slice(0, colon), m.decimal), price: decimalOf(band.slice(colon + 1), m.decimal) });
      }
    }
    const credit = cell('creditSku');
    const currency = credit ? null : (cell('currency') || m.fixedCurrency || bookCurrency).toUpperCase();
    const input = {
      sku: cell('sku'),
      priceId: cell('priceId'),
      name: cell('name') || cell('sku'),
      service: cell('service'),
      category: cell('category'),
      driver: cell('driver'),
      unit: cell('unit'),
      charge,
      price: decimalOf(cell('price'), m.decimal),
      block,
      currency,
      creditSku: credit || null,
      tiers,
      included: cell('included') ? decimalOf(cell('included'), m.decimal) : null,
      minimum: cell('minimum') ? decimalOf(cell('minimum'), m.decimal) : null,
      validFrom: cell('validFrom') || null,
      validTo: cell('validTo') || null,
      sourceNote: cell('sourceNote') || (x.fileName ? `CSV ${x.fileName.slice(0, 100)}` : ''),
    };
    const r = costPriceEntryInput.safeParse(input);
    if (!r.success) {
      const i = r.error.issues[0]!;
      return void fail(`${i.path.join('.') || 'row'}: ${i.message}`);
    }
    entries.push(normaliseEntry(r.data));
  });
  return { sha256: sha256(x.csv), rows, columns, entries, problems };
}

/** The entries an import would leave in the book (mode add: merged into the current ones). */
function importedEntries(row: BookRow, p: ParsedFile, mode: 'replace' | 'add'): { before: CostPriceEntry[]; next: CostPriceEntry[] } {
  const before = entriesOf(versionIdOf(row.id, Number(row.current_version)));
  if (mode === 'replace') return { before, next: p.entries };
  const map = new Map(before.map((e) => [entryKey(e), e]));
  for (const e of p.entries) map.set(entryKey(e), e);
  return { before, next: [...map.values()] };
}

/** What an import of this file would do – nothing is stored. */
export function previewImport(id: string, body: unknown): CostPriceImportPreview {
  const { row } = requireBook(id, 'edit');
  const x = costPriceImportInput.parse(body);
  const p = parseFile(x, row.currency);
  const { before, next } = importedEntries(row, p, x.mode);
  const problems = [...p.problems, ...versionProblems(next).map((v) => ({ row: -1, line: 0, message: v.message }))];
  return {
    fileName: x.fileName,
    sha256: p.sha256,
    rows: p.rows,
    columns: p.columns,
    entries: p.entries.length,
    problems: problems.slice(0, 200),
    diff: diffEntries(before, next),
    sample: p.entries.slice(0, 20),
  };
}

/** Imports the file as a new version: all or nothing – a file with problems is refused with the first of them. */
export function importBook(id: string, body: unknown): CostPriceBookDetail & { written: VersionWritten } {
  const { row } = requireBook(id, 'edit');
  const x = costPriceImportInput.parse(body);
  const p = parseFile(x, row.currency);
  if (p.problems.length) {
    const f = p.problems[0]!;
    throw new HttpError(400, `Line ${f.line}: ${f.message}`, 'COST_PRICE_IMPORT', { line: f.line, message: f.message, count: p.problems.length });
  }
  if (!p.entries.length) throw new HttpError(400, 'The file has no prices', 'COST_PRICE_IMPORT', { line: 0, message: 'no rows', count: 0 });
  const { next } = importedEntries(row, p, x.mode);
  const written = writeVersion(row, next, 'csv', x.fileName ? `CSV ${x.fileName.slice(0, 200)}` : 'CSV', {
    fileName: x.fileName,
    fileSha256: p.sha256,
    rows: p.rows,
    mode: x.mode,
  });
  if (written.created) db().run("UPDATE cost_price_books SET source = 'csv' WHERE id = ?", id);
  return { ...getBook(id), written };
}

// ---------- the Snowflake fallback's price per credit (decision 15) ----------

export const CREDIT_SKU = 'compute-credit';

/** The platform's contracted book (the oldest, if there are several). */
const platformBook = (platformId: string): BookRow | undefined =>
  db().get<BookRow>("SELECT * FROM cost_price_books WHERE platform_id = ? AND kind = 'contracted' ORDER BY created_at, id LIMIT 1", platformId);

/**
 * The price per credit the fallback multiplies METERING_DAILY_HISTORY's credits with: the entry `compute-credit` (or
 * the first priced in `{credit}`) of the platform's contracted book valid on `day`; null when there is none.
 */
export function snowflakeCreditPrice(platformId: string, day = nowIso().slice(0, 10)): { price: string; currency: string } | null {
  const b = platformBook(platformId);
  if (!b || !Number(b.current_version)) return null;
  const vid = versionIdOf(b.id, Number(b.current_version));
  if (!vid) return null;
  const rows = db()
    .all<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM cost_price_items WHERE version_id = ? AND (sku_id = ? OR unit = '{credit}') AND currency IS NOT NULL ORDER BY CASE WHEN sku_id = ? THEN 0 ELSE 1 END, sku_id, valid_from`,
      vid,
      CREDIT_SKU,
      CREDIT_SKU,
    )
    .map(entryOfRow)
    .filter((e) => (!e.validFrom || e.validFrom <= day) && (!e.validTo || e.validTo >= day) && !e.tiers);
  const e = rows[0];
  return e && e.currency ? { price: e.price, currency: e.currency } : null;
}

/**
 * The cost source's form still sets the price per credit (0.9 clients and the source dialog): it becomes a version of
 * the platform's contracted book – made when there is none yet. Runs inside the caller's transaction.
 */
export function setCreditPrice(platformId: string, platformName: string, price: string | null, currency: string): void {
  let b = platformBook(platformId);
  if (!b && price === null) return;
  const now = nowIso();
  if (!b) {
    const id = newId('cpb_');
    db().run(
      `INSERT INTO cost_price_books (id, name, kind, provider, platform_id, currency, description, source, review_days, current_version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, 'contracted', 'Snowflake', ?, ?, '', 'manual', 90, 0, ?, ?, ?, ?)`,
      id,
      `${platformName} – contracted prices`.slice(0, 120),
      platformId,
      currency,
      now,
      currentActor(),
      now,
      currentActor(),
    );
    audit({
      action: 'cost.price_book_added',
      entityType: 'cost_price_book',
      entityId: id,
      summary: `Price book "${platformName} – contracted prices" added for the price per credit of the cost source`,
      details: { after: { kind: 'contracted', provider: 'Snowflake', platformId, currency } },
    });
    b = bookRow(id)!;
  }
  const current = entriesOf(versionIdOf(b.id, Number(b.current_version)));
  const rest = current.filter((e) => e.sku !== CREDIT_SKU);
  const old = current.find((e) => e.sku === CREDIT_SKU && !e.validFrom);
  const next =
    price === null
      ? rest
      : [
          ...rest.filter((e) => !(e.sku === CREDIT_SKU)),
          ...current.filter((e) => e.sku === CREDIT_SKU && e.validFrom),
          {
            ...(old ?? {
              sku: CREDIT_SKU,
              priceId: '',
              name: 'Compute credit',
              service: 'Compute',
              category: 'Analytics',
              driver: 'credits',
              unit: '{credit}',
              charge: 'usage' as const,
              block: 1 as const,
              creditSku: null,
              tiers: null,
              tierMode: 'graduated' as const,
              included: null,
              minimum: null,
              validFrom: null,
              validTo: null,
              attributes: [],
              sourceNote: 'Cost source: price per credit (fallback)',
            }),
            price,
            currency,
          },
        ];
  writeVersion(b, next, 'manual', 'The price per credit of the cost source');
}

// ---------- "Prices to review" (cost.price_review_due) ----------

let reviewsChecked = 0;

/**
 * Books kept by hand whose review is due: their maintainers get "Prices to review" in the app, once per book and due
 * date (at most hourly). Maintainers: who may change the book (without administrators when there are others).
 */
export function checkPriceReviews(now = Date.now(), force = false): number {
  if (!force && now - reviewsChecked < 3600_000) return 0;
  if (!vault().unlocked) return 0;
  reviewsChecked = now;
  const due = db()
    .all<BookRow>("SELECT * FROM cost_price_books WHERE source IN ('manual', 'csv') AND current_version > 0")
    .filter((r) => reviewDue(r, now));
  if (!due.length) return 0;
  const users = listUsers()
    .filter((u) => u.active)
    .map((u) => ({ u, au: toAuthUser(u) }));
  let sent = 0;
  for (const r of due) {
    const dueOn = new Date(Date.parse(r.checked_at ?? r.created_at) + Number(r.review_days) * 86_400_000).toISOString().slice(0, 10);
    const claimed =
      db().run('INSERT INTO cost_price_review_notices (book_id, due_on, sent_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', r.id, dueOn, nowIso()).changes === 1;
    if (!claimed) continue;
    try {
      const maintainers = users.filter((x) => bookRights(r, x.au).edit);
      const others = maintainers.filter((x) => !x.u.roles.includes('admin'));
      const recipients = (others.length ? others : maintainers).map((x) => x.u);
      if (!recipients.length) continue;
      notify({
        event: 'cost.price_review_due',
        personal: true,
        text: (l: Locale) => ({
          title: t(l, 'priceReview.title', { book: titleName(r.name) }),
          body: t(l, 'priceReview.body', { book: r.name, days: String(r.review_days), checked: (r.checked_at ?? r.created_at).slice(0, 10) }),
        }),
        link: `/costs/price-books/${encodeURIComponent(r.id)}`,
        recipients,
        inAppKey: `cost.price_review_due:${r.id}:${dueOn}`,
        externalKey: `cost.price_review_due:${r.id}:${dueOn}`,
        data: { bookId: r.id, book: r.name, dueOn },
      });
      sent++;
    } catch (err) {
      logger.warn({ err, bookId: r.id }, 'price review reminder could not be sent');
    }
  }
  return sent;
}

/** The platform rows of contracted books, for the reader's book choice (pricing.ts). */
export type PlatformAcl = AclEntry<PlatformPermission>[];
