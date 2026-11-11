import { beforeAll, describe, expect, it } from 'vitest';
import { toMicros, type CostCommitments, type CostPlanYear, type CostProposals, type CostScheduleList, type SupplierDetail } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Contract payments (0.18.0, ADR 0030 parts 2–3, docs/COSTS.md#contract-payments-and-commitments): payment schedules
 * on contracts and their rights, proposals confirmed per fiscal year and the line limit, "Contract changed" and
 * "Update lines", the fiscal-year start changed, the copy into the next year with contracts, prepaid rows, removing a
 * contract, merging suppliers, session-only writes and the audit trail.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let dana: Client;
let olivia: Client;
let vera: Client;
let service: string;
let supplier: string;
let contract: string;
let schedule: string;

const m = (v: string | null | undefined) => (v === null || v === undefined ? null : (toMicros(v) ?? 0) / 1_000_000);
const plan = (fy: number, c: Client = olivia): Promise<CostPlanYear> => c('GET', `/costs/plans/${service}?fiscalYear=${fy}`);
const audits = async (action: string) =>
  (await s.api('GET', `/audit?action=${action}&limit=20`)) as { summary: string; entityId: string; details: Record<string, unknown> }[];

const base = {
  title: 'Base fee',
  category: 'support',
  amount: '1000',
  currency: 'EUR',
  billing: 'monthly',
  yearAmounts: ['1030', '1060.90'],
};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  dana = await s.as('dana', PW);
  olivia = await s.as('olivia', PW);
  vera = await s.as('vera', PW);
  // the fiscal year starts in October (ADR 0030's example)
  await s.api('PUT', '/costs/settings', { hideAmountsFromViewers: false, defaultCurrency: 'EUR', fiscalYearStartMonth: 10 });
  service = (await s.api('POST', '/services', { name: 'Contract service', owners: ['user:olivia'] })).id;
  supplier = (await s.api('POST', '/suppliers', { name: 'Invented Payments GmbH', type: 'serviceProvider' })).id;
  const d: SupplierDetail = await s.api('POST', `/suppliers/${supplier}/contracts`, {
    title: 'Payment platform',
    reference: 'PP-1',
    startsOn: '2031-02-01',
    endsOn: '2034-01-31',
    noticeDays: 90,
    renewal: 'fixedEnd',
    // the paying service must be covered by the contract (ADR 0031)
    services: [{ serviceId: service, purpose: 'Payments' }],
  });
  contract = d.contracts[0]!.id;
}, 240_000);

describe('payment schedules', () => {
  it('are added by who may change the contract, or who edits the paying service and sees the supplier', async () => {
    // a viewer may do neither
    await expect(vera('POST', '/costs/schedules', { ...base, contractId: contract, serviceId: service })).rejects.toMatchObject({
      status: 403,
      body: { code: 'COST_SCHEDULE_FORBIDDEN' },
    });
    // the service's owner (not a designer) may: they edit the paying service and see the supplier
    const l: CostScheduleList = await olivia('POST', '/costs/schedules', { ...base, contractId: contract, serviceId: service });
    expect(l.schedules).toHaveLength(1);
    schedule = l.schedules[0]!.id;
    expect(l.schedules[0]).toMatchObject({
      title: 'Base fee',
      amount: '1000.00',
      billing: 'monthly',
      effectiveStart: '2031-02-01',
      effectiveEnd: '2034-01-31',
      yearAmounts: ['1030.00', '1060.90'],
      serviceName: 'Contract service',
      supplier: { id: supplier },
      contract: { id: contract, title: 'Payment platform' },
      canEdit: true,
    });
    // who may change the contract (an administrator, a designer) adds payments for another service – here one of a
    // team the service's owner is not in
    const designer: CostScheduleList = await dana('GET', `/costs/schedules?contractId=${contract}`);
    expect(designer.canAdd).toBe(true);
    const other = (await s.api('POST', '/services', { name: 'Other paying service' })).id;
    const { db } = await import('../src/db.js');
    const team = (await s.api('POST', '/teams', { name: 'Payments secret team' })).id;
    db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('service', ?, ?, ?)", other, team, new Date().toISOString());
    const two: CostScheduleList = await s.api('POST', '/costs/schedules', {
      ...base,
      title: 'Setup',
      billing: 'once',
      amount: '500',
      yearAmounts: [],
      contractId: contract,
      serviceId: other,
    });
    expect(two.schedules.map((x) => x.title).sort()).toEqual(['Base fee', 'Setup']);
    // the service's owner does not see the other service: its schedule is neither named nor counted
    const mine: CostScheduleList = await olivia('GET', `/costs/schedules?contractId=${contract}`);
    expect(mine.schedules.map((x) => x.title)).toEqual(['Base fee']);
    const removed = two.schedules.find((x) => x.title === 'Setup')!.id;
    await s.api('DELETE', `/costs/schedules/${removed}`);
    const a = await audits('cost.schedule_added');
    expect(a.find((x) => x.entityId === service)!.summary).toBe(
      'Payment schedule "Base fee" of the contract "Payment platform" (Invented Payments GmbH) added for "Contract service": 1000.00 EUR monthly',
    );
    expect((await audits('cost.schedule_removed'))[0]!.entityId).toBe(other);
  });

  it('check amounts, decimals, limits of the input and the target', async () => {
    await expect(olivia('POST', '/costs/schedules', { ...base, amount: '0', contractId: contract, serviceId: service })).rejects.toMatchObject({ status: 400 });
    await expect(
      olivia('POST', '/costs/schedules', { ...base, currency: 'JPY', amount: '10.5', yearAmounts: [], contractId: contract, serviceId: service }),
    ).rejects.toMatchObject({
      status: 400,
    });
    await expect(olivia('POST', '/costs/schedules', { ...base, billing: 'dates', contractId: contract, serviceId: service })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      olivia('POST', '/costs/schedules', { ...base, contractId: contract, serviceId: service, target: { kind: 'application', id: 'app_nothing' } }),
    ).rejects.toMatchObject({ status: 400, body: { code: 'COST_PLAN_TARGET' } });
  });

  it('need a signed-in session (no API tokens)', async () => {
    const token = (await olivia('POST', '/me/tokens', { name: 'schedules', scope: 'full' })).token as string;
    const res = await fetch(`${s.base}/api/costs/schedules`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, contractId: contract, serviceId: service }),
    });
    expect(res.status).toBe(403);
    // reading works with a token
    const read = await fetch(`${s.base}/api/costs/schedules?serviceId=${service}`, { headers: { authorization: `Bearer ${token}` } });
    expect(read.status).toBe(200);
  });
});

