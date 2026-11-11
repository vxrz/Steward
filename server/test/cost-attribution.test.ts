import { beforeAll, describe, expect, it } from 'vitest';
import {
  currentPeriod,
  fiscalYearMonths,
  fiscalYearOf,
  prepaidDrawdown,
  proposalParts,
  schedulePayments,
  toMicros,
  volumeEstimate,
  volumeMinimum,
  volumeNoticeKinds,
  volumeOwed,
  volumePeriods,
  volumeWarnings,
  type ContractTerms,
  type CostAttribution,
  type CostCommitments,
  type CostPlanYear,
  type CostScheduleList,
  type PlatformContracts,
  type ScheduleSpec,
  type SupplierContractDetail,
  type SupplierDetail,
  type VolumeSpec,
} from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Cost attribution, platform cost plans and volumes (0.19.0, ADR 0032, docs/COSTS.md): the volume arithmetic (periods,
 * minimums in the currency's minor units, proposals that add up, the linear estimate, warnings, what is owed and what a
 * prepaid volume covers), a platform's own cost plan (rights, lines, entries, Book, copy, CSV, the read costs and what a
 * prepaid volume covers – nothing counted twice), contracts covering platforms (who sees them), applications and
 * systems named on a contract and the "Costs and contracts" rollup (each line once, team scope), the commitments of
 * platform-paid and volume schedules (owed against "up to", state only), the warnings sent once, /api/v1 and MCP, and
 * the number of statements of a platform's year view.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
const M = (v: string | number) => toMicros(String(v))!;
const m = (v: string | null | undefined) => (v === null || v === undefined ? null : (toMicros(v) ?? 0) / 1_000_000);

const fixed = (startsOn: string, endsOn: string): ContractTerms => ({ startsOn, endsOn, noticeDays: 90, renewal: 'fixedEnd', renewalMonths: null });
const vol = (v: Partial<VolumeSpec>): VolumeSpec => ({
  per: 'year',
  billing: 'byUse',
  committed: 'full',
  minimum: null,
  minimumPct: null,
  consumption: 'entries',
  ...v,
});
const spec = (amount: string, currency: string, v: Partial<VolumeSpec>, yearAmounts: (number | null)[] = []): ScheduleSpec => ({
  billing: 'volume',
  amount: M(amount),
  currency,
  firstPaymentOn: null,
  startsOn: null,
  endsOn: null,
  yearAmounts,
  payments: [],
  volume: vol(v),
});

