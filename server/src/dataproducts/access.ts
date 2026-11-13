import {
  DATA_PRODUCT_PERMISSIONS,
  type AccessReason,
  type DataProductModuleRole,
  type DataProductOwnedKind,
  type DataProductPermission,
  type Role,
} from '@sm/shared';
import type { AuthUser } from '../auth/context.js';
import { isAdmin, matches } from '../auth/permissions.js';
import { memberships, teamScoped } from '../auth/policy.js';
import { parseJson } from '../util.js';
import { usesModule as usesModuleAccess } from '../modules/access.js';

/**
 * Who may do what in the data products module (ADR 0036 part 12). **Module access** (ADR 0034 phase 1) decides who
 * uses the module at all: everyone signed in, or – restricted by an administrator – the selected teams and users
 * (administrators and auditors always). Someone who does not use it has no module role and no right on any of its
 * items, on every surface (its routes answer 404 MODULE_NO_ACCESS before this is asked; owning-team routes, link
 * pickers, monitor checks and contract drafts ask this). Within it the core roles give the module role
 * (`fromCoreRoles`): designer → manager, every other working role → viewer, administrators everything. Module roles
 * granted per team (contributor among them) come with ADR 0034 phase 2: `moduleRoleOf` is the seam that will ask them.
 *
 * Per item (owned kinds data_product, data_object, data_element, data_domain): without owning teams every working
 * role sees it and managers (designers) change it; with owning teams their members do (with their instance and team
 * roles), auditors see it, administrators may do everything. Named people add their rights on top: the product owner
 * (owners of a product) and a domain's owners may view, edit and manage; a data object's owner and stewards may see it
 * (responsibility, not rights – decision 6). Rights only add up.
 *
 * Elements can be hundreds of thousands: their owning teams are read in bulk (store.elementTeamIds) and lists filter in
 * SQL (elementScopeSql), never through the per-request index of owning teams.
 */

const ALL = DATA_PRODUCT_PERMISSIONS;

/** The module role a core role gives (ADR 0034 `fromCoreRoles`): designer → manager, other working roles → viewer. */
export const FROM_CORE_ROLES: Readonly<Record<Role, DataProductModuleRole | null>> = {
  admin: 'manager',
  designer: 'manager',
  operator: 'viewer',
  approver: 'viewer',
  auditor: 'viewer',
  viewer: 'viewer',
  status: null,
  plant: null,
};

/** The rights a module role gives on an item of the module (contributor: view; it may create, see canCreate). */
const BY_MODULE_ROLE: Readonly<Record<DataProductModuleRole, readonly DataProductPermission[]>> = {
  viewer: ['view'],
  contributor: ['view'],
  manager: ['view', 'edit', 'manage'],
};

const byRole = (r: Role): readonly DataProductPermission[] => {
  const m = FROM_CORE_ROLES[r];
  return r === 'admin' ? ALL : m ? BY_MODULE_ROLE[m] : [];
};

const RANK: Record<DataProductModuleRole, number> = { viewer: 1, contributor: 2, manager: 3 };

/** The person's module role in the instance (the highest of their instance and team roles; null: none). */
export function moduleRoleOf(u: AuthUser | null): DataProductModuleRole | null {
  if (!u || !usesModuleAccess(u, 'dataProducts')) return null;
  let best: DataProductModuleRole | null = null;
  const consider = (r: Role) => {
    const m = FROM_CORE_ROLES[r];
    if (m && (!best || RANK[m] > RANK[best])) best = m;
  };
  for (const r of u.roles) consider(r);
  for (const m of memberships(u).values()) for (const r of m.roles) consider(r);
  return best;
}

/** Whether the person uses the module at all (ADR 0034 module access, with a working role). */
export const usesModule = (u: AuthUser | null): boolean => moduleRoleOf(u) !== null;

/** Create products, data objects, elements and steps: the module's contributors and managers (designers), administrators. */
export const canCreate = (u: AuthUser | null): boolean => {
  const r = moduleRoleOf(u);
  return r === 'manager' || r === 'contributor';
};

/** Domains, layers and regulatory flags are the module's managers' (designers until module roles exist). */
export const canManageModule = (u: AuthUser | null): boolean => moduleRoleOf(u) === 'manager';

export interface ItemDecision {
  permissions: DataProductPermission[];
  reasons: AccessReason[];
}

/** Any right includes seeing; manage includes edit. */
function normalise(d: ItemDecision): ItemDecision {
  const has = new Set(d.permissions);
  if (has.size) has.add('view');
  if (has.has('manage')) has.add('edit');
  return { permissions: ALL.filter((p) => has.has(p)), reasons: d.reasons };
}

