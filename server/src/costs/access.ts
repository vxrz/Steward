import { costSettingsInput, type AclEntry, type CostScope, type CostSettings, type FiscalYearChange, type PlatformPermission } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { capabilities, isAdmin, matches, platformPermissions } from '../auth/permissions.js';
import { catalogueAccess, catalogueTeams, memberships, owningTeams } from '../auth/policy.js';
import { readSetting, writeSetting } from '../settings.js';
import { HttpError, parseJson } from '../util.js';

/**
 * Who sees which costs (#226, docs/COSTS.md#who-sees-costs).
 *
 * - A scope (service, application, team, platform) is only reachable for those who may see it: a hidden one answers
 *   like a missing one, and lists neither name nor count it.
 * - Amounts: administrators and auditors; the named owners and the members of the owning teams of a service or
 *   application (an application without teams of its own: those of its services); the members of a team; who may
 *   manage a platform or is a member of its owning teams. Everybody else who may see the scope sees the amounts too –
 *   unless the setting "hide amounts from viewers" is on: then they see states and percentages only.
 * - Background work (jobs, no reader) sees everything.
 */

const KEY = 'costs.settings';
const DEFAULTS: CostSettings = { hideAmountsFromViewers: false, defaultCurrency: 'USD', fiscalYearStartMonth: 1, estimateChangePct: 5 };

/**
 * The settings are read for every scope of a list (security review 0.19.0 H2): kept for a while, read again after a
 * change here, on another database (restore, tests) and after CACHE_MS (a change written by other means, e.g. a
 * migration package).
 */
const CACHE_MS = 30_000;
let cached: { db: object; at: number; value: CostSettings } | null = null;

export function costSettings(): CostSettings {
  const d = db();
  if (cached && cached.db === d && Date.now() - cached.at < CACHE_MS) return { ...cached.value };
  const value = { ...DEFAULTS, ...readSetting<Partial<CostSettings>>(KEY, {}) };
  cached = { db: d, at: Date.now(), value };
  return { ...value };
}

export function setCostSettings(body: unknown): CostSettings {
  if (!capabilities(currentUser()).manageSettings)
    throw new HttpError(403, 'Only administrators change the cost settings', 'FORBIDDEN', { context: 'costSettings' });
  const x = costSettingsInput.parse(body);
  const before = costSettings();
  // the fiscal year start stays as it is when left out (clients from before 0.16)
  const next: CostSettings = {
    ...x,
    fiscalYearStartMonth: x.fiscalYearStartMonth ?? before.fiscalYearStartMonth,
    estimateChangePct: x.estimateChangePct ?? before.estimateChangePct,
  };
  const moved = next.fiscalYearStartMonth !== before.fiscalYearStartMonth ? fiscalYearChange(next.fiscalYearStartMonth) : null;
  writeSetting(KEY, next);
  cached = null;
  audit({
    action: 'cost.settings_changed',
    entityType: 'settings',
    entityId: KEY,
    summary: `Cost settings changed: amounts ${next.hideAmountsFromViewers ? 'hidden from' : 'shown to'} viewers, default currency ${next.defaultCurrency}, fiscal year starts in month ${next.fiscalYearStartMonth}${moved?.entriesOtherYear ? `; ${moved.entriesOtherYear} cost entr${moved.entriesOtherYear === 1 ? 'y falls' : 'ies fall'} into another fiscal year than their plan line now` : ''}`,
    details: { before, after: next, ...(moved ? { entriesOtherYear: moved.entriesOtherYear } : {}) },
  });
  return next;
}

/**
 * What a fiscal year start month would do to the plans (docs/COSTS.md#planning-per-service): plan lines keep their
 * fiscal year, entries fall into the year their date is in – an entry whose plan line is then of another year keeps
 * its link and counts as unplanned. The settings dialog asks before such a change.
 */