describe('the volume arithmetic', () => {
  const terms = fixed('2026-02-01', '2029-01-31');

  it('has a period per contract year (or one for the term) with its committed minimum in minor units', () => {
    const p = volumePeriods(spec('12000', 'EUR', {}, [M('13000'), null]), terms);
    expect(p.map((x) => [x.index, x.from, x.to, x.amount / 1e6])).toEqual([
      [1, '2026-02-01', '2027-01-31', 12000],
      [2, '2027-02-01', '2028-01-31', 13000],
      [3, '2028-02-01', '2029-01-31', 13000],
    ]);
    expect(volumePeriods(spec('30000', 'EUR', { per: 'term' }), terms)).toEqual([
      { index: 1, from: '2026-02-01', to: '2029-01-31', amount: M('30000'), minimum: M('30000') },
    ]);
    // the minimum: a percentage rounded half away from zero to the currency's minor units
    expect(volumeMinimum(vol({ committed: 'minimum', minimumPct: 50 }), M('1000.01'), 'EUR')).toBe(M('500.01'));
    expect(volumeMinimum(vol({ committed: 'minimum', minimumPct: 33 }), M('1001'), 'JPY')).toBe(M('330'));
    expect(volumeMinimum(vol({ committed: 'minimum', minimumPct: 33 }), M('10.001'), 'KWD')).toBe(M('3.3'));
    // an amount, capped at the volume; full and prepaid: the volume; none: nothing
    expect(volumeMinimum(vol({ committed: 'minimum', minimum: M('900') }), M('500'), 'EUR')).toBe(M('500'));
    expect(volumeMinimum(vol({ committed: 'full' }), M('500'), 'EUR')).toBe(M('500'));
    expect(volumeMinimum(vol({ billing: 'prepaid', committed: 'none' }), M('500'), 'EUR')).toBe(M('500'));
    expect(volumeMinimum(vol({ committed: 'none' }), M('500'), 'EUR')).toBe(0);
  });

  it('proposes lines billed by use that add up to the volume over the fiscal years, in minor units', () => {
    for (const [currency, amount] of [
      ['EUR', '12000'],
      ['JPY', '100000'],
      ['KWD', '1000.001'],
    ] as const) {
      const sp = spec(amount, currency, {});
      let total = 0;
      const parts2025 = proposalParts(sp, terms, 2025, 10);
      // FY 2025/26 (October start): February to September of contract year 1
      expect(parts2025).toHaveLength(1);
      expect(parts2025[0]).toMatchObject({ part: 'v1', cadence: 'yearly', fromIndex: 4, toIndex: 11 });
      for (const fy of [2025, 2026, 2027, 2028]) for (const p of proposalParts(sp, terms, fy, 10)) total += p.amount;
      // three contract years of the same volume, never a fraction of a minor unit
      expect(total).toBe(M(amount) * 3);
      const unit = currency === 'JPY' ? 1_000_000 : currency === 'KWD' ? 1000 : 10_000;
      for (const p of proposalParts(sp, terms, 2026, 10)) for (const v of p.months) expect(v % unit).toBe(0);
    }
    // FY 2026/27 has two parts: October–January of year 1 and February–September of year 2
    expect(proposalParts(spec('12000', 'EUR', {}), terms, 2026, 10).map((p) => [p.part, p.amount / 1e6])).toEqual([
      ['v1', 4000],
      ['v2', 8000],
    ]);
  });

  it('pays a prepaid volume at the start of each period, covering the period', () => {
    const pays = schedulePayments(spec('5000', 'USD', { billing: 'prepaid' }), terms);
    expect(pays.map((p) => [p.date, p.amount / 1e6, p.coversFrom, p.coversTo])).toEqual([
      ['2026-02-01', 5000, '2026-02-01', '2027-01-31'],
      ['2027-02-01', 5000, '2027-02-01', '2028-01-31'],
      ['2028-02-01', 5000, '2028-02-01', '2029-01-31'],
    ]);
    // proposed as one-off lines in the month of the payment
    expect(proposalParts(spec('5000', 'USD', { billing: 'prepaid' }), terms, 2026, 10).map((p) => [p.cadence, p.onceIndex])).toEqual([['once', 4]]);
    // by use: no fixed payments
    expect(schedulePayments(spec('5000', 'USD', {}), terms)).toEqual([]);
  });

  it('estimates the use at the period end from the last 90 days, and when it runs out', () => {
    const p = { from: '2026-01-01', to: '2026-12-31', amount: M('365') };
    const daily = (from: string, days: number, amount: string) =>
      Array.from({ length: days }, (_, i) => ({
        date: new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
        amount: M(amount),
      }));
    // too early: less than 28 days of the period behind
    expect(volumeEstimate(p, daily('2026-01-01', 10, '1'), '2026-01-11', 'EUR').expectedAtEnd).toBeNull();
    // 2 a day for 100 days: 200 used, rate 2 a day over the last 90 days up to yesterday, 264 days after today → 728
    const e = volumeEstimate(p, daily('2026-01-01', 100, '2'), '2026-04-11', 'EUR');
    expect(m(String(e.used / 1e6))).toBe(200);
    expect(e.window).toEqual({ from: '2026-01-11', to: '2026-04-10' });
    expect(e.expectedAtEnd).toBe(M('728'));
    // 165 left at 2 a day: 83 days → 3 July
    expect(e.runsOutOn).toBe('2026-07-03');
    // rounded to the currency's minor units: JPY whole yen
    const j = volumeEstimate({ from: '2026-01-01', to: '2026-12-31', amount: M('100000') }, daily('2026-01-01', 100, '3.3'), '2026-04-11', 'JPY');
    expect(j.expectedAtEnd! % 1_000_000).toBe(0);
    // the period is over: what was used
    expect(volumeEstimate(p, daily('2026-01-01', 365, '0.5'), '2027-02-01', 'EUR').expectedAtEnd).toBe(M('182.5'));
  });

  it('warns: used up or running out (full, prepaid), over or towards a ceiling, well below a minimum', () => {
    const at = (used: string, expected: string | null, runsOutOn: string | null = null, elapsedPct = 50) => ({
      used: M(used),
      rate: 1,
      window: null,
      expectedAtEnd: expected === null ? null : M(expected),
      runsOutOn,
      elapsedPct,
    });
    const full = vol({ committed: 'full' });
    expect(volumeWarnings(full, { amount: M('100'), minimum: M('100') }, at('100', '150'))).toEqual(['usedUp']);
    expect(volumeWarnings(full, { amount: M('100'), minimum: M('100') }, at('60', '130', '2026-09-01'))).toEqual(['runsOut']);
    // full and expected to end at 70 of 100: a shortfall (use it or lose it)
    expect(volumeWarnings(full, { amount: M('100'), minimum: M('100') }, at('35', '70'))).toEqual(['shortfall']);
    // a minimum of 50 and a ceiling of 100
    const min = vol({ committed: 'minimum', minimumPct: 50 });
    expect(volumeWarnings(min, { amount: M('100'), minimum: M('50') }, at('20', '40'))).toEqual(['shortfall']);
    // within 10 % of the minimum: no warning
    expect(volumeWarnings(min, { amount: M('100'), minimum: M('50') }, at('23', '46'))).toEqual([]);
    // too early in the period for a shortfall
    expect(volumeWarnings(min, { amount: M('100'), minimum: M('50') }, at('5', '20', null, 10))).toEqual([]);
    expect(volumeWarnings(min, { amount: M('100'), minimum: M('50') }, at('60', '120'))).toEqual(['ceiling']);
    expect(volumeWarnings(vol({ committed: 'none' }), { amount: M('100'), minimum: 0 }, at('101', '140'))).toEqual(['overCeiling']);
    // a notice for "runs out" only within 30 days, for a shortfall when the period ends within 90
    const e = at('60', '130', '2026-09-01');
    expect(volumeNoticeKinds(['runsOut'], { to: '2026-12-31' }, e, '2026-07-01')).toEqual([]);
    expect(volumeNoticeKinds(['runsOut'], { to: '2026-12-31' }, e, '2026-08-10')).toEqual(['runsOut']);
    expect(volumeNoticeKinds(['shortfall'], { to: '2026-12-31' }, e, '2026-08-10')).toEqual([]);
    expect(volumeNoticeKinds(['shortfall'], { to: '2026-12-31' }, e, '2026-10-10')).toEqual(['shortfall']);
  });

  it('covers costs with a prepaid volume in date order; what is past it is an overage', () => {
    const drawn = prepaidDrawdown(
      [{ from: '2026-01-01', to: '2026-12-31', amount: M('100') }],
      [
        { date: '2026-03-01', amount: M('60'), key: 'b' },
        { date: '2026-02-01', amount: M('30'), key: 'a' },
        { date: '2026-04-01', amount: M('30'), key: 'c' },
        { date: '2026-05-01', amount: M('-5'), key: 'credit' },
        { date: '2027-01-02', amount: M('10'), key: 'next year' },
      ],
    );
    expect(Object.fromEntries([...drawn].map(([k, v]) => [k, v / 1e6]))).toEqual({ a: 30, b: 60, c: 10 });
  });

  it('owes the committed minimum not used yet (by use), payments (prepaid), nothing for a ceiling', () => {
    const today = '2026-08-01';
    // per year 12,000, minimum 50 %: year 1 has used 2,000 → owes 4,000; years 2 and 3 owe 6,000 each
    const sp = spec('12000', 'EUR', { committed: 'minimum', minimumPct: 50 });
    const o = volumeOwed(sp, terms, today, 10, (p) => (p.index === 1 ? M('2000') : 0));
    expect(o.toContractEnd / 1e6).toBe(16000);
    // the room above what is owed: year 1 12,000 − 6,000; years 2 and 3 another 6,000 each – never part of what is owed
    expect(o.upTo / 1e6).toBe(18000);
    expect(o.nextPayment).toBeNull();
    // counted in the fiscal year the period ends in (October start: January 2027 is FY 2026/27)
    expect(o.byFiscalYear.map((y) => [y.fiscalYear, y.toContractEnd / 1e6])).toEqual([
      [2026, 4000],
      [2027, 6000],
      [2028, 6000],
    ]);
    // a ceiling owes nothing, may bill up to the rest
    const none = volumeOwed(spec('12000', 'EUR', { committed: 'none' }), terms, today, 10, (p) => (p.index === 1 ? M('2000') : 0));
    expect([none.toContractEnd, none.upTo / 1e6]).toEqual([0, 34000]);
    // prepaid: the payments dated today or later
    const pre = volumeOwed(spec('5000', 'EUR', { billing: 'prepaid' }), terms, today, 10, () => 0);
    expect([pre.toContractEnd / 1e6, pre.upTo]).toEqual([10000, 0]);
    expect(currentPeriod(volumePeriods(sp, terms), today)?.index).toBe(1);
  });
});

