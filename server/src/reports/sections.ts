import { z, type ZodType } from 'zod';
import type { CredentialStatus, MonitorStatus, ReportLang } from '@sm/shared';
import { db } from '../db.js';
import { parseJson } from '../util.js';
import { currentUser } from '../auth/context.js';
import { permissionsOfRow } from '../monitors/model.js';
import * as processes from '../processes/service.js';
import * as platforms from '../platforms/service.js';
import { listCredentials } from '../credentials/service.js';
import { availability as gatusAvailability, sourceRow, type EndpointAvailability } from '../gatus/metrics.js';
import { COLORS, type CellInput, type ReportWriter, type Tone } from './pdf/engine.js';
import type { Translator } from './i18n.js';
import { pctText, st } from './scheduled-i18n.js';

/**
 * Sections of scheduled summary reports. Each section validates its own
 * configuration, collects its data (called inside runAs(owner): only what the
 * owner of the schedule may see) and renders it. The collected data is part of
 * the report model and therefore of its content hash.
 *
 * Extension point: other features register more sections with
 * registerReportSection() (e.g. "records" in records/report-section.ts,
 * imported by schedules.ts).
 */

const DAY = 86400000;

export interface SectionContext {
  from: number;
  to: number;
  now: number;
  lang: ReportLang;
}

export interface SectionRender {
  w: ReportWriter;
  tr: Translator;
  lang: ReportLang;
  /** Numbered section heading */
  section: (title: string) => void;
}

export interface ReportSectionDef<C = unknown, D = unknown> {
  id: string;
  /** Validates the section's configuration in a schedule */
  schema: ZodType<C>;
  /** Throws (HttpError 400) when the configuration names something the owner may not see; called on save */
  validate?: (config: C) => void;
  title: (lang: ReportLang) => string;
  build: (config: C, ctx: SectionContext) => D;
  render: (data: D, r: SectionRender) => void;
  /** Figures for the "at a glance" row */
  glance?: (data: D, lang: ReportLang) => { label: string; value: string; tone?: Tone }[];
}

const SECTIONS = new Map<string, ReportSectionDef>();
export function registerReportSection<C, D>(def: ReportSectionDef<C, D>): void {
  SECTIONS.set(def.id, def as unknown as ReportSectionDef);
}
export const reportSection = (id: string): ReportSectionDef | undefined => SECTIONS.get(id);
export const reportSectionIds = (): string[] => [...SECTIONS.keys()];

// ---------- helpers ----------

const slaTarget = z.number().min(0).max(100).nullable().optional();

const p95 = (values: number[]): number | null => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!;
};

const slaCell = (lang: ReportLang, uptime: number | null, target: number | null | undefined): CellInput => {
  if (target === null || target === undefined) return '–';
  if (uptime === null) return { text: st(lang, 'noData'), tone: 'muted' };
  return uptime >= target ? { text: st(lang, 'slaMet'), tone: 'success' } : { text: st(lang, 'slaMissed'), tone: 'danger', bold: true };
};

/** Horizontal bars drawn with PDFKit vector primitives (no images, PDF/A-safe). */
export function uptimeBars(w: ReportWriter, title: string, items: { label: string; value: number | null; target?: number | null }[], min: number): void {
  if (!items.length) return;
  const rowH = 13;
  const labelW = Math.min(170, w.width * 0.34);
  const barX = w.left + labelW + 8;
  const barW = w.width - labelW - 8 - 52;
  w.ensure(22 + Math.min(items.length, 10) * rowH);
  w.font('bold', 8).fillColor(COLORS.muted);
  w.text(title, w.left, w.y, { width: w.width });
  w.y += 4;
  for (const it of items) {
    w.ensure(rowH + 2);
    const y = w.y;
    w.font('sans', 7.2).fillColor(COLORS.text);
    w.text(it.label, w.left, y + 2, { width: labelW, lineBreak: false, ellipsis: true, height: rowH });
    w.doc.rect(barX, y + 2, barW, rowH - 4).fill(COLORS.headBg);
    if (it.value !== null) {
      const frac = Math.max(0, Math.min(1, (it.value - min) / (100 - min)));
      const tone = it.target !== null && it.target !== undefined ? (it.value >= it.target ? COLORS.success : COLORS.danger) : w.accent;
      if (frac > 0) w.doc.rect(barX, y + 2, barW * frac, rowH - 4).fill(tone);
    }
    if (it.target !== null && it.target !== undefined && it.target >= min) {
      const tx = barX + (barW * (it.target - min)) / (100 - min);
      w.doc
        .moveTo(tx, y)
        .lineTo(tx, y + rowH)
        .lineWidth(1)
        .stroke(COLORS.text);
    }
    w.font('sans', 7.2).fillColor(COLORS.text);
    w.text(it.value === null ? '–' : `${it.value.toFixed(2)} %`, barX + barW + 4, y + 2, { width: 48, align: 'right', lineBreak: false });
    w.y = y + rowH;
  }
  w.y += 8;
  w.doc.fillColor(COLORS.text);
}

