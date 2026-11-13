import {
  dataDiscoverySourceInput,
  DATA_PRODUCT_ID_PREFIX,
  DATA_PRODUCT_LIMITS,
  KAFKA_TOPIC_RE,
  SNOWFLAKE_DISCOVERY_SCOPE_RE,
  SNOWFLAKE_KIND,
  KAFKA_KIND,
  type DataDiscoveryMode,
  type DataDiscoveryRun,
  type DataDiscoverySource,
  type DataDiscoveryRunStatus,
  type DataEnvironmentRule,
  type Platform,
} from '@sm/shared';
import type { z } from 'zod';
import { db } from '../../db.js';
import { audit } from '../../audit.js';
import { HttpError, newId, nowIso, parseJson } from '../../util.js';
import { logger } from '../../log.js';
import { forbid, me } from '../../auth/access.js';
import type { AuthUser } from '../../auth/context.js';
import { isAdmin } from '../../auth/permissions.js';
import { memberships, owningTeams } from '../../auth/policy.js';
import { requireStepUpNow } from '../../auth/named-grants.js';
import { getPlatform } from '../../platforms/service.js';
import { clearPlatformAccessCache } from '../../monitors/platforms.js';
import { canManageModule } from '../access.js';
import { discoverySourceRow, type DiscoverySourceRow } from '../store.js';
import { limitReached } from '../common.js';
import { DISCOVERABLE_KINDS, isRunning, runsOf, startRun } from './job.js';

/**
 * Discovery sources (ADR 0036 part 5): which platform, what to read, how often – set up by the module's managers
 * (designers until module roles exist) and the platform's managers, who must also be allowed to use the platform: a
 * source runs as the person who last saved it, with their use right checked again before every run. Every change is
 * session-only (the routes) and audited; owning teams of what a source finds that reach people the platform's teams do
 * not (or the whole instance) ask for the access.grant step-up and are an access change in the audit log.
 *
 * Who sees a source: whoever has a right on its platform and may see what it finds (its element teams, or the
 * platform's, are none or include one of theirs); administrators all. A source of a platform the reader may not see is
 * neither listed nor counted.
 */

type SourceInput = z.infer<typeof dataDiscoverySourceInput>;

const notFound = (id: string) => new HttpError(404, `Discovery source ${id} not found`, 'DATA_DISCOVERY_NOT_FOUND', { id });

/** The platform's rights of the caller, or null when the platform is gone. */
function platformOf(id: string): Platform | null {
  try {
    return getPlatform(id);
  } catch {
    return null;
  }
}

/** The owning teams of what the source finds: its own, else the platform's (ids). */
function effectiveTeams(teamIds: readonly string[], platformId: string): string[] {
  return teamIds.length ? [...teamIds] : owningTeams('platform', platformId).map((t) => t.id);
}

/** view: the reader may see the source; manage: change it, delete it, read now. */
function permissionsOf(u: AuthUser, r: Pick<DiscoverySourceRow, 'platform_id' | 'element_team_ids'>, p: Platform | null): ('view' | 'manage')[] {
  if (!p) return isAdmin(u) ? ['view', 'manage'] : [];
  if (isAdmin(u)) return ['view', 'manage'];
  if (!p.permissions.length) return [];
  const teams = effectiveTeams(parseJson<string[]>(r.element_team_ids, []), r.platform_id);
  const mine = memberships(u);
  if (teams.length && !teams.some((t) => mine.has(t))) return [];
  const manage = p.permissions.includes('use') && (canManageModule(u) || p.permissions.includes('manage'));
  return manage ? ['view', 'manage'] : ['view'];
}

function toSource(r: DiscoverySourceRow, u: AuthUser, p: Platform | null, lastRun: DataDiscoveryRun | null): DataDiscoverySource {
  return {
    id: r.id,
    name: r.name,
    platformId: r.platform_id,
    scope: parseJson<string[]>(r.scope, []),
    includePrefixes: parseJson<string[]>(r.include_prefixes, []),
    excludePrefixes: parseJson<string[]>(r.exclude_prefixes, []),
    environmentRules: parseJson<DataEnvironmentRule[]>(r.environment_rules, []),
    mode: (r.mode as DataDiscoveryMode | null) ?? null,
    identityId: r.identity_id,
    elementTeamIds: parseJson<string[]>(r.element_team_ids, []),
    intervalMinutes: Number(r.interval_minutes),
    enabled: !!Number(r.enabled),
    runAs: r.run_as,
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    lastStatus: (r.last_status as DataDiscoveryRunStatus | null) ?? null,
    failingSince: r.failing_since,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
    platformName: p?.name ?? '',
    platformKind: p?.kind ?? '',
    permissions: permissionsOf(u, r, p),
    running: isRunning(r.id),
    lastRun,
  };
}

