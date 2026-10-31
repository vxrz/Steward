import fs from 'node:fs';
import path from 'node:path';
import {
  BRAND,
  NOTIFICATION_CORNERS,
  NOTIFICATION_DRY_RUN_DELIVERY,
  NOTIFICATION_FONTS,
  NOTIFICATION_HEADER_STYLES,
  NOTIFICATION_LOGO_ALIGNS,
  NOTIFICATION_LOGO_MAX_BYTES,
  NOTIFICATION_LOGO_SIZES,
  NOTIFICATION_LOGO_SOURCES,
  NOTIFICATION_LOOK_DEFAULTS,
  NOTIFICATION_LOOK_FOOTER_MAX,
  NOTIFICATION_LOOK_NAME_MAX,
  contrastRatio,
  normalizeHex,
  type Locale,
  type NotificationLook,
  type NotificationLookInput,
} from '@sm/shared';
import { config } from '../config.js';
import { t } from '../i18n/index.js';
import { readSetting, writeSetting } from '../settings.js';
import { getThemeSettings, logoFile } from '../theme/service.js';
import { imageMime, logo as reportLogo } from '../reports/branding.js';
import { HttpError, nowIso } from '../util.js';

/**
 * Look of e-mails and Teams messages (Settings → Notifications → Look): name, colour, logo, footer
 * text and a few safe styling choices, plus how dry runs are delivered. Empty fields follow
 * Settings → Appearance, so messages carry the company's name and colour without extra setup.
 * Stored as the internal setting "notifications.look"; an own logo is <data>/branding/notification-logo.png|jpg.
 */
const KEY = 'notifications.look';

type Stored = NotificationLookInput & { updatedAt: string | null; updatedBy: string | null };

/** The content id of the logo attached to e-mails (`<img src="cid:…">`). */
export const LOGO_CID = 'logo@steward';
/** E-mail logos larger than this are left out (a message should stay small). */
export const EMAIL_LOGO_MAX_BYTES = 512 * 1024;
/** A Teams card may be at most 28 KB: only a small logo is embedded. */
export const TEAMS_LOGO_MAX_BYTES = 12 * 1024;
export const TEAMS_CARD_MAX_CHARS = 24 * 1024;

const clean = (v: unknown, max: number) =>
  typeof v === 'string'
    ? v
        // eslint-disable-next-line no-control-regex -- control characters (line breaks in a subject header) are replaced on purpose
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .trim()
        .slice(0, max)
    : '';

/** The value when it is one of `allowed`, else the default. */
const oneOf = <T extends string>(allowed: readonly T[], v: unknown, fallback: T): T => ((allowed as readonly unknown[]).includes(v) ? (v as T) : fallback);
const hexOrEmpty = (v: unknown) => (typeof v === 'string' && v ? (normalizeHex(v) ?? '') : '');

function sanitize(v: Partial<Stored>): Stored {
  const d = NOTIFICATION_LOOK_DEFAULTS;
  return {
    name: clean(v.name, NOTIFICATION_LOOK_NAME_MAX),
    color: hexOrEmpty(v.color),
    logoSource: oneOf(NOTIFICATION_LOGO_SOURCES, v.logoSource, d.logoSource),
    footer: clean(v.footer, NOTIFICATION_LOOK_FOOTER_MAX),
    logoSize: oneOf(NOTIFICATION_LOGO_SIZES, v.logoSize, d.logoSize),
    logoAlign: oneOf(NOTIFICATION_LOGO_ALIGNS, v.logoAlign, d.logoAlign),
    headerStyle: oneOf(NOTIFICATION_HEADER_STYLES, v.headerStyle, d.headerStyle),
    buttonColor: hexOrEmpty(v.buttonColor),
    corners: oneOf(NOTIFICATION_CORNERS, v.corners, d.corners),
    font: oneOf(NOTIFICATION_FONTS, v.font, d.font),
    dryRunDelivery: oneOf(NOTIFICATION_DRY_RUN_DELIVERY, v.dryRunDelivery, d.dryRunDelivery),
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : null,
    updatedBy: typeof v.updatedBy === 'string' ? v.updatedBy : null,
  };
}

const stored = (): Stored => sanitize(readSetting<Partial<Stored>>(KEY, {}));

