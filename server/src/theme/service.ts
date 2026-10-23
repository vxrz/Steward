import crypto from 'node:crypto';
import {
  BRAND,
  THEME_APP_NAME_MAX,
  THEME_DEFAULTS,
  THEME_LOGO_MAX_BYTES,
  THEME_LOGO_MAX_PIXELS,
  isDefaultTheme,
  normalizeHex,
  themeProblems,
  type PublicTheme,
  type ThemeInput,
  type ThemeLogoType,
  type ThemeSettings,
} from '@sm/shared';
import { readSetting, writeSetting } from '../settings.js';
import { HttpError, nowIso, sha256 } from '../util.js';

/**
 * Theme (Settings → Appearance): colours, default colour scheme, radius, app
 * display name and header logo. Stored in the database (internal settings
 * "theme.*"), so every instance behind a load balancer serves the same theme
 * and a backup of the database includes it. The logo is small (≤ 512 KB) and
 * kept base64-encoded next to the settings.
 */
const KEY = 'theme.settings';
const LOGO_KEY = 'theme.logo';

type Stored = ThemeInput & { updatedAt: string | null; updatedBy: string | null };
interface StoredLogo {
  mime: ThemeLogoType;
  size: number;
  width: number;
  height: number;
  sha256: string;
  updatedAt: string;
  data: string;
}

function stored(): Stored {
  const s = readSetting<Partial<Stored>>(KEY, {});
  return {
    primaryColor: normalizeHex(s.primaryColor ?? '') ?? THEME_DEFAULTS.primaryColor,
    accentColor: normalizeHex(s.accentColor ?? '') ?? THEME_DEFAULTS.accentColor,
    colorScheme: s.colorScheme ?? THEME_DEFAULTS.colorScheme,
    radius: s.radius ?? THEME_DEFAULTS.radius,
    appName: (s.appName ?? '').trim(),
    updatedAt: s.updatedAt ?? null,
    updatedBy: s.updatedBy ?? null,
  };
}

const storedLogo = (): StoredLogo | null => readSetting<StoredLogo | null>(LOGO_KEY, null);

export function getThemeSettings(): ThemeSettings {
  const s = stored();
  const l = storedLogo();
  return { ...s, logo: l ? { mime: l.mime, size: l.size, width: l.width, height: l.height, sha256: l.sha256, updatedAt: l.updatedAt } : null };
}

/** Saves the editable fields; returns the settings and which fields changed (from → to). */
export function updateTheme(patch: Partial<ThemeInput>, actor: string): { settings: ThemeSettings; changed: Record<string, { from: unknown; to: unknown }> } {
  const problems = themeProblems(patch);
  if (problems.length) throw new HttpError(400, problems.join('; '), 'THEME_INVALID');
  const before = stored();
  const next: Stored = { ...before };
  if (patch.primaryColor !== undefined) next.primaryColor = normalizeHex(patch.primaryColor)!;
  if (patch.accentColor !== undefined) next.accentColor = normalizeHex(patch.accentColor)!;
  if (patch.colorScheme !== undefined) next.colorScheme = patch.colorScheme;
  if (patch.radius !== undefined) next.radius = patch.radius;
  if (patch.appName !== undefined) next.appName = patch.appName.trim().slice(0, THEME_APP_NAME_MAX);
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of ['primaryColor', 'accentColor', 'colorScheme', 'radius', 'appName'] as const) {
    if (before[k] !== next[k]) changed[k] = { from: before[k], to: next[k] };
  }
  if (Object.keys(changed).length) writeSetting(KEY, { ...next, updatedAt: nowIso(), updatedBy: actor });
  return { settings: getThemeSettings(), changed };
}

/** Back to the Steward defaults (colours, scheme, radius, name; the logo is removed too). */
export function resetTheme(): ThemeSettings {
  writeSetting(KEY, null);
  writeSetting(LOGO_KEY, null);
  return getThemeSettings();
}

// ---------- logo ----------

