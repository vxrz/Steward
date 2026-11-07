import {
  NOTIFICATION_EVENTS,
  type QuietHours,
  type NotificationChannel,
  type NotificationEvent,
  type NotificationSettings,
  type NotificationSettingsInput,
} from '@sm/shared';
import { config } from '../config.js';
import { vault } from '../vault.js';
import { audit } from '../audit.js';
import { readSetting, writeSetting } from '../settings.js';
import { HttpError } from '../util.js';

/**
 * Channel configuration. Plain values live in the settings table; the SMTP
 * password and webhook URLs (which carry their own credentials) are encrypted
 * with the vault and never returned by the API.
 */
type StoredConfig = Omit<NotificationSettings, 'email' | 'teams' | 'webhook'> & {
  email: Omit<NotificationSettings['email'], 'hasPassword'>;
  teams: { enabled: boolean; quietHours?: QuietHours };
  webhook: { enabled: boolean; format?: 'json' | 'teams'; quietHours?: QuietHours };
};

export interface ChannelSecrets {
  smtpPassword?: string;
  teamsWebhookUrl?: string;
  webhookUrl?: string;
}

const CONFIG_KEY = 'notifications.config';
const SECRETS_KEY = 'notifications.secrets';

export function defaultRoutes(): Record<NotificationEvent, NotificationChannel[]> {
  const withEmail: NotificationEvent[] = [
    'task.assigned',
    'run.failed',
    'check.failed',
    'check.resolved',
    'credential.due',
    'report.ready',
    'ticket.unchecked',
    'summary.daily',
    'access.undocumented',
    'document.review',
    'stack.eol',
    'stack.release',
    'maintenance.announced',
    'measure.due',
    'backup.failed',
    'mcp.request',
    'platform.failing',
    'ai.budget',
    'cost.budget',
    'contract.failed',
  ];
  // emergency access: every channel that is set up, so nobody can use it unnoticed
  return Object.fromEntries(
    NOTIFICATION_EVENTS.map((e) => [e, e === 'security.emergency' ? ['inApp', 'email', 'teams'] : withEmail.includes(e) ? ['inApp', 'email'] : ['inApp']]),
  ) as Record<NotificationEvent, NotificationChannel[]>;
}

const DEFAULTS = (): StoredConfig => ({
  email: { enabled: false, host: '', port: 587, secure: false, user: undefined, from: '' },
  teams: { enabled: false },
  webhook: { enabled: false },
  routes: defaultRoutes(),
  baseUrl: undefined,
  allowedEmailDomains: [],
});

function storedConfig(): StoredConfig {
  const s = readSetting<Partial<StoredConfig>>(CONFIG_KEY, {});
  const d = DEFAULTS();
  return {
    email: { ...d.email, ...s.email },
    teams: { ...d.teams, ...s.teams },
    webhook: { ...d.webhook, ...s.webhook },
    routes: { ...d.routes, ...s.routes },
    baseUrl: s.baseUrl || undefined,
    allowedEmailDomains: Array.isArray(s.allowedEmailDomains) ? s.allowedEmailDomains : [],
  };
}

/** Which secrets exist (readable while the vault is locked). */
function secretKeys(): (keyof ChannelSecrets)[] {
  return readSetting<{ keys?: (keyof ChannelSecrets)[] }>(SECRETS_KEY, {}).keys ?? [];
}

export function channelSecrets(): ChannelSecrets {
  const blob = readSetting<{ blob?: string }>(SECRETS_KEY, {}).blob;
  return blob ? vault().decrypt<ChannelSecrets>(blob) : {};
}

function saveSecrets(s: ChannelSecrets): void {
  const clean = Object.fromEntries(Object.entries(s).filter(([, v]) => v)) as ChannelSecrets;
  const keys = Object.keys(clean) as (keyof ChannelSecrets)[];
  writeSetting(SECRETS_KEY, keys.length ? { blob: vault().encrypt(clean), keys } : null);
}

