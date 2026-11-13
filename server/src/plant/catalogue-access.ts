import {
  PLANT_CATALOGUE_PERMISSIONS,
  PLANT_HIDDEN,
  PLANT_HIDDEN_REF_RE,
  plantHiddenRef,
  type AccessReason,
  type PlantCatalogueKind,
  type PlantCataloguePermission,
  type PlantHiddenCatalogue,
  type PlantAssignmentValues,
  type PlantKpiValues,
  type PlantProfileValues,
  type PlantResolvedProfile,
  type Role,
  coreRoleDefaults,
} from '@sm/shared';
import { db } from '../db.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { decide, memberships, owningTeams, type ShareModel } from '../auth/policy.js';
import { isRestricted } from '../auth/share-store.js';
import { moduleRole, usesModule } from '../modules/access.js';
import { HttpError } from '../util.js';
import { canManageCatalogue, plantProposesSome, proposing } from './access.js';
import { kpiProfiles } from './checks.js';
import { resolvedProfile } from './data-model.js';

/**
 * Device profiles and KPI definitions with owning teams and shares (0.21.0, #293; ADR 0033 parts 3 and 4).
 *
 * - **Rights** on one entry, through the one policy module (auth/policy.ts): `view`, `propose`, `edit` (change the
 *   entry) and `manage` (Edit, and its shares and deleting it). An entry **without owning teams and not Restricted**
 *   behaves exactly as before 0.21.0: everyone who sees the plant registry sees it, whoever may add sites (designers,
 *   administrators) manages it, whoever proposes on some site proposes – plus its shares. With owning teams their
 *   members have their instance and team roles on it (designers manage it, decision 13), auditors see it; Restricted:
 *   only its shares. Someone who does not use the plant registry (ADR 0034) has no right on it.
 * - **Visibility is read once per request** (`catalogueScope`): owning teams, Restricted entries and the reader's shares
 *   come from the request's indexes, so deciding thousands of rows costs a lookup each, never a query.
 * - **Hidden, not named** (part 4, decision 10): what follows an asset (its model, checks, KPI coverage, data flow,
 *   lineage) is computed on the whole catalogue as before; where a result would name an entry the reader may not see,
 *   its id becomes a placeholder (`HiddenRefs`, `~hidden-<n>`) and its name `~hidden` (`presentProfiles`,
 *   `presentKpis`). A placeholder sent back keeps the entry it stands for; choosing a hidden entry anew is refused like
 *   an unknown one.
 */

const ALL = PLANT_CATALOGUE_PERMISSIONS;

/**
 * What each role gives on an entry of an owning team (as a member) or – without the legacy rules – of the instance:
 * the plant module's role defaults since 0.23.0 (ADR 0034 part 5; designers manage it, decision 13). Device profiles
 * and KPI definitions give the same.
 */
export const DEFAULT_PLANT_CATALOGUE: Record<Role, readonly PlantCataloguePermission[]> = coreRoleDefaults('plant', 'device_profile', ALL);

/** How a share's level and action rights give rights on an entry (ADR 0033 part 1: View, Edit, Manage; propose beside them). */
export const PLANT_CATALOGUE_SHARES: ShareModel<PlantCataloguePermission> = {
  levels: { view: ['view'], edit: ['view', 'propose', 'edit'], manage: ALL },
  actions: { propose: ['propose'] },
};

export interface CatalogueDecision {
  permissions: PlantCataloguePermission[];
  reasons: AccessReason[];
}

/** Rights that include others: Manage includes Edit, Edit includes proposing, every right includes seeing it. */
function normalise(given: Iterable<string>): PlantCataloguePermission[] {
  const p = new Set(given);
  if (p.has('manage')) p.add('edit');
  if (p.has('edit')) p.add('propose');
  if (p.size) p.add('view');
  // a proposer's dry run (change sets): they may do what they propose, in a transaction that is rolled back (plant/access.ts)
  if (proposing() && p.has('propose')) for (const x of ALL) p.add(x);
  return ALL.filter((x) => p.has(x));
}

/** Who reaches the plant registry at all by a role (status viewers alone do not) – or by a plant module role (ADR 0034). */
const worksInSteward = (u: AuthUser): boolean =>
  u.roles.some((r) => r !== 'status') || [...memberships(u).values()].some((m) => m.roles.length > 0) || moduleRole('plant', u) !== null;

