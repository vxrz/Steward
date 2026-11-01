import type { OwnedKind, TeamChannel } from '@sm/shared';
import { db } from '../db.js';
import { vault } from '../vault.js';
import { parseJson } from '../util.js';
import { catalogueTeams, owningTeams, type OwningTeam } from '../auth/policy.js';

/**
 * Team channels (#136): where messages about a team's resources go. The settings themselves (and who may change them)
 * are in teams/settings.ts; this module seals the URL and finds the active channels of a message.
 */

interface Row {
  channel: string | null;
  channel_secret: string | null;
}
type StoredChannel = Omit<TeamChannel, 'hasUrl'>;

const row = (teamId: string) => db().get<Row>('SELECT channel, channel_secret FROM team_settings WHERE team_id = ?', teamId);

/** Encrypts a team channel's URL with the vault's data key (registered for key rotation in vault-rotation.ts). */
export function sealTeamChannel(value: { url: string }): string {
  return vault().encrypt(value);
}

/** The URL of a team's channel (only while the vault is unlocked). */
export function teamChannelUrl(teamId: string): string | null {
  const r = row(teamId);
  if (!r?.channel_secret || !vault().unlocked) return null;
  return vault().decrypt<{ url: string }>(r.channel_secret).url;
}

export interface ActiveTeamChannel {
  team: OwningTeam;
  format: TeamChannel['format'];
  mode: TeamChannel['mode'];
  url: string;
}

/** The owning teams of what a message is about: a resource, or the process of a run. */
export function teamsOf(about: { kind: OwnedKind; id: string } | undefined, runId: string | undefined): OwningTeam[] {
  if (about) {
    if (about.kind === 'service' || about.kind === 'application' || about.kind === 'system') return catalogueTeams(about.kind, about.id);
    return owningTeams(about.kind, about.id);
  }
  if (runId) {
    const p = db().get<{ process_id: string }>('SELECT process_id FROM runs WHERE id = ?', runId);
    if (p) return owningTeams('process', p.process_id);
  }
  return [];
}

/**
 * Where a message about a resource goes besides the instance channel: the active channels of its owning teams, and
 * whether the instance channel is left out (every owning team has an active channel that says "instead").
 */
export function teamChannelsFor(teams: OwningTeam[]): { channels: ActiveTeamChannel[]; skipInstance: boolean } {
  if (!teams.length || !vault().unlocked) return { channels: [], skipInstance: false };
  const channels: ActiveTeamChannel[] = [];
  for (const t of teams) {
    const r = row(t.id);
    const c = r?.channel ? parseJson<StoredChannel | null>(r.channel, null) : null;
    if (!c?.enabled || !r?.channel_secret) continue;
    const url = vault().decrypt<{ url: string }>(r.channel_secret).url;
    channels.push({ team: t, format: c.format, mode: c.mode, url });
  }
  const skipInstance = channels.length === teams.length && channels.every((c) => c.mode === 'instead');
  return { channels, skipInstance };
}
