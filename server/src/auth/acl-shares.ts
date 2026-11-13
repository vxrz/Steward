import {
  MONITOR_PERMISSIONS,
  PLANT_PERMISSIONS,
  PLATFORM_PERMISSIONS,
  PROCESS_PERMISSIONS,
  type AclEntry,
  type OwnedKind,
  type ResourceShare,
  type Role,
  type ShareAction,
  type ShareLevel,
} from '@sm/shared';
import type { FastifyReply } from 'fastify';
import { config } from '../config.js';
import { db } from '../db.js';
import { HttpError } from '../util.js';
import { currentStore } from './context.js';
import { DEFAULT_PLATFORM, DEFAULT_PROCESS, cleanAcl } from './permissions.js';
import { gainedRights } from './access-change.js';
import { MONITOR_DEFAULTS } from '../monitors/model.js';
import { DEFAULT_PLANT } from '../plant/access.js';
import {
  IDENTITY_SHARE_MODEL,
  MONITOR_SHARE_MODEL,
  PLATFORM_SHARE_MODEL,
  PROCESS_SHARE_MODEL,
  SITE_SHARE_MODEL,
  managesShares,
  type HeldShare,
  type ShareModel,
} from './policy.js';
import { isRestricted, sharesOf, shareActive, toShare, type ShareRow } from './share-store.js';
import { setRestricted, setShares, type ShareWrite } from './shares.js';

/**
 * The access lists of processes, platforms, platform identities, monitors and plant sites, migrated to shares
 * (0.23.0, ADR 0033 phase 2, #297; migrations/access.ts). Their routes `PUT …/access` stay for one release as
 * **deprecated aliases** (`Deprecation` header): they keep their bodies, write shares and the Restricted scope, and
 * their responses keep `acl`, computed from the shares.
 *
 * - An entry becomes one share with exactly its rights (`aclToShares`, the same rule as the migration); an entry no
 *   level and action rights express is _Custom_ (its exact rights).
 * - A non-empty list makes the item Restricted, an empty one opens it again – what the list meant (identities stay
 *   closed by default and are never Restricted).
 * - Writing goes through the shares core: Manage, never more than the author holds, the step-up when anyone gains a
 *   right, the `access.share_*` / `access.scope_changed` audit.
 */

export type AclKind = 'process' | 'platform' | 'platform_identity' | 'monitor' | 'site';
export const ACL_KINDS: readonly AclKind[] = ['process', 'platform', 'platform_identity', 'monitor', 'site'];

/** The kinds' own rights and how a share gives them (auth/policy.ts). */
const KIND: Record<AclKind, { perms: readonly string[]; model: ShareModel<string> }> = {
  process: { perms: PROCESS_PERMISSIONS, model: PROCESS_SHARE_MODEL },
  platform: { perms: PLATFORM_PERMISSIONS, model: PLATFORM_SHARE_MODEL },
  platform_identity: { perms: ['use'], model: IDENTITY_SHARE_MODEL },
  monitor: { perms: MONITOR_PERMISSIONS, model: MONITOR_SHARE_MODEL },
  site: { perms: PLANT_PERMISSIONS, model: SITE_SHARE_MODEL },
};

/** The terms of one share. */
export interface ShareTerms {
  level: ShareLevel;
  actions: ShareAction[];
  /** Custom: the exact rights, when no level and action rights express them */
  rights: string[] | null;
}

/**
 * The share an access-list entry becomes (null: an entry without rights, dropped) – the rule of the migration
 * (migrations/access.ts), kept in step by acl-shares-migration.test.ts.
 */
export function entryToShare(kind: AclKind, permissions: readonly string[]): ShareTerms | null {
  const known = new Set(permissions.filter((p) => KIND[kind].perms.includes(p)));
  if (!known.size) return null;
  const has = (p: string) => known.has(p);
  switch (kind) {
    case 'process': {
      const actions = (['approve', 'run'] as const).filter(has);
      if (has('manage') && !has('edit')) return { level: 'view', actions: [...actions], rights: [...new Set(['view', 'manage', ...actions])].sort() };
      return { level: has('manage') ? 'manage' : has('edit') ? 'edit' : 'view', actions: [...actions], rights: null };
    }
    case 'monitor':
      return {
        level: has('manage') ? 'manage' : has('edit') ? 'edit' : 'view',
        actions: has('acknowledge') || has('manage') ? ['acknowledge'] : [],
        rights: null,
      };
    case 'site':
      return { level: has('manage') ? 'manage' : 'view', actions: has('propose') || has('manage') ? ['propose'] : [], rights: null };
    case 'platform':
      return { level: has('manage') ? 'manage' : 'view', actions: ['use'], rights: null };
    case 'platform_identity':
      return { level: 'view', actions: ['use'], rights: null };
  }
}

