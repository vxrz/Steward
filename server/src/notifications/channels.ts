import nodemailer from 'nodemailer';
import { EnvHttpProxyAgent, fetch } from 'undici';
import type { NotificationSettings } from '@sm/shared';
import type { ChannelSecrets } from './settings.js';
import { BRAND } from '@sm/shared';

/** What every external channel receives. `link` is absolute. */
export interface OutgoingMessage {
  event: string;
  title: string;
  body: string;
  link: string;
  ts: string;
  data?: Record<string, unknown>;
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
  await postJson(url, { event: m.event, title: m.title, body: m.body, link: m.link, ts: m.ts, data: m.data ?? {} });
}

/** Adaptive Card message – accepted by Teams Workflows ("post to a channel") and classic incoming webhooks. */
export function teamsCard(m: OutgoingMessage): unknown {
  return {
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
            { type: 'TextBlock', text: m.title, weight: 'Bolder', size: 'Medium', wrap: true },
            ...(m.body ? [{ type: 'TextBlock', text: m.body, wrap: true }] : []),
            { type: 'TextBlock', text: `${BRAND.name} · ${m.event}`, isSubtle: true, size: 'Small', wrap: true },
          ],
          actions: [{ type: 'Action.OpenUrl', title: `Open in ${BRAND.name}`, url: m.link }],
        },
      },
    ],
  };
}

export async function sendTeams(url: string, m: OutgoingMessage): Promise<void> {
  await postJson(url, teamsCard(m));
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export async function sendEmail(cfg: NotificationSettings['email'], secrets: ChannelSecrets, to: string, m: OutgoingMessage): Promise<void> {
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: secrets.smtpPassword ?? '' } : undefined,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS * 2,
  });
  try {
    await transport.sendMail({
      from: cfg.from,
      to,
      subject: `[${BRAND.name}] ${m.title}`,
      text: `${m.title}\n\n${m.body}\n\n${m.link}\n`,
      html: `<p><strong>${esc(m.title)}</strong></p><p>${esc(m.body).replace(/\n/g, '<br>')}</p><p><a href="${esc(m.link)}">Open in ${BRAND.name}</a></p>`,
    });
  } finally {
    transport.close();
  }
}
