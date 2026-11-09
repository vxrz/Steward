import type { ReportLang, TicketStatus } from '@sm/shared';
import type { CellInput, Tone } from '../reports/pdf/engine.js';
import type { ReportSectionDraw } from '../reports/section-draw.js';

/**
 * The draw half of the section of scheduled summary reports in report-section.ts (which collects its data): data
 * in, PDF out – it runs in the PDF worker (reports/section-draw.ts).
 */

const MAX_ROWS = 300;

const en = {
  title: 'Ticket references',
  intro:
    'Tickets in other systems (ServiceNow incidents, vendor tickets) documented in Steward: open at the end of the period, opened and resolved in the period, and the mean time to resolution per vendor of the tickets resolved in the period.',
  openAtEnd: 'Open at the end',
  opened: 'Opened in the period',
  resolved: 'Resolved in the period',
  mttr: 'Mean time to resolution',
  perService: 'Open tickets per service',
  perVendor: 'Open tickets per vendor',
  openList: 'Open tickets',
  mttrPerVendor: 'Mean time to resolution per vendor',
  service: 'Service',
  vendor: 'Vendor',
  count: 'Open',
  avgAge: 'Average age',
  oldest: 'Oldest',
  number: 'Number',
  ticketTitle: 'Title',
  status: 'Status',
  age: 'Age',
  resolvedCount: 'Resolved',
  noVendor: '(no vendor)',
  noService: '(no service)',
  none: 'No open tickets at the end of the period.',
  noneResolved: 'No tickets were resolved in the period.',
  days: '{n} d',
  hours: '{n} h',
  more: '{n} more not shown.',
  statuses: { open: 'Open', waitingVendor: 'Waiting for vendor', waitingUs: 'Waiting for us', resolved: 'Resolved', closed: 'Closed' },
};

type Texts = typeof en;

const de: Texts = {
  title: 'Ticket-Referenzen',
  intro:
    'In Steward dokumentierte Tickets in anderen Systemen (ServiceNow-Incidents, Hersteller-Tickets): am Ende des Zeitraums offen, im Zeitraum eröffnet und gelöst, und die mittlere Lösungszeit je Hersteller der im Zeitraum gelösten Tickets.',
  openAtEnd: 'Offen am Ende',
  opened: 'Im Zeitraum eröffnet',
  resolved: 'Im Zeitraum gelöst',
  mttr: 'Mittlere Lösungszeit',
  perService: 'Offene Tickets je Service',
  perVendor: 'Offene Tickets je Hersteller',
  openList: 'Offene Tickets',
  mttrPerVendor: 'Mittlere Lösungszeit je Hersteller',
  service: 'Service',
  vendor: 'Hersteller',
  count: 'Offen',
  avgAge: 'Mittleres Alter',
  oldest: 'Ältestes',
  number: 'Nummer',
  ticketTitle: 'Titel',
  status: 'Status',
  age: 'Alter',
  resolvedCount: 'Gelöst',
  noVendor: '(kein Hersteller)',
  noService: '(kein Service)',
  none: 'Am Ende des Zeitraums waren keine Tickets offen.',
  noneResolved: 'Im Zeitraum wurden keine Tickets gelöst.',
  days: '{n} T',
  hours: '{n} Std.',
  more: '{n} weitere nicht angezeigt.',
  statuses: { open: 'Offen', waitingVendor: 'Wartet auf Hersteller', waitingUs: 'Wartet auf uns', resolved: 'Gelöst', closed: 'Geschlossen' },
};

const tx = (lang: ReportLang): Texts => (lang === 'de' ? de : en);

const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));

export interface OpenTicket {
  number: string;
  title: string;
  vendor: string;
  status: TicketStatus;
  services: string[];
  ageDays: number;
}

