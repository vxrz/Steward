import { BRAND } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { checkMac, configMac, type IntegrityState } from '../integrity.js';
import { readSetting, writeSetting } from '../settings.js';
import { vault } from '../vault.js';
import { logger } from '../log.js';
import { HttpError, canonicalJson, nowIso, parseJson, sha256 } from '../util.js';
import { DEFAULT_IDENTITY_NAME, configWithoutMcpMode, defaultIdentityId, hasLegacyGateway, mcpFromGateway, type IdentityRow } from './identities.js';

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

/**
 * Refuses a change to a platform whose settings or default identity were changed outside the application (they would be
 * sealed unseen otherwise). A missing platform passes: the caller answers 404.
 */
export function requirePlatformIntact(id: string): void {
  const r = db().get<SealedPlatformRow>('SELECT id, name, kind, base_url, environment, config, secrets, config_mac FROM platforms WHERE id = ?', id);
  if (!r) return;
  requireIntact(r);
  const i = db().get<SealedIdentityRow>(`SELECT ${IDENTITY_SEALED_COLUMNS}, config_mac FROM platform_identities WHERE platform_id = ? AND is_default = 1`, id);
  if (i) requireIdentityIntact(i, r.name);
}

/** An administrator has reviewed the current settings: seal them again – the platform and its identities. */
export function confirmPlatformConfig(id: string): void {
  const r = db().get<SealedPlatformRow>('SELECT id, name, kind, base_url, environment, config, secrets, config_mac FROM platforms WHERE id = ?', id);
  if (!r) throw new HttpError(404, `Platform ${id} not found`, 'PLATFORM_NOT_FOUND', { id });
  const before = platformIntegrity(r);
  const identitiesBefore = Object.fromEntries(
    db()
      .all<SealedIdentityRow>(`SELECT ${IDENTITY_SEALED_COLUMNS}, config_mac FROM platform_identities WHERE platform_id = ?`, id)
      .map((i) => [i.id, identityIntegrity(i)]),
  );
  db().tx(() => {
    // a platform that was not intact at the one-time step still has the old layout: the confirmed settings move now
    if (r.secrets !== null || hasLegacyGateway(r.config) || !Object.keys(identitiesBefore).length) moveToDefaultIdentity(id);
    else {
      for (const iid of Object.keys(identitiesBefore)) sealIdentity(iid);
      sealPlatform(id);
    }
    audit({
      action: 'platform.config_confirmed',
      entityType: 'platform',
      entityId: id,
      summary: `Connection settings of "${r.name}" confirmed by an administrator (were: ${before})`,
      details: { baseUrl: r.base_url, kind: r.kind, config: parseJson(r.config, null), previousState: before, identities: identitiesBefore },
    });
  });
}

// ---------- identities (0.9.0, #228, ADR 0009) ----------

/** The columns of an identity that are authenticated (everything that decides how it signs in and what it may do). */
export type SealedIdentityRow = Pick<
  IdentityRow,
  | 'id'
  | 'platform_id'
  | 'name'
  | 'is_default'
  | 'auth'
  | 'variables'
  | 'secrets'
  | 'read_only'
  | 'privileged'
  | 'operation_filter'
  | 'mcp'
  | 'credential_source'
> & { config_mac?: string | null };

const IDENTITY_SEALED_COLUMNS = 'id, platform_id, name, is_default, auth, variables, secrets, read_only, privileged, operation_filter, mcp, credential_source';

const identityFields = (r: SealedIdentityRow) => ({
  v: 1,
  // binds the row (with its credentials) to its platform: it cannot be moved to another one in the database
  platformId: r.platform_id,
  name: r.name,
  isDefault: Number(r.is_default) === 1 || r.is_default === true,
  auth: parseJson<unknown>(r.auth, null),
  variables: parseJson<unknown>(r.variables, {}),
  secrets: secretsDigest(r.secrets),
  readOnly: Number(r.read_only) === 1 || r.read_only === true,
  privileged: Number(r.privileged) === 1 || r.privileged === true,
  operationFilter: parseJson<unknown>(r.operation_filter, null),
  mcp: parseJson<unknown>(r.mcp, null),
  credentialSource: parseJson<unknown>(r.credential_source, null),
});

export function identityIntegrity(r: SealedIdentityRow): IntegrityState {
  return checkMac('platform_identity', r.id, identityFields(r), r.config_mac);
}

/** Recomputes an identity's seal after a change made through the application (inside the caller's transaction). */
export function sealIdentity(id: string): void {
  if (!vault().unlocked) return;
  const r = db().get<SealedIdentityRow>(`SELECT ${IDENTITY_SEALED_COLUMNS} FROM platform_identities WHERE id = ?`, id);
  if (r) db().run('UPDATE platform_identities SET config_mac = ? WHERE id = ?', configMac('platform_identity', r.id, identityFields(r)), id);
}

/** Refuses an identity whose settings or credentials were changed outside the application (as requireIntact for platforms). */
export function requireIdentityIntact(r: SealedIdentityRow, platformName: string): void {
  const s = identityIntegrity(r);
  if (s === 'ok' || s === 'locked') return;
  throw new HttpError(
    409,
    `The credentials of "${platformName}" were changed outside ${BRAND.name} (directly in the database) – no requests are sent until an administrator reviews them and confirms (platform page)`,
    'PLATFORM_CONFIG_UNVERIFIED',
  );
}