describe('proposals per fiscal year', () => {
  it('list the contract payments to plan, confirmed by a person per fiscal year', async () => {
    const before = await plan(2030);
    expect(before.lines).toHaveLength(0);
    expect(before.proposals).toBe(1);
    const p: CostProposals = await olivia('GET', `/costs/plans/${service}/proposals?fiscalYear=2030`);
    expect(p.proposals).toHaveLength(1);
    expect(p.proposals[0]!.title).toBe('Payment platform – Base fee');
    expect(p.proposals[0]!.lines.map((l) => [l.cadence, l.fromMonth, l.toMonth, l.amount])).toEqual([['monthly', '2031-02', '2031-09', '1000.00']]);
    // nothing without a person; a viewer may not confirm
    await expect(vera('POST', `/costs/plans/${service}/proposals`, { fiscalYear: 2030, scheduleIds: [schedule] })).rejects.toMatchObject({ status: 403 });
    const y: CostPlanYear = await olivia('POST', `/costs/plans/${service}/proposals`, { fiscalYear: 2030, scheduleIds: [schedule] });
    expect(y.lines.map((l) => [l.title, l.cadence, l.fromMonth, l.toMonth, l.planned])).toEqual([
      ['Payment platform – Base fee', 'monthly', '2031-02', '2031-09', '8000.00'],
    ]);
    expect(y.lines[0]!.schedule).toMatchObject({ id: schedule, contractId: contract, changed: false });
    expect(y.lines[0]!.supplierContract?.id).toBe(contract);
    expect(y.proposals).toBe(0);
    // confirmed twice: nothing left to plan
    await expect(olivia('POST', `/costs/plans/${service}/proposals`, { fiscalYear: 2030, scheduleIds: [schedule] })).rejects.toMatchObject({
      status: 409,
      body: { code: 'COST_PROPOSAL_NONE' },
    });
    // a price change inside the year: two lines
    const y2: CostPlanYear = await olivia('POST', `/costs/plans/${service}/proposals`, { fiscalYear: 2031, scheduleIds: [schedule] });
    expect(y2.lines.map((l) => [l.fromMonth, l.toMonth, l.amount])).toEqual([
      ['2031-10', '2032-01', '1000.00'],
      ['2032-02', '2032-09', '1030.00'],
    ]);
    // Book takes the schedule's payment date
    expect(y2.lines[1]!.paymentDates?.[4]).toBe('2032-02-01');
    const audit = (await audits('cost.contract_lines_added'))[0]!;
    expect(audit.summary).toContain('2 contract line(s) of 1 payment schedule(s)');
  });

  it('count against the 200 plan lines of a year, refused with the number', async () => {
    const { db } = await import('../src/db.js');
    const now = new Date().toISOString();
    for (let i = 0; i < 199; i++)
      db().run(
        `INSERT INTO cost_plan_lines (id, service_id, fiscal_year, title, category, amount, currency, cadence, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, 2032, ?, 'other', 1000000, 'EUR', 'yearly', ?, 'admin', ?, 'admin')`,
        `cpl_fill_${i}`,
        service,
        `Filler ${i}`,
        now,
        now,
      );
    await expect(olivia('POST', `/costs/plans/${service}/proposals`, { fiscalYear: 2032, scheduleIds: [schedule] })).rejects.toMatchObject({
      status: 409,
      body: { code: 'COST_PROPOSAL_LIMIT', params: { adding: 2, left: 1 } },
    });
    db().run("DELETE FROM cost_plan_lines WHERE id LIKE 'cpl_fill_%'");
  });
});