const chartMin = (values: (number | null)[]): number => {
  const lowest = Math.min(100, ...values.filter((v): v is number => v !== null));
  return lowest >= 99 ? 95 : lowest >= 90 ? 80 : 0;
};

// ---------- availability of monitors ----------

interface MonitorAvail {
  id: string;
  key: string;
  name: string;
  uptime: number | null;
  outages: { from: string; to: string | null; durationMs: number }[];
  downtimeMs: number;
  avgMs: number | null;
  p95Ms: number | null;
}

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
interface AvailabilityData {
  slaTarget: number | null;
  monitors: MonitorAvail[];
}

function visibleMonitorRows(): { id: string; key: string; name: string; owner: string; acl: string }[] {
  const u = currentUser();
  return db()
    .all<{ id: string; key: string; name: string; owner: string; acl: string }>(
      'SELECT id, key, name, owner, acl FROM monitors WHERE is_template = 0 ORDER BY name',
    )
    .filter((r) => permissionsOfRow(r, u).includes('view'));
}

registerReportSection<AvailabilityConfig, AvailabilityData>({
  id: 'availability',
  schema: availabilitySchema as unknown as ZodType<AvailabilityConfig>,
  validate: (c) => {
    if (!c.monitorIds) return;
    const visible = new Set(visibleMonitorRows().flatMap((m) => [m.id, m.key]));
    const missing = c.monitorIds.filter((id) => !visible.has(id));
    if (missing.length) throw Object.assign(new Error(`Monitor(s) not found: ${missing.join(', ')}`), { statusCode: 400 });
  },
  title: (l) => st(l, 'availability'),
  build: (c, ctx) => {
    const rows = visibleMonitorRows().filter((m) => !c.monitorIds || c.monitorIds.includes(m.id) || c.monitorIds.includes(m.key));
    return {
      slaTarget: c.slaTarget ?? null,
      monitors: rows.map((m) => ({ id: m.id, key: m.key, name: m.name, ...monitorAvailability(m.id, ctx.from, ctx.to) })),
    };
  },
  glance: (d, l) => {
    const ups = d.monitors.map((m) => m.uptime).filter((x): x is number => x !== null);
    const missed = d.slaTarget !== null ? d.monitors.filter((m) => m.uptime !== null && m.uptime < d.slaTarget!).length : null;
    return [
      { label: `${st(l, 'avgUptime')} (${st(l, 'monitor')})`, value: ups.length ? pctText(l, ups.reduce((s, x) => s + x, 0) / ups.length) : '–' },
      {
        label: st(l, 'incidents'),
        value: String(d.monitors.reduce((s, m) => s + m.outages.length, 0)),
        tone: d.monitors.some((m) => m.outages.length) ? 'warning' : 'default',
      },
      ...(missed !== null ? [{ label: st(l, 'slaMissedCount'), value: String(missed), tone: (missed ? 'danger' : 'success') as Tone }] : []),
    ];
  },
  render: (d, { w, tr, lang, section }) => {
    section(st(lang, 'availability'));
    w.paragraph(st(lang, 'availabilityIntro'), { tone: 'muted', size: 8 });
    if (!d.monitors.length) {
      w.paragraph(st(lang, 'noMonitors'), { tone: 'muted' });
      return;
    }
    const min = chartMin(d.monitors.map((m) => m.uptime));
    uptimeBars(
      w,
      st(lang, 'chartMonitors', { min }),
      d.monitors.map((m) => ({ label: m.name, value: m.uptime, target: d.slaTarget })),
      min,
    );
    w.table(
      [
        { header: st(lang, 'monitor'), width: 3 },
        { header: st(lang, 'uptime'), width: 1.4, align: 'right' },
        { header: d.slaTarget !== null ? `${st(lang, 'sla')} ${pctText(lang, d.slaTarget)}` : st(lang, 'sla'), width: 1.4 },
        { header: st(lang, 'incidents'), width: 1.1, align: 'right' },
        { header: st(lang, 'downtime'), width: 1.4, align: 'right' },
        { header: st(lang, 'avgMs'), width: 1.1, align: 'right' },
        { header: st(lang, 'p95Ms'), width: 1.1, align: 'right' },
      ],
      d.monitors.map((m): CellInput[] => [
        { text: m.name, bold: true },
        pctText(lang, m.uptime),
        slaCell(lang, m.uptime, d.slaTarget),
        String(m.outages.length),
        m.downtimeMs ? tr.duration(m.downtimeMs) : '–',
        m.avgMs === null ? '–' : String(m.avgMs),
        m.p95Ms === null ? '–' : String(m.p95Ms),
      ]),
    );
    const outages = d.monitors.flatMap((m) => m.outages.map((o) => ({ name: m.name, ...o })));
    w.subheading(st(lang, 'outageList'));
    outageTable(w, tr, lang, st(lang, 'monitor'), outages);
  },
});