/** The sources the caller may see (at most DATA_PRODUCT_LIMITS.discoverySources exist), by name; optional: one platform's. */
export function listSources(platformId?: string): DataDiscoverySource[] {
  const u = me();
  const rows = db().all<DiscoverySourceRow>(
    `SELECT * FROM dp_discovery_sources${platformId ? ' WHERE platform_id = ?' : ''} ORDER BY name, id`,
    ...(platformId ? [platformId] : []),
  );
  const platforms = new Map<string, Platform | null>();
  const visible = rows.filter((r) => {
    if (!platforms.has(r.platform_id)) platforms.set(r.platform_id, platformOf(r.platform_id));
    return permissionsOf(u, r, platforms.get(r.platform_id)!).length > 0;
  });
  const runs = runsOf(
    visible.map((r) => r.id),
    1,
  );
  return visible.map((r) => toSource(r, u, platforms.get(r.platform_id)!, runs.get(r.id)?.[0] ?? null));
}

/** The source as the caller sees it (404 when they may not: the same answer as a missing one). */
function visibleSource(id: string): { row: DiscoverySourceRow; platform: Platform | null; u: AuthUser; permissions: ('view' | 'manage')[] } {
  const u = me();
  const row = discoverySourceRow(id);
  if (!row) throw notFound(id);
  const platform = platformOf(row.platform_id);
  const permissions = permissionsOf(u, row, platform);
  if (!permissions.length) throw notFound(id);
  return { row, platform, u, permissions };
}

function manageableSource(id: string) {
  const s = visibleSource(id);
  if (!s.permissions.includes('manage')) forbid('change this discovery source', 'dataDiscoverySource');
  return s;
}

export function getSource(id: string): DataDiscoverySource {
  const { row, platform, u } = visibleSource(id);
  return toSource(row, u, platform, runsOf([row.id], 1).get(row.id)?.[0] ?? null);
}

export function listRuns(id: string): DataDiscoveryRun[] {
  const { row } = visibleSource(id);
  return runsOf([row.id]).get(row.id) ?? [];
}

/**
 * The platform of a new or changed source: one the caller may see (else "not found"), of a kind discovery reads,
 * which the caller may use and either manages or is a module manager for; the identity it names must be one the caller
 * may use and not privileged (background reads never use privileged identities).
 */
function checkPlatform(u: AuthUser, platformId: string, identityId: string | null): Platform {
  const p = platformOf(platformId);
  if (!p || (!isAdmin(u) && !p.permissions.length))
    throw new HttpError(400, `Platform "${platformId}" not found`, 'PLATFORM_NOT_FOUND', { id: platformId.slice(0, 100) });
  if (!DISCOVERABLE_KINDS.includes(p.kind))
    throw new HttpError(400, `Discovery reads Snowflake, Kafka and database platforms – not "${p.name}" (${p.kind})`, 'DATA_DISCOVERY_PLATFORM', {
      context: 'kind',
      name: p.name,
      kind: p.kind,
    });
  if (!p.permissions.includes('use'))
    throw new HttpError(403, `A discovery source runs as the person who saves it: you may not use "${p.name}"`, 'DATA_DISCOVERY_PLATFORM', {
      context: 'use',
      name: p.name,
    });
  if (!canManageModule(u) && !p.permissions.includes('manage')) forbid('set up discovery on this platform', 'dataDiscoverySource');
  if (identityId) {
    const i = p.identities?.find((x) => x.id === identityId);
    if (!i || !i.mayUse || i.privileged)
      throw new HttpError(400, `Choose an identity of "${p.name}" you may use (not a privileged one)`, 'DATA_DISCOVERY_PLATFORM', {
        context: 'identity',
        name: p.name,
      });
  }
  return p;
}