/** Problems of an input (empty = valid). */
export function lookProblems(p: Partial<NotificationLookInput>): string[] {
  const out: string[] = [];
  if (p.color !== undefined && p.color !== '' && !normalizeHex(p.color))
    out.push('Colour must be a hex colour like #1c7ed6, or empty for the Appearance colour');
  if (p.buttonColor !== undefined && p.buttonColor !== '' && !normalizeHex(p.buttonColor))
    out.push('Button colour must be a hex colour like #1c7ed6, or empty for the header colour');
  if (p.name !== undefined && p.name.trim().length > NOTIFICATION_LOOK_NAME_MAX) out.push(`Name: at most ${NOTIFICATION_LOOK_NAME_MAX} characters`);
  if (p.footer !== undefined && p.footer.trim().length > NOTIFICATION_LOOK_FOOTER_MAX) out.push(`Footer: at most ${NOTIFICATION_LOOK_FOOTER_MAX} characters`);
  const choice = (v: unknown, allowed: readonly string[], what: string) => {
    if (v !== undefined && !allowed.includes(v as string)) out.push(`${what}: ${allowed.join(', ')}`);
  };
  choice(p.logoSource, NOTIFICATION_LOGO_SOURCES, 'Logo');
  choice(p.logoSize, NOTIFICATION_LOGO_SIZES, 'Logo size');
  choice(p.logoAlign, NOTIFICATION_LOGO_ALIGNS, 'Logo position');
  choice(p.headerStyle, NOTIFICATION_HEADER_STYLES, 'Header');
  choice(p.corners, NOTIFICATION_CORNERS, 'Corners');
  choice(p.font, NOTIFICATION_FONTS, 'Font');
  choice(p.dryRunDelivery, NOTIFICATION_DRY_RUN_DELIVERY, 'Dry runs');
  return out;
}

// ---------- own logo ----------

const brandingDir = () => path.join(config.dataDir, 'branding');
const customLogoPath = (mime: 'image/png' | 'image/jpeg') =>
  path.join(brandingDir(), mime === 'image/jpeg' ? 'notification-logo.jpg' : 'notification-logo.png');

/** The uploaded notification logo, checked by its content (a file renamed or replaced by hand is not trusted). */
export function customLogo(): { data: Buffer; mime: 'image/png' | 'image/jpeg'; updatedAt: string | null } | null {
  for (const mime of ['image/png', 'image/jpeg'] as const) {
    let data: Buffer;
    try {
      data = fs.readFileSync(customLogoPath(mime));
    } catch {
      continue;
    }
    if (imageMime(data) !== mime) continue;
    let updatedAt: string | null = null;
    try {
      updatedAt = fs.statSync(customLogoPath(mime)).mtime.toISOString();
    } catch {
      /* gone meanwhile */
    }
    return { data, mime, updatedAt };
  }
  return null;
}

/** Stores an own notification logo (PNG or JPEG by content, at most 512 KB) and replaces an older one. */
export function setCustomLogo(data: Buffer): { mime: 'image/png' | 'image/jpeg'; size: number } {
  if (!data.length) throw new HttpError(400, 'The file is empty', 'FILE_EMPTY');
  if (data.length > NOTIFICATION_LOGO_MAX_BYTES)
    throw new HttpError(400, `The logo is too large (max. ${NOTIFICATION_LOGO_MAX_BYTES / 1024} KB)`, 'NOTIFICATION_LOGO_TOO_LARGE', {
      maxKb: NOTIFICATION_LOGO_MAX_BYTES / 1024,
    });
  const mime = imageMime(data);
  if (!mime) throw new HttpError(400, 'The logo must be a PNG or JPEG image (mail clients cannot show other formats)', 'NOTIFICATION_LOGO_TYPE');
  fs.mkdirSync(brandingDir(), { recursive: true, mode: 0o700 });
  const target = customLogoPath(mime);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, target);
  for (const other of ['image/png', 'image/jpeg'] as const) if (other !== mime) fs.rmSync(customLogoPath(other), { force: true });
  return { mime, size: data.length };
}

/** Removes the own notification logo; true when there was one. */
export function removeCustomLogo(): boolean {
  let removed = false;
  for (const mime of ['image/png', 'image/jpeg'] as const) {
    if (fs.existsSync(customLogoPath(mime))) removed = true;
    fs.rmSync(customLogoPath(mime), { force: true });
  }
  return removed;
}

export interface MessageLogo {
  data: Buffer;
  mime: 'image/png' | 'image/jpeg';
}

