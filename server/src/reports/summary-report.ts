import type { RunStats, RunStatus } from '@sm/shared';
import { db } from '../db.js';
import { sealedProtocolHash } from '../audit.js';
import { parseJson } from '../util.js';
import { ReportWriter, type CellInput } from './pdf/engine.js';
import { translator } from './i18n.js';
import { PRODUCT, chrome, langTag, statusTone, type BrandingInput } from './common.js';
import { LIMITS, person, personLabel, type Person, type ReportContext } from './model.js';
import { signOff, type RenderResult } from './run-report.js';

/** Periodic summary ("Access reviews Q3"): runs of one or more processes in a period, with totals. */
export interface SummaryReportModel extends ReportContext {
  kind: 'summary';
  title: string | null;
  from: string;
  to: string;
  processes: { id: string; name: string }[];
  totals: Totals;
  byProcess: ({ id: string; name: string } & Totals)[];
  runs: {
    id: string;
    processName: string;
    status: RunStatus;
    dryRun: boolean;
    actor: Person;
    startedAt: string;
    finishedAt: string | null;
    decisions: number;
    changes: number;
    checksFailed: number;
    protocolHash: string | null;
  }[];
  runsOmitted: number;
}

interface Totals {
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  open: number;
  dryRuns: number;
  decisions: number;
  changes: number;
  checksFailed: number;
}

const zero = (): Totals => ({ runs: 0, succeeded: 0, failed: 0, cancelled: 0, open: 0, dryRuns: 0, decisions: 0, changes: 0, checksFailed: 0 });

export function buildSummaryModel(o: { processIds: string[]; from: string; to: string; title?: string | null }, ctx: ReportContext): SummaryReportModel {
  const ids = [...new Set(o.processIds)];
  const marks = ids.map(() => '?').join(',');
  const rows = db().all<{
    id: string;
    process_id: string;
    process_name: string;
    status: RunStatus;
    dry_run: number;
    actor: string;
    started_at: string;
    finished_at: string | null;
    stats: string;
    decisions: number;
    protocol_hash: string | null;
  }>(
    `SELECT r.id, r.process_id, r.process_name, r.status, r.dry_run, r.actor, r.started_at, r.finished_at, r.stats,
       (SELECT COUNT(*) FROM run_tasks t WHERE t.run_id = r.id AND t.status = 'completed') AS decisions,
       NULL AS protocol_hash
     FROM runs r WHERE r.process_id IN (${marks}) AND r.started_at >= ? AND r.started_at < ? ORDER BY r.started_at, r.rowid`,
    ...ids,
    o.from,
    o.to,
  );
  const names = new Map(
    db()
      .all<{ id: string; name: string }>(`SELECT id, name FROM processes WHERE id IN (${marks})`, ...ids)
      .map((p) => [p.id, p.name]),
  );
  for (const r of rows) if (!names.has(r.process_id)) names.set(r.process_id, r.process_name);
  const processes = ids.map((id) => ({ id, name: names.get(id) ?? id })).sort((a, b) => a.name.localeCompare(b.name));

  const totals = zero();
  const per = new Map(processes.map((p) => [p.id, { ...p, ...zero() }]));
  const add = (tt: Totals, r: (typeof rows)[number], s: RunStats) => {
    tt.runs++;
    if (r.status === 'succeeded') tt.succeeded++;
    else if (r.status === 'failed') tt.failed++;
    else if (r.status === 'cancelled') tt.cancelled++;
    else tt.open++;
    if (r.dry_run) tt.dryRuns++;
    tt.decisions += r.decisions;
    tt.changes += s.writes ?? 0;
    tt.checksFailed += s.checksFailed ?? 0;
  };
  const runs = rows.map((r) => {
    const s = parseJson<Partial<RunStats>>(r.stats, {}) as RunStats;
    add(totals, r, s);
    add(per.get(r.process_id)!, r, s);
    return {
      id: r.id,
      processName: names.get(r.process_id) ?? r.process_name,
      status: r.status,
      dryRun: !!r.dry_run,
      actor: person(r.actor),
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      decisions: r.decisions,
      changes: s.writes ?? 0,
      checksFailed: s.checksFailed ?? 0,
      // only from an authentic audit entry (HMAC and chain position checked)
      protocolHash: sealedProtocolHash(r.id),
    };
  });
  return {
    ...ctx,
    kind: 'summary',
    title: o.title?.trim() || null,
    from: o.from,
    to: o.to,
    processes,
    totals,
    byProcess: [...per.values()],
    runs: runs.slice(0, LIMITS.summaryRuns),
    runsOmitted: Math.max(0, runs.length - LIMITS.summaryRuns),
  };
}

