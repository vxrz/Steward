import crypto from 'node:crypto';
import {
  DATA_LINEAGE_ID_PREFIX,
  DATA_LINEAGE_LIMITS as LL,
  DATA_LINEAGE_TOKEN_PREFIX,
  DATABASE_KIND,
  SNOWFLAKE_KIND,
  dataLineagePushPath,
  dataLineageSourceInput,
  dataLineageTokenInput,
  type DataLineageImport,
  type DataLineageNamespaceAlias,
  type DataLineageSource,
  type DataLineageToken,
  type DataLineageTokenCreated,
  type Platform,
} from '@sm/shared';
import { db } from '../../db.js';
import { audit } from '../../audit.js';
import { forbid, me } from '../../auth/access.js';
import { runAs, type AuthUser } from '../../auth/context.js';
import { isAdmin } from '../../auth/permissions.js';
import { memberships } from '../../auth/policy.js';
import { requireStepUpNow } from '../../auth/named-grants.js';
import { findUserByName, toAuthUser } from '../../auth/users.js';
import { getPlatform } from '../../platforms/service.js';
import { parseCidr } from '../../triggers/service.js';
import { HttpError, newId, nowIso, parseJson, sha256 } from '../../util.js';
import { canManageModule, usesModule } from '../access.js';
import { forgetQualityResults } from '../quality.js';
import { deleteProposalsOf, lineageSourceRow, proposalCounts, sourceNotFound, type LineageSourceRow } from './store.js';

/**
 * Lineage sources (0.24.0, ADR 0036 phase 2): where OpenLineage events and dbt files come from. Set up by the module's
 * managers (designers until module roles exist); a dbt source names the platform its models live on (one the person
 * may see). Owning teams decide who sees a source, its push tokens and its proposals ([]: every user of the module);
 * teams that reach people the creator's teams do not – or none at all – ask for the `access.grant` step-up and are an
 * access change in the audit log. Every change is session-only (the routes) and audited.
 *
 * Push tokens (`sdl_…`) follow the cost push tokens: bound to one source, they can do nothing but push to it; only a
 * SHA-256 is stored; allowed addresses, a rate limit and an expiry; they stop working when their creator is deactivated
 * or may no longer manage the source.
 */

const forbidden = () => forbid('change this lineage source', 'dataLineageSource');

/** view: the reader sees the source and its proposals; manage: change it, its tokens, upload dbt files. */
export function sourcePermissions(u: AuthUser | null, r: Pick<LineageSourceRow, 'team_ids'>): ('view' | 'manage')[] {
  if (!u || !usesModule(u)) return [];
  if (isAdmin(u)) return ['view', 'manage'];
  const teams = parseJson<string[]>(r.team_ids, []);
  const mine = memberships(u);
  const member = teams.some((t) => mine.has(t));
  if (teams.length && !member && !u.roles.includes('auditor')) return [];
  return canManageModule(u) && (!teams.length || member) ? ['view', 'manage'] : ['view'];
}

function platformOf(id: string | null): Platform | null {
  if (!id) return null;
  try {
    return getPlatform(id);
  } catch {
    return null;
  }
}

