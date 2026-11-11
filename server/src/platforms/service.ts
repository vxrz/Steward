import fs from 'node:fs';
import path from 'node:path';
import {
  BRAND,
  DATABASE_KIND,
  INFLUX_KIND,
  aiGatewaySettingsSchema,
  databaseSettingsSchema,
  influxVersionOf,
  influxVersionText,
  type ApiOperation,
  type McpGatewayConfig,
  type Platform,
  type PlatformConfig,
  type PlatformDoc,
  type PlatformIdentity,
  type PlatformSpec,
} from '@sm/shared';
import { db } from '../db.js';
import { vault } from '../vault.js';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { HttpError, newId, nowIso, parseJson, pathInside, sha256 } from '../util.js';
import { parseYaml, SPEC_YAML } from '../yaml-safe.js';
import { invalidateIdentityCaches, invalidatePlatformCaches, resolveBaseUrl } from './http.js';
import { derivePathPrefix, literalBasePath, pathPrefixProblem, withPrefix } from './pathPrefix.js';
import { deleteSource as deleteGatusSource } from '../gatus/metrics.js';
import { deleteWatchesOf } from '../changedetection/store.js';
import { identityIntegrity, platformIntegrity, requireIdentityIntact, requireIntact, requirePlatformIntact, sealIdentity, sealPlatform } from './integrity.js';
import {
  DEFAULT_IDENTITY_NAME,
  allIdentityRows,
  configWithoutMcpMode,
  defaultIdentityId,
  defaultIdentityRow,
  gatewayView,
  identityRow,
  identityRows,
  mcpFromGateway,
  mcpFromSetting,
  mergedAuthAndVariables,
  parseMcp,
  registerCounts,
  toIdentity,
  type IdentityRow,
} from './identities.js';
import { paramSchema, requestBodyInfo, resolveRef, successStatuses } from './openapi.js';
import { currentUser } from '../auth/context.js';
import { cleanAcl, platformPermissions } from '../auth/permissions.js';
import { PLATFORM_PERMISSIONS, type AclEntry, type PlatformPermission } from '@sm/shared';
import { assignCreatorTeams, forgetOwningTeams, identityAccess } from '../auth/policy.js';
import { staleRefs } from './operationFilter.js';

interface PlatformRow {
  id: string;
  name: string;
  kind: string;
  description: string;
  base_url: string;
  environment: string;
  config: string;
  secrets: string | null;
  created_at: string;
  updated_at: string;
  acl: string;
  config_mac: string | null;
}

function defaultConfig(): PlatformConfig {
  return { auth: { type: 'none' }, variables: {}, http: {} };
}

const decryptSecrets = (blob: string | null): Record<string, string> => (blob ? vault().decrypt<Record<string, string>>(blob) : {});

/** Names of stored credentials; none when the blob cannot be read (changed in the database: the seal says so). */
function secretNames(blob: string | null): string[] {
  try {
    return Object.keys(decryptSecrets(blob));
  } catch (e) {
    if (!vault().unlocked) throw e; // locked: answered as before (423)
    return []; // undecryptable: the identity's integrity is "mismatch" and it is refused
  }
}

/** The worst of several integrity states (a platform is intact only when it and its identities are). */
function worst(states: Platform['integrity'][]): Platform['integrity'] {
  for (const s of ['mismatch', 'unsealed', 'locked'] as const) if (states.includes(s)) return s;
  return 'ok';
}

