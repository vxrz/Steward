import { beforeAll, describe, expect, it } from 'vitest';
import {
  fiscalYearBounds,
  fiscalYearLabel,
  fiscalYearMonths,
  fiscalYearOf,
  isCalendarDate,
  isMonth,
  planMonths,
  shiftMonth,
  toMicros,
  type CostPlanYear,
} from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Service cost planning (0.16.0, ADR 0026, docs/COSTS.md#planning-per-service): fiscal years with the instance's start
 * month, plan lines and their cadences, limits and the copy into the next year, cost entries (planned and unplanned),
 * the costs read from the cost model matched with cloud lines, "expected for the year", who sees the cloud figures,
 * who may change a plan, the audit trail, CSV, /api/v1 and the team rollup.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let olivia: Client;
let vera: Client;
let service: string;
let appA: string;
let appB: string;
let other: string;
let system: string;
let platform: string;
let team: string;

const m = (v: string | null | undefined) => (v === null || v === undefined ? null : (toMicros(v) ?? 0) / 1_000_000);

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  olivia = await s.as('olivia', PW);
  vera = await s.as('vera', PW);
  const { db } = await import('../src/db.js');
  team = (await s.api('POST', '/teams', { name: 'Plan secret team' })).id;
  appA = (await s.api('POST', '/applications', { name: 'Plan app A', owners: ['user:olivia'] })).id;
  appB = (await s.api('POST', '/applications', { name: 'Plan app B' })).id;
  other = (await s.api('POST', '/applications', { name: 'Plan app elsewhere' })).id;
  db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('application', ?, ?, ?)", appB, team, new Date().toISOString());
  service = (await s.api('POST', '/services', { name: 'Planned service', owners: ['user:olivia'] })).id;
  await s.api('PUT', `/services/${service}/applications/${appA}`, {});
  await s.api('PUT', `/services/${service}/applications/${appB}`, {});
  system = (await s.api('POST', '/systems', { name: 'plan-host-01', kind: 'vm' })).id;
  await s.api('POST', `/applications/${appA}/systems`, { systemId: system, environment: 'prod' });
  platform = (await s.api('GET', '/platforms')).find((p: { name: string }) => p.name === 'AWS (demo)').id;
  // April starts the fiscal year
  await s.api('PUT', '/costs/settings', { hideAmountsFromViewers: false, defaultCurrency: 'USD', fiscalYearStartMonth: 4 });
}, 240_000);

