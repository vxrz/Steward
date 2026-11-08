import { ReportWriter, type CellInput } from './pdf/engine.js';
import { translator } from './i18n.js';
import { PRODUCT, chrome, langTag, statusTone, type BrandingInput } from './common.js';
import { personLabel } from './labels.js';
import { signOff, type RenderResult } from './run-report.js';
import type { SummaryReportModel } from './summary-report.js';

/** Draws the periodic summary (summary-report.ts collects it): data in, PDF out – it runs in the PDF worker. */
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
