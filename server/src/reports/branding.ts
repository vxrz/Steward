import fs from 'node:fs';
import path from 'node:path';
import { BRAND, REPORT_LOGO_MAX_BYTES, type ReportBranding } from '@sm/shared';
import { config } from '../config.js';
import { readSetting, writeSetting } from '../settings.js';
import { HttpError, nowIso } from '../util.js';
import { DEFAULT_LOGO, FONT_FILES, assetPath, readAsset } from './pdf/assets.js';
import { PDFDocument, openImage } from './pdf/pdfkit.js';

/**
 * Report branding: company name, logo, accent colour, default classification
 * and footer note. Stored as an internal setting; the logo is a file in
 * <data>/branding. Without a custom logo the Steward logo is used.
 */
const KEY = 'reports.branding';

type Stored = Omit<ReportBranding, 'customLogo'>;

const DEFAULTS: Stored = {
  companyName: '',
  accentColor: BRAND.color,
  classification: 'Internal',
  footerNote: '',
  logoMime: null,
  logoUpdatedAt: null,
};

const brandingDir = () => path.join(config.dataDir, 'branding');
const logoFile = (mime: string) => path.join(brandingDir(), mime === 'image/jpeg' ? 'logo.jpg' : 'logo.png');

export function getBranding(): ReportBranding {
  const s = { ...DEFAULTS, ...readSetting<Partial<Stored>>(KEY, {}) };
  const customLogo = !!s.logoMime && fs.existsSync(logoFile(s.logoMime));
  return { ...s, customLogo, logoMime: customLogo ? s.logoMime : null, logoUpdatedAt: customLogo ? s.logoUpdatedAt : null };
}

export function updateBranding(patch: Partial<Pick<ReportBranding, 'companyName' | 'accentColor' | 'classification' | 'footerNote'>>): ReportBranding {
  const cur = { ...DEFAULTS, ...readSetting<Partial<Stored>>(KEY, {}) };
  if (patch.accentColor !== undefined && !/^#[0-9a-fA-F]{6}$/.test(patch.accentColor))
    throw new HttpError(400, 'Accent colour must be a hex colour like #1c7ed6', 'COLOR_INVALID');
  const next: Stored = {
    ...cur,
    ...Object.fromEntries(
      Object.entries(patch)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v).trim()]),
    ),
  };
  writeSetting(KEY, next);
  return getBranding();
}

/** Detects PNG/JPEG by magic bytes (the declared file type is not trusted). */
export function imageMime(data: Buffer): 'image/png' | 'image/jpeg' | null {
  if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  return null;
}

export function setLogo(data: Buffer): ReportBranding {
  if (!data.length) throw new HttpError(400, 'The file is empty', 'FILE_EMPTY');
  if (data.length > REPORT_LOGO_MAX_BYTES)
    throw new HttpError(400, `The logo is too large (max. ${REPORT_LOGO_MAX_BYTES / 1024 / 1024} MB)`, 'LOGO_TOO_LARGE', {
      maxMb: REPORT_LOGO_MAX_BYTES / 1024 / 1024,
    });
  const mime = imageMime(data);
  if (!mime) throw new HttpError(400, 'The logo must be a PNG or JPEG image', 'LOGO_TYPE');
  // Make sure the PDF engine can actually embed it (corrupt or unsupported variants are rejected now, not at report time).
  try {
    const probe = new PDFDocument({ autoFirstPage: false, font: assetPath(FONT_FILES.sans) });
    const img = openImage(probe, data);
    if (!img.width || !img.height || img.width > 6000 || img.height > 6000) throw new Error('size');
  } catch {
    throw new HttpError(400, 'The image could not be read. Use a PNG or JPEG file up to 6000 × 6000 pixels.', 'LOGO_UNREADABLE');
  }
  fs.mkdirSync(brandingDir(), { recursive: true });
  const target = logoFile(mime);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
  for (const other of ['image/png', 'image/jpeg']) if (other !== mime) fs.rmSync(logoFile(other), { force: true });
  const cur = { ...DEFAULTS, ...readSetting<Partial<Stored>>(KEY, {}) };
  writeSetting(KEY, { ...cur, logoMime: mime, logoUpdatedAt: nowIso() });
  return getBranding();
}

export function removeLogo(): ReportBranding {
  for (const m of ['image/png', 'image/jpeg']) fs.rmSync(logoFile(m), { force: true });
  const cur = { ...DEFAULTS, ...readSetting<Partial<Stored>>(KEY, {}) };
  writeSetting(KEY, { ...cur, logoMime: null, logoUpdatedAt: null });
  return getBranding();
}

/** Report branding from elsewhere (a migration package): text fields as strings, only a logo type that matches the file. */
export function checkedBranding(v: unknown, logoData: Buffer | null): Stored | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const s = { ...DEFAULTS, ...(v as Partial<Stored>) };
  if (typeof s.accentColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(s.accentColor)) s.accentColor = DEFAULTS.accentColor;
  for (const k of ['companyName', 'classification', 'footerNote'] as const) s[k] = typeof s[k] === 'string' ? s[k].slice(0, 500) : DEFAULTS[k];
  const mime = logoData ? imageMime(logoData) : null;
  if (!mime || s.logoMime !== mime) ((s.logoMime = null), (s.logoUpdatedAt = null));
  return s;
}

/** The logo used in reports (custom or the Steward default). */
export function logo(): { data: Buffer; mime: string; custom: boolean } {
  const b = getBranding();
  if (b.customLogo && b.logoMime) {
    try {
      const data = fs.readFileSync(logoFile(b.logoMime));
      // the type comes from the content, never from the stored setting
      const mime = imageMime(data);
      if (mime) return { data, mime, custom: true };
    } catch {
      /* fall back to the default */
    }
  }
  return { data: readAsset(DEFAULT_LOGO), mime: 'image/png', custom: false };
}
