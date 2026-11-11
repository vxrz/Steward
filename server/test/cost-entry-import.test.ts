import { beforeAll, describe, expect, it } from 'vitest';
import { fiscalYearMonths, fiscalYearOf, lastDayOf, type CostPlanYear } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Recording incurred costs (0.18.0, ADR 0030 part 6, docs/COSTS.md#recording-incurred-costs): "Book" on a plan line
 * (defaults, booked twice, yearly lines refused, months to come refused, session only), the "Not booked" marks, entries
 * with a supplier and a contract.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let olivia: Client;
let vera: Client;
let service: string;
let supplier: string;
let contract: string;
/** Today in the instance's time zone, its month and the current fiscal year (start January) */
let today: string;
let month: string;
let fy: number;
let months: string[];
let cur: number;

const plan = (fiscalYear = fy): Promise<CostPlanYear> => s.api('GET', `/costs/plans/${service}?fiscalYear=${fiscalYear}`);
const lineOf = (y: CostPlanYear, title: string) => y.lines.find((l) => l.title === title)!;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  olivia = await s.as('olivia', PW);
  vera = await s.as('vera', PW);
  const { instanceTimeZone, localDate } = await import('../src/duties/periods.js');
  const d = localDate(Date.now(), instanceTimeZone());
  today = `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  month = today.slice(0, 7);
  await s.api('PUT', '/costs/settings', { hideAmountsFromViewers: false, defaultCurrency: 'EUR', fiscalYearStartMonth: 1 });
  fy = fiscalYearOf(month, 1);
  months = fiscalYearMonths(fy, 1);
  cur = months.indexOf(month);
  service = (await s.api('POST', '/services', { name: 'Booked service', owners: ['user:olivia'] })).id;
  supplier = (await s.api('POST', '/suppliers', { name: 'Booking Hosting GmbH', type: 'managedPlatform' })).id;
  const sup = await s.api('POST', `/suppliers/${supplier}/contracts`, {
    title: 'Hosting',
    reference: 'H-1',
    startsOn: `${fy}-01-01`,
    endsOn: `${fy + 2}-12-31`,
  });
  contract = sup.contracts[0].id;
}, 240_000);

describe('Book', () => {
  it('books the current month of a monthly line with the line’s amount, currency, supplier and contract', async () => {
    const y: CostPlanYear = await olivia('POST', `/costs/plans/${service}/lines`, {
      fiscalYear: fy,
      title: 'Hosting fee',
      category: 'support',
      amount: '1000',
      currency: 'EUR',
      cadence: 'monthly',
      supplierId: supplier,
      supplierContractId: contract,
    });
    const line = lineOf(y, 'Hosting fee');
    expect(line.bookable).toBe(true);
    // every month that is over and the current one has a payment and no entry yet
    expect(line.notBooked).toEqual(months.slice(0, cur + 1));
    const after: CostPlanYear = await olivia('POST', `/costs/plans/${service}/lines/${line.id}/book`, { reference: 'INV-B1' });
    const e = after.entries.find((x) => x.reference === 'INV-B1')!;
    expect(e).toMatchObject({ date: today, amount: '1000.00', currency: 'EUR', planLineId: line.id, unplanned: false });
    expect(e.supplier?.id).toBe(supplier);
    expect(e.supplierContract?.id).toBe(contract);
    expect(lineOf(after, 'Hosting fee').notBooked).not.toContain(month);
    const audit = (await s.api('GET', `/audit?action=cost.entry_added&entityId=${service}&limit=5`)) as { summary: string; details: Record<string, unknown> }[];
    expect(audit[0]!.details).toMatchObject({ via: 'book', lineId: line.id, month, again: false });
    expect(audit[0]!.summary).toContain('booked');
  });

  it('asks before booking a month twice', async () => {
    const line = lineOf(await plan(), 'Hosting fee');
    await expect(olivia('POST', `/costs/plans/${service}/lines/${line.id}/book`, { month })).rejects.toMatchObject({
      status: 409,
      body: { code: 'COST_BOOK_AGAIN', params: { month, amount: '1000.00 EUR' } },
    });
    const again: CostPlanYear = await olivia('POST', `/costs/plans/${service}/lines/${line.id}/book`, { month, again: true, reference: 'INV-B2' });
    expect(again.entries.filter((x) => x.planLineId === line.id && x.date.startsWith(month))).toHaveLength(2);
  });

  it('offers an earlier month without an entry, dated on its last day', async () => {
    if (cur === 0) return; // January: no earlier month in the fiscal year
    const line = lineOf(await plan(), 'Hosting fee');
    const y: CostPlanYear = await olivia('POST', `/costs/plans/${service}/lines/${line.id}/book`, { reference: 'INV-B3' });
    const e = y.entries.find((x) => x.reference === 'INV-B3')!;
    expect(e.date).toBe(lastDayOf(months[cur - 1]!));
  });

  it('refuses yearly lines, months to come and months without a payment', async () => {
    const y: CostPlanYear = await olivia('POST', `/costs/plans/${service}/lines`, {
      fiscalYear: fy,
      title: 'Yearly licence',
      category: 'licence',
      amount: '1200',
      currency: 'EUR',
      cadence: 'yearly',
    });
    const yearly = lineOf(y, 'Yearly licence');
    expect(yearly.bookable).toBe(false);
    expect(yearly.notBooked).toEqual([]);
    await expect(olivia('POST', `/costs/plans/${service}/lines/${yearly.id}/book`, {})).rejects.toMatchObject({
      status: 400,
      body: { code: 'COST_BOOK_YEARLY' },
    });
    const hosting = lineOf(y, 'Hosting fee');
    if (cur < 11)
      await expect(olivia('POST', `/costs/plans/${service}/lines/${hosting.id}/book`, { month: months[cur + 1] })).rejects.toMatchObject({
        status: 400,
        body: { code: 'COST_BOOK_FUTURE' },
      });
    // a quarterly line from the first month: payments in months 1, 4, 7 and 10 only
    const q: CostPlanYear = await olivia('POST', `/costs/plans/${service}/lines`, {
      fiscalYear: fy,
      title: 'Quarterly support',
      category: 'support',
      amount: '300',
      currency: 'EUR',
      cadence: 'quarterly',
    });
    const quarterly = lineOf(q, 'Quarterly support');
    expect(quarterly.months.map(Number)).toEqual([300, 0, 0, 300, 0, 0, 300, 0, 0, 300, 0, 0]);
    expect(quarterly.notBooked).toEqual(months.filter((_, i) => i <= cur && i % 3 === 0));
    if (cur % 3 !== 0)
      await expect(olivia('POST', `/costs/plans/${service}/lines/${quarterly.id}/book`, { month })).rejects.toMatchObject({
        status: 400,
        body: { code: 'COST_BOOK_NO_PAYMENT' },
      });
  });

  it('is for who may change the service, in a session', async () => {
    const line = lineOf(await plan(), 'Hosting fee');
    await expect(vera('POST', `/costs/plans/${service}/lines/${line.id}/book`, { month, again: true })).rejects.toMatchObject({ status: 403 });
    const token = (await olivia('POST', '/me/tokens', { name: 'book', scope: 'full' })).token as string;
    const res = await fetch(`${s.base}/api/costs/plans/${service}/lines/${line.id}/book`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ month, again: true }),
    });
    expect(res.status).toBe(403);
    // the entry routes keep accepting API tokens (0.16)
    const entry = await fetch(`${s.base}/api/costs/plans/${service}/entries`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ date: today, amount: '5', currency: 'EUR', reference: 'TOKEN-1' }),
    });
    expect(entry.status).toBe(200);
  });
});

describe('entries with a supplier and a contract', () => {
  it('default to the plan line’s, can be cleared, and keep a supplier the person may not see', async () => {
    const y = await plan();
    const line = lineOf(y, 'Hosting fee');
    const added: CostPlanYear = await olivia('POST', `/costs/plans/${service}/entries`, {
      date: today,
      amount: '10',
      currency: 'EUR',
      planLineId: line.id,
      reference: 'SUP-1',
    });
    const e = added.entries.find((x) => x.reference === 'SUP-1')!;
    expect(e.supplier?.id).toBe(supplier);
    expect(e.supplierContract?.id).toBe(contract);
    // cleared
    const cleared: CostPlanYear = await olivia('PUT', `/costs/plans/${service}/entries/${e.id}`, {
      date: today,
      amount: '10',
      currency: 'EUR',
      planLineId: line.id,
      reference: 'SUP-1',
      supplierId: null,
    });
    const c = cleared.entries.find((x) => x.id === e.id)!;
    expect(c.supplier).toBeNull();
    expect(c.supplierContract).toBeNull();
    // a contract needs its supplier
    await expect(
      olivia('POST', `/costs/plans/${service}/entries`, { date: today, amount: '1', currency: 'EUR', supplierContractId: contract }),
    ).rejects.toMatchObject({ status: 400, body: { code: 'SUPPLIER_CONTRACT_WITHOUT_SUPPLIER' } });
    // a supplier of a team the reader is not in: shown without its name, kept on save
    const { db } = await import('../src/db.js');
    const team = (await s.api('POST', '/teams', { name: 'Booking secret team' })).id;
    const hidden = (await s.api('POST', '/suppliers', { name: 'Hidden Licensing AG' })).id;
    db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('supplier', ?, ?, ?)", hidden, team, new Date().toISOString());
    const h: CostPlanYear = await s.api('POST', `/costs/plans/${service}/entries`, {
      date: today,
      amount: '2',
      currency: 'EUR',
      supplierId: hidden,
      reference: 'SUP-HIDDEN',
    });
    const he = h.entries.find((x) => x.reference === 'SUP-HIDDEN')!;
    const seen: CostPlanYear = await olivia('GET', `/costs/plans/${service}?fiscalYear=${fy}`);
    expect(seen.entries.find((x) => x.id === he.id)).toMatchObject({ supplier: null, supplierHidden: true });
    await olivia('PUT', `/costs/plans/${service}/entries/${he.id}`, { date: today, amount: '3', currency: 'EUR', reference: 'SUP-HIDDEN' });
    expect(db().get<{ supplier_id: string }>('SELECT supplier_id FROM cost_entries WHERE id = ?', he.id)?.supplier_id).toBe(hidden);
    // removing the contract keeps the entries' supplier
    await s.api('DELETE', `/suppliers/${supplier}/contracts/${contract}`);
    const after = await plan();
    expect(after.entries.find((x) => x.reference === 'INV-B1')).toMatchObject({ supplier: { id: supplier }, supplierContract: null });
  });
});
