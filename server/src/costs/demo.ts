import {
  AWS_KIND,
  CONFLUENT_KIND,
  addDays,
  addMonths,
  fiscalYearMonths,
  fiscalYearOf,
  fromMicros,
  LLM_GATEWAY_KIND,
  SNOWFLAKE_KIND,
  supplierContractInput,
  supplierInput,
  toMicros,
  yearAmountsFromPercent,
} from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { nowIso } from '../util.js';
import { readSource } from './sources.js';
import { tagKeyOf } from './store.js';
import { costSettings, setCostSettings } from './access.js';
import { addEntry, addPlanLine, bookLine, planYear, today } from './plans.js';
import { addSchedule, confirmProposals } from './schedules.js';
import { importEntries } from './entry-import.js';
import { addContract, createSupplier } from '../suppliers/service.js';

/**
 * Demo costs (#226): the cost sources of the demo platforms – AWS (demo), Snowflake (demo), Confluent Cloud (demo) and
 * LLM gateway (demo) – turned on and read once, so the costs pages, the budget and the reports have figures. The
 * mocks answer like the real APIs (Cost Explorer, USAGE_IN_CURRENCY_DAILY, the Costs API).
 */
export async function setupCostDemo(actor: string): Promise<number> {
  const rows = db()
    .all<{ id: string; name: string; kind: string }>(
      `SELECT id, name, kind FROM platforms WHERE kind IN (?, ?, ?, ?) ORDER BY name`,
      AWS_KIND,
      SNOWFLAKE_KIND,
      CONFLUENT_KIND,
      LLM_GATEWAY_KIND,
    )
    .filter((p) => p.name.endsWith('(demo)'));
  let read = 0;
  for (const p of rows) {
    if (db().get('SELECT platform_id FROM cost_sources WHERE platform_id = ? AND enabled = 1', p.id)) continue;
    const now = nowIso();
    db().run(
      `INSERT INTO cost_sources (platform_id, enabled, tag_key, currency, updated_at, updated_by) VALUES (?, 1, ?, ?, ?, ?)
       ON CONFLICT (platform_id) DO UPDATE SET enabled = 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      p.id,
      tagKeyOf(p.id),
      p.kind === LLM_GATEWAY_KIND ? 'USD' : null,
      now,
      actor,
    );
    try {
      const r = await readSource(p.id, actor);
      if (r.error) logger.warn({ platform: p.id, error: r.error }, 'demo costs not read');
      else read++;
    } catch (err) {
      logger.warn({ err: (err as Error).message, platform: p.id }, 'demo costs not read');
    }
  }
  return read;
}

/**
 * Demo cost plans (0.16.0, ADR 0026): the demo's fiscal year starts in October (the instance default stays January),
 * and two demo services get a plan for the current fiscal year with a few entries – invented products, vendors and
 * numbers. Only when the services have no plan yet.
 */
export function setupCostPlanDemo(services: { shop?: string; plant?: string }, now = Date.now()): number {
  const ids = [services.shop, services.plant].filter((x): x is string => !!x);
  if (!ids.length || db().get(`SELECT id FROM cost_plan_lines WHERE service_id IN (${ids.map(() => '?').join(', ')}) LIMIT 1`, ...ids)) return 0;
  const s = costSettings();
  if (s.fiscalYearStartMonth === 1) setCostSettings({ ...s, fiscalYearStartMonth: 10 });
  const start = costSettings().fiscalYearStartMonth;
  const fy = fiscalYearOf(new Date(now).toISOString().slice(0, 7), start);
  const months = fiscalYearMonths(fy, start);
  const dayIn = (i: number, d: number) => `${months[i]}-${String(d).padStart(2, '0')}`;
  const inDays = (n: number) => new Date(now + n * 86_400_000).toISOString().slice(0, 10);
  const app = (name: string) => db().get<{ id: string }>('SELECT id FROM applications WHERE name = ?', name)?.id;
  const system = (name: string) => db().get<{ id: string }>('SELECT id FROM systems WHERE name = ?', name)?.id;
  let n = 0;
  const line = (serviceId: string, body: Record<string, unknown>): string | undefined => {
    try {
      const y = addPlanLine(serviceId, { fiscalYear: fy, ...body });
      n++;
      return y.lines.find((l) => l.title === body.title)?.id;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'demo plan line not added');
      return undefined;
    }
  };
  const entry = (serviceId: string, body: Record<string, unknown>) => {
    try {
      addEntry(serviceId, body);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'demo cost entry not added');
    }
  };
  if (services.shop) {
    const shop = services.shop;
    const webshop = app('Webshop (demo)');
    const cluster = system('k8s-shop-01 (demo)');
    line(shop, {
      title: 'Cloud hosting of the webshop',
      category: 'cloud',
      target: webshop ? { kind: 'application', id: webshop } : null,
      vendor: 'AWS account of the shop',
      amount: '900',
      currency: 'USD',
      cadence: 'monthly',
      note: 'Compared with the costs read from AWS (demo).',
    });
    const support = line(shop, {
      title: 'Cluster support subscription',
      category: 'support',
      target: cluster ? { kind: 'system', id: cluster } : null,
      vendor: 'Atlas Container Support (invented), contract AC-7731',
      amount: '1200',
      currency: 'EUR',
      cadence: 'monthly',
    });
    if (support) entry(shop, { date: dayIn(0, 3), amount: '1200', currency: 'EUR', planLineId: support, reference: 'INV-AC-10031' });
    entry(shop, { date: dayIn(0, 21), amount: '650', currency: 'EUR', reference: 'PO-55821', note: 'Load test tool for the autumn sale, one month' });
  }
  if (services.plant) {
    const plant = services.plant;
    const licences = line(plant, {
      title: 'Historian licences',
      category: 'licence',
      vendor: 'Kestrel Historian by Brightfield Industrial Software (invented)',
      amount: '24000',
      currency: 'EUR',
      cadence: 'yearly',
      renewalDate: inDays(75),
      note: '25 tag packs for the press lines',
    });
    line(plant, {
      title: 'Historian support and maintenance',
      category: 'support',
      vendor: 'Brightfield Industrial Software (invented)',
      amount: '4800',
      currency: 'EUR',
      cadence: 'yearly',
    });
    line(plant, {
      title: 'Edge gateway hardware refresh',
      category: 'hardware',
      amount: '7500',
      currency: 'EUR',
      cadence: 'once',
      onceMonth: months[5],
    });
    if (licences) entry(plant, { date: dayIn(0, 3), amount: '24000', currency: 'EUR', planLineId: licences, reference: 'INV-BIS-88412' });
    entry(plant, { date: dayIn(0, 28), amount: '420', currency: 'EUR', reference: 'PO-55790', note: 'Spare power meter' });
  }
  return n;
}

/**
 * Demo contract payments (0.18.0, ADR 0030) – invented, like everything in the demo:
 *  - the shop's payment gateway licence: a three-year contract of Paylumen from the middle of the last fiscal year,
 *    billed monthly with +3 % per contract year; its lines of the current fiscal year confirmed and the months that
 *    are over booked;
 *  - a historian analytics add-on of the plant, prepaid for three years in the last fiscal year (a quiet "Prepaid"
 *    row in this one), from Brightfield Industrial Software;
 *  - an imported CSV of entries (an ERP export with a duplicate row) on the shop, kept as an import record.
 * Only when no payment schedule exists yet. Returns the number of plan lines it added.
 */
export function setupContractPaymentDemo(
  services: { shop?: string; plant?: string },
  suppliers: { payments: string; cloud: string } | null,
  owners: string[],
  now = Date.now(),
): number {
  if (!suppliers || !services.shop || db().get('SELECT id FROM cost_schedules LIMIT 1')) return 0;
  const start = costSettings().fiscalYearStartMonth;
  const day = today(now);
  const fy = fiscalYearOf(day, start);
  const last = fiscalYearMonths(fy - 1, start);
  const contractOf = (supplierId: string, title: string) =>
    db().get<{ id: string }>('SELECT id FROM supplier_contracts WHERE supplier_id = ? AND title = ?', supplierId, title)?.id;
  let lines = 0;
  // ---- the payment gateway licence: three years, monthly, +3 % per contract year ----
  const gwStart = `${last[4]}-01`;
  addContract(
    suppliers.payments,
    supplierContractInput.parse({
      title: 'Payment gateway licence',
      reference: 'PL-GW-2026',
      startsOn: gwStart,
      endsOn: addDays(addMonths(gwStart, 36), -1),
      noticeDays: 90,
      renewal: 'fixedEnd',
      note: 'Card payments of the online shop, billed monthly (invented)',
    }),
  );
  const gw = contractOf(suppliers.payments, 'Payment gateway licence');
  if (gw) {
    const l = addSchedule({
      contractId: gw,
      serviceId: services.shop,
      title: 'Licence fee',
      category: 'licence',
      amount: '1500',
      currency: 'EUR',
      billing: 'monthly',
      yearAmounts: yearAmountsFromPercent(toMicros('1500')!, 3, 'EUR', 2).map((v) => fromMicros(v)),
    });
    const scheduleId = l.schedules[0]?.id;
    if (scheduleId) {
      const y = confirmProposals(services.shop, { fiscalYear: fy, scheduleIds: [scheduleId] });
      lines += y.lines.filter((x) => x.schedule?.id === scheduleId).length;
      // the months that are over are booked; the current one is left for a person ("Not booked")
      for (const x of y.lines.filter((z) => z.schedule?.id === scheduleId))
        for (const m of x.notBooked.filter((mo) => mo < day.slice(0, 7)))
          try {
            bookLine(services.shop, x.id, { month: m, reference: `PL-${m}` }, now);
          } catch (err) {
            logger.warn({ err: (err as Error).message }, 'demo payment not booked');
          }
    }
  }
  // ---- the plant's historian analytics add-on, prepaid for three years ----
  if (services.plant) {
    const vendor = createSupplier(
      supplierInput.parse({
        name: 'Brightfield Industrial Software',
        type: 'softwareVendor',
        description: 'Maker of the Kestrel historian of the plant (invented).',
        website: 'https://brightfield.example',
        owners,
      }),
    );
    // the plan's free-text vendor lines name it
    db().run(
      "UPDATE cost_plan_lines SET supplier_id = ? WHERE service_id = ? AND supplier_id IS NULL AND lower(vendor) LIKE '%brightfield%'",
      vendor.id,
      services.plant,
    );
    const addOnStart = `${last[2]}-01`;
    addContract(
      vendor.id,
      supplierContractInput.parse({
        title: 'Historian analytics add-on',
        reference: 'BIS-AN-3Y',
        startsOn: addOnStart,
        endsOn: addDays(addMonths(addOnStart, 36), -1),
        renewal: 'fixedEnd',
        note: 'Three years, paid up front (invented)',
      }),
    );
    const addOn = contractOf(vendor.id, 'Historian analytics add-on');
    if (addOn) {
      const l = addSchedule({
        contractId: addOn,
        serviceId: services.plant,
        title: 'Three years prepaid',
        category: 'licence',
        amount: '9000',
        currency: 'EUR',
        billing: 'once',
      });
      const scheduleId = l.schedules[0]?.id;
      if (scheduleId) {
        const y = confirmProposals(services.plant, { fiscalYear: fy - 1, scheduleIds: [scheduleId] });
        const line = y.lines.find((x) => x.schedule?.id === scheduleId);
        if (line) {
          lines++;
          try {
            bookLine(services.plant, line.id, { month: line.onceMonth ?? undefined, reference: 'INV-BIS-90117' }, now);
          } catch (err) {
            logger.warn({ err: (err as Error).message }, 'demo prepaid payment not booked');
          }
        }
      }
    }
  }
  // ---- an ERP export of the shop's invoices, imported (one row sent twice: left out as a duplicate) ----
  const months = fiscalYearMonths(fy, start).filter((m) => `${m}-14` <= day);
  const de = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
  const rows = months.flatMap((m, i) => [
    `${de(`${m}-14`)};EC-INV-${88120 + i};Example Cloud GmbH;2.310,40;EUR;Managed Kubernetes, usage of the month before`,
    ...(i === 0
      ? [
          `${de(`${m}-14`)};MISC-4471;;189,90;EUR;Conference tickets for the shop team`,
          `${de(`${m}-14`)};MISC-4471;;189,90;EUR;The same, sent twice by the ERP`,
        ]
      : []),
  ]);
  if (rows.length)
    try {
      importEntries(services.shop, {
        csv: ['Belegdatum;Rechnungsnummer;Lieferant;Betrag;Währung;Text', ...rows].join('\r\n'),
        fileName: 'erp-export-demo.csv',
        mapping: {
          date: 'Belegdatum',
          amount: 'Betrag',
          currency: 'Währung',
          reference: 'Rechnungsnummer',
          supplier: 'Lieferant',
          note: 'Text',
          dateFormat: 'DD.MM.YYYY',
          decimal: ',',
        },
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'demo entries not imported');
    }
  // read once more, so a failing step above shows in the log rather than half a plan
  planYear(services.shop, fy, now);
  return lines;
}
