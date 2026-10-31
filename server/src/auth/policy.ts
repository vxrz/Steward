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
import { currentStore, type AuthUser } from './context.js';
import { isAdmin, matches, DEFAULT_PLATFORM, DEFAULT_PROCESS } from './permissions.js';

export interface OwningTeam {
  id: string;
  name: string;
}

/**
 * The owning teams of a resource (none: it belongs to the whole instance). Within a request (or job run) all owning
 * teams are read once, so filtering a long list costs one query.
 */
export function owningTeams(kind: OwnedKind, id: string): OwningTeam[] {
  const store = currentStore();
  if (!store)
    return db().all<OwningTeam>(
      'SELECT t.id, t.name FROM resource_teams r JOIN teams t ON t.id = r.team_id WHERE r.kind = ? AND r.resource_id = ? ORDER BY t.name',
      kind,
      id,
    );
  if (!store.teamIndex) {
    const index = new Map<string, OwningTeam[]>();
    for (const r of db().all<{ kind: string; resource_id: string; id: string; name: string }>(
      'SELECT r.kind, r.resource_id, t.id, t.name FROM resource_teams r JOIN teams t ON t.id = r.team_id ORDER BY t.name',
    )) {
      const key = `${r.kind}:${r.resource_id}`;
      const list = index.get(key) ?? [];
      list.push({ id: r.id, name: r.name });
      index.set(key, list);
    }
    store.teamIndex = index;
  }
  return store.teamIndex.get(`${kind}:${id}`) ?? [];
}

/**
 * Run `fn` as if the owning teams were `next` (a preview of a change): only this request sees it, nothing is stored.
 */
export function withOwningTeams<T>(next: (index: Map<string, OwningTeam[]>) => void, fn: () => T): T {
  const store = currentStore();
  if (!store) throw new Error('withOwningTeams needs a request');
  owningTeams('process', ''); // reads the index
  const saved = store.teamIndex!;
  const copy = new Map([...saved].map(([k, v]) => [k, [...v]]));
  next(copy);
  store.teamIndex = copy;
  try {
    return fn();
  } finally {
    store.teamIndex = saved;
  }
}

/** Forget the owning teams read in this request (after changing them). */
export function teamsChanged(): void {
  const store = currentStore();
  if (store) store.teamIndex = undefined;
}

/** Set the owning teams of a resource (no audit: callers say why). */
export function setOwningTeams(kind: OwnedKind, id: string, teamIds: string[]): void {
  const d = db();
  d.tx(() => {
    d.run('DELETE FROM resource_teams WHERE kind = ? AND resource_id = ?', kind, id);
    const ts = new Date().toISOString();
    for (const t of new Set(teamIds)) d.run('INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES (?, ?, ?, ?)', kind, id, t, ts);
  });
  teamsChanged();
}

/**
 * The owning teams a new resource gets from its creator (#131): the creator's teams that already own something. A
 * team that owns nothing does not use team scopes yet, so after an upgrade new resources stay the whole instance's.
 */
export function creatorTeams(u: AuthUser | null): string[] {
  if (!u || isAdmin(u)) return [];
  const mine = [...memberships(u).keys()];
  if (!mine.length) return [];
  const owning = new Set(
    db()
      .all<{ team_id: string }>(`SELECT DISTINCT team_id FROM resource_teams WHERE team_id IN (${mine.map(() => '?').join(', ')})`, ...mine)
      .map((r) => r.team_id),
  );
  return mine.filter((t) => owning.has(t));
}

/** Give a new resource its creator's teams (see creatorTeams). */
export function assignCreatorTeams(kind: OwnedKind, id: string, u: AuthUser | null): void {
  const teams = creatorTeams(u);
  if (teams.length) setOwningTeams(kind, id, teams);
}

/** Remove the owning teams of a deleted resource. */
export function forgetOwningTeams(kind: OwnedKind, id: string): void {
  db().run('DELETE FROM resource_teams WHERE kind = ? AND resource_id = ?', kind, id);
  teamsChanged();
}

