import {
  BRAND,
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
import { readSetting, writeSetting } from '../settings.js';
import { getThemeSettings, logoFile } from '../theme/service.js';
import { imageMime, logo as reportLogo } from '../reports/branding.js';
import { HttpError, nowIso } from '../util.js';

/**
 * Look of e-mails and Teams messages (Settings → Notifications → Look): name, colour, logo and a
 * footer text. Empty fields follow Settings → Appearance, so messages carry the company's name and
 * colour without extra setup. Stored as the internal setting "notifications.look".
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

function sanitize(v: Partial<Stored>): Stored {
  return {
    name: clean(v.name, NOTIFICATION_LOOK_NAME_MAX),
    color: typeof v.color === 'string' && v.color ? (normalizeHex(v.color) ?? '') : '',
    logoSource: (NOTIFICATION_LOGO_SOURCES as readonly string[]).includes(v.logoSource as string) ? v.logoSource! : NOTIFICATION_LOOK_DEFAULTS.logoSource,
    footer: clean(v.footer, NOTIFICATION_LOOK_FOOTER_MAX),
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
  if (p.name !== undefined && p.name.trim().length > NOTIFICATION_LOOK_NAME_MAX) out.push(`Name: at most ${NOTIFICATION_LOOK_NAME_MAX} characters`);
  if (p.footer !== undefined && p.footer.trim().length > NOTIFICATION_LOOK_FOOTER_MAX) out.push(`Footer: at most ${NOTIFICATION_LOOK_FOOTER_MAX} characters`);
  if (p.logoSource !== undefined && !(NOTIFICATION_LOGO_SOURCES as readonly string[]).includes(p.logoSource)) out.push('Logo: app, report or none');
  return out;
}

export interface MessageLogo {
  data: Buffer;
  mime: 'image/png' | 'image/jpeg';
}

/** The logo of a source, if it exists and mail clients can show it (PNG or JPEG). */
function logoOf(source: NotificationLookInput['logoSource']): { logo: MessageLogo | null; problem?: 'missing' | 'type' } {
  if (source === 'none') return { logo: null };
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
  footer: string;
  logo: MessageLogo | null;
  logoProblem?: 'missing' | 'type' | 'size';
}

/** The look with the fallbacks applied; `draft` previews unsaved settings. */
export function resolveLook(draft?: Partial<NotificationLookInput>): ResolvedLook {
  const s = draft ? sanitize({ ...stored(), ...draft }) : stored();
  const theme = getThemeSettings();
  const name = s.name || theme.appName || BRAND.name;
  const color = s.color || normalizeHex(theme.primaryColor) || BRAND.color;
  const onColor = contrastRatio(color, '#ffffff') >= contrastRatio(color, '#212529') ? '#ffffff' : '#212529';
  const { logo, problem } = logoOf(s.logoSource);
  const big = !!logo && logo.data.length > EMAIL_LOGO_MAX_BYTES;
  return {
    name,
    color,
    onColor,
    footer: s.footer,
    logo: big ? null : logo,
    ...(problem ? { logoProblem: problem } : big ? { logoProblem: 'size' as const } : {}),
  };
}

export function getLook(): NotificationLook {
  const s = stored();
  const r = resolveLook();
  return {
    name: s.name,
    color: s.color,
    logoSource: s.logoSource,
    footer: s.footer,
    effective: { name: r.name, color: r.color, logo: !!r.logo, ...(r.logoProblem ? { logoProblem: r.logoProblem } : {}) },
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
  for (const k of ['name', 'color', 'logoSource', 'footer'] as const) if (cur[k] !== next[k]) changed[k] = { from: cur[k], to: next[k] };
  if (Object.keys(changed).length) writeSetting(KEY, { ...next, updatedAt: nowIso(), updatedBy: by });
  return { look: getLook(), changed };
}

/** The setting from a migration package: null unless it is an object (the fields are cleaned like a save). */
export function checkedLook(v: unknown): Stored | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return sanitize(v as Partial<Stored>);
}

// ---------- tone ----------

/** Adaptive Card container styles; e-mails use the matching colours. */
export type MessageTone = 'good' | 'warning' | 'attention' | 'accent';

export const TONE_HEX: Record<MessageTone, string> = { good: '#2b8a3e', warning: '#e8590c', attention: '#c92a2a', accent: '#1971c2' };

const BAD_EVENTS = new Set(['run.failed', 'check.failed', 'duty.missed', 'objective.breached', 'security.emergency', 'access.undocumented']);
const WARN_EVENTS = new Set([
  'task.assigned',
  'dataset.stale',
  'schedule.skipped',
  'credential.due',
  'ticket.unchecked',
  'document.review',
  'duty.due',
  'duty.exception',
  'duty.ended',
]);

/** How a message reads at a glance: red for failures, orange for something to do, green when a monitor is up again. */
export function eventTone(event: string, data?: Record<string, unknown>): MessageTone {
  if (event === 'monitor.status') {
    const status = data?.status;
    return status === 'up' ? 'good' : status === 'down' ? 'attention' : status === 'degraded' || status === 'blocked' ? 'warning' : 'accent';
  }
  if (BAD_EVENTS.has(event)) return 'attention';
  if (WARN_EVENTS.has(event)) return 'warning';
  return 'accent';
}

// ---------- e-mail layout ----------

export const escHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * The HTML e-mail around a message: a header bar in the colour with logo and name, the content, an
 * optional button and the footer text. Tables and inline styles only (Outlook, Gmail); light colours
 * that stay readable when a client darkens them. `content` is HTML the caller has escaped.
 */
export function emailHtml(o: {
  look: ResolvedLook;
  locale: Locale;
  title: string;
  content: string;
  tone?: MessageTone;
  button?: { label: string; href: string };
  /** Small print under the content (e.g. how to turn the daily summary off); HTML, escaped by the caller */
  note?: string;
  /** Image source of the logo: the cid for a sent e-mail, a data URL for the preview */
  logoSrc?: string;
}): string {
  const l = o.look;
  const logo =
    l.logo && o.logoSrc ? `<img src="${escHtml(o.logoSrc)}" alt="" height="28" style="display:block;height:28px;width:auto;max-width:160px;border:0">` : '';
  const strip = o.tone ? `<tr><td style="height:4px;line-height:4px;font-size:0;background:${TONE_HEX[o.tone]}">&nbsp;</td></tr>` : '';
  const button = o.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0 4px"><tr><td style="border-radius:6px;background:${l.color}"><a href="${escHtml(o.button.href)}" style="display:inline-block;padding:10px 18px;font-family:${FONT};font-size:14px;font-weight:600;color:${l.onColor};text-decoration:none;border-radius:6px">${escHtml(o.button.label)}</a></td></tr></table>`
    : '';
  const footer = [o.note ? `<p style="margin:0 0 6px">${o.note}</p>` : '', l.footer ? `<p style="margin:0">${escHtml(l.footer)}</p>` : ''].join('');
  return [
    '<!DOCTYPE html>',
    `<html lang="${o.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escHtml(o.title)}</title></head>`,
    `<body style="margin:0;padding:0;background:#f1f3f5">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f3f5"><tr><td align="center" style="padding:24px 12px">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border:1px solid #dee2e6;border-radius:8px;overflow:hidden">`,
    `<tr><td style="background:${l.color};padding:14px 20px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>`,
    logo ? `<td style="padding-right:12px;vertical-align:middle">${logo}</td>` : '',
    `<td style="vertical-align:middle;font-family:${FONT};font-size:16px;font-weight:600;color:${l.onColor}">${escHtml(l.name)}</td>`,
    `</tr></table></td></tr>`,
    strip,
    `<tr><td style="padding:20px;font-family:${FONT};font-size:14px;line-height:1.5;color:#212529">`,
    `<h1 style="margin:0 0 12px;font-size:18px;line-height:1.3;font-weight:600;color:#212529">${escHtml(o.title)}</h1>`,
    o.content,
    button,
    `</td></tr>`,
    footer
      ? `<tr><td style="padding:12px 20px;border-top:1px solid #e9ecef;font-family:${FONT};font-size:12px;line-height:1.4;color:#5c636a">${footer}</td></tr>`
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