export function getNotificationSettings(): NotificationSettings {
  const c = storedConfig();
  const keys = secretKeys();
  return {
    email: { ...c.email, hasPassword: keys.includes('smtpPassword') },
    teams: { enabled: c.teams.enabled, hasWebhookUrl: keys.includes('teamsWebhookUrl'), ...(c.teams.quietHours ? { quietHours: c.teams.quietHours } : {}) },
    webhook: {
      enabled: c.webhook.enabled,
      hasUrl: keys.includes('webhookUrl'),
      ...(c.webhook.format === 'teams' ? { format: 'teams' as const } : {}),
      ...(c.webhook.quietHours ? { quietHours: c.webhook.quietHours } : {}),
    },
    routes: c.routes,
    baseUrl: c.baseUrl,
    allowedEmailDomains: c.allowedEmailDomains,
  };
}

/** A domain (corp.example) or all subdomains of one (*.corp.example). */
const DOMAIN_RULE = /^(\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const MAX_EMAIL_DOMAINS = 100;

/** Lower case, without a leading "@", unique; 400 for anything that is not a domain. */
export function normalizeEmailDomains(list: string[]): string[] {
  const out = [...new Set(list.map((d) => d.trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '')).filter(Boolean))];
  for (const d of out) {
    if (d.length > 253 || !DOMAIN_RULE.test(d))
      throw new HttpError(400, `"${d.slice(0, 80)}" is not a domain – enter e.g. corp.example or *.corp.example`, 'INVALID_DOMAIN', { domain: d.slice(0, 80) });
  }
  if (out.length > MAX_EMAIL_DOMAINS) throw new HttpError(400, `At most ${MAX_EMAIL_DOMAINS} allowed e-mail domains`);
  return out;
}

const CHANNELS: NotificationChannel[] = ['inApp', 'email', 'teams', 'webhook'];

/** Quiet hours of an instance channel (ADR 0012): omitted keeps the stored ones, null removes them. */
const keptQuiet = (input: QuietHours | null | undefined, stored: QuietHours | undefined): { quietHours?: QuietHours } =>
  input === undefined ? (stored ? { quietHours: stored } : {}) : input ? { quietHours: input } : {};

function checkUrl(u: string | undefined, what: string): void {
  if (!u) return;
  try {
    if (!/^https?:$/.test(new URL(u).protocol)) throw new Error();
  } catch {
    throw new HttpError(400, `${what}: enter an http(s) URL`);
  }
}

