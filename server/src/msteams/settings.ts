import crypto from 'node:crypto';
import { z } from 'zod';
import { boundedRecord, type TeamsBotSettings } from '@sm/shared';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { vault } from '../vault.js';
import { HttpError } from '../util.js';
import { readSetting, writeSetting } from '../settings.js';
import { getProvider } from '../auth/sso.js';

/**
 * The Teams bot (ADR 0013 stage 2, a preview, off by default): the Entra app id, the allowed tenants, the sign-in
 * provider whose accounts the bot recognises (its stable identifier must be tid + oid) and the bot's credential – a
 * client certificate (preferred) or a secret – sealed with the vault (key rotation: vault-rotation.ts). The HMAC key
 * that signs the data of the cards is generated on the first save and kept with the credential.
 */

const CONFIG_KEY = 'notifications.teamsBot';
export const SECRETS_KEY = 'notifications.teamsBot.secrets';

interface Stored {
  enabled: boolean;
  appId: string;
  tenantIds: string[];
  providerId: string | null;
  credential: 'certificate' | 'secret';
  /** Channel target → the bot's conversation (teams_conversations.id) used for decision cards instead of the webhook */
  channels: Record<string, string>;
}

export interface BotSecrets {
  clientSecret?: string;
  certificatePem?: string;
  privateKeyPem?: string;
  /** Signs card data (kind, id, version) */
  hmacKey: string;
}

const DEFAULTS: Stored = { enabled: false, appId: '', tenantIds: [], providerId: null, credential: 'certificate', channels: {} };

export const botConfig = (): Stored => ({ ...DEFAULTS, ...readSetting<Partial<Stored>>(CONFIG_KEY, {}) });

const secretKeys = (): string[] => readSetting<{ keys?: string[] }>(SECRETS_KEY, {}).keys ?? [];

export function botSecrets(): BotSecrets | null {
  const blob = readSetting<{ blob?: string }>(SECRETS_KEY, {}).blob;
  if (!blob || !vault().unlocked) return null;
  return vault().decrypt<BotSecrets>(blob);
}

function saveSecrets(s: BotSecrets): void {
  const keys = Object.entries(s)
    .filter(([k, v]) => v && k !== 'hmacKey')
    .map(([k]) => k);
  writeSetting(SECRETS_KEY, { blob: vault().encrypt(s), keys });
}

/** The bot is on and can answer (configured, the vault unlocked). */
export const botEnabled = (): boolean => botConfig().enabled;

export function botSettingsView(): TeamsBotSettings {
  const c = botConfig();
  const keys = secretKeys();
  return {
    preview: true,
    enabled: c.enabled,
    appId: c.appId,
    tenantIds: c.tenantIds,
    providerId: c.providerId,
    credential: c.credential,
    hasCredential: c.credential === 'secret' ? keys.includes('clientSecret') : keys.includes('certificatePem') && keys.includes('privateKeyPem'),
    channels: c.channels,
    listener: config.teamsBotPort ? { port: config.teamsBotPort, path: '/teams/bot/messages' } : null,
  };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const teamsBotInput = z
  .object({
    enabled: z.boolean(),
    appId: z.string().trim().max(64),
    tenantIds: z.array(z.string().trim().regex(GUID, 'a tenant id is a GUID')).max(10),
    providerId: z.string().max(100).nullable(),
    credential: z.enum(['certificate', 'secret']),
    /** omitted: keep; empty: remove */
    clientSecret: z.string().max(2000).optional(),
    certificatePem: z.string().max(20000).optional(),
    privateKeyPem: z.string().max(20000).optional(),
    channels: boundedRecord(z.string().max(64), 200).optional(),
  })
  .strict();

/** Whether the provider identifies people by Entra tid + oid (the only identifiers Teams sends). */
export function providerUsesOid(providerId: string | null): boolean {
  if (!providerId) return false;
  try {
    const p = getProvider(providerId);
    return [...p.stableIdClaims].sort().join(',') === 'oid,tid';
  } catch {
    return false; // unknown provider
  }
}

const CHANNEL_TARGET = /^(teams:instance|webhook:instance|team:[A-Za-z0-9_-]{1,64})$/;

/** Saves the bot settings (step-up changeNotificationDelivery on the route; audited without secrets). */
export function saveBotSettings(input: z.infer<typeof teamsBotInput>): TeamsBotSettings {
  const before = botConfig();
  if (input.enabled && !input.appId) throw new HttpError(400, 'Enter the app id of the bot', 'TEAMS_BOT_APP_ID');
  if (input.enabled && !GUID.test(input.appId)) throw new HttpError(400, 'The app id is a GUID', 'TEAMS_BOT_APP_ID');
  if (input.enabled && !input.tenantIds.length) throw new HttpError(400, 'Enter at least one allowed tenant', 'TEAMS_BOT_TENANT');
  // only accounts linked by tid + oid can be recognised: anything else would match people by name (nOAuth)
  if (input.enabled && !providerUsesOid(input.providerId))
    throw new HttpError(400, 'The sign-in provider must identify people by tid + oid (the Entra ID preset)', 'TEAMS_BOT_NEEDS_OID');
  const channels = Object.fromEntries(Object.entries(input.channels ?? before.channels).filter(([k]) => CHANNEL_TARGET.test(k) && k !== '__proto__'));
  const old = secretKeys().length ? botSecrets() : null;
  if (secretKeys().length && !old) throw new HttpError(423, 'Unlock the vault first', 'VAULT_LOCKED');
  const secrets: BotSecrets = { ...(old ?? { hmacKey: crypto.randomBytes(32).toString('base64url') }) };
  const changed: string[] = [];
  const apply = (k: 'clientSecret' | 'certificatePem' | 'privateKeyPem', v: string | undefined) => {
    if (v === undefined) return;
    if ((secrets[k] ?? '') !== v.trim()) changed.push(k);
    secrets[k] = v.trim() || undefined;
  };
  apply('clientSecret', input.clientSecret);
  apply('certificatePem', input.certificatePem);
  apply('privateKeyPem', input.privateKeyPem);
  if (secrets.certificatePem || secrets.privateKeyPem) {
    try {
      if (secrets.privateKeyPem) crypto.createPrivateKey(secrets.privateKeyPem);
      if (secrets.certificatePem) new crypto.X509Certificate(secrets.certificatePem);
    } catch {
      throw new HttpError(400, 'The certificate or its private key is not valid PEM', 'TEAMS_BOT_CERTIFICATE');
    }
  }
  const hasCredential = input.credential === 'secret' ? !!secrets.clientSecret : !!secrets.certificatePem && !!secrets.privateKeyPem;
  if (input.enabled && !hasCredential) throw new HttpError(400, 'Enter the credential of the bot', 'TEAMS_BOT_CREDENTIAL');
  const next: Stored = {
    enabled: input.enabled,
    appId: input.appId,
    tenantIds: [...new Set(input.tenantIds.map((x) => x.toLowerCase()))],
    providerId: input.providerId,
    credential: input.credential,
    channels,
  };
  writeSetting(CONFIG_KEY, next);
  saveSecrets(secrets);
  audit({
    action: 'teams.bot_settings_changed',
    entityType: 'settings',
    entityId: 'teams-bot',
    summary: `Teams bot (preview) ${next.enabled ? 'on' : 'off'}${changed.length ? `; ${changed.join(', ')} changed` : ''}`,
    details: { before, after: next, credentialChanged: changed },
  });
  return botSettingsView();
}