/** The rights of the rules before 0.21.0 (entries without owning teams and not Restricted); read once per scope. */
interface Legacy {
  propose: () => boolean;
  manage: () => boolean;
}
function legacyOf(u: AuthUser): Legacy {
  let propose: boolean | undefined;
  let manage: boolean | undefined;
  return {
    propose: () => (propose ??= plantProposesSome(u)),
    manage: () => (manage ??= canManageCatalogue(u)),
  };
}

/** Whether an entry is the whole instance's and not Restricted: the rules before 0.21.0 apply (and its shares add). */
const openEntry = (kind: PlantCatalogueKind, id: string): boolean => !owningTeams(kind, id).length && !isRestricted(kind, id);

/**
 * The rights of `u` on one device profile or KPI definition, and why. `legacy`: the rules before 0.21.0, read once per
 * request by catalogueScope (a single question reads them itself).
 */
export function catalogueEntryAccess(u: AuthUser | null, kind: PlantCatalogueKind, id: string, legacy?: Legacy): CatalogueDecision {
  if (!u || !usesModule(u, 'plant')) return { permissions: [], reasons: [] };
  const d = decide(u, { kind, id, acl: [] }, ALL, DEFAULT_PLANT_CATALOGUE, 'view', { shares: PLANT_CATALOGUE_SHARES, module: { id: 'plant', kind } });
  if (!openEntry(kind, id) || d.reasons.some((r) => r.source === 'admin')) return { permissions: normalise(d.permissions), reasons: d.reasons };
  // the whole instance's entry: exactly as before – every reader of the registry sees it, who may add sites manages it,
  // who proposes on some site proposes; its shares add (decide() gave their reasons)
  const l = legacy ?? legacyOf(u);
  const rights = new Set<string>(d.reasons.filter((r) => r.source === 'share').flatMap((r) => r.permissions));
  if (worksInSteward(u)) rights.add('view');
  if (l.propose()) rights.add('propose');
  if (l.manage()) for (const x of ALL) rights.add(x);
  const reasons = d.reasons
    .map((r) => (r.source === 'instanceRole' || r.source === 'moduleRole' ? { ...r, permissions: r.permissions.filter((x) => rights.has(x)) } : r))
    .filter((r) => r.permissions.length);
  if (rights.has('propose') && !reasons.some((r) => r.permissions.includes('propose')) && u.roles[0])
    reasons.push({ source: 'instanceRole', role: u.roles.find((r) => r !== 'status') ?? u.roles[0], permissions: ['propose'] });
  return { permissions: normalise(rights), reasons };
}

/**
 * Whether `u` may see one entry – the cheap question (link labels, notification recipients): an entry of the whole
 * instance needs no decision, only lookups in the request's indexes.
 */
export function seesEntry(u: AuthUser | null, kind: PlantCatalogueKind, id: string): boolean {
  if (!u) return true;
  if (!usesModule(u, 'plant')) return false;
  if (openEntry(kind, id) && worksInSteward(u)) return true;
  return catalogueEntryAccess(u, kind, id).permissions.length > 0;
}

export const profileAccess = (u: AuthUser | null, id: string): CatalogueDecision => catalogueEntryAccess(u, 'device_profile', id);
export const kpiAccess = (u: AuthUser | null, id: string): CatalogueDecision => catalogueEntryAccess(u, 'kpi_definition', id);

// ---------- the scope of a request ----------

/** What a reader may see and do in the catalogues, decided once per call (a lookup per entry, no query per row). */
export interface CatalogueScope {
  readonly user: AuthUser | null;
  rights(kind: PlantCatalogueKind, id: string): readonly PlantCataloguePermission[];
  /** Whether the reader may see the profile (an id that names no profile counts as visible: it is "unknown", not hidden) */
  profile(id: string): boolean;
  kpi(id: string): boolean;
  /** The existing entries the reader may not see */
  hiddenProfiles(): ReadonlySet<string>;
  hiddenKpis(): ReadonlySet<string>;
  /** Nothing is hidden from the reader (no owning teams or restrictions on the catalogues, or an administrator) */
  open(): boolean;
}

