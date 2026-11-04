import { z } from 'zod';
import { ENTRA_KIND, type EntraAppCredential, type EntraRegisterImport } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { me } from '../auth/access.js';
import { getPlatform, getSecrets } from '../platforms/service.js';
import { buildUrl } from '../platforms/http.js';
import { assertOutboundAllowed } from '../platforms/outbound.js';
import { outboundContext } from '../platforms/policyContext.js';
import { HttpError, nowIso } from '../util.js';
import { addEvent, canCreateCredentials, createCredential, credentialInputSchema, credentialPermissions, type CredentialRow } from '../credentials/service.js';
import { GraphError } from './graph.js';
import { appCredentials, signInHint } from './service.js';

/**
 * App registration secrets and certificates into the credentials register (v0.5.0, docs/ENTRA.md): one entry per
 * secret or certificate, of type "API client" or "Certificate", linked to the Microsoft Graph platform, with the end
 * date as its expiry – so the register's reminders cover them. An entry is found again by the key id in its location
 * ("… (key id <id>)"); a later import updates its expiry when Entra ID says otherwise (history and audit log) and
 * changes nothing else. Only names, ids and dates are read – Graph never returns a secret's value.
 */

export const entraImportSchema = z
  .object({
    platformId: z.string().min(1).max(100),
    /** Only credentials that end within this many days (expired ones too); null: all */
    withinDays: z.number().int().min(0).max(3650).nullable().default(null),
    /** Leave out credentials that ended more than 30 days ago (rotated and forgotten) */
    skipLongExpired: z.boolean().default(true),
    /** Only list what would happen */
    dryRun: z.boolean().default(false),
  })
  .strict();

const marker = (keyId: string) => `(key id ${keyId})`;

function locationOf(c: EntraAppCredential): string {
  const where = c.owner === 'application' ? 'App registrations' : 'Enterprise applications';
  const what = c.type === 'secret' ? 'client secret' : 'certificate';
  return `Entra ID: ${where} → ${c.appName} → Certificates & secrets → ${what}${c.name ? ` “${c.name}”` : ''} ${marker(c.keyId)}`.slice(0, 1000);
}

/** The Entra admin center page of the app registration's credentials (a link; it holds no secret). */
function portalUrl(c: EntraAppCredential): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(c.appId)) return null;
  return c.owner === 'application'
    ? `https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Credentials/appId/${c.appId}`
    : `https://entra.microsoft.com/#view/Microsoft_AAD_IAM/ManagedAppMenuBlade/~/SignOn/appId/${c.appId}`;
}

export async function importEntraCredentials(input: z.infer<typeof entraImportSchema>): Promise<EntraRegisterImport> {
  const u = me();
  if (!canCreateCredentials(u))
    throw new HttpError(403, 'You are not allowed to add entries to the credentials register', 'FORBIDDEN', { context: 'createCredential' });
  const platform = getPlatform(input.platformId);
  if (!platform.permissions.includes('use')) throw new HttpError(404, `Platform ${input.platformId} not found`, 'PLATFORM_NOT_FOUND', { id: input.platformId });
  if (platform.kind !== ENTRA_KIND) throw new HttpError(400, 'Importing app credentials needs a Microsoft Graph platform', 'ENTRA_PLATFORM_REQUIRED');
  const secrets = getSecrets(platform.id);
  await assertOutboundAllowed(await buildUrl(platform, secrets, '/', {}), outboundContext());
  let items: EntraAppCredential[];
  try {
    items = (await appCredentials(platform, secrets)).items;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const detail = signInHint((e as Error).message).slice(0, 500);
    throw new HttpError(e instanceof GraphError && e.status === 403 ? 403 : 502, `Entra ID could not be read: ${detail}`, 'ENTRA_READ', { detail });
  }
  const chosen = items.filter(
    (c) =>
      c.keyId &&
      (input.withinDays === null || (c.daysLeft !== null && c.daysLeft <= input.withinDays)) &&
      !(input.skipLongExpired && c.daysLeft !== null && c.daysLeft < -30),
  );
  const existing = db().all<CredentialRow>('SELECT * FROM credentials WHERE platform_id = ? AND archived = 0', platform.id);
  const out: EntraRegisterImport['items'] = [];
  for (const c of chosen) {
    const row = existing.find((r) => r.location_text.includes(marker(c.keyId)));
    const base = { appName: c.appName, appId: c.appId, type: c.type, name: c.name, keyId: c.keyId, endDateTime: c.endDateTime, daysLeft: c.daysLeft };
    if (!row) {
      if (input.dryRun) {
        out.push({ ...base, action: 'create', credentialId: null });
        continue;
      }
      const created = createCredential(
        credentialInputSchema.parse({
          name: `${c.appName} – ${c.type === 'secret' ? 'client secret' : 'certificate'}${c.name ? ` “${c.name}”` : ''}`.slice(0, 200),
          type: c.type === 'secret' ? 'apiClient' : 'certificate',
          platformId: platform.id,
          description: `${c.owner === 'application' ? 'App registration' : 'Enterprise application'} ${c.appName} (application id ${c.appId}) in Entra ID – imported from Microsoft Graph.`,
          location: { text: locationOf(c), url: portalUrl(c) },
          issuedAt: c.startDateTime,
          expiresAt: c.endDateTime,
          tags: ['entra-id'],
        }),
      );
      out.push({ ...base, action: 'create', credentialId: created.id });
      continue;
    }
    const same = !c.endDateTime ? !row.expires_at : !!row.expires_at && Math.abs(Date.parse(row.expires_at) - Date.parse(c.endDateTime)) <= 12 * 3_600_000;
    if (same) {
      out.push({ ...base, action: 'unchanged', credentialId: row.id });
      continue;
    }
    if (!credentialPermissions(u, row).includes('edit')) {
      out.push({ ...base, action: 'notAllowed', credentialId: row.id });
      continue;
    }
    if (!input.dryRun)
      db().tx(() => {
        db().run(
          'UPDATE credentials SET expires_at = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?',
          c.endDateTime,
          nowIso(),
          u.username,
          row.id,
        );
        addEvent(row.id, 'expiryImported', u.username, '', { from: row.expires_at, to: c.endDateTime, platformId: platform.id, keyId: c.keyId });
        audit({
          action: 'credential.expiry_synced',
          entityType: 'credential',
          entityId: row.id,
          summary: `Credential register: "${row.name}" expires ${c.endDateTime ? c.endDateTime.slice(0, 10) : 'never'} (was ${row.expires_at ? row.expires_at.slice(0, 10) : 'not set'}) – from Entra ID "${platform.name}"`,
          details: { from: row.expires_at, to: c.endDateTime, platformId: platform.id, keyId: c.keyId, source: 'entra' },
        });
      });
    out.push({ ...base, action: 'update', credentialId: row.id });
  }
  const count = (a: EntraRegisterImport['items'][number]['action']) => out.filter((x) => x.action === a).length;
  const result: EntraRegisterImport = {
    platformId: platform.id,
    dryRun: input.dryRun,
    read: items.length,
    created: count('create'),
    updated: count('update'),
    unchanged: count('unchanged'),
    notAllowed: count('notAllowed'),
    items: out,
  };
  if (!input.dryRun && (result.created || result.updated))
    audit({
      action: 'credential.imported',
      entityType: 'platform',
      entityId: platform.id,
      summary: `Credential register: ${result.created} app credential(s) imported from Entra ID "${platform.name}", ${result.updated} expiry date(s) updated`,
      details: { platformId: platform.id, created: result.created, updated: result.updated, unchanged: result.unchanged, withinDays: input.withinDays },
    });
  return result;
}