/** Omitted secret = keep, empty string = remove. */
export function saveNotificationSettings(input: NotificationSettingsInput): NotificationSettings {
  checkUrl(input.teams.webhookUrl, 'Teams webhook URL');
  checkUrl(input.webhook.url, 'Webhook URL');
  checkUrl(input.baseUrl || undefined, 'Base URL');
  if (input.email.enabled && (!input.email.host || !input.email.from)) throw new HttpError(400, 'E-mail: SMTP host and sender address are required');
  const routes = defaultRoutes();
  for (const e of NOTIFICATION_EVENTS) {
    const list = input.routes?.[e];
    if (list) routes[e] = CHANNELS.filter((c) => list.includes(c));
  }
  const next: StoredConfig = {
    email: {
      enabled: input.email.enabled,
      host: input.email.host.trim(),
      port: input.email.port,
      secure: input.email.secure,
      user: input.email.user?.trim() || undefined,
      from: input.email.from.trim(),
    },
    teams: { enabled: input.teams.enabled, ...keptQuiet(input.teams.quietHours, storedConfig().teams.quietHours) },
    webhook: {
      enabled: input.webhook.enabled,
      ...(input.webhook.format === 'teams' ? { format: 'teams' as const } : {}),
      ...keptQuiet(input.webhook.quietHours, storedConfig().webhook.quietHours),
    },
    routes,
    baseUrl: input.baseUrl?.trim().replace(/\/+$/, '') || undefined,
    allowedEmailDomains: input.allowedEmailDomains === undefined ? storedConfig().allowedEmailDomains : normalizeEmailDomains(input.allowedEmailDomains),
  };
  const secrets = secretKeys().length ? channelSecrets() : {};
  const changedSecrets: string[] = [];
  const apply = (key: keyof ChannelSecrets, v: string | undefined, label: string) => {
    if (v === undefined) return;
    if ((secrets[key] ?? '') !== v) changedSecrets.push(label);
    secrets[key] = v || undefined;
  };
  // The stored SMTP password belongs to the server and account it was entered for: it never goes to another host, port
  // or user. A change of those needs the password again (or none, without a user).
  const before = storedConfig().email;
  // (turning TLS off counts too: the password would then cross the network in clear text)
  const moved =
    before.host.toLowerCase() !== next.email.host.toLowerCase() ||
    before.port !== next.email.port ||
    (before.user ?? '') !== (next.email.user ?? '') ||
    (before.secure && !next.email.secure);
  if (moved && secrets.smtpPassword && input.email.password === undefined) {
    if (next.email.user) throw new HttpError(400, 'The SMTP server, port, user or TLS changed – enter the SMTP password again', 'SMTP_PASSWORD_AGAIN');
    secrets.smtpPassword = undefined;
    changedSecrets.push('SMTP password (removed with the server)');
  }
  apply('smtpPassword', input.email.password, 'SMTP password');
  apply('teamsWebhookUrl', input.teams.webhookUrl?.trim(), 'Teams webhook URL');
  apply('webhookUrl', input.webhook.url?.trim(), 'webhook URL');
  if (next.teams.enabled && !secrets.teamsWebhookUrl) throw new HttpError(400, 'Teams: enter the webhook URL');
  if (next.webhook.enabled && !secrets.webhookUrl) throw new HttpError(400, 'Webhook: enter the URL');
  const enabled = [next.email.enabled && 'e-mail', next.teams.enabled && 'Teams', next.webhook.enabled && 'webhook'].filter(Boolean);
  const before0 = storedConfig();
  writeSetting(CONFIG_KEY, next);
  saveSecrets(secrets);
  for (const ch of ['teams', 'webhook'] as const) {
    const a = before0[ch].quietHours ?? null;
    const b = next[ch].quietHours ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b))
      audit({
        action: 'notification.quiet_hours_changed',
        entityType: 'settings',
        entityId: `notifications:${ch}`,
        summary: `Quiet hours of the instance ${ch === 'teams' ? 'Teams channel' : 'webhook (Teams format)'} ${b?.enabled ? `on (${b.timeZone})` : 'off'}`,
        details: { target: ch === 'teams' ? 'teams:instance' : 'webhook:instance', from: a, to: b },
      });
  }
  audit({
    action: 'notification.settings_changed',
    entityType: 'settings',
    entityId: 'notifications',
    summary: `Notification settings changed (channels: ${enabled.join(', ') || 'in-app only'})${changedSecrets.length ? `; ${changedSecrets.join(', ')} changed` : ''}`,
    details: { ...next, secretsChanged: changedSecrets },
  });
  return getNotificationSettings();
}

/**
 * Absolute base URL for links in e-mails, Teams cards and webhooks: the base URL of the notification settings
 * (as entered, including any path), else SM_PUBLIC_URL (including the base path), else this server on localhost.
 */
export function publicBaseUrl(): string {
  const configured = storedConfig().baseUrl || config.publicUrl;
  if (configured) return configured;
  return `${config.tls ? 'https' : 'http'}://localhost:${config.port}${config.basePath}`;
}

export function absoluteLink(link: string | undefined): string {
  const base = publicBaseUrl();
  if (!link) return base + '/';
  return /^https?:\/\//.test(link) ? link : base + (link.startsWith('/') ? link : '/' + link);
}