function decideItem(u: AuthUser | null, kind: DataProductOwnedKind, id: string, personal: readonly DataProductPermission[], subject?: string): ItemDecision {
  // module access first: who does not use the module has no right on its items (named owners included)
  if (u && !usesModuleAccess(u, 'dataProducts')) return { permissions: [], reasons: [] };
  const d = teamScoped<DataProductPermission>(
    u,
    { kind, id },
    {
      all: ALL,
      byRole,
      personal: personal.length ? { permissions: personal, ...(subject ? { subject, as: 'owner' as const } : {}) } : null,
      auditor: ['view'],
      unscoped: () => {
        const granted = new Set<DataProductPermission>(personal);
        for (const r of u?.roles ?? []) for (const p of byRole(r)) granted.add(p);
        return ALL.filter((p) => granted.has(p));
      },
    },
  );
  return normalise(d);
}

const firstMatch = (u: AuthUser | null, subjects: readonly string[]): string | undefined => (u ? subjects.find((s) => matches(u, s)) : undefined);

/** A data product: the product owner (owners) may view, edit and manage it. */
export function productAccess(u: AuthUser | null, p: { id: string; owners: string | readonly string[] }): ItemDecision {
  const owners = typeof p.owners === 'string' ? parseJson<string[]>(p.owners, []) : p.owners;
  const owner = firstMatch(u, owners);
  return decideItem(u, 'data_product', p.id, owner ? ALL : [], owner);
}

/** A domain: its owners and the module's managers. */
export function domainAccess(u: AuthUser | null, d: { id: string; owners: string | readonly string[] }): ItemDecision {
  const owners = typeof d.owners === 'string' ? parseJson<string[]>(d.owners, []) : d.owners;
  const owner = firstMatch(u, owners);
  return decideItem(u, 'data_domain', d.id, owner ? ALL : [], owner);
}

/** A data object: its data owner and stewards see it (responsibility, not rights); editing follows its owning teams. */
export function objectAccess(u: AuthUser | null, o: { id: string; owner: string | null; stewards: string | readonly string[] }): ItemDecision {
  const stewards = typeof o.stewards === 'string' ? parseJson<string[]>(o.stewards, []) : o.stewards;
  const named = firstMatch(u, [...(o.owner ? [`user:${o.owner.toLowerCase()}`] : []), ...stewards]);
  return decideItem(u, 'data_object', o.id, named ? ['view'] : [], named);
}

/**
 * An element of the catalogue, with its owning team ids read in bulk by the caller (store.elementTeamIds; [] : none).
 * Same rules as products, without named people.
 */
export function elementAccess(u: AuthUser | null, teamIds: readonly string[]): ItemDecision {
  if (!u || !usesModuleAccess(u, 'dataProducts')) return { permissions: [], reasons: [] };
  if (isAdmin(u)) return { permissions: [...ALL], reasons: [{ source: 'admin', role: 'admin', permissions: [...ALL] }] };
  const reasons: AccessReason[] = [];
  const add = (r: AccessReason) => r.permissions.length && reasons.push(r);
  if (!teamIds.length) for (const role of u.roles) add({ source: 'instanceRole', role, permissions: [...byRole(role)] });
  else {
    if (u.roles.includes('auditor')) add({ source: 'auditor', role: 'auditor', permissions: ['view'] });
    const mine = memberships(u);
    for (const t of teamIds) {
      const m = mine.get(t);
      if (!m) continue;
      for (const role of new Set([...u.roles, ...m.roles])) add({ source: 'teamRole', role, team: m.name, permissions: [...byRole(role)] });
    }
  }
  const granted = new Set(reasons.flatMap((r) => r.permissions));
  return normalise({ permissions: ALL.filter((p) => granted.has(p as DataProductPermission)), reasons });
}

/**
 * The elements `u` may see, as an SQL condition on the element alias `e` (lists, counts and searches filter in the
 * database, so a page of 100 never reads the catalogue's owning teams into memory).
 */
export function elementScopeSql(u: AuthUser | null, alias = 'e'): { sql: string; params: string[] } {
  if (!u || !usesModuleAccess(u, 'dataProducts')) return { sql: '1 = 0', params: [] };
  if (isAdmin(u) || u.roles.includes('auditor')) return { sql: '1 = 1', params: [] };
  const working = u.roles.some((r) => byRole(r).length > 0);
  const teams = [...memberships(u)].filter(([, m]) => working || m.roles.some((r) => byRole(r).length > 0)).map(([id]) => id);
  const unowned = `NOT EXISTS (SELECT 1 FROM resource_teams rt WHERE rt.kind = 'data_element' AND rt.resource_id = ${alias}.id)`;
  const owned = teams.length
    ? `EXISTS (SELECT 1 FROM resource_teams rt WHERE rt.kind = 'data_element' AND rt.resource_id = ${alias}.id AND rt.team_id IN (${teams.map(() => '?').join(', ')}))`
    : null;
  if (working) return { sql: owned ? `(${unowned} OR ${owned})` : unowned, params: owned ? teams : [] };
  return owned ? { sql: owned, params: teams } : { sql: '1 = 0', params: [] };
}
