import nodemailer from 'nodemailer';
import { EnvHttpProxyAgent, fetch } from 'undici';
import type { Locale, NotificationSettings } from '@sm/shared';
import type { ChannelSecrets } from './settings.js';
import { BRAND } from '@sm/shared';
import { t } from '../i18n/index.js';
import {
  LOGO_CID,
  TEAMS_CARD_MAX_CHARS,
  TEAMS_LOGO_MAX_BYTES,
  bodyHtml,
  dryRunBanner,
  emailHtml,
  escHtml,
  eventTone,
  isDryRun,
  logoDataUrl,
  resolveLook,
  type ResolvedLook,
} from './look.js';

/** Logo height on a Teams card (Adaptive Cards take pixel heights). */
const TEAMS_LOGO_HEIGHT: Record<ResolvedLook['logoSize'], string> = { small: '20px', medium: '24px', large: '32px' };

/** What every external channel receives. `link` is absolute. */
export interface OutgoingMessage {
  event: string;
  /** Already in `locale` */
  title: string;
  body: string;
  /** Language of title/body; used for the fixed texts around them (button, link) */
  locale: Locale;
  link: string;
  ts: string;
  data?: Record<string, unknown>;
  /** E-mail only (e.g. the PDF of a scheduled report) */
  attachments?: { filename: string; content: Buffer; contentType: string }[];
  /**
   * E-mail only: own content instead of the message body (the daily summary). `html` is the content inside the
   * standard layout (already escaped), `note` small print above the footer, `button` replaces "Open in …".
   */
  emailParts?: { text: string; html: string; note?: string; button?: { label: string; href: string } };
  /** Structured content (#144), the same in e-mail and Teams: in that order below the body */
  parts?: MessageParts;
}

/** What a message says beyond title and body (#144). All optional; texts are in the message's language. */
export interface MessageParts {
  /** One line on what happened ("Got better: 12 → 11 · failing since …"), shown above the body */
  lead?: string;
  /** A small table: process, source, severity, since … */
  facts?: { label: string; value: string }[];
  /** The list behind the failure (the first ones; `more` = how many are left out) */
  items?: { list: string[]; more: number };
  /** Buttons before "Open in …", e.g. "Open runbook" (absolute links) */
  actions?: { label: string; href: string }[];
  /** Small print: why the reader got it */
  reason?: string;
  /** Small print link: where the messages of this source are set */
  settings?: { label: string; href: string };
}