/**
 * An access list as shares: one per subject (several entries of one subject add up), entries without rights and
 * `role:admin` entries dropped.
 */
export function aclToShares(kind: AclKind, acl: readonly AclEntry[]): ShareWrite[] {
  const bySubject = new Map<string, Set<string>>();
  for (const e of acl) {
    const subject = String(e.subject ?? '')
      .trim()
      .toLowerCase();
    const set = bySubject.get(subject) ?? new Set<string>();
    for (const p of e.permissions ?? []) set.add(String(p));
    bySubject.set(subject, set);
  }
  const out: ShareWrite[] = [];
  for (const [subject, perms] of bySubject) {
    // administrators have every right anyway (and a share cannot name them)
    if (subject === 'role:admin') continue;
    const t = entryToShare(kind, [...perms]);
    if (t) out.push({ subject, level: t.level, actions: t.actions, expiresAt: null, rights: t.rights });
  }
  return out.sort((a, b) => a.subject.localeCompare(b.subject));
}

/** The rights a share gives in the kind's own terms (the `permissions` of an access-list entry). */
export function shareRights(kind: AclKind, s: Pick<ResourceShare, 'level' | 'actions' | 'rights'>): string[] {
  const k = KIND[kind];
  if (s.rights?.length) return k.perms.filter((p) => s.rights!.includes(p));
  const given = new Set<string>([...k.model.levels[s.level], ...s.actions.flatMap((a) => k.model.actions?.[a] ?? [])]);
  return k.perms.filter((p) => given.has(p));
}

/** Shares as the access list the deprecated routes answer (active shares; end dates are not shown there). */
export function sharesToAcl<P extends string = string>(kind: AclKind, shares: readonly ResourceShare[]): AclEntry<P>[] {
  return shares
    .filter((s) => shareActive(s))
    .map((s) => ({ subject: s.subject, permissions: shareRights(kind, s) as P[] }))
    .filter((e) => e.permissions.length);
}

/**
 * The `acl` of an item as the deprecated field of its responses (computed from its shares). Lists read every share of
 * the kind once per request (one statement), not one per item.
 */
export function aclOf<P extends string = string>(kind: AclKind, id: string): AclEntry<P>[] {
  const store = currentStore();
  if (!store) return sharesToAcl<P>(kind, sharesOf(kind, id));
  const key = `acl-shares:${kind}`;
  const cache = (store as unknown as Record<string, Map<string, ResourceShare[]> | undefined>)[key];
  let all = cache;
  if (!all) {
    all = new Map();
    for (const r of db().all<ShareRow>(
      'SELECT kind, resource_id, subject, level, actions, expires_at, rights, created_by, created_at FROM resource_shares WHERE kind = ? ORDER BY subject',
      kind,
    )) {
      const l = all.get(r.resource_id) ?? [];
      l.push(toShare(r));
      all.set(r.resource_id, l);
    }
    (store as unknown as Record<string, unknown>)[key] = all;
  }
  return sharesToAcl<P>(kind, all.get(id) ?? []);
}

/** Forget the access lists read in this request (after a change). */
export function aclChanged(kind: AclKind): void {
  const store = currentStore() as unknown as Record<string, unknown> | undefined;
  if (store) delete store[`acl-shares:${kind}`];
}

// ---------- the deprecated routes ----------

/** What a deprecated route's body asks for: the shares and the scope (a non-empty list restricts; identities never). */
export function aliasTarget(kind: AclKind, aclInput: unknown): { shares: ShareWrite[]; restricted: boolean | undefined } {
  const acl = cleanAcl(aclInput, KIND[kind].perms);
  // (a site's entries without rights were dropped before they counted, as setSiteAccess did)
  const listed = kind === 'site' ? acl.filter((e) => e.permissions.length) : acl;
  return { shares: aclToShares(kind, acl), restricted: kind === 'platform_identity' ? undefined : listed.length > 0 };
}

/** The rights each role has on an item of the kind while it is not Restricted (identities: none, ADR 0009). */
const ROLE_DEFAULTS: Record<AclKind, Partial<Record<Role, readonly string[]>>> = {
  process: DEFAULT_PROCESS,
  platform: DEFAULT_PLATFORM,
  platform_identity: {},
  monitor: MONITOR_DEFAULTS,
  site: DEFAULT_PLANT,
};
/** The rights a right includes on each kind (as the kinds' access functions close them). */
const closeRights = (kind: AclKind, rights: Iterable<string>): string[] => {
  const out = new Set(rights);
  if (kind === 'platform' && out.has('manage')) out.add('use');
  if (kind === 'monitor' && out.has('manage')) ['edit', 'acknowledge'].forEach((x) => out.add(x));
  if (kind === 'site' && out.has('manage')) ['view', 'propose'].forEach((x) => out.add(x));
  if (out.size && kind !== 'platform_identity') out.add('view');
  return KIND[kind].perms.filter((p) => out.has(p));
};