let s: TestServer;
let olivia: Client;
let dana: Client;
let adam: Client;
let vera: Client;
let audrey: Client;
let platform: string;
let supplier: string;
let teamPlatform: string;

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  olivia = await s.as('olivia', PW);
  dana = await s.as('dana', PW);
  adam = await s.as('adam', PW);
  vera = await s.as('vera', PW);
  audrey = await s.as('audrey', PW);
  await s.api('PUT', '/costs/settings', { hideAmountsFromViewers: false, defaultCurrency: 'USD', fiscalYearStartMonth: 1 });
  const { db } = await import('../src/db.js');
  platform = (await s.api('POST', '/platforms', { name: 'Capacity platform', kind: 'rest', baseUrl: 'https://capacity.example.com' })).id;
  await s.api('PUT', `/platforms/${platform}/access`, {
    acl: [
      { subject: 'user:olivia', permissions: ['use'] },
      { subject: 'user:adam', permissions: ['use'] },
      { subject: 'user:dana', permissions: ['manage', 'use'] },
    ],
  });
  // olivia is a member of the platform's owning team; adam only uses the platform
  teamPlatform = (await s.api('POST', '/teams', { name: 'Platform team', members: [] })).id;
  await s.api('POST', '/teams', { name: 'Purchasing team', members: [] });
  const oliviaId = db().get<{ id: string }>("SELECT id FROM users WHERE username = 'olivia'")!.id;
  db().run("INSERT INTO team_members (team_id, user_id, roles) VALUES (?, ?, '[]')", teamPlatform, oliviaId);
  db().run(
    "INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('platform', ?, ?, ?)",
    platform,
    teamPlatform,
    new Date().toISOString(),
  );
  supplier = (await s.api('POST', '/suppliers', { name: 'Invented Capacity AG', type: 'serviceProvider' })).id;
}, 300_000);