/** The logo of a source, if it exists and mail clients can show it (PNG or JPEG). */
function logoOf(source: NotificationLookInput['logoSource']): { logo: MessageLogo | null; problem?: 'missing' | 'type' } {
  if (source === 'none') return { logo: null };
  if (source === 'custom') {
    const c = customLogo();
    return c ? { logo: { data: c.data, mime: c.mime } } : { logo: null, problem: 'missing' };
  }
  if (source === 'app') {
    const f = logoFile();
    if (!f) return { logo: null, problem: 'missing' };
    if (f.mime !== 'image/png' && f.mime !== 'image/jpeg') return { logo: null, problem: 'type' };
    return { logo: { data: f.data, mime: f.mime } };
  }
  // the report logo: the uploaded one, or the Steward logo the reports use by default
  const r = reportLogo();
  const mime = imageMime(r.data);
  return mime ? { logo: { data: r.data, mime } } : { logo: null, problem: 'type' };
}

export interface ResolvedLook {
  name: string;
  /** Header colour */
  color: string;
  /** Text colour on the header (white or near-black, whichever reads better) */
  onColor: string;
  /** Button colour (the header colour unless set) and its text colour */
  button: string;
  onButton: string;
  footer: string;
  logo: MessageLogo | null;
  logoProblem?: 'missing' | 'type' | 'size';
  logoSize: NotificationLookInput['logoSize'];
  logoAlign: NotificationLookInput['logoAlign'];
  headerStyle: NotificationLookInput['headerStyle'];
  corners: NotificationLookInput['corners'];
  font: NotificationLookInput['font'];
  dryRunDelivery: NotificationLookInput['dryRunDelivery'];
}

/** White or near-black text, whichever reads better on `bg`. */
const textOn = (bg: string) => (contrastRatio(bg, '#ffffff') >= contrastRatio(bg, '#212529') ? '#ffffff' : '#212529');

/** The look with the fallbacks applied; `draft` previews unsaved settings. */
export function resolveLook(draft?: Partial<NotificationLookInput>): ResolvedLook {
  const s = draft ? sanitize({ ...stored(), ...draft }) : stored();
  const theme = getThemeSettings();
  const name = s.name || theme.appName || BRAND.name;
  const color = s.color || normalizeHex(theme.primaryColor) || BRAND.color;
  const button = s.buttonColor || color;
  const { logo, problem } = logoOf(s.logoSource);
  const big = !!logo && logo.data.length > EMAIL_LOGO_MAX_BYTES;
  return {
    name,
    color,
    onColor: textOn(color),
    button,
    onButton: textOn(button),
    footer: s.footer,
    logo: big ? null : logo,
    ...(problem ? { logoProblem: problem } : big ? { logoProblem: 'size' as const } : {}),
    logoSize: s.logoSize,
    logoAlign: s.logoAlign,
    headerStyle: s.headerStyle,
    corners: s.corners,
    font: s.font,
    dryRunDelivery: s.dryRunDelivery,
  };
}

/** Whether messages about dry runs go to e-mail, Teams and webhooks too (marked) or only to the app. */
export const dryRunDelivery = (): NotificationLookInput['dryRunDelivery'] => stored().dryRunDelivery;

const INPUT_KEYS = Object.keys(NOTIFICATION_LOOK_DEFAULTS) as (keyof NotificationLookInput)[];

export function getLook(): NotificationLook {
  const s = stored();
  const r = resolveLook();
  const c = customLogo();
  return {
    ...(Object.fromEntries(INPUT_KEYS.map((k) => [k, s[k]])) as unknown as NotificationLookInput),
    effective: { name: r.name, color: r.color, logo: !!r.logo, ...(r.logoProblem ? { logoProblem: r.logoProblem } : {}) },
    customLogo: c ? { mime: c.mime, size: c.data.length, updatedAt: c.updatedAt } : null,
    updatedAt: s.updatedAt,
    updatedBy: s.updatedBy,
  };
}

