import { BRAND, type ReportBranding } from '@sm/shared';
import { config } from '../config.js';
import type { Chrome, Tone } from './pdf/engine.js';
import type { Translator } from './i18n.js';

export const PRODUCT = `${BRAND.name} ${config.version}`;

export interface BrandingInput {
  branding: ReportBranding;
  logo: Buffer;
}

export const companyName = (b: ReportBranding): string => b.companyName.trim() || BRAND.name;

export function chrome(
  tr: Translator,
  b: BrandingInput,
  o: { shortTitle: string; classification: string; tags: { text: string; tone: Tone }[]; lines: (page: number, total: number) => string[] },
): Chrome {
  const company = companyName(b.branding);
  const note = b.branding.footerNote.trim();
  return {
    logo: b.logo,
    companyName: company,
    shortTitle: o.shortTitle,
    classification: o.classification ? tr.classification(o.classification) : '',
    tags: o.tags,
    footer: (page, total) => ({
      left: note ? `${company} · ${note}` : company,
      right: tr.t('pageOf', { n: page, total }),
      lines: o.lines(page, total),
    }),
  };
}

export const statusTone = (s: string): Tone =>
  s === 'succeeded'
    ? 'success'
    : s === 'failed'
      ? 'danger'
      : s === 'dryrun'
        ? 'warning'
        : s === 'waiting' || s === 'running'
          ? 'info'
          : s === 'skipped'
            ? 'muted'
            : 'default';

export const langTag = (lang: string): string => (lang === 'de' ? 'de-DE' : 'en-GB');
