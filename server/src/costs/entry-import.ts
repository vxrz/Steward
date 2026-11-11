import crypto from 'node:crypto';
import {
  COST_ENTRY_IMPORT_LIMITS,
  COST_PLAN_LIMITS,
  ISO_4217_CODES,
  costEntryImportInput,
  fiscalYearBounds,
  fiscalYearLabel,
  fiscalYearOf,
  fitsCurrency,
  fromMicros,
  moneyText,
  normaliseImportAmount,
  parseImportDate,
  toMicros,
  type CostEntryImportMapping,
  type CostEntryImportPreview,
  type CostEntryImportRecord,
  type CostEntryImportRow,
  type CostEntryImports,
  type CostImportProblem,
  type CostPlanTarget,
  type CostPlanYear,
  type SupplierRef,
  type SupplierStatus,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentActor } from '../auth/context.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { contractEditable, coverChosenContract, supplierVisible, visibleContracts } from '../suppliers/links.js';
import { ScopeCtx, checkSideCover } from '../suppliers/contract-scope.js';
import { csvRows } from './csv.js';
import { requireScope } from './access.js';
import {
  insertEntry,
  lineTitle,
  ownerCatalogue,
  ownerCol,
  ownerValues,
  planYearOf,
  requireEditOf,
  startMonth,
  targetOf,
  type EntryValues,
  type LineRow,
  type OwnerRef,
} from './plans.js';

/**
 * CSV import of cost entries (0.18.0, ADR 0030 part 6, docs/COSTS.md#importing-entries-csv) on the reader of csv.ts:
 * map the columns, preview every row with what it becomes and its problems, import the rows without problems (a
 * duplicate only when ticked) in one transaction, keep the import as a record, remove it as a whole. Who may change
 * the service; a signed-in session (routes.ts). Audited once per import (`cost.entries_imported`, `cost.import_removed`).
 *
 * Duplicate rule: the service has an entry – or an earlier row of the file has one – with the same reference (letter
 * case and surrounding spaces aside, not empty), date, amount and currency. A row without a reference cannot be
 * checked and is marked "No reference", not left out.
 *
 * 0.19.0 (ADR 0032): the same for a platform's own cost plan (`OwnerRef`); its rows name no application or system, and a
 * contract must cover the platform – or the person may add the platform to it.
 */

const asOwner = (x: string | OwnerRef): OwnerRef => (typeof x === 'string' ? { kind: 'service', id: x } : x);

const LIMITS = { rows: COST_ENTRY_IMPORT_LIMITS.rows, columns: COST_ENTRY_IMPORT_LIMITS.columns, cellChars: COST_ENTRY_IMPORT_LIMITS.cellChars };

interface Parsed {
  header: string[];
  rows: { cells: string[]; line: number; index: number }[];
}

function parse(csv: string): Parsed {
  if (Buffer.byteLength(csv, 'utf8') > COST_ENTRY_IMPORT_LIMITS.bytes)
    throw new HttpError(413, 'The file is larger than 5 MB', 'COST_ENTRY_IMPORT_TOO_LARGE', { maxMb: 5 });
  const out: Parsed = { header: [], rows: [] };
  const it = csvRows(csv, LIMITS);
  for (;;) {
    const r = it.next();
    if (r.done) break;
    if (r.value.index < 0) out.header = r.value.cells.map((c) => c.trim());
    else out.rows.push(r.value);
  }
  if (!out.header.length) throw new HttpError(400, 'The file has no header row', 'COST_ENTRY_IMPORT_EMPTY');
  return out;
}

const sha = (csv: string) => crypto.createHash('sha256').update(csv, 'utf8').digest('hex');
const norm = (s: string) => s.trim().toLowerCase();

