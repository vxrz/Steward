import type { OwnedKind, ReportBranding } from '@sm/shared';
import { owningTeams } from '../auth/policy.js';
import { teamDefaults, teamLogo } from '../teams/settings.js';
import { getBranding, logo } from './branding.js';

/**
 * The branding of a team's PDFs (#136). Apart from the instance branding (branding.ts), which the team settings
 * check logos with – so that the two do not import each other.
 */

/**
 * Branding and logo for a PDF of a team: each value the team sets overrides the instance's (its own logo too); without
 * a team, or for a team that sets nothing, the instance branding.
 */
export function brandingFor(teamId: string | null | undefined): { branding: ReportBranding; logo: Buffer } {
  const base = getBranding();
  const team = teamId ? teamDefaults(teamId).branding : null;
  if (!teamId || !team) return { branding: base, logo: logo().data };
  const own = Object.fromEntries(
    (['companyName', 'accentColor', 'classification', 'footerNote'] as const).filter((k) => team[k] !== null).map((k) => [k, team[k]]),
  ) as Partial<ReportBranding>;
  const teamLogoData = team.customLogo ? teamLogo(teamId) : null;
  return { branding: { ...base, ...own, ...(teamLogoData ? { customLogo: true } : {}) }, logo: teamLogoData?.data ?? logo().data };
}

/** The team whose branding a PDF about a resource uses: the first of its owning teams, by name, that sets branding. */
export function brandingTeamOf(kind: OwnedKind, id: string): string | null {
  const teams = [...owningTeams(kind, id)].sort((a, b) => a.name.localeCompare(b.name));
  return teams.find((t) => teamDefaults(t.id).branding)?.id ?? null;
}

/** One branding team for several resources: theirs if they all share it, otherwise none (the instance branding). */
export function commonBrandingTeam(kind: OwnedKind, ids: string[]): string | null {
  const found = new Set(ids.map((id) => brandingTeamOf(kind, id)));
  return found.size === 1 ? [...found][0]! : null;
}