describe('fiscal years', () => {
  it('start in the instance month and are named by the year they start in', () => {
    expect(fiscalYearLabel(2026, 1)).toBe('FY 2026');
    expect(fiscalYearLabel(2026, 4)).toBe('FY 2026/27');
    expect(fiscalYearLabel(2099, 10)).toBe('FY 2099/00');
    expect(fiscalYearMonths(2026, 1)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
      '2026-12',
    ]);
    expect(fiscalYearMonths(2026, 4)[0]).toBe('2026-04');
    expect(fiscalYearMonths(2026, 4)[11]).toBe('2027-03');
    expect(fiscalYearMonths(2026, 10)).toEqual([
      '2026-10',
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
      '2027-03',
      '2027-04',
      '2027-05',
      '2027-06',
      '2027-07',
      '2027-08',
      '2027-09',
    ]);
    // month boundaries
    for (const [d, start, fy] of [
      ['2026-01-01', 1, 2026],
      ['2026-12-31', 1, 2026],
      ['2026-03-31', 4, 2025],
      ['2026-04-01', 4, 2026],
      ['2027-03-31', 4, 2026],
      ['2026-09-30', 10, 2025],
      ['2026-10-01', 10, 2026],
      ['2027-09-30', 10, 2026],
      ['2026-12', 12, 2026],
      ['2026-11', 12, 2025],
    ] as const)
      expect(fiscalYearOf(d, start), `${d} with start ${start}`).toBe(fy);
    expect(fiscalYearBounds(2026, 1)).toEqual({ from: '2026-01-01', to: '2027-01-01', last: '2026-12-31' });
    expect(fiscalYearBounds(2026, 10)).toEqual({ from: '2026-10-01', to: '2027-10-01', last: '2027-09-30' });
    // leap years: a year that ends with February
    expect(fiscalYearBounds(2027, 3)).toEqual({ from: '2027-03-01', to: '2028-03-01', last: '2028-02-29' });
    expect(fiscalYearBounds(2026, 3).last).toBe('2027-02-28');
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2027-02-29')).toBe(false);
    expect(isCalendarDate('2100-02-29')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isMonth('2026-12')).toBe(true);
    expect(isMonth('2026-00')).toBe(false);
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-11', 14)).toBe('2028-01');
  });

  it('spread a yearly amount evenly and exactly', () => {
    const y = planMonths(1_000_010_000, 'yearly', null);
    expect(y.reduce((a, b) => a + b, 0)).toBe(1_000_010_000);
    expect(Math.max(...y) - Math.min(...y)).toBeLessThanOrEqual(1);
    expect(planMonths(50_000_000, 'monthly', null)).toEqual(Array.from({ length: 12 }, () => 50_000_000));
    expect(planMonths(300_000_000, 'once', 4)).toEqual([0, 0, 0, 0, 300_000_000, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('start month is an administrator setting, audited, kept when left out', async () => {
    await expect(olivia('PUT', '/costs/settings', { hideAmountsFromViewers: false, defaultCurrency: 'USD', fiscalYearStartMonth: 7 })).rejects.toMatchObject({
      status: 403,
    });
    await expect(s.api('PUT', '/costs/settings', { hideAmountsFromViewers: false, defaultCurrency: 'USD', fiscalYearStartMonth: 13 })).rejects.toMatchObject({
      status: 400,
    });
    // a client from before 0.16 leaves it out: unchanged
    expect(await s.api('PUT', '/costs/settings', { hideAmountsFromViewers: false, defaultCurrency: 'USD' })).toMatchObject({ fiscalYearStartMonth: 4 });
    expect(await vera('GET', '/costs/settings')).toMatchObject({ fiscalYearStartMonth: 4 });
    const [a] = await s.api('GET', '/audit?action=cost.settings_changed');
    expect(a.summary).toContain('fiscal year starts in month 4');
  });
});

describe('plan lines', () => {
  const base = { title: 'Monitoring licence', category: 'licence', amount: '1200', currency: 'EUR', cadence: 'yearly' };

  it('are changed by who may change the service, read by who may see it, and audited', async () => {
    const y = await olivia<CostPlanYear>('POST', `/costs/plans/${service}/lines`, {
      ...base,
      fiscalYear: 2030,
      target: { kind: 'application', id: appA },
      vendor: 'Invented Monitoring Ltd',
      renewalDate: '2031-01-31',
    });
    expect(y).toMatchObject({ fiscalYear: 2030, label: 'FY 2030/31', startMonth: 4, canEdit: true });
    const line = y.lines[0]!;
    expect(line).toMatchObject({
      title: 'Monitoring licence',
      planned: '1200.00',
      target: { kind: 'application', id: appA, name: 'Plan app A', visible: true },
    });
    expect(line.months.map(m)).toEqual(Array.from({ length: 12 }, () => 100));
    // a viewer reads it, may not change it
    expect((await vera<CostPlanYear>('GET', `/costs/plans/${service}?year=2030`)).lines).toHaveLength(1);
    await expect(vera('POST', `/costs/plans/${service}/lines`, { ...base, fiscalYear: 2030 })).rejects.toMatchObject({ status: 403 });
    await expect(vera('DELETE', `/costs/plans/${service}/lines/${line.id}`)).rejects.toMatchObject({ status: 403 });
    // changed and removed by the owner
    const changed = await olivia<CostPlanYear>('PUT', `/costs/plans/${service}/lines/${line.id}`, {
      ...base,
      amount: '2400',
      target: { kind: 'system', id: system },
    });
    expect(changed.lines[0]).toMatchObject({ planned: '2400.00', target: { kind: 'system', id: system, name: 'plan-host-01' } });
    const audit = await s.api('GET', `/audit?entityId=${service}`);
    const actions = audit.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['cost.plan_line_added', 'cost.plan_line_changed']));
    const ch = audit.find((a: { action: string }) => a.action === 'cost.plan_line_changed');
    expect(ch.summary).toBe('Plan line "Monitoring licence" of "Planned service" (FY 2030/31) changed: 2400.00 EUR yearly (was 1200.00 EUR yearly)');
    expect(ch.details).toMatchObject({ before: { amount: '1200.00' }, after: { amount: '2400.00', target: { kind: 'system', id: system } } });
    await olivia('DELETE', `/costs/plans/${service}/lines/${line.id}`);
    expect((await s.api('GET', `/audit?action=cost.plan_line_removed&entityId=${service}`))[0].summary).toContain('removed');
  });

  it('refuse what is not of the service, months outside the year, effort and amounts below 1 cent', async () => {
    const post = (body: Record<string, unknown>) => s.api('POST', `/costs/plans/${service}/lines`, { ...base, fiscalYear: 2030, ...body });
    await expect(post({ target: { kind: 'application', id: other } })).rejects.toMatchObject({ status: 400, body: { code: 'COST_PLAN_TARGET' } });
    await expect(post({ target: { kind: 'system', id: 'sys_nothing' } })).rejects.toMatchObject({ status: 400, body: { code: 'COST_PLAN_TARGET' } });
    await expect(post({ cadence: 'once' })).rejects.toMatchObject({ status: 400 });
    await expect(post({ cadence: 'once', onceMonth: '2030-03' })).rejects.toMatchObject({ status: 400, body: { code: 'COST_PLAN_MONTH' } });
    await expect(post({ hours: 40 })).rejects.toMatchObject({ status: 400 });
    await expect(post({ category: 'staff' })).rejects.toMatchObject({ status: 400 });
    await expect(post({ amount: '0' })).rejects.toMatchObject({ status: 400 });
    // ISO 4217 codes only: a typo would open a currency of its own in every total
    await expect(post({ currency: 'EUX' })).rejects.toMatchObject({ status: 400 });
    await expect(s.api('POST', `/costs/plans/${service}/entries`, { date: '2030-05-01', amount: '1', currency: 'XXX' })).rejects.toMatchObject({
      status: 400,
    });
    const { ISO_4217_CODES } = await import('@sm/shared');
    expect(['EUR', 'USD', 'JPY', 'CHF', 'XCG'].every((c) => ISO_4217_CODES.has(c))).toBe(true);
    expect(ISO_4217_CODES.size).toBeGreaterThan(170);
    // a platform the caller may see
    const p = await post({ title: 'Platform share', category: 'cloud', target: { kind: 'platform', id: platform }, cadence: 'once', onceMonth: '2031-03' });
    expect(p.lines.find((l: { title: string }) => l.title === 'Platform share')).toMatchObject({
      onceMonth: '2031-03',
      target: { kind: 'platform', name: 'AWS (demo)' },
    });
    await expect(vera('GET', `/costs/plans/svc_nothing`)).rejects.toMatchObject({ status: 404 });
  });

  it('have a limit per service and fiscal year', async () => {
    const { db } = await import('../src/db.js');
    const now = new Date().toISOString();
    for (let i = 0; i < 200; i++)
      db().run(
        `INSERT INTO cost_plan_lines (id, service_id, fiscal_year, title, category, vendor, amount, currency, cadence, note, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, 2040, ?, 'other', '', 1000000, 'EUR', 'monthly', '', ?, 'admin', ?, 'admin')`,
        `cpl_limit_${i}`,
        service,
        `Line ${i}`,
        now,
        now,
      );
    await expect(s.api('POST', `/costs/plans/${service}/lines`, { ...base, fiscalYear: 2040 })).rejects.toMatchObject({
      status: 409,
      body: { code: 'COST_PLAN_LIMIT' },
    });
    db().run('DELETE FROM cost_plan_lines WHERE fiscal_year = 2040');
  });

  it('are copied into the next fiscal year once', async () => {
    await s.api('POST', `/costs/plans/${service}/lines`, {
      ...base,
      title: 'Support contract',
      category: 'support',
      fiscalYear: 2032,
      renewalDate: '2032-12-31',
    });
    await s.api('POST', `/costs/plans/${service}/lines`, {
      ...base,
      title: 'Laptop',
      category: 'hardware',
      fiscalYear: 2032,
      cadence: 'once',
      onceMonth: '2032-06',
      renewalDate: '2035-05-31',
    });
    const y = await olivia<CostPlanYear>('POST', `/costs/plans/${service}/copy`, { fromYear: 2032 });
    expect(y.fiscalYear).toBe(2033);
    const byTitle = Object.fromEntries(y.lines.map((l) => [l.title, l]));
    // a renewal before the new year moves on by a year; a later one stays; one-off payments keep their place
    expect(byTitle['Support contract']!.renewalDate).toBe('2033-12-31');
    expect(byTitle['Laptop']).toMatchObject({ renewalDate: '2035-05-31', onceMonth: '2033-06' });
    await expect(s.api('POST', `/costs/plans/${service}/copy`, { fromYear: 2032 })).rejects.toMatchObject({
      status: 409,
      body: { code: 'COST_PLAN_YEAR_NOT_EMPTY' },
    });
    await expect(s.api('POST', `/costs/plans/${service}/copy`, { fromYear: 2050 })).rejects.toMatchObject({
      status: 400,
      body: { code: 'COST_PLAN_NOTHING_TO_COPY' },
    });
    expect((await s.api('GET', `/audit?action=cost.plan_copied&entityId=${service}`))[0].summary).toBe(
      'Cost plan of "Planned service" copied from FY 2032/33 to FY 2033/34: 2 line(s)',
    );
    const { nextYearDate } = await import('../src/costs/plans.js');
    expect(nextYearDate('2028-02-29')).toBe('2029-02-28');
  });
});

describe('entries and the year view', () => {
  it('sets plan, entries and unplanned costs against each other per cadence', async () => {
    const { addEntry, addPlanLine, planYear } = await import('../src/costs/plans.js');
    // a service of its own; the module functions run without a reader (all rights)
    const svc = (await s.api('POST', '/services', { name: 'Cadence service' })).id;
    const line = (body: Record<string, unknown>) => {
      const y = addPlanLine(svc, { fiscalYear: 2026, currency: 'EUR', ...body });
      return y.lines.find((l) => l.title === body.title)!.id;
    };
    const yearly = line({ title: 'Yearly', category: 'licence', amount: '1200', cadence: 'yearly' });
    const monthly = line({ title: 'Monthly', category: 'support', amount: '50', cadence: 'monthly' });
    line({ title: 'Once', category: 'hardware', amount: '300', cadence: 'once', onceMonth: '2026-08' });
    addEntry(svc, { date: '2026-04-10', amount: '1200', currency: 'EUR', planLineId: yearly, reference: 'INV-1' });
    addEntry(svc, { date: '2026-04-30', amount: '60', currency: 'EUR', planLineId: monthly });
    addEntry(svc, { date: '2026-05-31', amount: '60', currency: 'EUR', planLineId: monthly });
    addEntry(svc, { date: '2026-06-01', amount: '40', currency: 'EUR', note: 'Spare part' });
    addEntry(svc, { date: '2026-07-01', amount: '10', currency: 'EUR' });
    // a credit note on the monthly line
    addEntry(svc, { date: '2026-05-31', amount: '-5', currency: 'EUR', planLineId: monthly });
    expect(() => addEntry(svc, { date: '2027-04-01', amount: '1', currency: 'EUR', planLineId: monthly })).toThrow(/Not a plan line/);
    expect(() => addEntry(svc, { date: '2026-05-01', amount: '1', currency: 'USD', planLineId: monthly })).toThrow(/Not a plan line/);
    expect(() => addEntry(svc, { date: '2026-05-01', amount: '1', currency: 'EUR', hours: 8 })).toThrow();
    const now = Date.parse('2026-06-15T12:00:00Z');
    const y = planYear(svc, 2026, now);
    expect(y).toMatchObject({ currentIndex: 2, from: '2026-04-01', to: '2027-03-31', cloud: 'none' });
    const l = Object.fromEntries(y.lines.map((x) => [x.title, x]));
    // a yearly amount: what is booked counts against it
    expect([l.Yearly!.planned, l.Yearly!.plannedToDate, l.Yearly!.incurredToDate, l.Yearly!.expected, l.Yearly!.difference].map(m)).toEqual([
      1200, 300, 1200, 1200, 0,
    ]);
    // monthly: April and May as incurred, June to March as planned (nothing booked)
    expect([l.Monthly!.planned, l.Monthly!.plannedToDate, l.Monthly!.incurredToDate, l.Monthly!.expected, l.Monthly!.difference].map(m)).toEqual([
      600, 150, 115, 615, 15,
    ]);
    expect(l.Monthly!.incurredMonths.slice(0, 4).map(m)).toEqual([60, 55, 0, null]);
    expect([l.Once!.planned, l.Once!.plannedToDate, l.Once!.expected].map(m)).toEqual([300, 0, 300]);
    const eur = y.currencies.find((c) => c.currency === 'EUR')!;
    expect(eur.unplanned).toEqual({ incurredToDate: '40.00', expected: '50.00', count: 2 });
    expect([eur.planned, eur.incurredToDate, eur.expected, eur.difference].map(m)).toEqual([2100, 1355, 2165, 65]);
    expect(eur.months[4]).toMatchObject({ month: '2026-08', planned: '450.00' });
    expect(y.entries.filter((e) => e.unplanned).map((e) => e.note)).toEqual(['Spare part', '']);
    // the year is over: everything is incurred
    const later = planYear(svc, 2026, Date.parse('2027-05-01T00:00:00Z'));
    expect(later.currentIndex).toBe(12);
    expect(m(later.lines.find((x) => x.title === 'Monthly')!.expected)).toBe(115);
    // a year to come: all planned
    expect(planYear(svc, 2026, Date.parse('2026-01-15T00:00:00Z')).currentIndex).toBe(-1);
  });

  it('removing a line leaves its entries as unplanned', async () => {
    const y0 = await s.api('POST', `/costs/plans/${service}/lines`, {
      title: 'Short-lived',
      category: 'other',
      amount: '10',
      currency: 'EUR',
      cadence: 'monthly',
      fiscalYear: 2034,
    });
    const lineId = y0.lines.find((l: { title: string }) => l.title === 'Short-lived').id;
    const y1 = await olivia<CostPlanYear>('POST', `/costs/plans/${service}/entries`, {
      date: '2034-05-02',
      amount: '10',
      currency: 'EUR',
      planLineId: lineId,
      reference: 'PO-1',
    });
    expect(y1.entries[0]).toMatchObject({ unplanned: false, planLineTitle: 'Short-lived' });
    const entryId = y1.entries[0]!.id;
    await expect(vera('PUT', `/costs/plans/${service}/entries/${entryId}`, { date: '2034-05-02', amount: '11', currency: 'EUR' })).rejects.toMatchObject({
      status: 403,
    });
    const y2 = await olivia<CostPlanYear>('PUT', `/costs/plans/${service}/entries/${entryId}`, {
      date: '2034-05-03',
      amount: '11',
      currency: 'EUR',
      planLineId: lineId,
      target: { kind: 'application', id: appA },
    });
    expect(y2.entries[0]).toMatchObject({ amount: '11.00', target: { id: appA } });
    // a line with entries in its currency keeps it
    await expect(
      s.api('PUT', `/costs/plans/${service}/lines/${lineId}`, { title: 'Short-lived', category: 'other', amount: '10', currency: 'USD', cadence: 'monthly' }),
    ).rejects.toMatchObject({ status: 409, body: { code: 'COST_PLAN_CURRENCY' } });
    const y3 = await s.api('DELETE', `/costs/plans/${service}/lines/${lineId}`);
    expect(y3.entries[0]).toMatchObject({ unplanned: true, planLineId: null });
    expect((await s.api('GET', `/audit?action=cost.plan_line_removed&entityId=${service}`))[0].details).toMatchObject({ entriesUnplanned: 1 });
    await olivia('DELETE', `/costs/plans/${service}/entries/${entryId}`);
    const audit = (await s.api('GET', `/audit?entityId=${service}`)).map((a: { action: string }) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['cost.entry_added', 'cost.entry_changed', 'cost.entry_removed']));
  });

  it('a changed fiscal year start keeps an entry’s plan line; it counts as unplanned in its year and stays editable', async () => {
    const svc = (await s.api('POST', '/services', { name: 'Start change service', owners: ['user:olivia'] })).id;
    const y0 = await s.api('POST', `/costs/plans/${svc}/lines`, {
      fiscalYear: 2036,
      title: 'Annual support',
      category: 'support',
      amount: '1200',
      currency: 'EUR',
      cadence: 'yearly',
    });
    const lineId = y0.lines[0].id;
    // February 2037 is in FY 2036/37 while the year starts in April
    const y1 = await olivia<CostPlanYear>('POST', `/costs/plans/${svc}/entries`, { date: '2037-02-10', amount: '1200', currency: 'EUR', planLineId: lineId });
    const entryId = y1.entries[0]!.id;
    expect(y1.entries[0]).toMatchObject({ unplanned: false, planLineYear: null });
    // what a January start would do: asked by the settings dialog (administrators only)
    await expect(olivia('GET', '/costs/settings/fiscal-year-change?startMonth=1')).rejects.toMatchObject({ status: 403 });
    const same = await s.api('GET', '/costs/settings/fiscal-year-change?startMonth=4');
    const preview = await s.api('GET', '/costs/settings/fiscal-year-change?startMonth=1');
    expect(preview).toMatchObject({ startMonth: 1 });
    expect(preview.lines).toBeGreaterThan(0);
    expect(preview.entriesOtherYear).toBe(same.entriesOtherYear + 1);
    await s.api('PUT', '/costs/settings', { hideAmountsFromViewers: false, defaultCurrency: 'USD', fiscalYearStartMonth: 1 });
    try {
      const [a] = await s.api('GET', '/audit?action=cost.settings_changed');
      expect(a.details).toMatchObject({ entriesOtherYear: preview.entriesOtherYear });
      expect(a.summary).toContain('into another fiscal year than their plan line now');
      // the entry is in FY 2037 now: unplanned there, its link kept and named with the line's year
      const y2037 = await olivia<CostPlanYear>('GET', `/costs/plans/${svc}?year=2037`);
      expect(y2037.entries[0]).toMatchObject({
        id: entryId,
        unplanned: true,
        planLineId: lineId,
        planLineTitle: 'Annual support',
        planLineYear: { fiscalYear: 2036, label: 'FY 2036' },
      });
      expect(y2037.currencies[0]!.unplanned.count).toBe(1);
      // the line of FY 2036 no longer counts it
      const y2036 = await olivia<CostPlanYear>('GET', `/costs/plans/${svc}?year=2036`);
      expect(y2036.lines[0]!.entries).toBe(0);
      // a change that keeps the link is allowed; linking it to that line anew, or in another currency, is not
      const kept = await olivia<CostPlanYear>('PUT', `/costs/plans/${svc}/entries/${entryId}`, {
        date: '2037-02-10',
        amount: '1200',
        currency: 'EUR',
        planLineId: lineId,
        reference: 'INV-2037-7',
      });
      expect(kept.entries[0]).toMatchObject({ reference: 'INV-2037-7', planLineId: lineId, planLineYear: { fiscalYear: 2036 } });
      await expect(
        olivia('PUT', `/costs/plans/${svc}/entries/${entryId}`, { date: '2037-02-10', amount: '1200', currency: 'USD', planLineId: lineId }),
      ).rejects.toMatchObject({ status: 400, body: { code: 'COST_ENTRY_PLAN_LINE' } });
      await expect(
        olivia('POST', `/costs/plans/${svc}/entries`, { date: '2037-02-11', amount: '5', currency: 'EUR', planLineId: lineId }),
      ).rejects.toMatchObject({ status: 400, body: { code: 'COST_ENTRY_PLAN_LINE' } });
      // unlinked, it is an ordinary unplanned entry
      const unlinked = await olivia<CostPlanYear>('PUT', `/costs/plans/${svc}/entries/${entryId}`, { date: '2037-02-10', amount: '1200', currency: 'EUR' });
      expect(unlinked.entries[0]).toMatchObject({ unplanned: true, planLineId: null, planLineYear: null });
    } finally {
      await s.api('PUT', '/costs/settings', { hideAmountsFromViewers: false, defaultCurrency: 'USD', fiscalYearStartMonth: 4 });
    }
  });

  it('has a limit of entries per fiscal year', async () => {
    const { db } = await import('../src/db.js');
    const now = new Date().toISOString();
    db().tx(() => {
      for (let i = 0; i < 2000; i++)
        db().run(
          `INSERT INTO cost_entries (id, service_id, entry_date, amount, currency, reference, note, created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, '2041-06-01', 1000000, 'EUR', '', '', ?, 'admin', ?, 'admin')`,
          `cen_limit_${i}`,
          service,
          now,
          now,
        );
    });
    await expect(s.api('POST', `/costs/plans/${service}/entries`, { date: '2041-07-01', amount: '1', currency: 'EUR' })).rejects.toMatchObject({
      status: 409,
      body: { code: 'COST_ENTRY_LIMIT' },
    });
    db().run("DELETE FROM cost_entries WHERE id LIKE 'cen_limit_%'");
  });
});