export function toSource(r: LineageSourceRow, u: AuthUser | null, counts?: DataLineageSource['proposals']): DataLineageSource {
  const p = platformOf(r.platform_id);
  const lastError = parseJson<{ message?: string; code?: string } | null>(r.last_error, null);
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    platformId: r.platform_id,
    platformName: p && (isAdmin(u) || p.permissions.length) ? p.name : null,
    namespaceAliases: parseJson<DataLineageNamespaceAlias[]>(r.namespace_aliases, []),
    teamIds: parseJson<string[]>(r.team_ids, []),
    enabled: !!Number(r.enabled),
    stats: {
      received: Number(r.received),
      refused: Number(r.refused),
      lastEventAt: r.last_event_at,
      lastError: lastError?.message ?? null,
      lastErrorCode: lastError?.code ?? null,
      lastErrorAt: r.last_error_at,
    },
    lastImport: parseJson<DataLineageImport | null>(r.last_import, null),
    proposals: counts ?? proposalCounts([r.id]).get(r.id) ?? { open: 0, accepted: 0, rejected: 0, documented: 0 },
    pushPath: dataLineagePushPath(r.id),
    permissions: sourcePermissions(u, r),
    revision: Number(r.revision),
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

/** The lineage sources the caller may see, by name (at most DATA_LINEAGE_LIMITS.sources exist). */
export function listLineageSources(): DataLineageSource[] {
  const u = me();
  const rows = db()
    .all<LineageSourceRow>('SELECT * FROM dp_lineage_sources ORDER BY name, id')
    .filter((r) => sourcePermissions(u, r).length > 0);
  const counts = proposalCounts(rows.map((r) => r.id));
  return rows.map((r) => toSource(r, u, counts.get(r.id) ?? { open: 0, accepted: 0, rejected: 0, documented: 0 }));
}

/** The source as the caller sees it (404 when they may not: the same answer as a missing one). */
export function visibleLineageSource(id: string): { row: LineageSourceRow; u: AuthUser; permissions: ('view' | 'manage')[] } {
  const u = me();
  const row = lineageSourceRow(id);
  if (!row) throw sourceNotFound(id);
  const permissions = sourcePermissions(u, row);
  if (!permissions.length) throw sourceNotFound(id);
  return { row, u, permissions };
}

export function manageableLineageSource(id: string) {
  const s = visibleLineageSource(id);
  if (!s.permissions.includes('manage')) forbidden();
  return s;
}

export function getLineageSource(id: string): DataLineageSource {
  const { row, u } = visibleLineageSource(id);
  return toSource(row, u);
}

type SourceInput = ReturnType<typeof dataLineageSourceInput.parse>;

/** dbt: a Snowflake or database platform the person may see; OpenLineage: none (datasets name their platform). */
function checkInput(u: AuthUser, input: SourceInput): void {
  if (input.kind === 'openlineage') {
    if (input.platformId)
      throw new HttpError(400, 'An OpenLineage source names no platform: the datasets of its events name theirs', 'DATA_LINEAGE_SOURCE_PLATFORM', {
        context: 'openlineage',
      });
    return;
  }
  if (!input.platformId)
    throw new HttpError(400, 'A dbt source names the platform its models live on', 'DATA_LINEAGE_SOURCE_PLATFORM', { context: 'dbtNeedsPlatform' });
  const p = platformOf(input.platformId);
  if (!p || (!isAdmin(u) && !p.permissions.length))
    throw new HttpError(400, `Platform "${input.platformId}" not found`, 'PLATFORM_NOT_FOUND', { id: input.platformId.slice(0, 100) });
  if (p.kind !== SNOWFLAKE_KIND && p.kind !== DATABASE_KIND)
    throw new HttpError(400, `dbt models are matched on Snowflake and database platforms – not "${p.name}"`, 'DATA_LINEAGE_SOURCE_PLATFORM', {
      context: 'kind',
      name: p.name,
    });
}

function checkTeams(ids: readonly string[]): void {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return;
  const known = new Set(
    db()
      .all<{ id: string }>(`SELECT id FROM teams WHERE id IN (${uniq.map(() => '?').join(', ')})`, ...uniq)
      .map((r) => r.id),
  );
  const unknown = uniq.find((t) => !known.has(t));
  if (unknown) throw new HttpError(400, `Unknown team "${unknown}"`, 'TEAM_NOT_FOUND', { name: unknown.slice(0, 100) });
}

/**
 * Teams that reach people `before` did not, or none at all (the whole module) where there were teams. From none (every
 * user of the module) to some narrows: nothing to confirm.
 */
const widens = (before: readonly string[], after: readonly string[]): boolean =>
  before.length > 0 && (after.length === 0 || after.some((t) => !before.includes(t)));

const teamNames = (ids: readonly string[]): string[] =>
  ids.length
    ? db()
        .all<{ name: string }>(`SELECT name FROM teams WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY name`, ...ids)
        .map((r) => r.name)
    : [];

function auditTeams(u: AuthUser, id: string, name: string, before: readonly string[], after: readonly string[]): void {
  const now = teamNames(after);
  const was = teamNames(before);
  audit({
    action: 'access.owning_teams_changed',
    entityType: 'data_lineage_source',
    entityId: id,
    summary: `Owning teams of lineage source "${name}": ${now.length ? now.join(', ') : 'none (every user of the module)'}${was.length ? ` (were: ${was.join(', ')})` : ''}`,
    details: { before: was, after: now, by: u.username },
  });
}

export function createLineageSource(body: unknown): DataLineageSource {
  const u = me();
  if (!canManageModule(u)) forbidden();
  const input = dataLineageSourceInput.parse(body);
  checkInput(u, input);
  checkTeams(input.teamIds ?? []);
  const n = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_lineage_sources')!.n);
  if (n >= LL.sources)
    throw new HttpError(409, `Limit reached: at most ${LL.sources} lineage sources`, 'DATA_PRODUCT_LIMIT', { context: 'lineageSources', max: LL.sources });
  // a new source is the creator's teams' by default; other teams or none widen who sees it
  const mine = [...memberships(u).keys()];
  const teams = [...new Set(input.teamIds ?? mine)];
  const widening = widens(mine, teams);
  if (widening) requireStepUpNow('access.grant', u, 'grantAccess');
  const id = newId(DATA_LINEAGE_ID_PREFIX.source);
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO dp_lineage_sources (id, name, kind, platform_id, namespace_aliases, team_ids, enabled, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      input.kind,
      input.platformId,
      JSON.stringify(input.namespaceAliases),
      JSON.stringify(teams),
      input.enabled ? 1 : 0,
      now,
      u.username,
      now,
      u.username,
    );
    audit({
      action: 'datalineage.source_created',
      entityType: 'data_lineage_source',
      entityId: id,
      summary: `Lineage source "${input.name}" (${input.kind === 'dbt' ? 'dbt' : 'OpenLineage'}) set up`,
      details: { kind: input.kind, platformId: input.platformId, namespaceAliases: input.namespaceAliases.length, enabled: input.enabled },
    });
    if (widening) auditTeams(u, id, input.name, mine, teams);
  });
  // as the person sees it now (owning teams they are not in leave them without sight of it)
  return toSource(lineageSourceRow(id)!, u);
}

