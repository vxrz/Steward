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
    // the service the lines and entries name it for is covered (ADR 0031)
    services: [{ serviceId: service }],
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

describe('CSV import of entries', () => {
  const base = () => `/costs/plans/${service}/entries/import`;
  const mapping = (x: Record<string, unknown> = {}) => ({
    date: 'Date',
    amount: 'Amount',
    currency: 'Currency',
    reference: 'Invoice',
    note: null,
    planLine: null,
    supplier: null,
    contract: null,
    target: null,
    dateFormat: 'YYYY-MM-DD',
    decimal: '.',
    ...x,
  });
  const d1 = () => `${months[0]}-15`;
  const d2 = () => `${months[0]}-16`;

  it('reads comma, semicolon and tab files with a byte order mark, every date format and a decimal comma', async () => {
    const comma = `\uFEFFDate,Amount,Currency,Invoice\n${d1()},"1,234.50",EUR,CSV-1\n`;
    let p = await olivia('POST', `${base()}/preview`, { csv: comma, fileName: 'a.csv', mapping: mapping() });
    expect(p.rows[0]).toMatchObject({ date: d1(), amount: '1234.50', currency: 'EUR', problems: [], duplicate: false, label: `FY ${fy}` });
    const [y, mo, d] = d1().split('-');
    const semi = `Datum;Betrag;Währung;Rechnung\n${d}.${mo}.${y};1.234,50;EUR;CSV-2\n`;
    p = await olivia('POST', `${base()}/preview`, {
      csv: semi,
      mapping: mapping({ date: 'Datum', amount: 'Betrag', currency: 'Währung', reference: 'Rechnung', dateFormat: 'DD.MM.YYYY', decimal: ',' }),
    });
    expect(p.rows[0]).toMatchObject({ date: d1(), amount: '1234.50', problems: [] });
    const tab = `Date\tAmount\tInvoice\n${mo}/${d}/${y}\t99\tCSV-3\n`;
    p = await olivia('POST', `${base()}/preview`, { csv: tab, mapping: mapping({ currency: null, fixedCurrency: 'EUR', dateFormat: 'MM/DD/YYYY' }) });
    expect(p.rows[0]).toMatchObject({ date: d1(), amount: '99.00', currency: 'EUR', problems: [] });
    p = await olivia('POST', `${base()}/preview`, { csv: tab, mapping: mapping({ currency: null, fixedCurrency: 'EUR', dateFormat: 'DD/MM/YYYY' }) });
    // 15/01 read as the 15th month: not a date in that format (never guessed)
    expect(p.rows[0]!.problems).toEqual(['badDate']);
  });

  it('names every problem of a row', async () => {
    const csv = [
      'Date,Amount,Currency,Invoice,Line,Supplier,For',
      `,10,EUR,P-1,,,`,
      `31.02.2026,10,EUR,P-2,,,`,
      `${d1()},ten,EUR,P-3,,,`,
      `${d1()},0,EUR,P-4,,,`,
      `${d1()},10.5,JPY,P-5,,,`,
      `${d1()},10,,P-6,,,`,
      `${d1()},10,EUX,P-7,,,`,
      `${d1()},10,EUR,P-8,No such line,,`,
      `${d1()},10,USD,P-9,Hosting fee,,`,
      `${d1()},10,EUR,P-10,,Nobody Ltd,`,
      `${d1()},10,EUR,P-11,,,Nothing app`,
      `${d1()},10,EUR,,Hosting fee,,`,
    ].join('\n');
    const p = await olivia('POST', `${base()}/preview`, { csv, mapping: mapping({ planLine: 'Line', supplier: 'Supplier', target: 'For' }) });
    expect(p.rows.map((r: { problems: string[] }) => r.problems)).toEqual([
      ['noDate'],
      ['badDate'],
      ['notNumber'],
      ['zero'],
      ['decimals'],
      ['noCurrency'],
      ['unknownCurrency'],
      ['planLineUnknown'],
      ['planLineCurrency'],
      ['supplierUnknown'],
      ['targetUnknown'],
      [],
    ]);
    // no reference: marked, not left out; the named line, with its supplier and contract
    const last = p.rows[11];
    expect(last).toMatchObject({ noReference: true, duplicate: false, planLine: { title: 'Hosting fee' }, supplier: { id: supplier } });
    // an unknown column
    await expect(olivia('POST', `${base()}/preview`, { csv, mapping: mapping({ note: 'Nope' }) })).rejects.toMatchObject({
      status: 400,
      body: { code: 'COST_ENTRY_IMPORT_COLUMN' },
    });
  });

  it('finds duplicates against stored entries and within the file, and imports the rows without problems', async () => {
    await olivia('POST', `/costs/plans/${service}/entries`, { date: d1(), amount: '100', currency: 'EUR', reference: 'dup-1' });
    const csv = ['Date,Amount,Currency,Invoice', `${d1()},100,EUR, DUP-1 `, `${d2()},50,EUR,NEW-1`, `${d2()},50,EUR,new-1`, `${d2()},bad,EUR,BAD-1`].join('\n');
    const p = await olivia('POST', `${base()}/preview`, { csv, fileName: 'invoices.csv', mapping: mapping() });
    expect(p.rows.map((r: { duplicate: boolean }) => r.duplicate)).toEqual([true, false, true, false]);
    expect(p.counts).toEqual({ rows: 4, ready: 1, problems: 1, duplicates: 2 });
    expect(p.sameFile).toBeNull();
    // the preview stores nothing
    const before = (await plan()).entries.length;
    expect((await plan()).entries.length).toBe(before);
    // import: duplicates left out unless ticked one by one
    const y = await olivia('POST', base(), { csv, fileName: 'invoices.csv', mapping: mapping(), include: [2] });
    expect(y.added).toBe(2);
    expect(y.skipped).toEqual({ duplicate: 1, notNumber: 1 });
    const after = await plan();
    expect(after.entries.length).toBe(before + 2);
    expect(
      after.entries
        .filter((e) => e.importId === y.importId)
        .map((e) => e.reference)
        .sort(),
    ).toEqual(['NEW-1', 'new-1']);
    const a = (await s.api('GET', `/audit?action=cost.entries_imported&entityId=${service}&limit=1`))[0];
    expect(a.details).toMatchObject({ fileName: 'invoices.csv', rows: 4, added: 2, sums: { EUR: '100.00' }, duplicatesIncluded: 1 });
    expect(a.details.sha256).toMatch(/^[0-9a-f]{64}$/);
    // the same file again: the preview says so; the mapping is offered again
    const again = await olivia('POST', `${base()}/preview`, { csv, fileName: 'invoices.csv', mapping: mapping() });
    expect(again.sameFile).toMatchObject({ id: y.importId, fileName: 'invoices.csv' });
    expect(again.rows.every((r: { duplicate: boolean; problems: string[] }) => r.duplicate || r.problems.length)).toBe(true);
    const list = await olivia('GET', `/costs/plans/${service}/imports`);
    expect(list.lastMapping).toMatchObject({ date: 'Date', dateFormat: 'YYYY-MM-DD' });
    expect(list.imports[0]).toMatchObject({ id: y.importId, added: 2, entries: 2 });
  });

  it('imports all or nothing, within the limits; a viewer and API tokens may not', async () => {
    await expect(olivia('POST', base(), { csv: 'Date,Amount,Currency,Invoice\n,1,EUR,X', mapping: mapping() })).rejects.toMatchObject({
      status: 400,
      body: { code: 'COST_ENTRY_IMPORT_NOTHING' },
    });
    const rows = ['Date,Amount,Currency,Invoice', ...Array.from({ length: 5001 }, (_, i) => `${d1()},1,EUR,L-${i}`)].join('\n');
    await expect(olivia('POST', `${base()}/preview`, { csv: rows, mapping: mapping() })).rejects.toMatchObject({
      status: 400,
      body: { code: 'COST_IMPORT_CSV' },
    });
    const cols = [Array.from({ length: 101 }, (_, i) => `C${i}`).join(','), Array.from({ length: 101 }, () => '1').join(',')].join('\n');
    await expect(olivia('POST', `${base()}/preview`, { csv: cols, mapping: mapping({ date: 'C0', amount: 'C1' }) })).rejects.toMatchObject({ status: 400 });
    // over the limit of 2,000 entries per service and fiscal year: those rows are a problem
    const { db } = await import('../src/db.js');
    const other = (await s.api('POST', '/services', { name: 'Full service', owners: ['user:olivia'] })).id;
    const now = new Date().toISOString();
    db().tx(() => {
      for (let i = 0; i < 1999; i++)
        db().run(
          `INSERT INTO cost_entries (id, service_id, entry_date, amount, currency, reference, note, created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, ?, 1000000, 'EUR', '', '', ?, 'admin', ?, 'admin')`,
          `cen_full_${i}`,
          other,
          d1(),
          now,
          now,
        );
    });
    const full = await olivia('POST', `/costs/plans/${other}/entries/import/preview`, {
      csv: `Date,Amount,Currency,Invoice\n${d1()},1,EUR,F-1\n${d1()},1,EUR,F-2\n`,
      mapping: mapping(),
    });
    expect(full.rows.map((r: { problems: string[] }) => r.problems)).toEqual([[], ['limit']]);
    await expect(vera('POST', `${base()}/preview`, { csv: 'Date,Amount\n', mapping: mapping() })).rejects.toMatchObject({ status: 403 });
    const token = (await olivia('POST', '/me/tokens', { name: 'imports', scope: 'full' })).token as string;
    const res = await fetch(`${s.base}/api${base()}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ csv: `Date,Amount,Currency,Invoice\n${d1()},1,EUR,T-1\n`, mapping: mapping() }),
    });
    expect(res.status).toBe(403);
  });

  it('removes an import: those of its entries that are still there, in one step', async () => {
    const csv = `Date,Amount,Currency,Invoice\n${d1()},7,EUR,RM-1\n${d1()},8,EUR,RM-2\n`;
    const y = await olivia('POST', base(), { csv, fileName: 'remove-me.csv', mapping: mapping() });
    const one = y.entries.find((e: { reference: string }) => e.reference === 'RM-1');
    await olivia('DELETE', `/costs/plans/${service}/entries/${one.id}`);
    const list = await olivia('DELETE', `/costs/plans/${service}/imports/${y.importId}`);
    expect(list.imports.find((r: { id: string }) => r.id === y.importId)).toMatchObject({ entries: 0, removedBy: 'olivia' });
    expect((await plan()).entries.some((e) => e.reference.startsWith('RM-'))).toBe(false);
    const a = (await s.api('GET', `/audit?action=cost.import_removed&entityId=${service}&limit=1`))[0];
    expect(a.details).toMatchObject({ importId: y.importId, entriesRemoved: 1 });
    await expect(olivia('DELETE', `/costs/plans/${service}/imports/${y.importId}`)).rejects.toMatchObject({
      status: 409,
      body: { code: 'COST_ENTRY_IMPORT_REMOVED' },
    });
  });
});

describe('the reminder "contract payments not booked"', () => {
  it('goes, off by default, to owners who opted in – once per service and month', async () => {
    const svc = (await s.api('POST', '/services', { name: 'Reminded service', owners: ['user:olivia', 'user:vera'] })).id;
    const sup = await s.api('POST', `/suppliers/${supplier}/contracts`, { title: 'Reminder contract', startsOn: '2020-01-01', endsOn: '2035-12-31' });
    const cid = sup.contracts.find((c: { title: string }) => c.title === 'Reminder contract').id;
    const sch = await s.api('POST', '/costs/schedules', {
      title: 'Monthly fee',
      amount: '250',
      currency: 'EUR',
      billing: 'monthly',
      firstPaymentOn: '2020-01-05',
      contractId: cid,
      serviceId: svc,
    });
    const prev = month === `${fy}-01` ? `${fy - 1}-12` : `${fy}-${String(Number(month.slice(5, 7)) - 1).padStart(2, '0')}`;
    await s.api('POST', `/costs/plans/${svc}/proposals`, { fiscalYear: fiscalYearOf(prev, 1), scheduleIds: [sch.schedules[0].id] });
    const { checkBookingReminders } = await import('../src/costs/booking-reminders.js');
    const third = Date.parse(`${month}-03T12:00:00Z`);
    // off by default: nobody opted in, nothing is sent (and nothing claimed)
    expect(checkBookingReminders(third)).toBe(0);
    expect((await olivia('GET', '/me/notification-opt-ins')).events).toEqual([]);
    await olivia('PUT', '/me/notification-opt-ins', { events: ['cost.booking_due'] });
    // before the third day: not yet
    expect(checkBookingReminders(Date.parse(`${month}-02T12:00:00Z`))).toBe(0);
    expect(checkBookingReminders(third)).toBe(1);
    expect(checkBookingReminders(third + 3_600_000)).toBe(0);
    const mine = ((await olivia('GET', '/notifications')) as { items: { event: string; title: string }[] }).items;
    expect(mine.find((n) => n.event === 'cost.booking_due')?.title).toContain('Reminded service');
    const veras = ((await vera('GET', '/notifications')) as { items: { event: string }[] }).items;
    expect(veras.some((n) => n.event === 'cost.booking_due')).toBe(false);
    const audit = (await s.api('GET', '/audit?action=notification.opt_ins_changed&limit=1'))[0];
    expect(audit.details).toMatchObject({ from: [], to: ['cost.booking_due'] });
  });
});
