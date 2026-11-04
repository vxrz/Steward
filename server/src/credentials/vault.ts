import { PVAULT_KIND, PVAULT_LIMITS, type PvSecretReadout } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { vault } from '../vault.js';
import { logger } from '../log.js';
import { HttpError, parseJson } from '../util.js';
import { platformFor } from '../monitors/platforms.js';
import { PvClient } from '../pvault/client.js';
import { lookupSecrets } from '../pvault/service.js';
import { currentUser } from '../auth/context.js';
import { addEvent, credentialRow, requireCredential, toCredential } from './service.js';

/**
 * Credentials register entries linked to their secret in IBM Verify Privilege Vault (#205): every few hours (or on
 * "Read now") Steward reads the secret's summary – name, template, folder, last password change, expiry, automatic
 * changing, heartbeat; never its value – with the rights of whoever last changed the entry. The vault's last change
 * counts as the entry's last rotation (rotation due dates and reminders follow it), its expiry as the entry's when the
 * entry has none. A newer last change is a "rotated" event in the entry's history.
 */

const DAY = 86_400_000;

interface Row {
  id: string;
  name: string;
  vault_platform_id: string | null;
  vault_secret_id: number | null;
  vault_state: string | null;
  updated_by: string;
  archived: number;
}

/** Reads the linked secret now as `actor`; a failed read keeps what was read before, with the error. */
export async function readVaultLink(id: string, actor: string, now = Date.now()): Promise<PvSecretReadout> {
  const r = db().get<Row>('SELECT id, name, vault_platform_id, vault_secret_id, vault_state, updated_by, archived FROM credentials WHERE id = ?', id);
  if (!r) throw new HttpError(404, `Credential ${id} not found`, 'CREDENTIAL_NOT_FOUND', { id });
  if (!r.vault_platform_id || !r.vault_secret_id) throw new HttpError(400, 'Link the entry to its vault secret first', 'CREDENTIAL_VAULT_REQUIRED');
  const at = new Date(now).toISOString();
  const before = parseJson<PvSecretReadout | null>(r.vault_state, null);
  let readout: PvSecretReadout;
  try {
    const { platform, secrets } = platformFor(actor, r.vault_platform_id);
    if (platform.kind !== PVAULT_KIND) throw new Error(`"${platform.name}" is not an IBM Verify Privilege Vault platform`);
    const sec = await new PvClient(platform, secrets).secret(Number(r.vault_secret_id));
    readout = {
      readAt: at,
      error: null,
      secret: {
        id: sec.id,
        name: sec.name,
        template: sec.templateName,
        folder: sec.folderPath,
        // a failed change (out of sync) is no rotation: the last change known stays
        lastChangeAt: sec.outOfSync ? (before?.secret?.lastChangeAt ?? null) : sec.lastPasswordChangeAt,
        expiresAt: sec.daysUntilExpiration === null ? null : new Date(now + sec.daysUntilExpiration * DAY).toISOString().slice(0, 10) + 'T00:00:00.000Z',
        autoChangeEnabled: sec.autoChangeEnabled,
        heartbeat: sec.heartbeat,
        outOfSync: sec.outOfSync,
      },
    };
  } catch (e) {
    readout = { readAt: at, error: (e as Error).message.slice(0, 500), secret: before?.secret ?? null };
  }
  db().tx(() => {
    db().run('UPDATE credentials SET vault_state = ? WHERE id = ?', JSON.stringify(readout), id);
    const was = before?.secret?.lastChangeAt ?? null;
    const is = readout.secret?.lastChangeAt ?? null;
    // rotated in the vault since the last read: a line in the entry's history and the audit log
    if (!readout.error && before && is && (!was || is > was)) {
      addEvent(id, 'rotated', 'system', 'Rotated in the vault', { source: 'vault', at: is, secretId: r.vault_secret_id });
      audit({
        actor: 'system',
        action: 'credential.vault_rotated',
        entityType: 'credential',
        entityId: id,
        summary: `Credential register: "${r.name}" was rotated in the vault (${is.slice(0, 10)})`,
        details: { platformId: r.vault_platform_id, secretId: r.vault_secret_id, from: was, to: is },
      });
    }
  });
  return readout;
}

/** "Read now" on an entry (its editors): the read uses the requester's rights on the vault platform. */
export async function readVaultLinkNow(id: string) {
  const u = currentUser();
  requireCredential(id, 'edit');
  await readVaultLink(id, u!.username);
  return toCredential(credentialRow(id));
}

/** Secrets of a vault platform the requester may use whose name contains the text (for linking an entry). */
export async function findVaultSecrets(platformId: string, q: string) {
  const u = currentUser();
  const { platform, secrets } = (() => {
    try {
      return platformFor(u!.username, platformId);
    } catch (e) {
      throw new HttpError(400, (e as Error).message, 'CREDENTIAL_VAULT_PLATFORM');
    }
  })();
  if (platform.kind !== PVAULT_KIND) throw new HttpError(400, 'A vault link needs an IBM Verify Privilege Vault platform', 'CREDENTIAL_VAULT_PLATFORM');
  if (q.trim().length < 2) return [];
  return lookupSecrets(platform, secrets, q.trim());
}

/** Every linked entry whose readout is older than PVAULT_LIMITS.refreshHours (background job). */
export async function runVaultLinkJob(now = Date.now()): Promise<number> {
  if (!vault().unlocked) return 0;
  const rows = db().all<Row>(
    `SELECT c.id, c.name, c.vault_platform_id, c.vault_secret_id, c.vault_state, c.updated_by, c.archived FROM credentials c
     JOIN platforms p ON p.id = c.vault_platform_id WHERE c.vault_secret_id IS NOT NULL AND c.archived = 0 AND p.kind = ?`,
    PVAULT_KIND,
  );
  let n = 0;
  for (const r of rows) {
    const last = parseJson<PvSecretReadout | null>(r.vault_state, null);
    const age = last ? now - Date.parse(last.readAt) : -1;
    if (last && age >= 0 && age < PVAULT_LIMITS.refreshHours * 3_600_000) continue;
    try {
      await readVaultLink(r.id, r.updated_by, now);
      n++;
    } catch (err) {
      logger.warn({ err, credential: r.id }, 'reading a vault secret of the credentials register failed');
    }
  }
  return n;
}