/** The structured parts as plain text (e-mail text part, in-app body). */
export function partsText(p: MessageParts | undefined, opts: { facts?: boolean } = {}): { before: string; after: string } {
  if (!p) return { before: '', after: '' };
  const after = [
    opts.facts === false || !p.facts?.length ? '' : p.facts.map((f) => `${f.label}: ${f.value}`).join('\n'),
    p.items?.list.length ? p.items.list.map((i) => `• ${i}`).join('\n') + (p.items.more ? `\n+ ${p.items.more}` : '') : '',
    p.actions?.length ? p.actions.map((a) => `${a.label}: ${a.href}`).join('\n') : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return { before: p.lead ?? '', after };
}

const TIMEOUT_MS = 10000;
// Honours HTTP(S)_PROXY / NO_PROXY like the platform client does without an explicit proxy.
const dispatcher = new EnvHttpProxyAgent();

async function postJson(url: string, payload: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': BRAND.slug },
    body: JSON.stringify(payload),
    dispatcher,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
}

export async function sendWebhook(url: string, m: OutgoingMessage): Promise<void> {
  await postJson(url, { event: m.event, title: m.title, body: m.body, locale: m.locale, link: m.link, ts: m.ts, data: m.data ?? {} });
}

/** Adaptive Card message – accepted by Teams Workflows ("post to a channel") and classic incoming webhooks. */
export function teamsCard(m: OutgoingMessage, look: ResolvedLook = resolveLook()): unknown {
  // Adaptive Cards have no fonts, header styles or button colours: only the logo's size and position follow the look
  const image = (withLogo: boolean) =>
    withLogo && look.logo
      ? {
          type: 'Image',
          url: logoDataUrl(look.logo),
          height: TEAMS_LOGO_HEIGHT[look.logoSize],
          altText: look.name,
          ...(look.logoAlign === 'center' ? { horizontalAlignment: 'Center' } : {}),
        }
      : null;
  const head = (withLogo: boolean) => {
    const img = image(withLogo);
    if (look.logoAlign === 'center')
      return [...(img ? [img] : []), { type: 'TextBlock', text: look.name, weight: 'Bolder', wrap: true, horizontalAlignment: 'Center', spacing: 'Small' }];
    return [
      {
        type: 'ColumnSet',
        columns: [
          ...(img ? [{ type: 'Column', width: 'auto', verticalContentAlignment: 'Center', items: [img] }] : []),
          {
            type: 'Column',
            width: 'stretch',
            verticalContentAlignment: 'Center',
            items: [{ type: 'TextBlock', text: look.name, weight: 'Bolder', wrap: true }],
          },
        ],
      },
    ];
  };
  const dry = isDryRun(m.data);
  const p = m.parts;
  const actions = [
    ...(p?.actions ?? []).map((a) => ({ type: 'Action.OpenUrl', title: a.label, url: a.href })),
    { type: 'Action.OpenUrl', title: t(m.locale, 'common.openIn', { brand: look.name }), url: m.link },
    ...(p?.settings ? [{ type: 'Action.OpenUrl', title: p.settings.label, url: p.settings.href }] : []),
  ];
  const card = (withLogo: boolean) => ({
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            {
              // Adaptive Cards take named colours only: the strip shows how the message reads (failed, to do, up again; grey for a dry run)
              type: 'Container',
              style: eventTone(m.event, m.data),
              bleed: true,
              items: head(withLogo),
            },
            ...(dry ? [{ type: 'TextBlock', text: dryRunBanner(m.locale), weight: 'Bolder', wrap: true, spacing: 'Medium' }] : []),
            { type: 'TextBlock', text: m.title, weight: 'Bolder', size: 'Medium', wrap: true, spacing: 'Medium' },
            ...(p?.lead ? [{ type: 'TextBlock', text: p.lead, wrap: true, weight: 'Bolder', spacing: 'Small' }] : []),
            ...(m.body ? [{ type: 'TextBlock', text: m.body, wrap: true }] : []),
            ...(p?.facts?.length ? [{ type: 'FactSet', facts: p.facts.map((f) => ({ title: f.label, value: f.value })), spacing: 'Medium' }] : []),
            ...(p?.items?.list.length
              ? [
                  {
                    type: 'TextBlock',
                    text:
                      p.items.list.map((i) => `- ${i}`).join('\n') + (p.items.more ? `\n\n+ ${t(m.locale, 'common.moreItems', { count: p.items.more })}` : ''),
                    wrap: true,
                    spacing: 'Medium',
                  },
                ]
              : []),
            ...(p?.reason ? [{ type: 'TextBlock', text: p.reason, isSubtle: true, size: 'Small', wrap: true, spacing: 'Medium' }] : []),
            { type: 'TextBlock', text: `${look.name} · ${m.event}`, isSubtle: true, size: 'Small', wrap: true },
            ...(look.footer ? [{ type: 'TextBlock', text: look.footer, isSubtle: true, size: 'Small', wrap: true, spacing: 'None' }] : []),
          ],
          actions,
        },
      },
    ],
  });
  // a card may be at most 28 KB: the logo is embedded only when it is small and the card stays well below that
  const small = !!look.logo && look.logo.data.length <= TEAMS_LOGO_MAX_BYTES;
  const withLogo = card(small);
  return small && JSON.stringify(withLogo).length > TEAMS_CARD_MAX_CHARS ? card(false) : withLogo;
}

export async function sendTeams(url: string, m: OutgoingMessage): Promise<void> {
  await postJson(url, teamsCard(m));
}

