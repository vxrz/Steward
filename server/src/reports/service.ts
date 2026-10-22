import fs from 'node:fs';
import path from 'node:path';
import { BRAND, type ReportBranding, type ReportLang, type ReportRecord, type ReportVerification, type RunStatus } from '@sm/shared';
import { config } from '../config.js';
import { db } from '../db.js';
import { audit, authenticRows } from '../audit.js';
import { runRow } from '../engine/store.js';
import { HttpError, newId, nowIso, parseJson, sha256, slugify } from '../util.js';
import { getBranding, logo } from './branding.js';
import { resolveTimeZone, translator } from './i18n.js';
import { buildRunModel, contentHash, evidenceImages, person, type ReportContext, type RunReportModel } from './model.js';
import { renderRunReport, type RenderResult } from './run-report.js';
import { buildSummaryModel, renderSummaryReport } from './summary-report.js';

/**
 * Generation, storage and listing of archived PDF reports.
 *
 * Every generation writes a new file reports/<runId>/<reportId>.pdf (or
 * reports/summary/<reportId>.pdf), never overwriting an existing one, stores
 * an immutable record and writes "report.generated" with the file's SHA-256
 * into the HMAC-chained audit log – that entry is what makes an archived copy
 * verifiable later.
 */

export const reportsDir = (): string => path.join(config.dataDir, 'reports');

/** Runs that are finished; waiting/interrupted runs get an interim report. */
const FINISHED: RunStatus[] = ['succeeded', 'failed', 'cancelled'];
const INTERIM_OK: RunStatus[] = ['waiting', 'interrupted'];

interface Row {
  id: string;
  kind: 'run' | 'summary';
  run_id: string | null;
  process_ids: string;
  version: number;
  title: string;
  lang: ReportLang;
  comment: string | null;
  classification: string;
  interim: number;
  auto: number;
  period_from: string | null;
  period_to: string | null;
  created_by: string;
  created_at: string;
  path: string;
  filename: string;
  sha256: string;
  size: number;
  protocol_hash: string | null;
  content_hash: string;
}

const toRecord = (r: Row): ReportRecord => ({
  id: r.id,
  kind: r.kind,
  runId: r.run_id,
  processIds: parseJson<string[]>(r.process_ids, []),
  version: r.version,
  title: r.title,
  lang: r.lang,
  comment: r.comment,
  classification: r.classification,
  interim: !!r.interim,
  auto: !!r.auto,
  createdBy: r.created_by,
  createdAt: r.created_at,
  filename: r.filename,
  sha256: r.sha256,
  size: r.size,
  protocolHash: r.protocol_hash,
  contentHash: r.content_hash,
  from: r.period_from,
  to: r.period_to,
});

export function listRunReports(runId: string): ReportRecord[] {
  return db().all<Row>('SELECT * FROM reports WHERE run_id = ? ORDER BY created_at DESC, version DESC', runId).map(toRecord);
}

export function listSummaryReports(limit = 200): ReportRecord[] {
  return db().all<Row>("SELECT * FROM reports WHERE kind = 'summary' ORDER BY created_at DESC LIMIT ?", limit).map(toRecord);
}

export function getReport(id: string): ReportRecord & { file: string } {
  const r = db().get<Row>('SELECT * FROM reports WHERE id = ?', id);
  if (!r) throw new HttpError(404, `Report ${id} not found`);
  return { ...toRecord(r), file: path.join(reportsDir(), ...r.path.split('/')) };
}

export function resolveLang(explicit?: string | null, userLocale?: string | null): ReportLang {
  const pick = (v?: string | null) => (v ? (v.toLowerCase().startsWith('de') ? 'de' : v.toLowerCase().startsWith('en') ? 'en' : null) : null);
  return pick(explicit) ?? pick(userLocale) ?? 'en';
}

// Generations of the same run are serialized so version numbers stay unique.
const locks = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(key, next);
  void next.finally(() => {
    if (locks.get(key) === next) locks.delete(key);
  }).catch(() => undefined);
  return next;
}