/** Read costs of the platform: one line a day, in USD. */
async function readCosts(platformId: string, from: string, days: number, amount: number, tag = 'r'): Promise<void> {
  const { db } = await import('../src/db.js');
  db().tx(() => {
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
      db().run(
        `INSERT INTO cost_records (id, source_platform_id, source, line_key, granularity, billing_period_start, billing_period_end, charge_period_start, charge_period_end,
           month, billed_cost, effective_cost, billing_currency, platform_id, read_at)
         VALUES (?, ?, 'focus', ?, 'day', ?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?)`,
        `crec_${tag}_${platformId}_${i}`,
        platformId,
        `${tag}-${i}`,
        `${d.slice(0, 7)}-01T00:00:00Z`,
        `${d.slice(0, 7)}-28T00:00:00Z`,
        `${d}T00:00:00Z`,
        `${d}T23:59:59Z`,
        d.slice(0, 7),
        amount * 1_000_000,
        amount * 1_000_000,
        platformId,
        new Date().toISOString(),
      );
    }
  });
}

describe("a platform's own cost plan", () => {
  it('is changed by who manages the platform and the members of its owning teams, read by its users', async () => {
    const fy = new Date().getUTCFullYear();
    const own: CostPlanYear = await olivia('GET', `/costs/platform-plans/${platform}?fiscalYear=${fy}`);
    expect(own).toMatchObject({ owner: { kind: 'platform', id: platform, name: 'Capacity platform' }, serviceId: '', canEdit: true });
    expect((await dana('GET', `/costs/platform-plans/${platform}`)).canEdit).toBe(true);
    // a user of the platform reads it, does not change it
    expect((await adam('GET', `/costs/platform-plans/${platform}`)).canEdit).toBe(false);
    await expect(adam('POST', `/costs/platform-plans/${platform}/lines`, line(fy))).rejects.toMatchObject({ status: 403 });
    // a viewer does not see platforms: answered like a missing one
    await expect(vera('GET', `/costs/platform-plans/${platform}`)).rejects.toMatchObject({ status: 404 });
    // an auditor reads it
    expect((await audrey('GET', `/costs/platform-plans/${platform}`)).canEdit).toBe(false);
  });

  it('has lines, entries, Book, copy and CSV like a service plan – without an application, system or platform to name', async () => {
    const fy = new Date().getUTCFullYear();
    let y: CostPlanYear = await olivia('POST', `/costs/platform-plans/${platform}/lines`, line(fy));
    const l = y.lines.find((x) => x.title === 'Support subscription')!;
    expect(l).toMatchObject({ cadence: 'monthly', serviceId: '', bookable: true });
    await expect(olivia('POST', `/costs/platform-plans/${platform}/lines`, { ...line(fy), target: { kind: 'platform', id: platform } })).rejects.toMatchObject({
      status: 400,
      body: { code: 'COST_PLAN_TARGET' },
    });
    const month = new Date().toISOString().slice(0, 7);
    y = await olivia('POST', `/costs/platform-plans/${platform}/lines/${l.id}/book`, { month, reference: 'SUB-1' });
    expect(y.entries.find((e) => e.reference === 'SUB-1')).toMatchObject({ amount: '500.00', planLineId: l.id });
    y = await olivia('POST', `/costs/platform-plans/${platform}/entries`, { date: day(0).slice(0, 4) + '-01-15', amount: '42', currency: 'USD' });
    expect(y.entries.some((e) => e.unplanned && e.amount === '42.00')).toBe(true);
    const { platformPlanCsv } = await import('../src/costs/plans.js');
    expect(platformPlanCsv(platform, fy, 'plan').csv).toContain('Support subscription');
    const copied: CostPlanYear = await olivia('POST', `/costs/platform-plans/${platform}/copy`, { fiscalYear: fy });
    expect(copied.fiscalYear).toBe(fy + 1);
    expect(copied.lines.map((x) => x.title)).toEqual(['Support subscription']);
    // the service plan's routes do not reach it
    await expect(olivia('GET', `/costs/plans/${platform}`)).rejects.toMatchObject({ status: 404 });
    const a = (await s.api('GET', '/audit?action=cost.plan_line_added&limit=5')) as { entityType: string; entityId: string }[];
    expect(a[0]).toMatchObject({ entityType: 'platform', entityId: platform });
  });

  it('sets its plan against the platform’s whole bill: a cloud line takes the read costs', async () => {
    const fy = new Date().getUTCFullYear();
    await readCosts(platform, `${fy}-01-01`, 31, 10, 'jan');
    const y: CostPlanYear = await olivia('POST', `/costs/platform-plans/${platform}/lines`, {
      ...line(fy),
      title: 'Consumption',
      category: 'cloud',
      amount: '400',
    });
    const cloud = y.lines.find((x) => x.title === 'Consumption')!;
    expect(cloud.read).toBe('matched');
    expect(m(cloud.incurredMonths[0])).toBe(310);
    expect(y.cloud).toBe('shown');
  });
});