export function fiscalYearChange(startMonth: number): FiscalYearChange {
  if (!capabilities(currentUser()).manageSettings)
    throw new HttpError(403, 'Only administrators change the cost settings', 'FORBIDDEN', { context: 'costSettings' });
  const n = (sql: string, ...params: unknown[]) => Number(db().get<{ n: number }>(sql, ...params)?.n ?? 0);
  return {
    startMonth,
    lines: n('SELECT COUNT(*) AS n FROM cost_plan_lines'),
    entries: n('SELECT COUNT(*) AS n FROM cost_entries'),
    // the fiscal year of a date: its year, one less before the start month
    entriesOtherYear: n(
      `SELECT COUNT(*) AS n FROM cost_entries e JOIN cost_plan_lines l ON l.id = e.plan_line_id
        WHERE CAST(substr(e.entry_date, 1, 4) AS INTEGER) - (CASE WHEN CAST(substr(e.entry_date, 6, 2) AS INTEGER) < ? THEN 1 ELSE 0 END) <> l.fiscal_year`,
      startMonth,
    ),
  };
}

export interface ScopeInfo {
  scope: CostScope;
  id: string;
  name: string;
  /** Sees the amounts */
  amounts: boolean;
  /** An owner in the sense above (owner, owning team member, manager) – or an administrator */
  owner: boolean;
  canEditBudget: boolean;
  canManageSource: boolean;
  /**
   * May change the scope's cost plan (0.19.0, ADR 0032): a service – who may change it (as canEditBudget); a platform –
   * who may manage it and the members of its owning teams (as for the platform's settings)
   */
  canEditPlan: boolean;
}

const privileged = (u: AuthUser) => isAdmin(u) || u.roles.includes('auditor');

export interface CatRow {
  id: string;
  name: string;
  owners: string;
  archived: number;
}

function catalogueInfo(u: AuthUser | null, scope: 'service' | 'application', id: string, row?: CatRow): ScopeInfo | null {
  const r = row ?? db().get<CatRow>(`SELECT id, name, owners, archived FROM ${scope === 'service' ? 'services' : 'applications'} WHERE id = ?`, id);
  if (!r) return null;
  if (!u) return { scope, id, name: r.name, amounts: true, owner: true, canEditBudget: true, canManageSource: false, canEditPlan: true };
  const owners = parseJson<string[]>(r.owners, []);
  const a = catalogueAccess(u, { kind: scope, id, owners });
  if (!a.view) return null;
  const mine = memberships(u);
  const owner = isAdmin(u) || owners.some((s) => matches(u, s)) || catalogueTeams(scope, id).some((t) => mine.has(t.id));
  const amounts = owner || privileged(u) || !costSettings().hideAmountsFromViewers;
  return {
    scope,
    id,
    name: r.name,
    amounts,
    owner,
    canEditBudget: a.edit && !r.archived,
    canManageSource: false,
    canEditPlan: scope === 'service' && a.edit && !r.archived,
  };
}

function teamInfo(u: AuthUser | null, id: string): ScopeInfo | null {
  const r = db().get<{ id: string; name: string }>('SELECT id, name FROM teams WHERE id = ?', id);
  if (!r) return null;
  if (!u) return { scope: 'team', id, name: r.name, amounts: true, owner: true, canEditBudget: true, canManageSource: false, canEditPlan: false };
  const member = memberships(u).has(id);
  if (!member && !privileged(u)) return null;
  return { scope: 'team', id, name: r.name, amounts: true, owner: member || isAdmin(u), canEditBudget: isAdmin(u), canManageSource: false, canEditPlan: false };
}

