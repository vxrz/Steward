import type { Person, ReportContext } from './model.js';
import { reportSection, sectionOrder, type SectionContext } from './sections.js';

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