describe('Contract changed and Update lines', () => {
  it('show the difference when the contract changes, and apply the selected changes', async () => {
    // the contract ends a year earlier: FY 2032/33 loses its lines, FY 2031/32 is unchanged
    await s.api('PUT', `/suppliers/${supplier}/contracts/${contract}`, {
      title: 'Payment platform',
      reference: 'PP-1',
      startsOn: '2031-02-01',
      endsOn: '2032-04-30',
      noticeDays: 90,
      renewal: 'fixedEnd',
    });
    let y = await plan(2031);
    expect(y.lines.every((l) => l.schedule?.changed)).toBe(true);
    const ch = y.contractChanges[0]!;
    expect(ch.scheduleId).toBe(schedule);
    expect(ch.changes.map((c) => [c.part, c.before?.toMonth ?? null, c.after?.toMonth ?? null])).toEqual([['y2', '2032-09', '2032-04']]);
    // a line changed by hand: "before" is what it plans now
    const y2line = y.lines.find((l) => l.fromMonth === '2032-02')!;
    await olivia('PUT', `/costs/plans/${service}/lines/${y2line.id}`, {
      title: y2line.title,
      category: 'support',
      amount: '1050',
      currency: 'EUR',
      cadence: 'monthly',
      fromMonth: '2032-02',
      toMonth: '2032-09',
    });
    y = await plan(2031);
    expect(y.contractChanges[0]!.changes[0]!.before?.amount).toBe('1050.00');
    expect(y.lines.find((l) => l.id === y2line.id)!.schedule?.id).toBe(schedule);
    // an entry on the line stays with it
    await olivia('POST', `/costs/plans/${service}/entries`, {
      date: '2032-02-01',
      amount: '1030',
      currency: 'EUR',
      planLineId: y2line.id,
      reference: 'PP-2032-02',
    });
    y = await olivia('POST', `/costs/plans/${service}/contract-updates`, { fiscalYear: 2031, changes: [{ scheduleId: schedule, part: 'y2' }] });
    expect(y.contractChanges).toEqual([]);
    expect(y.lines.find((l) => l.id === y2line.id)).toMatchObject({ fromMonth: '2032-02', toMonth: '2032-04', amount: '1030.00', planned: '3090.00' });
    expect(y.entries.find((e) => e.reference === 'PP-2032-02')!.unplanned).toBe(false);
    const u = (await audits('cost.contract_lines_updated'))[0]!;
    expect(u.details).toMatchObject({
      fiscalYear: 2031,
      lines: [{ kind: 'changed', before: { amount: '1050.00' }, after: { amount: '1030.00', toMonth: '2032-04' } }],
    });
    // the same change again no longer applies
    await expect(
      olivia('POST', `/costs/plans/${service}/contract-updates`, { fiscalYear: 2031, changes: [{ scheduleId: schedule, part: 'y2' }] }),
    ).rejects.toMatchObject({
      status: 409,
      body: { code: 'COST_UPDATE_STALE' },
    });
  });

  it('remove a part that is gone (its entries become unplanned) and add a new one', async () => {
    // plan FY 2032/33 while the contract still had it: back to the old end, confirm, then shorten again
    const longer = { title: 'Payment platform', reference: 'PP-1', startsOn: '2031-02-01', endsOn: '2034-01-31', noticeDays: 90, renewal: 'fixedEnd' };
    await s.api('PUT', `/suppliers/${supplier}/contracts/${contract}`, longer);
    await olivia('POST', `/costs/plans/${service}/contract-updates`, { fiscalYear: 2031, changes: [{ scheduleId: schedule, part: 'y2' }] });
    let y: CostPlanYear = await olivia('POST', `/costs/plans/${service}/proposals`, { fiscalYear: 2032, scheduleIds: [schedule] });
    const gone = y.lines.find((l) => l.fromMonth === '2032-10')!;
    await olivia('POST', `/costs/plans/${service}/entries`, {
      date: '2032-10-01',
      amount: '1030',
      currency: 'EUR',
      planLineId: gone.id,
      reference: 'PP-2032-10',
    });
    await s.api('PUT', `/suppliers/${supplier}/contracts/${contract}`, { ...longer, endsOn: '2032-09-30' });
    y = await plan(2032);
    const changes = y.contractChanges[0]!.changes;
    expect(changes.every((c) => c.after === null)).toBe(true);
    expect(changes.find((c) => c.lineId === gone.id)!.entries).toBe(1);
    y = await olivia('POST', `/costs/plans/${service}/contract-updates`, {
      fiscalYear: 2032,
      changes: changes.map((c) => ({ scheduleId: schedule, part: c.part })),
    });
    expect(y.lines).toHaveLength(0);
    expect(y.entries.find((e) => e.reference === 'PP-2032-10')!.unplanned).toBe(true);
    // a new part: the contract runs longer again, FY 2031/32 is complete (no change), FY 2032/33 has no lines (a proposal)
    await s.api('PUT', `/suppliers/${supplier}/contracts/${contract}`, longer);
    expect((await plan(2032)).proposals).toBe(1);
    // the price of year 3 changes on the schedule: FY 2031/32 is unchanged (years 1 and 2)
    await olivia('PUT', `/costs/schedules/${schedule}`, { ...base, yearAmounts: ['1030', '1100'] });
    expect((await plan(2031)).contractChanges).toEqual([]);
  });

  it('never offers fiscal years that are over', async () => {
    const past = (await s.api('POST', '/services', { name: 'Past contract service', owners: ['user:olivia'] })).id;
    const old: SupplierDetail = await s.api('POST', `/suppliers/${supplier}/contracts`, {
      title: 'Old contract',
      startsOn: '2020-01-01',
      endsOn: '2022-12-31',
    });
    const oldId = old.contracts.find((c) => c.title === 'Old contract')!.id;
    const sch: CostScheduleList = await s.api('POST', '/costs/schedules', { ...base, contractId: oldId, serviceId: past });
    await s.api('POST', `/costs/plans/${past}/proposals`, { fiscalYear: 2020, scheduleIds: [sch.schedules[0]!.id] });
    await s.api('PUT', `/suppliers/${supplier}/contracts/${oldId}`, { title: 'Old contract', startsOn: '2020-01-01', endsOn: '2021-06-30' });
    const y: CostPlanYear = await s.api('GET', `/costs/plans/${past}?fiscalYear=2020`);
    expect(y.contractChanges).toEqual([]);
    expect(y.lines.every((l) => !l.schedule?.changed)).toBe(true);
    await expect(
      s.api('POST', `/costs/plans/${past}/contract-updates`, { fiscalYear: 2020, changes: [{ scheduleId: sch.schedules[0]!.id, part: 'y1' }] }),
    ).rejects.toMatchObject({ status: 409, body: { code: 'COST_UPDATE_PAST_YEAR' } });
  });

  it('hint when the fiscal-year start changes, and unlink a line from its contract', async () => {
    await s.api('PUT', '/costs/settings', { hideAmountsFromViewers: false, defaultCurrency: 'EUR', fiscalYearStartMonth: 1 });
    try {
      // FY 2031 now runs January to December: the positions stay, the proposal moved
      const y = await plan(2031);
      const line = y.lines.find((l) => l.schedule)!;
      expect(line.schedule!.changed).toBe(true);
      const unlinked: CostPlanYear = await olivia('PUT', `/costs/plans/${service}/lines/${line.id}`, {
        title: line.title,
        category: line.category,
        amount: line.amount,
        currency: line.currency,
        cadence: line.cadence,
        fromMonth: line.fromMonth,
        toMonth: line.toMonth,
        scheduleId: null,
      });
      const after = unlinked.lines.find((l) => l.id === line.id)!;
      expect(after.schedule).toBeNull();
      expect(after.supplierContract?.id).toBe(contract);
    } finally {
      await s.api('PUT', '/costs/settings', { hideAmountsFromViewers: false, defaultCurrency: 'EUR', fiscalYearStartMonth: 10 });
    }
  });
});

