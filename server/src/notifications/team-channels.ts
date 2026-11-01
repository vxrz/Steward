import { z } from 'zod';
import { TEAM_CHANNEL_FORMATS, TEAM_CHANNEL_MODES, type OwnedKind, type TeamChannel, type TeamSettings } from '@sm/shared';
import { db } from '../db.js';
import { vault } from '../vault.js';
import { audit } from '../audit.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { currentActor, type AuthUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { catalogueTeams, memberships, owningTeams, type OwningTeam } from '../auth/policy.js';
import { getNotificationSettings } from './settings.js';

/**
 * Team settings (#136): a team's own channel for messages about its resources. Without one, the team uses the
 * instance channel (the default). Administrators change it; members of the team and administrators see it.
 */

interface Row {
  team_id: string;
  channel: string | null;
  channel_secret: string | null;
  updated_at: string;
  updated_by: string;
}
type StoredChannel = Omit<TeamChannel, 'hasUrl'>;

const row = (teamId: string) => db().get<Row>('SELECT * FROM team_settings WHERE team_id = ?', teamId);
const team = (teamId: string) => db().get<{ id: string; name: string }>('SELECT id, name FROM teams WHERE id = ?', teamId);

function requireTeam(teamId: string, u: AuthUser): { id: string; name: string } {
  const t = team(teamId);
  // members of the team and administrators see its settings; for others the team is unknown here
  if (!t || (!isAdmin(u) && !memberships(u).has(t.id))) throw new HttpError(404, 'Team not found', 'TEAM_NOT_FOUND', { id: teamId });
  return t;
}

function toSettings(t: { id: string; name: string }, r: Row | undefined, u: AuthUser): TeamSettings {
  const instance = getNotificationSettings();
  const stored = r?.channel ? parseJson<StoredChannel | null>(r.channel, null) : null;
  return {
    teamId: t.id,
    teamName: t.name,
    channel: stored ? { ...stored, hasUrl: !!r?.channel_secret } : null,
    instance: { teamsEnabled: instance.teams.enabled && instance.teams.hasWebhookUrl, webhookEnabled: instance.webhook.enabled && instance.webhook.hasUrl },
    canChange: isAdmin(u),
    updatedAt: r?.updated_at ?? null,
    updatedBy: r?.updated_by ?? null,
  };
}

export function getTeamSettings(teamId: string, u: AuthUser): TeamSettings {
  const t = requireTeam(teamId, u);
  return toSettings(t, row(t.id), u);
}

export const teamSettingsInput = z
  .object({
    /** null: back to the instance channel */
    channel: z
      .object({
        enabled: z.boolean(),
        format: z.enum(TEAM_CHANNEL_FORMATS),
        mode: z.enum(TEAM_CHANNEL_MODES),
        /** omitted: keep the stored URL; empty: remove it */
        url: z.string().trim().max(2048).optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();

/** Encrypts a team channel's URL with the vault's data key (registered for key rotation in vault-rotation.ts). */
export function sealTeamChannel(value: { url: string }): string {
  return vault().encrypt(value);
}

function checkUrl(url: string): void {
  try {
    if (!/^https?:$/.test(new URL(url).protocol)) throw new Error();
  } catch {
    throw new HttpError(400, 'Team channel: enter an http(s) URL', 'TEAM_CHANNEL_URL');
  }
}

export function saveTeamSettings(teamId: string, input: z.infer<typeof teamSettingsInput>, u: AuthUser): TeamSettings {
  const t = requireTeam(teamId, u);
  if (!isAdmin(u)) throw new HttpError(403, 'Only administrators change team settings', 'FORBIDDEN');
  const before = row(t.id);
  let channel: StoredChannel | null = null;
  let secret: string | null = null;
  if (input.channel) {
    const { url, ...rest } = input.channel;
    channel = rest;
    if (url === undefined) secret = before?.channel_secret ?? null;
    else if (url) {
      checkUrl(url);
      secret = sealTeamChannel({ url });
    }
    if (channel.enabled && !secret) throw new HttpError(400, 'Team channel: enter the webhook URL', 'TEAM_CHANNEL_URL');
  }
  const ts = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO team_settings (team_id, channel, channel_secret, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (team_id) DO UPDATE SET channel = excluded.channel, channel_secret = excluded.channel_secret,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      t.id,
      channel ? JSON.stringify(channel) : null,
      secret,
      ts,
      currentActor(),
    );
    const was = before?.channel ? parseJson<StoredChannel | null>(before.channel, null) : null;
    audit({
      action: 'team.settings_changed',
      entityType: 'team',
      entityId: t.id,
      summary: channel
        ? `Team "${t.name}": own channel ${channel.enabled ? 'on' : 'off'} (${channel.format}, ${channel.mode === 'instead' ? 'instead of' : 'besides'} the instance channel)${input.channel?.url !== undefined ? (input.channel.url ? ', URL changed' : ', URL removed') : ''}`
        : `Team "${t.name}": uses the instance channel again`,
      // never the URL: it carries its own credentials
      details: { scope: `team:${t.name}`, before: was, after: channel, urlChanged: input.channel?.url !== undefined },
    });
  });
  return toSettings(t, row(t.id), u);
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