function sameFile(o: OwnerRef, sha256: string): CostEntryImportPreview['sameFile'] {
  const r = db().get<{ id: string; file_name: string; created_at: string }>(
    `SELECT id, file_name, created_at FROM cost_entry_imports WHERE ${ownerCol(o)} = ? AND sha256 = ? ORDER BY created_at DESC LIMIT 1`,
    o.id,
    sha256,
  );
  return r ? { id: r.id, fileName: r.file_name, createdAt: r.created_at } : null;
}

interface SupplierRow {
  id: string;
  name: string;
  status: SupplierStatus;
  owners: string;
  aliases: string;
}

/** What the rows are read against: the service's lines, the suppliers and contracts the person may see, its targets, its entries. */
function lookups(o: OwnerRef) {
  const lines = db().all<LineRow>(`SELECT * FROM cost_plan_lines WHERE ${ownerCol(o)} = ?`, o.id);
  const suppliers = db()
    .all<SupplierRow>('SELECT id, name, status, owners, aliases FROM suppliers')
    .filter((r) => supplierVisible(r));
  const all = db()
    .all<{ id: string; supplier_id: string; title: string; reference: string }>('SELECT id, supplier_id, title, reference FROM supplier_contracts')
    .filter((c) => suppliers.some((s) => s.id === c.supplier_id));
  // the contracts the person may see (ADR 0031), read in bulk
  const seen = visibleContracts(all.map((c) => c.id));
  const contracts = all.filter((c) => seen.has(c.id));
  const cat = ownerCatalogue(o);
  const names = new Map<string, CostPlanTarget>();
  for (const [kind, ids] of [
    ['application', cat.apps],
    ['system', cat.systems],
  ] as const)
    for (const id of ids) {
      const t = targetOf(kind, id, cat);
      if (t && t.visible && !t.gone) names.set(`${kind}|${norm(t.name)}`, t);
    }
  const existing = db().all<{ entry_date: string; amount: number; currency: string; reference: string }>(
    `SELECT entry_date, amount, currency, reference FROM cost_entries WHERE ${ownerCol(o)} = ? AND reference <> ''`,
    o.id,
  );
  // a contract line's title as the person reads it ("contract – schedule" when they may see the contract, plans.ts)
  const lineContracts = visibleContracts(lines.map((l) => l.supplier_contract_id));
  const shown = new Map(lines.map((l) => [l.id, lineTitle(l, lineContracts)]));
  return { lines, shown, suppliers, contracts, names, existing };
}

const dupKey = (reference: string, date: string, amount: number, currency: string) => `${norm(reference)}|${date}|${amount}|${currency}`;

interface Resolved {
  row: CostEntryImportRow;
  values: EntryValues | null;
  /** A named contract that does not cover the service yet, which the person may add it to (on import) */
  cover: string | null;
}