/**
 * Moves a platform's credentials and MCP mode to its default identity (created when it is missing), empties
 * platforms.secrets, drops enabled/writes from config.mcpGateway and seals both. Everything comes from the platform row,
 * whose seal the caller has checked (or an administrator confirmed): the copy the SQL migration made is overwritten, so a
 * row changed in the database in between is never sealed. Idempotent; runs in one transaction.
 */
export function moveToDefaultIdentity(platformId: string): void {
  db().tx(() => {
    const p = db().get<{ id: string; config: string; secrets: string | null; created_at: string; updated_at: string }>(
      'SELECT id, config, secrets, created_at, updated_at FROM platforms WHERE id = ?',
      platformId,
    );
    if (!p) return;
    const mcp = JSON.stringify(mcpFromGateway(parseJson<{ mcpGateway?: { enabled?: unknown; writes?: unknown } }>(p.config, {}).mcpGateway));
    const def = db().get<{ id: string; secrets: string | null }>(
      'SELECT id, secrets FROM platform_identities WHERE platform_id = ? AND is_default = 1',
      platformId,
    );
    const ts = nowIso();
    if (!def) {
      // a missing default identity (an unconverted row, or deleted in the database): created from the platform
      const id = defaultIdentityId(platformId);
      const name = db().get('SELECT 1 FROM platform_identities WHERE platform_id = ? AND lower(name) = lower(?)', platformId, DEFAULT_IDENTITY_NAME)
        ? `${DEFAULT_IDENTITY_NAME} (${id.slice(-6)})`
        : DEFAULT_IDENTITY_NAME;
      db().run('DELETE FROM platform_identities WHERE id = ?', id);
      db().run(
        `INSERT INTO platform_identities (id, platform_id, name, is_default, secrets, mcp, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, 1, ?, ?, ?, 'system', ?, 'system')`,
        id,
        platformId,
        name,
        p.secrets,
        mcp,
        p.created_at,
        ts,
      );
      sealIdentity(id);
    } else {
      // the platform's (sealed) credentials, never the copy in the identity row: that one is not sealed yet
      db().run(
        'UPDATE platform_identities SET auth = NULL, variables = ?, secrets = ?, mcp = ?, read_only = 0, privileged = 0, operation_filter = NULL, credential_source = NULL WHERE id = ?',
        '{}',
        p.secrets,
        mcp,
        def.id,
      );
      sealIdentity(def.id);
    }
    db().run('UPDATE platforms SET secrets = NULL, config = ? WHERE id = ?', configWithoutMcpMode(p.config), platformId);
    sealPlatform(platformId);
  });
}

const IDENTITIES_MIGRATED = 'security.platformIdentitiesMigrated';

/** The platform's default identity exists and its seal is intact. */
function isConverted(platformId: string): boolean {
  const i = db().get<SealedIdentityRow>(
    `SELECT ${IDENTITY_SEALED_COLUMNS}, config_mac FROM platform_identities WHERE platform_id = ? AND is_default = 1`,
    platformId,
  );
  return !!i && identityIntegrity(i) === 'ok';
}

/**
 * One-time step after the first unlock with identities (0.9.0, ADR 0009): every platform whose seal is intact gets its
 * credentials and MCP mode moved to its sealed default identity. A platform that is not intact keeps the old layout and
 * an unsealed identity – both are refused until an administrator confirms its settings (confirmPlatformConfig moves them
 * then). One transaction per platform: a crash leaves each platform either converted or not, and the next unlock carries
 * on (the setting is written last).
 */
export function createPlatformIdentities(): void {
  if (!vault().unlocked || readSetting(IDENTITIES_MIGRATED, false)) return;
  const rows = db().all<SealedPlatformRow>('SELECT id, name, kind, base_url, environment, config, secrets, config_mac FROM platforms ORDER BY id');
  const moved: string[] = [];
  const skipped: string[] = [];
  let failed = 0;
  for (const r of rows) {
    if (platformIntegrity(r) !== 'ok') {
      skipped.push(r.name);
      continue;
    }
    // converted before a crash (or created with identities): nothing left to move
    if (r.secrets === null && !hasLegacyGateway(r.config) && isConverted(r.id)) continue;
    try {
      moveToDefaultIdentity(r.id);
      moved.push(r.name);
    } catch (e) {
      // rolled back: the platform keeps the old layout (and is refused) – the next unlock tries again
      failed++;
      logger.error({ platformId: r.id, err: (e as Error).message }, 'moving the credentials of a platform to its default identity failed');
    }
  }
  // the setting is written only when every platform is done, so a failure is retried at the next unlock
  db().tx(() => {
    if (!failed) writeSetting(IDENTITIES_MIGRATED, true);
    if (moved.length || skipped.length || failed) {
      audit({
        actor: 'system',
        action: 'platform.identities_created',
        entityType: 'platform',
        summary:
          `Default identity of ${moved.length} platform(s) created and sealed (identities introduced)` +
          (skipped.length ? ` – ${skipped.length} platform(s) changed outside ${BRAND.name} wait for an administrator` : '') +
          (failed ? ` – ${failed} platform(s) failed and are tried again at the next unlock` : ''),
        details: { count: moved.length, platforms: moved, notIntact: skipped, failed },
      });
    }
  });
}
