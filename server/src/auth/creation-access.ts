import { AsyncLocalStorage } from 'node:async_hooks';
import { creationAccessSchema, type CreationAccess, type OwnedKind } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { HttpError } from '../util.js';
import { currentUser } from './context.js';
import { isAdmin } from './permissions.js';
import { memberships, owningTeams, setOwningTeams } from './policy.js';
import { getSettings } from '../settings.js';
import { heldOn, isRestricted, setRestricted, setShares, shareKind } from './shares.js';
import { requireAccessGrant } from './access-change.js';

/**
 * Access at creation (ADR 0040 part 1, ADR 0042): what a create path's optional `access` object asks for, applied inside
 * the creation's transaction – an item is never visible wider than requested, and a refusal rolls the creation back.
 * Every kind of `OWNED_KINDS` on every create path (web and API, public API, YAML import, accepted proposals) calls
 * `applyCreationAccess` after the creator's default teams (`assignCreatorTeams`), with `undefined` when nobody chose.
 * The rules are the Access tab's: the same functions (`setShares`, `setRestricted`), the same step-up
 * (`requireAccessGrant`) and the same audit entries. Compared with the defaults (the item's teams so far, and the
 * instance setting `newItemVisibility`), narrowing asks for nothing and widening asks for the step-up.
 */

export const parseCreationAccess = (v: unknown): CreationAccess | undefined => (v === undefined ? undefined : creationAccessSchema.parse(v));

/**
 * The access a request or an accepted proposal asked for, for every item its handler creates: the create routes and the
 * proposal inbox set it (`withCreationAccess`), the services read it where they call `applyCreationAccess` without
 * an `access` of their own. Without it the instance default applies.
 */
const asked = new AsyncLocalStorage<{ access: CreationAccess | undefined }>();
export const withCreationAccess = <T>(access: CreationAccess | undefined, fn: () => T): T => asked.run({ access }, fn);

/** Loading the demo data creates sample items for the whole instance: the owning team rule does not apply to it. */
const loadingDemo = new AsyncLocalStorage<true>();
export const withDemoLoad = <T>(fn: () => T): T => loadingDemo.run(true, fn);

/** Splits the optional `access` object off a create route's body (so a strict body schema never sees it) and checks it. */
export function takeCreationAccess(body: unknown): { body: unknown; access: CreationAccess | undefined } {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('access' in body)) return { body, access: undefined };
  const { access, ...rest } = body as Record<string, unknown>;
  return { body: rest, access: parseCreationAccess(access ?? undefined) };
}

/** A create route's body: `access` is split off, the rest goes to `create`, and every item it creates gets that access. */
export function createWithAccess<T>(raw: unknown, create: (body: unknown) => T): T {
  const { body, access } = takeCreationAccess(raw);
  return withCreationAccess(access, () => create(body));
}

/**
 * Kinds that never get the creator's teams: the catalogue (device profiles, KPI definitions, machine blueprints,
 * suppliers) belongs to nobody and stays open, and a platform identity follows its platform. With the instance setting
 * `newItemVisibility: owningTeams` every other kind needs an owning team at creation.
 */
const OPEN_KINDS: ReadonlySet<OwnedKind> = new Set<OwnedKind>(['device_profile', 'kpi_definition', 'blueprint', 'supplier', 'platform_identity']);

/** Applies `access` to the item just inserted (call it inside the creation's transaction, after the default teams). */
export function applyCreationAccess(kind: OwnedKind, id: string, label: string, given: CreationAccess | undefined): void {
  const access = given ?? asked.getStore()?.access;
  const u = currentUser();
  const def = shareKind(kind);
  if (access && !def && (access.restricted || access.shares?.length))
    throw new HttpError(400, `A ${kind.replace(/_/g, ' ')} cannot be restricted or shared`, 'ACCESS_NOT_RESTRICTABLE', { kind });
  // the teams the item has so far: the creator's defaults, or none for kinds without (suppliers, plant catalogue, …)
  const defaults = owningTeams(kind, id);
  if (access?.owningTeams) {
    const ids = [...new Set(access.owningTeams)];
    // owning teams outside one's own are an administrator's choice (PUT /owning-teams is administrators only); anyone else
    // gets the same refusal for an unknown team and for a team they are not in, so ids cannot be probed
    const mine = u && !isAdmin(u) ? memberships(u) : null;
    const foreign = mine ? ids.find((t) => !mine.has(t)) : undefined;
    if (foreign) throw new HttpError(403, 'You can only name teams you are a member of', 'FORBIDDEN', { context: 'owningTeams' });
    const known = new Map(
      db()
        .all<{ id: string; name: string }>('SELECT id, name FROM teams')
        .map((t) => [t.id, t.name]),
    );
    const unknown = ids.find((t) => !known.has(t));
    if (unknown) throw new HttpError(400, `Unknown team "${unknown}"`, 'TEAM_NOT_FOUND', { id: unknown });
    const had = defaults.map((t) => t.id);
    const same = ids.length === had.length && ids.every((t) => had.includes(t));
    if (!same) {
      // a team beside the defaults gives its members their roles; none at all opens an item the defaults scoped (teamsGrantAccess)
      if (had.length > 0 && (ids.length === 0 || ids.some((t) => !had.includes(t)))) requireAccessGrant(u);
      setOwningTeams(kind, id, ids);
      const names = ids.map((t) => known.get(t)!);
      audit({
        action: 'access.owning_teams_changed',
        entityType: kind,
        entityId: id,
        summary: `Owning teams of ${kind} "${label}": ${names.length ? names.join(', ') : 'none (the whole instance)'}${defaults.length ? ` (were: ${defaults.map((t) => t.name).join(', ')})` : ''}`,
        details: { before: defaults.map((t) => t.name), after: names },
      });
    }
  }
  // "Owning teams only" (ADR 0042): a new item belongs to a team. A person without one – an administrator included – names
  // one (administrators any), or the creation is refused and nothing is created. Jobs without a signed-in user are not asked.
  if (u && !loadingDemo.getStore() && getSettings().newItemVisibility === 'owningTeams' && !OPEN_KINDS.has(kind) && owningTeams(kind, id).length === 0)
    throw new HttpError(400, `A new ${kind.replace(/_/g, ' ')} needs an owning team`, 'ACCESS_OWNING_TEAM_REQUIRED', { kind });
  if (!def || !u) return;
  // The instance default (ADR 0042): with "owning teams only" a new item that has owning teams starts Restricted. An
  // item without owning team belongs to the whole instance – there is nobody to narrow it to. Asking for `restricted:
  // false` opens it again, which widens beyond the default and asks for the step-up.
  const byDefault = getSettings().newItemVisibility === 'owningTeams' && def.restrictBy !== 'never' && owningTeams(kind, id).length > 0;
  const restrict = access?.restricted ?? byDefault;
  if (byDefault && access?.restricted === false) requireAccessGrant(u);
  // Restricted only narrows a new item: its creator may set it even where the kind leaves the switch to administrators
  if (restrict && !isRestricted(kind, id)) setRestricted({ kind, id, restricted: true, held: 'all', label: `${kind} "${label}"` });
  if (access?.shares?.length) {
    const held = isAdmin(u) ? 'all' : heldOn(def, u, id);
    setShares({ kind, id, held, shares: access.shares, label: `${kind} "${label}"` });
  }
}
