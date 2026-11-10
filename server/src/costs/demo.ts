import { AWS_KIND, CONFLUENT_KIND, fiscalYearMonths, fiscalYearOf, LLM_GATEWAY_KIND, SNOWFLAKE_KIND } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { nowIso } from '../util.js';
import { readSource } from './sources.js';
import { tagKeyOf } from './store.js';
import { costSettings, setCostSettings } from './access.js';
import { addEntry, addPlanLine } from './plans.js';

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
    const payments = line(shop, {
      title: 'Payment gateway licence',
      category: 'licence',
      vendor: 'Corvid Payments (invented)',
      amount: '18000',
      currency: 'EUR',
      cadence: 'yearly',
      renewalDate: inDays(60),
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
    if (payments) entry(shop, { date: dayIn(0, 15), amount: '18000', currency: 'EUR', planLineId: payments, reference: 'INV-CP-2026-0915' });
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
