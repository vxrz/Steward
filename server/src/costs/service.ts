import {
  COST_LIMITS,
  costSourceOfKind,
  costImportInput,
  costSourceInput,
  fromMicros,
  toMicros,
  type CostImport,
  type CostImportMode,
  type CostImportPreview,
  type CostSourceSettings,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentActor, currentUser, type AuthUser } from '../auth/context.js';
import { HttpError, newId, nowIso } from '../util.js';
import { requireScope, scopeInfo } from './access.js';
import { parseFocusAsync, summarize, type ParsedFocus } from './focus.js';
import { ingest, mapLines, mapper, remap, tagKeyOf, type IngestResult } from './store.js';

/**
 * Cost sources per platform and FOCUS file imports (#226, docs/COSTS.md#sources). Who may manage a platform sets how
 * its costs are read and imports files for it; who may see its costs sees the settings.
 */

interface SourceRow {
  platform_id: string;
  enabled: number;
  tag_key: string;
  credit_price: string | null;
  credit_currency: string | null;
  currency: string | null;
  last_read_at: string | null;
  last_read_error: string | null;
  last_read_note: string | null;
  updated_at: string;
  updated_by: string;
}

export const sourceRow = (platformId: string): SourceRow | undefined => db().get<SourceRow>('SELECT * FROM cost_sources WHERE platform_id = ?', platformId);

function platformRow(id: string): { id: string; name: string; kind: string } {
  const p = db().get<{ id: string; name: string; kind: string }>('SELECT id, name, kind FROM platforms WHERE id = ?', id);
  if (!p) throw new HttpError(404, `Platform ${id} not found`, 'COST_SCOPE_NOT_FOUND', { scope: 'platform', id });
  return p;
}

export function getSource(platformId: string): CostSourceSettings {
  const info = requireScope('platform', platformId);
  const p = platformRow(platformId);
  const r = sourceRow(platformId);
  return {
    platformId,
    platformName: p.name,
    platformKind: p.kind,
    source: costSourceOfKind(p.kind),
    enabled: !!r?.enabled,
    tagKey: tagKeyOf(platformId),
    creditPrice: r?.credit_price ?? null,
    creditCurrency: r?.credit_currency ?? null,
    currency: r?.currency ?? null,
    lastReadAt: r?.last_read_at ?? null,
    lastReadError: r?.last_read_error ?? null,
    lastReadNote: r?.last_read_note ?? null,
    updatedAt: r?.updated_at ?? null,
    updatedBy: r?.updated_by ?? null,
    canManage: info.canManageSource,
  };
}

function requireManage(platformId: string, what: string) {
  const info = requireScope('platform', platformId);
  if (!info.canManageSource) throw new HttpError(403, `You are not allowed to ${what}`, 'PLATFORM_MANAGE_FORBIDDEN', { name: info.name });
  return info;
}

/** Changes how a platform's costs are read (its manage right). Audited with before and after; links the lines again. */
export function setSource(platformId: string, body: unknown): CostSourceSettings {
  const info = requireManage(platformId, 'change how the costs of this platform are read');
  const x = costSourceInput.parse(body);
  const p = platformRow(platformId);
  const before = sourceRow(platformId);
  const price = x.creditPrice ? fromMicros(toMicros(x.creditPrice)!) : null;
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO cost_sources (platform_id, enabled, tag_key, credit_price, credit_currency, currency, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (platform_id) DO UPDATE SET enabled = excluded.enabled, tag_key = excluded.tag_key, credit_price = excluded.credit_price,
         credit_currency = excluded.credit_currency, currency = excluded.currency, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      platformId,
      x.enabled ? 1 : 0,
      x.tagKey,
      price,
      price ? (x.creditCurrency ?? 'USD') : null,
      x.currency,
      now,
      currentActor(),
    );
    audit({
      action: 'cost.source_changed',
      entityType: 'platform',
      entityId: platformId,
      summary: `Cost source of "${info.name}" ${x.enabled ? 'on' : 'off'}: tag ${x.tagKey}${price ? `, ${price} ${x.creditCurrency ?? 'USD'} per credit` : ''}${x.currency ? `, currency ${x.currency}` : ''}`,
      details: {
        before: before
          ? {
              enabled: !!before.enabled,
              tagKey: before.tag_key,
              creditPrice: before.credit_price,
              creditCurrency: before.credit_currency,
              currency: before.currency,
            }
          : null,
        after: { enabled: x.enabled, tagKey: x.tagKey, creditPrice: price, creditCurrency: price ? (x.creditCurrency ?? 'USD') : null, currency: x.currency },
      },
    });
  });
  // a new tag key links the lines anew
  if (before?.tag_key !== x.tagKey) remap(platformId, costSourceOfKind(p.kind));
  return getSource(platformId);
}

