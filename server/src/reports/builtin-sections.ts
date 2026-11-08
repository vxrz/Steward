import { z, type ZodType } from 'zod';
import type { MonitorStatus } from '@sm/shared';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { permissionsOfRow } from '../monitors/model.js';
import * as processes from '../processes/service.js';
import * as platforms from '../platforms/service.js';
import { listCredentials } from '../credentials/service.js';
import { availability as gatusAvailability, sourceRow } from '../gatus/metrics.js';
import { st } from './scheduled-i18n.js';
import type { ReportSectionDef } from './sections.js';
import {
  availabilitySectionDraw,
  gatusSectionDraw,
  credentialsSectionDraw,
  runsSectionDraw,
  type MonitorAvail,
  type AvailabilityData,
  type GatusData,
  type CredentialRowData,
  type CredentialsData,
  type RunsData,
} from './builtin-sections-draw.js';

/**
 * The built-in sections of scheduled summary reports: availability of monitors and of Gatus endpoints, the
 * credentials register and runs of processes. Other features bring their own (records, tickets, duties, …).
 */

const DAY = 86400000;

// ---------- helpers ----------

const slaTarget = z.number().min(0).max(100).nullable().optional();

const p95 = (values: number[]): number | null => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!;
};

/** Time-weighted uptime of a monitor in [from, to) from its status changes, with the down intervals. */
export function monitorAvailability(monitorId: string, from: number, to: number): Omit<MonitorAvail, 'id' | 'key' | 'name'> {
  const fromIso = new Date(from).toISOString();
  const toIso = new Date(to).toISOString();
  const before = db().get<{ ts: string; status: MonitorStatus }>(
    "SELECT ts, status FROM monitor_history WHERE monitor_id = ? AND check_id = '' AND ts < ? ORDER BY ts DESC, id DESC LIMIT 1",
    monitorId,
    fromIso,
  );
  const changes = db().all<{ ts: string; status: MonitorStatus }>(
    "SELECT ts, status FROM monitor_history WHERE monitor_id = ? AND check_id = '' AND ts >= ? AND ts < ? ORDER BY ts, id",
    monitorId,
    fromIso,
    toIso,
  );
  const points = [...(before ? [{ t: from, status: before.status }] : []), ...changes.map((c) => ({ t: Date.parse(c.ts), status: c.status }))];
  const end = Math.min(to, Date.now());
  let ok = 0;
  let down = 0;
  const outages: MonitorAvail['outages'] = [];
  let downSince: number | null = null;
  points.forEach((p, i) => {
    const a = Math.max(p.t, from);
    const b = Math.min(points[i + 1]?.t ?? end, end);
    if (p.status === 'down') {
      if (downSince === null) downSince = a;
    } else if (downSince !== null) {
      outages.push({ from: new Date(downSince).toISOString(), to: new Date(a).toISOString(), durationMs: a - downSince });
      downSince = null;
    }
    if (b <= a) return;
    if (p.status === 'up' || p.status === 'degraded') ok += b - a;
    else if (p.status === 'down') down += b - a;
  });
  if (downSince !== null)
    outages.push({ from: new Date(downSince).toISOString(), to: end < to ? null : new Date(to).toISOString(), durationMs: end - downSince });
  const durations = db()
    .all<{ d: number }>(
      'SELECT duration_ms AS d FROM monitor_results WHERE monitor_id = ? AND ts >= ? AND ts < ? AND duration_ms IS NOT NULL',
      monitorId,
      fromIso,
      toIso,
    )
    .map((r) => Number(r.d));
  return {
    uptime: ok + down > 0 ? Math.round((ok / (ok + down)) * 10000) / 100 : null,
    outages,
    downtimeMs: down,
    avgMs: durations.length ? Math.round(durations.reduce((s, x) => s + x, 0) / durations.length) : null,
    p95Ms: p95(durations),
  };
}

const availabilitySchema = z.object({ monitorIds: z.array(z.string().min(1).max(100)).max(500).nullable().default(null), slaTarget });

type AvailabilityConfig = z.infer<typeof availabilitySchema>;

function visibleMonitorRows(): { id: string; key: string; name: string; owner: string; acl: string }[] {
  const u = currentUser();
  return db()
    .all<{ id: string; key: string; name: string; owner: string; acl: string }>(
      'SELECT id, key, name, owner, acl FROM monitors WHERE is_template = 0 ORDER BY name',
    )
    .filter((r) => permissionsOfRow(r, u).includes('view'));
}

// ---------- availability of Gatus endpoints ----------

const gatusSchema = z.object({
  sources: z
    .array(z.object({ platformId: z.string().min(1).max(100), endpointKeys: z.array(z.string().min(1).max(300)).max(500).nullable().default(null) }))
    .min(1)
    .max(20),
  slaTarget,
});

type GatusConfig = z.infer<typeof gatusSchema>;

function visiblePlatform(id: string): { id: string; name: string } | null {
  try {
    const p = platforms.getPlatform(id);
    return p.permissions.length && p.kind === 'gatus' ? { id: p.id, name: p.name } : null;
  } catch {
    return null;
  }
}

// ---------- credentials ----------

const credentialsSchema = z.object({ dueWithinDays: z.number().int().min(0).max(365).default(30) });