describe('at scale', () => {
  it('computes a year of 200 lines and 2,000 entries with as many statements as a year of one of each', async () => {
    const { db } = await import('../src/db.js');
    const { planYear } = await import('../src/costs/plans.js');
    const { requestDbStats } = await import('../src/database/timing.js');
    const svc = (await s.api('POST', '/services', { name: 'Large plan service' })).id;
    const app = (await s.api('POST', '/applications', { name: 'Large plan app' })).id;
    await s.api('PUT', `/services/${svc}/applications/${app}`, {});
    const sys = (await s.api('POST', '/systems', { name: 'large-plan-host', kind: 'vm' })).id;
    await s.api('POST', `/applications/${app}/systems`, { systemId: sys, environment: 'prod' });
    const targets = [
      ['application', app],
      ['system', sys],
      ['platform', platform],
      [null, null],
    ] as const;
    const now = new Date().toISOString();
    const insert = (lines: number, entries: number, tag: string) =>
      db().tx(() => {
        for (let i = 0; i < lines; i++) {
          const [kind, id] = targets[i % 4]!;
          db().run(
            `INSERT INTO cost_plan_lines (id, service_id, fiscal_year, title, category, target_kind, target_id, vendor, amount, currency, cadence, note, created_at, created_by, updated_at, updated_by)
             VALUES (?, ?, 2045, ?, 'cloud', ?, ?, '', 1000000, 'EUR', 'monthly', '', ?, 'admin', ?, 'admin')`,
            `cpl_${tag}_${i}`,
            svc,
            `Line ${tag} ${i}`,
            kind,
            id,
            now,
            now,
          );
        }
        for (let i = 0; i < entries; i++) {
          const [kind, id] = targets[(i + 1) % 4]!;
          db().run(
            `INSERT INTO cost_entries (id, service_id, entry_date, amount, currency, plan_line_id, target_kind, target_id, reference, note, created_at, created_by, updated_at, updated_by)
             VALUES (?, ?, ?, 1000000, 'EUR', ?, ?, ?, '', '', ?, 'admin', ?, 'admin')`,
            `cen_${tag}_${i}`,
            svc,
            `${shiftMonth('2045-04', i % 12)}-15`,
            i % 3 ? `cpl_${tag}_${i % Math.max(lines, 1)}` : null,
            kind,
            id,
            now,
            now,
          );
        }
      });
    const statements = (fn: () => void) => {
      const st = { statements: 0, ms: 0 };
      requestDbStats.run(st, fn);
      return st.statements;
    };
    const at = Date.parse('2045-08-15T12:00:00Z');
    insert(4, 4, 'few');
    const few = statements(() => planYear(svc, 2045, at));
    expect(few).toBeGreaterThan(0);
    insert(196, 1996, 'many');
    let y = planYear(svc, 2045, at);
    expect([y.lines.length, y.entries.length]).toEqual([200, 2000]);
    const many = statements(() => (y = planYear(svc, 2045, at)));
    // no statement per line or entry: the same count as with four of each
    expect(many).toBe(few);
    expect(many).toBeLessThan(30);
    expect(y.lines.find((l) => l.target?.kind === 'platform')!.target).toMatchObject({ name: 'AWS (demo)', visible: true });
    expect(y.entries.find((e) => e.target?.kind === 'system')!.target).toMatchObject({ name: 'large-plan-host', visible: true });
    const started = performance.now();
    planYear(svc, 2045, at);
    expect(performance.now() - started).toBeLessThan(2000);
    db().run('DELETE FROM cost_entries WHERE service_id = ?', svc);
    db().run('DELETE FROM cost_plan_lines WHERE service_id = ?', svc);
  });
});