/**
 * Type and size of a PNG, JPEG or WebP image, read from its header (the declared
 * file type is never trusted). Anything else – including SVG, which can carry
 * scripts – is null.
 */
export function imageInfo(data: Buffer): { mime: ThemeLogoType; width: number; height: number } | null {
  if (
    data.length >= 24 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    data.subarray(12, 16).toString('latin1') === 'IHDR'
  ) {
    return { mime: 'image/png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    // walk the JPEG segments up to the first start-of-frame marker
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) return null;
      const marker = data[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = data.readUInt16BE(i + 2);
      if (len < 2) return null;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { mime: 'image/jpeg', height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return null;
  }
  if (data.length >= 30 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') {
    const chunk = data.subarray(12, 16).toString('latin1');
    if (chunk === 'VP8X') return { mime: 'image/webp', width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
    if (chunk === 'VP8 ' && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
      return { mime: 'image/webp', width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && data[20] === 0x2f) {
      const b = data.readUInt32LE(21);
      return { mime: 'image/webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  return null;
}

const looksLikeSvg = (data: Buffer) =>
  /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(data.subarray(0, 2048).toString('utf8'));

export function setLogo(data: Buffer): ThemeSettings {
  if (!data.length) throw new HttpError(400, 'The file is empty', 'THEME_LOGO_EMPTY');
  if (data.length > THEME_LOGO_MAX_BYTES) throw new HttpError(400, `The logo is too large (max. ${THEME_LOGO_MAX_BYTES / 1024} KB)`, 'THEME_LOGO_TOO_LARGE');
  const info = imageInfo(data);
  if (!info) {
    if (looksLikeSvg(data)) throw new HttpError(400, 'SVG logos are not accepted (they can contain scripts). Use a PNG, JPEG or WebP image.', 'THEME_LOGO_SVG');
    throw new HttpError(400, 'The logo must be a PNG, JPEG or WebP image', 'THEME_LOGO_TYPE');
  }
  if (!info.width || !info.height || info.width > THEME_LOGO_MAX_PIXELS || info.height > THEME_LOGO_MAX_PIXELS) {
    throw new HttpError(400, `The logo must be between 1 and ${THEME_LOGO_MAX_PIXELS} pixels wide and high`, 'THEME_LOGO_DIMENSIONS');
  }
  const logo: StoredLogo = { ...info, size: data.length, sha256: sha256(data), updatedAt: nowIso(), data: data.toString('base64') };
  writeSetting(LOGO_KEY, logo);
  return getThemeSettings();
}

export function removeLogo(): ThemeSettings {
  writeSetting(LOGO_KEY, null);
  return getThemeSettings();
}

export function logoFile(): { data: Buffer; mime: ThemeLogoType; sha256: string } | null {
  const l = storedLogo();
  return l ? { data: Buffer.from(l.data, 'base64'), mime: l.mime, sha256: l.sha256 } : null;
}

// ---------- public view ----------

export function publicTheme(): PublicTheme {
  const s = getThemeSettings();
  return {
    primaryColor: s.primaryColor,
    accentColor: s.accentColor,
    colorScheme: s.colorScheme,
    radius: s.radius,
    appName: s.appName,
    // the hash in the URL lets browsers cache the image for good
    logoUrl: s.logo ? `/api/theme/logo?v=${s.logo.sha256.slice(0, 16)}` : null,
    custom: !isDefaultTheme(s, !!s.logo),
  };
}

/** Strong ETag of a JSON body. */
export const etagOf = (body: string): string => `"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;

/** Does the If-None-Match header match the ETag? */
export function notModified(ifNoneMatch: string | string[] | undefined, etag: string): boolean {
  const v = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(',') : ifNoneMatch;
  if (!v) return false;
  if (v.trim() === '*') return true;
  return v.split(',').some((t) => t.trim().replace(/^W\//, '') === etag);
}

/** The display name: custom app name or the product name. */
export const displayName = (): string => stored().appName || BRAND.name;