type CredentialsConfig = z.infer<typeof credentialsSchema>;

// ---------- runs ----------

const runsSchema = z.object({ processIds: z.array(z.string().min(1).max(100)).max(500).nullable().default(null) });

type RunsConfig = z.infer<typeof runsSchema>;

export const availabilitySection: ReportSectionDef<AvailabilityConfig, AvailabilityData> = {
  ...availabilitySectionDraw,
  schema: availabilitySchema as unknown as ZodType<AvailabilityConfig>,
  validate: (c) => {
    if (!c.monitorIds) return;
    const visible = new Set(visibleMonitorRows().flatMap((m) => [m.id, m.key]));
    const missing = c.monitorIds.filter((id) => !visible.has(id));
    if (missing.length) throw Object.assign(new Error(`Monitor(s) not found: ${missing.join(', ')}`), { statusCode: 400 });
  },
  build: (c, ctx) => {
    const rows = visibleMonitorRows().filter((m) => !c.monitorIds || c.monitorIds.includes(m.id) || c.monitorIds.includes(m.key));
    return {
      slaTarget: c.slaTarget ?? null,
      monitors: rows.map((m) => ({ id: m.id, key: m.key, name: m.name, ...monitorAvailability(m.id, ctx.from, ctx.to) })),
    };
  },
};
export const gatusSection: ReportSectionDef<GatusConfig, GatusData> = {
  ...gatusSectionDraw,
  schema: gatusSchema as unknown as ZodType<GatusConfig>,
  validate: (c) => {
    for (const s of c.sources)
      if (!visiblePlatform(s.platformId)) throw Object.assign(new Error(`Gatus platform ${s.platformId} not found`), { statusCode: 400 });
  },
  build: (c, ctx) => ({
    slaTarget: c.slaTarget ?? null,
    platforms: c.sources.map((s) => {
      const p = visiblePlatform(s.platformId);
      if (!p) return { id: s.platformId, name: s.platformId, note: st(ctx.lang, 'notAccessible', { name: s.platformId }), endpoints: [] };
      if (!sourceRow(p.id)) return { id: p.id, name: p.name, note: st(ctx.lang, 'noMetrics', { name: p.name }), endpoints: [] };
      return { id: p.id, name: p.name, note: null, endpoints: gatusAvailability(p.id, s.endpointKeys, ctx.from, ctx.to) };
    }),
  }),
};
export const credentialsSection: ReportSectionDef<CredentialsConfig, CredentialsData> = {
  ...credentialsSectionDraw,
  schema: credentialsSchema as unknown as ZodType<CredentialsConfig>,
  build: (c, ctx) => {
    // the state at the end of the period (or now, if the period ends in the future)
    const at = Math.min(ctx.to, ctx.now);
    const horizon = ctx.to + c.dueWithinDays * DAY;
    const out: CredentialsData = { dueWithinDays: c.dueWithinDays, expired: [], overdue: [], dueSoon: [] };
    for (const cr of listCredentials({}, at)) {
      for (const d of cr.dues) {
        const t = Date.parse(d.dueAt);
        const row: CredentialRowData = {
          id: cr.id,
          name: cr.name,
          type: cr.type,
          platform: cr.platformName ?? cr.platformText,
          status: d.status,
          due: d.kind,
          dueAt: d.dueAt,
          owners: [...cr.owners.map((o) => o.email), ...cr.ownerSubjects].join(', '),
        };
        if (t <= at) (d.kind === 'expiry' ? out.expired : out.overdue).push(row);
        else if (t <= horizon) out.dueSoon.push(row);
      }
    }
    for (const l of [out.expired, out.overdue, out.dueSoon]) l.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    return out;
  },
};
export const runsSection: ReportSectionDef<RunsConfig, RunsData> = {
  ...runsSectionDraw,
  schema: runsSchema as unknown as ZodType<RunsConfig>,
  validate: (c) => {
    for (const id of c.processIds ?? [])
      if (!processes.permissionsFor(id).includes('view')) throw Object.assign(new Error(`Process ${id} not found`), { statusCode: 400 });
  },
  build: (c, ctx) => {
    const visible = new Set(
      db()
        .all<{ id: string }>('SELECT id FROM processes')
        .filter((p) => processes.permissionsFor(p.id).includes('view'))
        .map((p) => p.id),
    );
    const rows = db().all<{ process_id: string; process_name: string; status: string; n: number }>(
      'SELECT process_id, process_name, status, COUNT(*) AS n FROM runs WHERE started_at >= ? AND started_at < ? AND debug IS NULL GROUP BY process_id, process_name, status',
      new Date(ctx.from).toISOString(),
      new Date(ctx.to).toISOString(),
    );
    const per = new Map<string, RunsData['processes'][number]>();
    for (const r of rows) {
      if (!visible.has(r.process_id) || (c.processIds && !c.processIds.includes(r.process_id))) continue;
      const p = per.get(r.process_id) ?? { id: r.process_id, name: r.process_name, total: 0, succeeded: 0, failed: 0, other: 0 };
      const n = Number(r.n);
      p.total += n;
      if (r.status === 'succeeded') p.succeeded += n;
      else if (r.status === 'failed') p.failed += n;
      else p.other += n;
      per.set(r.process_id, p);
    }
    return { processes: [...per.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  },
};