function brandingInput(override?: Partial<ReportBranding>) {
  const branding = { ...getBranding(), ...(override ?? {}) };
  return { branding, logo: logo().data };
}

function writeOnce(rel: string, data: Buffer): void {
  const file = path.join(reportsDir(), ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data, { flag: 'wx' }); // never overwrite
  if (process.platform !== 'win32') fs.chmodSync(file, 0o400); // read-only, for the service account only
}

function store(rec: ReportRecord, rel: string, pdf: Buffer, details: Record<string, unknown>, summary: string): ReportRecord {
  writeOnce(rel, pdf);
  try {
    db().tx(() => {
      db().run(
        `INSERT INTO reports (id, kind, run_id, process_ids, version, title, lang, comment, classification, interim, auto, period_from, period_to,
           created_by, created_at, path, filename, sha256, size, protocol_hash, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        rec.id,
        rec.kind,
        rec.runId ?? null,
        JSON.stringify(rec.processIds),
        rec.version,
        rec.title,
        rec.lang,
        rec.comment ?? null,
        rec.classification,
        rec.interim ? 1 : 0,
        rec.auto ? 1 : 0,
        rec.from ?? null,
        rec.to ?? null,
        rec.createdBy,
        rec.createdAt,
        rel,
        rec.filename,
        rec.sha256,
        rec.size,
        rec.protocolHash ?? null,
        rec.contentHash,
      );
      audit({
        actor: rec.createdBy,
        action: 'report.generated',
        entityType: 'report',
        entityId: rec.id,
        runId: rec.runId ?? null,
        summary,
        details: {
          kind: rec.kind,
          sha256: rec.sha256,
          size: rec.size,
          filename: rec.filename,
          lang: rec.lang,
          version: rec.version,
          interim: rec.interim,
          auto: rec.auto,
          classification: rec.classification,
          contentHash: rec.contentHash,
          protocolHash: rec.protocolHash ?? undefined,
          comment: rec.comment ? rec.comment.slice(0, 1000) : undefined,
          ...details,
        },
      });
    });
  } catch (e) {
    fs.rmSync(path.join(reportsDir(), ...rel.split('/')), { force: true });
    throw e;
  }
  return rec;
}

export interface GenerateOptions {
  lang?: ReportLang;
  comment?: string | null;
  classification?: string | null;
  timeZone?: string | null;
  /** Username of the person generating the report ("system" for automatic reports) */
  actor: string;
  auto?: boolean;
  /** Tests: uncompressed content streams */
  compress?: boolean;
}

function context(o: GenerateOptions, reportId: string, version: number): ReportContext {
  const b = getBranding();
  return {
    reportId,
    version,
    generatedAt: nowIso(),
    generatedBy: person(o.actor),
    lang: o.lang ?? 'en',
    timeZone: resolveTimeZone(o.timeZone),
    classification: (o.classification ?? '').trim() || b.classification,
    comment: o.comment?.trim() || null,
  };
}

export function runReportFilename(processName: string, runId: string, createdAt: string, version: number): string {
  return `${BRAND.name}-${slugify(processName)}-${runId}-${createdAt.slice(0, 10)}${version > 1 ? `-v${version}` : ''}.pdf`;
}

export async function generateRunReport(runId: string, o: GenerateOptions): Promise<ReportRecord & { texts: string[] }> {
  return serialized(`run:${runId}`, async () => {
    const run = runRow(runId);
    if (!FINISHED.includes(run.status) && !INTERIM_OK.includes(run.status)) {
      throw new HttpError(409, `The run is ${run.status}. Reports can be generated when it has finished or is waiting for a decision.`);
    }
    const version = (db().get<{ v: number | null }>('SELECT MAX(version) AS v FROM reports WHERE run_id = ?', runId)?.v ?? 0) + 1;
    const id = newId('rpt_');
    const model = buildRunModel(runId, context(o, id, version));
    const hash = contentHash(model);
    const res = await renderRunReport(model, hash, brandingInput(), { images: evidenceImages(model), compress: o.compress });
    const tr = translator(model.lang, model.timeZone);
    const rec: ReportRecord = {
      id,
      kind: 'run',
      runId,
      processIds: [model.process.id],
      version,
      title: `${tr.t('runReport')}: ${model.process.name}`,
      lang: model.lang,
      comment: model.comment,
      classification: model.classification,
      interim: model.interim,
      auto: !!o.auto,
      createdBy: model.generatedBy.username,
      createdAt: model.generatedAt,
      filename: runReportFilename(model.process.name, runId, model.generatedAt, version),
      sha256: sha256(res.pdf),
      size: res.pdf.length,
      protocolHash: model.integrity.sealedHash ?? model.integrity.currentHash,
      contentHash: hash,
    };
    store(
      rec,
      `${runId}/${id}.pdf`,
      res.pdf,
      { processId: model.process.id, runStatus: model.run.status, dryRun: model.run.dryRun },
      `${o.auto ? 'Automatic ' : ''}PDF run report v${version} (${rec.lang}${rec.interim ? ', interim' : ''}) generated for "${model.process.name}" – sha256 ${rec.sha256.slice(0, 16)}…`,
    );
    return { ...rec, texts: res.texts };
  });
}

export interface SummaryOptions extends GenerateOptions {
  processIds: string[];
  from: string;
  to: string;
  title?: string | null;
}

export async function generateSummaryReport(o: SummaryOptions): Promise<ReportRecord & { texts: string[] }> {
  const from = new Date(o.from);
  const to = new Date(o.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new HttpError(400, 'Invalid period');
  if (to <= from) throw new HttpError(400, 'The end of the period must be after its start');
  if (!o.processIds.length) throw new HttpError(400, 'Select at least one process');
  const id = newId('rpt_');
  const model = buildSummaryModel({ processIds: o.processIds, from: from.toISOString(), to: to.toISOString(), title: o.title }, context(o, id, 1));
  const hash = contentHash(model);
  const res = await renderSummaryReport(model, hash, brandingInput(), { compress: o.compress });
  const tr = translator(model.lang, model.timeZone);
  const scope = model.processes.length === 1 ? slugify(model.processes[0]!.name) : `${model.processes.length}-processes`;
  const rec: ReportRecord = {
    id,
    kind: 'summary',
    runId: null,
    processIds: model.processes.map((p) => p.id),
    version: 1,
    title: model.title ?? `${tr.t('summaryReport')}: ${model.processes.map((p) => p.name).join(', ')}`.slice(0, 300),
    lang: model.lang,
    comment: model.comment,
    classification: model.classification,
    interim: false,
    auto: false,
    createdBy: model.generatedBy.username,
    createdAt: model.generatedAt,
    filename: `${BRAND.name}-summary-${scope}-${model.from.slice(0, 10)}_${model.to.slice(0, 10)}-${id.slice(-6)}.pdf`,
    sha256: sha256(res.pdf),
    size: res.pdf.length,
    protocolHash: null,
    contentHash: hash,
    from: model.from,
    to: model.to,
  };
  store(
    rec,
    `summary/${id}.pdf`,
    res.pdf,
    { processIds: rec.processIds, from: rec.from, to: rec.to, runs: model.totals.runs },
    `PDF summary report (${rec.lang}) generated for ${model.processes.length} process(es), ${model.totals.runs} run(s) – sha256 ${rec.sha256.slice(0, 16)}…`,
  );
  return { ...rec, texts: res.texts };
}

// ---------- verification ----------

interface GeneratedEntry {
  seq: number;
  ts: string;
  actor: string;
  entity_id: string | null;
  run_id: string | null;
  details: string | null;
}

/**
 * Finds the report.generated audit entry of a PDF: by its SHA-256, or – for a
 * copy that was signed later (signatures are appended as incremental
 * updates) – by the SHA-256 of its first <recorded size> bytes.
 */
export function findGenerated(data: Buffer): { match: 'exact' | 'signed-copy'; entry: GeneratedEntry; forged: number } | { match: null; forged: number } | null {
  // Only authentic entries count (HMAC and chain position checked): a row inserted into the database
  // with the SHA-256 of a forged PDF must not make that PDF verify.
  let forged = 0;
  const lookup = (hash: string): GeneratedEntry | undefined => {
    const r = authenticRows(`action = 'report.generated' AND ${db().jsonText('details', 'sha256')} = ? AND seq >= 1`, [hash], { ascending: true, limit: 20 });
    forged += r.rejected;
    return r.rows[0];
  };
  const exact = lookup(sha256(data));
  if (exact) return { match: 'exact', entry: exact, forged };
  if (!data.subarray(0, 5).equals(Buffer.from('%PDF-'))) return forged ? { match: null, forged } : null;
  const sizes = db()
    .all<{ size: number }>(
      `SELECT DISTINCT CAST(${db().jsonText('details', 'size')} AS INTEGER) AS size FROM audit_log WHERE action = 'report.generated' AND seq >= 1 AND CAST(${db().jsonText('details', 'size')} AS INTEGER) < ?`,
      data.length,
    )
    .map((r) => Number(r.size))
    .filter((n) => n > 0);
  for (const size of sizes) {
    // the original ends with %%EOF; an incremental update follows it
    if (!data.subarray(Math.max(0, size - 7), size).toString('latin1').includes('%%EOF')) continue;
    const entry = lookup(sha256(data.subarray(0, size)));
    if (entry) return { match: 'signed-copy', entry, forged };
  }
  return forged ? { match: null, forged } : null;
}

export function verificationOf(data: Buffer, found: ReturnType<typeof findGenerated>, chain?: ReportVerification['auditChain']): ReportVerification {
  if (!found || !found.match) return { match: 'unknown', sha256: sha256(data), auditChain: chain, ...(found?.forged ? { forgedEntries: found.forged } : {}) };
  const d = parseJson<{ kind?: string; filename?: string; sha256: string; size: number }>(found.entry.details, { sha256: '', size: 0 });
  const stored = !!db().get('SELECT 1 FROM reports WHERE id = ?', found.entry.entity_id);
  return {
    ...(found.forged ? { forgedEntries: found.forged } : {}),
    match: found.match,
    sha256: sha256(data),
    report: {
      id: found.entry.entity_id ?? '',
      kind: d.kind ?? 'run',
      runId: found.entry.run_id,
      filename: d.filename,
      sha256: d.sha256,
      size: d.size,
      generatedAt: found.entry.ts,
      generatedBy: found.entry.actor,
      auditSeq: Number(found.entry.seq),
      stored,
    },
    auditChain: chain,
  };
}

// ---------- branding preview ----------

/** A sample run report with invented data and the given (unsaved) branding. Not stored, not audited. */
export async function previewReport(o: { lang: ReportLang; actor: string; branding?: Partial<ReportBranding>; timeZone?: string | null }): Promise<RenderResult> {
  const tr = translator(o.lang, o.timeZone);
  const now = Date.now();
  const iso = (offsetS: number) => new Date(now - 3600_000 + offsetS * 1000).toISOString();
  const fake = (seed: string) => sha256(seed);
  const ctx = context({ ...o, comment: o.lang === 'de' ? 'Stichprobe geprüft, keine Auffälligkeiten.' : 'Spot-checked, no findings.' }, 'rpt_SAMPLE', 1);
  ctx.classification = (o.branding?.classification ?? '').trim() || ctx.classification;
  const actor = ctx.generatedBy;
  const model: RunReportModel = {
    ...ctx,
    kind: 'run',
    sample: true,
    interim: false,
    run: {
      id: 'run_SAMPLE',
      status: 'succeeded',
      error: null,
      dryRun: false,
      trigger: 'manual',
      scheduleName: null,
      parentRunId: null,
      actor,
      startedAt: iso(0),
      finishedAt: iso(95),
      durationMs: 95000,
      stats: { steps: 6, failedSteps: 0, writes: 2, skippedWrites: 0, checksPassed: 1, checksFailed: 1, openTasks: 0 },
    },
    process: { id: 'sample', name: tr.t('sampleProcess'), version: 3, definitionHash: fake('definition'), description: tr.t('sampleNote') },
    connections: [{ slot: 'hub', platformName: 'Insights Hub (production)', kind: 'insights-hub', environment: 'production' }],
    inputs: [{ name: 'days', label: 'Inactive for (days)', value: '90' }],
    steps: [
      { startedAt: iso(1), key: 'users', depth: 0, name: 'List all users', type: 'http', status: 'succeeded', result: 'GET /Users → 200 (148 items)', durationMs: 820, failed: false },
      { startedAt: iso(3), key: 'inactive', depth: 0, name: 'Find inactive users', type: 'set', status: 'succeeded', result: 'inactive = [2 items]', durationMs: 4, failed: false },
      { startedAt: iso(4), key: 'pick', depth: 0, name: 'Confirm removal', type: 'userTask', status: 'succeeded', result: 'Approved', durationMs: 80000, failed: false },
      { startedAt: iso(85), key: 'remove[0]/del', depth: 1, name: 'Remove from group', type: 'http', status: 'succeeded', result: 'DELETE … → 204', durationMs: 310, failed: false },
      { startedAt: iso(86), key: 'remove[1]/del', depth: 1, name: 'Remove from group', type: 'http', status: 'succeeded', result: 'DELETE … → 204', durationMs: 290, failed: false },
      { startedAt: iso(90), key: 'check', depth: 0, name: 'No admin removed', type: 'check', status: 'succeeded', result: 'Passed', durationMs: 2, failed: false },
    ],
    stepsOmitted: 0,
    writes: [
      { startedAt: iso(85), name: 'Remove from group', method: 'DELETE', url: 'https://gateway.eu1.mindsphere.io/api/identitymanagement/v3/Groups/g-1/members/u-17', status: 'succeeded', httpStatus: 204, result: '' },
      { startedAt: iso(86), name: 'Remove from group', method: 'DELETE', url: 'https://gateway.eu1.mindsphere.io/api/identitymanagement/v3/Groups/g-1/members/u-42', status: 'succeeded', httpStatus: 204, result: '' },
    ],
    decisions: [
      {
        title: 'Remove 2 inactive users from "Engineers"?',
        mode: 'select',
        status: 'completed',
        instructions: null,
        decidedBy: { username: 'adam', displayName: 'Adam Approver' },
        decidedAt: iso(84),
        approved: true,
        selectedCount: 2,
        total: 3,
        comment: o.lang === 'de' ? 'Mit Teamleitung abgestimmt.' : 'Agreed with the team lead.',
        fourEyes: true,
        startedBy: actor,
        assignees: ['team:service desk'],
        columns: ['User', 'Last login'],
        items: [
          { selected: true, cells: ['jane.doe@example.com', '2026-02-11'] },
          { selected: true, cells: ['max.muster@example.com', '2026-01-30'] },
          { selected: false, cells: ['oncall@example.com', '2026-03-02'] },
        ],
        itemsOmitted: 0,
      },
    ],
    checks: [
      { name: 'No admin removed', passed: true, severity: 'error', message: 'Passed' },
      { name: 'Review group empty', passed: false, severity: 'warning', message: '1 user still flagged' },
    ],
    sections: [],
    evidence: [],
    errors: [],
    integrity: { sealedHash: fake('protocol'), currentHash: fake('protocol'), intact: true },
    audit: [
      { seq: 101, ts: iso(0), actor: actor.username, action: 'run.started', summary: 'Run started (manual)', hash: fake('a1') },
      { seq: 102, ts: iso(84), actor: 'adam', action: 'task.completed', summary: 'Decision: 2 of 3 selected', hash: fake('a2') },
      { seq: 105, ts: iso(95), actor: actor.username, action: 'run.succeeded', summary: 'Run succeeded', hash: fake('a3') },
    ],
    auditOmitted: 0,
  };
  return renderRunReport(model, contentHash(model), brandingInput(o.branding));
}