describe('the costs read from the cost model', () => {
  let svc: string;
  let a1: string;
  let a2: string;
  beforeAll(async () => {
    const { db } = await import('../src/db.js');
    a1 = (await s.api('POST', '/applications', { name: 'Read app 1' })).id;
    a2 = (await s.api('POST', '/applications', { name: 'Read app 2' })).id;
    svc = (await s.api('POST', '/services', { name: 'Read service' })).id;
    await s.api('PUT', `/services/${svc}/applications/${a1}`, {});
    await s.api('PUT', `/services/${svc}/applications/${a2}`, {});
    let n = 0;
    const rec = (app: string, month: string, amount: number, end: string) =>
      db().run(
        `INSERT INTO cost_records (id, source_platform_id, source, line_key, granularity, billing_period_start, billing_period_end, charge_period_start, charge_period_end,
           month, billed_cost, effective_cost, billing_currency, platform_id, application_id, read_at)
         VALUES (?, ?, 'focus', ?, 'month', ?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?)`,
        `crec_plan_${++n}`,
        platform,
        `plan-${n}`,
        `${month}-01T00:00:00Z`,
        end,
        `${month}-01T00:00:00Z`,
        end,
        month,
        amount * 1_000_000,
        amount * 1_000_000,
        platform,
        app,
        new Date().toISOString(),
      );
    rec(a1, '2026-04', 200, '2026-05-01T00:00:00Z');
    rec(a1, '2026-05', 220, '2026-06-01T00:00:00Z');
    rec(a1, '2026-06', 140, '2026-06-15T00:00:00Z');
    rec(a2, '2026-04', 10, '2026-05-01T00:00:00Z');
    rec(a2, '2026-05', 10, '2026-06-01T00:00:00Z');
    rec(a2, '2026-06', 7, '2026-06-15T00:00:00Z');
  });

  it('a cloud line for an application takes its costs; the rest is shown as read, with the forecast', async () => {
    const { addPlanLine, planYear } = await import('../src/costs/plans.js');
    addPlanLine(svc, {
      fiscalYear: 2026,
      title: 'Hosting app 1',
      category: 'cloud',
      target: { kind: 'application', id: a1 },
      amount: '250',
      currency: 'USD',
      cadence: 'monthly',
    });
    addPlanLine(svc, {
      fiscalYear: 2026,
      title: 'Hosting app 1 again',
      category: 'cloud',
      target: { kind: 'application', id: a1 },
      amount: '1',
      currency: 'USD',
      cadence: 'monthly',
    });
    addPlanLine(svc, {
      fiscalYear: 2026,
      title: 'Not cloud',
      category: 'licence',
      target: { kind: 'application', id: a1 },
      amount: '1',
      currency: 'USD',
      cadence: 'yearly',
    });
    const now = Date.parse('2026-06-15T12:00:00Z');
    const y = planYear(svc, 2026, now);
    expect(y.cloud).toBe('shown');
    const l = Object.fromEntries(y.lines.map((x) => [x.title, x]));
    expect(l['Hosting app 1']!.read).toBe('matched');
    expect(l['Hosting app 1 again']!.read).toBe('taken');
    expect(l['Not cloud']!.read).toBe('none');
    // April and May as read, June's forecast (140 in 14 days of 30: 300), then the plan for the 9 months to come
    expect(l['Hosting app 1']!.incurredMonths.slice(0, 3).map(m)).toEqual([200, 220, 140]);
    expect([l['Hosting app 1']!.incurredToDate, l['Hosting app 1']!.expected, l['Hosting app 1']!.difference].map(m)).toEqual([560, 2970, -30]);
    const usd = y.currencies.find((c) => c.currency === 'USD')!;
    // app 2 is no line's: read 27 so far, June's forecast 15 and the months to come at that rate
    expect(usd.read).toMatchObject({ incurredToDate: '27.00', expected: '170.00' });
    expect(usd.months.slice(0, 3).map((x) => m(x.read))).toEqual([210, 230, 147]);
  });

  it('a reader who does not see every application of the service gets no cloud figures', async () => {
    const { db } = await import('../src/db.js');
    db().run(
      `INSERT INTO cost_records (id, source_platform_id, source, line_key, granularity, billing_period_start, billing_period_end, charge_period_start, charge_period_end,
         month, billed_cost, effective_cost, billing_currency, platform_id, application_id, read_at)
       VALUES ('crec_hidden', ?, 'focus', 'hidden-1', 'month', '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z', '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z',
         '2026-05', 99000000, 99000000, 'USD', ?, ?, ?)`,
      platform,
      platform,
      appB,
      new Date().toISOString(),
    );
    await s.api('POST', `/costs/plans/${service}/lines`, {
      fiscalYear: 2026,
      title: 'Hosting A',
      category: 'cloud',
      target: { kind: 'application', id: appA },
      amount: '100',
      currency: 'USD',
      cadence: 'monthly',
    });
    const mine = await olivia<CostPlanYear>('GET', `/costs/plans/${service}?year=2026`);
    expect(mine.cloud).toBe('hidden');
    expect(mine.lines.find((l) => l.title === 'Hosting A')!.read).toBe('hidden');
    expect(mine.currencies.every((c) => c.read === null && c.months.every((x) => x.read === null))).toBe(true);
    expect(JSON.stringify(mine)).not.toContain('99.00');
    // the hidden application is not offered either
    expect(mine.targets.map((t) => t.id)).toEqual([appA, system]);
    const admin = await s.api('GET', `/costs/plans/${service}?year=2026`);
    expect(admin.cloud).toBe('shown');
    expect(admin.currencies.find((c: { currency: string }) => c.currency === 'USD').read.incurredToDate).toBe('99.00');
  });

  it('amounts follow "hide amounts from viewers"', async () => {
    await s.api('PUT', '/costs/settings', { hideAmountsFromViewers: true, defaultCurrency: 'USD' });
    try {
      const y = await vera<CostPlanYear>('GET', `/costs/plans/${service}?year=2026`);
      expect(y.amountsVisible).toBe(false);
      expect(y.lines[0]).toMatchObject({ title: 'Hosting A', amount: null, planned: null, expected: null });
      expect((await olivia<CostPlanYear>('GET', `/costs/plans/${service}?year=2026`)).lines[0]!.amount).toBe('100.00');
    } finally {
      await s.api('PUT', '/costs/settings', { hideAmountsFromViewers: false, defaultCurrency: 'USD' });
    }
  });
});