/** Whether `u` is a member of one of `teams`, and the roles they have there (instance roles included). */
export function teamRoles(u: AuthUser, teams: OwningTeam[]): { team: string; roles: Role[] }[] {
  const mine = memberships(u);
  const out: { team: string; roles: Role[] }[] = [];
  for (const t of teams) {
    const m = mine.get(t.id);
    if (m) out.push({ team: t.name, roles: [...new Set([...u.roles, ...m.roles])] });
  }
  return out;
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
export function decide<P extends string>(
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
 * it is part of (an application in services of two teams belongs to both; one that is also part of a service of the
 * whole instance belongs to the whole instance).
 */
export function catalogueTeams(kind: CatalogueKind, id: string): OwningTeam[] {
  const own = owningTeams(kind, id);
  if (own.length || kind !== 'application') return own;
  const byId = new Map<string, OwningTeam>();
  for (const r of db().all<{ service_id: string }>('SELECT service_id FROM service_applications WHERE application_id = ?', id)) {
    const teams = owningTeams('service', r.service_id);
    // also part of a service of the whole instance: the application is the whole instance's as well
    if (!teams.length) return [];
    for (const t of teams) byId.set(t.id, t);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
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

// ---------- records and living documents ----------

/** Create and edit records, run the non-approval transitions (as records/access.ts). */
const RECORD_EDITORS: readonly Role[] = ['admin', 'designer', 'operator'];
const RECORD_APPROVERS: readonly Role[] = ['admin', 'approver'];

export interface RecordDecision {
  view: boolean;
  edit: boolean;
  approve: boolean;
  reasons: AccessReason[];
}

/**
 * Seeing, changing and approving a record (#131). Without owning teams: everybody signed in sees it, editors by role
 * and its owner change it, approvers approve (as before). With owning teams: members of those teams with their
 * instance and team roles, its owner (sees and changes it), administrators (everything) and auditors (see).
 * Document editions, reviews, attachments and links follow their record.
 */
export function recordAccess(u: AuthUser | null, r: { id: string; owner: string }): RecordDecision {
  if (!u) return { view: false, edit: false, approve: false, reasons: [] };
  const all = ['view', 'edit', 'approve'];
  if (isAdmin(u)) return { view: true, edit: true, approve: true, reasons: [{ source: 'admin', role: 'admin', permissions: all }] };
  const reasons: AccessReason[] = [];
  const rights = (roles: readonly Role[]) => [
    'view',
    ...(roles.some((x) => RECORD_EDITORS.includes(x)) ? ['edit'] : []),
    ...(roles.some((x) => RECORD_APPROVERS.includes(x)) ? ['approve'] : []),
  ];
  if (r.owner && r.owner.toLowerCase() === u.username.toLowerCase()) reasons.push({ source: 'owner', permissions: ['view', 'edit'] });
  const teams = owningTeams('record', r.id);
  if (!teams.length) {
    for (const role of u.roles) reasons.push({ source: 'instanceRole', role, permissions: rights([role]) });
  } else {
    if (u.roles.includes('auditor')) reasons.push({ source: 'auditor', role: 'auditor', permissions: ['view'] });
    for (const m of teamRoles(u, teams)) for (const role of m.roles) reasons.push({ source: 'teamRole', role, team: m.team, permissions: rights([role]) });
  }
  const granted = new Set(reasons.flatMap((x) => x.permissions));
  return { view: granted.has('view'), edit: granted.has('edit'), approve: granted.has('approve'), reasons };
}

// ---------- credentials, dashboards, ticket references: their own rules while they have no owning teams ----------

/**
 * Team scope on top of a kind's own rules (#131). Without owning teams `unscoped` decides (as before). With owning
 * teams: administrators have every right, `personal` (an owner, a responsible) keeps theirs, auditors `auditor`, and
 * members of an owning team what their instance and team roles give (`byRole`); everyone else nothing.
 */
export function teamScoped<P extends string>(
  u: AuthUser | null,
  r: { kind: OwnedKind; id: string },
  o: {
    all: readonly P[];
    byRole: (role: Role) => readonly P[];
    personal?: { permissions: readonly P[]; subject?: string } | null;
    auditor?: readonly P[];
    unscoped: () => P[];
  },
): Decision<P> {
  if (!u) return { permissions: [], reasons: [] };
  if (isAdmin(u)) return { permissions: [...o.all], reasons: [{ source: 'admin', role: 'admin', permissions: [...o.all] }] };
  const reasons: AccessReason[] = [];
  const add = (reason: AccessReason) => reason.permissions.length && reasons.push(reason);
  if (o.personal) add({ source: 'owner', ...(o.personal.subject ? { subject: o.personal.subject } : {}), permissions: [...o.personal.permissions] });
  const teams = owningTeams(r.kind, r.id);
  if (!teams.length) {
    for (const role of u.roles) add({ source: 'instanceRole', role, permissions: [...o.byRole(role)] });
    return { permissions: o.unscoped(), reasons };
  }
  if (o.auditor && u.roles.includes('auditor')) add({ source: 'auditor', role: 'auditor', permissions: [...o.auditor] });
  for (const m of teamRoles(u, teams)) for (const role of m.roles) add({ source: 'teamRole', role, team: m.team, permissions: [...o.byRole(role)] });
  const granted = new Set(reasons.flatMap((x) => x.permissions));
  return { permissions: o.all.filter((x) => granted.has(x)), reasons };
}