function toPlatform(r: PlatformRow, idents: IdentityRow[]): Platform {
  const stored = { ...defaultConfig(), ...parseJson<Partial<PlatformConfig>>(r.config, {}) };
  const acl = parseJson<AclEntry<PlatformPermission>[]>(r.acl, []);
  const permissions = platformPermissions(currentUser(), { id: r.id, acl });
  const def = idents.find((i) => Number(i.is_default) === 1 || i.is_default === true);
  // the MCP mode lives on the default identity (0.9.0); the API shows it in config.mcpGateway as before
  const mcpGateway = gatewayView(stored.mcpGateway, def ? parseMcp(def.mcp) : mcpFromGateway(stored.mcpGateway));
  const { mcpGateway: _stored, ...rest } = stored;
  const cfg = { ...rest, ...(mcpGateway ? { mcpGateway } : {}) } as PlatformConfig;
  // operation filters with chosen operations: references that no longer resolve are stale (read once per platform)
  let ops: ApiOperation[] | undefined;
  const staleOf = (i: IdentityRow): number => {
    const f = parseJson<PlatformIdentity['operationFilter']>(i.operation_filter, null);
    if (!f?.operations?.length) return 0;
    ops ??= listOperations(r.id);
    return staleRefs(f, ops).length;
  };
  const user = currentUser();
  // entries of the credentials register that document each identity (0.14.0): their number only
  const register = registerCounts(r.id);
  const identities: PlatformIdentity[] = idents.map((i) =>
    toIdentity(i, {
      secretKeys: secretNames(i.secrets),
      integrity: identityIntegrity(i),
      // the default identity is open to everybody with "use" on the platform; any other is closed by default (ADR 0009)
      mayUse:
        permissions.includes('use') &&
        !(Number(i.disabled) === 1 || i.disabled === true) &&
        identityAccess(user, { id: r.id, acl }, { id: i.id, default: Number(i.is_default) === 1 || i.is_default === true, acl: parseJson(i.acl, []) })
          .permissions.length > 0,
      staleOperations: staleOf(i),
      registerEntries: register.get(i.id) ?? 0,
    }),
  );
  const own = platformIntegrity(r);
  return {
    acl,
    permissions,
    id: r.id,
    name: r.name,
    kind: r.kind,
    description: r.description,
    baseUrl: r.base_url,
    environment: r.environment,
    config: cfg,
    secretKeys: def ? (identities.find((i) => i.id === def.id)?.secretKeys ?? []) : secretNames(r.secrets),
    // changed outside the application: the platform row, one of its identities, or its default identity missing
    integrity: own === 'locked' ? own : worst([own, ...identities.map((i) => i.integrity), def ? 'ok' : 'unsealed']),
    identities,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listPlatforms(): Platform[] {
  const idents = allIdentityRows();
  return db()
    .all<PlatformRow>('SELECT * FROM platforms ORDER BY name')
    .map((r) => toPlatform(r, idents.get(r.id) ?? []));
}

/**
 * The latest connection test of every platform, from the audit log (POST /platforms/:id/test writes `platform.tested`).
 * Entries from before 0.3.1 have no `details.ok`: their summary tells. One statement with an indexed lookup per
 * platform (audit_target, newest first: platforms/health.ts lastTestOf does the same) – grouping all `platform.tested`
 * entries read every one ever written (security review 0.19.0 M3). The action is compared as an expression on purpose:
 * through the index audit_action the database would walk every test of every platform to find one platform's.
 */
export const LAST_TESTS_SQL = `SELECT a.entity_id, a.ts, a.summary, a.details FROM platforms p
  JOIN audit_log a ON a.seq = (
    SELECT t.seq FROM audit_log t
     WHERE t.entity_type = 'platform' AND COALESCE(t.entity_id, '') = p.id AND (t.action || '') = 'platform.tested'
     ORDER BY t.seq DESC LIMIT 1)`;
export function lastConnectionTests(): Map<string, { at: string; ok: boolean }> {
  const rows = db().all<{ entity_id: string; ts: string; summary: string; details: string | null }>(LAST_TESTS_SQL);
  const out = new Map<string, { at: string; ok: boolean }>();
  for (const r of rows) {
    const d = parseJson<{ ok?: unknown }>(r.details, {});
    const http = /→ HTTP (\d{3})/.exec(r.summary);
    const ok = typeof d.ok === 'boolean' ? d.ok : http ? Number(http[1]) < 400 : !/" failed: /.test(r.summary);
    out.set(r.entity_id, { at: r.ts, ok });
  }
  return out;
}

export function getPlatform(id: string): Platform {
  const r = db().get<PlatformRow>('SELECT * FROM platforms WHERE id = ?', id);
  if (!r) throw new HttpError(404, `Platform ${id} not found`, 'PLATFORM_NOT_FOUND', { id });
  return toPlatform(r, identityRows(id));
}

/** The platform's configuration as stored (config.mcpGateway: only the path prefixes) – for code that writes it back. */
export function storedConfig(id: string): PlatformConfig {
  const r = db().get<{ config: string }>('SELECT config FROM platforms WHERE id = ?', id);
  if (!r) throw new HttpError(404, `Platform ${id} not found`, 'PLATFORM_NOT_FOUND', { id });
  return { ...defaultConfig(), ...parseJson<Partial<PlatformConfig>>(r.config, {}) } as PlatformConfig;
}

/**
 * A platform object for requests with one of its identities: the identity's sign-in settings and variables merged in
 * (platformRequest, obtainAuthHeader, signerFor and resolveBaseUrl read them as before), and the identity's id, which keys
 * the token, AWS role and database pool caches (platforms/http.ts identityKey).
 */
export type ConnectedPlatform = Platform & { identityId: string; identityName: string };

export interface Connection {
  platform: ConnectedPlatform;
  identity: PlatformIdentity;
  secrets: Record<string, string>;
}

/**
 * The one resolver for using a platform (ADR 0009): the platform and one of its identities (default: the default
 * identity) with its credentials. Both seals are checked – refused (PLATFORM_CONFIG_UNVERIFIED) when the platform or
 * the identity was changed outside the application. The caller checks the rights.
 */
export function getConnection(platformId: string, identityId?: string): Connection {
  const r = db().get<PlatformRow>('SELECT * FROM platforms WHERE id = ?', platformId);
  if (!r) throw new HttpError(404, `Platform ${platformId} not found`, 'PLATFORM_NOT_FOUND', { id: platformId });
  requireIntact(r);
  const i = identityId ? identityRow(platformId, identityId) : defaultIdentityRow(platformId);
  if (!i) {
    if (identityId) throw new HttpError(404, `Identity ${identityId} of "${r.name}" not found`, 'IDENTITY_NOT_FOUND', { id: identityId });
    // every platform has a default identity: a missing one was deleted in the database
    throw new HttpError(
      409,
      `The credentials of "${r.name}" were changed outside ${BRAND.name} (directly in the database) – no requests are sent until an administrator reviews them and confirms (platform page)`,
      'PLATFORM_CONFIG_UNVERIFIED',
    );
  }
  requireIdentityIntact(i, r.name);
  // kept but not usable: added or changed outside Steward (0.13.0) – no credentials are handed out
  if (Number(i.disabled) === 1 || i.disabled === true)
    throw new HttpError(
      409,
      `The identity "${i.name}" of "${r.name}" is disabled: it was added or changed outside ${BRAND.name} – an administrator enables it on the platform's Identities tab`,
      'IDENTITY_DISABLED',
      { identity: i.name, platform: r.name },
    );
  const p = toPlatform(r, identityRows(platformId));
  const identity = p.identities!.find((x) => x.id === i.id)!;
  // the variables used where requests go (base URL, token URLs, trusted origins) stay the platform's (IDENTITY_VARIABLE_FIXED)
  const merged = mergedAuthAndVariables({ ...p.config, kind: p.kind, baseUrl: p.baseUrl }, i);
  return {
    platform: { ...p, config: { ...p.config, auth: merged.auth, variables: merged.variables }, identityId: i.id, identityName: i.name },
    identity,
    secrets: decryptSecrets(i.secrets),
  };
}

/**
 * Credentials of the platform's default identity – refused when the platform or the identity was changed outside the
 * application. Kept for the call sites that are not converted to getConnection yet (server/test/identities.test.ts
 * lists them).
 */
export function getSecrets(id: string): Record<string, string> {
  return getConnection(id).secrets;
}

/** Credentials of the default identity without the integrity check – only for scrubbing them from error reports and listing their names. */
export function getSecretsUnchecked(id: string): Record<string, string> {
  if (!db().get('SELECT 1 FROM platforms WHERE id = ?', id)) throw new HttpError(404, `Platform ${id} not found`, 'PLATFORM_NOT_FOUND', { id });
  return decryptSecrets(defaultIdentityRow(id)?.secrets ?? null);
}

/**
 * Every credential stored for a platform – of all its identities, and of the platform row while it still has the old
 * layout – for masking error reports (not only the identity in use). Never checked: never sent anywhere.
 */
export function allSecretsUnchecked(id: string): Record<string, string>[] {
  const legacy = db().get<{ secrets: string | null }>('SELECT secrets FROM platforms WHERE id = ?', id)?.secrets ?? null;
  const blobs = [
    legacy,
    ...db()
      .all<{ secrets: string | null }>('SELECT secrets FROM platform_identities WHERE platform_id = ?', id)
      .map((x) => x.secrets),
  ];
  return blobs.flatMap((b) => {
    try {
      return b ? [decryptSecrets(b)] : [];
    } catch {
      return []; // an unreadable blob (changed in the database) holds nothing to mask
    }
  });
}

export interface PlatformInput {
  name: string;
  kind?: string;
  description?: string;
  baseUrl?: string;
  environment?: string;
  config?: PlatformConfig;
  secrets?: Record<string, string>;
}

/** The MCP gateway is turned on per platform (setMcpGateway), never inherited from a copied configuration. */
function withoutGateway(cfg: PlatformConfig): PlatformConfig {
  const { mcpGateway: _gateway, ...rest } = cfg;
  return rest as PlatformConfig;
}

/** The AI settings change only through ai/gateway.ts (PUT /platforms/:id/ai). */
function withoutAi(cfg: PlatformConfig): PlatformConfig {
  const { ai: _ai, ...rest } = cfg;
  return rest as PlatformConfig;
}

/** AI settings given when a platform is created (the setup wizard, a copy) must be valid ones. */
function checkedAi(cfg: PlatformConfig): PlatformConfig {
  if (cfg.ai === undefined) return cfg;
  const r = aiGatewaySettingsSchema.safeParse(cfg.ai);
  if (!r.success) throw new HttpError(400, `AI settings: ${r.error.issues[0]?.message ?? 'invalid'}`, 'AI_SETTINGS_INVALID');
  return { ...cfg, ai: r.data };
}

/** The database connection (0.7.0) changes only through dbms/service.ts (PUT /platforms/:id/database). */
function withoutDatabase(cfg: PlatformConfig): PlatformConfig {
  const { database: _database, ...rest } = cfg;
  return rest as PlatformConfig;
}

/** Database settings given when a platform is created (the setup wizard, a copy) must be valid ones. */
function checkedDatabase(cfg: PlatformConfig): PlatformConfig {
  if (cfg.database === undefined) return cfg;
  const r = databaseSettingsSchema.safeParse(cfg.database);
  if (!r.success)
    throw new HttpError(
      400,
      `Database settings: ${r.error.issues[0]?.path.join('.') ?? ''} ${r.error.issues[0]?.message ?? 'invalid'}`.trim(),
      'DB_SETTINGS_INVALID',
      {
        field: r.error.issues[0]?.path.join('.') ?? '',
      },
    );
  return { ...cfg, database: r.data };
}

/**
 * An InfluxDB platform reads 1.x or 2.x (0.18.0, docs/PLATFORMS.md#influxdb): any other variable version – 3.x as well –
 * is refused when it is saved. A platform without one is told so when a check reads it.
 */
function assertInfluxVersion(kind: string | undefined, cfg: PlatformConfig | undefined): void {
  if (kind !== INFLUX_KIND) return;
  const version = influxVersionText(cfg?.variables).slice(0, 40);
  if (version && !influxVersionOf(cfg?.variables))
    throw new HttpError(
      400,
      `InfluxDB version "${version}" is not supported – set the variable version to 1 (InfluxDB 1.x) or 2 (InfluxDB 2.x)`,
      'PLATFORM_INFLUX_VERSION',
      { version },
    );
}

export function createPlatform(input: PlatformInput): Platform {
  if (!input.name?.trim()) throw new HttpError(400, 'Name is required', 'NAME_REQUIRED');
  assertInfluxVersion(input.kind, input.config);
  const id = newId('pf_');
  const ts = nowIso();
  const secrets = Object.fromEntries(Object.entries(input.secrets ?? {}).filter(([, v]) => v !== '' && v != null));
  const actor = currentUser()?.username ?? 'system';
  db().tx(() => {
    db().run(
      `INSERT INTO platforms (id, name, kind, description, base_url, environment, config, secrets, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      id,
      input.name.trim(),
      input.kind || 'generic',
      input.description ?? '',
      input.baseUrl ?? '',
      input.environment ?? '',
      JSON.stringify(checkedDatabase(checkedAi(withoutGateway(input.config ?? defaultConfig())))),
      ts,
      ts,
    );
    // its default identity holds the credentials (0.9.0, ADR 0009); MCP starts off, as the gateway always did
    const identityId = defaultIdentityId(id);
    db().run(
      `INSERT INTO platform_identities (id, platform_id, name, is_default, secrets, mcp, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      identityId,
      id,
      DEFAULT_IDENTITY_NAME,
      Object.keys(secrets).length ? vault().encrypt(secrets) : null,
      JSON.stringify({ mode: 'off' }),
      ts,
      actor,
      ts,
      actor,
    );
    sealIdentity(identityId);
    assignCreatorTeams('platform', id, currentUser());
    audit({
      action: 'platform.created',
      entityType: 'platform',
      entityId: id,
      summary: `Platform "${input.name}" created`,
      details: { kind: input.kind, baseUrl: input.baseUrl, auth: input.config?.auth?.type, secretKeys: Object.keys(secrets) },
    });
    sealPlatform(id);
  });
  return getPlatform(id);
}

const requireIntactRow = requirePlatformIntact;

/** The platform's default identity (every platform has one; a missing one was deleted in the database). */
function requireDefaultIdentity(id: string, name: string): IdentityRow {
  const i = defaultIdentityRow(id);
  if (!i)
    throw new HttpError(
      409,
      `The credentials of "${name}" were changed outside ${BRAND.name} (directly in the database) – no requests are sent until an administrator reviews them and confirms (platform page)`,
      'PLATFORM_CONFIG_UNVERIFIED',
    );
  return i;
}

export function updatePlatform(id: string, patch: Partial<PlatformInput>): Platform {
  // settings changed outside the application have to be confirmed first (they would be sealed unseen otherwise)
  requireIntactRow(id);
  const before = getPlatform(id);
  const stored = storedConfig(id);
  const next = {
    name: patch.name?.trim() || before.name,
    kind: patch.kind ?? before.kind,
    description: patch.description ?? before.description,
    baseUrl: patch.baseUrl ?? before.baseUrl,
    environment: patch.environment ?? before.environment,
    // the MCP gateway setting only changes through setMcpGateway, the AI settings of an LLM gateway only through
    // ai/gateway.ts setGatewaySettings, the connection of a database platform only through dbms/service.ts (own right
    // check and audit entry)
    config: patch.config
      ? {
          ...withoutDatabase(withoutAi(withoutGateway(patch.config))),
          // as stored: the path prefixes (the MCP mode is on the default identity)
          ...(stored.mcpGateway ? { mcpGateway: stored.mcpGateway } : {}),
          ...(stored.ai ? { ai: stored.ai } : {}),
          ...(stored.database ? { database: stored.database } : {}),
        }
      : stored,
  };
  assertInfluxVersion(next.kind, next.config);
  db().tx(() => {
    db().run(
      `UPDATE platforms SET name=?, kind=?, description=?, base_url=?, environment=?, config=?, updated_at=? WHERE id=?`,
      next.name,
      next.kind,
      next.description,
      next.baseUrl,
      next.environment,
      JSON.stringify(next.config),
      nowIso(),
      id,
    );
    audit({
      action: 'platform.updated',
      entityType: 'platform',
      entityId: id,
      summary: `Platform "${next.name}" updated`,
      details: { changed: diffKeys({ ...before, config: stored } as Platform, next) },
    });
    sealPlatform(id);
  });
  invalidatePlatformCaches(id);
  return getPlatform(id);
}

function diffKeys(before: Platform, next: Record<string, unknown>): string[] {
  const b = before as unknown as Record<string, unknown>;
  return Object.keys(next).filter((k) => JSON.stringify(b[k]) !== JSON.stringify(next[k]));
}

/** Merge secrets of the default identity: empty string / null removes a key. Values are never logged. */
export function setSecrets(id: string, patch: Record<string, string | null>): Platform {
  const p = getPlatform(id);
  const { secrets: current, identity } = getConnection(id);
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === '') {
      if (k in current) removed.push(k);
      delete current[k];
    } else if (current[k] !== v) {
      current[k] = v;
      changed.push(k);
    }
  }
  const ts = nowIso();
  db().tx(() => {
    db().run(
      'UPDATE platform_identities SET secrets = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      Object.keys(current).length ? vault().encrypt(current) : null,
      ts,
      currentUser()?.username ?? 'system',
      identity.id,
    );
    db().run('UPDATE platforms SET updated_at = ? WHERE id = ?', ts, id);
    audit({
      action: 'platform.secrets_changed',
      entityType: 'platform',
      entityId: id,
      summary: `Credentials of "${p.name}" changed (${[...changed, ...removed.map((r) => `-${r}`)].join(', ') || 'no change'})`,
      details: { set: changed, removed, identityId: identity.id },
    });
    sealIdentity(identity.id);
  });
  invalidateIdentityCaches(id, identity.id);
  return getPlatform(id);
}

/** Turns the MCP gateway of a platform on or off (the caller checks the "manage" right): the default identity's mode, the platform's path prefixes. */
export function setMcpGateway(id: string, input: McpGatewayConfig): Platform {
  requireIntactRow(id);
  const before = getPlatform(id);
  const identity = requireDefaultIdentity(id, before.name);
  const prefixes = [...new Set((input.allowedPathPrefixes ?? []).map((x) => x.trim()).filter(Boolean))];
  // changing calls (#11) keep their mode when a client sends none; "off" is not stored
  const writes = input.writes ?? before.config.mcpGateway?.writes ?? 'off';
  // database platforms (0.7.0, ADR 0008): read-only through MCP – changing statements are not offered at all
  if (before.kind === DATABASE_KIND && writes !== 'off')
    throw new HttpError(
      400,
      `"${before.name}" is a database platform: its MCP gateway is read-only (changing statements are not available)`,
      'MCP_WRITES_NOT_AVAILABLE',
      { name: before.name },
    );
  const gateway: McpGatewayConfig = {
    enabled: input.enabled,
    ...(prefixes.length ? { allowedPathPrefixes: prefixes } : {}),
    ...(writes !== 'off' ? { writes } : {}),
  };
  const writesText = { off: 'read-only', confirm: 'changing calls confirmed by the token owner', fourEyes: 'changing calls approved by a second person' }[
    writes
  ];
  const previous = before.config.mcpGateway ?? { enabled: false };
  const stored = storedConfig(id);
  const { mcpGateway: _gateway, ...rest } = stored;
  const ts = nowIso();
  db().tx(() => {
    // the path prefixes describe the API (platform); the mode belongs to the credential (default identity, ADR 0009)
    db().run(
      'UPDATE platforms SET config = ?, updated_at = ? WHERE id = ?',
      configWithoutMcpMode(JSON.stringify({ ...rest, mcpGateway: { allowedPathPrefixes: prefixes } })),
      ts,
      id,
    );
    db().run(
      'UPDATE platform_identities SET mcp = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      JSON.stringify(mcpFromSetting(input.enabled, writes)),
      ts,
      currentUser()?.username ?? 'system',
      identity.id,
    );
    audit({
      action: 'platform.mcp_gateway_changed',
      entityType: 'platform',
      entityId: id,
      summary: `MCP gateway of "${before.name}" ${gateway.enabled ? `turned on (${writesText})` : 'turned off'}${prefixes.length ? ` – path prefixes: ${prefixes.join(', ')}` : ''}`,
      details: { enabled: gateway.enabled, allowedPathPrefixes: prefixes, writes, previous, identityId: identity.id },
    });
    sealIdentity(identity.id);
    sealPlatform(id);
  });
  invalidatePlatformCaches(id);
  return getPlatform(id);
}

export function setPlatformAccess(id: string, aclInput: unknown): Platform {
  const before = getPlatform(id);
  const acl = cleanAcl(aclInput, PLATFORM_PERMISSIONS);
  db().tx(() => {
    db().run('UPDATE platforms SET acl = ?, updated_at = ? WHERE id = ?', JSON.stringify(acl), nowIso(), id);
    audit({
      action: 'platform.access_changed',
      entityType: 'platform',
      entityId: id,
      summary: `Access of "${before.name}" changed: ${acl.length ? acl.map((e) => `${e.subject} (${e.permissions.join('/')})`).join(', ') : 'default role rights'}`,
      details: { acl, previous: before.acl },
    });
  });
  return getPlatform(id);
}

export function deletePlatform(id: string): void {
  const p = getPlatform(id);
  // scheduled exports (0.16.0) remove their older files from this bucket by the keys they recorded: never forget them
  const exportJob = db().get<{ name: string }>('SELECT name FROM export_jobs WHERE platform_id = ? ORDER BY name LIMIT 1', id);
  if (exportJob)
    throw new HttpError(
      409,
      `The export "${exportJob.name}" writes to this platform – choose another target for it, or remove it, first`,
      'PLATFORM_EXPORT_TARGET',
      {
        name: exportJob.name,
      },
    );
  const left = db().get<{ name: string }>(
    `SELECT j.name FROM export_runs r JOIN export_jobs j ON j.id = r.job_id WHERE r.platform_id = ? AND r.pruned = 0 AND r.files <> '[]' ORDER BY j.name LIMIT 1`,
    id,
  );
  if (left)
    throw new HttpError(
      409,
      `Runs of the export "${left.name}" have files in this bucket that its retention rule has not removed yet – wait for its next runs, or remove the export (its files then stay in the bucket), first`,
      'PLATFORM_EXPORT_FILES',
      { name: left.name },
    );
  const docs = db().all<{ filename: string | null; id: string }>('SELECT id, filename FROM platform_docs WHERE platform_id = ?', id);
  db().tx(() => {
    // its identities go with it (ON DELETE CASCADE as well)
    db().run('DELETE FROM platform_identities WHERE platform_id = ?', id);
    db().run('DELETE FROM platforms WHERE id = ?', id);
    // its owning teams go with it: a later resource with the same id (dashboard slugs) does not inherit them
    forgetOwningTeams('platform', id);
    // Gatus metrics mode: the source with its samples, aggregates, transitions and endpoints
    deleteGatusSource(id);
    // changedetection.io: its watches and their links (#242)
    deleteWatchesOf(id);
    audit({ action: 'platform.deleted', entityType: 'platform', entityId: id, summary: `Platform "${p.name}" deleted` });
  });
  for (const d of docs) if (d.filename) fs.rmSync(docPath(d.id, d.filename), { force: true });
  invalidatePlatformCaches(id);
}

// ---------- OpenAPI specs ----------

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'];

export function parseSpec(content: string): {
  format: string;
  title?: string;
  version?: string;
  serverUrl?: string;
  /** OpenAPI 3 server variables of the first server (their defaults fill the server URL). */
  serverVariables?: Record<string, { default?: unknown }>;
  operations: Omit<ApiOperation, 'specId'>[];
} {
  let doc: Record<string, unknown>;
  try {
    doc = (content.trim().startsWith('{') ? JSON.parse(content) : parseYaml(content, SPEC_YAML)) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, `Could not parse specification: ${(e as Error).message}`);
  }
  if (!doc || typeof doc !== 'object') throw new HttpError(400, 'Specification is empty');
  const isOas3 = typeof doc.openapi === 'string';
  const isSwagger = doc.swagger === '2.0';
  if (!isOas3 && !isSwagger) throw new HttpError(400, 'Not an OpenAPI 3.x or Swagger 2.0 document');
  const info = (doc.info ?? {}) as { title?: string; version?: string };
  let serverUrl: string | undefined;
  let serverVariables: Record<string, { default?: unknown }> | undefined;
  if (isOas3) {
    const server = ((doc.servers as { url?: unknown; variables?: unknown }[] | undefined) ?? [])[0];
    serverUrl = typeof server?.url === 'string' ? server.url : undefined;
    if (server?.variables && typeof server.variables === 'object') serverVariables = server.variables as Record<string, { default?: unknown }>;
  } else if (doc.host) serverUrl = `${((doc.schemes as string[]) ?? ['https'])[0]}://${doc.host}${doc.basePath ?? ''}`;
  else if (doc.basePath) serverUrl = String(doc.basePath);

  const operations: Omit<ApiOperation, 'specId'>[] = [];
  const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>;
  for (const [p, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue;
    const shared = (item.parameters as Record<string, unknown>[] | undefined) ?? [];
    for (const m of METHODS) {
      const op = item[m] as Record<string, unknown> | undefined;
      if (!op) continue;
      const params = [...shared, ...((op.parameters as Record<string, unknown>[]) ?? [])]
        .map((x) => resolveRef(doc, x))
        .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && 'name' in x);
      const body = requestBodyInfo(doc, op, params);
      operations.push({
        operationId: op.operationId as string | undefined,
        method: m.toUpperCase(),
        path: p,
        summary: (op.summary as string) ?? (op.description as string | undefined)?.slice(0, 160),
        description: op.description ? String(op.description).slice(0, 2000) : undefined,
        tag: ((op.tags as string[]) ?? [])[0],
        parameters: params
          .filter((x) => x.in !== 'body' && x.in !== 'formData')
          .map((x) => ({
            name: String(x.name),
            in: String(x.in),
            required: Boolean(x.required),
            description: x.description ? String(x.description).slice(0, 300) : undefined,
            schema: paramSchema(doc, x),
          })),
        hasBody: Boolean(op.requestBody) || params.some((x) => x.in === 'body'),
        requestContentType: body.contentType,
        requestBodyExample: body.example,
        successStatus: successStatuses(op),
      });
    }
  }
  return { format: isOas3 ? `openapi ${doc.openapi}` : 'swagger 2.0', title: info.title, version: info.version, serverUrl, serverVariables, operations };
}