export interface TicketsSectionData {
  open: OpenTicket[];
  openedCount: number;
  resolvedCount: number;
  /** Mean time to resolution of all tickets resolved in the period, in hours (null: none resolved) */
  mttrHours: number | null;
  perService: { name: string; count: number; avgAgeDays: number; oldestDays: number }[];
  perVendor: { name: string; count: number; avgAgeDays: number; oldestDays: number }[];
  mttrPerVendor: { name: string; resolved: number; mttrHours: number }[];
}

const duration = (lang: ReportLang, hours: number | null): string => {
  if (hours === null) return '–';
  return hours < 48 ? fill(tx(lang).hours, { n: Math.round(hours) }) : fill(tx(lang).days, { n: Math.round((hours / 24) * 10) / 10 });
};

export const ticketsSectionDraw: ReportSectionDraw<TicketsSectionData> = {
  id: 'tickets',
  title: (l) => tx(l).title,
  glance: (d, l) => [{ label: tx(l).openAtEnd, value: String(d.open.length), tone: (d.open.length ? 'info' : 'default') as Tone }],
  render: (d, { w, lang, section }) => {
    const x = tx(lang);
    const days = (n: number) => fill(x.days, { n });
    section(x.title);
    w.paragraph(x.intro, { tone: 'muted', size: 8 });
    w.stats([
      { label: x.openAtEnd, value: String(d.open.length), tone: d.open.length ? 'info' : 'default' },
      { label: x.opened, value: String(d.openedCount) },
      { label: x.resolved, value: String(d.resolvedCount), tone: d.resolvedCount ? 'success' : 'default' },
      { label: x.mttr, value: duration(lang, d.mttrHours) },
    ]);
    if (!d.open.length) w.paragraph(x.none, { tone: 'muted' });
    else {
      const cols = (first: string) => [
        { header: first, width: 3 },
        { header: x.count, width: 1, align: 'right' as const },
        { header: x.avgAge, width: 1.3, align: 'right' as const },
        { header: x.oldest, width: 1.2, align: 'right' as const },
      ];
      w.subheading(x.perService);
      w.table(
        cols(x.service),
        d.perService.map((g): CellInput[] => [g.name || { text: x.noService, tone: 'muted' }, String(g.count), days(g.avgAgeDays), days(g.oldestDays)]),
        { size: 7.4 },
      );
      w.subheading(x.perVendor);
      w.table(
        cols(x.vendor),
        d.perVendor.map((g): CellInput[] => [g.name || { text: x.noVendor, tone: 'muted' }, String(g.count), days(g.avgAgeDays), days(g.oldestDays)]),
        { size: 7.4 },
      );
      w.subheading(x.openList);
      w.table(
        [
          { header: x.number, width: 1.5, mono: true },
          { header: x.ticketTitle, width: 3.2 },
          { header: x.vendor, width: 1.4 },
          { header: x.service, width: 1.8 },
          { header: x.status, width: 1.4 },
          { header: x.age, width: 0.8, align: 'right' },
        ],
        d.open
          .slice(0, MAX_ROWS)
          .map((t): CellInput[] => [
            t.number,
            { text: t.title, bold: true },
            t.vendor || '–',
            t.services.join(', ') || '–',
            x.statuses[t.status],
            { text: days(t.ageDays), tone: t.ageDays >= 30 ? 'danger' : 'default' },
          ]),
        { size: 7.4 },
      );
      if (d.open.length > MAX_ROWS) w.paragraph(fill(x.more, { n: d.open.length - MAX_ROWS }), { tone: 'muted', size: 7.4 });
    }
    w.subheading(x.mttrPerVendor);
    w.table(
      [
        { header: x.vendor, width: 3 },
        { header: x.resolvedCount, width: 1, align: 'right' },
        { header: x.mttr, width: 1.6, align: 'right' },
      ],
      d.mttrPerVendor.map((g): CellInput[] => [g.name || { text: x.noVendor, tone: 'muted' }, String(g.resolved), duration(lang, g.mttrHours)]),
      { empty: x.noneResolved, size: 7.4 },
    );
  },
};