describe('export, API and the team rollup', () => {
  it('exports the plan and the entries as CSV', async () => {
    await s.api('POST', `/costs/plans/${service}/lines`, {
      fiscalYear: 2035,
      title: '=HYPERLINK("x")',
      category: 'other',
      amount: '12.5',
      currency: 'EUR',
      cadence: 'monthly',
    });
    await s.api('POST', `/costs/plans/${service}/entries`, { date: '2035-06-01', amount: '-3.25', currency: 'EUR', reference: 'CN-7, credit' });
    const plan: string = await vera('GET', `/costs/plans/${service}/export?year=2035`);
    const lines = plan.replace('﻿', '').trim().split('\r\n');
    expect(lines[0]).toContain('Fiscal year,Title,Category');
    // a formula is defused
    expect(lines[1]).toContain(`FY 2035/36,"'=HYPERLINK(""x"")"`);
    expect(lines[1]).toContain(',12.50,EUR,monthly,');
    const entries: string = await vera('GET', `/costs/plans/${service}/export?year=2035&what=entries`);
    expect(entries).toContain('2035-06-01,-3.25,EUR,,yes,,,"CN-7, credit",');
  });

  it('serves /api/v1/services/{id}/cost-plan with the token owner’s rights', async () => {
    const token = (await olivia('POST', '/me/tokens', { name: 'plans', scope: 'read' })).token as string;
    const v1 = async (path: string) => {
      const res = await fetch(`${s.base}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: res.status, json: await res.json() };
    };
    const one = await v1(`/services/${service}/cost-plan?year=2026`);
    expect(one.status).toBe(200);
    expect(one.json).toMatchObject({ fiscalYear: 2026, label: 'FY 2026/27', cloud: 'hidden' });
    expect(one.json.lines[0]).toMatchObject({ title: 'Hosting A', read: 'hidden' });
    expect((await v1('/services/svc_missing/cost-plan')).status).toBe(404);
    expect((await v1(`/services/${service}/cost-plan?year=1999`)).status).toBe(400);
  });

  it('offers the MCP tool get_service_cost_plan with the token owner’s rights', async () => {
    await s.api('PUT', '/mcp-server', { enabled: true });
    const token = (await olivia('POST', '/me/tokens', { name: 'plans-mcp', scope: 'mcp' })).token as string;
    const call = async (args: Record<string, unknown>) => {
      const res = await fetch(`${s.base}/api/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call',
          'mcp-name': 'get_service_cost_plan',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'get_service_cost_plan',
            arguments: args,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
              'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
            },
          },
        }),
      });
      return (await res.json()).result;
    };
    const r = await call({ serviceId: service, fiscalYear: 2026 });
    expect(r.structuredContent).toMatchObject({ label: 'FY 2026/27', cloud: 'hidden' });
    expect(r.structuredContent.lines[0]).toMatchObject({ title: 'Hosting A', read: 'hidden', for: { kind: 'application', id: appA } });
    expect(JSON.stringify(r)).not.toContain('99.00');
    expect((await call({ serviceId: 'svc_missing' })).isError).toBe(true);
  });

  it('sums the plans of a team’s services per currency', async () => {
    const { db } = await import('../src/db.js');
    const planTeam = (await s.api('POST', '/teams', { name: 'Plan team', members: ['olivia'] })).id;
    const second = (await s.api('POST', '/teams', { name: 'Second plan team' })).id;
    const t1 = (await s.api('POST', '/services', { name: 'Team service 1' })).id;
    const t2 = (await s.api('POST', '/services', { name: 'Team service 2' })).id;
    const own = (sid: string, tid: string) =>
      db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('service', ?, ?, ?)", sid, tid, new Date().toISOString());
    own(t1, planTeam);
    own(t2, planTeam);
    own(t2, second);
    for (const [sid, amount] of [
      [t1, '1200'],
      [t2, '2400'],
    ] as const)
      await s.api('POST', `/costs/plans/${sid}/lines`, { fiscalYear: 2026, title: 'Licence', category: 'licence', amount, currency: 'EUR', cadence: 'yearly' });
    await s.api('POST', `/costs/plans/${t1}/lines`, {
      fiscalYear: 2026,
      title: 'Hosting',
      category: 'cloud',
      amount: '10',
      currency: 'USD',
      cadence: 'monthly',
    });
    const r = await olivia('GET', `/costs/team-plans/${planTeam}?year=2026`);
    expect(r).toMatchObject({ teamName: 'Plan team', label: 'FY 2026/27' });
    expect(r.services.map((x: { name: string; shared: boolean }) => [x.name, x.shared])).toEqual([
      ['Team service 1', false],
      ['Team service 2', true],
    ]);
    expect(r.totals).toEqual([
      expect.objectContaining({ currency: 'EUR', planned: '3600.00' }),
      expect.objectContaining({ currency: 'USD', planned: '120.00' }),
    ]);
    await expect(vera('GET', `/costs/team-plans/${planTeam}`)).rejects.toMatchObject({ status: 404 });
  });

  it('publishes the dataset "Cost plans" for administrators and auditors', async () => {
    const { publishCostPlansDataset } = await import('../src/costs/dataset.js');
    expect(await publishCostPlansDataset(true, Date.parse('2026-11-10T12:00:00Z'))).toBe(true);
    const ds = await s.api('GET', '/datasets/costs.plans');
    const row = ds.rows.find((r: { Service: string; Currency: string }) => r.Service === 'Planned service' && r.Currency === 'USD');
    expect(row).toMatchObject({ 'Fiscal year': 'FY 2026/27', Planned: 1200 });
    const audrey = await s.as('audrey', PW);
    expect((await audrey('GET', '/datasets/costs.plans')).rows.length).toBeGreaterThan(0);
    await expect(vera('GET', '/datasets/costs.plans')).rejects.toMatchObject({ status: 404 });
  });

  it('covers the same services in the team rollup, the dataset and the export: not archived, with lines or entries in the year', async () => {
    const { db } = await import('../src/db.js');
    const { planServices, planExportRows, PLAN_EXPORT_HEADS } = await import('../src/costs/plans.js');
    const { publishCostPlansDataset } = await import('../src/costs/dataset.js');
    const setTeam = (await s.api('POST', '/teams', { name: 'Same set team', members: ['olivia'] })).id;
    const own = (sid: string) =>
      db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('service', ?, ?, ?)", sid, setTeam, new Date().toISOString());
    const onlyEntries = (await s.api('POST', '/services', { name: 'Set entries only' })).id;
    const archived = (await s.api('POST', '/services', { name: 'Set archived' })).id;
    const nothing = (await s.api('POST', '/services', { name: 'Set nothing' })).id;
    for (const sid of [onlyEntries, archived, nothing]) own(sid);
    await s.api('POST', `/costs/plans/${onlyEntries}/entries`, { date: '2026-05-04', amount: '30', currency: 'EUR' });
    await s.api('POST', `/costs/plans/${archived}/lines`, {
      fiscalYear: 2026,
      title: 'Old',
      category: 'other',
      amount: '5',
      currency: 'EUR',
      cadence: 'monthly',
    });
    db().run('UPDATE services SET archived = 1 WHERE id = ?', archived);
    const ids = planServices(2026, 4).map((x) => x.id);
    expect(ids).toContain(onlyEntries);
    expect(ids).not.toContain(archived);
    expect(ids).not.toContain(nothing);
    const team = await olivia('GET', `/costs/team-plans/${setTeam}?year=2026`);
    expect(team.services.map((x: { id: string }) => x.id)).toEqual([onlyEntries]);
    await publishCostPlansDataset(true, Date.parse('2026-11-10T12:00:00Z'));
    const ds = await s.api('GET', '/datasets/costs.plans');
    expect(ds.rows.map((r: { Service: string }) => r.Service)).toEqual(expect.arrayContaining(['Set entries only']));
    expect(ds.rows.map((r: { Service: string }) => r.Service)).not.toContain('Set archived');
    const out: string[] = [];
    for await (const x of planExportRows(2026, Date.parse('2026-11-10T12:00:00Z'))) out.push(...x.entries);
    expect(out.some((r) => r.startsWith(`${onlyEntries},Set entries only,2026-05-04,30.00,EUR`))).toBe(true);
    expect(out.join('\n')).not.toContain('Set archived');
    // the same columns whether there is anything to export or not
    expect(PLAN_EXPORT_HEADS.plan.split(',')).toHaveLength(19);
    expect(PLAN_EXPORT_HEADS.entries.split(',')).toHaveLength(11);
    const none: unknown[] = [];
    for await (const x of planExportRows(2090)) none.push(x);
    expect(none).toEqual([]);
  });

  it('answers 404 while the costs module is off', async () => {
    await s.api('PUT', '/settings/modules/costs', { enabled: false });
    try {
      await expect(s.api('GET', `/costs/plans/${service}`)).rejects.toMatchObject({ status: 404, body: { code: 'MODULE_OFF' } });
      const token = (await s.api('POST', '/me/tokens', { name: 'plans-off', scope: 'read' })).token as string;
      const res = await fetch(`${s.base}/api/v1/services/${service}/cost-plan`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(404);
    } finally {
      await s.api('PUT', '/settings/modules/costs', { enabled: true });
    }
  });
});
