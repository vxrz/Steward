/**
 * Team-scoped access (#131): one place that decides what someone may do with a resource, and says why.
 *
 * - A **role** says what someone may do (viewer, operator, designer, approver, auditor, admin).
 * - It applies to the whole **instance** (the user's roles) or to a **team** (the roles a member has in a team).
 * - A resource's **owning teams** are its scope. Without one, a resource behaves exactly as before: instance
 *   roles give their default rights, and an access list, when there is one, restricts it to its entries.
 * - With owning teams, members of those teams have their instance and team roles on it; everyone else only
 *   what an access list entry gives (an exception for sharing across teams). Administrators have every right,
 *   auditors may view, a process's owner may do everything.
 * - Rights only add up; there are no deny rules.
 */
import {
  PLATFORM_PERMISSIONS,
  PROCESS_PERMISSIONS,
  TEAM_ROLES,
  type AccessReason,
  type AclEntry,
  type OwnedKind,
  type PlatformPermission,
  type ProcessPermission,
  type Role,
} from '@sm/shared';
import { db } from '../db.js';
import { parseJson } from '../util.js';
import type { AuthUser } from './context.js';
import { isAdmin, matches, DEFAULT_PLATFORM, DEFAULT_PROCESS } from './permissions.js';

export interface OwningTeam {
  id: string;
  name: string;
}

/** The owning teams of a resource (none: it belongs to the whole instance). */
export function owningTeams(kind: OwnedKind, id: string): OwningTeam[] {
  return db().all<OwningTeam>(
    'SELECT t.id, t.name FROM resource_teams r JOIN teams t ON t.id = r.team_id WHERE r.kind = ? AND r.resource_id = ? ORDER BY t.name',
    kind,
    id,
  );
}

/** The teams a user is a member of, with the roles they have in each. Read once per user object (a request). */
const membershipCache = new WeakMap<AuthUser, Map<string, { name: string; roles: Role[] }>>();
export function memberships(u: AuthUser): Map<string, { name: string; roles: Role[] }> {
  let m = membershipCache.get(u);
  if (!m) {
    m = new Map(
      db()
        .all<{ id: string; name: string; roles: string | null }>(
          'SELECT t.id, t.name, m.roles FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ?',
          u.id,
        )
        .map((r) => [r.id, { name: r.name, roles: parseJson<string[]>(r.roles, []).filter((x): x is Role => (TEAM_ROLES as readonly string[]).includes(x)) }]),
    );
    membershipCache.set(u, m);
  }
  return m;
}

interface Decision<P extends string> {
  permissions: P[];
  reasons: AccessReason[];
}

/**
 * The rights `u` has on a resource, with the reasons. `all` lists every right of the kind (in order), `defaults`
 * the rights each role gives, `owner` the user who owns the resource (processes).
 */
function decide<P extends string>(
  u: AuthUser | null,
  r: { kind: OwnedKind; id: string; owner?: string | null; acl: AclEntry<P>[] },
  all: readonly P[],
  defaults: Record<Role, readonly P[]>,
  auditorView?: P,
): Decision<P> {
  if (!u) return { permissions: [], reasons: [] };
  if (isAdmin(u)) return { permissions: [...all], reasons: [{ source: 'admin', role: 'admin', permissions: [...all] }] };
  if (r.owner && r.owner.toLowerCase() === u.username.toLowerCase()) return { permissions: [...all], reasons: [{ source: 'owner', permissions: [...all] }] };
  const reasons: AccessReason[] = [];
  const add = (reason: AccessReason) => reason.permissions.length && reasons.push(reason);
  if (auditorView && u.roles.includes('auditor')) add({ source: 'auditor', role: 'auditor', permissions: [auditorView] });
  const teams = owningTeams(r.kind, r.id);
  if (!teams.length) {
    // the whole instance's resource: as before team scopes
    if (!r.acl.length) for (const role of u.roles) add({ source: 'instanceRole', role, permissions: [...(defaults[role] ?? [])] });
  } else {
    // members of an owning team: their instance roles and their roles in that team
    const mine = memberships(u);
    for (const t of teams) {
      const m = mine.get(t.id);
      if (!m) continue;
      for (const role of new Set([...u.roles, ...m.roles])) add({ source: 'teamRole', role, team: t.name, permissions: [...(defaults[role] ?? [])] });
    }
  }
  // access list entries: the only rights on an unowned resource that has a list, an exception on an owned one
  for (const e of r.acl) if (matches(u, e.subject)) add({ source: 'accessList', subject: e.subject, permissions: [...e.permissions] });
  const granted = new Set(reasons.flatMap((x) => x.permissions));
  return { permissions: all.filter((x) => granted.has(x)), reasons };
}

