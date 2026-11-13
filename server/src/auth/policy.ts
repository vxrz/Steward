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
 * - **Shares** (ADR 0033) give a user, a team or a role a level (View, Edit, Manage) and the kind's action rights on
 *   one resource – for kinds that pass their share model (`ShareModel`). A resource whose scope is **Restricted** gives
 *   instance roles nothing: only its owning teams, its shares, administrators, auditors and owners reach it.
 * - Rights only add up; there are no deny rules.
 */
import {
  DATA_CONTRACT_PERMISSIONS,
  PLATFORM_PERMISSIONS,
  PROCESS_PERMISSIONS,
  TEAM_ROLES,
  type AccessReason,
  type AclEntry,
  type DataContractPermission,
  type NewResourceTeams,
  type TeamNewResourceMode,
  type OwnedKind,
  type MonitorPermission,
  type PlantPermission,
  type PlatformPermission,
  type ProcessPermission,
  type Role,
  type ShareAction,
  type ShareLevel,
  type ModuleId,
  DEPRECATED_ROLES,
  SHARE_LEVELS,
  accessModule,
  moduleOfRoute,
  moduleRoleFromCore,
  moduleRoleRights,
  modulesWithRoles,
} from '@sm/shared';
import { db } from '../db.js';
import { HttpError, parseJson } from '../util.js';
import { currentStore, type AuthUser } from './context.js';
import { isAdmin, matches, subjectsOf, DEFAULT_PLATFORM, DEFAULT_PROCESS } from './permissions.js';

/** A status viewer: role "status" and no other (#26) – auth/access.ts has the same; repeated so this module imports no route layer. */
const isStatusViewer = (roles: readonly string[]): boolean => roles.length > 0 && roles.every((r) => r === 'status');
import { isRestricted, sharesFor } from './share-store.js';
import { formerRolesOf, grantedModuleRoles, modulesGrantingRoles } from '../modules/grants.js';

/**
 * The instance roles a person has for the rules outside a module's own kinds: their roles and the former role "plant"
 * when the plant registry's contributor role or more is granted to them (ADR 0034 part 5, modules/grants.ts).
 */
export const policyRoles = (u: AuthUser): Role[] => {
  const former = formerRolesOf(u);
  return former.length ? [...u.roles, ...former] : u.roles;
};

export interface OwningTeam {
  id: string;
  name: string;
}

/** Kinds whose owning teams are not part of the per-request index (too many rows). */
const PER_ROW_KINDS: ReadonlySet<OwnedKind> = new Set<OwnedKind>(['data_element']);

/**
 * The owning teams of a resource (none: it belongs to the whole instance). Within a request (or job run) all owning
 * teams are read once, so filtering a long list costs one query.
 */
