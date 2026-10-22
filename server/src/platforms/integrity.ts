import { BRAND } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { checkMac, configMac, type IntegrityState } from '../integrity.js';
import { readSetting, writeSetting } from '../settings.js';
import { vault } from '../vault.js';
import { HttpError, canonicalJson, parseJson, sha256 } from '../util.js';

/** The columns of a platform that are authenticated (everything that decides where and how requests go). */
export interface SealedPlatformRow {
  id: string;
  name: string;
  kind: string;
  base_url: string;
  environment: string;
  config: string;
  secrets: string | null;
  config_mac?: string | null;
}

const fields = (r: SealedPlatformRow) => ({
  v: 1,
  name: r.name,
  kind: r.kind,
  baseUrl: r.base_url,
  environment: r.environment,
  // auth type, token URL, trusted origins, default headers, TLS options, variables …
  config: parseJson<unknown>(r.config, null),
  // binds the credentials to this configuration (they cannot be moved to another platform row); the
  // plaintext is hashed (inside the HMAC), so re-encrypting them with a new data key keeps the seal valid
  secrets: secretsDigest(r.secrets),
});

function secretsDigest(blob: string | null): string | null {
  if (!blob) return null;
  try {
    return sha256(canonicalJson(vault().decrypt(blob)));
  } catch {
    return 'undecryptable';
  }
}

export function platformIntegrity(r: SealedPlatformRow): IntegrityState {
  return checkMac('platform', r.id, fields(r), r.config_mac);
}

/** Recomputes the seal after a change made through the application (inside the caller's transaction). */
export function sealPlatform(id: string): void {
  if (!vault().unlocked) return;
  const r = db().get<SealedPlatformRow>('SELECT id, name, kind, base_url, environment, config, secrets FROM platforms WHERE id = ?', id);
  if (r) db().run('UPDATE platforms SET config_mac = ? WHERE id = ?', configMac('platform', r.id, fields(r)), id);
}

const MIGRATED = 'security.platformSealsCreated';

/**
 * One-time sealing of platforms created before configuration integrity existed (first unlock after
 * the update). Afterwards a platform without a seal counts as changed outside the application.
 */
export function sealPlatformConfigs(): void {
  if (!vault().unlocked || readSetting(MIGRATED, false)) return;
  const rows = db().all<{ id: string; name: string }>('SELECT id, name FROM platforms WHERE config_mac IS NULL');
  db().tx(() => {
    for (const r of rows) sealPlatform(r.id);
    writeSetting(MIGRATED, true);
    if (rows.length) {
      audit({
        actor: 'system',
        action: 'platform.config_sealed',
        entityType: 'platform',
        summary: `Connection settings of ${rows.length} existing platform(s) sealed (configuration integrity introduced)`,
        details: { platforms: rows.map((r) => r.name) },
      });
    }
  });
}

/** Refuses to hand out credentials (or send requests) for a platform whose settings were changed outside the application. */
export function requireIntact(r: SealedPlatformRow): void {
  const s = platformIntegrity(r);
  if (s === 'ok' || s === 'locked') return;
  throw new HttpError(
    409,
    `The connection settings of "${r.name}" were changed outside ${BRAND.name} (directly in the database) – no requests are sent until an administrator reviews them and confirms (platform page)`,
    'PLATFORM_CONFIG_UNVERIFIED',
  );
}

/** An administrator has reviewed the current settings: seal them again. */
export function confirmPlatformConfig(id: string): void {
  const r = db().get<SealedPlatformRow>('SELECT id, name, kind, base_url, environment, config, secrets, config_mac FROM platforms WHERE id = ?', id);
  if (!r) throw new HttpError(404, `Platform ${id} not found`, 'PLATFORM_NOT_FOUND', { id });
  const before = platformIntegrity(r);
  db().tx(() => {
    sealPlatform(id);
    audit({
      action: 'platform.config_confirmed',
      entityType: 'platform',
      entityId: id,
      summary: `Connection settings of "${r.name}" confirmed by an administrator (were: ${before})`,
      details: { baseUrl: r.base_url, kind: r.kind, config: parseJson(r.config, null), previousState: before },
    });
  });
}