describe('contracts covering a platform', () => {
  let contract: string;
  it('are seen by who manages the platform or belongs to its owning teams – not by every user of it', async () => {
    const d: SupplierDetail = await s.api('POST', `/suppliers/${supplier}/contracts`, {
      title: 'Capacity contract',
      reference: 'CAP-1',
      startsOn: day(-200),
      endsOn: day(165),
      renewal: 'fixedEnd',
      owners: ['team:purchasing team'],
      platforms: [{ platformId: platform, purpose: 'Capacity of the data platform' }],
    });
    contract = d.contracts.find((c) => c.title === 'Capacity contract')!.id;
    const read = (c: Client) => c('GET', `/suppliers/${supplier}/contracts/${contract}`) as Promise<SupplierContractDetail>;
    expect((await read(olivia)).contract.readReason).toBe('platform');
    expect((await read(dana)).contract.platforms).toMatchObject([{ id: platform, purpose: 'Capacity of the data platform', canChange: true }]);
    expect((await read(audrey)).contract.readReason).toBe('auditor');
    await expect(read(adam)).rejects.toMatchObject({ status: 404 });
    const listed: PlatformContracts = await olivia('GET', `/platforms/${platform}/contracts`);
    expect(listed.contracts.map((x) => x.contract.title)).toEqual(['Capacity contract']);
    expect(listed.canEdit).toBe(true);
    expect(((await adam('GET', `/platforms/${platform}/contracts`)) as PlatformContracts).contracts).toEqual([]);
    // taking the platform off needs a session and who changes the contract or manages the platform
    await expect(adam('DELETE', `/suppliers/${supplier}/contracts/${contract}/platforms/${platform}`)).rejects.toMatchObject({ status: 404 });
  });

  it('pay a prepaid capacity drawn down by the read costs, never counted twice', async () => {
    // 199 days of 10 USD a day so far (some of them read above already); the capacity is 2,200 – it runs out in 21 days
    const { db } = await import('../src/db.js');
    db().run('DELETE FROM cost_records WHERE platform_id = ?', platform);
    await readCosts(platform, day(-199), 199, 10, 'cap');
    const l: CostScheduleList = await olivia('POST', '/costs/schedules', {
      contractId: contract,
      platformId: platform,
      title: 'Prepaid capacity',
      category: 'cloud',
      amount: '2200',
      currency: 'USD',
      billing: 'volume',
      volume: { per: 'term', billing: 'prepaid', committed: 'full' },
    });
    const sch = l.schedules.find((x) => x.title === 'Prepaid capacity')!;
    expect(sch).toMatchObject({ payer: { kind: 'platform', id: platform }, serviceId: '', volume: { billing: 'prepaid', consumption: 'read' } });
    // a second volume in the same currency on the contract: refused
    await expect(
      olivia('POST', '/costs/schedules', { ...volBody(contract), platformId: platform, volume: { per: 'year', billing: 'byUse', committed: 'none' } }),
    ).rejects.toMatchObject({ status: 409, body: { code: 'COST_VOLUME_ONE_PER_CURRENCY' } });
    const fy = new Date().getUTCFullYear();
    const y: CostPlanYear = await olivia('GET', `/costs/platform-plans/${platform}?fiscalYear=${fy}`);
    const v = y.volumes.find((x) => x.scheduleId === sch.id)!;
    expect(m(v.used)).toBe(1990);
    expect(m(v.left)).toBe(210);
    expect(v.warnings).toContain('runsOut');
    expect(v.runsOutOn).not.toBeNull();
    // what the volume covers is not incurred again: all read costs of the year are drawn, none left as read
    const usd = y.currencies.find((c) => c.currency === 'USD')!;
    const readThisYear = db().get<{ e: number }>(
      'SELECT SUM(effective_cost) AS e FROM cost_records WHERE platform_id = ? AND month >= ? AND month <= ?',
      platform,
      `${fy}-01`,
      `${fy}-12`,
    )!.e;
    expect(m(usd.drawn!.toDate)).toBe(Number(readThisYear) / 1e6);
    const cloud = y.lines.find((x) => x.title === 'Consumption')!;
    expect(m(cloud.incurredToDate)).toBe(0);
    // the commitments: a row of the platform, owed what is still to pay (the payment was at the start: nothing)
    const c: CostCommitments = await olivia('GET', `/costs/commitments?platformId=${platform}`);
    const row = c.rows.find((r) => r.scheduleId === sch.id)!;
    expect(row).toMatchObject({ payer: { kind: 'platform', id: platform }, serviceId: '', upTo: null });
    expect(row.volume?.warnings).toContain('runsOut');
    // the team that owns the platform finds it there too
    const team: CostCommitments = await olivia('GET', `/costs/commitments?teamId=${teamPlatform}`);
    expect(team.rows.some((r) => r.scheduleId === sch.id)).toBe(true);
    // the warning goes out once
    const { checkVolumeNotices } = await import('../src/costs/volume-notices.js');
    const first = checkVolumeNotices(Date.now(), true);
    expect(first).toBeGreaterThan(0);
    expect(checkVolumeNotices(Date.now(), true)).toBe(0);
  });
});

