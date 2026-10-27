import crypto from 'node:crypto';
import { z } from 'zod';
import {
  GIT_PROVIDERS,
  STEWARD_EXAMPLES_SOURCE_ID,
  SYNC_KINDS,
  SYNC_LIMITS,
  SYNC_REF_TYPES,
  SYNC_VERSION_PLACEHOLDER,
  type SyncRefType,
  type SyncSource,
  type SyncSourceSecret,
  type SyncSourceSettings,
} from '@sm/shared';
import { config } from '../config.js';
import { db } from '../db.js';
import { logger } from '../log.js';
import { audit } from '../audit.js';
import { vault } from '../vault.js';
import { currentUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { HttpError, newId, nowIso, parseJson, sha256 } from '../util.js';
import { resolveRepo } from './providers.js';

/**
 * Git sync sources – management (administrators, signed-in sessions only).
 *
 * The access token is stored encrypted with the vault key and never returned. The webhook
 * secret is generated here, shown once (creation / rotation) and stored encrypted (to verify
 * HMAC signatures of Forgejo/GitHub) and hashed (GitLab sends it as a plain token).
 */

export interface SourceRow {
  id: string;
  name: string;
  provider: SyncSourceSettings['provider'];
  repo_url: string;
  api_url: string;
  ref_type: SyncRefType;
  branch: string;
  last_ref: string | null;
  folder: string;
  kinds: string;
  token_enc: string | null;
  interval_minutes: number;
  webhook_enabled: number;
  webhook_secret_enc: string | null;
  webhook_secret_hash: string | null;
  webhook_secret_prefix: string | null;
  require_signed: number;
  allowed_signers: string;
  auto_accept_new: number;
  enabled: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  last_fetch_at: string | null;
  last_commit: string | null;
  last_status: 'ok' | 'error' | null;
  last_error: string | null;
  last_verified: number | null;
}

export const SOURCE_ID_RE = /^gsr_[A-Za-z0-9_-]{8,40}$/;
/** The settings row that records that Steward's example source was offered once (a deleted one is not brought back). */
export const EXAMPLES_SOURCE_SEEDED_KEY = 'system.gitSyncExamplesSeeded';
export const WEBHOOK_SECRET_PREFIX = 'gsw_';
export const syncHookPath = (id: string) => `/api/hooks/sync/${id}`;

const FOLDER = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const BRANCH = /^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}(?<![/.])$/;
const VERSION_TOKEN = /\{version\}/g;

/** The branch or tag name with {version} replaced by this installation's Steward version. */
export function resolveRefName(name: string, version = config.version): string {
  return name.replace(VERSION_TOKEN, version);
}

/** A branch or tag name: Git's rules for the characters Steward allows, {version} as the only placeholder. */
const refName = z
  .string()
  .trim()
  .refine((b) => BRANCH.test(b.replace(VERSION_TOKEN, '0.0.0')), `Invalid branch or tag name (letters, digits, . _ - / and ${SYNC_VERSION_PLACEHOLDER})`);

export const sourceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  provider: z.enum(GIT_PROVIDERS),
  repoUrl: z.string().trim().min(1).max(500),
  apiUrl: z.string().trim().max(500).optional().default(''),
  refType: z.enum(SYNC_REF_TYPES).default('branch'),
  branch: refName.default('main'),
  folder: z
    .string()
    .trim()
    .max(200)
    .transform((f) => f.replace(/^\/+|\/+$/g, ''))
    .refine((f) => f === '' || (FOLDER.test(f) && !f.split('/').some((s) => s === '.' || s === '..')), 'Invalid folder (letters, digits, . _ - and /)')
    .default(''),
  kinds: z.array(z.enum(SYNC_KINDS)).min(1).max(SYNC_KINDS.length),
  intervalMinutes: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 60)
    .refine((n) => n === 0 || n >= 5, 'At least every 5 minutes (or 0 for no schedule)')
    .default(0),
  webhookEnabled: z.boolean().default(false),
  requireSignedCommits: z.boolean().default(false),
  /** Git host logins or e-mail addresses (compared case-insensitively) */
  allowedSigners: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .min(1)
        .max(200)
        .regex(/^[^\s,;<>"']+$/, 'A login or an e-mail address, without spaces'),
    )
    .max(SYNC_LIMITS.maxAllowedSigners)
    .default([])
    .transform((a) => [...new Set(a)]),
  autoAcceptNew: z.boolean().default(false),
  enabled: z.boolean().default(true),
  /** Write-only. Omitted = keep, '' = remove. */
  token: z.string().max(1000).optional(),
});
export type SourceInput = z.infer<typeof sourceSchema>;