/** The scope, prefixes and mode fit the platform's kind (DATA_DISCOVERY_SCOPE otherwise). */
function checkScope(p: Platform, input: SourceInput): void {
  const bad = (context: string, value = '') =>
    new HttpError(400, `The scope does not fit a ${p.kind} platform${value ? `: "${value}"` : ''}`, 'DATA_DISCOVERY_SCOPE', {
      context,
      value: value.slice(0, 100),
    });
  if (input.mode && p.kind !== SNOWFLAKE_KIND) throw bad('mode');
  if (p.kind === SNOWFLAKE_KIND) {
    if (!input.scope.length) throw bad('snowflakeEmpty');
    const wrong = input.scope.find((s) => !SNOWFLAKE_DISCOVERY_SCOPE_RE.test(s));
    if (wrong !== undefined) throw bad('snowflake', wrong);
  } else if (p.kind === KAFKA_KIND) {
    const wrong = input.scope.find((s) => !KAFKA_TOPIC_RE.test(s));
    if (wrong !== undefined) throw bad('kafka', wrong);
  } else {
    const wrong = input.scope.find((s) => !/^[^\0\r\n.;]{1,128}$/.test(s));
    if (wrong !== undefined) throw bad('sql', wrong);
  }
}

/** Element teams that exist; their names for the audit entry. */
function checkTeams(ids: readonly string[]): Map<string, string> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return new Map();
  const rows = db().all<{ id: string; name: string }>(`SELECT id, name FROM teams WHERE id IN (${uniq.map(() => '?').join(', ')})`, ...uniq);
  const known = new Map(rows.map((r) => [r.id, r.name]));
  const unknown = uniq.find((t) => !known.has(t));
  if (unknown) throw new HttpError(400, `Unknown team "${unknown}"`, 'TEAM_NOT_FOUND', { name: unknown.slice(0, 100) });
  return known;
}

/**
 * Whether the owning teams of what the source finds widen access compared to `before` (both: the effective teams – the
 * source's, else the platform's): a team that was not there, or none at all (the whole instance) where there were teams.
 */
function widens(before: readonly string[], after: readonly string[]): boolean {
  return after.some((t) => !before.includes(t)) || (before.length > 0 && after.length === 0);
}

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
    entityType: 'data_discovery_source',
    entityId: id,
    summary: `Owning teams of what discovery source "${name}" finds: ${now.length ? now.join(', ') : 'none (the whole instance)'}${was.length ? ` (were: ${was.join(', ')})` : ''}`,
    details: { before: was, after: now, by: u.username },
  });
}

function values(input: SourceInput) {
  return [
    input.name,
    JSON.stringify([...new Set(input.scope)]),
    JSON.stringify([...new Set(input.includePrefixes)]),
    JSON.stringify([...new Set(input.excludePrefixes)]),
    JSON.stringify(input.environmentRules),
    input.mode,
    input.identityId,
    JSON.stringify([...new Set(input.elementTeamIds)]),
    input.intervalMinutes,
    input.enabled ? 1 : 0,
  ] as const;
}

export function createSource(body: unknown): DataDiscoverySource {
  const u = me();
  const input = dataDiscoverySourceInput.parse(body);
  const p = checkPlatform(u, input.platformId, input.identityId);
  checkScope(p, input);
  checkTeams(input.elementTeamIds);
  const n = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_discovery_sources')!.n);
  if (n >= DATA_PRODUCT_LIMITS.discoverySources) throw limitReached('discoverySources', DATA_PRODUCT_LIMITS.discoverySources);
  const platformTeams = effectiveTeams([], p.id);
  const after = effectiveTeams(input.elementTeamIds, p.id);
  const widening = widens(platformTeams, after);
  if (widening) requireStepUpNow('access.grant', u, 'grantAccess');
  const id = newId(DATA_PRODUCT_ID_PREFIX.source);
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO dp_discovery_sources (id, name, scope, include_prefixes, exclude_prefixes, environment_rules, mode, identity_id, element_team_ids,
         interval_minutes, enabled, platform_id, run_as, next_run_at, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      ...values(input),
      p.id,
      u.username,
      // the first scheduled read follows soon (the job looks every 5 minutes); Read now starts one at once
      now,
      now,
      u.username,
      now,
      u.username,
    );
    audit({
      action: 'datadiscovery.source_created',
      entityType: 'data_discovery_source',
      entityId: id,
      summary: `Discovery source "${input.name}" set up on ${p.name}${input.scope.length ? ` (${input.scope.slice(0, 5).join(', ')}${input.scope.length > 5 ? ', …' : ''})` : ''}, runs as ${u.username}`,
      details: { platformId: p.id, scope: input.scope, mode: input.mode, intervalMinutes: input.intervalMinutes, enabled: input.enabled },
    });
    if (widening) auditTeams(u, id, input.name, platformTeams, after);
  });
  clearPlatformAccessCache();
  return getSource(id);
}