describe('copy to the next fiscal year with contracts', () => {
  it('proposes schedule lines, shortens and leaves out 0.17 contract lines, and is not blocked by early contract lines', async () => {
    const svc = (await s.api('POST', '/services', { name: 'Copy service', owners: ['user:olivia'] })).id;
    const sup: SupplierDetail = await s.api('POST', `/suppliers/${supplier}/contracts`, {
      title: 'Ends in March',
      startsOn: '2030-01-01',
      endsOn: '2042-03-15',
      services: [{ serviceId: svc }],
    });
    const endsInMarch = sup.contracts.find((c) => c.title === 'Ends in March')!.id;
    const sup2: SupplierDetail = await s.api('POST', `/suppliers/${supplier}/contracts`, {
      title: 'Ended',
      startsOn: '2030-01-01',
      endsOn: '2041-09-30',
      services: [{ serviceId: svc }],
    });
    const ended = sup2.contracts.find((c) => c.title === 'Ended')!.id;
    const longC: SupplierDetail = await s.api('POST', `/suppliers/${supplier}/contracts`, {
      title: 'Long',
      startsOn: '2040-10-01',
      endsOn: '2045-09-30',
      services: [{ serviceId: svc }],
    });
    const long = longC.contracts.find((c) => c.title === 'Long')!.id;
    const line = (title: string, extra: Record<string, unknown>) =>
      olivia('POST', `/costs/plans/${svc}/lines`, { fiscalYear: 2040, title, category: 'support', currency: 'EUR', supplierId: supplier, ...extra });
    await line('Monthly until March', { amount: '100', cadence: 'monthly', supplierContractId: endsInMarch });
    await line('Yearly until March', { amount: '1200', cadence: 'yearly', supplierContractId: endsInMarch });
    await line('Ended contract', { amount: '100', cadence: 'monthly', supplierContractId: ended });
    await line('No contract', { amount: '50', cadence: 'monthly' });
    const sch: CostScheduleList = await olivia('POST', '/costs/schedules', { ...base, title: 'Licence', yearAmounts: [], contractId: long, serviceId: svc });
    await olivia('POST', `/costs/plans/${svc}/proposals`, { fiscalYear: 2040, scheduleIds: [sch.schedules[0]!.id] });
    // the next year's contract lines confirmed early do not block the copy
    await olivia('POST', `/costs/plans/${svc}/proposals`, { fiscalYear: 2041, scheduleIds: [sch.schedules[0]!.id] });
    const y: CostPlanYear = await olivia('POST', `/costs/plans/${svc}/copy`, { fiscalYear: 2040 });
    expect(y.copyResult).toEqual({
      copied: ['Yearly until March', 'No contract'],
      proposed: [],
      shortened: ['Monthly until March'],
      leftOut: ['Ended contract'],
    });
    expect(y.lines.find((l) => l.title === 'Monthly until March')).toMatchObject({ fromMonth: '2041-10', toMonth: '2042-03' });
    expect(y.lines.find((l) => l.title === 'Yearly until March')!.contractEnds).toBe('2042-03-15');
    // the schedule's lines were confirmed already: not added twice
    expect(y.lines.filter((l) => l.schedule)).toHaveLength(1);
    // a hand-made line for a contract with a schedule: a hint
    await line('Hand-made Long', { amount: '10', cadence: 'monthly', supplierContractId: long });
    expect((await olivia<CostPlanYear>('GET', `/costs/plans/${svc}?fiscalYear=2040`)).lines.find((l) => l.title === 'Hand-made Long')!.twoLines).toBe(true);
    // a year with hand-made lines is not copied into again
    await expect(olivia('POST', `/costs/plans/${svc}/copy`, { fiscalYear: 2040 })).rejects.toMatchObject({
      status: 409,
      body: { code: 'COST_PLAN_YEAR_NOT_EMPTY' },
    });
    // a copy into a year without the schedule's lines adds its proposal
    const z: CostPlanYear = await olivia('POST', `/costs/plans/${svc}/copy`, { fiscalYear: 2041 });
    expect(z.copyResult!.proposed).toEqual(['Long – Licence']);
    expect([...z.copyResult!.leftOut].sort()).toEqual(['Monthly until March', 'Yearly until March']);
    expect(z.lines.filter((l) => l.schedule)).toHaveLength(1);
    const audit = (await audits('cost.plan_copied'))[1]!;
    expect(audit.details).toMatchObject({ shortened: ['Monthly until March'], leftOut: ['Ended contract'] });
  });
});

