import { OWNED_KINDS, type OwnedKind } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { HttpError } from '../util.js';
import { protectOpening } from '../suppliers/shared.js';
import { teamsChanged } from './policy.js';
import { deleteTeam } from './users.js';

/**
 * Deleting a team without widening anyone's access (review 0.20.0). A resource whose only owning team is deleted would
 * lose its last owning team and so become the whole instance's (resource_teams cascades with the team). Instead:
 * - a team that owns resources together with other teams is simply removed from them (that only narrows);
 * - a team that is the only owning team of resources is not deleted (`TEAM_OWNS_RESOURCES`, with the count per kind)
 *   unless the administrator names the team they move to (`moveTo`). Moving them to a team with members grants those
 *   members sight – the route asks for the `grantAccess` step-up then; a team without members keeps them restricted
 *   to administrators (and named owners, access lists, auditors where the kind lets them read).
 * Access lists and supplier contract owners keep the deleted team as an entry that matches nobody (auth/subjects.ts).
 */

/** The resources this team is the only owning team of. */
function soleOwned(teamId: string): { kind: OwnedKind; id: string }[] {
  return db()
    .all<{ kind: string; resource_id: string }>(
      `SELECT r.kind, r.resource_id FROM resource_teams r
        WHERE r.team_id = ? AND NOT EXISTS (
          SELECT 1 FROM resource_teams o WHERE o.kind = r.kind AND o.resource_id = r.resource_id AND o.team_id <> r.team_id)
        ORDER BY r.kind, r.resource_id`,
      teamId,
    )
    .filter((r): r is { kind: OwnedKind; resource_id: string } => (OWNED_KINDS as readonly string[]).includes(r.kind))
    .map((r) => ({ kind: r.kind, id: r.resource_id }));
}

export interface TeamDeletionPreview {
  /** Resources the team is the only owning team of, per kind: they need a team to move to */
  soleOwned: Partial<Record<OwnedKind, number>>;
  soleOwnedTotal: number;
  /** Resources the team owns together with other teams: it is just removed from them */
  shared: number;
}

const countByKind = (rows: { kind: OwnedKind }[]): Partial<Record<OwnedKind, number>> =>
  Object.fromEntries(OWNED_KINDS.map((k) => [k, rows.filter((r) => r.kind === k).length]).filter(([, n]) => n)) as Partial<Record<OwnedKind, number>>;

function teamName(id: string): string {
  const t = db().get<{ name: string }>('SELECT name FROM teams WHERE id = ?', id);
  if (!t) throw new HttpError(404, 'Team not found', 'TEAM_NOT_FOUND', { id, name: id });
  return t.name;
}

/** What deleting the team would do to the resources it owns. */
export function teamDeletionPreview(teamId: string): TeamDeletionPreview {
  teamName(teamId);
  const sole = soleOwned(teamId);
  const all = db().get<{ n: number }>('SELECT COUNT(*) AS n FROM resource_teams WHERE team_id = ?', teamId)?.n ?? 0;
  return { soleOwned: countByKind(sole), soleOwnedTotal: sole.length, shared: Number(all) - sole.length };
}

/** Does moving a team's only-owned resources to `moveTo` grant anyone sight (a team with members)? For the step-up rule. */
export function handOverGrantsAccess(teamId: string, moveTo: string | undefined): boolean {
  if (!moveTo) return false;
  const members = db().get<{ n: number }>('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?', moveTo)?.n ?? 0;
  return Number(members) > 0 && soleOwned(teamId).length > 0;
}

/**
 * Deletes the team; the resources it alone owns go to `moveTo` (else: refused while there are any). `nameOf`: a
 * resource's name for the audit entry (the route passes the owning-teams lookup).
 */
export function deleteTeamSafely(teamId: string, moveTo: string | undefined, nameOf: (kind: OwnedKind, id: string) => string | undefined): { moved: number } {
  const name = teamName(teamId);
  let moved = 0;
  db().tx(() => {
    const sole = soleOwned(teamId);
    if (sole.length && !moveTo) {
      // the kinds as a list (the counts per kind: GET /api/teams/:id/deletion)
      const kinds = Object.keys(countByKind(sole));
      throw new HttpError(
        409,
        `The team "${name}" is the only owning team of ${sole.length} item(s) – choose the team they move to, or give them other owning teams first`,
        'TEAM_OWNS_RESOURCES',
        { name, total: sole.length, kinds },
      );
    }
    if (sole.length && moveTo) {
      if (moveTo === teamId) throw new HttpError(400, 'Choose another team to move the items to', 'TEAM_NOT_FOUND', { id: moveTo, name: moveTo });
      const target = teamName(moveTo);
      const ts = new Date().toISOString();
      for (const r of sole) {
        // a supplier gets the protections of opening it (ADR 0031 part 8): its contracts and contacts stay with who saw them
        const protectedWhat = r.kind === 'supplier' ? protectOpening(r.id, [moveTo]) : null;
        db().run('INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES (?, ?, ?, ?)', r.kind, r.id, moveTo, ts);
        const label = nameOf(r.kind, r.id) ?? r.id;
        audit({
          action: 'access.owning_teams_changed',
          entityType: r.kind,
          entityId: r.id,
          summary: `Owning teams of ${r.kind} "${label}": ${target} (were: ${name}) – team "${name}" deleted`,
          details: { before: [name], after: [target], teamDeleted: name, ...(protectedWhat ? { protected: protectedWhat } : {}) },
        });
      }
      moved = sole.length;
    }
    deleteTeam(teamId);
  });
  teamsChanged();
  return { moved };
}