/**
 * Who holds which rights on an item, by subject, as an access list decided them (the step-up rules of 0.22): the role
 * defaults while it is not Restricted, the shares, auditors' view (processes, monitors, sites), the owner's every right.
 * Administrators are left out (they hold everything). Owning teams are left out as they were: a list on an owned item
 * was compared the same way.
 */
function effectiveGrants(kind: AclKind, st: { restricted: boolean; shares: readonly ResourceShare[] }, owner?: string | null): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (subject: string, rights: Iterable<string>) => {
    if (subject === 'role:admin') return;
    const set = out.get(subject) ?? new Set<string>();
    for (const r of closeRights(kind, rights)) set.add(r);
    if (set.size) out.set(subject, set);
  };
  if (!st.restricted) for (const [role, rights] of Object.entries(ROLE_DEFAULTS[kind])) add(`role:${role}`, rights ?? []);
  for (const sh of st.shares) if (shareActive(sh)) add(sh.subject, shareRights(kind, sh));
  if (kind === 'process' || kind === 'monitor' || kind === 'site') add('role:auditor', ['view']);
  if (owner?.trim()) add(`user:${owner.trim().toLowerCase()}`, KIND[kind].perms);
  return out;
}

/** The state a deprecated route's body asks for: its shares (as stored) and its scope. */
function aliasState(kind: AclKind, id: string, aclInput: unknown): { restricted: boolean; shares: ResourceShare[] } {
  const t = aliasTarget(kind, aclInput);
  return {
    restricted: t.restricted ?? isRestricted(kind, id),
    shares: t.shares.map((s) => ({
      subject: s.subject,
      level: s.level,
      actions: [...(s.actions ?? [])],
      expiresAt: null,
      rights: s.rights ? [...s.rights] : null,
      createdBy: '',
      createdAt: '',
    })),
  };
}

/**
 * Whether a deprecated route's body gives anyone a right (its step-up rule, and again before writing): compared as the
 * access list was – a new subject with a right, a raised right, an emptied list on a Restricted item (the role defaults
 * come back), a new owner. A list that only keeps or narrows what the role defaults gave does not ask. Throws on a
 * body the route refuses. `owner`: the owner before and after (processes, monitors).
 */
export function aliasWidens(kind: AclKind, id: string, aclInput: unknown, owner?: { before: string | null; after: string | null }): boolean {
  const before = { restricted: isRestricted(kind, id), shares: sharesOf(kind, id) };
  const after = aclInput === undefined ? before : aliasState(kind, id, aclInput);
  return gainedRights(effectiveGrants(kind, before, owner?.before), effectiveGrants(kind, after, owner?.after)).length > 0;
}

/**
 * Writes what a deprecated route's body asks for (in one transaction): the shares through the shares core, and the
 * scope – Restricted first when it narrows, opened last when it widens. `held`: what the author holds (`heldOn`).
 */
export function writeAlias(c: { kind: AliasKind; id: string; aclInput: unknown; held: HeldShare | 'all'; label: string }): void {
  if (!managesShares(c.held)) throw new HttpError(403, 'Only who manages this item may change its access', 'FORBIDDEN', { context: 'right_manage' });
  const t = aliasTarget(c.kind, c.aclInput);
  // the widening is decided as the access list decided it (the role defaults an emptied list gives back count)
  const widens = aliasWidens(c.kind, c.id, c.aclInput);
  db().tx(() => {
    if (t.restricted === true) setRestricted({ kind: c.kind, id: c.id, restricted: true, held: c.held, label: c.label });
    setShares({ kind: c.kind, id: c.id, held: c.held, shares: t.shares, label: c.label, widens });
    if (t.restricted === false) setRestricted({ kind: c.kind, id: c.id, restricted: false, held: c.held, label: c.label, widens });
  });
  aclChanged(c.kind);
}
type AliasKind = AclKind & OwnedKind;

/** Marks the answer of a deprecated access-list route: `Deprecation`, and the Access tab's route as its successor. */
export function markDeprecated(reply: FastifyReply, kind: AliasKind, id: string): void {
  reply.header('Deprecation', 'true').header('Link', `<${config.basePath}/api/access/${kind}/${encodeURIComponent(id)}/shares>; rel="successor-version"`);
}
