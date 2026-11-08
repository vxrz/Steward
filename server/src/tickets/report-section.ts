import { z, type ZodType } from 'zod';
import { isTicketOpen, type TicketStatus } from '@sm/shared';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { ticketSettings } from './service.js';
import { ticketVisible } from './service.js';
import { canViewCatalogue } from '../records/access.js';
import { parseJson } from '../util.js';
import { defineReportSection } from '../reports/sections.js';
import { ticketsSectionDraw, type OpenTicket, type TicketsSectionData } from './report-section-draw.js';

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

const schema = z
  .object({
    /** Ticket source keys; null: all sources */
    sources: z.array(z.string().max(40)).max(30).nullable().default(null),
  })
  .strict();

type TicketsConfig = z.infer<typeof schema>;

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

export const ticketsSection = defineReportSection<TicketsConfig, TicketsSectionData>({
  ...ticketsSectionDraw,
  schema: schema as unknown as ZodType<TicketsConfig>,
  validate: (c) => {
    if (!c.sources) return;
    const known = new Set(ticketSettings().sources.map((s) => s.key));
    const missing = c.sources.filter((k) => !known.has(k));
    if (missing.length) throw Object.assign(new Error(`Ticket source(s) not found: ${missing.join(', ')}`), { statusCode: 400 });
  },
  build,
});
