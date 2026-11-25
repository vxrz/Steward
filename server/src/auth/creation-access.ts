import { creationAccessSchema, type CreationAccess, type OwnedKind } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { HttpError } from '../util.js';
import { currentUser } from './context.js';
import { isAdmin } from './permissions.js';
import { memberships, newResourceTeams, setOwningTeams } from './policy.js';
import { heldOn, setRestricted, setShares, shareKind } from './shares.js';
import { requireAccessGrant } from './access-change.js';

/**
 * Access at creation (ADR 0040 part 1): what a create route's optional `access` object asks for, applied inside the
 * creation's transaction – an item is never visible wider than requested, and a refusal rolls the creation back.
 * The rules are the Access tab's: the same functions (`setShares`, `setRestricted`), the same step-up
 * (`requireAccessGrant`) and the same audit entries. Compared with the creator's defaults (`newResourceTeams`, no
 * Restricted, no shares), narrowing asks for nothing and widening asks for the step-up.
 */

export const parseCreationAccess = (v: unknown): CreationAccess | undefined => (v === undefined ? undefined : creationAccessSchema.parse(v));

/** Applies `access` to the item just inserted (call it inside the creation's transaction, after the default teams). */
export function applyCreationAccess(kind: OwnedKind, id: string, label: string, access: CreationAccess | undefined): void {
  if (!access) return;
  const u = currentUser();
  const defaults = newResourceTeams(u).teams;
  if (access.owningTeams) {
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
  const def = shareKind(kind);
  if (!def || !u) return;
  const held = isAdmin(u) ? 'all' : heldOn(def, u, id);
  // Restricted only narrows a new item: its creator may set it even where the kind leaves the switch to administrators
  if (access.restricted) setRestricted({ kind, id, restricted: true, held: 'all', label: `${kind} "${label}"` });
  if (access.shares?.length) setShares({ kind, id, held, shares: access.shares, label: `${kind} "${label}"` });
}