const SELECT = `SELECT s.*, (SELECT COUNT(*) FROM sync_updates u WHERE u.source_id = s.id AND u.status = 'pending') AS pending_count FROM sync_sources s`;

export function requireAdmin(): void {
  if (!isAdmin(currentUser())) throw new HttpError(403, 'Only administrators can manage Git sync sources', 'FORBIDDEN', { context: 'manageGitSync' });
}

export function toSource(r: SourceRow & { pending_count?: number }): SyncSource {
  return {
    id: r.id,
    name: r.name,
    provider: r.provider,
    repoUrl: r.repo_url,
    apiUrl: r.api_url,
    refType: r.ref_type ?? 'branch',
    branch: r.branch,
    resolvedRef: resolveRefName(r.branch),
    lastRef: r.last_ref ?? null,
    builtIn: r.id === STEWARD_EXAMPLES_SOURCE_ID,
    folder: r.folder,
    kinds: parseJson(r.kinds, []),
    intervalMinutes: r.interval_minutes,
    webhookEnabled: !!r.webhook_enabled,
    requireSignedCommits: !!r.require_signed,
    allowedSigners: parseJson<string[]>(r.allowed_signers, []),
    autoAcceptNew: !!r.auto_accept_new,
    enabled: !!r.enabled,
    hasToken: !!r.token_enc,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    webhookPath: syncHookPath(r.id),
    webhookSecretPrefix: r.webhook_secret_prefix,
    lastFetchAt: r.last_fetch_at,
    lastCommit: r.last_commit,
    lastStatus: r.last_status,
    lastError: r.last_error,
    lastVerified: r.last_verified === null ? null : !!r.last_verified,
    pendingCount: Number(r.pending_count ?? 0),
  };
}

export function sourceRow(id: string): SourceRow | undefined {
  if (!SOURCE_ID_RE.test(id)) return undefined;
  return db().get<SourceRow>('SELECT * FROM sync_sources WHERE id = ?', id);
}

export function requireSource(id: string): SourceRow {
  const r = sourceRow(id);
  if (!r) throw new HttpError(404, 'Git sync source not found', 'SYNC_SOURCE_NOT_FOUND');
  return r;
}

export function listSources(): SyncSource[] {
  return db().all<SourceRow & { pending_count: number }>(`${SELECT} ORDER BY s.name`).map(toSource);
}

export function getSource(id: string): SyncSource {
  if (!SOURCE_ID_RE.test(id)) throw new HttpError(404, 'Git sync source not found', 'SYNC_SOURCE_NOT_FOUND');
  const r = db().get<SourceRow & { pending_count: number }>(`${SELECT} WHERE s.id = ?`, id);
  if (!r) throw new HttpError(404, 'Git sync source not found', 'SYNC_SOURCE_NOT_FOUND');
  return toSource(r);
}

/** The decrypted access token (server side only). */
export function sourceToken(r: SourceRow): string | undefined {
  return r.token_enc ? vault().decrypt<string>(r.token_enc) : undefined;
}

function newWebhookSecret(): { secret: string; enc: string; hash: string; prefix: string } {
  const secret = WEBHOOK_SECRET_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { secret, enc: vault().encrypt(secret), hash: sha256(secret), prefix: secret.slice(0, WEBHOOK_SECRET_PREFIX.length + 4) };
}

function checked(input: SourceInput): SourceInput {
  // throws a clear 400 for URLs that are not https, carry credentials or have no owner/repository
  resolveRepo(input.provider, input.repoUrl, input.apiUrl);
  if (input.token !== undefined && /\s/.test(input.token.trim())) throw new HttpError(400, 'The token must not contain spaces', 'SYNC_TOKEN_INVALID');
  return { ...input, kinds: [...new Set(input.kinds)] };
}

/** Settings as recorded in the audit log (no token, no secret). */
const auditable = (s: SourceInput) => ({
  provider: s.provider,
  repoUrl: s.repoUrl,
  apiUrl: s.apiUrl || null,
  refType: s.refType,
  branch: s.branch,
  folder: s.folder,
  kinds: s.kinds,
  intervalMinutes: s.intervalMinutes,
  webhookEnabled: s.webhookEnabled,
  requireSignedCommits: s.requireSignedCommits,
  allowedSigners: s.allowedSigners,
  autoAcceptNew: s.autoAcceptNew,
  enabled: s.enabled,
});