/** Every row with what it becomes and its problems (nothing stored). */
function resolve(o: OwnerRef, p: Parsed, m: CostEntryImportMapping): Resolved[] {
  const start = startMonth();
  const col = (name: string | null) => {
    if (!name) return -1;
    const i = p.header.findIndex((h) => h === name.trim());
    if (i < 0) throw new HttpError(400, `The file has no column "${name}"`, 'COST_ENTRY_IMPORT_COLUMN', { column: name });
    return i;
  };
  const c = {
    date: col(m.date),
    amount: col(m.amount),
    currency: col(m.currency),
    reference: col(m.reference),
    note: col(m.note),
    planLine: col(m.planLine),
    supplier: col(m.supplier),
    contract: col(m.contract),
    target: col(m.target),
  };
  const L = lookups(o);
  // a named contract must cover the service (or platform) – or the person may add it (who may change the contract and
  // sees the service or platform), as in the entry form (suppliers/links.ts resolveSupplierContract)
  const covering = new Set(
    db()
      .all<{ contract_id: string }>(
        o.kind === 'service'
          ? 'SELECT contract_id FROM supplier_contract_services WHERE service_id = ?'
          : 'SELECT contract_id FROM supplier_contract_platforms WHERE platform_id = ?',
        o.id,
      )
      .map((r) => r.contract_id),
  );
  const ctx = new ScopeCtx();
  const mayCover = new Map<string, boolean>();
  const mayAdd = (id: string) => {
    if (!mayCover.has(id))
      mayCover.set(
        id,
        (o.kind === 'service' ? ctx.seesService(o.id) : ctx.seesPlatform(o.id)) &&
          contractEditable(
            L.contracts.find((k) => k.id === id)!,
            undefined,
            ctx.u,
            ctx,
          ),
      );
    return mayCover.get(id)!;
  };
  // a platform added on the side: never a grant to another team (security review 0.19.0 M1)
  const sideOk = new Map<string, boolean>();
  const mayAddSide = (id: string) => {
    if (o.kind !== 'platform') return true;
    if (!sideOk.has(id)) {
      try {
        checkSideCover(id, o.id);
        sideOk.set(id, true);
      } catch {
        sideOk.set(id, false);
      }
    }
    return sideOk.get(id)!;
  };
  const seen = new Set(L.existing.map((e) => dupKey(e.reference, e.entry_date, Number(e.amount), e.currency)));
  // entries per fiscal year so far, against the limit of 2,000
  const inYear = new Map<number, number>();
  const countYear = (fy: number) => {
    if (!inYear.has(fy)) {
      const b = fiscalYearBounds(fy, start);
      inYear.set(
        fy,
        Number(
          db().get<{ n: number }>(`SELECT COUNT(*) AS n FROM cost_entries WHERE ${ownerCol(o)} = ? AND entry_date >= ? AND entry_date < ?`, o.id, b.from, b.to)
            ?.n ?? 0,
        ),
      );
    }
    return inYear.get(fy)!;
  };
  const cell = (cells: string[], i: number) => (i >= 0 ? (cells[i] ?? '').trim() : '');
  const out = p.rows.map((r): Resolved => {
    const problems: CostImportProblem[] = [];
    const rawDate = cell(r.cells, c.date);
    const date = rawDate ? parseImportDate(rawDate, m.dateFormat) : null;
    if (!rawDate) problems.push('noDate');
    else if (!date) problems.push('badDate');
    const text = normaliseImportAmount(cell(r.cells, c.amount), m.decimal);
    const micros = text === null ? null : toMicros(text);
    if (micros === null) problems.push('notNumber');
    else if (micros === 0) problems.push('zero');
    const currencyText = (c.currency >= 0 ? cell(r.cells, c.currency) : (m.fixedCurrency ?? '')).toUpperCase();
    const currency = currencyText && ISO_4217_CODES.has(currencyText) ? currencyText : null;
    if (!currencyText) problems.push('noCurrency');
    else if (!currency) problems.push('unknownCurrency');
    if (micros !== null && micros !== 0 && currency && !fitsCurrency(micros, currency)) problems.push('decimals');
    const fy = date ? fiscalYearOf(date, start) : null;
    // supplier and contract: a name or a spelling, a title or a number – only those the person may see
    let supplier: SupplierRow | undefined;
    const supText = cell(r.cells, c.supplier);
    if (supText) {
      supplier = L.suppliers.find((s) => norm(s.name) === norm(supText) || parseJson<string[]>(s.aliases, []).some((a) => norm(a) === norm(supText)));
      if (!supplier) problems.push('supplierUnknown');
      else if (supplier.status === 'archived') problems.push('supplierArchived');
    }
    let contract: { id: string; supplier_id: string; title: string } | undefined;
    const conText = cell(r.cells, c.contract);
    if (conText) {
      const matches = L.contracts.filter(
        (k) => (!supplier || k.supplier_id === supplier.id) && (norm(k.title) === norm(conText) || (!!k.reference && norm(k.reference) === norm(conText))),
      );
      contract = matches.length === 1 ? matches[0] : undefined;
      if (!contract) problems.push('contractUnknown');
      else {
        if (!supplier) supplier = L.suppliers.find((s) => s.id === contract!.supplier_id);
        if (!covering.has(contract.id) && !mayAdd(contract.id)) problems.push('contractNotCovering');
        else if (!covering.has(contract.id) && !mayAddSide(contract.id)) problems.push('contractPlatformGrant');
      }
    }
    // the plan line: named (title or id), or the only line of the contract in that year and currency, else unplanned
    let line: LineRow | undefined;
    const lineText = cell(r.cells, c.planLine);
    if (lineText) {
      const named = L.lines.filter((l) => l.id === lineText || norm(l.title) === norm(lineText) || norm(L.shown.get(l.id)!) === norm(lineText));
      line = named.find((l) => Number(l.fiscal_year) === fy && l.currency === currency) ?? named[0];
      if (!line) problems.push('planLineUnknown');
      else if (fy !== null && Number(line.fiscal_year) !== fy) problems.push('planLineOtherYear');
      else if (currency && line.currency !== currency) problems.push('planLineCurrency');
    } else if (contract && fy !== null && currency) {
      const ofContract = L.lines.filter((l) => l.supplier_contract_id === contract!.id && Number(l.fiscal_year) === fy && l.currency === currency);
      if (ofContract.length === 1) line = ofContract[0];
    }
    let target: CostPlanTarget | null = null;
    const tText = cell(r.cells, c.target);
    if (tText) {
      target = L.names.get(`application|${norm(tText)}`) ?? L.names.get(`system|${norm(tText)}`) ?? null;
      if (!target) problems.push('targetUnknown');
    }
    // supplier and contract default to the plan line's
    const supplierId = supplier?.id ?? (line && !supText ? line.supplier_id : null) ?? null;
    const contractId = contract?.id ?? (line && !conText && !supText ? line.supplier_contract_id : null) ?? null;
    const reference = cell(r.cells, c.reference).slice(0, COST_PLAN_LIMITS.referenceChars);
    const note = cell(r.cells, c.note).slice(0, COST_PLAN_LIMITS.noteChars);
    const noReference = !reference;
    let duplicate = false;
    if (!problems.length && date && micros !== null && currency && reference) {
      const k = dupKey(reference, date, micros, currency);
      duplicate = seen.has(k);
      seen.add(k);
    }
    // what the row becomes: the named supplier and contract, else the plan line's (when the person may see them)
    const shownSupplier = supplier ?? (supplierId ? L.suppliers.find((x) => x.id === supplierId) : undefined);
    const shownContract = contract ?? (contractId ? L.contracts.find((x) => x.id === contractId) : undefined);
    const ref = shownSupplier ? ({ id: shownSupplier.id, name: shownSupplier.name, status: shownSupplier.status } as SupplierRef) : null;
    const row: CostEntryImportRow = {
      index: r.index,
      line: r.line,
      date,
      amount: micros === null ? null : fromMicros(micros),
      currency,
      fiscalYear: fy,
      label: fy === null ? null : fiscalYearLabel(fy, start),
      planLine: line ? { id: line.id, title: L.shown.get(line.id)! } : null,
      supplier: ref,
      contract: shownContract ? { id: shownContract.id, title: shownContract.title } : null,
      target,
      reference,
      note,
      problems,
      duplicate,
      noReference,
    };
    const values: EntryValues | null =
      !problems.length && date && micros !== null && currency
        ? {
            date,
            amount: micros,
            currency,
            planLineId: line?.id ?? null,
            target: target ? { kind: target.kind, id: target.id } : line?.target_kind && line.target_id ? { kind: line.target_kind, id: line.target_id } : null,
            supplierId,
            supplierContractId: contractId,
            reference,
            note,
          }
        : null;
    return { row, values, cover: values && contract && !covering.has(contract.id) ? contract.id : null };
  });
  // the limit of entries per service and fiscal year: rows that would pass it are a problem (duplicates not counted)
  for (const x of out)
    if (x.values && !x.row.duplicate && x.row.fiscalYear !== null) {
      const n = countYear(x.row.fiscalYear);
      if (n >= COST_PLAN_LIMITS.entriesPerYear) {
        x.row.problems.push('limit');
        x.values = null;
      } else inYear.set(x.row.fiscalYear, n + 1);
    }
  return out;
}