export function updateLineageSource(id: string, body: unknown): DataLineageSource {
  const { row, u } = manageableLineageSource(id);
  const input = dataLineageSourceInput.parse(body);
  if (input.kind !== row.kind)
    throw new HttpError(400, 'A lineage source keeps its kind – set up a new source', 'DATA_LINEAGE_SOURCE_PLATFORM', { context: 'kindChanged' });
  checkInput(u, input);
  checkTeams(input.teamIds ?? []);
  const before = parseJson<string[]>(row.team_ids, []);
  const after = [...new Set(input.teamIds ?? before)];
  const widening = widens(before, after);
  if (widening) requireStepUpNow('access.grant', u, 'grantAccess');
  db().tx(() => {
    db().run(
      `UPDATE dp_lineage_sources SET name = ?, platform_id = ?, namespace_aliases = ?, team_ids = ?, enabled = ?, revision = revision + 1, updated_at = ?, updated_by = ?
       WHERE id = ?`,
      input.name,
      input.platformId,
      JSON.stringify(input.namespaceAliases),
      JSON.stringify(after),
      input.enabled ? 1 : 0,
      nowIso(),
      u.username,
      row.id,
    );
    audit({
      action: 'datalineage.source_updated',
      entityType: 'data_lineage_source',
      entityId: row.id,
      summary: `Lineage source "${input.name}" changed${input.enabled ? '' : ' (paused)'}`,
      details: { platformId: input.platformId, namespaceAliases: input.namespaceAliases.length, enabled: input.enabled },
    });
    if (before.join() !== after.join()) auditTeams(u, row.id, input.name, before, after);
  });
  return toSource(lineageSourceRow(row.id)!, u);
}

/** Deletes the source, its tokens, proposals and quality results; the steps made from its proposals stay. */
export function deleteLineageSource(id: string): void {
  const { row } = manageableLineageSource(id);
  db().tx(() => {
    db().run('DELETE FROM dp_lineage_tokens WHERE source_id = ?', row.id);
    // before the proposals: the source's dbt tests (deleted with them) say which results came through it
    const results = forgetQualityResults(row.id);
    const proposals = deleteProposalsOf(row.id);
    db().run('DELETE FROM dp_lineage_sources WHERE id = ?', row.id);
    audit({
      action: 'datalineage.source_deleted',
      entityType: 'data_lineage_source',
      entityId: row.id,
      summary: `Lineage source "${row.name}" deleted with ${proposals} proposal(s) – steps made from them stay`,
      details: { proposals, qualityResults: results },
    });
  });
}

// ---------- push tokens ----------

interface TokenRow {
  id: string;
  source_id: string;
  name: string;
  prefix: string;
  hash: string;
  allowed_cidrs: string;
  rate_limit_per_minute: number;
  expires_at: string | null;
  created_at: string;
  created_by: string;
  rotated_at: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}
export type LineageTokenRow = TokenRow;

export const tokenExpired = (r: Pick<TokenRow, 'expires_at'>) => !!r.expires_at && r.expires_at <= nowIso();

/** The creator is active and may still manage the source. */
export function creatorMayPush(r: Pick<TokenRow, 'created_by' | 'source_id'>): boolean {
  const user = findUserByName(r.created_by);
  if (!user || !user.active) return false;
  const src = lineageSourceRow(r.source_id);
  if (!src) return false;
  try {
    const au = toAuthUser(user);
    return runAs(au, () => sourcePermissions(au, src).includes('manage'));
  } catch {
    return false;
  }
}

const toToken = (r: TokenRow): DataLineageToken => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  allowedCidrs: parseJson<string[]>(r.allowed_cidrs, []),
  rateLimitPerMinute: Number(r.rate_limit_per_minute),
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  createdBy: r.created_by,
  rotatedAt: r.rotated_at,
  lastUsedAt: r.last_used_at,
  lastUsedIp: r.last_used_ip,
  expired: tokenExpired(r),
  creatorInactive: !creatorMayPush(r),
});