/** Subject, text and HTML part of an e-mail in the configured look. `logoSrc` defaults to the attached logo (cid). */
export function emailContent(m: OutgoingMessage, look: ResolvedLook = resolveLook(), logoSrc = `cid:${LOGO_CID}`) {
  const parts = m.emailParts;
  const p = m.parts;
  const open = { label: t(m.locale, 'common.openIn', { brand: look.name }), href: m.link };
  const banner = isDryRun(m.data) ? dryRunBanner(m.locale) : undefined;
  const pt = partsText(p);
  const plain = [pt.before, m.body, pt.after].filter(Boolean).join('\n\n');
  const small = [p?.reason, p?.settings ? `${p.settings.label}: ${p.settings.href}` : ''].filter(Boolean).join('\n');
  const text =
    (banner ? `${banner}\n\n` : '') +
    (parts?.text ?? `${m.title}\n\n${plain}\n\n${m.link}\n${small ? `\n${small}\n` : ''}`) +
    (look.footer ? `\n--\n${look.footer}\n` : '');
  const html = emailHtml({
    banner,
    look,
    locale: m.locale,
    title: m.title,
    content: parts ? parts.html : partsHtml(m, p),
    tone: parts ? undefined : eventTone(m.event, m.data),
    button: parts?.button ?? open,
    buttons: parts ? undefined : p?.actions,
    note: parts?.note ?? noteHtml(p),
    logoSrc,
  });
  return { subject: `[${look.name}] ${m.title}`, text, html };
}

/** The body with the structured parts (#144) as e-mail HTML: lead, body, facts table, items (escaped). */
function partsHtml(m: OutgoingMessage, p: MessageParts | undefined): string {
  if (!p) return bodyHtml(m.body);
  const facts = p.facts?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:12px 0;border-collapse:collapse">${p.facts
        .map(
          (f) =>
            `<tr><td style="padding:3px 16px 3px 0;color:#5c636a;vertical-align:top;white-space:nowrap">${escHtml(f.label)}</td><td style="padding:3px 0;vertical-align:top">${escHtml(f.value)}</td></tr>`,
        )
        .join('')}</table>`
    : '';
  const items = p.items?.list.length
    ? `<ul style="margin:8px 0 10px;padding-left:20px">${p.items.list.map((i) => `<li style="margin:0 0 2px">${escHtml(i)}</li>`).join('')}</ul>${
        p.items.more ? `<p style="margin:0 0 10px;color:#5c636a">+ ${escHtml(t(m.locale, 'common.moreItems', { count: p.items.more }))}</p>` : ''
      }`
    : '';
  return [p.lead ? `<p style="margin:0 0 10px;font-weight:600">${escHtml(p.lead)}</p>` : '', bodyHtml(m.body), facts, items].join('');
}

/** Small print of the structured parts: why the reader got it and where it is set (escaped HTML). */
function noteHtml(p: MessageParts | undefined): string | undefined {
  if (!p?.reason && !p?.settings) return undefined;
  return [p.reason ? escHtml(p.reason) : '', p.settings ? `<a href="${escHtml(p.settings.href)}" style="color:#5c636a">${escHtml(p.settings.label)}</a>` : '']
    .filter(Boolean)
    .join(' ');
}

export async function sendEmail(cfg: NotificationSettings['email'], secrets: ChannelSecrets, to: string, m: OutgoingMessage): Promise<void> {
  const look = resolveLook();
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: secrets.smtpPassword ?? '' } : undefined,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS * 2,
  });
  const { subject, text, html } = emailContent(m, look);
  // the logo travels inside the message (cid): mail clients block remote images, and Steward is often not reachable from outside
  const attachments = [
    ...(look.logo
      ? [{ filename: look.logo.mime === 'image/png' ? 'logo.png' : 'logo.jpg', content: look.logo.data, contentType: look.logo.mime, cid: LOGO_CID }]
      : []),
    ...(m.attachments ?? []).map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
  ];
  try {
    await transport.sendMail({ from: cfg.from, to, subject, text, html, ...(attachments.length ? { attachments } : {}) });
  } finally {
    transport.close();
  }
}
