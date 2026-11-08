import type { ZodType } from 'zod';
import type { ReportLang } from '@sm/shared';
import { parseJson } from '../util.js';
import { registerSectionDrawer, type ReportSectionDraw } from './section-draw.js';

export type { SectionRender, ReportSectionDraw } from './section-draw.js';

/**
 * Sections of scheduled summary reports. Each section validates its own configuration, collects its data (called
 * inside runAs(owner): only what the owner of the schedule may see) and draws it. The collected data is part of the
 * report model and therefore of its content hash.
 *
 * A section has two halves: the draw half (section-draw.ts: title, "at a glance" figures, the drawing – pure, it runs
 * in the PDF worker) and the collect half here (configuration, checks, data – main thread, may use the database).
 * The features bring their sections in their manifest (features/); the built-in ones are in builtin-sections.ts.
 * registerReportSection() also takes a section another feature defines at run time: it is drawn in the main thread.
 */

export interface SectionContext {
  from: number;
  to: number;
  now: number;
  lang: ReportLang;
}

/** A whole section: its draw half and the collect half. */
export interface ReportSectionDef<C = unknown, D = unknown> extends ReportSectionDraw<D> {
  /** Validates the section's configuration in a schedule */
  schema: ZodType<C>;
  /** Throws (HttpError 400) when the configuration names something the owner may not see; called on save */
  validate?: (config: C) => void;
  build: (config: C, ctx: SectionContext) => D;
}

const SECTIONS = new Map<string, ReportSectionDef>();
/** Registers a section (in this order: the order of the sections in a report); its draw half too. */
export function registerReportSection<C, D>(def: ReportSectionDef<C, D>): void {
  SECTIONS.set(def.id, def as unknown as ReportSectionDef);
  registerSectionDrawer({ id: def.id, title: def.title, render: def.render, glance: def.glance } as ReportSectionDraw<D>);
}
export const reportSection = (id: string): ReportSectionDef | undefined => SECTIONS.get(id);
export const reportSectionIds = (): string[] => [...SECTIONS.keys()];

/** Validates and normalises the sections of a schedule (unknown sections are rejected). */
export function parseSections(input: unknown): Record<string, unknown> {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [id, cfg] of Object.entries(raw)) {
    if (cfg === null || cfg === undefined || cfg === false) continue;
    const def = SECTIONS.get(id);
    if (!def) throw Object.assign(new Error(`Unknown report section "${id}"`), { statusCode: 400 });
    const r = def.schema.safeParse(cfg === true ? {} : cfg);
    if (!r.success)
      throw Object.assign(new Error(`Section "${id}": ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`), { statusCode: 400 });
    out[id] = r.data;
  }
  if (!Object.keys(out).length) throw Object.assign(new Error('Select at least one section'), { statusCode: 400 });
  return out;
}

export const sectionOrder = (ids: string[]): string[] => reportSectionIds().filter((id) => ids.includes(id));

export const parseSectionsJson = (s: string): Record<string, unknown> => parseJson<Record<string, unknown>>(s, {});