const secret = () => DATA_LINEAGE_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
const prefixOf = (token: string) => token.slice(0, DATA_LINEAGE_TOKEN_PREFIX.length + 6);

function tokenRow(sourceId: string, tokenId: string): TokenRow {
  const r = db().get<TokenRow>('SELECT * FROM dp_lineage_tokens WHERE id = ? AND source_id = ? AND revoked_at IS NULL', tokenId, sourceId);
  if (!r) throw new HttpError(404, `Push token ${tokenId} not found`, 'DATA_LINEAGE_TOKEN_NOT_FOUND', { id: tokenId });
  return r;
}

export function listLineageTokens(sourceId: string): DataLineageToken[] {
  manageableLineageSource(sourceId);
  return db().all<TokenRow>('SELECT * FROM dp_lineage_tokens WHERE source_id = ? AND revoked_at IS NULL ORDER BY created_at, id', sourceId).map(toToken);
}

export function createLineageToken(sourceId: string, body: unknown): DataLineageTokenCreated {
  const { row, u } = manageableLineageSource(sourceId);
  const input = dataLineageTokenInput.parse(body);
  const n = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_lineage_tokens WHERE source_id = ? AND revoked_at IS NULL', sourceId)!.n);
  if (n >= LL.tokensPerSource)
    throw new HttpError(409, `At most ${LL.tokensPerSource} push tokens per lineage source`, 'DATA_LINEAGE_TOKENS_FULL', { max: LL.tokensPerSource });
  const cidrs = [...new Set(input.allowedCidrs.map((c) => c.trim()).filter(Boolean))];
  for (const c of cidrs) {
    try {
      parseCidr(c);
    } catch {
      throw new HttpError(400, `"${c}" is not an IP address or CIDR range`, 'DATA_LINEAGE_CIDR', { value: c });
    }
  }
  const token = secret();
  const id = newId(DATA_LINEAGE_ID_PREFIX.token);
  const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString() : null;
  db().tx(() => {
    db().run(
      `INSERT INTO dp_lineage_tokens (id, source_id, name, prefix, hash, allowed_cidrs, rate_limit_per_minute, expires_at, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      sourceId,
      input.name,
      prefixOf(token),
      sha256(token),
      JSON.stringify(cidrs),
      input.rateLimitPerMinute,
      expiresAt,
      nowIso(),
      u.username,
    );
    audit({
      action: 'datalineage.token_created',
      entityType: 'data_lineage_source',
      entityId: sourceId,
      summary: `Push token "${input.name}" created for lineage source "${row.name}"${expiresAt ? ` (expires ${expiresAt.slice(0, 10)})` : ''}`,
      details: { tokenId: id, name: input.name, expiresAt, allowedCidrs: cidrs, rateLimitPerMinute: input.rateLimitPerMinute },
    });
  });
  return { ...toToken(tokenRow(sourceId, id)), token, path: dataLineagePushPath(sourceId) };
}

export function rotateLineageToken(sourceId: string, tokenId: string): DataLineageTokenCreated {
  const { row } = manageableLineageSource(sourceId);
  const r = tokenRow(sourceId, tokenId);
  const token = secret();
  db().tx(() => {
    db().run('UPDATE dp_lineage_tokens SET hash = ?, prefix = ?, rotated_at = ? WHERE id = ?', sha256(token), prefixOf(token), nowIso(), r.id);
    audit({
      action: 'datalineage.token_rotated',
      entityType: 'data_lineage_source',
      entityId: sourceId,
      summary: `Push token "${r.name}" of lineage source "${row.name}" rotated (${r.prefix}… is no longer accepted)`,
      details: { tokenId: r.id, name: r.name, previousPrefix: r.prefix },
    });
  });
  return { ...toToken(tokenRow(sourceId, tokenId)), token, path: dataLineagePushPath(sourceId) };
}

export function revokeLineageToken(sourceId: string, tokenId: string): void {
  const { row, u } = manageableLineageSource(sourceId);
  const r = tokenRow(sourceId, tokenId);
  db().tx(() => {
    db().run('UPDATE dp_lineage_tokens SET revoked_at = ?, revoked_by = ? WHERE id = ?', nowIso(), u.username, r.id);
    audit({
      action: 'datalineage.token_revoked',
      entityType: 'data_lineage_source',
      entityId: sourceId,
      summary: `Push token "${r.name}" of lineage source "${row.name}" revoked`,
      details: { tokenId: r.id, name: r.name, prefix: r.prefix },
    });
  });
}