const line = (fy: number) => ({ fiscalYear: fy, title: 'Support subscription', category: 'support', amount: '500', currency: 'USD', cadence: 'monthly' });
const volBody = (contractId: string) => ({
  contractId,
  title: 'Second volume',
  category: 'support',
  amount: '1000',
  currency: 'USD',
  billing: 'volume',
});

describe('volumes billed by use and their commitments', () => {
  it('owe the committed minimum not used; the use of services the reader may not see gives state only', async () => {
    const { db } = await import('../src/db.js');
    const svcA = (await s.api('POST', '/services', { name: 'Volume service A', owners: ['user:olivia'] })).id;
    const svcB = (await s.api('POST', '/services', { name: 'Volume service B' })).id;
    const hidden = (await s.api('POST', '/teams', { name: 'Volume hidden team', members: [] })).id;
    db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('service', ?, ?, ?)", svcB, hidden, new Date().toISOString());
    const start = `${day(-120).slice(0, 7)}-01`;
    const d: SupplierDetail = await s.api('POST', `/suppliers/${supplier}/contracts`, {
      title: 'Translation framework',
      startsOn: start,
      endsOn: new Date(Date.parse(`${start}T00:00:00Z`) + 729 * 86_400_000).toISOString().slice(0, 10),
      renewal: 'fixedEnd',
      services: [
        { serviceId: svcA, purpose: 'Letters' },
        { serviceId: svcB, purpose: 'Help articles' },
      ],
    });
    const contractId = d.contracts.find((c) => c.title === 'Translation framework')!.id;
    const l: CostScheduleList = await s.api('POST', '/costs/schedules', {
      contractId,
      serviceId: svcA,
      title: 'Translation volume',
      category: 'support',
      amount: '12000',
      currency: 'EUR',
      billing: 'volume',
      volume: { per: 'year', billing: 'byUse', committed: 'minimum', minimumPct: 50 },
    });
    const sch = l.schedules.find((x) => x.title === 'Translation volume')!;
    // read costs are only for a platform's volume
    await expect(
      s.api('POST', '/costs/schedules', {
        ...volBody(contractId),
        currency: 'USD',
        serviceId: svcA,
        volume: { per: 'year', billing: 'byUse', committed: 'none', consumption: 'read' },
      }),
    ).rejects.toMatchObject({ status: 400, body: { code: 'COST_VOLUME_READ_PLATFORM' } });
    // A books 1,000 against the contract, B (hidden from olivia) 500
    await s.api('POST', `/costs/plans/${svcA}/entries`, {
      date: day(-30),
      amount: '1000',
      currency: 'EUR',
      supplierId: supplier,
      supplierContractId: contractId,
    });
    await s.api('POST', `/costs/plans/${svcB}/entries`, {
      date: day(-20),
      amount: '500',
      currency: 'EUR',
      supplierId: supplier,
      supplierContractId: contractId,
    });
    const admin: CostCommitments = await s.api('GET', `/costs/commitments?serviceId=${svcA}`);
    const row = admin.rows.find((r) => r.scheduleId === sch.id)!;
    expect(m(row.volume!.used)).toBe(1500);
    expect(row.volume!.stateOnly).toBe(false);
    // year 1 owes 6,000 − 1,500; year 2 the whole 6,000; the ceiling above it is "up to", not owed
    expect(m(row.toContractEnd)).toBe(10500);
    expect(m(row.upTo)).toBe(12000);
    expect(row.nextPayment).toBeNull();
    // olivia does not see B: no figures that depend on the use, and the totals leave the row out
    const mine: CostCommitments = await olivia('GET', `/costs/commitments?serviceId=${svcA}`);
    const r2 = mine.rows.find((r) => r.scheduleId === sch.id)!;
    expect(r2.volume).toMatchObject({ stateOnly: true, used: null, left: null, expectedAtEnd: null });
    expect([r2.amountsVisible, r2.toContractEnd, r2.upTo]).toEqual([false, null, null]);
    expect(mine.totals.find((x) => x.currency === 'EUR')).toBeUndefined();
    // Book on a line billed by use asks for the amount; its suggestion is the average use per month
    const fy = fiscalYearOf(day(0), 1);
    const y: CostPlanYear = await s.api('POST', `/costs/plans/${svcA}/proposals`, { fiscalYear: fy, scheduleIds: [sch.id] });
    const vl = y.lines.find((x) => x.schedule?.id === sch.id)!;
    expect(vl).toMatchObject({ cadence: 'yearly', bookable: true, volume: { billing: 'byUse', consumption: 'entries' } });
    expect(vl.volume!.suggested).not.toBeNull();
    await expect(s.api('POST', `/costs/plans/${svcA}/lines/${vl.id}/book`, { month: day(0).slice(0, 7) })).rejects.toMatchObject({
      status: 400,
      body: { code: 'COST_BOOK_AMOUNT_REQUIRED' },
    });
    const booked: CostPlanYear = await s.api('POST', `/costs/plans/${svcA}/lines/${vl.id}/book`, {
      month: day(0).slice(0, 7),
      amount: '321',
      reference: 'TR-1',
    });
    expect(booked.entries.find((e) => e.reference === 'TR-1')).toMatchObject({ amount: '321.00', planLineId: vl.id });
    // the proposed lines of a fiscal year spread the volume over its months
    expect(fiscalYearMonths(fy, 1)).toHaveLength(12);
  });
});