/** The catalogues as `u` may see them; without a user (a job, the system) everything. */
export function catalogueScope(u: AuthUser | null = currentUser()): CatalogueScope {
  const memo = new Map<string, readonly PlantCataloguePermission[]>();
  const legacy = u ? legacyOf(u) : null;
  const reaches = u ? usesModule(u, 'plant') && worksInSteward(u) : true;
  const rights = (kind: PlantCatalogueKind, id: string): readonly PlantCataloguePermission[] => {
    if (!u) return ALL;
    const key = `${kind}:${id}`;
    let r = memo.get(key);
    if (!r) memo.set(key, (r = catalogueEntryAccess(u, kind, id, legacy!).permissions));
    return r;
  };
  // seeing an entry of the whole instance needs no decision (the common case: one lookup in the request's indexes)
  const sees = (kind: PlantCatalogueKind, id: string): boolean =>
    !u ? true : !reaches ? rights(kind, id).length > 0 : openEntry(kind, id) || rights(kind, id).length > 0;
  let hp: Set<string> | undefined;
  let hk: Set<string> | undefined;
  const hiddenOf = (kind: PlantCatalogueKind, table: string): Set<string> => {
    if (!u) return new Set();
    return new Set(
      db()
        .all<{ id: string }>(`SELECT id FROM ${table}`)
        .map((r) => r.id)
        .filter((id) => !sees(kind, id)),
    );
  };
  const scope: CatalogueScope = {
    user: u,
    rights,
    hiddenProfiles: () => (hp ??= hiddenOf('device_profile', 'plant_profiles')),
    hiddenKpis: () => (hk ??= hiddenOf('kpi_definition', 'plant_kpis')),
    profile: (id) => !scope.hiddenProfiles().has(id),
    kpi: (id) => !scope.hiddenKpis().has(id),
    open: () => !scope.hiddenProfiles().size && !scope.hiddenKpis().size,
  };
  return scope;
}

/** GET /api/plant/catalogue/hidden: how many entries the reader may not see (the lists say "and 2 you may not see"). */
export function hiddenCatalogue(scope: CatalogueScope = catalogueScope()): PlantHiddenCatalogue {
  return { profiles: scope.hiddenProfiles().size, kpis: scope.hiddenKpis().size };
}

// ---------- not named: placeholders ----------

/**
 * Placeholders for the entries one item names that the reader may not see (`~hidden-1`, `~hidden-2` … in the order the
 * item names them). Built from the stored item the same way when it is read and when a form or file sends it back, so
 * a placeholder keeps what it stands for; anything else that is hidden is "unknown".
 */
export class HiddenRefs {
  private readonly tokens = new Map<string, string>();
  private readonly ids = new Map<string, string>();
  constructor(
    private readonly visible: (id: string) => boolean,
    names: Iterable<string | null | undefined> = [],
  ) {
    for (const id of names) if (id) this.ref(id);
  }
  /** The id as the reader may see it: itself, or its placeholder. */
  ref(id: string): string;
  ref(id: string | null): string | null;
  ref(id: string | null): string | null {
    if (!id || this.visible(id)) return id;
    let t = this.tokens.get(id);
    if (!t) {
      t = plantHiddenRef(this.tokens.size + 1);
      this.tokens.set(id, t);
      this.ids.set(t, id);
    }
    return t;
  }
  /** Whether the id is one the reader may not see (named by this item). */
  hides(id: string): boolean {
    return this.tokens.has(id);
  }
  /** A message or path with the ids this item hides replaced by their placeholders (`"<id>"` → `"~hidden-1"`). */
  redact(text: string): string {
    let out = text;
    for (const [id, t] of this.tokens) out = out.split(`"${id}"`).join(`"${t}"`);
    return out;
  }
  /** The id a value sent back stands for: a placeholder's entry (undefined: no entry of this item), else the value. */
  id(v: string): string | undefined {
    return PLANT_HIDDEN_REF_RE.test(v) ? this.ids.get(v) : v;
  }
}

/**
 * The id a form or file names, as stored: a placeholder becomes the hidden entry it stands for (`kept`), a visible or
 * unknown id stays; a hidden entry the item did not name before – or a placeholder it does not have – is refused like an
 * unknown one (`notFound`). Used for profiles (assignments, bases, KPI inputs) and KPI definitions (KPI instances).
 */
export function keptRef(v: string, refs: HiddenRefs, visible: (id: string) => boolean, notFound: (id: string) => HttpError): string {
  const id = refs.id(v);
  if (id === undefined) throw notFound(v);
  if (!visible(id) && !refs.hides(id)) throw notFound(id);
  return id;
}

/** Profiles as the reader may see them: a hidden one keeps its model (what the asset delivers) and loses its name. */
export function presentProfiles<T extends PlantProfileValues>(m: Map<string, T>, scope: CatalogueScope): Map<string, T> {
  const hidden = scope.hiddenProfiles();
  if (!hidden.size) return m;
  return new Map([...m].map(([id, p]) => [id, hidden.has(id) ? anonymousProfile(p) : p]));
}