describe('prepaid payments', () => {
  it('count in the year paid, with quiet rows in the years they cover', async () => {
    const svc = (await s.api('POST', '/services', { name: 'Prepaid service', owners: ['user:olivia'] })).id;
    const c: SupplierDetail = await s.api('POST', `/suppliers/${supplier}/contracts`, {
      title: 'Historian licence',
      startsOn: '2035-02-01',
      endsOn: '2038-01-31',
      services: [{ serviceId: svc }],
    });
    const cid = c.contracts.find((x) => x.title === 'Historian licence')!.id;
    const sch: CostScheduleList = await olivia('POST', '/costs/schedules', {
      title: 'Three years prepaid',
      category: 'licence',
      amount: '36000',
      currency: 'EUR',
      billing: 'once',
      contractId: cid,
      serviceId: svc,
    });
    const y: CostPlanYear = await olivia('POST', `/costs/plans/${svc}/proposals`, { fiscalYear: 2034, scheduleIds: [sch.schedules[0]!.id] });
    expect(y.lines[0]).toMatchObject({ cadence: 'once', onceMonth: '2035-02', coversFrom: '2035-02-01', coversTo: '2038-01-31', planned: '36000.00' });
    for (const fy of [2035, 2036, 2037]) {
      const later = await olivia<CostPlanYear>('GET', `/costs/plans/${svc}?fiscalYear=${fy}`);
      expect(later.prepaid).toEqual([
        expect.objectContaining({ fiscalYear: 2034, label: 'FY 2034/35', amount: '36000.00', coversFrom: '2035-02-01', coversTo: '2038-01-31' }),
      ]);
      expect(later.currencies).toEqual([]);
    }
    expect((await olivia<CostPlanYear>('GET', `/costs/plans/${svc}?fiscalYear=2038`)).prepaid).toEqual([]);
  });
});