export function processAccess(u: AuthUser | null, p: { id: string; owner?: string | null; acl: AclEntry<ProcessPermission>[] }): Decision<ProcessPermission> {
  const d = decide(u, { kind: 'process', ...p }, PROCESS_PERMISSIONS, DEFAULT_PROCESS, 'view');
  // any right on a process includes seeing it
  if (d.permissions.length && !d.permissions.includes('view')) d.permissions = PROCESS_PERMISSIONS.filter((x) => x === 'view' || d.permissions.includes(x));
  return d;
}

export function platformAccess(u: AuthUser | null, p: { id: string; acl: AclEntry<PlatformPermission>[] }): Decision<PlatformPermission> {
  const d = decide(u, { kind: 'platform', ...p }, PLATFORM_PERMISSIONS, DEFAULT_PLATFORM);
  // manage includes use
  if (d.permissions.includes('manage') && !d.permissions.includes('use')) d.permissions = [...PLATFORM_PERMISSIONS];
  return d;
}

/**
 * Whether `u` may see data read from a platform (dataset partitions, #142): from a platform of the whole instance
 * without an access list everyone who sees the dataset; otherwise members of its owning teams and whoever may use it.
 */
export function platformDataVisible(u: AuthUser | null, p: { id: string; acl: AclEntry<PlatformPermission>[] }): boolean {
  if (!u) return false;
  const d = platformAccess(u, p);
  if (d.permissions.includes('use')) return true;
  const teams = owningTeams('platform', p.id);
  if (!teams.length) return !p.acl.length;
  const mine = memberships(u);
  return teams.some((t) => mine.has(t.id));
}

// ---------- the service catalogue: services, applications, systems ----------

export type CatalogueKind = 'service' | 'application' | 'system';
/** Who may change the catalogue by instance role (as before team scopes). */
const CATALOGUE_EDITORS: readonly Role[] = ['admin', 'designer'];

/**
 * The teams a catalogue item belongs to: its own, or – for an application without its own – those of the services
 * it is part of (an application in services of two teams belongs to both).
 */
export function catalogueTeams(kind: CatalogueKind, id: string): OwningTeam[] {
  const own = owningTeams(kind, id);
  if (own.length || kind !== 'application') return own;
  return db().all<OwningTeam>(
    `SELECT DISTINCT t.id, t.name FROM service_applications sa
       JOIN resource_teams r ON r.kind = 'service' AND r.resource_id = sa.service_id
       JOIN teams t ON t.id = r.team_id
     WHERE sa.application_id = ? ORDER BY t.name`,
    id,
  );
}

export interface CatalogueDecision {
  view: boolean;
  edit: boolean;
  reasons: AccessReason[];
}

/**
 * Seeing and changing a catalogue item. Without owning teams: everybody signed in sees it, designers, administrators
 * and its named owners change it (as before). With owning teams: members of those teams see it and change it when
 * they are designers there; its named owners, administrators (both: change) and auditors (see) as well.
 */
export function catalogueAccess(u: AuthUser | null, r: { kind: CatalogueKind; id: string; owners: string[] }): CatalogueDecision {
  if (!u) return { view: false, edit: false, reasons: [] };
  if (isAdmin(u)) return { view: true, edit: true, reasons: [{ source: 'admin', role: 'admin', permissions: ['view', 'edit'] }] };
  const reasons: AccessReason[] = [];
  const owner = r.owners.find((s) => matches(u, s));
  if (owner) reasons.push({ source: 'accessList', subject: owner, permissions: ['view', 'edit'] });
  const teams = catalogueTeams(r.kind, r.id);
  if (!teams.length) {
    for (const role of u.roles) reasons.push({ source: 'instanceRole', role, permissions: CATALOGUE_EDITORS.includes(role) ? ['view', 'edit'] : ['view'] });
  } else {
    if (u.roles.includes('auditor')) reasons.push({ source: 'auditor', role: 'auditor', permissions: ['view'] });
    const mine = memberships(u);
    for (const t of teams) {
      const m = mine.get(t.id);
      if (!m) continue;
      for (const role of new Set([...u.roles, ...m.roles]))
        reasons.push({ source: 'teamRole', role, team: t.name, permissions: CATALOGUE_EDITORS.includes(role) ? ['view', 'edit'] : ['view'] });
    }
  }
  const granted = new Set(reasons.flatMap((x) => x.permissions));
  return { view: granted.has('view'), edit: granted.has('edit'), reasons };
}