/** A profile the reader may not see, as the asset shows it: its model, without its name, maker or notes. */
export function anonymousProfile<T extends PlantProfileValues>(p: T): T {
  return { ...p, name: PLANT_HIDDEN, manufacturer: '', model: '', version: '', category: '', description: '', notes: '' };
}

/** KPI definitions as the reader may see them: a hidden one keeps what the checks read and loses its name. */
export function presentKpis<T extends PlantKpiValues>(m: Map<string, T>, scope: CatalogueScope): Map<string, T> {
  const hidden = scope.hiddenKpis();
  if (!hidden.size) return m;
  return new Map([...m].map(([id, k]) => [id, hidden.has(id) ? { ...k, name: PLANT_HIDDEN, names: {}, description: '', notes: '' } : k]));
}

/**
 * A visible profile whose bases the reader may not all see (part 4): every profile id it names – its chain, where each
 * item comes from, who marks an item not present – as `refs` shows it. The inherited items stay (they are its model).
 */
export function presentResolved<T extends PlantResolvedProfile>(p: T, refs: HiddenRefs): T {
  if (!p.chain.some((id) => refs.hides(id) || refs.ref(id) !== id)) return p;
  const origin = <O extends { from: string; changedBy: string[]; descriptionFrom: string }>(o: O): O => ({
    ...o,
    from: refs.ref(o.from),
    changedBy: o.changedBy.map((x) => refs.ref(x)),
    descriptionFrom: refs.ref(o.descriptionFrom),
  });
  const map = <O extends { from: string; changedBy: string[]; descriptionFrom: string }>(r: Record<string, O>) =>
    Object.fromEntries(Object.entries(r).map(([k, o]) => [k, origin(o)]));
  return {
    ...p,
    chain: p.chain.map((x) => refs.ref(x)),
    extends: refs.ref(p.extends),
    descriptionFrom: refs.ref(p.descriptionFrom),
    origins: {
      interfaces: map(p.origins.interfaces),
      points: map(p.origins.points),
      groups: map(p.origins.groups),
      fileSets: map(p.origins.fileSets),
    },
    notPresent: {
      interfaces: p.notPresent.interfaces.map((x) => ({ ...x, by: refs.ref(x.by) })),
      points: p.notPresent.points.map((x) => ({ ...x, by: refs.ref(x.by) })),
    },
  };
}

/** The rights on one entry, refusing it like an unknown one when the reader may not see it. */
export function requireEntry(
  scope: CatalogueScope,
  kind: PlantCatalogueKind,
  id: string,
  notFound: (id: string) => HttpError,
): readonly PlantCataloguePermission[] {
  const r = scope.rights(kind, id);
  if (!r.includes('view')) throw notFound(id);
  return r;
}

/**
 * An id the caller cannot have for a new entry because an entry they may not see has it (or an old id of one leads
 * there): refused neutrally, without saying what holds it (part 4).
 */
export const idUnavailable = (id: string): HttpError => new HttpError(409, `The id ${id} cannot be used – choose another one`, 'PLANT_ID_UNAVAILABLE', { id });

/** Refuses a change the reader's rights on an entry do not cover (403, after the entry is known to be visible). */
export function requireRight(rights: readonly PlantCataloguePermission[], need: PlantCataloguePermission, what: string): void {
  if (!rights.includes(need)) throw new HttpError(403, `You are not allowed to ${what}`, 'FORBIDDEN', { context: 'managePlantCatalogue' });
}

// ---------- KPI inputs ----------

/** The profiles a KPI definition's inputs name, as placeholders where the caller may not see them (in the order named). */
export const kpiRefs = (k: Pick<PlantKpiValues, 'inputs'>, scope: CatalogueScope): HiddenRefs => new HiddenRefs(scope.profile, kpiProfiles(k));

/** A KPI definition's inputs with the profiles the caller may not see as placeholders (`profile`, `profiles`, `mapping`). */
export function presentInputs(k: Pick<PlantKpiValues, 'inputs'>, refs: HiddenRefs): PlantKpiValues['inputs'] {
  return k.inputs.map((i) => ({
    ...i,
    profile: i.profile ? refs.ref(i.profile) : i.profile,
    ...(i.profiles ? { profiles: i.profiles.map((p) => refs.ref(p)) } : {}),
    ...(i.mapping ? { mapping: Object.fromEntries(Object.entries(i.mapping).map(([p, m]) => [refs.ref(p), m])) } : {}),
  }));
}

