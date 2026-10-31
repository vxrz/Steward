import { z, type ZodType } from 'zod';
import { isTicketOpen, type ReportLang, type TicketStatus } from '@sm/shared';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { registerReportSection } from '../reports/sections.js';
import type { CellInput, Tone } from '../reports/pdf/engine.js';
import { ticketSettings } from './service.js';
import { ticketVisible } from './service.js';
import { canViewCatalogue } from '../records/access.js';
import { parseJson } from '../util.js';

/**
 * "Ticket references" section of scheduled summary reports: tickets open at
 * the end of the period per service and per vendor with their age, tickets
 * opened and resolved in the period, and the mean time to resolution per
 * vendor (of the tickets resolved in the period).
 *
 * "Open at the end of the period" follows from the opening and resolution
 * dates (opened before the end, not resolved by then), so a report generated
 * later for the same period shows the same figures. Ticket references are
 * readable by everyone who can sign in; affected services are named as such
 * (the catalogue is readable by everyone too).
 */

const DAY = 86400000;
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

const schema = z
  .object({
    /** Ticket source keys; null: all sources */
    sources: z.array(z.string().max(40)).max(30).nullable().default(null),
  })
  .strict();
type TicketsConfig = z.infer<typeof schema>;

interface OpenTicket {
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

interface Row {
  id: string;
  source: string;
  external_number: string;
  title: string;
  vendor: string;
  status: TicketStatus;
  opened_at: string;
  resolved_at: string | null;
  responsible: string;
}

const openStatus = (s: TicketStatus): TicketStatus => (isTicketOpen(s) ? s : 'open');

const group = (items: OpenTicket[], keys: (t: OpenTicket) => string[]) => {
  const m = new Map<string, number[]>();
  for (const t of items) for (const k of keys(t)) m.set(k, [...(m.get(k) ?? []), t.ageDays]);
  return [...m]
    .map(([name, ages]) => ({ name, count: ages.length, avgAgeDays: Math.round(ages.reduce((a, b) => a + b, 0) / ages.length), oldestDays: Math.max(...ages) }))
    .sort((a, b) => b.count - a.count || b.oldestDays - a.oldestDays || a.name.localeCompare(b.name));
};

function build(c: TicketsConfig, ctx: { from: number; to: number; now: number }): TicketsSectionData {
  const out: TicketsSectionData = { open: [], openedCount: 0, resolvedCount: 0, mttrHours: null, perService: [], perVendor: [], mttrPerVendor: [] };
  if (!currentUser()) return out;
  const end = Math.min(ctx.to, ctx.now);
  const endIso = new Date(end).toISOString();
  const fromIso = new Date(ctx.from).toISOString();
  const toIso = new Date(ctx.to).toISOString();
  const rows = db()
    .all<Row>(
      'SELECT id, source, external_number, title, vendor, status, opened_at, resolved_at, responsible FROM ticket_refs WHERE opened_at < ? ORDER BY opened_at, id',
      toIso,
    )
    .filter((r) => !c.sources || c.sources.includes(r.source))
    .filter((r) => ticketVisible(r));
  if (!rows.length) return out;
  const services = new Map<string, string[]>();
  for (const l of db()
    .all<{ from_id: string; name: string; id: string; owners: string }>(
      "SELECT l.from_id, s.name, s.id, s.owners FROM item_links l JOIN services s ON s.id = l.to_id WHERE l.from_kind = 'ticket' AND l.to_kind = 'service' ORDER BY s.name",
    )
    .filter((x) => canViewCatalogue(currentUser(), { kind: 'service', id: x.id, owners: parseJson<string[]>(x.owners, []) })))
    services.set(l.from_id, [...(services.get(l.from_id) ?? []), l.name]);

  // the status at the end of the period: the newest status event up to then
  const statusAt = new Map<string, TicketStatus>();
  for (const e of db().all<{ ticket_id: string; to_status: TicketStatus }>(
    "SELECT ticket_id, to_status FROM ticket_ref_events WHERE kind IN ('created', 'status') AND to_status IS NOT NULL AND ts <= ? ORDER BY id",
    endIso,
  ))
    statusAt.set(e.ticket_id, e.to_status);

  const resolvedTimes: { vendor: string; hours: number }[] = [];
  for (const r of rows) {
    if (r.opened_at >= fromIso && r.opened_at < toIso) out.openedCount++;
    if (r.resolved_at && r.resolved_at >= fromIso && r.resolved_at < toIso) {
      out.resolvedCount++;
      resolvedTimes.push({ vendor: r.vendor, hours: Math.max(0, (Date.parse(r.resolved_at) - Date.parse(r.opened_at)) / 3600000) });
    }
    const openAtEnd = r.opened_at <= endIso && (!r.resolved_at || r.resolved_at > endIso);
    if (openAtEnd)
      out.open.push({
        number: r.external_number,
        title: r.title,
        vendor: r.vendor,
        // entered later than the end of the period (no event by then): its current status if open, else "open"
        status: openStatus(statusAt.get(r.id) ?? (r.resolved_at ? 'open' : r.status)),
        services: services.get(r.id) ?? [],
        ageDays: Math.max(0, Math.floor((end - Date.parse(r.opened_at)) / DAY)),
      });
  }
  out.open.sort((a, b) => b.ageDays - a.ageDays || a.number.localeCompare(b.number));
  out.perService = group(out.open, (t) => (t.services.length ? t.services : ['']));
  out.perVendor = group(out.open, (t) => [t.vendor]);
  if (resolvedTimes.length) out.mttrHours = resolvedTimes.reduce((a, b) => a + b.hours, 0) / resolvedTimes.length;
  const byVendor = new Map<string, number[]>();
  for (const x of resolvedTimes) byVendor.set(x.vendor, [...(byVendor.get(x.vendor) ?? []), x.hours]);
  out.mttrPerVendor = [...byVendor]
    .map(([name, hs]) => ({ name, resolved: hs.length, mttrHours: hs.reduce((a, b) => a + b, 0) / hs.length }))
    .sort((a, b) => b.resolved - a.resolved || a.name.localeCompare(b.name));
  return out;
}

const duration = (lang: ReportLang, hours: number | null): string => {
  if (hours === null) return '–';
  return hours < 48 ? fill(tx(lang).hours, { n: Math.round(hours) }) : fill(tx(lang).days, { n: Math.round((hours / 24) * 10) / 10 });
};

registerReportSection<TicketsConfig, TicketsSectionData>({
  id: 'tickets',
  schema: schema as unknown as ZodType<TicketsConfig>,
  validate: (c) => {
    if (!c.sources) return;
    const known = new Set(ticketSettings().sources.map((s) => s.key));
    const missing = c.sources.filter((k) => !known.has(k));
    if (missing.length) throw Object.assign(new Error(`Ticket source(s) not found: ${missing.join(', ')}`), { statusCode: 400 });
  },
  title: (l) => tx(l).title,
  build,
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
});
