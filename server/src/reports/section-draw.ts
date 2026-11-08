import type { ReportLang } from '@sm/shared';
import type { ReportWriter, Tone } from './pdf/engine.js';
import type { Translator } from './i18n.js';

/**
 * The draw half of a section of scheduled summary reports (sections.ts has the collect half): its title, the "at a
 * glance" figures and the drawing. It takes the collected data and draws it – no database, no services – so it runs
 * in the PDF worker (reports/pdf/pool.ts). The worker registers the draw halves it knows (reports/pdf/drawers.ts); the
 * main thread registers each section's draw half with the section (registerReportSection).
 */

export interface SectionRender {
  w: ReportWriter;
  tr: Translator;
  lang: ReportLang;
  /** Numbered section heading */
  section: (title: string) => void;
}

export interface ReportSectionDraw<D = unknown> {
  id: string;
  title: (lang: ReportLang) => string;
  render: (data: D, r: SectionRender) => void;
  /** Figures for the "at a glance" row */
  glance?: (data: D, lang: ReportLang) => { label: string; value: string; tone?: Tone }[];
}

const DRAWERS = new Map<string, ReportSectionDraw>();

export function registerSectionDrawer<D>(def: ReportSectionDraw<D>): void {
  DRAWERS.set(def.id, def as unknown as ReportSectionDraw);
}
export const sectionDrawer = (id: string): ReportSectionDraw | undefined => DRAWERS.get(id);
/** The sections this thread can draw (the worker tells the main thread at start, pool.ts). */
export const sectionDrawerIds = (): string[] => [...DRAWERS.keys()];