interface SpecRow {
  id: string;
  platform_id: string;
  name: string;
  format: string;
  title: string | null;
  version: string | null;
  server_url: string | null;
  /** null: imported before path prefixes existed – derived from server_url when read */
  path_prefix: string | null;
  operations: string;
  created_at: string;
}

/** The path of the platform's base URL as written, when it has no template (sync, cheap). */
function literalPlatformBasePath(platformId: string): string | undefined {
  const r = db().get<{ base_url: string }>('SELECT base_url FROM platforms WHERE id = ?', platformId);
  return r ? literalBasePath(r.base_url) : undefined;
}

/**
 * The path of the platform's base URL, with templates ({{ vars.x }}) rendered (undefined: not resolvable).
 * Rendered without credentials: only the path is used, to decide the default path prefix of a new spec.
 */
export async function platformBasePath(platformId: string): Promise<string | undefined> {
  const p = getPlatform(platformId);
  const literal = literalBasePath(p.baseUrl);
  if (literal !== undefined || !p.baseUrl.includes('{{')) return literal;
  try {
    return new URL(await resolveBaseUrl(p, {})).pathname.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

/** Prefixes of specs imported before path prefixes existed, derived once per process (server URL and operations never change). */
const legacyPrefixes = new Map<string, string>();

function serverVariablesOf(specId: string): Record<string, { default?: unknown }> | undefined {
  try {
    return parseSpec(getSpecContent(specId)).serverVariables;
  } catch {
    return undefined;
  }
}

/**
 * The prefix in front of a spec's operation paths. Stored values are re-checked (a value changed outside the
 * application never reaches a request). Legacy rows: derived from server_url (server variables from the stored
 * content), and empty when the platform base URL path – as written – already ends with it.
 */
function specPrefix(r: Pick<SpecRow, 'id' | 'server_url' | 'path_prefix'>, ops: { path: string }[], basePath: string | undefined): string {
  if (r.path_prefix !== null) return pathPrefixProblem(r.path_prefix) ? '' : r.path_prefix;
  let derived = legacyPrefixes.get(r.id);
  if (derived === undefined) {
    const variables = r.server_url && /\{[^{}]+\}/.test(r.server_url) ? serverVariablesOf(r.id) : undefined;
    derived = derivePathPrefix(r.server_url, { variables, opPaths: ops.map((o) => o.path) }).prefix;
    if (legacyPrefixes.size >= 1000) legacyPrefixes.clear();
    legacyPrefixes.set(r.id, derived);
  }
  return derived && basePath?.endsWith(derived) ? '' : derived;
}

const toSpec = (r: SpecRow, basePath: string | undefined): PlatformSpec => {
  const ops = parseJson<{ path: string }[]>(r.operations, []);
  return {
    id: r.id,
    platformId: r.platform_id,
    name: r.name,
    format: r.format,
    title: r.title ?? undefined,
    version: r.version ?? undefined,
    serverUrl: r.server_url ?? undefined,
    pathPrefix: specPrefix(r, ops, basePath),
    operationCount: ops.length,
    createdAt: r.created_at,
  };
};

const getSpecRow = (platformId: string, specId: string): SpecRow => {
  const r = db().get<SpecRow>('SELECT * FROM platform_specs WHERE id = ? AND platform_id = ?', specId, platformId);
  if (!r) throw new HttpError(404, 'Spec not found', 'SPEC_NOT_FOUND');
  return r;
};

function checkedPrefix(prefix: string): string {
  const problem = pathPrefixProblem(prefix);
  if (problem) throw new HttpError(400, `Invalid path prefix: ${problem}`, 'SPEC_PATH_PREFIX_INVALID');
  return prefix;
}

/**
 * Import a specification. The path prefix defaults to the path of its server URL (see derivePathPrefix);
 * `basePath` is the platform's resolved base URL path (default: the base URL as written, when it has no template).
 */
export function addSpec(
  platformId: string,
  name: string,
  content: string,
  opts: { pathPrefix?: string; basePath?: string; copiedFrom?: { platformId: string; platformName: string; specId: string } } = {},
): PlatformSpec {
  const p = getPlatform(platformId);
  const parsed = parseSpec(content);
  const basePath = opts.basePath ?? literalPlatformBasePath(platformId);
  const pathPrefix =
    opts.pathPrefix !== undefined
      ? checkedPrefix(opts.pathPrefix)
      : derivePathPrefix(parsed.serverUrl, { variables: parsed.serverVariables, basePath, opPaths: parsed.operations.map((o) => o.path) }).prefix;
  const id = newId('sp_');
  db().tx(() => {
    db().run(
      `INSERT INTO platform_specs (id, platform_id, name, format, title, version, server_url, path_prefix, content, operations, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      platformId,
      name || parsed.title || 'API specification',
      parsed.format,
      parsed.title ?? null,
      parsed.version ?? null,
      parsed.serverUrl ?? null,
      pathPrefix,
      content,
      JSON.stringify(parsed.operations),
      nowIso(),
    );
    audit({
      action: 'platform.spec_added',
      entityType: 'platform',
      entityId: platformId,
      summary: `API spec "${name || parsed.title}" added to "${p.name}" (${parsed.operations.length} operations)${opts.copiedFrom ? ` – copied from "${opts.copiedFrom.platformName}"` : ''}`,
      details: {
        specId: id,
        sha256: sha256(content),
        format: parsed.format,
        version: parsed.version,
        serverUrl: parsed.serverUrl,
        pathPrefix,
        ...(opts.copiedFrom ? { copiedFrom: { platformId: opts.copiedFrom.platformId, specId: opts.copiedFrom.specId } } : {}),
        ...withIdentities(platformId, [id]),
      },
    });
  });
  return toSpec(db().get<SpecRow>('SELECT * FROM platform_specs WHERE id = ?', id)!, basePath);
}

/** Change the path prefix of a spec (empty: operation paths are relative to the base URL as they are). */
export function setSpecPathPrefix(platformId: string, specId: string, pathPrefix: string): PlatformSpec {
  const r = getSpecRow(platformId, specId);
  const next = checkedPrefix(pathPrefix);
  const basePath = literalPlatformBasePath(platformId);
  const before = specPrefix(r, parseJson<{ path: string }[]>(r.operations, []), basePath);
  db().tx(() => {
    db().run('UPDATE platform_specs SET path_prefix = ? WHERE id = ?', next, specId);
    audit({
      action: 'platform.spec_updated',
      entityType: 'platform',
      entityId: platformId,
      summary: `API spec "${r.name}": path prefix ${before ? `"${before}"` : '(none)'} → ${next ? `"${next}"` : '(none)'}`,
      details: { specId, before: { pathPrefix: before }, after: { pathPrefix: next }, ...withIdentities(platformId, [specId]) },
    });
  });
  return toSpec(getSpecRow(platformId, specId), basePath);
}

/**
 * The identities whose operation filter a change of these specs affects (0.13.0, ADR 0009): filters with the read preset
 * follow every spec, chosen references their spec. Listed in the spec's audit entry (references that no longer resolve
 * are stale: they match nothing).
 */
function filterIdentities(platformId: string, specIds: string[]): { id: string; name: string }[] {
  const ids = new Set(specIds);
  return identityRows(platformId)
    .filter((r) => {
      const f = parseJson<{ preset?: string; operations?: { specId?: string }[] } | null>(r.operation_filter, null);
      return !!f && (f.preset === 'read' || (f.operations ?? []).some((o) => ids.has(o.specId ?? '')));
    })
    .map((r) => ({ id: r.id, name: r.name }));
}
const withIdentities = (platformId: string, specIds: string[]) => {
  const identities = filterIdentities(platformId, specIds);
  return identities.length ? { identities } : {};
};

/** Most platforms a specification can be copied to in one request. */
export const SPEC_COPY_MAX_TARGETS = 50;

export interface SpecCopyResult {
  copied: { platformId: string; specId: string; replaced: boolean }[];
  skipped: { platformId: string; reason: 'exists' | 'source' }[];
}

/** A spec on the target counts as the same when title and version match (or, without a title, the name). */
const sameSpec = (a: Pick<SpecRow, 'title' | 'version' | 'name'>, b: Pick<SpecRow, 'title' | 'version' | 'name'>) =>
  (a.title ?? '') === (b.title ?? '') && (a.version ?? '') === (b.version ?? '') && (a.title ? true : a.name === b.name);

/**
 * Copies a specification to other platforms of the same kind as independent specs: platforms of one kind can
 * run different API versions, so nothing stays linked. The caller checks `manage` on the source and every target.
 * A target that already has the same spec (title and version) is skipped, unless `replace` – then that spec's
 * content is replaced and its id kept, so operation references keep working.
 */
export function copySpec(platformId: string, specId: string, targetIds: string[], opts: { replace?: boolean } = {}): SpecCopyResult {
  const source = getPlatform(platformId);
  const r = getSpecRow(platformId, specId);
  const content = getSpecContent(specId);
  const sourcePrefix = r.path_prefix;
  const targets = [...new Set(targetIds)];
  if (!targets.length) throw new HttpError(400, 'Choose at least one platform to copy to', 'SPEC_COPY_NO_TARGET');
  if (targets.length > SPEC_COPY_MAX_TARGETS)
    throw new HttpError(400, `At most ${SPEC_COPY_MAX_TARGETS} platforms at a time`, 'SPEC_COPY_TOO_MANY', { max: SPEC_COPY_MAX_TARGETS });
  const wrongKind = targets.map((t) => getPlatform(t)).find((t) => t.id !== platformId && t.kind !== source.kind);
  if (wrongKind)
    throw new HttpError(
      400,
      `"${wrongKind.name}" is not a ${source.kind} platform – specifications are copied to platforms of the same kind`,
      'SPEC_COPY_KIND',
      {
        kind: source.kind,
      },
    );
  const result: SpecCopyResult = { copied: [], skipped: [] };
  const copiedFrom = { platformId, platformName: source.name, specId };
  for (const t of targets) {
    if (t === platformId) {
      result.skipped.push({ platformId: t, reason: 'source' });
      continue;
    }
    // a prefix the target's base URL already ends with would be added twice
    const targetBase = literalPlatformBasePath(t);
    const pathPrefix = sourcePrefix === null ? undefined : sourcePrefix && targetBase?.endsWith(sourcePrefix) ? '' : sourcePrefix;
    const existing = db()
      .all<SpecRow>('SELECT * FROM platform_specs WHERE platform_id = ? ORDER BY created_at', t)
      .find((x) => sameSpec(x, r));
    if (existing && !opts.replace) {
      result.skipped.push({ platformId: t, reason: 'exists' });
      continue;
    }
    if (existing) {
      replaceSpecContent(t, existing, content, pathPrefix, copiedFrom);
      result.copied.push({ platformId: t, specId: existing.id, replaced: true });
    } else {
      const spec = addSpec(t, r.name, content, { pathPrefix, copiedFrom });
      result.copied.push({ platformId: t, specId: spec.id, replaced: false });
    }
  }
  return result;
}

function replaceSpecContent(
  platformId: string,
  existing: SpecRow,
  content: string,
  pathPrefix: string | undefined,
  copiedFrom: { platformId: string; platformName: string; specId: string },
): void {
  const parsed = parseSpec(content);
  const prefix =
    pathPrefix !== undefined
      ? checkedPrefix(pathPrefix)
      : derivePathPrefix(parsed.serverUrl, {
          variables: parsed.serverVariables,
          basePath: literalPlatformBasePath(platformId),
          opPaths: parsed.operations.map((o) => o.path),
        }).prefix;
  db().tx(() => {
    db().run(
      'UPDATE platform_specs SET format = ?, title = ?, version = ?, server_url = ?, path_prefix = ?, content = ?, operations = ? WHERE id = ?',
      parsed.format,
      parsed.title ?? null,
      parsed.version ?? null,
      parsed.serverUrl ?? null,
      prefix,
      content,
      JSON.stringify(parsed.operations),
      existing.id,
    );
    audit({
      action: 'platform.spec_updated',
      entityType: 'platform',
      entityId: platformId,
      summary: `API spec "${existing.name}" replaced with the copy from "${copiedFrom.platformName}" (${parsed.operations.length} operations)`,
      details: {
        specId: existing.id,
        sha256: sha256(content),
        format: parsed.format,
        version: parsed.version,
        pathPrefix: prefix,
        copiedFrom: { platformId: copiedFrom.platformId, specId: copiedFrom.specId },
        ...withIdentities(platformId, [existing.id]),
      },
    });
  });
  legacyPrefixes.delete(existing.id);
}

export function listSpecs(platformId: string): PlatformSpec[] {
  const basePath = literalPlatformBasePath(platformId);
  return db()
    .all<SpecRow>('SELECT * FROM platform_specs WHERE platform_id = ? ORDER BY created_at', platformId)
    .map((r) => toSpec(r, basePath));
}

/** The platform a specification belongs to (undefined: no such specification). */
export function specPlatformId(specId: string): string | undefined {
  return db().get<{ platform_id: string }>('SELECT platform_id FROM platform_specs WHERE id = ?', specId)?.platform_id;
}

export function getSpecContent(specId: string): string {
  const r = db().get<{ content: string }>('SELECT content FROM platform_specs WHERE id = ?', specId);
  if (!r) throw new HttpError(404, 'Spec not found');
  return r.content;
}

export function deleteSpec(platformId: string, specId: string): void {
  const r = getSpecRow(platformId, specId);
  db().tx(() => {
    db().run('DELETE FROM platform_specs WHERE id = ?', specId);
    const affected = filterIdentities(platformId, [specId]);
    audit({
      action: 'platform.spec_deleted',
      entityType: 'platform',
      entityId: platformId,
      summary: `API spec "${r.name}" removed${affected.length ? ` – operation filters affected: ${affected.map((i) => i.name).join(', ')}` : ''}`,
      ...(affected.length ? { details: { specId, identities: affected } } : {}),
    });
  });
  legacyPrefixes.delete(specId);
}

/**
 * The operations of all specs of a platform (oldest spec first). `path` is the effective path – the spec's
 * path prefix followed by the path of the specification, which is kept in `specPath` when they differ.
 */
export function listOperations(platformId: string): ApiOperation[] {
  const basePath = literalPlatformBasePath(platformId);
  const rows = db().all<Pick<SpecRow, 'id' | 'server_url' | 'path_prefix' | 'operations'>>(
    'SELECT id, server_url, path_prefix, operations FROM platform_specs WHERE platform_id = ? ORDER BY created_at',
    platformId,
  );
  return rows.flatMap((r) => {
    const ops = parseJson<Omit<ApiOperation, 'specId'>[]>(r.operations, []);
    const prefix = specPrefix(r, ops, basePath);
    return ops.map((o) => (prefix ? { ...o, path: withPrefix(prefix, o.path), specPath: o.path, specId: r.id } : { ...o, specId: r.id }));
  });
}

// ---------- Documentation ----------

interface DocRow {
  id: string;
  platform_id: string;
  title: string;
  kind: 'note' | 'link' | 'file';
  content: string | null;
  url: string | null;
  filename: string | null;
  mime: string | null;
  size: number | null;
  created_at: string;
}

const toDoc = (r: DocRow): PlatformDoc => ({
  id: r.id,
  platformId: r.platform_id,
  title: r.title,
  kind: r.kind,
  content: r.content ?? undefined,
  url: r.url ?? undefined,
  filename: r.filename ?? undefined,
  mime: r.mime ?? undefined,
  size: r.size ?? undefined,
  createdAt: r.created_at,
});

export function docPath(id: string, filename: string): string {
  return pathInside(path.join(config.dataDir, 'docs'), `${id}-${filename.replace(/[^A-Za-z0-9._-]/g, '_')}`);
}

export function listDocs(platformId: string): PlatformDoc[] {
  return db().all<DocRow>('SELECT * FROM platform_docs WHERE platform_id = ? ORDER BY created_at', platformId).map(toDoc);
}

export function getDoc(id: string): PlatformDoc {
  const r = db().get<DocRow>('SELECT * FROM platform_docs WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'Document not found');
  return toDoc(r);
}

export function addDoc(
  platformId: string,
  input: { title: string; kind: 'note' | 'link' | 'file'; content?: string; url?: string; filename?: string; mime?: string; data?: Buffer },
): PlatformDoc {
  const p = getPlatform(platformId);
  const id = newId('doc_');
  if (input.kind === 'file') {
    if (!input.data || !input.filename) throw new HttpError(400, 'File missing');
    fs.writeFileSync(docPath(id, input.filename), input.data);
  }
  db().tx(() => {
    db().run(
      `INSERT INTO platform_docs (id, platform_id, title, kind, content, url, filename, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      platformId,
      input.title || input.filename || input.url || 'Note',
      input.kind,
      input.content ?? null,
      input.url ?? null,
      input.filename ?? null,
      input.mime ?? null,
      input.data?.length ?? null,
      nowIso(),
    );
    audit({
      action: 'platform.doc_added',
      entityType: 'platform',
      entityId: platformId,
      summary: `Documentation "${input.title || input.filename}" added to "${p.name}"`,
      details: { kind: input.kind, sha256: input.data ? sha256(input.data) : undefined },
    });
  });
  return getDoc(id);
}

export function deleteDoc(platformId: string, id: string): void {
  const d = getDoc(id);
  if (d.platformId !== platformId) throw new HttpError(404, 'Document not found');
  db().tx(() => {
    db().run('DELETE FROM platform_docs WHERE id = ?', id);
    audit({ action: 'platform.doc_deleted', entityType: 'platform', entityId: platformId, summary: `Documentation "${d.title}" removed` });
  });
  if (d.filename) fs.rmSync(docPath(d.id, d.filename), { force: true });
}
