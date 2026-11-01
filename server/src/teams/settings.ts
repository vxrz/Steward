import { z } from 'zod';
import {
  TEAM_CHANNEL_FORMATS,
  TEAM_CHANNEL_MODES,
  TEAM_NEW_RESOURCE_MODES,
  DAILY_SUMMARY_SECTIONS,
  type DailySummaryPrefs,
  type TeamChannel,
  type TeamNewResourceMode,
  type TeamReportBranding,
  type TeamSettings,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { HttpError, nowIso, parseJson, sha256 } from '../util.js';
import { currentActor, type AuthUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { memberships } from '../auth/policy.js';
import { getNotificationSettings } from '../notifications/settings.js';
import { sealTeamChannel } from '../notifications/team-channels.js';
import { prefsSchema } from '../notifications/summary-prefs.js';
import { checkLogo, getBranding, imageMime } from '../reports/branding.js';

/**
 * Team settings (#136). A team without a value of its own uses the instance's (the default); every value shows that,
 * with the way back to the default. Administrators change them; members of the team and administrators see them.
 *
 * - channel: the team's own Teams/webhook channel for messages about its resources (notifications/team-channels.ts)
 * - newResources: which new resources of its members the team owns (auth/policy.ts creatorTeams)
 * - summary: the daily summary its members get unless they chose their own (notifications/summary.ts)
 * - branding: report branding that overrides the instance's in the team's reports (reports/branding.ts brandingFor)
 */

interface Row {
  team_id: string;
  channel: string | null;
  channel_secret: string | null;
  defaults: string | null;
  logo: string | null;
  updated_at: string;
  updated_by: string;
}
type StoredChannel = Omit<TeamChannel, 'hasUrl'>;
type StoredBranding = Omit<TeamReportBranding, 'customLogo'>;
interface StoredDefaults {
  newResources?: TeamNewResourceMode;
  summary?: DailySummaryPrefs | null;
  branding?: StoredBranding | null;
}

const row = (teamId: string) => db().get<Row>('SELECT * FROM team_settings WHERE team_id = ?', teamId);
const team = (teamId: string) => db().get<{ id: string; name: string }>('SELECT id, name FROM teams WHERE id = ?', teamId);

function requireTeam(teamId: string, u: AuthUser): { id: string; name: string } {
  const t = team(teamId);
  // members of the team and administrators see its settings; for others the team is unknown here
  if (!t || (!isAdmin(u) && !memberships(u).has(t.id))) throw new HttpError(404, 'Team not found', 'TEAM_NOT_FOUND', { id: teamId });
  return t;
}

const storedDefaults = (r: Row | undefined): StoredDefaults => (r?.defaults ? parseJson<StoredDefaults>(r.defaults, {}) : {});

function validSummary(v: unknown): DailySummaryPrefs | null {
  const p = prefsSchema.safeParse(v);
  return p.success ? { ...p.data, sections: DAILY_SUMMARY_SECTIONS.filter((s) => p.data.sections.includes(s)) } : null;
}

/** The defaults a team sets, each falling back to the instance's. */
export function teamDefaults(teamId: string): { newResources: TeamNewResourceMode; summary: DailySummaryPrefs | null; branding: TeamReportBranding | null } {
  const r = row(teamId);
  const d = storedDefaults(r);
  return {
    newResources: (TEAM_NEW_RESOURCE_MODES as readonly string[]).includes(d.newResources ?? '') ? d.newResources! : 'auto',
    summary: d.summary ? validSummary(d.summary) : null,
    branding: d.branding || r?.logo ? { ...EMPTY_BRANDING, ...(d.branding ?? {}), customLogo: !!r?.logo } : null,
  };
}

const EMPTY_BRANDING: StoredBranding = { companyName: null, accentColor: null, classification: null, footerNote: null };

/** The team's report schedules (they name the team as a subject, like other team references). */
function reportSchedulesOf(teamName: string): { id: string; name: string }[] {
  const subject = `team:${teamName.toLowerCase()}`;
  return db()
    .all<{ id: string; name: string; team: string }>("SELECT id, name, team FROM report_schedules WHERE team <> '[]' ORDER BY name")
    .filter((s) => parseJson<string[]>(s.team, []).some((x) => x.toLowerCase() === subject))
    .map(({ id, name }) => ({ id, name }));
}

function toSettings(t: { id: string; name: string }, r: Row | undefined, u: AuthUser): TeamSettings {
  const instance = getNotificationSettings();
  const b = getBranding();
  const stored = r?.channel ? parseJson<StoredChannel | null>(r.channel, null) : null;
  const d = teamDefaults(t.id);
  return {
    teamId: t.id,
    teamName: t.name,
    channel: stored ? { ...stored, hasUrl: !!r?.channel_secret } : null,
    instance: {
      teamsEnabled: instance.teams.enabled && instance.teams.hasWebhookUrl,
      webhookEnabled: instance.webhook.enabled && instance.webhook.hasUrl,
      branding: { companyName: b.companyName, accentColor: b.accentColor, classification: b.classification, footerNote: b.footerNote },
    },
    newResources: d.newResources,
    summary: d.summary,
    branding: d.branding,
    reportSchedules: reportSchedulesOf(t.name),
    canChange: isAdmin(u),
    updatedAt: r?.updated_at ?? null,
    updatedBy: r?.updated_by ?? null,
  };
}

export function getTeamSettings(teamId: string, u: AuthUser): TeamSettings {
  const t = requireTeam(teamId, u);
  return toSettings(t, row(t.id), u);
}

const brandingText = (max: number) => z.string().trim().max(max).nullable();
export const teamSettingsInput = z
  .object({
    /** null: back to the instance channel; omitted: unchanged */
    channel: z
      .object({
        enabled: z.boolean(),
        format: z.enum(TEAM_CHANNEL_FORMATS),
        mode: z.enum(TEAM_CHANNEL_MODES),
        /** omitted: keep the stored URL; empty: remove it */
        url: z.string().trim().max(2048).optional(),
      })
      .strict()
      .nullable()
      .optional(),
    newResources: z.enum(TEAM_NEW_RESOURCE_MODES).optional(),
    /** null: members without their own settings get the instance default (off) */
    summary: prefsSchema.nullable().optional(),
    /** null: reports use the instance branding (the team logo is removed as well); a null field keeps the instance value */
    branding: z
      .object({
        companyName: brandingText(120),
        accentColor: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #1c7ed6')
          .nullable(),
        classification: brandingText(60),
        footerNote: brandingText(200),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

function checkUrl(url: string): void {
  try {
    if (!/^https?:$/.test(new URL(url).protocol)) throw new Error();
  } catch {
    throw new HttpError(400, 'Team channel: enter an http(s) URL', 'TEAM_CHANNEL_URL');
  }
}

function write(teamId: string, next: { channel: string | null; channelSecret: string | null; defaults: StoredDefaults; logo: string | null }): void {
  const defaults = Object.keys(next.defaults).length ? JSON.stringify(next.defaults) : null;
  db().run(
    `INSERT INTO team_settings (team_id, channel, channel_secret, defaults, logo, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (team_id) DO UPDATE SET channel = excluded.channel, channel_secret = excluded.channel_secret, defaults = excluded.defaults,
       logo = excluded.logo, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    teamId,
    next.channel,
    next.channelSecret,
    defaults,
    next.logo,
    nowIso(),
    currentActor(),
  );
}

const current = (r: Row | undefined) => ({
  channel: r?.channel ?? null,
  channelSecret: r?.channel_secret ?? null,
  defaults: storedDefaults(r),
  logo: r?.logo ?? null,
});

export function saveTeamSettings(teamId: string, input: z.infer<typeof teamSettingsInput>, u: AuthUser): TeamSettings {
  const t = requireTeam(teamId, u);
  if (!isAdmin(u)) throw new HttpError(403, 'Only administrators change team settings', 'FORBIDDEN');
  const before = row(t.id);
  const next = current(before);
  const changes: string[] = [];
  const details: Record<string, unknown> = { scope: `team:${t.name}` };

  if (input.channel !== undefined) {
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
    const was = before?.channel ? parseJson<StoredChannel | null>(before.channel, null) : null;
    next.channel = channel ? JSON.stringify(channel) : null;
    next.channelSecret = secret;
    changes.push(
      channel
        ? `own channel ${channel.enabled ? 'on' : 'off'} (${channel.format}, ${channel.mode === 'instead' ? 'instead of' : 'besides'} the instance channel)${input.channel?.url !== undefined ? (input.channel.url ? ', URL changed' : ', URL removed') : ''}`
        : 'uses the instance channel again',
    );
    // never the URL: it carries its own credentials
    Object.assign(details, { before: was, after: channel, urlChanged: input.channel?.url !== undefined });
  }
  if (input.newResources !== undefined) {
    const was = next.defaults.newResources ?? 'auto';
    if (input.newResources === 'auto') delete next.defaults.newResources;
    else next.defaults.newResources = input.newResources;
    changes.push(`new resources of members: ${input.newResources}`);
    details.newResources = { from: was, to: input.newResources };
  }
  if (input.summary !== undefined) {
    const was = next.defaults.summary ?? null;
    if (input.summary) next.defaults.summary = validSummary(input.summary);
    else delete next.defaults.summary;
    changes.push(
      input.summary
        ? `daily summary for members ${input.summary.enabled ? `on at ${input.summary.time} (${input.summary.timeZone})` : 'off'}`
        : 'daily summary: the instance default again',
    );
    details.summary = { from: was, to: next.defaults.summary ?? null };
  }
  if (input.branding !== undefined) {
    const was = next.defaults.branding ?? null;
    if (input.branding) {
      const b = Object.fromEntries(Object.entries(input.branding).map(([k, v]) => [k, typeof v === 'string' && v.trim() ? v.trim() : null])) as StoredBranding;
      next.defaults.branding = b;
    } else {
      delete next.defaults.branding;
      next.logo = null;
    }
    changes.push(input.branding ? 'report branding changed' : 'report branding: the instance branding again');
    details.branding = { from: was, to: next.defaults.branding ?? null };
  }
  if (!changes.length) return toSettings(t, before, u);
  db().tx(() => {
    write(t.id, next);
    audit({
      action: 'team.settings_changed',
      entityType: 'team',
      entityId: t.id,
      summary: `Team "${t.name}": ${changes.join('; ')}`,
      details,
    });
  });
  return toSettings(t, row(t.id), u);
}

// ---------- the team's report logo ----------

export function setTeamLogo(teamId: string, data: Buffer, u: AuthUser): TeamSettings {
  const t = requireTeam(teamId, u);
  if (!isAdmin(u)) throw new HttpError(403, 'Only administrators change team settings', 'FORBIDDEN');
  const mime = checkLogo(data);
  const next = current(row(t.id));
  next.logo = data.toString('base64');
  db().tx(() => {
    write(t.id, next);
    audit({
      action: 'team.settings_changed',
      entityType: 'team',
      entityId: t.id,
      summary: `Team "${t.name}": report logo uploaded (${mime}, ${data.length} bytes)`,
      details: { scope: `team:${t.name}`, logo: { sha256: sha256(data), size: data.length, mime } },
    });
  });
  return toSettings(t, row(t.id), u);
}

export function removeTeamLogo(teamId: string, u: AuthUser): TeamSettings {
  const t = requireTeam(teamId, u);
  if (!isAdmin(u)) throw new HttpError(403, 'Only administrators change team settings', 'FORBIDDEN');
  const before = row(t.id);
  if (!before?.logo) return toSettings(t, before, u);
  const next = current(before);
  next.logo = null;
  db().tx(() => {
    write(t.id, next);
    audit({
      action: 'team.settings_changed',
      entityType: 'team',
      entityId: t.id,
      summary: `Team "${t.name}": report logo removed (the instance logo again)`,
      details: { scope: `team:${t.name}`, logo: null },
    });
  });
  return toSettings(t, row(t.id), u);
}

/** The team's own report logo (only an image the PDF engine can read; null: the instance logo). */
export function teamLogo(teamId: string): { data: Buffer; mime: string } | null {
  const b64 = row(teamId)?.logo;
  if (!b64) return null;
  const data = Buffer.from(b64, 'base64');
  const mime = imageMime(data);
  return mime ? { data, mime } : null;
}

/** For migration packages: a team's settings without its channel URL. */
export function exportedDefaults(teamId: string): { defaults: StoredDefaults | null; logo: string | null } {
  const r = row(teamId);
  const d = storedDefaults(r);
  return { defaults: Object.keys(d).length ? d : null, logo: r?.logo ?? null };
}

/** For migration packages: checked defaults and logo of an imported team (anything invalid is left out). */
export function importedDefaults(v: unknown, logo: string | null | undefined): { defaults: string | null; logo: string | null } {
  const d = (v && typeof v === 'object' ? v : {}) as StoredDefaults;
  const out: StoredDefaults = {};
  if (d.newResources && d.newResources !== 'auto' && (TEAM_NEW_RESOURCE_MODES as readonly string[]).includes(d.newResources)) out.newResources = d.newResources;
  const summary = d.summary ? validSummary(d.summary) : null;
  if (summary) out.summary = summary;
  const b = teamSettingsInput.shape.branding.safeParse(d.branding ?? undefined);
  if (b.success && b.data) out.branding = b.data as StoredBranding;
  let checkedLogo: string | null = null;
  if (logo) {
    try {
      checkLogo(Buffer.from(logo, 'base64'));
      checkedLogo = logo;
    } catch {
      checkedLogo = null;
    }
  }
  return { defaults: Object.keys(out).length ? JSON.stringify(out) : null, logo: checkedLogo };
}