function platformInfo(u: AuthUser | null, id: string, row?: { id: string; name: string; acl: string }): ScopeInfo | null {
  const r = row ?? db().get<{ id: string; name: string; acl: string }>('SELECT id, name, acl FROM platforms WHERE id = ?', id);
  if (!r) return null;
  if (!u) return { scope: 'platform', id, name: r.name, amounts: true, owner: true, canEditBudget: false, canManageSource: true, canEditPlan: true };
  const perms = platformPermissions(u, { id, acl: parseJson<AclEntry<PlatformPermission>[]>(r.acl, []) });
  if (!perms.length && !privileged(u)) return null;
  const mine = memberships(u);
  const owner = perms.includes('manage') || owningTeams('platform', id).some((t) => mine.has(t.id));
  const amounts = owner || privileged(u) || !costSettings().hideAmountsFromViewers;
  // the platform's own cost plan (ADR 0032): who may manage it and the members of its owning teams – an auditor reads only
  return { scope: 'platform', id, name: r.name, amounts, owner, canEditBudget: false, canManageSource: perms.includes('manage'), canEditPlan: owner };
}

/**
 * What the reader may do with a scope; null when it does not exist or they may not see it. `row`: the service's or
 * application's row when the caller read it already (lists).
 */
export function scopeInfo(scope: CostScope, id: string, u: AuthUser | null = currentUser(), row?: CatRow): ScopeInfo | null {
  if (scope === 'service' || scope === 'application') return catalogueInfo(u, scope, id, row);
  if (scope === 'team') return teamInfo(u, id);
  return platformInfo(u, id);
}

/**
 * scopeInfo of many platforms at once (the data products' costs, ADR 0036 part 11): one statement whatever their
 * number; platforms that do not exist or the reader may not see are missing from the map.
 */
export function platformScopes(ids: readonly string[], u: AuthUser | null = currentUser()): Map<string, ScopeInfo> {
  const uniq = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, ScopeInfo>();
  for (let i = 0; i < uniq.length; i += 500) {
    const part = uniq.slice(i, i + 500);
    for (const r of db().all<{ id: string; name: string; acl: string }>(
      `SELECT id, name, acl FROM platforms WHERE id IN (${part.map(() => '?').join(', ')})`,
      ...part,
    )) {
      const info = platformInfo(u, r.id, r);
      if (info) out.set(r.id, info);
    }
  }
  return out;
}

const SCOPE_NAMES: Record<CostScope, string> = { service: 'Service', application: 'Application', team: 'Team', platform: 'Platform' };

/** The scope, or 404 – a scope the reader may not see answers exactly like a missing one. */
export function requireScope(scope: CostScope, id: string): ScopeInfo {
  const s = scopeInfo(scope, id);
  if (!s) throw new HttpError(404, `${SCOPE_NAMES[scope]} ${id} not found`, 'COST_SCOPE_NOT_FOUND', { scope, id });
  return s;
}

/** Every scope of a kind the reader may see (not archived). */
export function visibleScopes(scope: CostScope, u: AuthUser | null = currentUser()): ScopeInfo[] {
  // services and applications with their rows in one statement (not one per item: security review 0.19.0 H2)
  if (scope === 'service' || scope === 'application')
    return db()
      .all<CatRow>(`SELECT id, name, owners, archived FROM ${scope === 'service' ? 'services' : 'applications'} WHERE archived = 0 ORDER BY name`)
      .map((r) => catalogueInfo(u, scope, r.id, r))
      .filter((x): x is ScopeInfo => !!x);
  const ids =
    scope === 'team' ? db().all<{ id: string }>('SELECT id FROM teams ORDER BY name') : db().all<{ id: string }>('SELECT id FROM platforms ORDER BY name');
  return ids.map((r) => scopeInfo(scope, r.id, u)).filter((x): x is ScopeInfo => !!x);
}

// ---------- what a scope covers ----------

export interface ScopeCover {
  /** Lines of these applications … */
  applications: string[];
  /** … and the unassigned lines of these platforms (teams: the platforms they own) */
  unassignedPlatforms: string[];
  /** … or every line of this platform */
  platform: string | null;
}

/** The applications whose teams include `teamId` (own teams, or for applications without: their services' teams). */
function teamApplications(teamId: string): string[] {
  return db()
    .all<{ id: string }>('SELECT id FROM applications WHERE archived = 0')
    .filter((a) => catalogueTeams('application', a.id).some((t) => t.id === teamId))
    .map((a) => a.id);
}