describe('removing a contract and merging suppliers', () => {
  it('removes its schedules; lines made from them stay as ordinary lines with their amounts', async () => {
    const svc = (await s.api('POST', '/services', { name: 'Removal service', owners: ['user:olivia'] })).id;
    const c: SupplierDetail = await s.api('POST', `/suppliers/${supplier}/contracts`, {
      title: 'Short-lived',
      startsOn: '2036-01-01',
      endsOn: '2036-12-31',
      services: [{ serviceId: svc }],
    });
    const cid = c.contracts.find((x) => x.title === 'Short-lived')!.id;
    const sch: CostScheduleList = await olivia('POST', '/costs/schedules', { ...base, yearAmounts: [], contractId: cid, serviceId: svc });
    await olivia('POST', `/costs/plans/${svc}/proposals`, { fiscalYear: 2035, scheduleIds: [sch.schedules[0]!.id] });
    await s.api('DELETE', `/suppliers/${supplier}/contracts/${cid}`);
    const y = await olivia<CostPlanYear>('GET', `/costs/plans/${svc}?fiscalYear=2035`);
    expect(y.lines[0]).toMatchObject({ schedule: null, supplier: { id: supplier }, supplierContract: null, amount: '1000.00' });
    const r = (await audits('cost.schedule_removed'))[0]!;
    expect(r).toMatchObject({ entityId: svc, details: { contractRemoved: true, linesUnlinked: 1 } });
  });

  it('moves contracts with their schedules when suppliers are merged; archiving keeps them', async () => {
    const other = (await s.api('POST', '/suppliers', { name: 'Invented Payments Duplicate' })).id;
    const c: SupplierDetail = await s.api('POST', `/suppliers/${other}/contracts`, {
      title: 'Duplicate contract',
      startsOn: '2036-01-01',
      endsOn: '2037-12-31',
      services: [{ serviceId: service }],
    });
    const cid = c.contracts[0]!.id;
    await olivia('POST', '/costs/schedules', { ...base, yearAmounts: [], contractId: cid, serviceId: service });
    await s.api('POST', `/suppliers/${other}/merge`, { into: supplier });
    const l: CostScheduleList = await olivia('GET', `/costs/schedules?contractId=${cid}`);
    expect(l.schedules[0]!.supplier?.id).toBe(supplier);
    await s.api('POST', `/suppliers/${supplier}/archive`, { archived: true });
    expect((await olivia<CostScheduleList>('GET', `/costs/schedules?serviceId=${service}`)).schedules.length).toBeGreaterThan(0);
    // no new schedule on an archived supplier's contract
    await expect(olivia('POST', '/costs/schedules', { ...base, contractId: cid, serviceId: service })).rejects.toMatchObject({
      status: 409,
      body: { code: 'SUPPLIER_ARCHIVED' },
    });
    await s.api('POST', `/suppliers/${supplier}/archive`, { archived: false });
    expect(m('1')).toBe(1);
  });
});