describe('applications and systems named on contracts', () => {
  it('are chosen per covered service and rolled up on the item, each line once, only what the reader may see', async () => {
    const { db } = await import('../src/db.js');
    const app = (await s.api('POST', '/applications', { name: 'Attributed app', owners: ['user:olivia'] })).id;
    const sys = (await s.api('POST', '/systems', { name: 'attributed-host', kind: 'vm' })).id;
    await s.api('POST', `/applications/${app}/systems`, { systemId: sys, environment: 'prod' });
    const svc1 = (await s.api('POST', '/services', { name: 'Attribution service 1', owners: ['user:olivia'] })).id;
    const svc2 = (await s.api('POST', '/services', { name: 'Attribution service 2' })).id;
    const hidden = (await s.api('POST', '/teams', { name: 'Attribution hidden team', members: [] })).id;
    db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('service', ?, ?, ?)", svc2, hidden, new Date().toISOString());
    await s.api('PUT', `/services/${svc1}/applications/${app}`, {});
    await s.api('PUT', `/services/${svc2}/applications/${app}`, {});
    const d: SupplierDetail = await s.api('POST', `/suppliers/${supplier}/contracts`, {
      title: 'Host support',
      services: [{ serviceId: svc1, purpose: 'Support of the host', items: [{ kind: 'system', id: sys }] }],
    });
    const contractId = d.contracts.find((c) => c.title === 'Host support')!.id;
    // an item that is not of the service is refused
    await expect(
      s.api('PUT', `/suppliers/${supplier}/contracts/${contractId}/services/${svc1}`, { items: [{ kind: 'application', id: 'app_nothing' }] }),
    ).rejects.toMatchObject({ status: 400, body: { code: 'SUPPLIER_CONTRACT_ITEM' } });
    const c: SupplierContractDetail = await olivia('GET', `/suppliers/${supplier}/contracts/${contractId}`);
    expect(c.contract.services[0]!.items).toEqual([{ kind: 'system', id: sys, name: 'attributed-host' }]);
    const fy = fiscalYearOf(day(0), 1);
    await s.api('POST', `/costs/plans/${svc1}/lines`, {
      fiscalYear: fy,
      title: 'App licence',
      category: 'licence',
      amount: '1200',
      currency: 'EUR',
      cadence: 'yearly',
      target: { kind: 'application', id: app },
    });
    await s.api('POST', `/costs/plans/${svc2}/lines`, {
      fiscalYear: fy,
      title: 'Hidden licence',
      category: 'licence',
      amount: '800',
      currency: 'EUR',
      cadence: 'yearly',
      target: { kind: 'application', id: app },
    });
    // the administrator sees both services: each line once, totals over both
    const all: CostAttribution = await s.api('GET', `/costs/attribution/application/${app}?fiscalYear=${fy}`);
    expect(all.lines.map((x) => x.title).sort()).toEqual(['App licence', 'Hidden licence']);
    expect(m(all.totals.find((x) => x.fiscalYear === fy && x.currency === 'EUR')!.planned)).toBe(2000);
    // olivia does not see service 2: neither listed nor counted
    const mine: CostAttribution = await olivia('GET', `/costs/attribution/application/${app}?fiscalYear=${fy}`);
    expect(mine.lines.map((x) => x.title)).toEqual(['App licence']);
    expect(m(mine.totals.find((x) => x.fiscalYear === fy)!.planned)).toBe(1200);
    // the system names its contract
    const onSystem: CostAttribution = await olivia('GET', `/costs/attribution/system/${sys}`);
    expect(onSystem.contracts).toMatchObject([{ id: contractId, named: true, services: [{ id: svc1, purpose: 'Support of the host' }] }]);
    // /api/v1 and MCP read the same
    const token = (await olivia('POST', '/me/tokens', { name: 'attribution', scope: 'read' })).token as string;
    const v1 = await fetch(`${s.base}/api/v1/applications/${app}/cost-attribution?fiscalYear=${fy}`, { headers: { authorization: `Bearer ${token}` } });
    expect(v1.status).toBe(200);
    expect(((await v1.json()) as CostAttribution).lines.map((x) => x.title)).toEqual(['App licence']);
    const pv1 = await fetch(`${s.base}/api/v1/platforms/${platform}/cost-plan`, { headers: { authorization: `Bearer ${token}` } });
    expect(pv1.status).toBe(200);
    expect(((await pv1.json()) as CostPlanYear).owner).toMatchObject({ kind: 'platform', id: platform });
  });
});