export async function renderSummaryReport(
  m: SummaryReportModel,
  contentHash: string,
  brand: BrandingInput,
  o: { compress?: boolean } = {},
): Promise<RenderResult> {
  const tr = translator(m.lang, m.timeZone);
  const { t } = tr;
  const period = `${tr.dateTime(m.from)} – ${tr.dateTime(m.to)}`;
  const heading = m.title ?? t('summaryReport');
  const w = new ReportWriter(
    {
      title: `${heading}: ${tr.date(m.from)} – ${tr.date(m.to)}`,
      author: m.generatedBy.displayName,
      subject: `${t('summaryReport')} – ${m.processes.map((p) => p.name).join(', ')}`.slice(0, 400),
      keywords: [PRODUCT.split(' ')[0]!, t('summaryReport'), ...m.processes.map((p) => p.name)],
      creator: PRODUCT,
      producer: `${PRODUCT} (PDFKit)`,
      lang: langTag(m.lang),
      createdAt: new Date(m.generatedAt),
      custom: {
        reportId: m.reportId,
        reportKind: 'summary',
        processIds: m.processes.map((p) => p.id).join(','),
        periodFrom: m.from,
        periodTo: m.to,
        runCount: String(m.totals.runs),
        contentHash,
        classification: m.classification,
        generatedBy: m.generatedBy.username,
        generatedAt: m.generatedAt,
      },
    },
    chrome(tr, brand, {
      shortTitle: heading,
      classification: m.classification,
      tags: [],
      lines: () => [
        t('footerSummary', {
          count: m.processes.length,
          from: tr.date(m.from),
          to: tr.date(m.to),
          date: tr.dateTime(m.generatedAt),
          user: personLabel(m.generatedBy),
          reportId: m.reportId,
        }),
        `${t('contentHash')}: ${contentHash}`,
        t('footerVerifySummary', { reportId: m.reportId }),
      ],
    }),
    { accent: brand.branding.accentColor, compress: o.compress },
  );

  w.cover({
    title: heading,
    subtitle: period,
    meta: [t('generatedWith', { product: PRODUCT }), t('reportNo', { id: m.reportId }), tr.dateTime(m.generatedAt)],
  });

  let n = 0;
  const section = (title: string) => w.section(`${++n}. ${title}`);
  section(t('scope'));
  w.keyValues([
    { label: t('period'), value: period, span: 2 },
    { label: t('timeZone'), value: tr.timeZone },
    { label: t('runs'), value: String(m.totals.runs) },
    { label: t('processes'), value: m.processes.map((p) => p.name).join('\n'), span: 2 },
  ]);
  w.subheading(t('totals'));
  const tt = m.totals;
  w.stats([
    { label: t('runs'), value: String(tt.runs) },
    { label: t('succeeded'), value: String(tt.succeeded), tone: tt.succeeded ? 'success' : 'default' },
    { label: t('failedRuns'), value: String(tt.failed), tone: tt.failed ? 'danger' : 'default' },
    { label: t('cancelledRuns'), value: String(tt.cancelled) },
    { label: t('openRuns'), value: String(tt.open), tone: tt.open ? 'info' : 'default' },
    { label: t('dryRuns'), value: String(tt.dryRuns), tone: tt.dryRuns ? 'warning' : 'default' },
    { label: t('decisionsCount'), value: String(tt.decisions) },
    { label: t('changesCount'), value: String(tt.changes) },
    { label: t('checksFailed'), value: String(tt.checksFailed), tone: tt.checksFailed ? 'danger' : 'default' },
  ]);

  section(t('byProcess'));
  w.table(
    [
      { header: t('process'), width: 2.8 },
      { header: t('colRuns'), width: 1.2, align: 'right' },
      { header: t('succeeded'), width: 1.3, align: 'right' },
      { header: t('colFailed'), width: 1.3, align: 'right' },
      { header: t('colOpen'), width: 1.3, align: 'right' },
      { header: t('decisionsShort'), width: 1.2, align: 'right' },
      { header: t('changesShort'), width: 1.35, align: 'right' },
      { header: t('checksFailed'), width: 1.25, align: 'right' },
    ],
    m.byProcess.map((p): CellInput[] => [
      { text: p.name, bold: true },
      String(p.runs),
      String(p.succeeded),
      { text: String(p.failed), tone: p.failed ? 'danger' : 'default' },
      String(p.open),
      String(p.decisions),
      String(p.changes),
      { text: String(p.checksFailed), tone: p.checksFailed ? 'danger' : 'default' },
    ]),
  );

  section(t('runList'));
  w.table(
    [
      { header: t('started'), width: 1.75 },
      { header: t('process'), width: 2.6 },
      { header: t('runIdHash'), width: 2.3, mono: true },
      { header: t('status'), width: 1.6 },
      { header: t('startedBy'), width: 1.5 },
      { header: t('decisionsShort'), width: 1.1, align: 'right' },
      { header: t('changesShort'), width: 1.1, align: 'right' },
      { header: t('checksFailed'), width: 1.1, align: 'right' },
    ],
    m.runs.map((r): CellInput[] => [
      tr.dateTime(r.startedAt),
      r.processName,
      `${r.id}\n${r.protocolHash ? r.protocolHash.slice(0, 20) + '…' : '–'}`,
      { text: tr.v('status', r.status) + (r.dryRun ? ` · ${t('dryRunTag')}` : ''), tone: statusTone(r.status) },
      r.actor.displayName,
      String(r.decisions),
      String(r.changes),
      { text: String(r.checksFailed), tone: r.checksFailed ? 'danger' : 'default' },
    ]),
    { empty: t('noRuns'), size: 7.2 },
  );
  if (m.runsOmitted) w.paragraph(t('runsTruncated', { n: m.runsOmitted }), { tone: 'muted', size: 8 });

  section(t('comments'));
  w.subheading(t('reviewerComment'));
  if (m.comment)
    w.keyValues([{ label: t('reviewerCommentBy', { user: personLabel(m.generatedBy), date: tr.dateTime(m.generatedAt) }), value: m.comment, span: 2 }]);
  else w.paragraph(t('noReviewerComment'), { tone: 'muted' });

  section(t('integrity'));
  w.keyValues([
    { label: t('contentHash'), value: contentHash, mono: true, span: 2 },
    { label: t('reportId'), value: m.reportId, mono: true },
  ]);
  w.subheading(t('howToVerify'));
  w.paragraph(t('verify1', { reportId: m.reportId }), { size: 8.5 });
  w.paragraph(t('verify2'), { size: 8.5 });

  signOff(w, tr, m, `${++n}. ${t('signoff')}`);
  const pdf = await w.finish();
  return { pdf, texts: w.texts };
}
