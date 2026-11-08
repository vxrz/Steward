import type { CredentialStatus, ReportLang } from '@sm/shared';
import type { EndpointAvailability } from '../gatus/metrics.js';
import { COLORS, type CellInput, type ReportWriter, type Tone } from './pdf/engine.js';
import type { Translator } from './i18n.js';
import { pctText, st } from './scheduled-i18n.js';
import type { ReportSectionDraw } from './section-draw.js';

/**
 * The draw halves of the built-in sections of scheduled summary reports (builtin-sections.ts collects their data):
 * data in, PDF out – they run in the PDF worker (section-draw.ts).
 */

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

export interface MonitorAvail {
  id: string;
  key: string;
  name: string;
  uptime: number | null;
  outages: { from: string; to: string | null; durationMs: number }[];
  downtimeMs: number;
  avgMs: number | null;
  p95Ms: number | null;
}

export interface AvailabilityData {
  slaTarget: number | null;
  monitors: MonitorAvail[];
}

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

export interface GatusData {
  slaTarget: number | null;
  platforms: { id: string; name: string; note: string | null; endpoints: EndpointAvailability[] }[];
}

export interface CredentialRowData {
  id: string;
  name: string;
  type: string;
  platform: string;
  status: CredentialStatus;
  due: string;
  dueAt: string;
  owners: string;
}

export interface CredentialsData {
  dueWithinDays: number;
  expired: CredentialRowData[];
  overdue: CredentialRowData[];
  dueSoon: CredentialRowData[];
}

export interface RunsData {
  processes: { id: string; name: string; total: number; succeeded: number; failed: number; other: number }[];
}

export const availabilitySectionDraw: ReportSectionDraw<AvailabilityData> = {
  id: 'availability',
  title: (l) => st(l, 'availability'),
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
};
export const gatusSectionDraw: ReportSectionDraw<GatusData> = {
  id: 'gatus',
  title: (l) => st(l, 'gatus'),
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
};
export const credentialsSectionDraw: ReportSectionDraw<CredentialsData> = {
  id: 'credentials',
  title: (l) => st(l, 'credentials'),
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
};
export const runsSectionDraw: ReportSectionDraw<RunsData> = {
  id: 'runs',
  title: (l) => st(l, 'runs'),
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
};