function outageTable(
  w: ReportWriter,
  tr: Translator,
  lang: ReportLang,
  what: string,
  outages: { name: string; from: string; to: string | null; durationMs: number }[],
): void {
  w.table(
    [
      { header: what, width: 3 },
      { header: st(lang, 'from'), width: 2 },
      { header: st(lang, 'to'), width: 2 },
      { header: st(lang, 'downtime'), width: 1.4, align: 'right' },
    ],
    outages
      .sort((a, b) => a.from.localeCompare(b.from))
      .slice(0, 500)
      .map((o): CellInput[] => [
        o.name,
        tr.dateTime(o.from),
        o.to ? tr.dateTime(o.to) : { text: st(lang, 'ongoing'), tone: 'danger' },
        tr.duration(o.durationMs),
      ]),
    { empty: st(lang, 'noIncidents'), size: 7.4 },
  );
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
interface GatusData {
  slaTarget: number | null;
  platforms: { id: string; name: string; note: string | null; endpoints: EndpointAvailability[] }[];
}

function visiblePlatform(id: string): { id: string; name: string } | null {
  try {
    const p = platforms.getPlatform(id);
    return p.permissions.length && p.kind === 'gatus' ? { id: p.id, name: p.name } : null;
  } catch {
    return null;
  }
}

registerReportSection<GatusConfig, GatusData>({
  id: 'gatus',
  schema: gatusSchema as unknown as ZodType<GatusConfig>,
  validate: (c) => {
    for (const s of c.sources)
      if (!visiblePlatform(s.platformId)) throw Object.assign(new Error(`Gatus platform ${s.platformId} not found`), { statusCode: 400 });
  },
  title: (l) => st(l, 'gatus'),
  build: (c, ctx) => ({
    slaTarget: c.slaTarget ?? null,
    platforms: c.sources.map((s) => {
      const p = visiblePlatform(s.platformId);
      if (!p) return { id: s.platformId, name: s.platformId, note: st(ctx.lang, 'notAccessible', { name: s.platformId }), endpoints: [] };
      if (!sourceRow(p.id)) return { id: p.id, name: p.name, note: st(ctx.lang, 'noMetrics', { name: p.name }), endpoints: [] };
      return { id: p.id, name: p.name, note: null, endpoints: gatusAvailability(p.id, s.endpointKeys, ctx.from, ctx.to) };
    }),
  }),
  glance: (d, l) => {
    const eps = d.platforms.flatMap((p) => p.endpoints);
    const ups = eps.map((e) => e.uptime).filter((x): x is number => x !== null);
    return [
      { label: `${st(l, 'avgUptime')} (Gatus)`, value: ups.length ? pctText(l, ups.reduce((s, x) => s + x, 0) / ups.length) : '–' },
      ...(d.slaTarget !== null
        ? [
            {
              label: `${st(l, 'slaMissedCount')} (Gatus)`,
              value: String(eps.filter((e) => e.uptime !== null && e.uptime < d.slaTarget!).length),
              tone: (eps.some((e) => e.uptime !== null && e.uptime < d.slaTarget!) ? 'danger' : 'success') as Tone,
            },
          ]
        : []),
    ];
  },
  render: (d, { w, tr, lang, section }) => {
    section(st(lang, 'gatus'));
    w.paragraph(st(lang, 'gatusIntro'), { tone: 'muted', size: 8 });
    for (const p of d.platforms) {
      w.subheading(p.name);
      if (p.note) {
        w.paragraph(p.note, { tone: 'muted' });
        continue;
      }
      if (!p.endpoints.length) {
        w.paragraph(st(lang, 'noEndpoints'), { tone: 'muted' });
        continue;
      }
      const min = chartMin(p.endpoints.map((e) => e.uptime));
      uptimeBars(
        w,
        st(lang, 'chartEndpoints', { min }),
        p.endpoints.map((e) => ({ label: `${e.group ? `${e.group}/` : ''}${e.name || e.key}`, value: e.uptime, target: d.slaTarget })),
        min,
      );
      w.table(
        [
          { header: st(lang, 'endpoint'), width: 3 },
          { header: st(lang, 'uptime'), width: 1.3, align: 'right' },
          { header: d.slaTarget !== null ? `${st(lang, 'sla')} ${pctText(lang, d.slaTarget)}` : st(lang, 'sla'), width: 1.3 },
          { header: st(lang, 'results'), width: 1.1, align: 'right' },
          { header: st(lang, 'failedResults'), width: 1.1, align: 'right' },
          { header: st(lang, 'incidents'), width: 1, align: 'right' },
          { header: st(lang, 'downtime'), width: 1.3, align: 'right' },
          { header: st(lang, 'avgMs'), width: 1, align: 'right' },
          { header: st(lang, 'p95Ms'), width: 1, align: 'right' },
        ],
        p.endpoints.map((e): CellInput[] => [
          { text: `${e.group ? `${e.group}/` : ''}${e.name || e.key}`, bold: true },
          pctText(lang, e.uptime),
          slaCell(lang, e.uptime, d.slaTarget),
          String(e.results),
          { text: String(e.failed), tone: e.failed ? 'danger' : 'default' },
          String(e.outages.length),
          e.downtimeMs ? tr.duration(e.downtimeMs) : '–',
          e.avgMs === null ? '–' : String(e.avgMs),
          e.p95Ms === null ? '–' : String(e.p95Ms),
        ]),
        { size: 7.4 },
      );
      w.subheading(st(lang, 'outageList'));
      outageTable(
        w,
        tr,
        lang,
        st(lang, 'endpoint'),
        p.endpoints.flatMap((e) => e.outages.map((o) => ({ name: `${e.group ? `${e.group}/` : ''}${e.name || e.key}`, ...o }))),
      );
    }
  },
});

// ---------- credentials ----------

const credentialsSchema = z.object({ dueWithinDays: z.number().int().min(0).max(365).default(30) });
type CredentialsConfig = z.infer<typeof credentialsSchema>;
interface CredentialRowData {
  id: string;
  name: string;
  type: string;
  platform: string;
  status: CredentialStatus;
  due: string;
  dueAt: string;
  owners: string;
}
interface CredentialsData {
  dueWithinDays: number;
  expired: CredentialRowData[];
  overdue: CredentialRowData[];
  dueSoon: CredentialRowData[];
}

registerReportSection<CredentialsConfig, CredentialsData>({
  id: 'credentials',
  schema: credentialsSchema as unknown as ZodType<CredentialsConfig>,
  title: (l) => st(l, 'credentials'),
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
  glance: (d, l) => [
    { label: st(l, 'expired'), value: String(d.expired.length), tone: d.expired.length ? 'danger' : 'default' },
    { label: st(l, 'overdue'), value: String(d.overdue.length), tone: d.overdue.length ? 'warning' : 'default' },
  ],
  render: (d, { w, tr, lang, section }) => {
    section(st(lang, 'credentials'));
    w.paragraph(st(lang, 'credentialsIntro', { days: d.dueWithinDays }), { tone: 'muted', size: 8 });
    w.stats([
      { label: st(lang, 'expired'), value: String(d.expired.length), tone: d.expired.length ? 'danger' : 'default' },
      { label: st(lang, 'overdue'), value: String(d.overdue.length), tone: d.overdue.length ? 'warning' : 'default' },
      { label: st(lang, 'dueSoon', { days: d.dueWithinDays }), value: String(d.dueSoon.length), tone: d.dueSoon.length ? 'info' : 'default' },
    ]);
    const table = (title: string, rows: CredentialRowData[], tone: Tone) => {
      if (!rows.length) return;
      w.subheading(title, tone);
      w.table(
        [
          { header: st(lang, 'name'), width: 2.6 },
          { header: st(lang, 'platform'), width: 1.6 },
          { header: st(lang, 'due'), width: 1.2 },
          { header: st(lang, 'dueDate'), width: 1.5 },
          { header: st(lang, 'owners'), width: 2.6 },
        ],
        rows
          .slice(0, 1000)
          .map((r): CellInput[] => [
            { text: r.name, bold: true },
            r.platform || '–',
            st(lang, `kind_${r.due}` as 'kind_expiry'),
            tr.date(r.dueAt),
            r.owners || '–',
          ]),
        { size: 7.4 },
      );
    };
    if (!d.expired.length && !d.overdue.length && !d.dueSoon.length) w.paragraph(st(lang, 'noCredentials'), { tone: 'muted' });
    table(st(lang, 'expired'), d.expired, 'danger');
    table(st(lang, 'overdue'), d.overdue, 'warning');
    table(st(lang, 'dueSoon', { days: d.dueWithinDays }), d.dueSoon, 'info');
  },
});

// ---------- runs ----------

const runsSchema = z.object({ processIds: z.array(z.string().min(1).max(100)).max(500).nullable().default(null) });
type RunsConfig = z.infer<typeof runsSchema>;
interface RunsData {
  processes: { id: string; name: string; total: number; succeeded: number; failed: number; other: number }[];
}

registerReportSection<RunsConfig, RunsData>({
  id: 'runs',
  schema: runsSchema as unknown as ZodType<RunsConfig>,
  validate: (c) => {
    for (const id of c.processIds ?? [])
      if (!processes.permissionsFor(id).includes('view')) throw Object.assign(new Error(`Process ${id} not found`), { statusCode: 400 });
  },
  title: (l) => st(l, 'runs'),
  build: (c, ctx) => {
    const visible = new Set(
      db()
        .all<{ id: string }>('SELECT id FROM processes')
        .filter((p) => processes.permissionsFor(p.id).includes('view'))
        .map((p) => p.id),
    );
    const rows = db().all<{ process_id: string; process_name: string; status: string; n: number }>(
      'SELECT process_id, process_name, status, COUNT(*) AS n FROM runs WHERE started_at >= ? AND started_at < ? GROUP BY process_id, process_name, status',
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
  glance: (d, l) => {
    const failed = d.processes.reduce((s, p) => s + p.failed, 0);
    return [{ label: st(l, 'failedRuns'), value: String(failed), tone: failed ? 'danger' : 'default' }];
  },
  render: (d, { w, lang, section }) => {
    section(st(lang, 'runs'));
    w.paragraph(st(lang, 'runsIntro'), { tone: 'muted', size: 8 });
    w.table(
      [
        { header: st(lang, 'process'), width: 3.4 },
        { header: st(lang, 'total'), width: 1.2, align: 'right' },
        { header: st(lang, 'succeeded'), width: 1.3, align: 'right' },
        { header: st(lang, 'failed'), width: 1.3, align: 'right' },
        { header: st(lang, 'other'), width: 1.2, align: 'right' },
      ],
      d.processes.map((p): CellInput[] => [
        { text: p.name, bold: true },
        String(p.total),
        String(p.succeeded),
        { text: String(p.failed), tone: p.failed ? 'danger' : 'default' },
        String(p.other),
      ]),
      { empty: st(lang, 'noRuns') },
    );
  },
});

/** Validates and normalises the sections of a schedule (unknown sections are rejected). */
export function parseSections(input: unknown): Record<string, unknown> {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [id, cfg] of Object.entries(raw)) {
    if (cfg === null || cfg === undefined || cfg === false) continue;
    const def = SECTIONS.get(id);
    if (!def) throw Object.assign(new Error(`Unknown report section "${id}"`), { statusCode: 400 });
    const r = def.schema.safeParse(cfg === true ? {} : cfg);
    if (!r.success)
      throw Object.assign(new Error(`Section "${id}": ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`), { statusCode: 400 });
    out[id] = r.data;
  }
  if (!Object.keys(out).length) throw Object.assign(new Error('Select at least one section'), { statusCode: 400 });
  return out;
}

export const sectionOrder = (ids: string[]): string[] => reportSectionIds().filter((id) => ids.includes(id));

export const parseSectionsJson = (s: string): Record<string, unknown> => parseJson<Record<string, unknown>>(s, {});
