import { ReportWriter } from './pdf/engine.js';
import { translator } from './i18n.js';
import { PRODUCT, chrome, langTag, type BrandingInput } from './common.js';
import { personLabel, type Person, type ReportContext } from './model.js';
import { signOff, type RenderResult } from './run-report.js';
import { reportSection, sectionOrder, type SectionContext } from './sections.js';
import { st } from './scheduled-i18n.js';

/** A scheduled summary report: a period and the data of the selected sections (collected as the schedule owner). */
export interface ScheduledReportModel extends ReportContext {
  kind: 'scheduled';
  scheduleId: string;
  scheduleName: string;
  title: string;
  owner: Person;
  from: string;
  to: string;
  sections: { id: string; data: unknown }[];
}

/** Collects the section data. Call inside runAs(owner). */
export function buildScheduledModel(
  o: { scheduleId: string; scheduleName: string; title: string; owner: Person; from: number; to: number; now: number; sections: Record<string, unknown> },
  ctx: ReportContext,
): ScheduledReportModel {
  const sctx: SectionContext = { from: o.from, to: o.to, now: o.now, lang: ctx.lang };
  const sections = sectionOrder(Object.keys(o.sections)).map((id) => ({ id, data: reportSection(id)!.build(o.sections[id], sctx) }));
  return {
    ...ctx,
    kind: 'scheduled',
    scheduleId: o.scheduleId,
    scheduleName: o.scheduleName,
    title: o.title,
    owner: o.owner,
    from: new Date(o.from).toISOString(),
    to: new Date(o.to).toISOString(),
    sections,
  };
}

export async function renderScheduledReport(
  m: ScheduledReportModel,
  contentHash: string,
  brand: BrandingInput,
  o: { compress?: boolean } = {},
): Promise<RenderResult> {
  const tr = translator(m.lang, m.timeZone);
  const { t } = tr;
  const L = m.lang;
  const period = `${tr.dateTime(m.from)} – ${tr.dateTime(m.to)}`;
  const w = new ReportWriter(
    {
      title: `${m.title}: ${tr.date(m.from)} – ${tr.date(m.to)}`,
      author: m.owner.displayName,
      subject: `${st(L, 'scheduledReport')} – ${m.scheduleName}`.slice(0, 400),
      keywords: [PRODUCT.split(' ')[0]!, st(L, 'scheduledReport'), ...m.sections.map((s) => s.id)],
      creator: PRODUCT,
      producer: `${PRODUCT} (PDFKit)`,
      lang: langTag(L),
      createdAt: new Date(m.generatedAt),
      custom: {
        reportId: m.reportId,
        reportKind: 'scheduled',
        scheduleId: m.scheduleId,
        sections: m.sections.map((s) => s.id).join(','),
        periodFrom: m.from,
        periodTo: m.to,
        contentHash,
        classification: m.classification,
        generatedBy: m.generatedBy.username,
        generatedAt: m.generatedAt,
      },
    },
    chrome(tr, brand, {
      shortTitle: m.title,
      classification: m.classification,
      tags: [],
      lines: () => [
        st(L, 'footer', { name: m.scheduleName, from: tr.date(m.from), to: tr.date(m.to), date: tr.dateTime(m.generatedAt), reportId: m.reportId }),
        `${t('contentHash')}: ${contentHash}`,
        t('footerVerifySummary', { reportId: m.reportId }),
      ],
    }),
    { accent: brand.branding.accentColor, compress: o.compress },
  );

  w.cover({
    title: m.title,
    subtitle: period,
    meta: [t('generatedWith', { product: PRODUCT }), t('reportNo', { id: m.reportId }), tr.dateTime(m.generatedAt)],
  });

  let n = 0;
  const section = (title: string) => w.section(`${++n}. ${title}`);
  section(t('scope'));
  w.keyValues([
    { label: t('period'), value: period, span: 2 },
    { label: t('timeZone'), value: tr.timeZone },
    { label: st(L, 'schedule'), value: m.scheduleName },
    { label: st(L, 'owner'), value: personLabel(m.owner) },
    { label: st(L, 'sections'), value: m.sections.map((s) => reportSection(s.id)?.title(L) ?? s.id).join('\n') },
  ]);
  w.paragraph(st(L, 'scopeNote'), { tone: 'muted', size: 8 });
  const tiles = m.sections.flatMap((s) => reportSection(s.id)?.glance?.(s.data as never, L) ?? []);
  if (tiles.length) {
    w.subheading(st(L, 'atAGlance'));
    w.stats(tiles);
  }

  for (const s of m.sections) reportSection(s.id)?.render(s.data as never, { w, tr, lang: L, section });

  if (m.comment) {
    section(t('comments'));
    w.paragraph(m.comment);
  }

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