/** Notes the outcome of a read on the platform's source (no audit: reads happen daily; corrections are audited). */
export function noteRead(platformId: string, r: { error: string | null; note?: string | null; at?: string }): void {
  const at = r.at ?? nowIso();
  db().run(
    `INSERT INTO cost_sources (platform_id, enabled, tag_key, last_read_at, last_read_error, last_read_note, updated_at, updated_by) VALUES (?, 0, 'application', ?, ?, ?, ?, 'system')
     ON CONFLICT (platform_id) DO UPDATE SET last_read_at = excluded.last_read_at, last_read_error = excluded.last_read_error,
       last_read_note = COALESCE(excluded.last_read_note, cost_sources.last_read_note)`,
    platformId,
    at,
    r.error ? r.error.slice(0, 500) : null,
    r.note ?? null,
    at,
  );
}

// ---------- FOCUS imports ----------

interface ImportRow {
  id: string;
  platform_id: string;
  file_name: string;
  sha256: string;
  bytes: number;
  row_count: number;
  line_count: number;
  period_start: string | null;
  period_end: string | null;
  mode: CostImportMode;
  via: 'ui' | 'push';
  actor: string;
  imported_at: string;
}

const toImport = (r: ImportRow): CostImport => ({
  id: r.id,
  platformId: r.platform_id,
  fileName: r.file_name,
  sha256: r.sha256,
  bytes: Number(r.bytes),
  rows: Number(r.row_count),
  lines: Number(r.line_count),
  periodStart: r.period_start,
  periodEnd: r.period_end,
  mode: r.mode,
  via: r.via,
  actor: r.actor,
  importedAt: r.imported_at,
});

export function listImports(platformId: string): CostImport[] {
  requireScope('platform', platformId);
  return db()
    .all<ImportRow>('SELECT * FROM cost_imports WHERE platform_id = ? ORDER BY imported_at DESC, id DESC LIMIT ?', platformId, COST_LIMITS.importsListed)
    .map(toImport);
}

/** Lines of earlier imports on this platform in the file's days (what mode "replace" removes). */
function replaced(platformId: string, p: ParsedFocus): number {
  if (!p.periodStart || !p.periodEnd) return 0;
  return Number(
    db().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM cost_records WHERE source_platform_id = ? AND source = 'focus' AND charge_period_start >= ? AND charge_period_start < ?",
      platformId,
      p.periodStart,
      p.periodEnd,
    )?.n ?? 0,
  );
}

/**
 * The preview counts as linked only lines of applications the caller may see: one they may not see (tied to the
 * platform, say) counts as unassigned, like a name no application has – the preview never tells whether it exists.
 */
async function previewOf(platformId: string, p: ParsedFocus, fileName: string): Promise<CostImportPreview> {
  const u = currentUser();
  const links = await mapLines(mapper(platformId, 'focus', u), p.lines);
  const seen = new Map<string, boolean>();
  const visible = (id: string) => {
    if (!seen.has(id)) seen.set(id, !!scopeInfo('application', id, u));
    return seen.get(id)!;
  };
  let assigned = 0;
  for (const l of links) if (l.applicationId && visible(l.applicationId)) assigned++;
  const dup = db().get<ImportRow>('SELECT * FROM cost_imports WHERE platform_id = ? AND sha256 = ? ORDER BY imported_at DESC LIMIT 1', platformId, p.sha256);
  return {
    fileName,
    sha256: p.sha256,
    bytes: p.bytes,
    rows: p.rows,
    lines: p.lines.length,
    columns: p.columns,
    periodStart: p.periodStart,
    periodEnd: p.periodEnd,
    ...summarize(p),
    assigned,
    unassigned: p.lines.length - assigned,
    warnings: p.warnings,
    duplicateOf: dup ? { id: dup.id, importedAt: dup.imported_at, fileName: dup.file_name } : null,
    replacesLines: replaced(platformId, p),
  };
}

/** What an import of this file would do – nothing is stored. */
export async function previewImport(platformId: string, body: unknown): Promise<CostImportPreview> {
  requireManage(platformId, 'import costs for this platform');
  const x = costImportInput.parse(body);
  return previewOf(platformId, await parseFocusAsync(x.csv), x.fileName);
}

