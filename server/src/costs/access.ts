import { costSettingsInput, type AclEntry, type CostScope, type CostSettings, type PlatformPermission } from '@sm/shared';
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
const DEFAULTS: CostSettings = { hideAmountsFromViewers: false, defaultCurrency: 'USD' };

export function costSettings(): CostSettings {
  return { ...DEFAULTS, ...readSetting<Partial<CostSettings>>(KEY, {}) };
}

export function setCostSettings(body: unknown): CostSettings {
  if (!capabilities(currentUser()).manageSettings)
    throw new HttpError(403, 'Only administrators change the cost settings', 'FORBIDDEN', { context: 'costSettings' });
  const next = costSettingsInput.parse(body);
  const before = costSettings();
  writeSetting(KEY, next);
  audit({
    action: 'cost.settings_changed',
    entityType: 'settings',
    entityId: KEY,
    summary: `Cost settings changed: amounts ${next.hideAmountsFromViewers ? 'hidden from' : 'shown to'} viewers, default currency ${next.defaultCurrency}`,
    details: { before, after: next },
  });
  return next;
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
}

const privileged = (u: AuthUser) => isAdmin(u) || u.roles.includes('auditor');

interface CatRow {
  id: string;
  name: string;
  owners: string;
  archived: number;
}

function catalogueInfo(u: AuthUser | null, scope: 'service' | 'application', id: string): ScopeInfo | null {
  const r = db().get<CatRow>(`SELECT id, name, owners, archived FROM ${scope === 'service' ? 'services' : 'applications'} WHERE id = ?`, id);
  if (!r) return null;
  if (!u) return { scope, id, name: r.name, amounts: true, owner: true, canEditBudget: true, canManageSource: false };
  const owners = parseJson<string[]>(r.owners, []);
  const a = catalogueAccess(u, { kind: scope, id, owners });
  if (!a.view) return null;
  const mine = memberships(u);
  const owner = isAdmin(u) || owners.some((s) => matches(u, s)) || catalogueTeams(scope, id).some((t) => mine.has(t.id));
  const amounts = owner || privileged(u) || !costSettings().hideAmountsFromViewers;
  return { scope, id, name: r.name, amounts, owner, canEditBudget: a.edit && !r.archived, canManageSource: false };
}

function teamInfo(u: AuthUser | null, id: string): ScopeInfo | null {
  const r = db().get<{ id: string; name: string }>('SELECT id, name FROM teams WHERE id = ?', id);
  if (!r) return null;
  if (!u) return { scope: 'team', id, name: r.name, amounts: true, owner: true, canEditBudget: true, canManageSource: false };
  const member = memberships(u).has(id);
  if (!member && !privileged(u)) return null;
  return { scope: 'team', id, name: r.name, amounts: true, owner: member || isAdmin(u), canEditBudget: isAdmin(u), canManageSource: false };
}

function platformInfo(u: AuthUser | null, id: string): ScopeInfo | null {
  const r = db().get<{ id: string; name: string; acl: string }>('SELECT id, name, acl FROM platforms WHERE id = ?', id);
  if (!r) return null;
  if (!u) return { scope: 'platform', id, name: r.name, amounts: true, owner: true, canEditBudget: false, canManageSource: true };
  const perms = platformPermissions(u, { id, acl: parseJson<AclEntry<PlatformPermission>[]>(r.acl, []) });
  if (!perms.length && !privileged(u)) return null;
  const mine = memberships(u);
  const owner = perms.includes('manage') || owningTeams('platform', id).some((t) => mine.has(t.id));
  const amounts = owner || privileged(u) || !costSettings().hideAmountsFromViewers;
  return { scope: 'platform', id, name: r.name, amounts, owner, canEditBudget: false, canManageSource: perms.includes('manage') };
}

/** What the reader may do with a scope; null when it does not exist or they may not see it. */
export function scopeInfo(scope: CostScope, id: string, u: AuthUser | null = currentUser()): ScopeInfo | null {
  if (scope === 'service' || scope === 'application') return catalogueInfo(u, scope, id);
  if (scope === 'team') return teamInfo(u, id);
  return platformInfo(u, id);
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
  const ids =
    scope === 'service'
      ? db().all<{ id: string }>('SELECT id FROM services WHERE archived = 0 ORDER BY name')
      : scope === 'application'
        ? db().all<{ id: string }>('SELECT id FROM applications WHERE archived = 0 ORDER BY name')
        : scope === 'team'
          ? db().all<{ id: string }>('SELECT id FROM teams ORDER BY name')
          : db().all<{ id: string }>('SELECT id FROM platforms ORDER BY name');
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