export function createSource(raw: SourceInput): SyncSourceSecret {
  requireAdmin();
  const s = checked(raw);
  const id = newId('gsr_');
  const ts = nowIso();
  const token = s.token?.trim();
  const sec = newWebhookSecret();
  db().tx(() => {
    db().run(
      `INSERT INTO sync_sources (id, name, provider, repo_url, api_url, ref_type, branch, folder, kinds, token_enc, interval_minutes, webhook_enabled,
         webhook_secret_enc, webhook_secret_hash, webhook_secret_prefix, require_signed, allowed_signers, auto_accept_new, enabled, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      s.name,
      s.provider,
      s.repoUrl,
      s.apiUrl ?? '',
      s.refType,
      s.branch,
      s.folder,
      JSON.stringify(s.kinds),
      token ? vault().encrypt(token) : null,
      s.intervalMinutes,
      s.webhookEnabled ? 1 : 0,
      sec.enc,
      sec.hash,
      sec.prefix,
      s.requireSignedCommits ? 1 : 0,
      JSON.stringify(s.allowedSigners),
      s.autoAcceptNew ? 1 : 0,
      s.enabled ? 1 : 0,
      currentUser()!.username,
      ts,
      ts,
    );
    audit({
      action: 'sync.source_created',
      entityType: 'sync_source',
      entityId: id,
      summary: `Git sync source "${s.name}" created (${s.provider} ${s.repoUrl}, ${s.refType} ${s.branch}${s.folder ? `, folder ${s.folder}` : ''})`,
      details: { ...auditable(s), token: token ? 'set' : 'none', webhookSecretPrefix: sec.prefix },
    });
  });
  return { source: getSource(id), webhookSecret: sec.secret };
}

export function updateSource(id: string, raw: SourceInput): SyncSource {
  requireAdmin();
  const before = requireSource(id);
  const s = checked(raw);
  const now = auditable(s);
  const was = auditable(toSource(before) as unknown as SourceInput);
  const changed: string[] = (Object.keys(now) as (keyof typeof now)[]).filter((k) => JSON.stringify(now[k]) !== JSON.stringify(was[k]));
  const token = s.token === undefined ? undefined : s.token.trim();
  const tokenEnc = token === undefined ? before.token_enc : token ? vault().encrypt(token) : null;
  // another repository or branch: the last commit says nothing about the new one
  const moved =
    before.repo_url !== s.repoUrl ||
    before.branch !== s.branch ||
    (before.ref_type ?? 'branch') !== s.refType ||
    before.folder !== s.folder ||
    before.provider !== s.provider;
  db().tx(() => {
    db().run(
      `UPDATE sync_sources SET name = ?, provider = ?, repo_url = ?, api_url = ?, ref_type = ?, branch = ?, folder = ?, kinds = ?, token_enc = ?, interval_minutes = ?,
         webhook_enabled = ?, require_signed = ?, allowed_signers = ?, auto_accept_new = ?, enabled = ?, updated_at = ?${moved ? ', last_commit = NULL, last_ref = NULL' : ''} WHERE id = ?`,
      s.name,
      s.provider,
      s.repoUrl,
      s.apiUrl ?? '',
      s.refType,
      s.branch,
      s.folder,
      JSON.stringify(s.kinds),
      tokenEnc,
      s.intervalMinutes,
      s.webhookEnabled ? 1 : 0,
      s.requireSignedCommits ? 1 : 0,
      JSON.stringify(s.allowedSigners),
      s.autoAcceptNew ? 1 : 0,
      s.enabled ? 1 : 0,
      nowIso(),
      id,
    );
    if (token !== undefined) changed.push('token');
    audit({
      action: 'sync.source_updated',
      entityType: 'sync_source',
      entityId: id,
      summary: `Git sync source "${s.name}" updated${changed.length ? ` (${changed.join(', ')})` : ''}`,
      details: { ...auditable(s), changed, token: token === undefined ? 'unchanged' : token ? 'replaced' : 'removed' },
    });
  });
  return getSource(id);
}

export function rotateWebhookSecret(id: string): SyncSourceSecret {
  requireAdmin();
  const r = requireSource(id);
  const sec = newWebhookSecret();
  db().tx(() => {
    db().run(
      'UPDATE sync_sources SET webhook_secret_enc = ?, webhook_secret_hash = ?, webhook_secret_prefix = ?, updated_at = ? WHERE id = ?',
      sec.enc,
      sec.hash,
      sec.prefix,
      nowIso(),
      id,
    );
    audit({
      action: 'sync.webhook_secret_rotated',
      entityType: 'sync_source',
      entityId: id,
      summary: `Webhook secret of Git sync source "${r.name}" rotated (old secret ${r.webhook_secret_prefix ?? ''}… is no longer accepted)`,
      details: { oldPrefix: r.webhook_secret_prefix, newPrefix: sec.prefix },
    });
  });
  return { source: getSource(id), webhookSecret: sec.secret };
}

/** Deletes the source and its pending updates. Items it brought in stay; they just lose their origin. */
export function deleteSource(id: string): void {
  requireAdmin();
  const r = requireSource(id);
  db().tx(() => {
    const pending = db().run("DELETE FROM sync_updates WHERE source_id = ? AND status IN ('pending', 'invalid')", id).changes;
    const items = db().run('DELETE FROM sync_items WHERE source_id = ?', id).changes;
    db().run('DELETE FROM sync_sources WHERE id = ?', id);
    audit({
      action: 'sync.source_deleted',
      entityType: 'sync_source',
      entityId: id,
      summary: `Git sync source "${r.name}" deleted (${pending} open update(s) dropped, ${items} item(s) keep their content but lose the Git origin)`,
      details: { repoUrl: r.repo_url, droppedUpdates: pending, unlinkedItems: items },
    });
  });
}

/** Steward's own example library as a ready source: disabled, no token, no webhook secret, reviewed like any source. */
export const STEWARD_EXAMPLES_SOURCE = {
  name: 'Steward example library',
  provider: 'github',
  repoUrl: 'https://github.com/vxrz/Steward',
  refType: 'tag',
  branch: `v${SYNC_VERSION_PLACEHOLDER}`,
  folder: 'examples',
  kinds: ['process', 'dashboard', 'monitor'],
} as const satisfies Partial<SourceInput>;

/**
 * Adds the example source once per installation (new ones and upgrades alike). A settings row
 * remembers it, so a source the administrator deleted is not brought back, and an existing source
 * is never changed. Runs at start-up, not as a migration: `db:copy` needs an empty target database.
 */
export function seedExamplesSource(): boolean {
  if (db().get('SELECT 1 FROM settings WHERE key = ?', EXAMPLES_SOURCE_SEEDED_KEY)) return false;
  const e = STEWARD_EXAMPLES_SOURCE;
  const ts = nowIso();
  const added = db().tx(() => {
    const n = db().run(
      `INSERT INTO sync_sources (id, name, provider, repo_url, api_url, ref_type, branch, folder, kinds, interval_minutes, webhook_enabled,
         require_signed, allowed_signers, auto_accept_new, enabled, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, 0, 0, 0, '[]', 0, 0, 'system', ?, ?) ON CONFLICT (id) DO NOTHING`,
      STEWARD_EXAMPLES_SOURCE_ID,
      e.name,
      e.provider,
      e.repoUrl,
      e.refType,
      e.branch,
      e.folder,
      JSON.stringify(e.kinds),
      ts,
      ts,
    ).changes;
    db().run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', EXAMPLES_SOURCE_SEEDED_KEY, JSON.stringify(ts));
    return n > 0;
  });
  if (!added) return false;
  audit({
    actor: 'system',
    action: 'sync.source_created',
    entityType: 'sync_source',
    entityId: STEWARD_EXAMPLES_SOURCE_ID,
    summary: `Git sync source "${e.name}" added, disabled (${e.provider} ${e.repoUrl}, tag ${e.branch}, folder ${e.folder}) – nothing is fetched until an administrator turns it on`,
    details: {
      provider: e.provider,
      repoUrl: e.repoUrl,
      refType: e.refType,
      branch: e.branch,
      folder: e.folder,
      kinds: e.kinds,
      enabled: false,
      token: 'none',
      builtIn: true,
    },
  });
  logger.info({ source: STEWARD_EXAMPLES_SOURCE_ID }, 'git sync: Steward example library added as a disabled source');
  return true;
}