describe('commitments', () => {
  let svc: string;
  let hiddenSvc: string;
  let secretSupplier: string;
  let team: string;
  const MODERN = '2026-07-28';
  async function mcp(token: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: any }> {
    const res = await fetch(`${s.base}/api/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        'mcp-protocol-version': MODERN,
        'mcp-method': 'tools/call',
        'mcp-name': name,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name,
          arguments: args,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MODERN,
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
          },
        },
      }),
    });
    const r = JSON.parse(await res.text()).result;
    return { isError: !!r.isError, data: r.isError ? r.content[0].text : r.structuredContent };
  }

  beforeAll(async () => {
    const { db } = await import('../src/db.js');
    svc = (await s.api('POST', '/services', { name: 'Committed service', owners: ['user:olivia'] })).id;
    // the documentation's contract: ends 31 January 2027, 90 days' notice, renews by 12 months
    const sup: SupplierDetail = await s.api('POST', `/suppliers/${supplier}/contracts`, {
      title: 'Hosting renewing',
      startsOn: '2024-02-01',
      endsOn: '2027-01-31',
      noticeDays: 90,
      renewal: 'automatic',
      renewalMonths: 12,
      services: [{ serviceId: svc }],
    });
    const hosting = sup.contracts.find((c) => c.title === 'Hosting renewing')!.id;
    await olivia('POST', '/costs/schedules', { ...base, yearAmounts: [], startsOn: '2024-02-01', endsOn: '2029-01-31', contractId: hosting, serviceId: svc });
    // a service of a team the viewer is not in, and a supplier of such a team
    team = (await s.api('POST', '/teams', { name: 'Commitment secret team' })).id;
    hiddenSvc = (await s.api('POST', '/services', { name: 'Hidden committed service' })).id;
    db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('service', ?, ?, ?)", hiddenSvc, team, new Date().toISOString());
    await s.api('POST', '/costs/schedules', { ...base, title: 'Hidden fee', yearAmounts: [], contractId: hosting, serviceId: hiddenSvc });
    secretSupplier = (await s.api('POST', '/suppliers', { name: 'Secret Licensing AG' })).id;
    const sc: SupplierDetail = await s.api('POST', `/suppliers/${secretSupplier}/contracts`, {
      title: 'Secret licence',
      startsOn: '2040-01-01',
      endsOn: '2041-12-31',
    });
    await s.api('POST', '/costs/schedules', {
      ...base,
      title: 'Secret fee',
      amount: '500',
      yearAmounts: [],
      contractId: sc.contracts[0]!.id,
      serviceId: svc,
    });
    db().run(
      "INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('supplier', ?, ?, ?)",
      secretSupplier,
      team,
      new Date().toISOString(),
    );
  });

  it('owe to contract end and to the earliest exit as of a day, with the notice warning', async () => {
    const { commitments } = await import('../src/costs/commitments.js');
    // a job (no reader) on 11 November 2026
    const c = commitments({ serviceId: svc }, Date.parse('2026-11-11T12:00:00Z'));
    const row = c.rows.find((r) => r.title === 'Base fee')!;
    expect(row).toMatchObject({ toContractEnd: '26000.00', toEarliestExit: '14000.00', earliestExit: '2028-01-31', nextPayment: { date: '2026-12-01' } });
    expect(c.years.map((y) => y.label)).toEqual(['FY 2026/27', 'FY 2027/28', 'FY 2028/29', 'FY 2029/30', 'FY 2030/31']);
    expect(row.years).toEqual(['10000.00', '12000.00', '4000.00', '0.00', '0.00']);
    // the notice-by date is ahead, and FY 2027/28 – where the next term would start – has no lines of the service
    expect(row.warning).toMatchObject({ noticeBy: '2027-11-02', label: 'FY 2027/28' });
    expect(c.rows[0]!.warning).not.toBeNull();
    // planned there: no warning
    await olivia('POST', `/costs/plans/${svc}/lines`, {
      fiscalYear: 2027,
      title: 'Something',
      category: 'other',
      amount: '1',
      currency: 'EUR',
      cadence: 'once',
      onceMonth: '2027-10',
    });
    expect(commitments({ serviceId: svc }, Date.parse('2026-11-11T12:00:00Z')).rows.find((r) => r.title === 'Base fee')!.warning).toBeNull();
  });

  it('name and count only services the reader may see; a hidden supplier shows amounts only', async () => {
    const all: CostCommitments = await s.api('GET', '/costs/commitments');
    expect(all.rows.some((r) => r.serviceId === hiddenSvc)).toBe(true);
    const mine: CostCommitments = await olivia('GET', '/costs/commitments');
    expect(mine.rows.some((r) => r.serviceId === hiddenSvc)).toBe(false);
    // totals add only what the reader sees
    const eur = (c: CostCommitments) => m(c.totals.find((t) => t.currency === 'EUR')?.toContractEnd);
    expect(eur(all)! - eur(mine)!).toBeGreaterThan(0);
    const secret = mine.rows.find((r) => r.title === 'Secret fee')!;
    expect(secret).toMatchObject({ contractHidden: true, supplier: null, contract: null, contractEnd: null, noticeBy: null, toContractEnd: '12000.00' });
    // the supplier's own page: 404 for who may not see it, its contracts only for who may
    await expect(olivia('GET', `/costs/commitments?supplierId=${secretSupplier}`)).rejects.toMatchObject({ status: 404 });
    const bySupplier: CostCommitments = await olivia('GET', `/costs/commitments?supplierId=${supplier}`);
    expect(bySupplier.rows.every((r) => r.supplier?.id === supplier)).toBe(true);
    expect(bySupplier.incurred).toBeDefined();
    // team scope: a team the reader is not in answers 404
    await expect(olivia('GET', `/costs/commitments?teamId=${team}`)).rejects.toMatchObject({ status: 404 });
    expect((await s.api<CostCommitments>('GET', `/costs/commitments?teamId=${team}`)).rows.map((r) => r.serviceId)).toEqual([hiddenSvc]);
  });

  it('follow "Hide amounts from viewers"', async () => {
    await s.api('PUT', '/costs/settings', { hideAmountsFromViewers: true, defaultCurrency: 'EUR', fiscalYearStartMonth: 10 });
    try {
      const v: CostCommitments = await vera('GET', `/costs/commitments?serviceId=${svc}`);
      expect(v.rows.length).toBeGreaterThan(0);
      expect(v.rows.every((r) => !r.amountsVisible && r.toContractEnd === null && r.years.every((x) => x === null))).toBe(true);
      expect(v.totals).toEqual([]);
    } finally {
      await s.api('PUT', '/costs/settings', { hideAmountsFromViewers: false, defaultCurrency: 'EUR', fiscalYearStartMonth: 10 });
    }
  });

  it('are in /api/v1, MCP, the CSV export, the dataset and the supplier in /api/v1', async () => {
    const token = (await olivia('POST', '/me/tokens', { name: 'commitments', scope: 'read' })).token as string;
    const v1 = async (path: string) => {
      const res = await fetch(`${s.base}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status, path).toBe(200);
      return res.json();
    };
    const page = await v1(`/cost-commitments?serviceId=${svc}&limit=1`);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const plan = await v1(`/services/${svc}/cost-plan`);
    expect(plan.commitments.length).toBeGreaterThan(0);
    const sup = await v1(`/suppliers/${supplier}`);
    expect(sup.contracts.find((c: { title: string }) => c.title === 'Hosting renewing').paymentSchedules.map((x: { title: string }) => x.title)).toEqual([
      'Base fee',
    ]);
    await s.api('PUT', '/mcp-server', { enabled: true });
    const mcpToken = (await olivia('POST', '/me/tokens', { name: 'commitments-mcp', scope: 'mcp' })).token as string;
    const tool = await mcp(mcpToken, 'list_cost_commitments', { serviceId: svc });
    expect(tool.isError).toBe(false);
    expect(tool.data.items.find((x: { title: string }) => x.title === 'Secret fee').contract).toBe('a contract of a supplier you may not see');
    const csv: string = await olivia('GET', `/costs/commitments/export?serviceId=${svc}`);
    expect(csv).toContain('Service id,Service,Supplier,Contract,Schedule');
    expect(csv).toContain('Committed service');
    const { publishCommitmentsDataset } = await import('../src/costs/commitments.js');
    expect(publishCommitmentsDataset(true)).toBe(true);
    const ds = await s.api('GET', '/datasets/costs.commitments');
    expect(ds.rows.some((r: { Schedule: string }) => r.Schedule === 'Hidden fee')).toBe(true);
    await expect(vera('GET', '/datasets/costs.commitments')).rejects.toMatchObject({ status: 404 });
  });

  it('switch off with the Costs module', async () => {
    await s.api('PUT', '/settings/modules/costs', { enabled: false });
    try {
      await expect(olivia('GET', '/costs/commitments')).rejects.toMatchObject({ status: 404, body: { code: 'MODULE_OFF' } });
      await expect(olivia('GET', `/costs/schedules?serviceId=${svc}`)).rejects.toMatchObject({ status: 404 });
      const token = (await olivia('POST', '/me/tokens', { name: 'off', scope: 'read' })).token as string;
      const res = await fetch(`${s.base}/api/v1/cost-commitments`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(404);
      // contracts stay core
      expect((await olivia<SupplierDetail>('GET', `/suppliers/${supplier}`)).contracts.length).toBeGreaterThan(0);
    } finally {
      await s.api('PUT', '/settings/modules/costs', { enabled: true });
    }
  });
});