/**
 * A KPI definition's inputs as stored: placeholders become the profiles they stand for in the stored definition, a
 * profile the caller may not see that it did not name is refused like an unknown one (0.21.0, part 4).
 */
export function keptInputs(
  inputs: PlantKpiValues['inputs'],
  stored: Pick<PlantKpiValues, 'inputs'> | null,
  scope: CatalogueScope,
  notFound: (id: string) => HttpError,
): PlantKpiValues['inputs'] {
  const refs = new HiddenRefs(scope.profile, stored ? kpiProfiles(stored) : []);
  const kept = (p: string) => keptRef(p, refs, scope.profile, notFound);
  return inputs.map((i) => ({
    ...i,
    profile: i.profile ? kept(i.profile) : i.profile,
    ...(i.profiles ? { profiles: i.profiles.map(kept) } : {}),
    ...(i.mapping ? { mapping: Object.fromEntries(Object.entries(i.mapping).map(([p, m]) => [kept(p), m])) } : {}),
  }));
}

// ---------- assignments ----------

/**
 * Placeholders of the profiles an asset's assignment names – the assigned one first (`~hidden-1` when hidden), then its
 * bases (`chain`: the assigned profile's, itself first) – and of its KPI instances' definitions, in their order.
 */
export function assignmentRefs(
  a: Pick<PlantAssignmentValues, 'profileId' | 'kpis'> | null,
  chain: readonly string[],
  scope: CatalogueScope,
): { profiles: HiddenRefs; kpis: HiddenRefs } {
  return {
    profiles: new HiddenRefs(scope.profile, [a?.profileId, ...chain.slice(1)]),
    kpis: new HiddenRefs(
      scope.kpi,
      (a?.kpis ?? []).map((k) => k.kpi),
    ),
  };
}

/** An assignment as the reader may see it: hidden profiles and KPI definitions by their placeholders. */
export function presentAssignment<T extends Pick<PlantAssignmentValues, 'profileId' | 'kpis'>>(a: T, refs: { profiles: HiddenRefs; kpis: HiddenRefs }): T {
  return { ...a, profileId: refs.profiles.ref(a.profileId), kpis: a.kpis.map((k) => ({ ...k, kpi: refs.kpis.ref(k.kpi) })) };
}

/**
 * An entry's values (a change set's base and current, a 409's merge) as the reader may see them: an assignment's,
 * a profile's base and a KPI definition's input profiles by their placeholders. Other kinds are returned as they are.
 */
export function presentEntryValues(kind: string, id: string, v: Record<string, unknown>, scope: CatalogueScope = catalogueScope()): Record<string, unknown> {
  if (scope.open()) return v;
  if (kind === 'assignment' && ('profileId' in v || 'kpis' in v)) {
    const a = { profileId: (v.profileId as string | null) ?? null, kpis: (v.kpis as PlantAssignmentValues['kpis'] | undefined) ?? [] };
    const chain = resolvedProfile(a.profileId)?.chain ?? [];
    const shown = presentAssignment(a, assignmentRefs(a, chain, scope));
    return { ...v, ...('profileId' in v ? { profileId: shown.profileId } : {}), ...('kpis' in v ? { kpis: shown.kpis } : {}) };
  }
  if (kind === 'profile' && typeof v.extends === 'string') {
    const refs = new HiddenRefs(scope.profile, resolvedProfile(id)?.chain.slice(1) ?? [v.extends]);
    return { ...v, extends: refs.ref(v.extends) };
  }
  if (kind === 'kpi' && Array.isArray(v.inputs)) {
    const k = { inputs: v.inputs as PlantKpiValues['inputs'] };
    return { ...v, inputs: presentInputs(k, kpiRefs(k, scope)) };
  }
  return v;
}

/**
 * Whether the caller may change the device profile an asset has (known-as names and data points a collection import
 * adds to it): the Edit right on that profile (0.21.0); an asset without one: who may add catalogue entries.
 */
export function mayChangeAssetProfile(assetId: string, u: AuthUser | null = currentUser()): boolean {
  const profileId = db().get<{ profile_id: string | null }>('SELECT profile_id FROM plant_assignments WHERE asset_id = ?', assetId)?.profile_id;
  return profileId ? catalogueEntryAccess(u, 'device_profile', profileId).permissions.includes('edit') : canManageCatalogue(u);
}