describe('at scale', () => {
  it("computes a platform's year of 200 lines and 2,000 entries with as many statements as one of each", async () => {
    const { db } = await import('../src/db.js');
    const { platformPlanYear } = await import('../src/costs/plans.js');
    const { requestDbStats } = await import('../src/database/timing.js');
    const p = (await s.api('POST', '/platforms', { name: 'Large plan platform', kind: 'rest', baseUrl: 'https://large.example.com' })).id;
    const now = new Date().toISOString();
    const insert = (lines: number, entries: number, tag: string) =>
      db().tx(() => {
        for (let i = 0; i < lines; i++)
          db().run(
            `INSERT INTO cost_plan_lines (id, service_id, platform_id, fiscal_year, title, category, vendor, amount, currency, cadence, note, created_at, created_by, updated_at, updated_by)
             VALUES (?, '', ?, 2045, ?, ?, '', 1000000, 'EUR', 'monthly', '', ?, 'admin', ?, 'admin')`,
            `cpl_p_${tag}_${i}`,
            p,
            `Line ${tag} ${i}`,
            i % 2 ? 'cloud' : 'support',
            now,
            now,
          );
        for (let i = 0; i < entries; i++)
          db().run(
            `INSERT INTO cost_entries (id, service_id, platform_id, entry_date, amount, currency, plan_line_id, reference, note, created_at, created_by, updated_at, updated_by)
             VALUES (?, '', ?, ?, 1000000, 'EUR', ?, '', '', ?, 'admin', ?, 'admin')`,
            `cen_p_${tag}_${i}`,
            p,
            `2045-${String((i % 12) + 1).padStart(2, '0')}-15`,
            i % 3 ? `cpl_p_${tag}_${i % Math.max(lines, 1)}` : null,
            now,
            now,
          );
      });
    const statements = (fn: () => void) => {
      const st = { statements: 0, ms: 0 };
      requestDbStats.run(st, fn);
      return st.statements;
    };
    const at = Date.parse('2045-08-15T12:00:00Z');
    insert(4, 4, 'few');
    const few = statements(() => platformPlanYear(p, 2045, at));
    insert(196, 1996, 'many');
    let y = platformPlanYear(p, 2045, at);
    expect([y.lines.length, y.entries.length]).toEqual([200, 2000]);
    const many = statements(() => (y = platformPlanYear(p, 2045, at)));
    expect(many).toBe(few);
    expect(many).toBeLessThan(30);
    db().run('DELETE FROM cost_entries WHERE platform_id = ?', p);
    db().run('DELETE FROM cost_plan_lines WHERE platform_id = ?', p);
  });
});