/** POST /api/costs/plans/:serviceId/entries/import/preview – every row with what it becomes; nothing is stored. */
export function previewEntryImport(owner: string | OwnerRef, body: unknown): CostEntryImportPreview {
  const o = asOwner(owner);
  requireEditOf(o);
  const x = costEntryImportInput.parse(body);
  const p = parse(x.csv);
  const rows = resolve(o, p, x.mapping).map((r) => r.row);
  const s = sha(x.csv);
  return {
    fileName: x.fileName,
    sha256: s,
    bytes: Buffer.byteLength(x.csv, 'utf8'),
    header: p.header,
    rows,
    counts: {
      rows: rows.length,
      ready: rows.filter((r) => !r.problems.length && !r.duplicate).length,
      problems: rows.filter((r) => r.problems.length).length,
      duplicates: rows.filter((r) => r.duplicate).length,
    },
    sameFile: sameFile(o, s),
  };
}

/**
 * POST /api/costs/plans/:serviceId/entries/import – the rows without problems (duplicates only when ticked), in one
 * transaction, as one import record; the file is read again, never taken from the preview.
 */
export function importEntries(owner: string | OwnerRef, body: unknown): CostPlanYear & { importId: string; added: number; skipped: Record<string, number> } {
  const o = asOwner(owner);
  const info = requireEditOf(o);
  const x = costEntryImportInput.parse(body);
  const p = parse(x.csv);
  const include = new Set(x.include);
  const resolved = resolve(o, p, x.mapping);
  const take = resolved.filter((r) => r.values && (!r.row.duplicate || include.has(r.row.index)));
  const skipped: Record<string, number> = {};
  for (const r of resolved) {
    if (take.includes(r)) continue;
    const reason = r.row.problems[0] ?? (r.row.duplicate ? 'duplicate' : 'other');
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  }
  if (!take.length)
    throw new HttpError(400, 'No row of the file can be imported', 'COST_ENTRY_IMPORT_NOTHING', { skipped: Object.values(skipped).reduce((a, b) => a + b, 0) });
  const s = sha(x.csv);
  const id = newId('cei_');
  const sums = new Map<string, number>();
  for (const r of take) sums.set(r.values!.currency, (sums.get(r.values!.currency) ?? 0) + r.values!.amount);
  const start = startMonth();
  db().tx(() => {
    db().run(
      `INSERT INTO cost_entry_imports (id, service_id, platform_id, file_name, sha256, rows, added, skipped, mapping, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      ownerValues(o).service_id,
      ownerValues(o).platform_id,
      x.fileName,
      s,
      p.rows.length,
      take.length,
      JSON.stringify(skipped),
      JSON.stringify(x.mapping),
      nowIso(),
      currentActor(),
    );
    for (const r of take) {
      insertEntry(o, r.values!, id);
      // a named contract that did not cover the service covers it now (audited on the supplier, once)
      coverChosenContract(r.cover, null, o, currentActor());
    }
    // 100 import records per service: older ones keep their entries and lose "Remove import"
    const old = db()
      .all<{ id: string }>(`SELECT id FROM cost_entry_imports WHERE ${ownerCol(o)} = ? ORDER BY created_at DESC, id DESC`, o.id)
      .slice(COST_ENTRY_IMPORT_LIMITS.importsKept);
    for (const o of old) db().run('DELETE FROM cost_entry_imports WHERE id = ?', o.id);
    audit({
      action: 'cost.entries_imported',
      entityType: o.kind,
      entityId: o.id,
      summary: `${take.length} cost entr${take.length === 1 ? 'y' : 'ies'} imported into "${info.name}" from ${x.fileName || 'a CSV file'} (${p.rows.length} row(s), ${p.rows.length - take.length} left out): ${[...sums.entries()].map(([c, v]) => moneyText(v, c)).join(', ')}`,
      details: {
        importId: id,
        fileName: x.fileName,
        sha256: s,
        mapping: x.mapping,
        rows: p.rows.length,
        added: take.length,
        skipped,
        duplicatesIncluded: take.filter((r) => r.row.duplicate).length,
        sums: Object.fromEntries([...sums.entries()].map(([c, v]) => [c, fromMicros(v)])),
      },
    });
  });
  const years = take.map((r) => fiscalYearOf(r.values!.date, start));
  const fy = years.sort((a, b) => b - a)[0]!;
  return { ...planYearOf(info, fy, Date.now(), start), importId: id, added: take.length, skipped };
}

interface ImportRow {
  id: string;
  file_name: string;
  sha256: string;
  rows: number;
  added: number;
  skipped: string;
  mapping: string;
  created_at: string;
  created_by: string;
  removed_at: string | null;
  removed_by: string | null;
}

/** GET /api/costs/plans/:serviceId/imports – the import records (newest first) and the last mapping. */
export function listEntryImports(owner: string | OwnerRef): CostEntryImports {
  const o = asOwner(owner);
  const info = requireScope(o.kind, o.id);
  const rows = db().all<ImportRow>(`SELECT * FROM cost_entry_imports WHERE ${ownerCol(o)} = ? ORDER BY created_at DESC, id DESC`, o.id);
  const counts = new Map(
    db()
      .all<{ import_id: string; n: number }>(
        `SELECT import_id, COUNT(*) AS n FROM cost_entries WHERE ${ownerCol(o)} = ? AND import_id IS NOT NULL GROUP BY import_id`,
        o.id,
      )
      .map((r) => [r.import_id, Number(r.n)]),
  );
  const imports: CostEntryImportRecord[] = rows.map((r) => ({
    id: r.id,
    fileName: r.file_name,
    sha256: r.sha256,
    rows: Number(r.rows),
    added: Number(r.added),
    skipped: parseJson<Record<string, number>>(r.skipped, {}),
    mapping: parseJson<CostEntryImportMapping>(r.mapping, {} as CostEntryImportMapping),
    createdAt: r.created_at,
    createdBy: r.created_by,
    removedAt: r.removed_at,
    removedBy: r.removed_by,
    entries: counts.get(r.id) ?? 0,
  }));
  return { imports, lastMapping: imports[0]?.mapping ?? null, canEdit: info.canEditPlan };
}

/** DELETE /api/costs/plans/:serviceId/imports/:importId – "Remove import": its entries that are still there, in one step. */
export function removeEntryImport(owner: string | OwnerRef, importId: string): CostEntryImports {
  const o = asOwner(owner);
  const info = requireEditOf(o);
  const r = db().get<ImportRow>(`SELECT * FROM cost_entry_imports WHERE id = ? AND ${ownerCol(o)} = ?`, importId, o.id);
  if (!r) throw new HttpError(404, `Import ${importId} not found`, 'COST_ENTRY_IMPORT_NOT_FOUND', { id: importId });
  if (r.removed_at) throw new HttpError(409, 'This import was removed already', 'COST_ENTRY_IMPORT_REMOVED');
  db().tx(() => {
    const removed = db().run(`DELETE FROM cost_entries WHERE import_id = ? AND ${ownerCol(o)} = ?`, importId, o.id).changes;
    db().run('UPDATE cost_entry_imports SET removed_at = ?, removed_by = ? WHERE id = ?', nowIso(), currentActor(), importId);
    audit({
      action: 'cost.import_removed',
      entityType: o.kind,
      entityId: o.id,
      summary: `Import of ${r.file_name || 'a CSV file'} removed from "${info.name}": ${removed} cost entr${removed === 1 ? 'y' : 'ies'} removed`,
      details: { importId, fileName: r.file_name, sha256: r.sha256, entriesRemoved: removed, added: Number(r.added) },
    });
  });
  return listEntryImports(o);
}
