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
            ...(m.body ? [{ type: 'TextBlock', text: m.body, wrap: true }] : []),
            { type: 'TextBlock', text: `${look.name} · ${m.event}`, isSubtle: true, size: 'Small', wrap: true },
            ...(look.footer ? [{ type: 'TextBlock', text: look.footer, isSubtle: true, size: 'Small', wrap: true, spacing: 'None' }] : []),
          ],
          actions: [{ type: 'Action.OpenUrl', title: t(m.locale, 'common.openIn', { brand: look.name }), url: m.link }],
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
  const open = { label: t(m.locale, 'common.openIn', { brand: look.name }), href: m.link };
  const banner = isDryRun(m.data) ? dryRunBanner(m.locale) : undefined;
  const text = (banner ? `${banner}\n\n` : '') + (parts?.text ?? `${m.title}\n\n${m.body}\n\n${m.link}\n`) + (look.footer ? `\n--\n${look.footer}\n` : '');
  const html = emailHtml({
    banner,
    look,
    locale: m.locale,
    title: m.title,
    content: parts ? parts.html : bodyHtml(m.body),
    tone: parts ? undefined : eventTone(m.event, m.data),
    button: parts?.button ?? open,
    note: parts?.note,
    logoSrc,
  });
  return { subject: `[${look.name}] ${m.title}`, text, html };
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