export function owningTeams(kind: OwnedKind, id: string): OwningTeam[] {
  const store = currentStore();
  // elements of the data products' catalogue (ADR 0036) can be hundreds of thousands: read one at a time, never into
  // the index every request builds (the module reads them in bulk itself, dataproducts/access.ts)
  if (!store || PER_ROW_KINDS.has(kind))
    return db().all<OwningTeam>(
      'SELECT t.id, t.name FROM resource_teams r JOIN teams t ON t.id = r.team_id WHERE r.kind = ? AND r.resource_id = ? ORDER BY t.name',
      kind,
      id,
    );
  if (!store.teamIndex) {
    const index = new Map<string, OwningTeam[]>();
    for (const r of db().all<{ kind: string; resource_id: string; id: string; name: string }>(
      `SELECT r.kind, r.resource_id, t.id, t.name FROM resource_teams r JOIN teams t ON t.id = r.team_id WHERE r.kind NOT IN (${[...PER_ROW_KINDS].map((k) => `'${k}'`).join(', ')}) ORDER BY t.name`,
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
 * The owning teams a new resource gets from its creator (#131, #136), and where that comes from:
 * - the creator chose one of their teams for their new resources (Profile): that team;
 * - otherwise the creator's teams that take new resources of members – a team set to "always", or set to "auto" (the
 *   default) once it owns something. A team that owns nothing does not use team scopes yet, so after an upgrade new
 *   resources stay the whole instance's. A team set to "never" is left out;
 * - administrators' new resources get no owning team unless they chose one.
 */
export function newResourceTeams(u: AuthUser | null): NewResourceTeams {
  const none: NewResourceTeams = { teams: [], source: { from: 'instance' }, choices: [], chosen: null };
  if (!u) return none;
  const rows = db().all<{ id: string; name: string; chosen: number; defaults: string | null }>(
    `SELECT t.id, t.name, m.new_resources AS chosen, s.defaults FROM team_members m JOIN teams t ON t.id = m.team_id
     LEFT JOIN team_settings s ON s.team_id = t.id WHERE m.user_id = ? ORDER BY t.name`,
    u.id,
  );
  const mode = (r: { defaults: string | null }): TeamNewResourceMode =>
    parseJson<{ newResources?: TeamNewResourceMode }>(r.defaults, {}).newResources ?? 'auto';
  const choices = rows.filter((r) => mode(r) !== 'never');
  const pick = (r: { id: string; name: string }) => ({ id: r.id, name: r.name });
  const chosen = choices.find((r) => r.chosen);
  const base = { choices: choices.map(pick), chosen: chosen?.id ?? null };
  if (chosen) return { ...base, teams: [pick(chosen)], source: { from: 'own' } };
  if (isAdmin(u) || !choices.length) return { ...none, ...base };
  const ids = choices.map((r) => r.id);
  const owning = new Set(
    db()
      .all<{ team_id: string }>(`SELECT DISTINCT team_id FROM resource_teams WHERE team_id IN (${ids.map(() => '?').join(', ')})`, ...ids)
      .map((r) => r.team_id),
  );
  const teams = choices.filter((r) => mode(r) === 'always' || owning.has(r.id)).map(pick);
  return { ...base, teams, source: teams.length ? { from: 'team' } : { from: 'instance' } };
}

/** The ids of the owning teams a new resource of `u` gets (see newResourceTeams). */
export function creatorTeams(u: AuthUser | null): string[] {
  return newResourceTeams(u).teams.map((t) => t.id);
}

/** The person's own choice of team for their new resources (#136); null: the teams' defaults again. */
export function chooseNewResourceTeam(u: AuthUser, teamId: string | null): NewResourceTeams {
  const now = newResourceTeams(u);
  if (teamId !== null && !now.choices.some((c) => c.id === teamId))
    throw new HttpError(400, 'Choose one of your teams that takes new resources', 'TEAM_NOT_CHOOSABLE');
  db().tx(() => {
    db().run('UPDATE team_members SET new_resources = 0 WHERE user_id = ?', u.id);
    if (teamId) db().run('UPDATE team_members SET new_resources = 1 WHERE user_id = ? AND team_id = ?', u.id, teamId);
  });
  return newResourceTeams(u);
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
    if (m) out.push({ team: t.name, roles: [...new Set([...policyRoles(u), ...m.roles])] });
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

/**
 * A module-only user (ADR 0034 part 1, 0.23.0): no core role that works in Steward – none in the instance but the status
 * viewer's role (which adds only the status pages) and the deprecated role "plant", none in a team – and a module role,
 * granted (to them, a team they are in, through single sign-on) or given by the deprecated role "plant". They reach
 * only those modules' routes, their profile and /api/v1/me: app.ts refuses every other route (PLANT_VIEWER_ONLY for
 * the plant registry's users, MODULE_ONLY_USER for others), the public API and MCP likewise.
 *
 * The cheap questions first: someone with a working core role costs no statement.
 */
export function moduleOnlyModules(u: AuthUser | null): ModuleId[] {
  if (!u || u.roles.some((r) => r !== 'status' && !DEPRECATED_ROLES.includes(r))) return [];
  if ([...memberships(u).values()].some((m) => m.roles.length > 0)) return [];
  const out = new Set<ModuleId>(modulesGrantingRoles(u));
  for (const id of modulesWithRoles()) if (moduleRoleFromCore(id, u.roles)) out.add(id);
  return [...out].sort();
}

export const moduleOnly = (u: AuthUser | null): boolean => moduleOnlyModules(u).length > 0;

/**
 * A status viewer (#26) whom nothing else lets in: the role "status" only, and no module role either – the former
 * "plant" and "status" pair is a module-only user who also reaches the status pages.
 */
export const statusOnly = (u: AuthUser | null): boolean => !!u && isStatusViewer(u.roles) && !moduleOnly(u);

/**
 * Whether a module-only user (`only`: their modules) may reach a route (app.ts): the routes of their modules, the
 * routes every plant viewer reaches (their profile, sign-in; for the plant registry's users all of /api/plant/…), and
 * the status pages when they have the status role.
 */
export function moduleOnlyReaches(
  only: readonly ModuleId[],
  url: string,
  access: { statusViewer: boolean; plantViewer: boolean },
  u: Pick<AuthUser, 'roles'>,
): boolean {
  if (access.statusViewer && u.roles.includes('status')) return true;
  if (access.plantViewer && (only.includes('plant') || !url.startsWith('/api/plant/'))) return true;
  const m = moduleOfRoute(url);
  return !!m && only.includes(accessModule(m));
}

/** The refusal of a route a module-only user may not reach: the plant registry keeps its code (#218). */
export const moduleOnlyRefusal = (only: readonly ModuleId[]): { error: string; code: string } =>
  only.includes('plant')
    ? { error: 'Plant viewers only see the plant registry', code: 'PLANT_VIEWER_ONLY' }
    : { error: 'You only use some modules of Steward – this is not one of them', code: 'MODULE_ONLY_USER' };

/**
 * A plant viewer (#218): since 0.23.0 a module-only user of the plant registry – a plant module role granted to them,
 * their team or through single sign-on (or the deprecated role "plant"), and no other working role. They see the
 * plant registry only: app.ts refuses every other route, the public API and the MCP endpoint answer only for the registry.
 */
export function plantOnly(u: AuthUser | null): boolean {
  return moduleOnlyModules(u).includes('plant');
}

/**
 * The module roles granted to `u` in module `id` as reasons (ADR 0034 part 4): each counts like an instance role – on
 * items of the whole instance (no owning team, no access list, not Restricted), and on items of an owning team they
 * are a member of. Its rights are the module's declaration for `kind`.
 */
function moduleRoleReasons(u: AuthUser, m: { id: ModuleId; kind: string }, all: readonly string[]): AccessReason[] {
  return grantedModuleRoles(u, m.id).map((r) => {
    const rights = new Set(moduleRoleRights(m.id, r.role, m.kind));
    return {
      source: 'moduleRole' as const,
      moduleRole: r.role,
      ...(r.source === 'team' ? { subject: `team:${r.team}` } : r.source === 'user' ? { subject: `user:${u.username.toLowerCase()}` } : {}),
      ...(r.source === 'sso' ? { sso: true } : {}),
      permissions: all.filter((p) => rights.has(p)),
    };
  });
}

interface Decision<P extends string> {
  permissions: P[];
  reasons: AccessReason[];
}

// ---------- shares (ADR 0033) ----------

/**
 * How a kind's rights follow from a share: the rights of each level (each includes the lower ones' – Manage is Edit
 * and changing shares) and of each action right the kind offers beside the level. A kind passes its model to decide()
 * once it is switched to shares; until then shares and Restricted do not count for it.
 */
export interface ShareModel<P extends string> {
  levels: Record<ShareLevel, readonly P[]>;
  actions?: Partial<Record<ShareAction, readonly P[]>>;
}

/** The reasons `u` has from the shares of a resource: one per share of one of their subjects that has not ended. */
export function shareReasons<P extends string>(u: AuthUser, r: { kind: OwnedKind; id: string }, model: ShareModel<P>): AccessReason[] {
  return sharesFor(u.id, subjectsOf(u), r.kind, r.id).map((s) => ({
    source: 'share' as const,
    subject: s.subject,
    level: s.level,
    ...(s.actions.length ? { actions: [...s.actions] } : {}),
    ...(s.expiresAt ? { expiresAt: s.expiresAt } : {}),
    // Custom (a migrated access-list entry no level expresses): exactly its rights
    permissions: s.rights?.length
      ? [...new Set(s.rights)]
      : [...new Set<string>([...model.levels[s.level], ...s.actions.flatMap((a) => model.actions?.[a] ?? [])])],
    ...(s.rights?.length ? { custom: true } : {}),
  }));
}

/** What someone holds on a resource in share terms: the highest level all of whose rights they have, and the action rights. */
export interface HeldShare {
  level: ShareLevel | null;
  actions: ShareAction[];
  /**
   * Changes the shares without holding the whole Manage level (0.23.0): a migrated _Custom_ entry with `manage` but
   * not `edit` – it changed the access list before; what it shares stays within `level` and `actions`
   */
  manages?: boolean;
}

/**
 * What `u` may give away by sharing (ADR 0033 part 5, "nobody shares more than they hold"): administrators everything
 * (`'all'`), anyone else the level and action rights their rights on the resource cover. Manage is what changes shares.
 */
export function heldShare<P extends string>(u: AuthUser | null, model: ShareModel<P>, permissions: readonly P[]): HeldShare | 'all' {
  if (isAdmin(u)) return 'all';
  const has = new Set<string>(permissions);
  const covers = (rights: readonly P[] | undefined) => !!rights?.length && rights.every((p) => has.has(p));
  const level = [...SHARE_LEVELS].reverse().find((l) => covers(model.levels[l])) ?? null;
  const actions = (Object.keys(model.actions ?? {}) as ShareAction[]).filter((a) => covers(model.actions?.[a]));
  return { level, actions };
}

/** Whether these rights include Manage (changing shares, decision 3: Edit may not re-share). */
export const managesShares = (held: HeldShare | 'all'): boolean => held === 'all' || held.level === 'manage' || !!held.manages;

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
  /**
   * instanceDefaults false (identities, ADR 0009): instance roles alone give nothing – only owning teams and the access
   * list. shares: the kind's share model (ADR 0033) – its shares add rights, and Restricted keeps instance roles out.
   * module: the kind belongs to a module that declares roles (ADR 0034) – its granted module roles count like instance
   * roles (`defaults` are then the module's `fromCoreRoles`, coreRoleDefaults)
   */
  opts: { instanceDefaults?: boolean; shares?: ShareModel<P>; module?: { id: ModuleId; kind: string } } = {},
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
    // Restricted (ADR 0033): only the shares, as a non-empty access list
    const restricted = !!opts.shares && isRestricted(r.kind, r.id);
    if (!r.acl.length && !restricted && opts.instanceDefaults !== false) {
      for (const role of u.roles) add({ source: 'instanceRole', role, permissions: [...(defaults[role] ?? [])] });
      if (opts.module) for (const reason of moduleRoleReasons(u, opts.module, all)) add(reason);
    }
  } else {
    // members of an owning team: their instance roles and their roles in that team
    const mine = memberships(u);
    let member = false;
    for (const t of teams) {
      const m = mine.get(t.id);
      if (!m) continue;
      member = true;
      for (const role of new Set([...u.roles, ...m.roles])) add({ source: 'teamRole', role, team: t.name, permissions: [...(defaults[role] ?? [])] });
    }
    // module roles are module-wide like instance roles: inside an owning team's item only for its members
    if (member && opts.module) for (const reason of moduleRoleReasons(u, opts.module, all)) add(reason);
  }
  // access list entries: the only rights on an unowned resource that has a list, an exception on an owned one
  for (const e of r.acl) if (matches(u, e.subject)) add({ source: 'accessList', subject: e.subject, permissions: [...e.permissions] });
  // shares (ADR 0033): an exception on an owned resource, the way in on a Restricted one
  if (opts.shares) for (const reason of shareReasons(u, r, opts.shares)) add(reason);
  const granted = new Set(reasons.flatMap((x) => x.permissions));
  return { permissions: all.filter((x) => granted.has(x)), reasons };
}

// ---------- the kinds whose access lists became shares (0.23.0, ADR 0033 phase 2) ----------

/**
 * The access lists of processes, platforms, identities, monitors and sites were migrated to shares one to one
 * (migrations/access.ts): their `acl` columns are no longer read – the `acl` the callers still pass is ignored – and
 * shares and the Restricted scope decide instead. A share's level and action rights give the kind's own rights below.
 */
export type Legacy = { acl?: unknown };

/** Process: View sees it and what follows it, Edit changes the definition, Manage also its shares, owner and archive. */
export const PROCESS_SHARE_MODEL: ShareModel<ProcessPermission> = {
  levels: { view: ['view'], edit: ['view', 'edit'], manage: ['view', 'edit', 'manage'] },
  actions: { run: ['view', 'run'], approve: ['view', 'approve'] },
};

/** Platform: View sees the page and its health, Manage changes it and its shares; `use` calls it (Edit is not offered yet). */
export const PLATFORM_SHARE_MODEL: ShareModel<PlatformPermission> = {
  levels: { view: ['view'], edit: ['view'], manage: ['view', 'use', 'manage'] },
  actions: { use: ['view', 'use'] },
};

/** A platform identity: its share is View with `use`; Manage is the platform's (who manages it changes the identities' shares). */
export const IDENTITY_SHARE_MODEL: ShareModel<'use' | 'manage'> = {
  levels: { view: [], edit: [], manage: ['manage'] },
  actions: { use: ['use'] },
};

/** Monitor: Manage includes acknowledging, as `manage` did. */
export const MONITOR_SHARE_MODEL: ShareModel<MonitorPermission> = {
  levels: { view: ['view'], edit: ['view', 'edit'], manage: ['view', 'edit', 'manage', 'acknowledge'] },
  actions: { acknowledge: ['view', 'acknowledge'] },
};

/**
 * Plant site: View sees it and what follows it, Manage changes it, its entries and its shares (one right, `manage`, as
 * before – Edit is not offered yet); `propose` beside.
 */
export const SITE_SHARE_MODEL: ShareModel<PlantPermission> = {
  levels: { view: ['view'], edit: ['view'], manage: ['view', 'propose', 'manage'] },
  actions: { propose: ['view', 'propose'] },
};

export function processAccess(u: AuthUser | null, p: { id: string; owner?: string | null } & Legacy): Decision<ProcessPermission> {
  const d = decide(u, { kind: 'process', id: p.id, owner: p.owner, acl: [] }, PROCESS_PERMISSIONS, DEFAULT_PROCESS, 'view', { shares: PROCESS_SHARE_MODEL });
  // any right on a process includes seeing it
  if (d.permissions.length && !d.permissions.includes('view')) d.permissions = PROCESS_PERMISSIONS.filter((x) => x === 'view' || d.permissions.includes(x));
  return d;
}

export function platformAccess(u: AuthUser | null, p: { id: string } & Legacy): Decision<PlatformPermission> {
  // auditors view every platform (0.23.0, decision 8): also a team's and a Restricted one
  const d = decide(u, { kind: 'platform', id: p.id, acl: [] }, PLATFORM_PERMISSIONS, DEFAULT_PLATFORM, 'view', { shares: PLATFORM_SHARE_MODEL });
  // manage includes use; any right includes seeing it
  const out = new Set(d.permissions);
  if (out.has('manage')) out.add('use');
  if (out.size) out.add('view');
  d.permissions = PLATFORM_PERMISSIONS.filter((x) => out.has(x));
  return d;
}

/** Who may use a platform identity that is not the default (ADR 0009): owning-team members with these roles, besides the access list. */
const DEFAULT_IDENTITY_USE: Record<Role, readonly 'use'[]> = {
  admin: ['use'],
  designer: ['use'],
  operator: ['use'],
  approver: [],
  auditor: [],
  viewer: [],
  status: [],
  plant: [],
};

/** What identityAccess needs to know of an identity. */
export interface IdentityForAccess extends Legacy {
  id: string;
  default: boolean;
}

/**
 * Whether `u` may use a platform identity (ADR 0009, 0.13.0), and why: `use` on the platform and – for an identity that
 * is not the default – `use` on the identity. The default identity is open to everyone with `use` on the platform. Any
 * other identity is closed by default: only administrators, members of its owning teams whose role gives `use`
 * (designer, operator) and its access list. Managing the platform does not make someone a user of its identities.
 */
export function identityAccess(u: AuthUser | null, p: { id: string } & Legacy, identity: IdentityForAccess): Decision<'use'> {
  const platform = platformAccess(u, p);
  const viaPlatform = platform.reasons.filter((r) => r.permissions.includes('use')).map((r) => ({ ...r, permissions: ['use'] }));
  if (!platform.permissions.includes('use')) return { permissions: [], reasons: [] };
  if (identity.default) return { permissions: ['use'], reasons: viaPlatform };
  const d = decide(u, { kind: 'platform_identity', id: identity.id, acl: [] }, ['use'] as const, DEFAULT_IDENTITY_USE, undefined, {
    instanceDefaults: false,
    shares: IDENTITY_SHARE_MODEL as ShareModel<'use'>,
  });
  return d.permissions.includes('use') ? { permissions: ['use'], reasons: [...viaPlatform, ...d.reasons] } : { permissions: [], reasons: [] };
}

/**
 * Whether `u` may see data read from a platform (dataset partitions, #142): from a platform of the whole instance
 * without an access list everyone who sees the dataset; otherwise members of its owning teams and whoever may use it.
 */
export function platformDataVisible(u: AuthUser | null, p: { id: string } & Legacy): boolean {
  if (!u) return false;
  const d = platformAccess(u, p);
  if (d.permissions.includes('use')) return true;
  const teams = owningTeams('platform', p.id);
  // (a Restricted platform: as one whose access list had entries)
  if (!teams.length) return !isRestricted('platform', p.id);
  const mine = memberships(u);
  return teams.some((t) => mine.has(t.id));
}

// ---------- data contracts (#221) ----------

/**
 * The rights on a data contract as deciding knows them (0.23.0): `relax` switches off "breaking changes need a change
 * record" (decision 12, the former `manage`), `share` changes its shares – Manage (decision 13: designers among the
 * members, all designers while it has no owning teams). The public `permissions` name `relax` also `manage` (its
 * former name, for one release) and leave `share` out.
 */
export type ContractRight = 'view' | 'test' | 'edit' | 'relax' | 'share';
const CONTRACT_RIGHTS: readonly ContractRight[] = ['view', 'test', 'edit', 'relax', 'share'];

/** What each role may do with a data contract: see it, run its tests, change it (new versions, links, settings). */
export const DEFAULT_CONTRACT: Record<Role, readonly ContractRight[]> = {
  admin: CONTRACT_RIGHTS,
  designer: ['view', 'test', 'edit', 'share'],
  operator: ['view', 'test'],
  // approvers approve changes: they may also switch off the rule that breaking changes need a change record (0.9.0)
  approver: ['view', 'relax'],
  auditor: ['view'],
  viewer: ['view'],
  status: [],
  plant: [],
};

/** How a share gives rights on a data contract: View, Edit (new versions, links), Manage (its shares); test and relax beside. */
export const CONTRACT_SHARE_MODEL: ShareModel<ContractRight> = {
  levels: { view: ['view'], edit: ['view', 'edit'], manage: ['view', 'edit', 'share'] },
  actions: { test: ['view', 'test'], relax: ['view', 'relax'] },
};

/** The rights on a data contract as deciding knows them (shares, Restricted), with `share` (the Access tab). */
export function contractRights(u: AuthUser | null, c: { id: string }): Decision<ContractRight> {
  const d = decide(u, { kind: 'contract', id: c.id, acl: [] }, CONTRACT_RIGHTS, DEFAULT_CONTRACT, 'view', { shares: CONTRACT_SHARE_MODEL });
  // any right on a contract includes seeing it
  if (d.permissions.length && !d.permissions.includes('view')) d.permissions = CONTRACT_RIGHTS.filter((x) => x === 'view' || d.permissions.includes(x));
  return d;
}

/**
 * The rights on a data contract (#221): without owning teams every role that works in Steward sees it, operators run
 * its tests, designers change it, approvers and administrators may switch off "breaking changes need a change record"
 * (manage); with owning teams only their members do (with their instance and team roles), auditors see it,
 * administrators may do everything. Contracts have no access list.
 */
export function contractAccess(u: AuthUser | null, c: { id: string }): Decision<DataContractPermission> {
  const d = contractRights(u, c);
  const has = new Set<string>(d.permissions);
  // relax under its former name as well (deprecated, one release)
  if (has.has('relax')) has.add('manage');
  return { permissions: DATA_CONTRACT_PERMISSIONS.filter((x) => has.has(x)), reasons: d.reasons };
}

// ---------- the service catalogue: services, applications, systems ----------

export type CatalogueKind = 'service' | 'application' | 'system' | 'supplier';
/** Who may change the catalogue by instance role (as before team scopes). */
const CATALOGUE_EDITORS: readonly Role[] = ['admin', 'designer'];

/**
 * The teams a catalogue item belongs to: its own, or – for an application without its own – those of the services
 * it is part of (an application in services of two teams belongs to both; one that is also part of a service of the
 * whole instance belongs to the whole instance).
 */
/** The services of each application while withServiceLinks runs (null: read per application). */
let serviceLinks: Map<string, string[]> | null = null;

/**
 * Runs `fn` (synchronous) with every link between services and applications read once: lists that decide the access
 * to many applications (costs, scorecards) would otherwise read the links of each one (security review 0.19.0 H2).
 */
export function withServiceLinks<T>(fn: () => T): T {
  if (serviceLinks) return fn();
  const links = new Map<string, string[]>();
  for (const r of db().all<{ service_id: string; application_id: string }>('SELECT service_id, application_id FROM service_applications'))
    links.set(r.application_id, [...(links.get(r.application_id) ?? []), r.service_id]);
  serviceLinks = links;
  try {
    const out = fn();
    if (out instanceof Promise) throw new Error('withServiceLinks needs a synchronous function');
    return out;
  } finally {
    serviceLinks = null;
  }
}

export function catalogueTeams(kind: CatalogueKind, id: string): OwningTeam[] {
  const own = owningTeams(kind, id);
  if (own.length || kind !== 'application') return own;
  const byId = new Map<string, OwningTeam>();
  const services =
    serviceLinks?.get(id) ??
    (serviceLinks
      ? []
      : db()
          .all<{ service_id: string }>('SELECT service_id FROM service_applications WHERE application_id = ?', id)
          .map((r) => r.service_id));
  for (const serviceId of services) {
    const teams = owningTeams('service', serviceId);
    // also part of a service of the whole instance: the application is the whole instance's as well
    if (!teams.length) return [];
    for (const t of teams) byId.set(t.id, t);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface CatalogueDecision {
  view: boolean;
  edit: boolean;
  /** Changing its shares and naming owners from outside its owning teams (ADR 0033 decision 3) */
  manage: boolean;
  reasons: AccessReason[];
}

/** The catalogue kinds switched to shares (ADR 0033 phase 1): their shares and the Restricted scope count. */
export const SHARED_CATALOGUE_KINDS: ReadonlySet<CatalogueKind> = new Set<CatalogueKind>(['service', 'application', 'system', 'supplier']);

/** How a share gives rights on a catalogue item: View sees it and its children, Edit changes them, Manage also its shares. */
export const CATALOGUE_SHARE_MODEL: ShareModel<'view' | 'edit' | 'manage'> = {
  levels: { view: ['view'], edit: ['view', 'edit'], manage: ['view', 'edit', 'manage'] },
};

/**
 * Seeing, changing and managing a catalogue item. Without owning teams: everybody signed in sees it, designers and
 * administrators change and manage it, its named owners change it (as before). With owning teams: members of those
 * teams see it and change and manage it when they are designers there; auditors see it. Administrators may do
 * everything.
 *
 * For the kinds switched to shares (ADR 0033, `SHARED_CATALOGUE_KINDS`):
 * - **Shares** add a level – View, Edit or Manage – for a user, a team or a role.
 * - An **owner** has an implied Edit share (reason `implied`, computed from the owner field, never stored): who may
 *   edit by role keeps Manage by role, an owner named from outside the owning teams can no longer name further
 *   outsiders (decision 3).
 * - **Restricted** (an item without owning teams that an administrator restricted): instance roles give nothing –
 *   only its shares, its owners, administrators and auditors reach it.
 * - An application without owning teams of its own belongs to those of its services (catalogueTeams); shares and the
 *   scope of a service do **not** flow to its applications – each item has its own.
 *
 * The plant role's "see" only names the systems and applications that sites and assets link to (without a way to
 * them): a plant viewer reaches no route of the catalogue (app.ts, plantOnly).
 */
export function catalogueAccess(u: AuthUser | null, r: { kind: CatalogueKind; id: string; owners: string[] }): CatalogueDecision {
  if (!u) return { view: false, edit: false, manage: false, reasons: [] };
  const shared = SHARED_CATALOGUE_KINDS.has(r.kind);
  // who may edit by role manages by role (decision 3); kinds not switched to shares say only view and edit, as before
  const editor = shared ? ['view', 'edit', 'manage'] : ['view', 'edit'];
  if (isAdmin(u)) return { view: true, edit: true, manage: true, reasons: [{ source: 'admin', role: 'admin', permissions: editor }] };
  const reasons: AccessReason[] = [];
  const byRole = (role: Role): string[] => (CATALOGUE_EDITORS.includes(role) ? editor : ['view']);
  // a named owner (#195: "Why do I have access?" says so; adding one from outside the owning teams is a confirmed grant)
  const owner = r.owners.find((s) => matches(u, s));
  if (owner)
    reasons.push(
      shared
        ? { source: 'implied', as: 'owner', subject: owner, level: 'edit', permissions: ['view', 'edit'] }
        : { source: 'named', as: 'owner', subject: owner, permissions: ['view', 'edit'] },
    );
  const teams = catalogueTeams(r.kind, r.id);
  if (!teams.length) {
    // Restricted (ADR 0033): instance roles give nothing, auditors still see it
    if (shared && isRestricted(r.kind, r.id)) {
      if (u.roles.includes('auditor')) reasons.push({ source: 'auditor', role: 'auditor', permissions: ['view'] });
    } else for (const role of policyRoles(u)) reasons.push({ source: 'instanceRole', role, permissions: byRole(role) });
  } else {
    if (u.roles.includes('auditor')) reasons.push({ source: 'auditor', role: 'auditor', permissions: ['view'] });
    const mine = memberships(u);
    for (const t of teams) {
      const m = mine.get(t.id);
      if (!m) continue;
      for (const role of new Set([...policyRoles(u), ...m.roles])) reasons.push({ source: 'teamRole', role, team: t.name, permissions: byRole(role) });
    }
  }
  if (shared) reasons.push(...shareReasons(u, r, CATALOGUE_SHARE_MODEL));
  const granted = new Set(reasons.flatMap((x) => x.permissions));
  // before shares, whoever changed an item named its owners: editors keep that on kinds not switched yet
  return { view: granted.has('view'), edit: granted.has('edit'), manage: shared ? granted.has('manage') : granted.has('edit'), reasons };
}

// ---------- records and living documents ----------

/** Create and edit records, run the non-approval transitions (as records/access.ts). */
const RECORD_EDITORS: readonly Role[] = ['admin', 'designer', 'operator'];
const RECORD_APPROVERS: readonly Role[] = ['admin', 'approver'];

export interface RecordDecision {
  view: boolean;
  edit: boolean;
  approve: boolean;
  /** Changing its shares and naming an owner from outside its owning teams (0.23.0, ADR 0033 decision 3) */
  manage: boolean;
  reasons: AccessReason[];
}

/**
 * How a share gives rights on a record, a credential, a ticket reference or a dashboard (0.23.0, ADR 0033 phase 2):
 * View sees it, Edit changes it, Manage also changes its shares.
 */
export const ITEM_SHARE_MODEL: ShareModel<'view' | 'edit' | 'manage'> = {
  levels: { view: ['view'], edit: ['view', 'edit'], manage: ['view', 'edit', 'manage'] },
};
/** Who manages a record by role (who named outside owners before shares): designers – in its owning teams, when it has some. */
const RECORD_MANAGERS: readonly Role[] = ['admin', 'designer'];

/**
 * Seeing, changing and approving a record (#131). Without owning teams: everybody signed in sees it, editors by role
 * and its owner change it, approvers approve (as before). With owning teams: members of those teams with their
 * instance and team roles, its owner (sees and changes it), administrators (everything) and auditors (see).
 * Document editions, reviews, attachments and links follow their record.
 */
export function recordAccess(u: AuthUser | null, r: { id: string; owner: string }): RecordDecision {
  if (!u) return { view: false, edit: false, approve: false, manage: false, reasons: [] };
  const all = ['view', 'edit', 'approve', 'manage'];
  if (isAdmin(u)) return { view: true, edit: true, approve: true, manage: true, reasons: [{ source: 'admin', role: 'admin', permissions: all }] };
  const reasons: AccessReason[] = [];
  const rights = (roles: readonly Role[]) => [
    'view',
    ...(roles.some((x) => RECORD_EDITORS.includes(x)) ? ['edit'] : []),
    ...(roles.some((x) => RECORD_APPROVERS.includes(x)) ? ['approve'] : []),
    ...(roles.some((x) => RECORD_MANAGERS.includes(x)) ? ['manage'] : []),
  ];
  // the plant role (#218) gives nothing on records and documents: plant viewers see the plant registry only
  const working = (roles: readonly Role[]) => roles.filter((x) => x !== 'plant');
  // its owner: an implied Edit share (0.23.0, ADR 0033 part 2)
  if (r.owner && r.owner.toLowerCase() === u.username.toLowerCase())
    reasons.push({ source: 'implied', as: 'owner', subject: `user:${r.owner.toLowerCase()}`, level: 'edit', permissions: ['view', 'edit'] });
  const teams = owningTeams('record', r.id);
  if (!teams.length) {
    // Restricted (0.23.0): instance roles give nothing, auditors still see it
    if (isRestricted('record', r.id)) {
      if (u.roles.includes('auditor')) reasons.push({ source: 'auditor', role: 'auditor', permissions: ['view'] });
    } else for (const role of working(u.roles)) reasons.push({ source: 'instanceRole', role, permissions: rights([role]) });
  } else {
    if (u.roles.includes('auditor')) reasons.push({ source: 'auditor', role: 'auditor', permissions: ['view'] });
    for (const m of teamRoles(u, teams))
      for (const role of working(m.roles)) reasons.push({ source: 'teamRole', role, team: m.team, permissions: rights([role]) });
  }
  reasons.push(...shareReasons(u, { kind: 'record', id: r.id }, ITEM_SHARE_MODEL));
  const granted = new Set(reasons.flatMap((x) => x.permissions));
  return { view: granted.has('view'), edit: granted.has('edit'), approve: granted.has('approve'), manage: granted.has('manage'), reasons };
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
    /** `as`: a named owner or responsible (#195) – the subject that matched; without it the item's own owner */
    personal?: { permissions: readonly P[]; subject?: string; as?: 'owner' | 'responsible'; level?: ShareLevel } | null;
    auditor?: readonly P[];
    unscoped: () => P[];
    /** The kind's share model (0.23.0, ADR 0033): its shares add rights, and Restricted keeps instance roles out */
    shares?: ShareModel<P>;
    /** The rights each instance role has without owning teams, for the reasons (default: byRole) */
    instanceByRole?: (role: Role) => readonly P[];
  },
): Decision<P> {
  if (!u) return { permissions: [], reasons: [] };
  if (isAdmin(u)) return { permissions: [...o.all], reasons: [{ source: 'admin', role: 'admin', permissions: [...o.all] }] };
  const reasons: AccessReason[] = [];
  const add = (reason: AccessReason) => reason.permissions.length && reasons.push(reason);
  if (o.personal)
    add({
      // an implied share (0.23.0, ADR 0033 part 2): the level its owner field gives
      source: o.personal.level ? 'implied' : o.personal.as ? 'named' : 'owner',
      ...(o.personal.level ? { level: o.personal.level } : {}),
      ...(o.personal.as ? { as: o.personal.as } : {}),
      ...(o.personal.subject ? { subject: o.personal.subject } : {}),
      permissions: [...o.personal.permissions],
    });
  const teams = owningTeams(r.kind, r.id);
  const shared = () => (o.shares ? shareReasons(u, r, o.shares) : []);
  if (!teams.length) {
    // Restricted (ADR 0033): instance roles give nothing – its owners, auditors and shares only
    if (o.shares && isRestricted(r.kind, r.id)) {
      if (o.auditor && u.roles.includes('auditor')) add({ source: 'auditor', role: 'auditor', permissions: [...o.auditor] });
      for (const x of shared()) add(x);
      const granted = new Set(reasons.flatMap((x) => x.permissions));
      return { permissions: o.all.filter((x) => granted.has(x)), reasons };
    }
    for (const role of policyRoles(u)) add({ source: 'instanceRole', role, permissions: [...(o.instanceByRole ?? o.byRole)(role)] });
    const extra = shared();
    for (const x of extra) add(x);
    if (!extra.length) return { permissions: o.unscoped(), reasons };
    const granted = new Set<string>([...o.unscoped(), ...extra.flatMap((x) => x.permissions)]);
    return { permissions: o.all.filter((x) => granted.has(x)), reasons };
  }
  if (o.auditor && u.roles.includes('auditor')) add({ source: 'auditor', role: 'auditor', permissions: [...o.auditor] });
  for (const m of teamRoles(u, teams)) for (const role of m.roles) add({ source: 'teamRole', role, team: m.team, permissions: [...o.byRole(role)] });
  for (const x of shared()) add(x);
  const granted = new Set(reasons.flatMap((x) => x.permissions));
  return { permissions: o.all.filter((x) => granted.has(x)), reasons };
}