export interface ImportOutcome {
  import: CostImport;
  result: IngestResult;
  warnings: string[];
}

/**
 * Imports a FOCUS file for a platform. The same file (SHA-256) twice is refused. Mode "replace" (default) replaces
 * the lines of earlier imports for the file's days – a corrected file; changed figures of closed periods are audited
 * as corrections. Audited with the file's SHA-256, size, rows, period and totals. Lines link with the rights of
 * `importer` (the signed-in user; a push: the token's creator – store.ts, mapper). Reading and linking give the
 * event loop a turn now and then; the writing is one transaction.
 */
export async function importFile(
  platformId: string,
  input: { csv: string; fileName: string; mode: CostImportMode },
  via: { kind: 'ui' } | { kind: 'push'; tokenId: string; tokenName: string; ip: string },
  actor = currentActor(),
  importer: AuthUser | null = currentUser(),
): Promise<ImportOutcome> {
  const p = await parseFocusAsync(input.csv);
  const links = await mapLines(mapper(platformId, 'focus', importer), p.lines);
  // after the pauses above: nothing awaits from here to the end of the transaction
  const pl = platformRow(platformId);
  const dup = db().get<{ id: string; imported_at: string }>(
    'SELECT id, imported_at FROM cost_imports WHERE platform_id = ? AND sha256 = ? LIMIT 1',
    platformId,
    p.sha256,
  );
  if (dup)
    throw new HttpError(409, `This file was imported before (${dup.imported_at.slice(0, 10)})`, 'COST_IMPORT_DUPLICATE', {
      importedAt: dup.imported_at,
      id: dup.id,
    });
  if (!p.lines.length) throw new HttpError(400, 'The file has no cost lines Steward can read', 'COST_IMPORT_EMPTY');
  const id = newId('cimp_');
  const now = nowIso();
  const totals = summarize(p).totals;
  let result!: IngestResult;
  db().tx(() => {
    db().run(
      `INSERT INTO cost_imports (id, platform_id, file_name, sha256, bytes, row_count, line_count, period_start, period_end, mode, via, token_id, actor, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      platformId,
      input.fileName.slice(0, 200),
      p.sha256,
      p.bytes,
      p.rows,
      p.lines.length,
      p.periodStart,
      p.periodEnd,
      input.mode,
      via.kind,
      via.kind === 'push' ? via.tokenId : null,
      actor,
      now,
    );
    result = ingest({
      sourcePlatformId: platformId,
      sourceName: pl.name,
      source: 'focus',
      lines: p.lines.map((l) => ({ ...l, key: `${id}|${l.key}` })),
      links,
      window: input.mode === 'replace' && p.periodStart && p.periodEnd ? { from: p.periodStart, to: p.periodEnd } : null,
      actor,
      importId: id,
      now,
    });
    audit({
      action: 'cost.imported',
      actor,
      entityType: 'platform',
      entityId: platformId,
      summary: `FOCUS file ${input.fileName ? `"${input.fileName.slice(0, 100)}" ` : ''}imported for "${pl.name}"${via.kind === 'push' ? ` by push token "${via.tokenName}"` : ''}: ${p.lines.length} line(s) from ${p.rows} row(s), ${totals.map((t) => `${t.effective} ${t.currency}`).join(', ')}${result.removed ? `, ${result.removed} earlier line(s) replaced` : ''}`,
      details: {
        importId: id,
        fileName: input.fileName,
        sha256: p.sha256,
        bytes: p.bytes,
        rows: p.rows,
        lines: p.lines.length,
        periodStart: p.periodStart,
        periodEnd: p.periodEnd,
        mode: input.mode,
        via: via.kind,
        ...(via.kind === 'push' ? { tokenId: via.tokenId, ip: via.ip } : {}),
        totals,
        replaced: result.removed,
      },
    });
  });
  noteRead(platformId, { error: null, at: now });
  const row = db().get<ImportRow>('SELECT * FROM cost_imports WHERE id = ?', id)!;
  return { import: toImport(row), result, warnings: p.warnings };
}

/** The import of the web app (who may manage the platform). */
export async function importFromUi(platformId: string, body: unknown): Promise<ImportOutcome> {
  requireManage(platformId, 'import costs for this platform');
  const x = costImportInput.parse(body);
  return importFile(platformId, { csv: x.csv, fileName: x.fileName, mode: x.mode }, { kind: 'ui' });
}
