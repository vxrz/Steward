import { NOTIFICATION_EVENTS, type NotificationChannel, type NotificationEvent, type NotificationSettings, type NotificationSettingsInput } from '@sm/shared';
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
  teams: { enabled: boolean };
  webhook: { enabled: boolean };
};

export interface ChannelSecrets {
  smtpPassword?: string;
  teamsWebhookUrl?: string;
  webhookUrl?: string;
}

const CONFIG_KEY = 'notifications.config';
const SECRETS_KEY = 'notifications.secrets';

export function defaultRoutes(): Record<NotificationEvent, NotificationChannel[]> {
  const withEmail: NotificationEvent[] = ['task.assigned', 'run.failed', 'check.failed', 'credential.due', 'report.ready'];
  return Object.fromEntries(NOTIFICATION_EVENTS.map((e) => [e, withEmail.includes(e) ? ['inApp', 'email'] : ['inApp']])) as Record<
    NotificationEvent,
    NotificationChannel[]
  >;
}

const DEFAULTS = (): StoredConfig => ({
  email: { enabled: false, host: '', port: 587, secure: false, user: undefined, from: '' },
  teams: { enabled: false },
  webhook: { enabled: false },
  routes: defaultRoutes(),
  baseUrl: undefined,
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
    teams: { enabled: c.teams.enabled, hasWebhookUrl: keys.includes('teamsWebhookUrl') },
    webhook: { enabled: c.webhook.enabled, hasUrl: keys.includes('webhookUrl') },
    routes: c.routes,
    baseUrl: c.baseUrl,
  };
}

const CHANNELS: NotificationChannel[] = ['inApp', 'email', 'teams', 'webhook'];

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
    teams: { enabled: input.teams.enabled },
    webhook: { enabled: input.webhook.enabled },
    routes,
    baseUrl: input.baseUrl?.trim().replace(/\/+$/, '') || undefined,
  };
  const secrets = secretKeys().length ? channelSecrets() : {};
  const changedSecrets: string[] = [];
  const apply = (key: keyof ChannelSecrets, v: string | undefined, label: string) => {
    if (v === undefined) return;
    if ((secrets[key] ?? '') !== v) changedSecrets.push(label);
    secrets[key] = v || undefined;
  };
  apply('smtpPassword', input.email.password, 'SMTP password');
  apply('teamsWebhookUrl', input.teams.webhookUrl?.trim(), 'Teams webhook URL');
  apply('webhookUrl', input.webhook.url?.trim(), 'webhook URL');
  if (next.teams.enabled && !secrets.teamsWebhookUrl) throw new HttpError(400, 'Teams: enter the webhook URL');
  if (next.webhook.enabled && !secrets.webhookUrl) throw new HttpError(400, 'Webhook: enter the URL');
  writeSetting(CONFIG_KEY, next);
  saveSecrets(secrets);
  const enabled = [next.email.enabled && 'e-mail', next.teams.enabled && 'Teams', next.webhook.enabled && 'webhook'].filter(Boolean);
  audit({
    action: 'notification.settings_changed',
    entityType: 'settings',
    entityId: 'notifications',
    summary: `Notification settings changed (channels: ${enabled.join(', ') || 'in-app only'})${changedSecrets.length ? `; ${changedSecrets.join(', ')} changed` : ''}`,
    details: { ...next, secretsChanged: changedSecrets },
  });
  return getNotificationSettings();
}

/** Absolute base URL for links in e-mails, Teams cards and webhooks. */
export function publicBaseUrl(): string {
  const configured = storedConfig().baseUrl || process.env.SM_PUBLIC_URL?.trim().replace(/\/+$/, '');
  if (configured) return configured;
  return `${config.tls ? 'https' : 'http'}://localhost:${config.port}`;
}

export function absoluteLink(link: string | undefined): string {
  const base = publicBaseUrl();
  if (!link) return base + '/';
  return /^https?:\/\//.test(link) ? link : base + (link.startsWith('/') ? link : '/' + link);
}