/**
 * What a scope covers. For a reader (`visibleOnly`, the default; `reader`, by default the signed-in user) a service or
 * team covers only the applications they may see – an application they may not see is neither named nor counted in
 * its totals; budgets and their notices use the whole scope (`visibleOnly: false`). No reader (a job): everything.
 */
export function coverOf(scope: CostScope, id: string, visibleOnly = true, reader: AuthUser | null = currentUser()): ScopeCover {
  if (scope === 'platform') return { applications: [], unassignedPlatforms: [], platform: id };
  if (scope === 'application') return { applications: [id], unassignedPlatforms: [], platform: null };
  const u = visibleOnly ? reader : null;
  const seen = (appId: string) => !u || !!scopeInfo('application', appId, u);
  if (scope === 'service')
    return {
      applications: db()
        .all<{ application_id: string }>('SELECT application_id FROM service_applications WHERE service_id = ? ORDER BY application_id', id)
        .map((r) => r.application_id)
        .filter(seen),
      unassignedPlatforms: [],
      platform: null,
    };
  return {
    applications: teamApplications(id).filter(seen),
    unassignedPlatforms: db()
      .all<{ resource_id: string }>("SELECT resource_id FROM resource_teams WHERE kind = 'platform' AND team_id = ? ORDER BY resource_id", id)
      .map((r) => r.resource_id),
    platform: null,
  };
}

/** coverOf of every service (visibleOnly, the reader) from two statements – for lists (security review 0.19.0 H2). */
export function serviceCovers(reader: AuthUser | null = currentUser()): (serviceId: string) => ScopeCover {
  const apps = new Map(
    db()
      .all<CatRow>('SELECT id, name, owners, archived FROM applications')
      .map((r) => [r.id, r]),
  );
  const seen = new Map<string, boolean>();
  const visible = (appId: string) => {
    if (!reader) return true;
    let v = seen.get(appId);
    if (v === undefined) seen.set(appId, (v = !!apps.get(appId) && !!scopeInfo('application', appId, reader, apps.get(appId))));
    return v;
  };
  const linked = new Map<string, string[]>();
  for (const r of db().all<{ service_id: string; application_id: string }>(
    'SELECT service_id, application_id FROM service_applications ORDER BY application_id',
  ))
    if (visible(r.application_id)) linked.set(r.service_id, [...(linked.get(r.service_id) ?? []), r.application_id]);
  return (serviceId) => ({ applications: linked.get(serviceId) ?? [], unassignedPlatforms: [], platform: null });
}

/**
 * Whether the reader sees every application a service or team covers (applications and platforms: always). Who does
 * not gets only the state of its budget (under, 80 %, reached) – its figures cover the whole scope, so they would give
 * away the costs of the applications left out by subtraction (docs/COSTS.md#budgets).
 */
export function seesWholeScope(scope: CostScope, id: string, reader: AuthUser | null = currentUser()): boolean {
  if (!reader || scope === 'platform' || scope === 'application') return true;
  return coverOf(scope, id, true, reader).applications.length === coverOf(scope, id, false).applications.length;
}

/** The WHERE part (on cost_records) of what a scope covers; `false` when it covers nothing. */
export function coverWhere(c: ScopeCover): { sql: string; params: unknown[] } | false {
  if (c.platform) return { sql: 'platform_id = ?', params: [c.platform] };
  const parts: string[] = [];
  const params: unknown[] = [];
  if (c.applications.length) {
    parts.push(`application_id IN (${c.applications.map(() => '?').join(', ')})`);
    params.push(...c.applications);
  }
  if (c.unassignedPlatforms.length) {
    parts.push(`(application_id IS NULL AND platform_id IN (${c.unassignedPlatforms.map(() => '?').join(', ')}))`);
    params.push(...c.unassignedPlatforms);
  }
  if (!parts.length) return false;
  return { sql: `(${parts.join(' OR ')})`, params };
}