export function updateSource(id: string, body: unknown): DataDiscoverySource {
  const { row, u } = manageableSource(id);
  const input = dataDiscoverySourceInput.parse(body);
  if (input.platformId !== row.platform_id)
    throw new HttpError(400, 'A discovery source keeps its platform – set up a new source for another platform', 'DATA_DISCOVERY_PLATFORM', {
      context: 'changed',
    });
  const p = checkPlatform(u, row.platform_id, input.identityId);
  checkScope(p, input);
  checkTeams(input.elementTeamIds);
  const before = effectiveTeams(parseJson<string[]>(row.element_team_ids, []), p.id);
  const after = effectiveTeams(input.elementTeamIds, p.id);
  const widening = widens(before, after);
  if (widening) requireStepUpNow('access.grant', u, 'grantAccess');
  const now = nowIso();
  db().tx(() => {
    // the person who saves the source takes it over: it runs with their use right from now on
    db().run(
      `UPDATE dp_discovery_sources SET name = ?, scope = ?, include_prefixes = ?, exclude_prefixes = ?, environment_rules = ?, mode = ?, identity_id = ?,
         element_team_ids = ?, interval_minutes = ?, enabled = ?, run_as = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?`,
      ...values(input),
      u.username,
      now,
      u.username,
      row.id,
    );
    audit({
      action: 'datadiscovery.source_updated',
      entityType: 'data_discovery_source',
      entityId: row.id,
      summary: `Discovery source "${input.name}" changed${row.run_as !== u.username ? `, runs as ${u.username} now (was ${row.run_as})` : ''}`,
      details: { scope: input.scope, mode: input.mode, intervalMinutes: input.intervalMinutes, enabled: input.enabled, runAs: u.username },
    });
    if (widening || before.join() !== after.join()) auditTeams(u, row.id, input.name, before, after);
  });
  clearPlatformAccessCache();
  return getSource(row.id);
}

/** Deletes the source and its run history; the elements it found stay in the catalogue (no longer marked missing by it). */
export function deleteSource(id: string): void {
  const { row } = manageableSource(id);
  if (isRunning(row.id))
    throw new HttpError(409, `Discovery source "${row.name}" is reading – wait for its run to end`, 'DATA_DISCOVERY_RUNNING', { name: row.name });
  db().tx(() => {
    const kept = db().run('UPDATE dp_elements SET discovery_source_id = NULL WHERE discovery_source_id = ?', row.id).changes;
    db().run('DELETE FROM dp_discovery_runs WHERE source_id = ?', row.id);
    db().run('DELETE FROM dp_discovery_sources WHERE id = ?', row.id);
    audit({
      action: 'datadiscovery.source_deleted',
      entityType: 'data_discovery_source',
      entityId: row.id,
      summary: `Discovery source "${row.name}" deleted – the ${kept} element(s) it found stay in the catalogue`,
      details: { platformId: row.platform_id, elements: kept },
    });
  });
}

/** Read now: starts the source's run (as the person the source runs as) and answers with the run going on. */
export function readNow(id: string): DataDiscoveryRun {
  const { row, u } = manageableSource(id);
  const { runId, done } = startRun(row.id, { trigger: 'manual', actor: u.username });
  // it settles by itself and the run history shows the end; a failure to write that end is only logged
  done.catch((err: unknown) => logger.warn({ err, source: row.id }, 'a data products discovery run did not finish'));
  return runsOf([row.id]).get(row.id)!.find((r) => r.id === runId)!;
}