/** Saves a change; `changed` lists the fields that differ (for the audit entry). */
export function updateLook(
  patch: Partial<NotificationLookInput>,
  by: string,
): { look: NotificationLook; changed: Record<string, { from: string; to: string }> } {
  const problems = lookProblems(patch);
  if (problems.length) throw new HttpError(400, problems.join('; '), 'NOTIFICATION_LOOK_INVALID');
  const cur = stored();
  const next = sanitize({ ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
  const changed: Record<string, { from: string; to: string }> = {};
  for (const k of INPUT_KEYS) if (cur[k] !== next[k]) changed[k] = { from: cur[k], to: next[k] };
  if (Object.keys(changed).length) writeSetting(KEY, { ...next, updatedAt: nowIso(), updatedBy: by });
  return { look: getLook(), changed };
}

/** The setting from a migration package: null unless it is an object (the fields are cleaned like a save). */
export function checkedLook(v: unknown): Stored | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return sanitize(v as Partial<Stored>);
}

// ---------- tone ----------

/** Adaptive Card container styles; e-mails use the matching colours. `emphasis` is the neutral grey of dry runs. */
export type MessageTone = 'good' | 'warning' | 'attention' | 'accent' | 'emphasis';

export const TONE_HEX: Record<MessageTone, string> = { good: '#2b8a3e', warning: '#e8590c', attention: '#c92a2a', accent: '#1971c2', emphasis: '#868e96' };

/** A message about a dry run: a test that changed nothing, so it must not read as urgent. */
export const isDryRun = (data?: Record<string, unknown>): boolean => data?.dryRun === true;

const BAD_EVENTS = new Set(['run.failed', 'check.failed', 'duty.missed', 'objective.breached', 'security.emergency', 'access.undocumented', 'backup.failed']);
const WARN_EVENTS = new Set([
  'task.assigned',
  'mcp.request',
  'dataset.stale',
  'schedule.skipped',
  'credential.due',
  'ticket.unchecked',
  'document.review',
  'stack.eol',
  'duty.due',
  'duty.exception',
  'duty.ended',
  'measure.due',
]);

/** How a message reads at a glance: red for failures, orange for something to do, green when a monitor is up again. */
export function eventTone(event: string, data?: Record<string, unknown>): MessageTone {
  if (isDryRun(data)) return 'emphasis';
  if (event === 'monitor.status') {
    const status = data?.status;
    return status === 'up' ? 'good' : status === 'down' ? 'attention' : status === 'degraded' || status === 'blocked' ? 'warning' : 'accent';
  }
  if (event === 'check.resolved') return 'good';
  if (BAD_EVENTS.has(event)) return 'attention';
  if (WARN_EVENTS.has(event)) return 'warning';
  return 'accent';
}

// ---------- e-mail layout ----------

export const escHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Font stacks that every mail client has. */
const FONTS: Record<NotificationLookInput['font'], string> = {
  system: "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  arial: 'Arial,Helvetica,sans-serif',
  serif: "Georgia,'Times New Roman',Times,serif",
};
/** Logo height in the e-mail header (px). */
export const LOGO_HEIGHT: Record<NotificationLookInput['logoSize'], number> = { small: 20, medium: 28, large: 40 };

/** The dry-run note on top of a message (e-mail banner, Teams card, text part). */
export const dryRunBanner = (locale: Locale): string => t(locale, 'dryRun.banner');

/**
 * The HTML e-mail around a message: a header with logo and name (in the colour, white with a line in
 * the colour, or minimal), an optional strip by tone, an optional dry-run banner, the content, a button
 * and the footer text. Tables and inline styles only (Outlook, Gmail); light colours that stay readable
 * when a client darkens them. `content` is HTML the caller has escaped.
 */
export function emailHtml(o: {
  look: ResolvedLook;
  locale: Locale;
  title: string;
  content: string;
  tone?: MessageTone;
  button?: { label: string; href: string };
  /** More buttons before `button` (e.g. "Open runbook") */
  buttons?: { label: string; href: string }[];
  /** Small print under the content (e.g. how to turn the daily summary off); HTML, escaped by the caller */
  note?: string;
  /** Image source of the logo: the cid for a sent e-mail, a data URL for the preview */
  logoSrc?: string;
  /** Plain text shown in a neutral box above the title (dry runs) */
  banner?: string;
}): string {
  const l = o.look;
  const font = FONTS[l.font];
  const radius = l.corners === 'rounded' ? 8 : 0;
  const buttonRadius = l.corners === 'rounded' ? 6 : 0;
  const h = LOGO_HEIGHT[l.logoSize];
  const solid = l.headerStyle === 'solid';
  const headBg = solid ? l.color : '#ffffff';
  // on a white header the name is in the colour when that reads well, else near-black
  const headText = solid ? l.onColor : contrastRatio(l.color, '#ffffff') >= 4.5 ? l.color : '#212529';
  const headBorder = l.headerStyle === 'line' ? `border-bottom:3px solid ${l.color};` : l.headerStyle === 'minimal' ? 'border-bottom:1px solid #e9ecef;' : '';
  const center = l.logoAlign === 'center';
  const logo =
    l.logo && o.logoSrc
      ? `<img src="${escHtml(o.logoSrc)}" alt="" height="${h}" style="display:${center ? 'inline-block' : 'block'};height:${h}px;width:auto;max-width:${h * 6}px;border:0">`
      : '';
  const nameCell = `font-family:${font};font-size:16px;font-weight:600;color:${headText}`;
  const header = center
    ? `<tr><td align="center" style="background:${headBg};${headBorder}padding:16px 20px;text-align:center">${logo ? `<div style="margin:0 0 6px">${logo}</div>` : ''}<div style="${nameCell}">${escHtml(l.name)}</div></td></tr>`
    : [
        `<tr><td style="background:${headBg};${headBorder}padding:14px 20px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>`,
        logo ? `<td style="padding-right:12px;vertical-align:middle">${logo}</td>` : '',
        `<td style="vertical-align:middle;${nameCell}">${escHtml(l.name)}</td>`,
        `</tr></table></td></tr>`,
      ].join('');
  const strip = o.tone ? `<tr><td style="height:4px;line-height:4px;font-size:0;background:${TONE_HEX[o.tone]}">&nbsp;</td></tr>` : '';
  const banner = o.banner
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px"><tr><td style="background:#f1f3f5;border-left:4px solid ${TONE_HEX.emphasis};border-radius:${buttonRadius}px;padding:10px 12px;font-family:${font};font-size:14px;line-height:1.4;color:#212529"><strong>${escHtml(o.banner)}</strong></td></tr></table>`
    : '';
  const one = (b: { label: string; href: string }, primary: boolean) =>
    primary
      ? `<td style="border-radius:${buttonRadius}px;background:${l.button}"><a href="${escHtml(b.href)}" style="display:inline-block;padding:10px 18px;font-family:${font};font-size:14px;font-weight:600;color:${l.onButton};text-decoration:none;border-radius:${buttonRadius}px">${escHtml(b.label)}</a></td>`
      : `<td style="border-radius:${buttonRadius}px;border:1px solid ${l.button}"><a href="${escHtml(b.href)}" style="display:inline-block;padding:9px 17px;font-family:${font};font-size:14px;font-weight:600;color:#212529;text-decoration:none;border-radius:${buttonRadius}px">${escHtml(b.label)}</a></td>`;
  const all = [...(o.buttons ?? []).map((b) => one(b, false)), ...(o.button ? [one(o.button, true)] : [])];
  const button = all.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0 4px"><tr>${all.join('<td style="width:8px">&nbsp;</td>')}</tr></table>`
    : '';
  const footer = [o.note ? `<p style="margin:0 0 6px">${o.note}</p>` : '', l.footer ? `<p style="margin:0">${escHtml(l.footer)}</p>` : ''].join('');
  return [
    '<!DOCTYPE html>',
    `<html lang="${o.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escHtml(o.title)}</title></head>`,
    `<body style="margin:0;padding:0;background:#f1f3f5">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f3f5"><tr><td align="center" style="padding:24px 12px">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border:1px solid #dee2e6;border-radius:${radius}px;overflow:hidden">`,
    header,
    strip,
    `<tr><td style="padding:20px;font-family:${font};font-size:14px;line-height:1.5;color:#212529">`,
    banner,
    `<h1 style="margin:0 0 12px;font-size:18px;line-height:1.3;font-weight:600;color:#212529">${escHtml(o.title)}</h1>`,
    o.content,
    button,
    `</td></tr>`,
    footer
      ? `<tr><td style="padding:12px 20px;border-top:1px solid #e9ecef;font-family:${font};font-size:12px;line-height:1.4;color:#5c636a">${footer}</td></tr>`
      : '',
    `</table></td></tr></table></body></html>`,
  ].join('');
}

/** A plain message body as HTML paragraphs (escaped; line breaks kept). */
export const bodyHtml = (body: string): string =>
  body
    ? body
        .split(/\n{2,}/)
        .map((p) => `<p style="margin:0 0 10px">${escHtml(p).replace(/\n/g, '<br>')}</p>`)
        .join('')
    : '';

/** The logo as a data URL (preview, Teams). */
export const logoDataUrl = (logo: MessageLogo): string => `data:${logo.mime};base64,${logo.data.toString('base64')}`;
